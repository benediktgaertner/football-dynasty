-- =====================================================================
-- 0030 Simulation begrenzen, Europapokal, Fankultur, Stadionsound
--  1. Zentrale Regel „aktive Länder“ = Länder mit mindestens einem menschlichen Manager.
--     Nur Vereine aktiver Länder (alle drei Ligen) und Europapokal-Teilnehmer erhalten
--     Hintergrundarbeit (KI-Training, KI-Transfers, Free-Agent-Interesse, Regeneration).
--  2. Reine KI-Spiele speichern nur Tore, Karten und Verletzungen als Ereignisse.
--  3. Champions League und Europa League (je 16 Teams: 4 Gruppen, Viertel-/Halbfinale mit
--     Hin- und Rückspiel, Finale). Spiele ohne menschlichen Manager werden kompakt in der
--     Datenbank berechnet (kein Match-Server, keine 2D-Ereignisliste).
--  4. Performance: RLS ohne Funktionsaufruf je Zeile, fehlende Indizes, Torjägerlisten-Cache,
--     inaktive Welten ohne Hintergrundarbeit, längeres Zeitlimit für den Match-Server.
--  5. Fankultur (Schwenkfahnen, Choreografien, Ultragruppen) und Stadionsound (Hymnen,
--     Fangesänge, MP3-Upload) – rein optisch/akustisch, ohne Kosten oder sportliche Boni.
-- Wiederholbar: alle Anweisungen sind idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Aktive Länder und aktive Vereine
-- ---------------------------------------------------------------------
create or replace function public.fd_active_assocs(p_world uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct c.association_code::text), array['GER'])
  from public.clubs c where c.world_id = p_world and c.control = 'human';
$$;

create table if not exists public.fd_active_clubs (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  primary key (world_id, season_id, club_id)
);
alter table public.fd_active_clubs enable row level security;
create index if not exists fd_active_clubs_club on public.fd_active_clubs(club_id);

-- Vereine mit Spielbetrieb: alle Vereine aktiver Länder + Europapokal-Teilnehmer der Saison
create or replace function public.fd_refresh_active_clubs(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_season uuid := (select current_season_id from public.career_worlds where id = p_world);
  v_n integer;
begin
  if v_season is null then return 0; end if;
  delete from public.fd_active_clubs where world_id = p_world;
  insert into public.fd_active_clubs(world_id, season_id, club_id)
  select p_world, v_season, c.id from public.clubs c
  where c.world_id = p_world and (c.association_code::text = any(public.fd_active_assocs(p_world))
    or exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
               where e.club_id = c.id and co.season_id = v_season and co.kind::text in ('champions_league', 'europa_league')))
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Liste der aktiven Vereine der laufenden Saison (wird bei Bedarf einmal je Saison aufgebaut)
create or replace function public.fd_active_club_ids(p_world uuid)
returns setof uuid
language plpgsql
set search_path = ''
as $$
declare
  v_season uuid := (select current_season_id from public.career_worlds where id = p_world);
begin
  if v_season is null then return; end if;
  if not exists (select 1 from public.fd_active_clubs where world_id = p_world and season_id = v_season) then
    perform public.fd_refresh_active_clubs(p_world);
  end if;
  return query select club_id from public.fd_active_clubs where world_id = p_world and season_id = v_season;
end;
$$;

revoke execute on function public.fd_active_assocs(uuid) from public, anon, authenticated;
revoke execute on function public.fd_refresh_active_clubs(uuid) from public, anon, authenticated;
revoke execute on function public.fd_active_club_ids(uuid) from public, anon, authenticated;

-- Statistik je Spieltag: wie viele Spiele wurden wie berechnet (Nachweis der Einsparung)
create table if not exists public.fd_sim_log (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid,
  slot_key text,
  fixture_id uuid,
  competition_kind text,
  association text,
  mode text not null check (mode in ('engine', 'compact', 'fallback')),
  events integer not null default 0,
  player_rows integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.fd_sim_log enable row level security;
create index if not exists fd_sim_log_world_slot on public.fd_sim_log(world_id, season_id, slot_key);

-- ---------------------------------------------------------------------
-- 2. Indizes (Ursache vieler Vollscans laut pg_stat_user_tables)
-- ---------------------------------------------------------------------
create index if not exists player_contracts_player_idx on public.player_contracts(player_id);
create index if not exists player_contracts_club_idx on public.player_contracts(club_id);
create index if not exists transfer_offers_to_club_idx on public.transfer_offers(to_club_id, status);
create index if not exists transfer_offers_from_club_idx on public.transfer_offers(from_club_id, status);
create index if not exists transfers_player_idx on public.transfers(player_id);
create index if not exists transfers_to_club_idx on public.transfers(to_club_id);
create index if not exists transfers_from_club_idx on public.transfers(from_club_id);
create index if not exists match_events_player_idx on public.match_events(player_id);
create index if not exists match_events_secondary_player_idx on public.match_events(secondary_player_id);
create index if not exists career_history_player_idx on public.career_history(player_id);
create index if not exists fixtures_competition_status on public.fixtures(competition_id, status);
create index if not exists fixtures_tie_idx on public.fixtures(tie_id) where tie_id is not null;
create index if not exists standings_group_idx on public.standings(group_id) where group_id is not null;
create index if not exists psd_aging_idx on public.player_season_development(world_id, season_id, player_id) where not aging_done;
create index if not exists players_club_overall on public.players(club_id, overall desc) where not retired;

-- ---------------------------------------------------------------------
-- 3. RLS: Mitgliedschaft einmal je Abfrage statt einmal je Zeile
-- ---------------------------------------------------------------------
create or replace function public.fd_my_world_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.world_id), '{}'::uuid[]) from public.world_members m where m.user_id = (select auth.uid());
$$;
revoke execute on function public.fd_my_world_ids() from public, anon;
grant execute on function public.fd_my_world_ids() to authenticated, service_role;

