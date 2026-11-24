-- =====================================================================
-- Migration 0048: Saisonwechsel in Schritten (Timeout-Fix für große Welten)
--   Problem: fd_end_season lief in EINEM Aufruf des Spielers (PostgREST, 8 s Limit) und brach auf dem
--   Produktionsbestand mit „statement timeout“ ab. Jetzt:
--     * Aus dem Spiel (PostgREST) startet der Termin „Saisonende“ nur noch einen Auftrag (season_end_jobs).
--     * Der Match-Server (Sweep, service_role, 60 s je Aufruf) arbeitet den Auftrag in sieben kleinen
--       Schritten ab – jeder Schritt ist eine eigene Transaktion (admin_sweep_world meldet „noch Arbeit“,
--       der Server ruft sofort wieder auf). Kein Fly-Deploy nötig, die Logik liegt in der Datenbank.
--     * Direkte Aufrufe (SQL-Editor, Tests) laufen weiter in einem Zug (fd_end_season).
--   Die Jugend-/Karriereende-Verarbeitung (Trigger) läuft dabei als eigener Schritt.
-- Idempotent, ohne Datenverlust.
-- =====================================================================

create table if not exists public.season_end_jobs (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  new_season_id uuid,
  step smallint not null default 0,
  attempts smallint not null default 0,
  error text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  primary key (world_id, season_id)
);
alter table public.season_end_jobs enable row level security;
revoke all on public.season_end_jobs from anon, authenticated;

-- Jugend-Trigger: im Stufenbetrieb als eigener Schritt (Flag fd.defer_youth)
create or replace function public.fd_trg_youth_season_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('fd.defer_youth', true), '') = '1' then return new; end if;
  begin
    perform public.fd_youth_season_change(new.id, new.current_season_id);
  exception when others then
    raise warning 'Jugend/Karriereende: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Ein Schritt des Saisonwechsels. Rückgabe: {done, step, total}. Jeder Schritt ist atomar und läuft genau einmal.
