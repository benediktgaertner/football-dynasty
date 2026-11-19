-- =====================================================================
-- 0022: Serverseitige Spieltagssteuerung – KI-Spiele werden nie mehr blockiert
--
-- Bisher wurden KI-gegen-KI-Partien nur berechnet, wenn ein Browser den Match-Server
-- anstieß (/world/simulate). Brach eine Berechnung ab (Neustart, Fehler), blieb das Spiel
-- auf „scheduled“ stehen, bis zufällig wieder jemand das Dashboard öffnete.
--
-- Neu:
--  * fixture_jobs: eindeutiger Verarbeitungsstatus je Partie
--      queued → processing → done   (normaler Weg)
--                        ↘ failed → processing (automatischer Neuversuch)
--                                 ↘ fallback (nach 3 Fehlversuchen: Ersatzergebnis, siehe unten)
--  * admin_claim_fixture: Sperre gegen doppelte Simulation (auch über mehrere Server-Instanzen)
--  * admin_due_worlds / admin_sweep_world: Der Match-Server prüft selbstständig alle 10 s
--    alle Welten mit laufendem Spieltag – ganz ohne Client.
--  * admin_fallback_result: letzte Sicherung, damit keine Partie die Karriere aufhält.
-- Bereits gespeicherte Ergebnisse werden nie überschrieben (admin_finish_match ist idempotent).
-- =====================================================================

create table if not exists public.fixture_jobs (
  fixture_id uuid primary key references public.fixtures(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'processing', 'done', 'failed', 'fallback')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  claimed_by text,
  last_error text,
  updated_at timestamptz not null default now()
);
create index if not exists fixture_jobs_world_state on public.fixture_jobs(world_id, state);
alter table public.fixture_jobs enable row level security;