do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and qual in ('is_world_member(world_id)', 'public.is_world_member(world_id)')
  loop
    execute format('alter policy %I on %I.%I using (world_id = any ((select public.fd_my_world_ids())::uuid[]))', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Zeitlimit für den Match-Server (service_role); Spieler-RPCs behalten ihr kurzes Limit
-- ---------------------------------------------------------------------
do $$
begin
  execute 'alter role service_role set statement_timeout = ''60s''';
exception when others then raise notice 'statement_timeout für service_role nicht gesetzt: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 5. Torjäger-/Vorlagen-/Notenlisten: einmal je Freigabe berechnen statt bei jedem Dashboard-Aufruf
-- ---------------------------------------------------------------------
create table if not exists public.fd_leaders_cache (
  competition_id uuid primary key references public.competitions(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.fd_leaders_cache enable row level security;

create or replace function public.fd_leaders_compute(p_comp uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'scorers', coalesce((select jsonb_agg(x order by (x ->> 'goals')::int desc, (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'goals', sum(ms.goals), 'assists', sum(ms.assists),
                                  'games', count(*), 'rating', round(avg(ms.rating), 2)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released'
        group by p.id, c.id, c.short_name having sum(ms.goals) > 0 order by sum(ms.goals) desc, sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'assists', coalesce((select jsonb_agg(x order by (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'assists', sum(ms.assists), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released'
        group by p.id, c.id, c.short_name having sum(ms.assists) > 0 order by sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'ratings', coalesce((select jsonb_agg(x order by (x ->> 'rating')::numeric desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'rating', round(avg(ms.rating), 2), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and ms.minutes >= 45
        group by p.id, c.id, c.short_name
        having count(*) >= greatest(1, (select count(distinct f2.slot_key) from public.fixtures f2 where f2.competition_id = p_comp and f2.status = 'released') / 3)
        order by avg(ms.rating) desc limit 20) s), '[]'::jsonb)
  );
$$;
revoke execute on function public.fd_leaders_compute(uuid) from public, anon, authenticated;

create or replace function public.league_leaders(p_comp uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_world uuid := (select world_id from public.competitions where id = p_comp);
  v_data jsonb;
begin
  if v_world is null or not public.is_world_member(v_world) then
    return jsonb_build_object('scorers', '[]'::jsonb, 'assists', '[]'::jsonb, 'ratings', '[]'::jsonb);
  end if;
  select data into v_data from public.fd_leaders_cache where competition_id = p_comp;
  return coalesce(v_data, public.fd_leaders_compute(p_comp));
end;
$$;
revoke execute on function public.league_leaders(uuid) from public, anon;
grant execute on function public.league_leaders(uuid) to authenticated;

-- Nach jeder Freigabe: Listen der betroffenen Wettbewerbe neu berechnen
create or replace function public.fd_refresh_leaders(p_world uuid, p_season uuid, p_slot_key text)
returns void
language plpgsql
set search_path = ''
as $$
declare r record;
begin
  for r in select distinct f.competition_id from public.fixtures f join public.competitions c on c.id = f.competition_id
           where f.world_id = p_world and f.season_id = p_season and f.slot_key = p_slot_key
             and c.kind::text in ('league', 'domestic_cup', 'champions_league', 'europa_league') loop
    insert into public.fd_leaders_cache(competition_id, data, updated_at)
    values (r.competition_id, public.fd_leaders_compute(r.competition_id), now())
    on conflict (competition_id) do update set data = excluded.data, updated_at = now();
  end loop;
end;
$$;
revoke execute on function public.fd_refresh_leaders(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Europapokal: Struktur
-- ---------------------------------------------------------------------
alter table public.season_slots drop constraint if exists season_slots_kind_check;
alter table public.season_slots add constraint season_slots_kind_check check (kind in ('league', 'cup', 'relegation', 'europe', 'season_end'));

-- Mannschaftsstärke = Schnitt der besten elf Spieler
create or replace function public.fd_club_strength(p_club uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(avg(o), 50) from (select p.overall o from public.players p where p.club_id = p_club and not p.retired order by p.overall desc limit 11) x;
$$;

create or replace function public.fd_group_table(p_group uuid)
returns table(club_id uuid, pos integer, points integer, gd integer, gf integer)
language sql
stable
set search_path = ''
as $$
  select s.club_id,
         (row_number() over (order by s.points desc, s.goals_for - s.goals_against desc, s.goals_for desc, c.name))::int,
         s.points::int, (s.goals_for - s.goals_against)::int, s.goals_for::int
  from public.standings s join public.clubs c on c.id = s.club_id
  where s.group_id = p_group;
$$;

-- Ein Europapokal-Spiel ohne menschlichen Manager wird kompakt berechnet
create or replace function public.fd_fixture_compact(p_fixture uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.fixtures f join public.competitions c on c.id = f.competition_id
    where f.id = p_fixture and c.kind::text in ('champions_league', 'europa_league')
      and not exists (select 1 from public.clubs cl where cl.id in (f.home_club_id, f.away_club_id) and cl.control = 'human'));
$$;

-- Prämie aus den Vorlagen (Europapokal)
create or replace function public.fd_ec_prize(p_comp uuid, p_club uuid, p_key text, p_ref text, p_label text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_c public.competitions;
  v_amount bigint;
begin
  select * into v_c from public.competitions where id = p_comp;
  select amount into v_amount from public.prize_templates where competition_kind = v_c.kind and tier = 0 and prize_key = p_key;
  if coalesce(v_amount, 0) = 0 then return; end if;
  perform public.fd_pay(p_club, 'competition_prize', v_amount, 'ec:' || p_comp || ':' || p_ref || ':' || p_club, v_c.name || ' · ' || p_label, v_c.season_id);
end;
$$;

-- K.-o.-Runde anlegen: Paarungen (a, b) mit Hin-/Rückspiel oder Finale (neutral)
create or replace function public.fd_ec_ko_round(p_comp uuid, p_stage public.stage_kind, p_pairs uuid[], p_slot1 text, p_slot2 text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_c public.competitions;
  v_stage uuid;
  v_ord smallint := case p_stage when 'quarter_final' then 2 when 'semi_final' then 3 else 4 end;
  v_i integer;
  v_tie uuid;
  v_a uuid; v_b uuid;
  s1 public.season_slots; s2 public.season_slots;
begin
  select * into v_c from public.competitions where id = p_comp;
  insert into public.competition_stages(competition_id, world_id, kind, ordinal, two_legged)
  values (p_comp, v_c.world_id, p_stage, v_ord, p_slot2 is not null)
  on conflict (competition_id, kind) do update set ordinal = excluded.ordinal returning id into v_stage;
  if exists (select 1 from public.ties where stage_id = v_stage) then return; end if;
  select * into s1 from public.season_slots where season_id = v_c.season_id and slot_key = p_slot1;
  if p_slot2 is not null then select * into s2 from public.season_slots where season_id = v_c.season_id and slot_key = p_slot2; end if;
  for v_i in 1..(coalesce(array_length(p_pairs, 1), 0) / 2) loop
    v_a := p_pairs[2 * v_i - 1]; v_b := p_pairs[2 * v_i];
    insert into public.ties(stage_id, world_id, club_a_id, club_b_id) values (v_stage, v_c.world_id, v_a, v_b) returning id into v_tie;
    if p_slot2 is null then
      insert into public.fixtures(world_id, season_id, competition_id, stage_id, tie_id, slot_key, scheduled_date, home_club_id, away_club_id, neutral_venue)
      values (v_c.world_id, v_c.season_id, p_comp, v_stage, v_tie, s1.slot_key, s1.slot_date, v_a, v_b, true);
    else
      -- Hinspiel beim zweitgenannten Verein (Gruppenzweiter), Rückspiel beim erstgenannten
      insert into public.fixtures(world_id, season_id, competition_id, stage_id, tie_id, leg, slot_key, scheduled_date, home_club_id, away_club_id)
      values (v_c.world_id, v_c.season_id, p_comp, v_stage, v_tie, 1, s1.slot_key, s1.slot_date, v_b, v_a),
             (v_c.world_id, v_c.season_id, p_comp, v_stage, v_tie, 2, s2.slot_key, s2.slot_date, v_a, v_b);
    end if;
  end loop;
  insert into public.draws(world_id, stage_id, seed, result)
  values (v_c.world_id, v_stage, (select seed from public.career_worlds where id = v_c.world_id),
          (select jsonb_agg(jsonb_build_array(club_a_id, club_b_id)) from public.ties where stage_id = v_stage))
  on conflict (stage_id) do nothing;
end;
$$;

-- Teilnehmer bestimmen, Gruppen auslosen, Gruppenspiele ansetzen (einmal je Saison)
create or replace function public.fd_setup_europe(p_world uuid, p_season uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_prev uuid;
  v_t1 uuid;
  v_cupwin uuid;
  v_active text[] := public.fd_active_assocs(p_world);
  v_kind text;
  v_comp uuid;
  v_stage uuid;
  v_groups uuid[];
  v_grp_assoc text[];
  v_list uuid[];
  v_pot integer;
  v_club uuid;
  v_assoc text;
  v_g integer;
  v_try integer;
  v_order integer[];
  v_mem uuid[];
  v_round integer;
  v_pairs integer[] := array[1,2, 3,4,  4,1, 2,3,  1,3, 4,2,  2,1, 4,3,  1,4, 3,2,  3,1, 2,4];
  v_slot public.season_slots;
  v_k integer;
  r record;
  v_seed text;
begin
  select * into v_w from public.career_worlds where id = p_world;
  if exists (select 1 from public.competitions where season_id = p_season and kind::text in ('champions_league', 'europa_league')) then
    return jsonb_build_object('status', 'exists');
  end if;
  if not exists (select 1 from public.season_slots where season_id = p_season and kind = 'europe') then
    return jsonb_build_object('status', 'no_slots');
  end if;
  v_seed := v_w.seed || ':' || p_season::text;
  create temporary table if not exists fd_tmp_ec (club_id uuid primary key, comp text, score numeric, assoc text) on commit drop;
  delete from fd_tmp_ec where true;

  -- a) Aktive Länder: sportliche Qualifikation über die 1. Liga der Vorsaison (+ Pokalsieger)
  select id into v_prev from public.seasons where world_id = p_world and status::text = 'closed' and id <> p_season order by year desc limit 1;
  if v_prev is not null then
    select id into v_t1 from public.competitions where season_id = v_prev and kind = 'league' and tier = 1;
  end if;
  if v_t1 is not null then
    insert into fd_tmp_ec(club_id, comp, score, assoc)
    select t.club_id, case when t.pos <= 4 then 'cl' else 'el' end, 100 - t.pos, c.association_code
    from public.fd_table(v_t1) t join public.clubs c on c.id = t.club_id where t.pos <= 6;
    select t.winner_club_id into v_cupwin from public.ties t join public.competition_stages st on st.id = t.stage_id
    join public.competitions c on c.id = st.competition_id where c.season_id = v_prev and c.kind = 'domestic_cup' and st.kind = 'final';
    if v_cupwin is not null and not exists (select 1 from fd_tmp_ec where club_id = v_cupwin) then
      insert into fd_tmp_ec values (v_cupwin, 'el', 90, (select association_code from public.clubs where id = v_cupwin));
    else
      insert into fd_tmp_ec(club_id, comp, score, assoc)
      select t.club_id, 'el', 93, c.association_code from public.fd_table(v_t1) t join public.clubs c on c.id = t.club_id where t.pos = 7
      on conflict do nothing;
    end if;
  else
    -- Erste Saison: die stärksten Erstligisten (4 Champions League, 3 Europa League)
    insert into fd_tmp_ec(club_id, comp, score, assoc)
    select x.club_id, case when x.rn <= 4 then 'cl' else 'el' end, 100 - x.rn, x.assoc from (
      select e.club_id, c.association_code as assoc, row_number() over (order by public.fd_club_strength(e.club_id) desc, e.club_id) rn
      from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
      where co.season_id = p_season and co.kind = 'league' and co.tier = 1) x
    where x.rn <= 7;
  end if;

  -- b) Nicht simulierte Länder: Auswahl nach Mannschaftsstärke mit begrenztem Zufall (±3 OVR),
  --    höchstens zwei Vereine je Land und Wettbewerb – starke Vereine sind deutlich häufiger dabei
  create temporary table if not exists fd_tmp_ec_cand (club_id uuid primary key, assoc text, score numeric) on commit drop;
  delete from fd_tmp_ec_cand where true;
  insert into fd_tmp_ec_cand
  select c.id, c.association_code, public.fd_club_strength(c.id) + (public.fd_hash01(v_seed || ':ec:' || c.id::text) - 0.5) * 6
  from public.clubs c
  where c.world_id = p_world and not c.amateur and c.control = 'ai'
    and not (c.association_code::text = any(v_active))
    and not exists (select 1 from fd_tmp_ec t where t.club_id = c.id);
  insert into fd_tmp_ec(club_id, comp, score, assoc)
  select club_id, 'cl', score, assoc from (
    select k.*, row_number() over (partition by k.assoc order by k.score desc) rn from fd_tmp_ec_cand k) x
  where x.rn <= 2 order by x.score desc limit greatest(0, 16 - (select count(*) from fd_tmp_ec where comp = 'cl'));
  delete from fd_tmp_ec_cand k where exists (select 1 from fd_tmp_ec t where t.club_id = k.club_id);
  insert into fd_tmp_ec(club_id, comp, score, assoc)
  select club_id, 'el', score, assoc from (
    select k.*, row_number() over (partition by k.assoc order by k.score desc) rn from fd_tmp_ec_cand k) x
  where x.rn <= 2 order by x.score desc limit greatest(0, 16 - (select count(*) from fd_tmp_ec where comp = 'el'));

  -- c) Zu wenige Europa-Vereine in der Welt: mit den nächstbesten Vereinen aktiver Länder auffüllen
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into fd_tmp_ec(club_id, comp, score, assoc)
    select c.id, v_kind, public.fd_club_strength(c.id), c.association_code from public.clubs c
    where c.world_id = p_world and not c.amateur and not exists (select 1 from fd_tmp_ec t where t.club_id = c.id)
    -- zuerst Vereine aktiver Länder (Länderlimit bleibt für die übrigen Länder gewahrt)
    order by (c.association_code::text = any(v_active)) desc, public.fd_club_strength(c.id) desc, c.id
    limit greatest(0, 16 - (select count(*) from fd_tmp_ec where comp = v_kind));
  end loop;

  -- d) Wettbewerbe, Gruppen (Lostöpfe nach Stärke, möglichst keine zwei Vereine eines Landes in einer Gruppe)
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into public.competitions(world_id, season_id, kind, association_code, name, neutral_final_venue)
    values (p_world, p_season, case v_kind when 'cl' then 'champions_league' else 'europa_league' end::public.competition_kind, null,
            case v_kind when 'cl' then 'Champions League' else 'Europa League' end, 'Neutraler Finalort')
    on conflict do nothing returning id into v_comp;
    if v_comp is null then
      select id into v_comp from public.competitions where season_id = p_season and kind::text = case v_kind when 'cl' then 'champions_league' else 'europa_league' end;
    end if;
    insert into public.competition_entries(competition_id, club_id, world_id, seed_rank)
    select v_comp, t.club_id, p_world, row_number() over (order by public.fd_club_strength(t.club_id) desc)
    from fd_tmp_ec t where t.comp = v_kind on conflict do nothing;
    insert into public.competition_stages(competition_id, world_id, kind, ordinal) values (v_comp, p_world, 'group', 1)
    on conflict (competition_id, kind) do update set ordinal = 1 returning id into v_stage;
    v_groups := array[]::uuid[];
    for v_g in 1..4 loop
      insert into public.competition_groups(stage_id, world_id, label) values (v_stage, p_world, chr(64 + v_g))
      on conflict (stage_id, label) do update set label = excluded.label returning id into v_club;
      v_groups := v_groups || v_club;
    end loop;
    v_grp_assoc := array['', '', '', ''];
    select array_agg(e.club_id order by e.seed_rank) into v_list from public.competition_entries e where e.competition_id = v_comp;
    for v_pot in 1..4 loop
      -- Reihenfolge innerhalb des Topfs aus dem Welt-Seed (reproduzierbare Auslosung)
      for v_club in select c from unnest(v_list[(v_pot - 1) * 4 + 1 : v_pot * 4]) c order by md5(v_seed || v_kind || v_pot || c::text) loop
        v_assoc := (select association_code from public.clubs where id = v_club);
        v_g := null;
        for v_try in select g from generate_series(1, 4) g order by md5(v_seed || v_club::text || g) loop
          if not exists (select 1 from public.group_memberships gm where gm.group_id = v_groups[v_try] and gm.pot = v_pot)
             and position('|' || v_assoc || '|' in v_grp_assoc[v_try]) = 0 then v_g := v_try; exit; end if;
        end loop;
        if v_g is null then
          select g into v_g from generate_series(1, 4) g
          where not exists (select 1 from public.group_memberships gm where gm.group_id = v_groups[g] and gm.pot = v_pot)
          order by g limit 1;
        end if;
        insert into public.group_memberships(group_id, club_id, world_id, pot) values (v_groups[v_g], v_club, p_world, v_pot) on conflict do nothing;
        v_grp_assoc[v_g] := v_grp_assoc[v_g] || '|' || v_assoc || '|';
        insert into public.standings(world_id, competition_id, group_id, club_id) values (p_world, v_comp, v_groups[v_g], v_club) on conflict do nothing;
        perform public.fd_ec_prize(v_comp, v_club, 'group_start', 'start', 'Startprämie Gruppenphase');
      end loop;
    end loop;
    -- Gruppenspiele: 6 Spieltage (jeder gegen jeden mit Hin- und Rückspiel)
    for v_g in 1..4 loop
      select array_agg(gm.club_id order by gm.pot) into v_mem from public.group_memberships gm where gm.group_id = v_groups[v_g];
      for v_round in 1..6 loop
        select * into v_slot from public.season_slots where season_id = p_season and slot_key = 'E' || v_round;
        for v_k in 0..1 loop
          insert into public.fixtures(world_id, season_id, competition_id, stage_id, group_id, slot_key, scheduled_date, home_club_id, away_club_id, matchday)
          values (p_world, p_season, v_comp, v_stage, v_groups[v_g], v_slot.slot_key, v_slot.slot_date,
                  v_mem[v_pairs[(v_round - 1) * 4 + v_k * 2 + 1]], v_mem[v_pairs[(v_round - 1) * 4 + v_k * 2 + 2]], v_round);
        end loop;
      end loop;
    end loop;
    insert into public.draws(world_id, stage_id, seed, result)
    values (p_world, v_stage, v_w.seed, (select jsonb_agg(jsonb_build_object('group', g.label, 'clubs', (select jsonb_agg(gm.club_id order by gm.pot) from public.group_memberships gm where gm.group_id = g.id)) order by g.label)
                                         from public.competition_groups g where g.stage_id = v_stage))
    on conflict (stage_id) do nothing;
    v_comp := null;
  end loop;
  perform public.fd_refresh_active_clubs(p_world);
  return jsonb_build_object('status', 'created', 'cl', (select count(*) from fd_tmp_ec where comp = 'cl'), 'el', (select count(*) from fd_tmp_ec where comp = 'el'));
end;
$$;

-- Nach einem Europapokal-Termin: nächste Runde ansetzen, Prämien, Titel
create or replace function public.fd_europe_progress(p_world uuid, p_slot public.season_slots)
returns void
language plpgsql
set search_path = ''
as $$
declare
  co record;
  v_pairs uuid[];
  v_win uuid[];
  g record;
  v_first uuid[] := array[]::uuid[];
  v_second uuid[] := array[]::uuid[];
  v_c uuid;
  v_seed text := (select seed from public.career_worlds where id = p_world);
  v_final uuid;
begin
  for co in select * from public.competitions where season_id = p_slot.season_id and kind::text in ('champions_league', 'europa_league') loop
    if p_slot.slot_key = 'E6' then
      v_first := array[]::uuid[]; v_second := array[]::uuid[];
      for g in select cg.id, cg.label from public.competition_groups cg join public.competition_stages st on st.id = cg.stage_id
               where st.competition_id = co.id and st.kind = 'group' order by cg.label loop
        v_first := v_first || (select club_id from public.fd_group_table(g.id) where pos = 1);
        v_second := v_second || (select club_id from public.fd_group_table(g.id) where pos = 2);
      end loop;
      if coalesce(array_length(v_first, 1), 0) = 4 then
        for v_c in select unnest(v_first) loop perform public.fd_ec_prize(co.id, v_c, 'group_winner', 'gw', 'Gruppensieg'); end loop;
        for v_c in select unnest(v_second) loop perform public.fd_ec_prize(co.id, v_c, 'group_runner_up', 'gr', 'Gruppenzweiter'); end loop;
        for v_c in select unnest(v_first || v_second) loop perform public.fd_ec_prize(co.id, v_c, 'reach_quarter_final', 'qf', 'Viertelfinale erreicht'); end loop;
        -- A1–B2, B1–A2, C1–D2, D1–C2
        v_pairs := array[v_first[1], v_second[2], v_first[2], v_second[1], v_first[3], v_second[4], v_first[4], v_second[3]];
        perform public.fd_ec_ko_round(co.id, 'quarter_final', v_pairs, 'E7', 'E8');
      end if;
    elsif p_slot.slot_key in ('E8', 'E10') then
      select array_agg(t.winner_club_id order by md5(v_seed || co.id::text || t.winner_club_id::text)) into v_win
      from public.ties t join public.competition_stages st on st.id = t.stage_id
      where st.competition_id = co.id and st.kind = case p_slot.slot_key when 'E8' then 'quarter_final' else 'semi_final' end::public.stage_kind
        and t.winner_club_id is not null;
      if p_slot.slot_key = 'E8' and coalesce(array_length(v_win, 1), 0) = 4 then
        for v_c in select unnest(v_win) loop perform public.fd_ec_prize(co.id, v_c, 'reach_semi_final', 'sf', 'Halbfinale erreicht'); end loop;
        perform public.fd_ec_ko_round(co.id, 'semi_final', v_win, 'E9', 'E10');
      elsif p_slot.slot_key = 'E10' and coalesce(array_length(v_win, 1), 0) = 2 then
        for v_c in select unnest(v_win) loop perform public.fd_ec_prize(co.id, v_c, 'reach_final', 'f', 'Finale erreicht'); end loop;
        perform public.fd_ec_ko_round(co.id, 'final', v_win, 'E11', null);
      end if;
    elsif p_slot.slot_key = 'E11' then
      select t.winner_club_id into v_final from public.ties t join public.competition_stages st on st.id = t.stage_id
      where st.competition_id = co.id and st.kind = 'final';
      if v_final is not null then
        perform public.fd_ec_prize(co.id, v_final, 'title', 'title', 'Titelgewinn');
        insert into public.season_awards(world_id, season_id, competition_id, kind, club_id)
        select p_world, co.season_id, co.id, case co.kind::text when 'champions_league' then 'cl_winner' else 'el_winner' end, v_final
        where not exists (select 1 from public.season_awards a where a.competition_id = co.id and a.kind in ('cl_winner', 'el_winner'));
      end if;
    end if;
  end loop;
end;
$$;

-- Kompakte Berechnung (Europapokal ohne menschlichen Manager): Ergebnis aus der Stärke der besten
-- Elf (dieselbe Formel wie die Ersatzberechnung), Torschützen, Vorlagen, Karten und Verletzungen.
-- Keine 2D-Simulation, keine Ereignisliste außer Toren/Karten/Verletzungen.
create or replace function public.fd_compact_result(p_fixture uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_date date;
  v_side text;
  v_club uuid;
  v_str numeric[] := array[60, 60];
  v_goals integer[] := array[0, 0];
  v_ids uuid[];
  v_pos text[];
  v_fit numeric[];
  v_players jsonb := '[]'::jsonb;
  v_events jsonb := '[]'::jsonb;
  v_stats jsonb := '{}'::jsonb;
  v_lineups jsonb := '{}'::jsonb;
  v_g integer;
  v_i integer;
  v_k integer;
  v_u numeric;
  v_w numeric[];
  v_tot numeric;
  v_scorer integer;
  v_assist integer;
  v_min integer;
  v_cards integer;
  v_pg integer[];
  v_pa integer[];
  v_py integer[];
  v_pr boolean[];
  v_inj boolean[];
  v_si integer;
  v_res jsonb;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.fixture_results where fixture_id = p_fixture) then return jsonb_build_object('status', 'already_saved'); end if;
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;
  v_str[1] := public.fd_club_strength(v_f.home_club_id);
  v_str[2] := public.fd_club_strength(v_f.away_club_id);
  v_goals[1] := public.fd_poisson(least(4, (case when v_f.neutral_venue then 1.3 else 1.45 end) * exp((v_str[1] - v_str[2]) / 12.0)), public.fd_hash01(v_f.rng_seed || ':compact:h')::numeric);
  v_goals[2] := public.fd_poisson(least(4, (case when v_f.neutral_venue then 1.3 else 1.15 end) * exp((v_str[2] - v_str[1]) / 12.0)), public.fd_hash01(v_f.rng_seed || ':compact:a')::numeric);
  for v_si in 1..2 loop
    v_side := case v_si when 1 then 'home' else 'away' end;
    v_club := case v_si when 1 then v_f.home_club_id else v_f.away_club_id end;
    -- Aufstellung: bester Torwart + zehn beste Feldspieler (ohne Verletzte)
    select array_agg(x.id order by x.gk desc, x.overall desc), array_agg(x.pos order by x.gk desc, x.overall desc), array_agg(x.fitness order by x.gk desc, x.overall desc)
    into v_ids, v_pos, v_fit from (
      (select p.id, p.overall, p.main_position::text pos, p.fitness, 1 gk from public.players p
       where p.club_id = v_club and not p.retired and p.main_position = 'GK'
         and not exists (select 1 from public.injuries i where i.player_id = p.id and v_date between i.starts_on and i.ends_on)
       order by p.overall desc limit 1)
      union all
      (select p.id, p.overall, p.main_position::text, p.fitness, 0 from public.players p
       where p.club_id = v_club and not p.retired and p.main_position <> 'GK'
         and not exists (select 1 from public.injuries i where i.player_id = p.id and v_date between i.starts_on and i.ends_on)
       order by p.overall desc limit 10)) x;
    if v_ids is null then continue; end if;
    v_pg := array_fill(0, array[array_length(v_ids, 1)]);
    v_pa := v_pg; v_py := v_pg;
    v_pr := array_fill(false, array[array_length(v_ids, 1)]);
    v_inj := v_pr;
    -- Torgefahr je Position
    v_w := array[]::numeric[];
    for v_i in 1..array_length(v_ids, 1) loop
      v_w := v_w || (case when v_pos[v_i] in ('ST', 'CF') then 5 when v_pos[v_i] in ('LW', 'RW', 'CAM') then 3 when v_pos[v_i] in ('LM', 'RM', 'CM') then 1.6
                          when v_pos[v_i] in ('CDM', 'LWB', 'RWB') then 0.9 when v_pos[v_i] in ('LB', 'RB', 'CB') then 0.5 else 0.02 end)::numeric;
    end loop;
    select sum(x) into v_tot from unnest(v_w) x;
    for v_g in 1..v_goals[v_si] loop
      v_u := public.fd_hash01(v_f.rng_seed || ':sc:' || v_side || v_g)::numeric * v_tot;
      v_scorer := array_length(v_ids, 1);
      for v_i in 1..array_length(v_ids, 1) loop
        v_u := v_u - v_w[v_i];
        if v_u <= 0 then v_scorer := v_i; exit; end if;
      end loop;
      v_pg[v_scorer] := v_pg[v_scorer] + 1;
      v_assist := null;
      if public.fd_hash01(v_f.rng_seed || ':as?:' || v_side || v_g) < 0.72 then
        v_assist := 2 + floor(public.fd_hash01(v_f.rng_seed || ':as:' || v_side || v_g) * (array_length(v_ids, 1) - 1))::int;
        if v_assist = v_scorer then v_assist := case when v_scorer < array_length(v_ids, 1) then v_scorer + 1 else 2 end; end if;
        if v_assist > array_length(v_ids, 1) or v_assist = v_scorer then v_assist := null; end if;
        if v_assist is not null then v_pa[v_assist] := v_pa[v_assist] + 1; end if;
      end if;
      v_min := 1 + floor(public.fd_hash01(v_f.rng_seed || ':min:' || v_side || v_g) * 90)::int;
      v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'goal', 'side', v_side, 'minute', v_min, 'second', v_min * 60,
        'playerId', v_ids[v_scorer], 'otherId', case when v_assist is not null then v_ids[v_assist] end, 'text', 'Tor'));
    end loop;
    -- Karten (im Schnitt ~1,6 Gelbe je Team, selten Rot) und Verletzungen (~5 % je Team)
    v_cards := public.fd_poisson(1.6, public.fd_hash01(v_f.rng_seed || ':y:' || v_side)::numeric);
    for v_k in 1..v_cards loop
      v_i := 2 + floor(public.fd_hash01(v_f.rng_seed || ':yc:' || v_side || v_k) * (array_length(v_ids, 1) - 1))::int;
      if v_i > array_length(v_ids, 1) then continue; end if;
      v_py[v_i] := least(2, v_py[v_i] + 1);
      v_min := 10 + floor(public.fd_hash01(v_f.rng_seed || ':ym:' || v_side || v_k) * 80)::int;
      v_events := v_events || jsonb_build_array(jsonb_build_object('type', case when v_py[v_i] = 2 then 'second_yellow' else 'yellow' end, 'side', v_side,
        'minute', v_min, 'second', v_min * 60, 'playerId', v_ids[v_i], 'text', 'Karte'));
      if v_py[v_i] = 2 then v_pr[v_i] := true; end if;
    end loop;
    if public.fd_hash01(v_f.rng_seed || ':r:' || v_side) < 0.035 then
      v_i := 2 + floor(public.fd_hash01(v_f.rng_seed || ':rp:' || v_side) * (array_length(v_ids, 1) - 1))::int;
      if v_i <= array_length(v_ids, 1) and not v_pr[v_i] then
        v_pr[v_i] := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'red', 'side', v_side, 'minute', 60, 'second', 3600, 'playerId', v_ids[v_i], 'text', 'Rote Karte'));
      end if;
    end if;
    if public.fd_hash01(v_f.rng_seed || ':inj:' || v_side) < 0.05 then
      v_i := 1 + floor(public.fd_hash01(v_f.rng_seed || ':injp:' || v_side) * array_length(v_ids, 1))::int;
      if v_i <= array_length(v_ids, 1) then
        v_inj[v_i] := true;
        v_events := v_events || jsonb_build_array(jsonb_build_object('type', 'injury', 'side', v_side, 'minute', 55, 'second', 3300, 'playerId', v_ids[v_i], 'text', 'Verletzung'));
      end if;
    end if;
    for v_i in 1..array_length(v_ids, 1) loop
      v_players := v_players || jsonb_build_array(jsonb_build_object(
        'playerId', v_ids[v_i], 'side', v_side, 'minutes', 90, 'goals', v_pg[v_i], 'assists', v_pa[v_i],
        'shots', v_pg[v_i] + floor(public.fd_hash01(v_f.rng_seed || ':sh:' || v_ids[v_i]::text) * (case when v_w[v_i] >= 3 then 4 else 2 end))::int,
        'shotsOnTarget', v_pg[v_i], 'xg', round(v_pg[v_i] * 0.45 + v_w[v_i] * 0.05, 2), 'passes', 30, 'passesCompleted', 25,
        'tacklesWon', 1, 'interceptions', 1, 'saves', case when v_i = 1 then greatest(0, 3 - v_goals[3 - v_si]) else 0 end,
        'rating', round(least(10, greatest(4, 6.4 + v_pg[v_i] * 0.9 + v_pa[v_i] * 0.5
                    + case when v_goals[v_si] > v_goals[3 - v_si] then 0.35 when v_goals[v_si] < v_goals[3 - v_si] then -0.3 else 0 end
                    - case when v_pr[v_i] then 1.2 else 0 end
                    + (public.fd_hash01(v_f.rng_seed || ':rt:' || v_ids[v_i]::text)::numeric - 0.5) * 0.9)), 1),
        'fitnessStart', v_fit[v_i], 'fitnessEnd', greatest(0, v_fit[v_i] - 28), 'yellow', v_py[v_i], 'red', v_pr[v_i], 'injured', v_inj[v_i]));
    end loop;
    v_stats := v_stats || jsonb_build_object(v_side, jsonb_build_object('xg', round(v_goals[v_si] * 0.85 + 0.4, 2), 'goals', v_goals[v_si]));
    v_lineups := v_lineups || jsonb_build_object(v_side, to_jsonb(v_ids));
  end loop;
  v_res := public.admin_finish_match(p_fixture, jsonb_build_object('score', jsonb_build_array(v_goals[1], v_goals[2]), 'events', v_events, 'players', v_players,
    'stats', v_stats, 'possessionHome', round(50 + (v_str[1] - v_str[2]) * 0.8), 'lineups', v_lineups, 'compact', true));
  insert into public.fd_sim_log(world_id, season_id, slot_key, fixture_id, competition_kind, mode, events, player_rows)
  values (v_f.world_id, v_f.season_id, v_f.slot_key, p_fixture, (select kind::text from public.competitions where id = v_f.competition_id), 'compact',
          jsonb_array_length(v_events), jsonb_array_length(v_players));
  return v_res || jsonb_build_object('score', jsonb_build_array(v_goals[1], v_goals[2]));
end;
$$;
revoke execute on function public.fd_compact_result(uuid) from public, anon, authenticated;

-- Mehrere kompakte Spiele des laufenden Termins gesammelt berechnen
create or replace function public.fd_compact_batch(p_world uuid, p_limit integer default 8)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  if (public.fd_current_slot(p_world)).state <> 'live' then return 0; end if;
  for r in select f.id from public.fixtures f
           where f.id in (select public.fd_slot_fixture_ids(p_world)) and f.status = 'scheduled' and public.fd_fixture_compact(f.id)
           order by f.id limit p_limit loop
    begin
      perform public.fd_compact_result(r.id);
      v_n := v_n + 1;
    exception when others then raise warning 'Kompaktberechnung %: %', r.id, sqlerrm;
    end;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.fd_compact_batch(uuid, integer) from public, anon, authenticated;

-- Termine ohne eigenes Spiel eines Menschen (Europapokal, Pokal nach dem Ausscheiden, Relegation)
-- starten ohne Bereit-Meldung
create or replace function public.fd_auto_begin(p_world uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_slot public.season_slots;
begin
  select * into v_w from public.career_worlds where id = p_world;
  if v_w.status::text <> 'season' then return false; end if;
  v_slot := public.fd_current_slot(p_world);
  if v_slot.id is null or v_slot.state <> 'pending' or v_slot.kind not in ('cup', 'europe', 'relegation') then return false; end if;
  if exists (select 1 from public.fixtures f join public.clubs c on c.id in (f.home_club_id, f.away_club_id)
             where f.world_id = p_world and f.season_id = v_slot.season_id and f.slot_key = v_slot.slot_key and f.status <> 'cancelled'
               and c.control = 'human') then
    return false;
  end if;
  perform 1 from public.career_worlds where id = p_world for update;
  perform public.fd_begin_slot(p_world);
  return true;
end;
$$;
revoke execute on function public.fd_auto_begin(uuid) from public, anon, authenticated;

-- Europapokal-Übersicht (Gruppen, K.-o.-Runden, Torschützen) für die App
create or replace function public.europe_overview(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season uuid;
begin
  if not public.is_world_member(p_world) then
    raise exception 'Kein Zugriff auf diese Welt.' using errcode = 'P0001', hint = 'forbidden';
  end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  return jsonb_build_object('season_id', v_season, 'competitions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', co.id, 'kind', co.kind, 'name', co.name,
      'groups', coalesce((select jsonb_agg(jsonb_build_object('label', g.label, 'table', (
          select jsonb_agg(jsonb_build_object('club_id', t.club_id, 'name', c.name, 'short', c.short_name, 'association', c.association_code,
                   'pos', t.pos, 'points', t.points, 'gd', t.gd, 'gf', t.gf, 'played', s.played, 'won', s.won, 'drawn', s.drawn, 'lost', s.lost) order by t.pos)
          from public.fd_group_table(g.id) t join public.clubs c on c.id = t.club_id
          join public.standings s on s.group_id = g.id and s.club_id = t.club_id)) order by g.label)
        from public.competition_groups g join public.competition_stages st on st.id = g.stage_id where st.competition_id = co.id), '[]'::jsonb),
      'fixtures', coalesce((select jsonb_agg(jsonb_build_object(
          'id', f.id, 'stage', st.kind, 'group', g.label, 'leg', f.leg, 'slot_key', f.slot_key, 'date', f.scheduled_date, 'status', f.status,
          'home', jsonb_build_object('id', h.id, 'name', h.name, 'short', h.short_name, 'association', h.association_code),
          'away', jsonb_build_object('id', a.id, 'name', a.name, 'short', a.short_name, 'association', a.association_code),
          'result', case when public.can_see_fixture_result(f.id) then (select jsonb_build_object('home', r.home_goals, 'away', r.away_goals, 'hp', r.home_penalties, 'ap', r.away_penalties)
                                                                         from public.fixture_results r where r.fixture_id = f.id) end)
          order by f.scheduled_date, g.label nulls last, f.leg nulls first)
        from public.fixtures f join public.competition_stages st on st.id = f.stage_id
        left join public.competition_groups g on g.id = f.group_id
        join public.clubs h on h.id = f.home_club_id join public.clubs a on a.id = f.away_club_id
        where f.competition_id = co.id), '[]'::jsonb),
      'winner', (select jsonb_build_object('id', c.id, 'name', c.name) from public.ties t join public.competition_stages st on st.id = t.stage_id
                 join public.clubs c on c.id = t.winner_club_id where st.competition_id = co.id and st.kind = 'final'
                   and exists (select 1 from public.fixtures f where f.tie_id = t.id and f.status = 'released')),
      'leaders', public.league_leaders(co.id)
    ) order by co.kind)
    from public.competitions co where co.season_id = v_season and co.kind::text in ('champions_league', 'europa_league')), '[]'::jsonb));
end;
$$;
revoke execute on function public.europe_overview(uuid) from public, anon;
grant execute on function public.europe_overview(uuid) to authenticated;

-- Nachweis: simulierte und gespeicherte Spiele je Termin
create or replace function public.admin_sim_report(p_world uuid)
returns table(slot_key text, label text, competition text, mode text, games bigint, events bigint, player_rows bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select l.slot_key, s.label, l.competition_kind || coalesce(' ' || l.association, ''), l.mode, count(*), sum(l.events), sum(l.player_rows)
  from public.fd_sim_log l
  join public.career_worlds w on w.id = l.world_id
  left join public.season_slots s on s.season_id = l.season_id and s.slot_key = l.slot_key
  where l.world_id = p_world and l.season_id = w.current_season_id
  group by l.slot_key, s.label, s.ordinal, l.competition_kind, l.association, l.mode
  order by s.ordinal nulls last, 3, 4;
$$;
revoke execute on function public.admin_sim_report(uuid) from public, anon, authenticated;
-- ---------------------------------------------------------------------
-- 7. Fankultur: Schwenkfahnen, Choreografien, Ultragruppen (rein optisch, keine Kosten/Boni)
-- ---------------------------------------------------------------------
create table if not exists public.club_fan_culture (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  flags jsonb not null default '[]'::jsonb,
  ultras jsonb not null default '[]'::jsonb,
  default_choreo_id uuid,
  auto_choreo boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.club_choreos (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  name text not null,
  design jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists club_choreos_club on public.club_choreos(club_id);
create table if not exists public.fixture_choreos (
  fixture_id uuid primary key references public.fixtures(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  choreo_id uuid references public.club_choreos(id) on delete cascade
);
create index if not exists fixture_choreos_choreo on public.fixture_choreos(choreo_id);

-- Stadionsound: Hymnen und Fangesänge (Synthesizer-Rezept oder hochgeladene MP3)
create table if not exists public.club_audio (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  kind text not null check (kind in ('anthem', 'chant')),
  ultra_id text,
  name text not null,
  style text,
  mood text,
  voice text,
  lyrics text,
  source text not null check (source in ('synth', 'upload')),
  recipe jsonb,
  storage_path text,
  situation text check (situation in ('attack', 'goal', 'behind', 'lead', 'derby')),
  is_official boolean not null default false,
  is_signature boolean not null default false,
  volume numeric not null default 0.8 check (volume between 0 and 1),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists club_audio_club on public.club_audio(club_id);

alter table public.club_fan_culture enable row level security;
alter table public.club_choreos enable row level security;
alter table public.fixture_choreos enable row level security;
alter table public.club_audio enable row level security;
drop policy if exists read_world_members on public.club_fan_culture;
create policy read_world_members on public.club_fan_culture for select to authenticated using (world_id = any ((select public.fd_my_world_ids())::uuid[]));
drop policy if exists read_world_members on public.club_choreos;
create policy read_world_members on public.club_choreos for select to authenticated using (world_id = any ((select public.fd_my_world_ids())::uuid[]));
drop policy if exists read_world_members on public.fixture_choreos;
create policy read_world_members on public.fixture_choreos for select to authenticated using (world_id = any ((select public.fd_my_world_ids())::uuid[]));
drop policy if exists read_world_members on public.club_audio;
create policy read_world_members on public.club_audio for select to authenticated using (world_id = any ((select public.fd_my_world_ids())::uuid[]));

-- Prüfungen
create or replace function public.fd_hex_list(p jsonb, p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and p_max
    and not exists (select 1 from jsonb_array_elements(p) c where jsonb_typeof(c) <> 'string' or not public.is_hex_color(c #>> '{}'));
$$;

create or replace function public.fd_valid_flag(f jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(f) = 'object'
    and coalesce(f ->> 'shape', '') in ('rect', 'square', 'triangle', 'swallow', 'banner')
    and coalesce(f ->> 'size', '') in ('s', 'm', 'l')
    and coalesce(f ->> 'pattern', '') in ('solid', 'stripes_h', 'stripes_v', 'diagonal', 'halves', 'cross', 'checker', 'star')
    and public.fd_hex_list(f -> 'colors', 3)
    and char_length(coalesce(f ->> 'text', '')) <= 16;
$$;

create or replace function public.fd_valid_choreo(d jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(d) = 'object'
    and coalesce(d ->> 'pattern', '') in ('stripes', 'blocks', 'checker', 'wave', 'gradient', 'rays', 'mosaic')
    and coalesce(d ->> 'motif', 'none') in ('none', 'star', 'heart', 'crown', 'crest', 'lion', 'eagle', 'anchor', 'castle')
    and coalesce(d ->> 'block', 'home_curve') in ('home_curve', 'main_stand', 'back_stand', 'all')
    and public.fd_hex_list(d -> 'colors', 4)
    and char_length(coalesce(d ->> 'text', '')) <= 24;
$$;

create or replace function public.fd_valid_ultras(u jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(u) = 'array' and jsonb_array_length(u) <= 4
    and not exists (
      select 1 from jsonb_array_elements(u) g
      where jsonb_typeof(g) <> 'object'
         or char_length(btrim(coalesce(g ->> 'name', ''))) not between 3 and 32
         or char_length(coalesce(g ->> 'id', '')) not between 4 and 40
         or char_length(coalesce(g ->> 'banner', '')) > 28
         or coalesce(g ->> 'block', '') not in ('home_curve', 'main_stand', 'back_stand', 'corner_left', 'corner_right')
         or not public.fd_hex_list(g -> 'colors', 3)
         or (g ? 'flag' and g -> 'flag' <> 'null'::jsonb and not public.fd_valid_flag(g -> 'flag')));
$$;

-- Meine Fankultur (Editor)
create or replace function public.fan_culture(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_fc public.club_fan_culture;
  v_next record;
begin
  select * into v_fc from public.club_fan_culture where club_id = v_club;
  select f.id, f.scheduled_date, s.label, a.name as opponent, c.kind::text as kind into v_next
  from public.fixtures f join public.career_worlds w on w.id = f.world_id
  join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
  join public.clubs a on a.id = f.away_club_id join public.competitions c on c.id = f.competition_id
  where f.world_id = p_world and f.season_id = w.current_season_id and f.home_club_id = v_club and f.status = 'scheduled'
    and not f.neutral_venue and c.kind::text <> 'friendly'
  order by s.ordinal limit 1;
  return jsonb_build_object(
    'club_id', v_club,
    'club', (select jsonb_build_object('name', c.name, 'short', c.short_name, 'primary', b.primary_color, 'secondary', b.secondary_color,
                                       'capacity', st.capacity, 'design', st.design,
                                       'attendance', (select r.attendance from public.fixture_results r join public.fixtures f on f.id = r.fixture_id
                                                      where f.home_club_id = c.id and r.attendance is not null order by f.scheduled_date desc limit 1))
             from public.clubs c left join public.club_branding b on b.club_id = c.id left join public.stadiums st on st.club_id = c.id where c.id = v_club),
    'flags', coalesce(v_fc.flags, '[]'::jsonb),
    'ultras', coalesce(v_fc.ultras, '[]'::jsonb),
    'default_choreo_id', v_fc.default_choreo_id,
    'auto_choreo', coalesce(v_fc.auto_choreo, true),
    'choreos', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'design', design) order by created_at) from public.club_choreos where club_id = v_club), '[]'::jsonb),
    'audio', coalesce((select jsonb_agg(to_jsonb(a) - 'world_id' order by a.kind, a.created_at) from public.club_audio a where a.club_id = v_club), '[]'::jsonb),
    'next_home', case when v_next.id is null then null else jsonb_build_object('fixture_id', v_next.id, 'date', v_next.scheduled_date, 'label', v_next.label,
      'opponent', v_next.opponent, 'kind', v_next.kind, 'choreo_id', (select choreo_id from public.fixture_choreos where fixture_id = v_next.id)) end
  );
end;
$$;

create or replace function public.save_fan_culture(p_world uuid, p_flags jsonb, p_ultras jsonb, p_default_choreo uuid, p_auto boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if jsonb_typeof(coalesce(p_flags, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_flags, '[]'::jsonb)) > 8
     or exists (select 1 from jsonb_array_elements(coalesce(p_flags, '[]'::jsonb)) f where not public.fd_valid_flag(f)) then
    raise exception 'Ungültige Fahnen (höchstens 8).' using errcode = '22023', hint = 'invalid_flags';
  end if;
  if not public.fd_valid_ultras(coalesce(p_ultras, '[]'::jsonb)) then
    raise exception 'Ungültige Ultragruppen (höchstens 4, Name 3–32 Zeichen).' using errcode = '22023', hint = 'invalid_ultras';
  end if;
  if p_default_choreo is not null and not exists (select 1 from public.club_choreos where id = p_default_choreo and club_id = v_club) then
    raise exception 'Choreografie nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  insert into public.club_fan_culture(club_id, world_id, flags, ultras, default_choreo_id, auto_choreo, updated_at)
  values (v_club, p_world, coalesce(p_flags, '[]'::jsonb), coalesce(p_ultras, '[]'::jsonb), p_default_choreo, coalesce(p_auto, true), now())
  on conflict (club_id) do update set flags = excluded.flags, ultras = excluded.ultras, default_choreo_id = excluded.default_choreo_id,
    auto_choreo = excluded.auto_choreo, updated_at = now();
  return public.fan_culture(p_world);
end;
$$;

create or replace function public.save_choreo(p_world uuid, p_id uuid, p_name text, p_design jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if char_length(v_name) not between 2 and 40 then raise exception 'Der Name muss 2 bis 40 Zeichen haben.' using errcode = '22023', hint = 'invalid_name'; end if;
  if not public.fd_valid_choreo(p_design) then raise exception 'Ungültige Choreografie.' using errcode = '22023', hint = 'invalid_design'; end if;
  if p_id is null then
    if (select count(*) from public.club_choreos where club_id = v_club) >= 12 then
      raise exception 'Höchstens 12 gespeicherte Choreografien.' using errcode = 'P0001', hint = 'limit';
    end if;
    insert into public.club_choreos(club_id, world_id, name, design) values (v_club, p_world, v_name, p_design) returning id into v_id;
  else
    update public.club_choreos set name = v_name, design = p_design where id = p_id and club_id = v_club returning id into v_id;
    if v_id is null then raise exception 'Choreografie nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_choreo(p_world uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  update public.club_fan_culture set default_choreo_id = null where club_id = v_club and default_choreo_id = p_id;
  delete from public.club_choreos where id = p_id and club_id = v_club;
end;
$$;

-- Choreografie für ein bevorstehendes Heimspiel wählen (null = Standard/Automatik)
create or replace function public.set_fixture_choreo(p_world uuid, p_fixture uuid, p_choreo uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if not exists (select 1 from public.fixtures where id = p_fixture and world_id = p_world and home_club_id = v_club and status = 'scheduled') then
    raise exception 'Nur für eigene, noch nicht begonnene Heimspiele.' using errcode = 'P0001', hint = 'not_home';
  end if;
  if p_choreo is not null and not exists (select 1 from public.club_choreos where id = p_choreo and club_id = v_club) then
    raise exception 'Choreografie nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  if p_choreo is null then delete from public.fixture_choreos where fixture_id = p_fixture;
  else
    insert into public.fixture_choreos(fixture_id, club_id, world_id, choreo_id) values (p_fixture, v_club, p_world, p_choreo)
    on conflict (fixture_id) do update set choreo_id = excluded.choreo_id;
  end if;
end;
$$;

-- Stadionsound speichern (neu oder ändern)
create or replace function public.save_club_audio(p_world uuid, p_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_kind text := p_payload ->> 'kind';
  v_source text := p_payload ->> 'source';
  v_name text := btrim(coalesce(p_payload ->> 'name', ''));
  v_path text := nullif(p_payload ->> 'storage_path', '');
  v_id uuid;
begin
  if v_kind not in ('anthem', 'chant') or v_source not in ('synth', 'upload') then
    raise exception 'Ungültige Art.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if char_length(v_name) not between 2 and 40 then raise exception 'Der Name muss 2 bis 40 Zeichen haben.' using errcode = '22023', hint = 'invalid_name'; end if;
  if char_length(coalesce(p_payload ->> 'lyrics', '')) > 1200 then raise exception 'Der Text ist zu lang (höchstens 1200 Zeichen).' using errcode = '22023', hint = 'invalid_lyrics'; end if;
  if v_source = 'upload' and (v_path is null or split_part(v_path, '/', 1) <> p_world::text or split_part(v_path, '/', 2) <> v_club::text) then
    raise exception 'Ungültige Datei.' using errcode = '22023', hint = 'invalid_file';
  end if;
  if v_source = 'synth' and jsonb_typeof(p_payload -> 'recipe') <> 'object' then
    raise exception 'Rezept fehlt.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if coalesce(p_payload ->> 'situation', '') not in ('', 'attack', 'goal', 'behind', 'lead', 'derby') then
    raise exception 'Ungültige Spielsituation.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if p_payload ->> 'ultra_id' is not null and not exists (
       select 1 from public.club_fan_culture fc, jsonb_array_elements(fc.ultras) u where fc.club_id = v_club and u ->> 'id' = p_payload ->> 'ultra_id') then
    raise exception 'Ultragruppe nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  if p_id is null then
    if (select count(*) from public.club_audio where club_id = v_club and kind = v_kind) >= (case v_kind when 'anthem' then 6 else 24 end) then
      raise exception 'Höchstzahl erreicht (6 Hymnen, 24 Gesänge).' using errcode = 'P0001', hint = 'limit';
    end if;
    insert into public.club_audio(club_id, world_id, kind, ultra_id, name, style, mood, voice, lyrics, source, recipe, storage_path, situation, volume, enabled)
    values (v_club, p_world, v_kind, p_payload ->> 'ultra_id', v_name, left(p_payload ->> 'style', 30), left(p_payload ->> 'mood', 30), left(p_payload ->> 'voice', 30),
            p_payload ->> 'lyrics', v_source, case when v_source = 'synth' then p_payload -> 'recipe' end, case when v_source = 'upload' then v_path end,
            nullif(p_payload ->> 'situation', ''), least(1, greatest(0, coalesce((p_payload ->> 'volume')::numeric, 0.8))), coalesce((p_payload ->> 'enabled')::boolean, true))
    returning id into v_id;
  else
    update public.club_audio set name = v_name, ultra_id = p_payload ->> 'ultra_id', style = left(p_payload ->> 'style', 30), mood = left(p_payload ->> 'mood', 30),
      voice = left(p_payload ->> 'voice', 30), lyrics = p_payload ->> 'lyrics',
      recipe = case when source = 'synth' then coalesce(p_payload -> 'recipe', recipe) else recipe end,
      situation = nullif(p_payload ->> 'situation', ''), volume = least(1, greatest(0, coalesce((p_payload ->> 'volume')::numeric, volume))),
      enabled = coalesce((p_payload ->> 'enabled')::boolean, enabled)
    where id = p_id and club_id = v_club returning id into v_id;
    if v_id is null then raise exception 'Eintrag nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  end if;
  return v_id;
end;
$$;

-- Rolle festlegen: offizielle Vereinshymne bzw. Signatur-Fangesang (je Verein genau einer)
create or replace function public.set_audio_role(p_world uuid, p_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if p_role = 'official' then
    if not exists (select 1 from public.club_audio where id = p_id and club_id = v_club and kind = 'anthem') then
      raise exception 'Hymne nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
    end if;
    update public.club_audio set is_official = (id = p_id) where club_id = v_club and kind = 'anthem';
  elsif p_role = 'signature' then
    if not exists (select 1 from public.club_audio where id = p_id and club_id = v_club and kind = 'chant') then
      raise exception 'Fangesang nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
    end if;
    update public.club_audio set is_signature = (id = p_id) where club_id = v_club and kind = 'chant';
  else
    raise exception 'Ungültige Rolle.' using errcode = '22023', hint = 'invalid_payload';
  end if;
end;
$$;

-- Löschen; liefert den Speicherpfad zurück, damit die App die Datei entfernen kann
create or replace function public.delete_club_audio(p_world uuid, p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_path text;
begin
  delete from public.club_audio where id = p_id and club_id = v_club returning storage_path into v_path;
  return v_path;
end;
$$;

-- Für das Match: Fahnen, Ultras, Choreografie und Sound des Heimvereins
create or replace function public.fd_fan_view(p_fixture uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'flags', coalesce(fc.flags, '[]'::jsonb),
    'ultras', coalesce(fc.ultras, '[]'::jsonb),
    'choreo', coalesce(
      (select ch.design || jsonb_build_object('name', ch.name) from public.fixture_choreos x join public.club_choreos ch on ch.id = x.choreo_id where x.fixture_id = f.id),
      case when coalesce(fc.auto_choreo, true) then
        coalesce((select ch.design || jsonb_build_object('name', ch.name) from public.club_choreos ch where ch.id = fc.default_choreo_id),
                 jsonb_build_object('pattern', 'stripes', 'colors', jsonb_build_array(b.primary_color, b.secondary_color), 'text', h.short_name, 'motif', 'crest', 'block', 'home_curve', 'name', 'Standard'))
      end),
    'audio', jsonb_build_object(
      'anthem', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'recipe', a.recipe, 'path', a.storage_path, 'lyrics', a.lyrics, 'volume', a.volume)
                 from public.club_audio a where a.club_id = h.id and a.kind = 'anthem' and a.enabled order by a.is_official desc, a.created_at limit 1),
      'signature', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'recipe', a.recipe, 'path', a.storage_path, 'lyrics', a.lyrics, 'volume', a.volume)
                    from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled order by a.is_signature desc, a.created_at limit 1),
      'chants', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'recipe', a.recipe, 'path', a.storage_path,
                                  'lyrics', a.lyrics, 'volume', a.volume, 'situation', a.situation))
                          from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled and a.situation is not null), '[]'::jsonb)),
    'walkout', (select c.kind::text <> 'friendly' from public.competitions c where c.id = f.competition_id)
  )
  from public.fixtures f join public.clubs h on h.id = f.home_club_id
  left join public.club_branding b on b.club_id = h.id
  left join public.club_fan_culture fc on fc.club_id = h.id
  where f.id = p_fixture;
$$;

revoke execute on function public.fan_culture(uuid) from public, anon;
revoke execute on function public.save_fan_culture(uuid, jsonb, jsonb, uuid, boolean) from public, anon;
revoke execute on function public.save_choreo(uuid, uuid, text, jsonb) from public, anon;
revoke execute on function public.delete_choreo(uuid, uuid) from public, anon;
revoke execute on function public.set_fixture_choreo(uuid, uuid, uuid) from public, anon;
revoke execute on function public.save_club_audio(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.set_audio_role(uuid, uuid, text) from public, anon;
revoke execute on function public.delete_club_audio(uuid, uuid) from public, anon;
grant execute on function public.fan_culture(uuid) to authenticated;
grant execute on function public.save_fan_culture(uuid, jsonb, jsonb, uuid, boolean) to authenticated;
grant execute on function public.save_choreo(uuid, uuid, text, jsonb) to authenticated;
grant execute on function public.delete_choreo(uuid, uuid) to authenticated;
grant execute on function public.set_fixture_choreo(uuid, uuid, uuid) to authenticated;
grant execute on function public.save_club_audio(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_audio_role(uuid, uuid, text) to authenticated;
grant execute on function public.delete_club_audio(uuid, uuid) to authenticated;
revoke execute on function public.fd_fan_view(uuid) from public, anon, authenticated;

-- Speicher für hochgeladene Hymnen/Gesänge: öffentlich lesbar (Abspielen im Browser),
-- schreiben nur in den Ordner des eigenen Vereins: <welt>/<verein>/<datei>.mp3, höchstens 10 MB
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    values ('club-audio', 'club-audio', true, 10485760, array['audio/mpeg', 'audio/mp3'])
    on conflict (id) do update set public = true, file_size_limit = 10485760, allowed_mime_types = array['audio/mpeg', 'audio/mp3'];
    execute 'drop policy if exists club_audio_insert on storage.objects';
    execute 'drop policy if exists club_audio_delete on storage.objects';
    execute $p$create policy club_audio_insert on storage.objects for insert to authenticated with check (
      bucket_id = 'club-audio' and exists (select 1 from public.clubs c where c.manager_user_id = (select auth.uid())
        and c.world_id::text = (storage.foldername(name))[1] and c.id::text = (storage.foldername(name))[2]))$p$;
    execute $p$create policy club_audio_delete on storage.objects for delete to authenticated using (
      bucket_id = 'club-audio' and exists (select 1 from public.clubs c where c.manager_user_id = (select auth.uid())
        and c.world_id::text = (storage.foldername(name))[1] and c.id::text = (storage.foldername(name))[2]))$p$;
  end if;
exception when others then raise notice 'Speicher-Bucket bitte prüfen: %', sqlerrm;
end $$;
-- fd_start_season
CREATE OR REPLACE FUNCTION public.fd_start_season(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_season public.seasons;
  v_start date;
  v_md integer;
  v_date date;
  v_ord integer := 0;
  v_cup uuid;
  r record;
  v_slots jsonb := '[]'::jsonb;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if v_world.status <> 'preseason' then return; end if;
  select * into v_season from public.seasons where id = v_world.current_season_id;
  if exists (select 1 from public.season_slots where season_id = v_season.id) then return; end if;
  perform public.fd_ensure_amateurs(p_world);
  v_start := make_date(v_season.year, 8, 1);
  v_start := v_start + ((6 - extract(dow from v_start)::int + 7) % 7); -- erster Samstag im August

  -- Termine (Liga samstags, Pokal mittwochs, Winterpause nach dem 17. Spieltag)
  create temp table if not exists fd_tmp_slots (slot_key text, kind text, label text, slot_date date, matchday smallint, cup_stage public.stage_kind) on commit drop;
  delete from fd_tmp_slots where true; -- Supabase (pg-safeupdate) verlangt eine WHERE-Klausel
  insert into fd_tmp_slots values ('C1', 'cup', 'Pokal · 1. Runde', v_start, null, 'round_of_64');
  for v_md in 1..34 loop
    v_date := v_start + 7 * v_md + case when v_md > 17 then 35 else 0 end;
    insert into fd_tmp_slots values ('L' || v_md, 'league', v_md || '. Spieltag', v_date, v_md, null);
    -- Europapokal dienstags: 6 Gruppenspieltage, Viertel- und Halbfinale mit Hin- und Rückspiel
    if v_md in (2, 4, 6, 9, 11, 13, 19, 21, 24, 26) then
      insert into fd_tmp_slots values ('E' || array_position(array[2, 4, 6, 9, 11, 13, 19, 21, 24, 26], v_md), 'europe',
        case when v_md <= 13 then 'Europapokal · Gruppenphase ' || array_position(array[2, 4, 6, 9, 11, 13], v_md)
             when v_md = 19 then 'Europapokal · Viertelfinale (Hinspiel)' when v_md = 21 then 'Europapokal · Viertelfinale (Rückspiel)'
             when v_md = 24 then 'Europapokal · Halbfinale (Hinspiel)' else 'Europapokal · Halbfinale (Rückspiel)' end,
        v_date + 3, null,
        case when v_md <= 13 then 'group' when v_md <= 21 then 'quarter_final' else 'semi_final' end::public.stage_kind);
    end if;
    if v_md = 7 then insert into fd_tmp_slots values ('C2', 'cup', 'Pokal · 2. Runde', v_date + 4, null, 'round_of_32'); end if;
    if v_md = 13 then insert into fd_tmp_slots values ('C3', 'cup', 'Pokal · Achtelfinale', v_date + 4, null, 'round_of_16'); end if;
    if v_md = 20 then insert into fd_tmp_slots values ('C4', 'cup', 'Pokal · Viertelfinale', v_date + 4, null, 'quarter_final'); end if;
    if v_md = 27 then insert into fd_tmp_slots values ('C5', 'cup', 'Pokal · Halbfinale', v_date + 4, null, 'semi_final'); end if;
    if v_md = 34 then
      insert into fd_tmp_slots values ('R1', 'relegation', 'Relegation · Hinspiel', v_date + 4, null, null);
      insert into fd_tmp_slots values ('R2', 'relegation', 'Relegation · Rückspiel', v_date + 7, null, null);
      insert into fd_tmp_slots values ('C6', 'cup', 'Pokalfinale', v_date + 14, null, 'final');
      insert into fd_tmp_slots values ('E11', 'europe', 'Europapokal · Finale', v_date + 10, null, 'final');
      insert into fd_tmp_slots values ('END', 'season_end', 'Saisonabschluss', v_date + 21, null, null);
    end if;
  end loop;
  insert into public.season_slots(world_id, season_id, ordinal, slot_key, kind, label, slot_date, matchday, cup_stage)
  select p_world, v_season.id, row_number() over (order by slot_date, slot_key), slot_key, kind, label, slot_date, matchday, cup_stage
  from fd_tmp_slots;

  -- Ligen: Spielpläne und Tabellen
  for r in select id from public.competitions where season_id = v_season.id and kind = 'league' loop
    perform public.fd_schedule_league(r.id);
    insert into public.standings(world_id, competition_id, club_id)
    select p_world, r.id, e.club_id from public.competition_entries e where e.competition_id = r.id
    on conflict do nothing;
  end loop;

  -- Pokal: 54 Profis + 10 Amateure
  insert into public.competitions(world_id, season_id, kind, association_code, name, neutral_final_venue)
  values (p_world, v_season.id, 'domestic_cup', 'GER', 'DFB-Pokal', 'Neutraler Finalort')
  on conflict do nothing;
  select id into v_cup from public.competitions where season_id = v_season.id and kind = 'domestic_cup';
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_cup, e.club_id, p_world from public.competition_entries e join public.competitions c on c.id = e.competition_id
  where c.season_id = v_season.id and c.kind = 'league'
  union all
  select v_cup, id, p_world from public.clubs where world_id = p_world and amateur
  on conflict do nothing;
  perform public.fd_draw_cup_round(v_cup, 'round_of_64', (select array_agg(club_id) from public.competition_entries where competition_id = v_cup));

  -- Europapokal: Teilnehmer, Gruppen, Spielplan; danach Liste der Vereine mit Spielbetrieb
  perform public.fd_setup_europe(p_world, v_season.id);
  perform public.fd_refresh_active_clubs(p_world);

  -- Transferfenster (H1)
  insert into public.transfer_windows(world_id, season_id, window_no, next_matchday_from, next_matchday_to)
  values (p_world, v_season.id, 1, 1, 5), (p_world, v_season.id, 2, 18, 22)
  on conflict do nothing;

  update public.seasons set status = 'running', starts_on = v_start, ends_on = (select max(slot_date) from public.season_slots where season_id = v_season.id)
  where id = v_season.id;
  update public.career_worlds set status = 'season', current_slot = 1, current_week = 1, current_date_in_world = v_start - 3
  where id = p_world;
  delete from public.multiplayer_readiness where world_id = p_world and context = 'preseason';
end;
$function$;

-- fd_release_slot
CREATE OR REPLACE FUNCTION public.fd_release_slot(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_nleague integer;
  v_kleague integer;
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_next public.season_slots;
  f record;
  v_res public.fixture_results;
  v_tier smallint;
  v_hw integer; v_hd integer; v_hl integer;
  v_price integer;
  v_cap integer;
  v_win uuid;
  v_days integer;
  v_cup uuid;
  v_stage public.stage_kind;
  v_next_stage public.stage_kind;
  v_winners uuid[];
  v_first public.fixture_results;
  v_tie public.ties;
  v_cup_prize bigint;
  r record;
  v_sp record;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_slot.state <> 'live' then return; end if;

  for f in
    select fx.*, c.kind::text as comp_kind, c.tier as comp_tier, st.kind as stage_kind
    from public.fixtures fx join public.competitions c on c.id = fx.competition_id
    left join public.competition_stages st on st.id = fx.stage_id
    where fx.id in (select public.fd_slot_fixture_ids(p_world))
  loop
    select * into v_res from public.fixture_results where fixture_id = f.id;
    v_hw := (v_res.home_goals > v_res.away_goals)::int; v_hd := (v_res.home_goals = v_res.away_goals)::int; v_hl := (v_res.home_goals < v_res.away_goals)::int;
    if f.comp_kind = 'league' then
      update public.standings s set
        played = played + 1, won = won + v_hw, drawn = drawn + v_hd, lost = lost + v_hl,
        goals_for = goals_for + v_res.home_goals, goals_against = goals_against + v_res.away_goals, points = points + 3 * v_hw + v_hd,
        home = jsonb_build_object('p', (home ->> 'p')::int + 1, 'w', (home ->> 'w')::int + v_hw, 'd', (home ->> 'd')::int + v_hd, 'l', (home ->> 'l')::int + v_hl,
                                  'gf', (home ->> 'gf')::int + v_res.home_goals, 'ga', (home ->> 'ga')::int + v_res.away_goals)
      where s.competition_id = f.competition_id and s.club_id = f.home_club_id and s.group_id is null;
      update public.standings s set
        played = played + 1, won = won + v_hl, drawn = drawn + v_hd, lost = lost + v_hw,
        goals_for = goals_for + v_res.away_goals, goals_against = goals_against + v_res.home_goals, points = points + 3 * v_hl + v_hd,
        away = jsonb_build_object('p', (away ->> 'p')::int + 1, 'w', (away ->> 'w')::int + v_hl, 'd', (away ->> 'd')::int + v_hd, 'l', (away ->> 'l')::int + v_hw,
                                  'gf', (away ->> 'gf')::int + v_res.away_goals, 'ga', (away ->> 'ga')::int + v_res.home_goals)
      where s.competition_id = f.competition_id and s.club_id = f.away_club_id and s.group_id is null;
      -- I6: Spielprämien
      for r in select * from (values (f.home_club_id, v_hw, v_hd, v_res.home_goals, v_res.away_goals), (f.away_club_id, v_hl, v_hd, v_res.away_goals, v_res.home_goals)) x(club, w, d, gf, ga) loop
        perform public.fd_pay(r.club, 'match_bonus',
          (select amount from public.prize_templates where competition_kind = 'league' and tier = f.comp_tier
             and prize_key = case when r.w = 1 then 'match_win' when r.d = 1 then 'match_draw' else 'match_loss' end),
          'fx:' || f.id || ':bonus:' || r.club, 'Spielprämie ' || v_slot.label, f.season_id);
        -- I7: laufende Sponsorzahlungen
        for v_sp in select so.* from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
                    where sc.club_id = r.club and sc.season_id = f.season_id loop
          perform public.fd_pay(r.club, 'sponsor', case v_sp.kind
              when 'per_league_match' then v_sp.amount when 'per_league_win' then v_sp.amount * r.w
              when 'per_league_point' then v_sp.amount * (3 * r.w + r.d) when 'per_league_goal' then v_sp.amount * r.gf else 0 end,
            'fx:' || f.id || ':sponsor:' || r.club, 'Sponsor ' || v_sp.name || ' · ' || v_slot.label, f.season_id);
        end loop;
      end loop;
    elsif f.comp_kind in ('champions_league', 'europa_league') and f.group_id is not null then
      -- Europapokal-Gruppen
      update public.standings s set played = played + 1, won = won + v_hw, drawn = drawn + v_hd, lost = lost + v_hl,
        goals_for = goals_for + v_res.home_goals, goals_against = goals_against + v_res.away_goals, points = points + 3 * v_hw + v_hd
      where s.group_id = f.group_id and s.club_id = f.home_club_id;
      update public.standings s set played = played + 1, won = won + v_hl, drawn = drawn + v_hd, lost = lost + v_hw,
        goals_for = goals_for + v_res.away_goals, goals_against = goals_against + v_res.home_goals, points = points + 3 * v_hl + v_hd
      where s.group_id = f.group_id and s.club_id = f.away_club_id;
      for r in select * from (values (f.home_club_id, v_hw, v_hd), (f.away_club_id, v_hl, v_hd)) x(club, w, d) loop
        if r.w = 1 then perform public.fd_ec_prize(f.competition_id, r.club, 'group_win', 'gwin:' || f.id, 'Sieg ' || v_slot.label);
        elsif r.d = 1 then perform public.fd_ec_prize(f.competition_id, r.club, 'group_draw', 'gdraw:' || f.id, 'Remis ' || v_slot.label); end if;
      end loop;
    elsif f.tie_id is not null then
      select * into v_tie from public.ties where id = f.tie_id;
      if f.leg is null then
        v_win := case when v_res.home_goals > v_res.away_goals then f.home_club_id when v_res.home_goals < v_res.away_goals then f.away_club_id
                      when coalesce(v_res.home_penalties, 0) > coalesce(v_res.away_penalties, 0) then f.home_club_id else f.away_club_id end;
        update public.ties set winner_club_id = v_win,
          decided_by = case when v_res.home_penalties is not null then 'penalties' else 'aggregate' end where id = f.tie_id;
      elsif f.leg = 2 then
        select r1.* into v_first from public.fixture_results r1 join public.fixtures f1 on f1.id = r1.fixture_id where f1.tie_id = f.tie_id and f1.leg = 1;
        v_win := case when v_res.home_goals + v_first.away_goals > v_res.away_goals + v_first.home_goals then f.home_club_id
                      when v_res.home_goals + v_first.away_goals < v_res.away_goals + v_first.home_goals then f.away_club_id
                      when coalesce(v_res.home_penalties, 0) > coalesce(v_res.away_penalties, 0) then f.home_club_id else f.away_club_id end;
        update public.ties set winner_club_id = v_win,
          decided_by = case when v_res.home_penalties is not null then 'penalties' else 'aggregate' end where id = f.tie_id;
      end if;
      -- Pokalprämien je Runde (Gewinner der Runde, in Mio. €: 0,5 · 1 · 2 · 4 · 8 · 15)
      if f.comp_kind = 'domestic_cup' and v_win is not null then
        v_cup_prize := case f.stage_kind when 'round_of_64' then 500000 when 'round_of_32' then 1000000 when 'round_of_16' then 2000000
                         when 'quarter_final' then 4000000 when 'semi_final' then 8000000 else 15000000 end;
        perform public.fd_pay(v_win, 'competition_prize', v_cup_prize, 'fx:' || f.id || ':cupprize', 'Pokalprämie ' || v_slot.label, f.season_id);
      end if;
    end if;
    -- I4: Zuschauereinnahmen und Stadionkosten (Heimverein)
    if not f.neutral_venue and v_res.attendance is not null then
      select case when f.comp_kind = 'domestic_cup' then ticket_price_cup when f.comp_kind in ('champions_league', 'europa_league') then ticket_price_international else ticket_price_league end, capacity
      into v_price, v_cap from public.stadiums where club_id = f.home_club_id;
      if v_price is not null then
        perform public.fd_pay(f.home_club_id, 'ticket_income', v_res.attendance::bigint * v_price, 'fx:' || f.id || ':tickets',
          'Ticketverkauf – ' || replace(to_char(v_res.attendance, 'FM999,999'), ',', '.') || ' Zuschauer · ' || v_slot.label, f.season_id);
        perform public.fd_pay(f.home_club_id, 'stadium_running_cost', -(v_cap::bigint * 2), 'fx:' || f.id || ':stadiumcost',
          'Stadionbetrieb · ' || v_slot.label, f.season_id);
      end if;
    end if;
    -- Sperren abbüßen (nur Sperren aus früheren Spielen)
    update public.disciplinary_records d set served_matches = served_matches + 1
    from public.players p
    where p.id = d.player_id and p.club_id in (f.home_club_id, f.away_club_id)
      and d.scope = public.fd_fixture_scope(f.id) and d.season_id = f.season_id
      and d.suspension_matches > d.served_matches
      and (d.fixture_id is null or d.fixture_id not in (select public.fd_slot_fixture_ids(p_world)));
    update public.fixtures set status = 'released', released_at = now() where id = f.id;
  end loop;

  -- Gehälter je Ligaspieltag (Jahresgehalt / 34)
  if v_slot.kind = 'league' then
    select count(*) into v_nleague from public.season_slots where season_id = v_slot.season_id and kind = 'league';
    select count(*) into v_kleague from public.season_slots where season_id = v_slot.season_id and kind = 'league' and ordinal <= v_slot.ordinal;
    for r in select pc.club_id, sum(pc.annual_salary) as total from public.player_contracts pc
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and c.association_code = 'GER' and pc.active group by pc.club_id loop
      -- Jahresgehalt exakt auf alle Ligatermine der Saison verteilt (Summe = Jahresgehalt, Rundungsrest im letzten Termin)
      perform public.fd_pay(r.club_id, 'salary', -(floor(r.total * v_kleague / v_nleague) - floor(r.total * (v_kleague - 1) / v_nleague))::bigint, 'slot:' || v_slot.id || ':salary:' || r.club_id, 'Gehälter · ' || v_slot.label, v_slot.season_id);
    end loop;
  end if;

  -- Pokal: nächste Runde auslosen
  if v_slot.kind = 'cup' and v_slot.cup_stage <> 'final' then
    select id into v_cup from public.competitions where season_id = v_slot.season_id and kind = 'domestic_cup';
    select array_agg(t.winner_club_id) into v_winners from public.ties t join public.competition_stages st on st.id = t.stage_id
    where st.competition_id = v_cup and st.kind = v_slot.cup_stage;
    v_next_stage := case v_slot.cup_stage when 'round_of_64' then 'round_of_32' when 'round_of_32' then 'round_of_16'
                    when 'round_of_16' then 'quarter_final' when 'quarter_final' then 'semi_final' else 'final' end;
    perform public.fd_draw_cup_round(v_cup, v_next_stage, v_winners);
  end if;

  -- Europapokal: nächste Runde ansetzen bzw. Titel vergeben
  if v_slot.kind = 'europe' then
    perform public.fd_europe_progress(p_world, v_slot);
  end if;
  -- Torjäger-/Vorlagen-/Notenlisten der betroffenen Wettbewerbe (Cache für Dashboard und Tabellen)
  begin perform public.fd_refresh_leaders(p_world, v_slot.season_id, v_slot.slot_key); exception when others then raise warning 'Bestenlisten: %', sqlerrm; end;

  -- Nach dem 34. Spieltag: Platzierungsprämien und Relegation
  if v_slot.kind = 'league' and v_slot.matchday = 34 then
    perform public.fd_after_last_matchday(p_world);
  end if;

  update public.season_slots set state = 'released', released_at = now() where id = v_slot.id;
  select * into v_next from public.season_slots where season_id = v_slot.season_id and ordinal = v_slot.ordinal + 1;
  -- G2: Regeneration +15 je freiem Tag bis zum nächsten Termin
  v_days := greatest(1, coalesce(v_next.slot_date, v_slot.slot_date + 7) - v_slot.slot_date);
  update public.players p set fitness = least(100, p.fitness + 15 * greatest(1, v_days - 1))
  where p.world_id = p_world and p.club_id is not null and p.fitness < 100
    -- nur Vereine mit Spielbetrieb (aktive Länder + Europapokal); alle anderen spielen nicht
    and p.club_id in (select public.fd_active_club_ids(p_world));
  update public.career_worlds set current_slot = current_slot + 1,
    current_week = current_week + (v_slot.kind = 'league')::int,
    current_date_in_world = coalesce(v_next.slot_date, v_slot.slot_date) - 1
  where id = p_world;
  -- Neuer Kalendertag/neue Woche: Trainingspläne, Verhandlungen, Free-Agent-Entscheidungen
  begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung nach Freigabe: %', sqlerrm; end;
end;
$function$;

-- admin_finish_match
CREATE OR REPLACE FUNCTION public.admin_finish_match(p_fixture uuid, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_f public.fixtures;
  v_kind text;
  v_hg int := (p_result -> 'score' ->> 0)::int;
  v_ag int := (p_result -> 'score' ->> 1)::int;
  v_side_club jsonb;
  v_scope public.discipline_scope;
  v_date date;
  v_att integer;
  v_pen int[];
  v_needs_pen boolean := false;
  v_first public.fixture_results;
  r record;
  v_human boolean;
  v_events jsonb;
begin
  select * into v_f from public.fixtures where id = p_fixture for update;
  if not found then raise exception 'Spiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if exists (select 1 from public.fixture_results where fixture_id = p_fixture) then
    return jsonb_build_object('status', 'already_saved');
  end if;
  if v_hg is null or v_ag is null or v_hg < 0 or v_ag < 0 then
    raise exception 'Ungültiges Ergebnis.' using errcode = 'P0001', hint = 'invalid_result';
  end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  v_human := exists (select 1 from public.clubs c where c.id in (v_f.home_club_id, v_f.away_club_id) and c.control = 'human');
  -- Reine KI-Spiele: nur Tore, Karten und Verletzungen speichern (keine Chancen-, Paraden- oder Ablaufereignisse)
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_events from jsonb_array_elements(coalesce(p_result -> 'events', '[]'::jsonb)) e
  where v_human or e ->> 'type' in ('goal', 'yellow', 'second_yellow', 'red', 'injury');
  v_side_club := jsonb_build_object('home', v_f.home_club_id, 'away', v_f.away_club_id);
  v_scope := public.fd_fixture_scope(p_fixture);
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;

  -- K.-o.: Elfmeterschießen bei Gleichstand (Einzelspiel bzw. Gesamtergebnis nach dem Rückspiel)
  if v_f.tie_id is not null then
    if v_f.leg is null then
      v_needs_pen := v_hg = v_ag;
    elsif v_f.leg = 2 then
      select r2.* into v_first from public.fixture_results r2 join public.fixtures f1 on f1.id = r2.fixture_id
      where f1.tie_id = v_f.tie_id and f1.leg = 1;
      -- Hinspiel: Gastgeber des Rückspiels war Gast
      v_needs_pen := v_first.fixture_id is not null and (v_hg + v_first.away_goals) = (v_ag + v_first.home_goals);
    end if;
    if v_needs_pen then v_pen := public.fd_shootout(p_fixture); end if;
  end if;
  v_att := case when v_kind = 'friendly' then null else public.fd_expected_attendance(p_fixture) end;

  insert into public.fixture_results(fixture_id, world_id, home_goals, away_goals, home_xg, away_xg, home_possession, summary,
                                     attendance, home_penalties, away_penalties)
  values (p_fixture, v_f.world_id, v_hg, v_ag,
          (p_result -> 'stats' -> 'home' ->> 'xg')::numeric, (p_result -> 'stats' -> 'away' ->> 'xg')::numeric,
          (p_result ->> 'possessionHome')::numeric,
          jsonb_build_object('stats', p_result -> 'stats', 'playerOfTheMatch', p_result -> 'playerOfTheMatch', 'lineups', p_result -> 'lineups'),
          v_att, v_pen[1], v_pen[2]);

  insert into public.match_events(fixture_id, world_id, match_second, type, club_id, player_id, secondary_player_id, payload)
  select p_fixture, v_f.world_id, greatest(0, round(coalesce((e ->> 'second')::numeric, (e ->> 'tick')::numeric * 0.75)))::int, e ->> 'type',
         (v_side_club ->> (e ->> 'side'))::uuid,
         (select p.id from public.players p where p.id::text = e ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         (select p.id from public.players p where p.id::text = e ->> 'otherId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         jsonb_build_object('minute', e -> 'minute', 'text', e -> 'text', 'xg', e -> 'xg')
  from jsonb_array_elements(v_events) e
  where e ->> 'type' in ('kickoff','goal','save','chance','woodwork','yellow','second_yellow','red','injury','sub','halftime','fulltime','penalty','tactic','miss');

  insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, goals, assists, shots, shots_on_target, xg,
    passes, passes_completed, tackles_won, interceptions, saves, rating, fitness_start, fitness_end, yellow, red)
  select p_fixture, p.id, p.club_id, v_f.world_id,
         least(120, (s ->> 'minutes')::int), (s ->> 'goals')::int, (s ->> 'assists')::int, (s ->> 'shots')::int, (s ->> 'shotsOnTarget')::int,
         (s ->> 'xg')::numeric, least(32000, (s ->> 'passes')::int), least(32000, (s ->> 'passesCompleted')::int), (s ->> 'tacklesWon')::int,
         (s ->> 'interceptions')::int, (s ->> 'saves')::int, (s ->> 'rating')::numeric,
         greatest(0, least(100, (s ->> 'fitnessStart')::numeric)), greatest(0, least(100, (s ->> 'fitnessEnd')::numeric)),
         coalesce((s ->> 'yellow')::int, 0), coalesce((s ->> 'red')::boolean, false)
  from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
  join public.players p on p.id::text = s ->> 'playerId'
  where p.club_id = (v_side_club ->> (s ->> 'side'))::uuid
  on conflict do nothing;

  if v_kind <> 'friendly' then
    -- Spielerentwicklung: XP aus der Leistung (einmalig je Spieler und Partie)
    perform public.fd_dev_after_match(p_fixture);
    -- Fitness übernehmen
    update public.players p set fitness = greatest(0, least(100, (s ->> 'fitnessEnd')::numeric))
    from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
    where p.id::text = s ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id);
    -- F10: Verletzungen (1–5 Wochen), wirken wettbewerbsübergreifend
    insert into public.injuries(world_id, player_id, fixture_id, kind, starts_on, ends_on)
    select v_f.world_id, ms.player_id, p_fixture, 'Spielverletzung', v_date,
           v_date + (7 + floor(public.fd_hash01(v_f.rng_seed || ms.player_id::text) * 28))::int
    from public.match_player_stats ms
    join jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s on s ->> 'playerId' = ms.player_id::text
    where ms.fixture_id = p_fixture and coalesce((s ->> 'injured')::boolean, false);
    -- F10: Karten und Sperren (Rot: 2 Spiele, Gelb-Rot: 1 Spiel, jede 5. Gelbe: 1 Spiel) – je Wettbewerb getrennt
    for r in select ms.player_id, ms.yellow, ms.red from public.match_player_stats ms where ms.fixture_id = p_fixture and (ms.yellow > 0 or ms.red) loop
      if r.red then
        insert into public.disciplinary_records(world_id, player_id, season_id, scope, fixture_id, card, suspension_matches)
        values (v_f.world_id, r.player_id, v_f.season_id, v_scope, p_fixture, case when r.yellow >= 2 then 'second_yellow'::public.card_kind else 'red'::public.card_kind end,
                case when r.yellow >= 2 then 1 else 2 end);
      elsif r.yellow = 1 then
        insert into public.disciplinary_records(world_id, player_id, season_id, scope, fixture_id, card, suspension_matches)
        values (v_f.world_id, r.player_id, v_f.season_id, v_scope, p_fixture, 'yellow',
                case when (select count(*) from public.disciplinary_records d where d.player_id = r.player_id and d.season_id = v_f.season_id
                           and d.scope = v_scope and d.card = 'yellow') % 5 = 4 then 1 else 0 end);
      end if;
    end loop;
  end if;

  update public.fixtures set status = (case when v_kind = 'friendly' then 'released' else 'finished' end)::public.fixture_status,
                             released_at = case when v_kind = 'friendly' then now() else released_at end
  where id = p_fixture;
  update public.match_sessions set status = 'finished', finished_at = now(), updated_at = now() where fixture_id = p_fixture;
  insert into public.fixture_jobs(fixture_id, world_id, state) values (p_fixture, v_f.world_id, 'done')
  on conflict (fixture_id) do update set state = case when public.fixture_jobs.state = 'fallback' then 'fallback' else 'done' end,
    claimed_at = null, updated_at = now();
  if v_kind <> 'friendly' and not coalesce((p_result ->> 'compact')::boolean, false) then
    insert into public.fd_sim_log(world_id, season_id, slot_key, fixture_id, competition_kind, association, mode, events, player_rows)
    values (v_f.world_id, v_f.season_id, v_f.slot_key, p_fixture, v_kind, (select association_code from public.competitions where id = v_f.competition_id),
            case when jsonb_array_length(coalesce(p_result -> 'players', '[]'::jsonb)) = 0 then 'fallback' else 'engine' end,
            jsonb_array_length(v_events), jsonb_array_length(coalesce(p_result -> 'players', '[]'::jsonb)));
  end if;
  if v_kind <> 'friendly' then perform public.fd_try_release(v_f.world_id); end if;
  return jsonb_build_object('status', 'saved');
end;
$function$;

-- admin_pending_fixtures
CREATE OR REPLACE FUNCTION public.admin_pending_fixtures(p_world uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select f.id from public.fixtures f
  join public.season_slots s on s.world_id = f.world_id and s.season_id = f.season_id and s.slot_key = f.slot_key
  left join public.match_sessions ms on ms.fixture_id = f.id
  left join public.fixture_jobs j on j.fixture_id = f.id
  where f.id in (select public.fd_slot_fixture_ids(p_world))
    and s.state = 'live'
    and f.status in ('scheduled', 'live')
    and not public.fd_fixture_compact(f.id)
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
$function$;

-- admin_sweep_world
CREATE OR REPLACE FUNCTION public.admin_sweep_world(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '20s'
AS $function$
declare
  v_pending uuid[];
  v_live boolean := (public.fd_current_slot(p_world)).state = 'live';
begin
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
$function$;

-- fd_ai_training_batch
CREATE OR REPLACE FUNCTION public.fd_ai_training_batch(p_world uuid, p_limit integer DEFAULT 40)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_w public.career_worlds;
  c record;
  pl record;
  v_n integer;
  v_sid bigint;
  v_date date;
begin
  select * into v_w from public.career_worlds where id = p_world;
  if v_w.status::text not in ('preseason', 'season') or v_w.current_season_id is null then return 0; end if;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  for c in
    select cl.id from public.clubs cl
    where cl.world_id = p_world and cl.control = 'ai'
      and cl.id in (select public.fd_active_club_ids(p_world))
      and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week)
    -- Vereine im laufenden Spielbetrieb zuerst
    order by exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                     where e.club_id = cl.id and co.season_id = v_w.current_season_id) desc, cl.id
    limit p_limit
  loop
    v_n := 0;
    for pl in
      select p.id, p.main_position from public.players p
      join public.player_attributes pa on pa.player_id = p.id
      left join public.player_hidden h on h.player_id = p.id
      where p.club_id = c.id and not p.retired and p.fitness >= 80
        and not exists (select 1 from public.injuries i where i.player_id = p.id and v_date between i.starts_on and i.ends_on)
        and not exists (select 1 from public.training_sessions t where t.player_id = p.id and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week)
      -- Wer am meisten profitiert (jung, Luft zum Potenzial, lernfähig), trainiert zuerst
      order by public.fd_dev_multiplier(p.age, p.overall, coalesce(h.potential, p.overall), (pa.attributes ->> 'gameIntelligence')::numeric) desc, p.id
      limit greatest(0, 5 - (select count(*) from public.training_sessions t where t.club_id = c.id and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week))
    loop
      insert into public.training_sessions(world_id, club_id, season_id, week_no, player_id, focus, training_date)
      values (p_world, c.id, v_w.current_season_id, v_w.current_week, pl.id, public.fd_ai_focus(pl.main_position::text), v_date)
      on conflict do nothing
      returning id into v_sid;
      if v_sid is null then continue; end if;
      perform public.fd_dev_train(v_sid);
      update public.players set fitness = greatest(0, fitness - 20) where id = pl.id;
      update public.player_hidden set development_points = development_points + coalesce((select dev_xp from public.training_sessions where id = v_sid), 0) where player_id = pl.id;
      v_n := v_n + 1;
      v_sid := null;
    end loop;
    insert into public.ai_training_log(club_id, season_id, week_no, world_id, trainees) values (c.id, v_w.current_season_id, v_w.current_week, p_world, v_n)
    on conflict do nothing;
  end loop;
  return (select count(*) from public.clubs cl where cl.world_id = p_world and cl.control = 'ai' and cl.id in (select public.fd_active_club_ids(p_world))
          and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week));
end;
$function$;

-- fd_ai_transfer_batch
CREATE OR REPLACE FUNCTION public.fd_ai_transfer_batch(p_world uuid, p_limit integer DEFAULT 40)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_w public.career_worlds;
  v_win public.transfer_windows;
  c record;
  g record;
  v_need text;
  v_need_avg numeric;
  v_top numeric;
  v_target record;
  v_strat text;
  v_bal bigint;
  v_fee bigint;
  v_max bigint;
  v_left integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_win := public.fd_open_window(p_world);
  if v_win.id is null then return 0; end if;
  for c in
    select cl.id from public.clubs cl
    where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
      -- Vereine mit Spielbetrieb jede Woche; aus den übrigen Ländern nur gelegentliche Käufer (~3 % je Woche),
      -- damit der Markt für Vereine aktiver Länder weiter Nachfrage aus Europa hat
      and (cl.id in (select public.fd_active_club_ids(p_world)) or public.fd_hash01(cl.id::text || ':fx:' || v_w.current_season_id || ':' || v_w.current_week) < 0.03)
      and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week)
    order by exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                     where e.club_id = cl.id and co.season_id = v_w.current_season_id) desc, cl.id
    limit p_limit
  loop
    insert into public.ai_transfer_log(club_id, season_id, week_no, world_id) values (c.id, v_w.current_season_id, v_w.current_week, p_world) on conflict do nothing;
    -- nicht jeder Verein ist jede Woche aktiv; volle Kader, ausgeschöpfte Limits und laufende Verhandlungen bremsen
    continue when public.fd_hash01(c.id::text || ':' || v_w.current_week || ':' || v_w.current_season_id) > 0.2;
    continue when (select count(*) from public.players where club_id = c.id) >= 27;
    continue when (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = c.id and t.kind in ('transfer', 'free_agent')) >= 2;
    continue when (select count(*) from public.transfer_offers o where o.to_club_id = c.id and o.status in ('pending', 'countered')) >= 2;
    select balance into v_bal from public.finances where club_id = c.id;
    continue when coalesce(v_bal, 0) < 500000;
    v_strat := public.fd_ai_strategy(c.id);
    -- Bedarf: schwächste Positionsgruppe relativ zur eigenen Stammelf
    select avg(o) into v_top from (select overall o from public.players where club_id = c.id order by overall desc limit 11) x;
    v_need := null; v_need_avg := null;
    for g in
      select grp, avg(overall) av from (
        select public.fd_pos_group(main_position::text) grp, overall, row_number() over (partition by public.fd_pos_group(main_position::text) order by overall desc) rn
        from public.players where club_id = c.id) x
      where rn <= case grp when 'GK' then 1 when 'ATT' then 2 else 4 end group by grp
    loop
      if v_need_avg is null or g.av - v_top < v_need_avg - v_top then v_need := g.grp; v_need_avg := g.av; end if;
    end loop;
    continue when v_need is null;
    select p.id, p.market_value, p.age, p.overall into v_target
    from public.players p join public.clubs s on s.id = p.club_id
    where p.world_id = p_world and s.control = 'ai' and s.id <> c.id and not p.retired
      and public.fd_pos_group(p.main_position::text) = v_need
      and p.overall between v_need_avg + 2 and least(v_need_avg + 7, v_top + 6)
      and p.market_value <= v_bal * 0.5
      and case v_strat when 'talents' then p.age <= 22 when 'established' then p.age between 24 and 30
                       when 'bargain' then p.age >= 28 or p.market_value < 2000000 else true end
      and not exists (select 1 from public.transfer_offers o where o.player_id = p.id and o.to_club_id = c.id)
    order by p.overall - p.market_value / 1e6 * 0.3 desc, md5(p.id::text || c.id::text) limit 1;
    continue when v_target.id is null;
    v_fee := (round(v_target.market_value * case v_strat when 'bargain' then 0.75 when 'profit' then 0.8 when 'talents' then 0.95 else 1.0 end / 50000) * 50000)::bigint;
    v_max := least((v_bal * 0.6)::bigint, (v_target.market_value * case v_strat when 'established' then 1.25 when 'talents' then 1.3 when 'bargain' then 1.0 else 0.95 end * 1.1)::bigint);
    begin
      perform public.fd_offer_open(v_target.id, c.id, greatest(v_fee, 50000), public.fd_player_demand(v_target.id, c.id),
        case when v_target.age < 25 then 4 when v_target.age < 29 then 3 else 2 end, greatest(v_max, v_fee));
    exception when others then null;
    end;
  end loop;
  select count(*) into v_left from public.clubs cl where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
    and (cl.id in (select public.fd_active_club_ids(p_world)) or public.fd_hash01(cl.id::text || ':fx:' || v_w.current_season_id || ':' || v_w.current_week) < 0.03)
    and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week);
  return v_left;
end;
$function$;

-- fd_ai_fa_interest
CREATE OR REPLACE FUNCTION public.fd_ai_fa_interest(p_world uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_w public.career_worlds;
  v_win public.transfer_windows;
  fa record;
  c record;
  v_n integer := 0;
  v_k integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_win := public.fd_open_window(p_world);
  if v_win.id is null then return 0; end if;
  insert into public.world_week_log(world_id, season_id, week_no, job) values (p_world, v_w.current_season_id, v_w.current_week, 'ai_fa')
  on conflict do nothing;
  if not found then return 0; end if;
  -- Kandidaten einmal je Lauf bestimmen (große Welten: hunderte Vereine)
  create temporary table if not exists fd_tmp_fa_clubs (club_id uuid primary key, tier integer, rep numeric) on commit drop;
  create temporary table if not exists fd_tmp_fa_second (club_id uuid, grp text, second integer, primary key (club_id, grp)) on commit drop;
  truncate fd_tmp_fa_clubs; truncate fd_tmp_fa_second;
  insert into fd_tmp_fa_clubs
  select cl.id, coalesce(public.fd_tier_of(cl.id, v_w.current_season_id), 4), cl.reputation
  from public.clubs cl
  where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
    and cl.id in (select public.fd_active_club_ids(p_world))
    and public.fd_fa_signings(cl.id, v_w.current_season_id) < 2
    and (select count(*) from public.players where club_id = cl.id) < 27
    and not exists (select 1 from public.fa_applications a where a.club_id = cl.id and a.status = 'pending');
  insert into fd_tmp_fa_second
  select club_id, grp, overall from (
    select p.club_id, public.fd_pos_group(p.main_position::text) grp, p.overall,
           row_number() over (partition by p.club_id, public.fd_pos_group(p.main_position::text) order by p.overall desc) rn
    from public.players p join fd_tmp_fa_clubs fc on fc.club_id = p.club_id) x where rn = 2;
  for fa in select f.player_id, p.overall, p.age, p.main_position::text pos, f.min_club_reputation
            from public.free_agents f join public.players p on p.id = f.player_id
            where f.world_id = p_world and p.club_id is null order by p.overall desc limit 40 loop
    v_k := 0;
    for c in
      select k.club_id as id from fd_tmp_fa_clubs k
      left join fd_tmp_fa_second sc on sc.club_id = k.club_id and sc.grp = public.fd_pos_group(fa.pos)
      where k.rep >= fa.min_club_reputation and k.tier <= public.fd_fa_min_tier(fa.overall, fa.age)
        -- echte Verstärkung: besser als der zweitbeste Spieler dieser Positionsgruppe
        and fa.overall >= coalesce(sc.second, 0)
        and not exists (select 1 from public.fa_applications a where a.club_id = k.club_id and a.status = 'pending')
      order by md5(k.club_id::text || fa.player_id::text || v_w.current_week::text) limit 2
    loop
      begin
        perform public.fd_fa_apply(fa.player_id, c.id, case when fa.age < 26 then 3 when fa.age < 30 then 2 else 1 end);
        v_n := v_n + 1; v_k := v_k + 1;
      exception when others then null;
      end;
    end loop;
  end loop;
  return v_n;
end;
$function$;

-- admin_due_worlds
CREATE OR REPLACE FUNCTION public.admin_due_worlds()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- laufender Spieltag: sofort (Spielberechnung, Freigabe)
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  -- sonst Hintergrundarbeit höchstens einmal pro Minute je Welt
  select w.id from public.career_worlds w
  left join public.fd_world_bg b on b.world_id = w.id
  where w.status::text in ('preseason', 'season', 'season_end') and (b.last_run is null or b.last_run < now() - interval '60 seconds')
    and exists (select 1 from public.world_members m where m.world_id = w.id and m.last_seen_at > now() - interval '2 days');
$function$;

-- admin_match_setup
CREATE OR REPLACE FUNCTION public.admin_match_setup(p_fixture uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_f public.fixtures;
  v_kind text;
  v_date date;
  v_session public.match_sessions;
  v_scope public.discipline_scope;
begin
  select * into v_f from public.fixtures where id = p_fixture for update;
  if not found then raise exception 'Spiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_f.status not in ('scheduled', 'live') then
    raise exception 'Das Spiel ist bereits beendet.' using errcode = 'P0001', hint = 'already_finished';
  end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  if v_kind <> 'friendly' and p_fixture not in (select public.fd_slot_fixture_ids(v_f.world_id)) then
    raise exception 'Dieses Spiel steht noch nicht an.' using errcode = 'P0001', hint = 'not_current';
  end if;
  if v_kind <> 'friendly' and (public.fd_current_slot(v_f.world_id)).state <> 'live' then
    raise exception 'Der Spieltag wurde noch nicht gestartet – alle Manager müssen bereit sein.' using errcode = 'P0001', hint = 'slot_not_live';
  end if;
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;
  v_scope := public.fd_fixture_scope(p_fixture);
  if v_f.status = 'scheduled' then
    update public.fixtures set status = 'live' where id = p_fixture;
  end if;
  insert into public.match_sessions(fixture_id, world_id, mode, engine_version)
  values (p_fixture, v_f.world_id, 'live', '2')
  on conflict (fixture_id) do update set status = 'running', updated_at = now()
  returning * into v_session;
  return jsonb_build_object(
    'fixtureId', v_f.id, 'worldId', v_f.world_id, 'seed', v_f.rng_seed, 'kind', v_kind, 'neutral', v_f.neutral_venue,
    'homeAdvantage', case when v_kind = 'friendly' then null else public.fd_home_advantage(p_fixture) end,
    'home', public.fd_match_team(v_f.home_club_id, v_date, v_scope, v_f.season_id),
    'away', public.fd_match_team(v_f.away_club_id, v_date, v_scope, v_f.season_id),
    'checkpoint', v_session.checkpoint,
    -- Stadion für die Darstellung: Design des Heimvereins und dieselbe Zuschauerzahl wie Ticketverkauf/Ergebnis
    'stadium', (select jsonb_build_object('name', st.name, 'capacity', st.capacity, 'design', st.design,
                  'weather', public.fd_weather(v_f.id), 'atmosphere', public.fd_atmosphere(v_f.id),
                  'competition', (select jsonb_build_object('kind', c.kind, 'tier', c.tier, 'association', c.association_code, 'name', c.name)
                                  from public.competitions c where c.id = v_f.competition_id),
                  'attendance', case when v_f.neutral_venue then round(st.capacity * 0.8)
                                     when v_kind = 'friendly' then round(st.capacity * 0.18)
                                     else coalesce((select r.attendance from public.fixture_results r where r.fixture_id = v_f.id), public.fd_expected_attendance(p_fixture)) end,
                  'fans', public.fd_fan_view(v_f.id))
                from public.stadiums st where st.club_id = v_f.home_club_id)
  );
end;
$function$;

-- fd_fa_score
CREATE OR REPLACE FUNCTION public.fd_fa_score(p_player uuid, p_club uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_p public.players;
  v_c public.clubs;
  v_w public.career_worlds;
  v_fa public.free_agents;
  v_tier integer;
  v_better integer;
  v_rank integer;
  v_prev numeric := 0;
  v_euro boolean;
  v_score numeric;
  v_play numeric;
  v_success numeric;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_c from public.clubs where id = p_club;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  select * into v_fa from public.free_agents where player_id = p_player;
  if v_c.reputation < coalesce(v_fa.min_club_reputation, 0) then return null; end if;
  v_tier := coalesce(public.fd_tier_of(p_club, v_w.current_season_id), 4);
  if v_tier > public.fd_fa_min_tier(v_p.overall, v_p.age) then return null; end if;
  -- Erwartete Einsatzzeit: Konkurrenz auf der Position
  select count(*) filter (where p.overall >= v_p.overall + 4), count(*) filter (where p.overall > v_p.overall)
  into v_better, v_rank
  from public.players p where p.club_id = p_club and not p.retired and public.fd_pos_group(p.main_position::text) = public.fd_pos_group(v_p.main_position::text);
  if v_better >= 3 and v_p.age < 33 then return null; end if;
  v_play := case when v_rank = 0 then 25 when v_rank = 1 then 15 when v_rank = 2 then 6 else -8 end;
  -- Sportlicher Erfolg der Vorsaison (Tabellenplatz der letzten abgeschlossenen Liga)
  select coalesce(max(1 - (t.pos - 1)::numeric / greatest(1, n.cnt - 1)), 0.4) * 20 into v_prev
  from public.seasons s
  join public.competitions co on co.season_id = s.id and co.kind = 'league'
    and exists (select 1 from public.competition_entries ce where ce.competition_id = co.id and ce.club_id = p_club)
  join lateral public.fd_table(co.id) t on t.club_id = p_club
  cross join lateral (select count(*) cnt from public.competition_entries e where e.competition_id = co.id) n
  where s.world_id = v_p.world_id and s.status::text = 'closed' and s.id = (select id from public.seasons where world_id = v_p.world_id and status::text = 'closed' order by year desc limit 1);
  v_euro := exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                    where e.club_id = p_club and co.season_id = v_w.current_season_id and co.kind::text in ('champions_league', 'europa_league', 'continental'));
  v_success := (5 - v_tier) * 12 + coalesce(v_prev, 8) + case when v_euro then 15 else 0 end + v_c.reputation * 0.3;
  -- Karriereziele: Junge wollen spielen, Ältere Erfolg
  v_score := v_success * case when v_p.age >= 30 then 1.3 else 1 end + v_play * case when v_p.age <= 23 then 1.5 else 1 end
           + public.fd_hash01(p_player::text || p_club::text || ':fa') * 6;
  return round(v_score, 2);
end;
$function$;
-- ---------------------------------------------------------------------
-- 8. Abschluss: Listen aktiver Vereine aufbauen, Statistiken aktualisieren
-- ---------------------------------------------------------------------
do $$
declare w record;
begin
  for w in select id from public.career_worlds where current_season_id is not null loop
    perform public.fd_refresh_active_clubs(w.id);
  end loop;
end $$;

-- Bestenlisten einmal für alle laufenden Wettbewerbe füllen
insert into public.fd_leaders_cache(competition_id, data)
select c.id, public.fd_leaders_compute(c.id) from public.competitions c join public.career_worlds w on w.current_season_id = c.season_id
where c.kind::text in ('league', 'domestic_cup', 'champions_league', 'europa_league')
on conflict (competition_id) do update set data = excluded.data, updated_at = now();

insert into public.fd_data_migrations(key) values ('0030_active_countries') on conflict do nothing;

analyze public.players;
analyze public.player_contracts;
analyze public.transfer_offers;
analyze public.fixtures;
analyze public.match_events;
analyze public.world_members;