create or replace function public.fd_season_end_step(p_world uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_old public.seasons;
  v_new uuid;
  v_slot public.season_slots;
  j public.season_end_jobs;
  v_tier smallint;
  v_comp uuid;
  r record;
  v_newtier jsonb := '{}'::jsonb;
  v_rel_win uuid;
  v_rel_lose uuid;
  v_ama uuid[];
  v_ga integer;
  c_total constant integer := 7;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  select * into j from public.season_end_jobs where world_id = p_world and done_at is null order by started_at desc limit 1 for update;
  if not found then
    v_slot := public.fd_current_slot(p_world);
    if v_slot.id is null or v_slot.kind <> 'season_end' or v_slot.state <> 'live' then
      return jsonb_build_object('done', true, 'step', c_total, 'total', c_total);
    end if;
    insert into public.season_end_jobs(world_id, season_id) values (p_world, v_world.current_season_id)
    on conflict (world_id, season_id) do update set done_at = null, step = 0, attempts = 0, error = null, updated_at = now()
    returning * into j;
  end if;
  select * into v_old from public.seasons where id = j.season_id;

  if j.step = 0 then
    -- Auf-/Abstieg, Sponsor-Saisonprämien, neue Saison mit Ligen
  -- Neue Spielklasse je Verein bestimmen
  for v_tier in 1..3 loop
    select id into v_comp from public.competitions where season_id = v_old.id and kind = 'league' and tier = v_tier;
    for r in select * from public.fd_table(v_comp) loop
      v_newtier := v_newtier || jsonb_build_object(r.club_id::text,
        case
          when v_tier > 1 and r.pos <= 2 then v_tier - 1
          when v_tier < 3 and r.pos >= 17 then v_tier + 1
          when v_tier = 3 and r.pos >= 17 then 4
          else v_tier end);
      -- I7: Sponsor-Saisonprämien
      select goals_against into v_ga from public.standings where competition_id = v_comp and club_id = r.club_id;
      perform public.fd_pay(r.club_id, 'sponsor', public.fd_scaled(so.amount, v_world.economy_factor), 'season:' || v_old.id || ':sponsorbonus:' || r.club_id, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
      from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
      where sc.club_id = r.club_id and sc.season_id = v_old.id and (
        (so.kind = 'max_goals_against' and v_ga <= so.threshold)
        or (so.kind = 'placement_at_most' and r.pos <= so.threshold)
        or (so.kind = 'champion' and r.pos = 1)
        or (so.kind = 'promotion' and v_tier > 1 and r.pos <= 2));
    end loop;
  end loop;
  -- Relegation (Sieger spielt in der höheren Liga)
  for r in select t.*, c.tier from public.ties t join public.competition_stages st on st.id = t.stage_id join public.competitions c on c.id = st.competition_id
           where c.season_id = v_old.id and c.kind = 'relegation' and t.winner_club_id is not null loop
    v_rel_win := r.winner_club_id;
    v_rel_lose := case when r.winner_club_id = r.club_a_id then r.club_b_id else r.club_a_id end;
    v_newtier := v_newtier || jsonb_build_object(v_rel_win::text, r.tier) || jsonb_build_object(v_rel_lose::text, r.tier + 1);
    perform public.fd_pay(v_rel_win, 'sponsor', public.fd_scaled(so.amount, v_world.economy_factor), 'season:' || v_old.id || ':sponsorbonus:' || v_rel_win, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
    from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
    where sc.club_id = v_rel_win and sc.season_id = v_old.id and so.kind = 'promotion' and r.tier + 1 = (select public.fd_tier_of(v_rel_win, v_old.id));
  end loop;
  -- Vierte Liga: die zwei stärksten Amateurvereine steigen auf, die Absteiger werden Amateure
  select array_agg(id order by avg_ovr desc) into v_ama from (
    select c.id, (select avg(p.overall) from public.players p where p.club_id = c.id) as avg_ovr
    from public.clubs c where c.world_id = p_world and c.amateur) x;
  v_newtier := v_newtier || jsonb_build_object(v_ama[1]::text, 3) || jsonb_build_object(v_ama[2]::text, 3);
  update public.clubs set amateur = false where id in (v_ama[1], v_ama[2]);
  update public.clubs c set amateur = true where c.world_id = p_world and (v_newtier ->> c.id::text) = '4';

  -- Neue Saison
  insert into public.seasons(world_id, year, status) values (p_world, v_old.year + 1, 'planned') returning id into v_new;
  for v_tier in 1..3 loop
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_new, 'league', v_world.country_code, v_tier, public.fd_league_name(v_world.country_code, v_tier))
    returning id into v_comp;
    insert into public.competition_entries(competition_id, club_id, world_id)
    select v_comp, (k)::uuid, p_world from jsonb_each_text(v_newtier) e(k, v) where v::int = v_tier;
  end loop;
  -- Sicherung: jede Liga exakt 18 Vereine
  if exists (select 1 from public.competitions c where c.season_id = v_new and c.kind = 'league'
             and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18) then
    raise exception 'Auf-/Abstieg ergibt keine 18er-Ligen' using errcode = 'P0001', hint = 'league_size';
  end if;

    update public.season_end_jobs set new_season_id = v_new where world_id = p_world and season_id = j.season_id;
    j.new_season_id := v_new;
  elsif j.step = 1 then
    -- Entwicklungsbericht: Stand am Saisonende festhalten
    perform public.fd_dev_season_close(p_world, v_old.id);
  elsif j.step = 2 then
    -- Vertragsmanagement; bei einem Fehler gilt die bisherige Regel (+2 Jahre)
    begin
      perform public.fd_contracts_season_change(p_world, v_old.id, v_old.year);
    exception when others then
      raise warning 'Vertragsmanagement: %', sqlerrm;
      update public.player_contracts set end_season_year = end_season_year + 2
      where world_id = p_world and active and end_season_year <= v_old.year;
    end;
  elsif j.step = 3 then
    -- Alter +1, Alterung (Rest übernimmt der Server-Sweep), Sperren abbüßen, Fitness
    update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
    insert into public.dev_aging_jobs(world_id, season_id) values (p_world, v_old.id) on conflict do nothing;
    perform public.fd_dev_season_aging(p_world, v_old.id, 2000);
    update public.disciplinary_records set served_matches = suspension_matches where world_id = p_world and season_id = v_old.id;
    update public.players set fitness = 100 where world_id = p_world;
  elsif j.step = 4 then
    -- Wechsel in die neue Saison (Jugend-Trigger läuft als eigener Schritt 5)
    perform set_config('fd.defer_youth', '1', true);
    update public.season_slots set state = 'released', released_at = now() where season_id = v_old.id and slot_key = 'END';
    update public.seasons set status = 'closed' where id = v_old.id;
    update public.career_worlds set current_season_id = j.new_season_id, status = 'preseason', current_slot = 0, current_week = 0,
      current_date_in_world = make_date(v_old.year + 1, 7, 1)
    where id = p_world;
    delete from public.multiplayer_readiness where world_id = p_world and context = 'preseason';
  elsif j.step = 5 then
    -- Jugend und Karriereende (Fehler dürfen den Saisonwechsel nie blockieren)
    begin perform public.fd_youth_season_change(p_world, j.new_season_id);
    exception when others then raise warning 'Jugend/Karriereende: %', sqlerrm; end;
  elsif j.step = 6 then
    -- Ergänzungsspieler entfernen, Kader kleinerer Länder auf elf reduzieren
    begin perform public.fd_cleanup_temporary_players(p_world);
    exception when others then raise warning 'Ergänzungsspieler: %', sqlerrm; end;
    begin perform public.fd_reduce_world_players(p_world);
    exception when others then raise warning 'Kaderreduktion: %', sqlerrm; end;
  end if;

  update public.season_end_jobs
     set step = step + 1, attempts = 0, error = null, updated_at = now(), done_at = case when j.step + 1 >= c_total then now() else null end
   where world_id = p_world and season_id = j.season_id;
  return jsonb_build_object('done', j.step + 1 >= c_total, 'step', j.step + 1, 'total', c_total);
end;
$$;

-- Alles in einem Zug (SQL-Editor, Tests, Langlauf)
create or replace function public.fd_end_season(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare v_r jsonb;
begin
  loop
    v_r := public.fd_season_end_step(p_world);
    exit when (v_r ->> 'done')::boolean;
  end loop;
end;
$$;

-- Termin „Saisonende“ beginnen: aus dem Spiel (PostgREST) nur Auftrag anlegen, sonst sofort ausführen
create or replace function public.fd_begin_slot(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state not in ('pending', 'prep') then return; end if;
  update public.season_slots set state = 'live', started_at = now() where id = v_slot.id;
  update public.career_worlds set current_date_in_world = v_slot.slot_date where id = p_world;
  if v_slot.kind = 'season_end' then
    if session_user = 'authenticator' then
      insert into public.season_end_jobs(world_id, season_id) values (p_world, v_slot.season_id)
      on conflict (world_id, season_id) do nothing;
      return;
    end if;
    perform public.fd_end_season(p_world);
    return;
  end if;
  perform public.fd_try_release(p_world);
end;
$$;

-- Sweep (Match-Server): zusätzlich Saisonwechsel-Schritte abarbeiten (sonst unverändert gegenüber 0031)
create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '20s'
as $$
declare
  v_pending uuid[];
  v_slot public.season_slots;
  v_live boolean;
  v_job public.season_end_jobs;
  v_res jsonb;
begin
  -- Spielvorbereitung: nach Ablauf der Frist automatisch starten (blockiert den Spieltag nie)
  begin perform public.fd_prep_try_finish(p_world); exception when others then raise warning 'Vorbereitung: %', sqlerrm; end;
  v_slot := public.fd_current_slot(p_world);
  v_live := v_slot.state = 'live';
  -- Saisonwechsel: ein Schritt je Aufruf (eigene Transaktion), der Server ruft sofort wieder auf
  select * into v_job from public.season_end_jobs where world_id = p_world and done_at is null order by started_at desc limit 1;
  if v_job.world_id is not null or (v_live and v_slot.kind = 'season_end') then
    if coalesce(v_job.attempts, 0) < 5 then
      begin
        v_res := public.fd_season_end_step(p_world);
      exception when others then
        raise warning 'Saisonwechsel Schritt: %', sqlerrm;
        update public.season_end_jobs set attempts = attempts + 1, error = left(sqlerrm, 300), updated_at = now() where world_id = p_world and done_at is null;
        v_res := jsonb_build_object('done', false);
      end;
    else
      v_res := jsonb_build_object('done', true);  -- zu viele Fehlversuche: nicht endlos wiederholen (Host kann neu starten)
    end if;
    return jsonb_build_object('pending', '[]'::jsonb, 'slot_state', v_slot.state, 'training_left', 0,
                              'aging_left', case when coalesce((v_res ->> 'done')::boolean, false) then 0 else 1 end);
  end if;
  if v_live then
    begin perform public.fd_compact_batch(p_world, 8); exception when others then raise warning 'Kompaktberechnung: %', sqlerrm; end;
    begin perform public.fd_try_release(p_world); exception when others then raise warning 'Freigabe: %', sqlerrm; end;
  elsif not exists (select 1 from public.fd_world_bg where world_id = p_world and last_run > now() - interval '55 seconds') then
    insert into public.fd_world_bg(world_id, last_run) values (p_world, now()) on conflict (world_id) do update set last_run = now();
    begin perform public.fd_auto_begin(p_world); exception when others then raise warning 'Automatischer Start: %', sqlerrm; end;
    begin perform public.fd_dev_aging_batch(p_world, 2000); exception when others then raise warning 'Alterung: %', sqlerrm; end;
    begin perform public.fd_ai_training_batch(p_world, 25); exception when others then raise warning 'KI-Training: %', sqlerrm; end;
    begin perform public.fd_ai_transfer_batch(p_world, 25); exception when others then raise warning 'KI-Transfers: %', sqlerrm; end;
    begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
    begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state, 'training_left', 0, 'aging_left', 0);
end;
$$;

-- Welten mit unfertigem Saisonwechsel sind immer „fällig“ (auch nach einem Neustart des Servers)
create or replace function public.admin_due_worlds()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  select w.id from public.career_worlds w
  left join public.fd_world_bg b on b.world_id = w.id
  where w.status::text in ('preseason', 'season', 'season_end') and (b.last_run is null or b.last_run < now() - interval '60 seconds')
    and exists (select 1 from public.world_members m where m.world_id = w.id and m.last_seen_at > now() - interval '2 days')
  union
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'prep' and s.prep_until < now()
  union
  select j.world_id from public.season_end_jobs j where j.done_at is null and j.attempts < 5;
$$;

-- Fortschritt für die Oberfläche; Host kann nach Fehlversuchen neu anstoßen
create or replace function public.season_end_status(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  j public.season_end_jobs;
begin
  select * into j from public.season_end_jobs where world_id = p_world and done_at is null order by started_at desc limit 1;
  if not found then return jsonb_build_object('active', false); end if;
  return jsonb_build_object('active', true, 'step', j.step, 'total', 7, 'attempts', j.attempts, 'error', j.error, 'failed', j.attempts >= 5);
end;
$$;

create or replace function public.season_end_retry(p_world uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select host_user_id from public.career_worlds where id = p_world) is distinct from auth.uid() then
    raise exception 'Nur der Host kann den Saisonwechsel neu starten.' using errcode = '42501', hint = 'host_only';
  end if;
  update public.season_end_jobs set attempts = 0, error = null, updated_at = now() where world_id = p_world and done_at is null;
end;
$$;

revoke execute on function public.fd_season_end_step(uuid), public.fd_end_season(uuid), public.fd_begin_slot(uuid) from public, anon, authenticated;
revoke execute on function public.admin_sweep_world(uuid), public.admin_due_worlds() from public, anon, authenticated;
grant execute on function public.admin_sweep_world(uuid), public.admin_due_worlds() to service_role;
revoke execute on function public.season_end_status(uuid), public.season_end_retry(uuid) from public, anon;
grant execute on function public.season_end_status(uuid), public.season_end_retry(uuid) to authenticated;
notify pgrst, 'reload schema';