-- Partie zur Berechnung übernehmen. Gibt ok=false zurück, wenn sie fertig ist oder gerade
-- von einer anderen Instanz berechnet wird (Lease 4 Minuten, danach gilt sie als abgebrochen).
create or replace function public.admin_claim_fixture(p_fixture uuid, p_worker text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_job public.fixture_jobs;
begin
  select * into v_f from public.fixtures where id = p_fixture for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_f.status in ('finished', 'released', 'cancelled') or exists (select 1 from public.fixture_results r where r.fixture_id = p_fixture) then
    insert into public.fixture_jobs(fixture_id, world_id, state) values (p_fixture, v_f.world_id, 'done')
    on conflict (fixture_id) do update set state = case when public.fixture_jobs.state = 'fallback' then 'fallback' else 'done' end, updated_at = now();
    return jsonb_build_object('ok', false, 'reason', 'done');
  end if;
  select * into v_job from public.fixture_jobs where fixture_id = p_fixture for update;
  if found and v_job.state = 'processing' and v_job.claimed_by is distinct from p_worker and v_job.claimed_at > now() - interval '4 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'attempts', v_job.attempts);
  end if;
  insert into public.fixture_jobs(fixture_id, world_id, state, attempts, claimed_at, claimed_by)
  values (p_fixture, v_f.world_id, 'processing', 1, now(), p_worker)
  on conflict (fixture_id) do update set state = 'processing', attempts = public.fixture_jobs.attempts + 1,
    claimed_at = now(), claimed_by = p_worker, updated_at = now()
  returning * into v_job;
  return jsonb_build_object('ok', true, 'attempts', v_job.attempts);
end;
$$;

create or replace function public.admin_fixture_failed(p_fixture uuid, p_error text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  update public.fixture_jobs set state = 'failed', last_error = left(p_error, 500), claimed_at = null, updated_at = now()
  where fixture_id = p_fixture and state = 'processing'
  returning jsonb_build_object('attempts', attempts);
$$;

-- Ersatzergebnis, falls eine Partie dreimal nicht berechnet werden konnte: deterministisch aus dem
-- Spiel-Seed und der Stärke der besten elf verfügbaren Spieler (Poisson-verteilte Tore).
-- Ohne Spielerstatistiken; Freigabe, Tabelle und Finanzen laufen ganz normal weiter.
create or replace function public.fd_poisson(p_lambda numeric, p_u numeric)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_k integer := 0;
  v_p numeric := exp(-p_lambda);
  v_c numeric := v_p;
begin
  while p_u > v_c and v_k < 9 loop
    v_k := v_k + 1;
    v_p := v_p * p_lambda / v_k;
    v_c := v_c + v_p;
  end loop;
  return v_k;
end;
$$;

create or replace function public.admin_fallback_result(p_fixture uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_h numeric;
  v_a numeric;
  v_hg integer;
  v_ag integer;
  v_res jsonb;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.fixture_results where fixture_id = p_fixture) then return jsonb_build_object('status', 'already_saved'); end if;
  select coalesce(avg(o), 60) into v_h from (select p.overall o from public.players p where p.club_id = v_f.home_club_id and not p.retired order by p.overall desc limit 11) x;
  select coalesce(avg(o), 60) into v_a from (select p.overall o from public.players p where p.club_id = v_f.away_club_id and not p.retired order by p.overall desc limit 11) x;
  v_hg := public.fd_poisson(least(4, 1.45 * exp((v_h - v_a) / 12.0)), public.fd_hash01(v_f.rng_seed || ':fallback:h')::numeric);
  v_ag := public.fd_poisson(least(4, 1.15 * exp((v_a - v_h) / 12.0)), public.fd_hash01(v_f.rng_seed || ':fallback:a')::numeric);
  v_res := public.admin_finish_match(p_fixture, jsonb_build_object('score', jsonb_build_array(v_hg, v_ag), 'events', '[]'::jsonb, 'players', '[]'::jsonb,
    'stats', jsonb_build_object('home', jsonb_build_object('xg', v_hg * 0.9), 'away', jsonb_build_object('xg', v_ag * 0.9)), 'possessionHome', 50));
  update public.fixture_jobs set state = 'fallback', updated_at = now() where fixture_id = p_fixture;
  return v_res || jsonb_build_object('score', jsonb_build_array(v_hg, v_ag));
end;
$$;

-- Offene Partien des laufenden Termins. Neu: fehlgeschlagene oder abgebrochene Berechnungen
-- (Lease abgelaufen) werden sofort erneut geliefert, nicht erst nach 6 Minuten.
create or replace function public.admin_pending_fixtures(p_world uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select f.id from public.fixtures f
  join public.season_slots s on s.world_id = f.world_id and s.season_id = f.season_id and s.slot_key = f.slot_key
  left join public.match_sessions ms on ms.fixture_id = f.id
  left join public.fixture_jobs j on j.fixture_id = f.id
  where f.id in (select public.fd_slot_fixture_ids(p_world))
    and s.state = 'live'
    and f.status in ('scheduled', 'live')
    and (
      (f.status = 'scheduled' and (
        not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human')
        or not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human'
                       and not exists (select 1 from public.fixture_decisions d where d.fixture_id = f.id and d.club_id = c.id and d.decision = 'skip'))
        or s.started_at < now() - interval '10 minutes'))
      or (f.status = 'live' and ms.updated_at < now() - interval '6 minutes')
      or j.state = 'failed'
      or (j.state = 'processing' and j.claimed_at < now() - interval '4 minutes')
    )
  order by (select count(*) from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human') desc, f.id;
$$;

-- Welten, in denen gerade ein Spieltag läuft
create or replace function public.admin_due_worlds()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live';
$$;

-- Ein Durchgang je Welt: Freigabe nachholen, falls alles fertig ist; sonst die zu berechnenden Partien liefern
create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending uuid[];
begin
  if (public.fd_current_slot(p_world)).state = 'live' then
    perform public.fd_try_release(p_world);
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state);
end;
$$;

-- admin_finish_match: Verarbeitungsstatus auf „done“ setzen (Ergebnis gespeichert)
do $patch$
declare
  v_def text;
begin
  select pg_get_functiondef('public.admin_finish_match(uuid, jsonb)'::regprocedure) into v_def;
  if position('fixture_jobs' in v_def) = 0 then
    v_def := replace(v_def,
      $a$  update public.match_sessions set status = 'finished', finished_at = now(), updated_at = now() where fixture_id = p_fixture;$a$,
      $b$  update public.match_sessions set status = 'finished', finished_at = now(), updated_at = now() where fixture_id = p_fixture;
  insert into public.fixture_jobs(fixture_id, world_id, state) values (p_fixture, v_f.world_id, 'done')
  on conflict (fixture_id) do update set state = case when public.fixture_jobs.state = 'fallback' then 'fallback' else 'done' end,
    claimed_at = null, updated_at = now();$b$);
    if position('fixture_jobs' in v_def) = 0 then raise exception 'Patch admin_finish_match fehlgeschlagen'; end if;
    execute v_def;
  end if;
end
$patch$;

-- Statusanzeige: Verarbeitungsstand der KI-Partien im Spieltag (für „Wird berechnet …“)
create or replace function public.matchday_processing(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.fd_require_member(p_world);
  return coalesce((select jsonb_object_agg(j.fixture_id, j.state) from public.fixture_jobs j
                   where j.fixture_id in (select public.fd_slot_fixture_ids(p_world))), '{}'::jsonb);
end;
$$;

revoke execute on function public.admin_claim_fixture(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_fixture_failed(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_fallback_result(uuid) from public, anon, authenticated;
revoke execute on function public.admin_due_worlds() from public, anon, authenticated;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
revoke execute on function public.fd_poisson(numeric, numeric) from public, anon, authenticated;
grant execute on function public.admin_claim_fixture(uuid, text) to service_role;
grant execute on function public.admin_fixture_failed(uuid, text) to service_role;
grant execute on function public.admin_fallback_result(uuid) to service_role;
grant execute on function public.admin_due_worlds() to service_role;
grant execute on function public.admin_sweep_world(uuid) to service_role;
revoke execute on function public.matchday_processing(uuid) from public, anon;
grant execute on function public.matchday_processing(uuid) to authenticated;
