-- =====================================================================
-- Migration 0014: Phase 7 + 8 – Saison, Kalender, Spieltage, Tabellen, Pokal,
-- Relegation, Saisonwechsel, Finanzen, Stadion, Transfers und Free Agents.
--
-- Ablauf eines Termins (B4):
--   1. Vorbereitung: Manager stellen auf, trainieren, verhandeln; dann „Bereit“.
--   2. Alle bereit (oder Host startet) ⇒ Termin läuft. Jeder Manager sieht sein Spiel live
--      oder überspringt es; Spiele ohne Menschen rechnet der Match-Server headless.
--   3. Sind alle Spiele des Termins berechnet ⇒ gemeinsame Freigabe: Ergebnisse, Tabellen,
--      Einnahmen, Gehälter, Regeneration; danach beginnt die Vorbereitung des nächsten Termins.
-- Europäische Wettbewerbe folgen in einer späteren Phase (erste Teilnahme frühestens nach Saison 2).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------
create table if not exists public.season_slots (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  ordinal smallint not null,
  slot_key text not null,
  kind text not null check (kind in ('league', 'cup', 'relegation', 'season_end')),
  label text not null,
  slot_date date not null,
  matchday smallint,
  cup_stage public.stage_kind,
  state text not null default 'pending' check (state in ('pending', 'live', 'released')),
  started_at timestamptz,
  released_at timestamptz,
  unique (season_id, ordinal),
  unique (season_id, slot_key)
);
create index if not exists season_slots_world on public.season_slots(world_id, season_id, ordinal);

alter table public.career_worlds add column if not exists current_slot smallint not null default 0;

-- B4: Entscheidung je menschlichem Verein und Spiel (live ansehen / überspringen)
create table if not exists public.fixture_decisions (
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  decision text not null check (decision in ('live', 'skip')),
  updated_at timestamptz not null default now(),
  primary key (fixture_id, club_id)
);

alter table public.match_player_stats add column if not exists yellow smallint not null default 0;
alter table public.match_player_stats add column if not exists red boolean not null default false;
alter table public.clubs add column if not exists amateur boolean not null default false;

alter table public.season_slots enable row level security;
alter table public.fixture_decisions enable row level security;
drop policy if exists read_world_members on public.season_slots;
create policy read_world_members on public.season_slots for select to authenticated using (public.is_world_member(world_id));
drop policy if exists read_world_members on public.fixture_decisions;
create policy read_world_members on public.fixture_decisions for select to authenticated using (public.is_world_member(world_id));

-- ---------------------------------------------------------------------
-- Hilfen
-- ---------------------------------------------------------------------
-- Deterministische Zufallszahl 0…1 aus Text (für Auslosungen, Elfmeterschießen, Nachfrage)
create or replace function public.fd_hash01(p_text text)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select (('x' || substr(md5(p_text), 1, 8))::bit(32)::bigint & 2147483647)::double precision / 2147483647;
$$;

-- Spielklasse eines Vereins in der Saison (1–3; Amateure = 4)
create or replace function public.fd_tier_of(p_club uuid, p_season uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  select coalesce(public.fd_club_tier(p_club, p_season), 4::smallint);
$$;

create or replace function public.fd_season_year(p_season uuid)
returns integer language sql stable set search_path = '' as $$ select year from public.seasons where id = p_season $$;

create or replace function public.fd_human_clubs(p_world uuid)
returns setof uuid language sql stable set search_path = '' as $$
  select id from public.clubs where world_id = p_world and control = 'human'
$$;

-- H5: Gehaltsforderung aus Marktwert und Alter (12 % × Altersfaktor)
create or replace function public.fd_salary_demand(p_value bigint, p_age integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select greatest(50000, round(p_value * 0.12 * case
    when p_age <= 20 then 0.75 when p_age <= 24 then 0.85 when p_age <= 28 then 1.0
    when p_age <= 32 then 1.10 when p_age <= 35 then 1.20 else 1.25 end / 10000) * 10000)::bigint;
$$;

-- ---------------------------------------------------------------------
-- Amateurvereine = abstrakte vierte Liga (Pokalteilnehmer, Auf- und Absteiger der 3. Liga)
-- ---------------------------------------------------------------------
create or replace function public.fd_ensure_amateurs(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_need integer;
  v_prefix text[] := array['SV', 'TuS', 'FC', 'SpVgg', 'TSV', 'SC', 'VfL', 'SG', 'FV', 'DJK'];
  v_towns text[] := array['Hollerbach', 'Kesselbrunn', 'Lindenau', 'Morsbach', 'Eichenried', 'Weidenthal', 'Steinwalde',
                          'Birkenhain', 'Rosenau', 'Falkenried', 'Grünwiesen', 'Ahornfeld', 'Buchenloh', 'Erlenbrück',
                          'Haselgrund', 'Mühlenau', 'Tannheim', 'Ulmenhof', 'Wiesenbach', 'Zedernfeld'];
  v_i integer;
  v_club uuid;
  v_name text;
  v_short text;
  v_target integer;
  v_n integer := 0;
begin
  select * into v_world from public.career_worlds where id = p_world;
  v_need := 10 - (select count(*) from public.clubs where world_id = p_world and amateur);
  v_i := 0;
  while v_need > 0 and v_i < 200 loop
    v_i := v_i + 1;
    v_name := v_prefix[1 + floor(public.fd_hash01(v_world.seed || ':ap:' || v_i) * 10)::int] || ' '
           || v_towns[1 + floor(public.fd_hash01(v_world.seed || ':at:' || v_i) * 20)::int];
    v_short := 'AM' || lpad(((select count(*) from public.clubs where world_id = p_world and amateur) + 1 + v_n)::text, 2, '0');
    if exists (select 1 from public.clubs where world_id = p_world and (name_normalized = public.normalize_name(v_name) or short_name_normalized = public.normalize_name(v_short)))
       or exists (select 1 from public.club_name_blocklist b where b.name_normalized = public.normalize_name(v_name)) then
      continue;
    end if;
    insert into public.clubs(world_id, association_code, name, short_name, control, reputation, amateur, name_normalized, short_name_normalized)
    values (p_world, 'GER', v_name, v_short, 'ai', 25, true, '', '')
    returning id into v_club;
    insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
    select v_club, p_world, b.primary_color, b.secondary_color, b.accent_color, b.crest, b.kit
    from public.club_branding b join public.clubs c on c.id = b.club_id
    where c.world_id = p_world and c.control = 'ai' and not c.amateur
    order by md5(v_club::text || b.club_id::text) limit 1;
    -- Kader: 16 Feldspieler + 2 Torhüter, schwächer, abgeleitet aus bestehenden Spielern (neue Namenskombination)
    v_target := 58 + floor(public.fd_hash01(v_club::text) * 6)::int;
    insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                               overall, fitness, market_value, shirt_number, club_id)
    select p_world, f.first_name, l.last_name, p.nationality, p.region, p.age, p.main_position, p.secondary_positions,
           greatest(40, least(70, v_target + (p.overall - 70) / 4)), 100, 100000,
           case when p.main_position = 'GK' then (case when p.rn = 1 then 1 else 18 end) else p.rn + 1 end, v_club
    from (
      select pl.*, row_number() over (partition by (pl.main_position = 'GK') order by md5(v_club::text || pl.id::text)) as rn
      from public.players pl where pl.world_id = p_world and not pl.retired and pl.club_id is not null
    ) p
    join lateral (select x.first_name from public.players x where x.world_id = p_world order by md5(v_club::text || x.id::text || 'f') limit 1 offset (p.rn % 40)) f on true
    join lateral (select x.last_name from public.players x where x.world_id = p_world order by md5(v_club::text || x.id::text || 'l') limit 1 offset ((p.rn * 7 + (p.main_position = 'GK')::int * 3) % 40)) l on true
    where (p.main_position = 'GK' and p.rn <= 2) or (p.main_position <> 'GK' and p.rn <= 16);
    -- Attribute: skaliert von einem Spieler gleicher Position
    insert into public.player_attributes(player_id, world_id, kind, attributes)
    select np.id, p_world, src.kind,
           (select jsonb_object_agg(k, greatest(20, least(80, round((v::numeric) * np.overall / greatest(src_overall, 1)))))
            from jsonb_each_text(src.attributes) as a(k, v))
    from public.players np
    join lateral (
      select pa.kind, pa.attributes, op.overall as src_overall from public.player_attributes pa join public.players op on op.id = pa.player_id
      where op.world_id = p_world and op.main_position = np.main_position and op.id <> np.id
      order by md5(np.id::text || op.id::text) limit 1
    ) src on true
    where np.club_id = v_club;
    insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 2000000);
    perform public.fd_init_club_tactics(p_world, v_club, '4-4-2');
    v_need := v_need - 1;
    v_n := v_n + 1;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Spielplan
-- ---------------------------------------------------------------------
-- Doppelrunde nach dem Kreisverfahren (18 Vereine, 34 Spieltage)
create or replace function public.fd_schedule_league(p_comp uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_comp public.competitions;
  v_world public.career_worlds;
  v_ids uuid[];
  v_n integer;
  v_round integer;
  v_i integer;
  v_a uuid;
  v_b uuid;
  v_home uuid;
  v_away uuid;
  v_tmp uuid;
  v_date date;
begin
  select * into v_comp from public.competitions where id = p_comp;
  select * into v_world from public.career_worlds where id = v_comp.world_id;
  select array_agg(e.club_id order by md5(v_world.seed || v_comp.id::text || e.club_id::text))
  into v_ids from public.competition_entries e where e.competition_id = p_comp;
  v_n := array_length(v_ids, 1);
  if v_n is null or v_n % 2 = 1 then raise exception 'Liga braucht eine gerade Anzahl Vereine'; end if;
  for v_round in 1..(v_n - 1) loop
    for v_i in 1..(v_n / 2) loop
      v_a := v_ids[v_i];
      v_b := v_ids[v_n + 1 - v_i];
      if (v_i = 1 and v_round % 2 = 0) or (v_i > 1 and v_i % 2 = 0) then v_home := v_b; v_away := v_a; else v_home := v_a; v_away := v_b; end if;
      select slot_date into v_date from public.season_slots where season_id = v_comp.season_id and slot_key = 'L' || v_round;
      insert into public.fixtures(world_id, season_id, competition_id, matchday, slot_key, scheduled_date, home_club_id, away_club_id)
      values (v_comp.world_id, v_comp.season_id, p_comp, v_round, 'L' || v_round, v_date, v_home, v_away);
      select slot_date into v_date from public.season_slots where season_id = v_comp.season_id and slot_key = 'L' || (v_round + v_n - 1);
      insert into public.fixtures(world_id, season_id, competition_id, matchday, slot_key, scheduled_date, home_club_id, away_club_id)
      values (v_comp.world_id, v_comp.season_id, p_comp, v_round + v_n - 1, 'L' || (v_round + v_n - 1), v_date, v_away, v_home);
    end loop;
    -- Rotation: Position 1 bleibt, alle anderen rücken weiter
    v_ids := array[v_ids[1]] || v_ids[v_n:v_n] || v_ids[2:v_n - 1];
  end loop;
end;
$$;

-- Pokalrunde auslosen: Unterklassige Vereine haben bis zum Viertelfinale Heimrecht (C4)
create or replace function public.fd_draw_cup_round(p_comp uuid, p_stage public.stage_kind, p_clubs uuid[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_comp public.competitions;
  v_world public.career_worlds;
  v_stage uuid;
  v_ord smallint;
  v_slot public.season_slots;
  v_list uuid[];
  v_low uuid[];
  v_high uuid[];
  v_i integer;
  v_a uuid;
  v_b uuid;
  v_ta smallint;
  v_tb smallint;
  v_tie uuid;
  v_final boolean := p_stage = 'final';
begin
  select * into v_comp from public.competitions where id = p_comp;
  select * into v_world from public.career_worlds where id = v_comp.world_id;
  select * into v_slot from public.season_slots where season_id = v_comp.season_id and kind = 'cup' and cup_stage = p_stage;
  v_ord := case p_stage when 'round_of_64' then 1 when 'round_of_32' then 2 when 'round_of_16' then 3 when 'quarter_final' then 4 when 'semi_final' then 5 else 6 end;
  insert into public.competition_stages(competition_id, world_id, kind, ordinal) values (p_comp, v_comp.world_id, p_stage, v_ord)
  on conflict (competition_id, kind) do update set ordinal = excluded.ordinal returning id into v_stage;
  if exists (select 1 from public.ties where stage_id = v_stage) then return; end if;
  if p_stage = 'round_of_64' then
    -- 1. Runde: 32 „kleine“ (Amateure, 3. Liga, schwächste Zweitligisten) gegen 32 „große“
    select array_agg(c order by public.fd_tier_of(c, v_comp.season_id) desc, md5(v_world.seed || c::text)) into v_list from unnest(p_clubs) c;
    v_low := v_list[1:32];
    v_high := v_list[33:64];
    select array_agg(c order by md5(v_world.seed || 'L' || c::text)) into v_low from unnest(v_low) c;
    select array_agg(c order by md5(v_world.seed || 'H' || c::text)) into v_high from unnest(v_high) c;
    for v_i in 1..32 loop
      insert into public.ties(stage_id, world_id, club_a_id, club_b_id) values (v_stage, v_comp.world_id, v_low[v_i], v_high[v_i]) returning id into v_tie;
      insert into public.fixtures(world_id, season_id, competition_id, stage_id, tie_id, slot_key, scheduled_date, home_club_id, away_club_id)
      values (v_comp.world_id, v_comp.season_id, p_comp, v_stage, v_tie, v_slot.slot_key, v_slot.slot_date, v_low[v_i], v_high[v_i]);
    end loop;
  else
    select array_agg(c order by md5(v_world.seed || p_stage::text || c::text)) into v_list from unnest(p_clubs) c;
    for v_i in 1..(array_length(v_list, 1) / 2) loop
      v_a := v_list[2 * v_i - 1]; v_b := v_list[2 * v_i];
      v_ta := public.fd_tier_of(v_a, v_comp.season_id); v_tb := public.fd_tier_of(v_b, v_comp.season_id);
      if p_stage in ('round_of_32', 'round_of_16', 'quarter_final') and v_tb > v_ta then
        v_tie := v_a; v_a := v_b; v_b := v_tie;
      end if;
      insert into public.ties(stage_id, world_id, club_a_id, club_b_id) values (v_stage, v_comp.world_id, v_a, v_b) returning id into v_tie;
      insert into public.fixtures(world_id, season_id, competition_id, stage_id, tie_id, slot_key, scheduled_date, home_club_id, away_club_id, neutral_venue)
      values (v_comp.world_id, v_comp.season_id, p_comp, v_stage, v_tie, v_slot.slot_key, v_slot.slot_date, v_a, v_b, v_final);
    end loop;
  end if;
  insert into public.draws(world_id, stage_id, seed, result)
  values (v_comp.world_id, v_stage, v_world.seed, (select jsonb_agg(jsonb_build_array(club_a_id, club_b_id)) from public.ties where stage_id = v_stage))
  on conflict (stage_id) do nothing;
end;
$$;

-- Kalender, Wettbewerbe, Spielpläne und Tabellen der Saison anlegen und die Saison starten
create or replace function public.fd_start_season(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
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
    if v_md = 7 then insert into fd_tmp_slots values ('C2', 'cup', 'Pokal · 2. Runde', v_date + 4, null, 'round_of_32'); end if;
    if v_md = 13 then insert into fd_tmp_slots values ('C3', 'cup', 'Pokal · Achtelfinale', v_date + 4, null, 'round_of_16'); end if;
    if v_md = 20 then insert into fd_tmp_slots values ('C4', 'cup', 'Pokal · Viertelfinale', v_date + 4, null, 'quarter_final'); end if;
    if v_md = 27 then insert into fd_tmp_slots values ('C5', 'cup', 'Pokal · Halbfinale', v_date + 4, null, 'semi_final'); end if;
    if v_md = 34 then
      insert into fd_tmp_slots values ('R1', 'relegation', 'Relegation · Hinspiel', v_date + 4, null, null);
      insert into fd_tmp_slots values ('R2', 'relegation', 'Relegation · Rückspiel', v_date + 7, null, null);
      insert into fd_tmp_slots values ('C6', 'cup', 'Pokalfinale', v_date + 14, null, 'final');
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
$$;

-- ---------------------------------------------------------------------
-- Tabellen, Zuschauer, Heimvorteil
-- ---------------------------------------------------------------------
create or replace function public.fd_table(p_comp uuid)
returns table (club_id uuid, pos integer, points integer, gd integer, gf integer)
language sql
stable
set search_path = ''
as $$
  select s.club_id,
         (row_number() over (order by s.points desc, s.goals_for - s.goals_against desc, s.goals_for desc, c.name))::int,
         s.points::int, (s.goals_for - s.goals_against)::int, s.goals_for::int
  from public.standings s join public.clubs c on c.id = s.club_id
  where s.competition_id = p_comp and s.group_id is null;
$$;

-- I4: Zuschauernachfrage (Preis, Form, Gegner, Bedeutung, Stadiongröße, Liga, Reputation)
create or replace function public.fd_expected_attendance(p_fixture uuid)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_kind text;
  v_cap integer;
  v_price integer;
  v_tier smallint;
  v_home public.clubs;
  v_away public.clubs;
  v_base numeric;
  v_ref numeric;
  v_form numeric := 1;
  v_imp numeric := 1;
  v_pos integer;
  v_n integer;
  v_demand numeric;
  v_stage public.stage_kind;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if v_f.neutral_venue then return 0; end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  select * into v_home from public.clubs where id = v_f.home_club_id;
  select * into v_away from public.clubs where id = v_f.away_club_id;
  select capacity, case when v_kind = 'domestic_cup' then ticket_price_cup when v_kind in ('champions_league', 'europa_league') then ticket_price_international else ticket_price_league end
  into v_cap, v_price from public.stadiums where club_id = v_home.id;
  v_cap := coalesce(v_cap, 8000);
  v_price := coalesce(v_price, 12);
  v_tier := public.fd_tier_of(v_home.id, v_f.season_id);
  v_base := case v_tier when 1 then 0.95 when 2 then 0.80 when 3 then 0.64 else 0.50 end;
  v_ref := case v_tier when 1 then 45 when 2 then 30 when 3 then 20 else 12 end * case when v_kind = 'domestic_cup' then 0.85 else 1 end;
  select t.pos, count(*) over () into v_pos, v_n from public.fd_table((select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
                                                                where e.club_id = v_home.id and c.season_id = v_f.season_id and c.kind = 'league' limit 1)) t
  where t.club_id = v_home.id;
  if v_pos is not null and v_n > 1 and exists (select 1 from public.standings where club_id = v_home.id and played > 0) then
    v_form := 1 + (0.5 - (v_pos - 1)::numeric / (v_n - 1)) * 0.2;
  end if;
  if v_f.stage_id is not null then
    select kind into v_stage from public.competition_stages where id = v_f.stage_id;
    v_imp := case v_stage when 'round_of_64' then 1.0 when 'round_of_32' then 1.05 when 'round_of_16' then 1.1 when 'quarter_final' then 1.15 when 'semi_final' then 1.25 when 'relegation' then 1.3 else 1.3 end;
  end if;
  v_demand := v_base * least(1.35, power(v_ref / greatest(v_price, 1), 0.7)) * v_form
            * (1 + (v_away.reputation - 50) / 250) * (1 + (v_home.reputation - 50) / 400) * v_imp
            * (1 - (v_cap - 10000)::numeric / 220000)
            * (0.97 + public.fd_hash01(v_f.rng_seed || ':att') * 0.06);
  return (round(v_cap * least(1, greatest(0.12, v_demand)) / 10) * 10)::int;
end;
$$;

-- I5: Heimvorteil aus Auslastung und Stadiongröße (begrenzt); C4: Pokal-Bonus für Unterklassige bis zum Viertelfinale
create or replace function public.fd_home_advantage(p_fixture uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_cap integer;
  v_att integer;
  v_occ numeric;
  v_adv numeric := 0;
  v_stage public.stage_kind;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if v_f.neutral_venue then return null; end if;
  select capacity into v_cap from public.stadiums where club_id = v_f.home_club_id;
  v_cap := coalesce(v_cap, 8000);
  v_att := public.fd_expected_attendance(p_fixture);
  v_occ := v_att::numeric / v_cap;
  if v_occ > 0.5 then v_adv := (v_occ - 0.5) / 0.5 * (0.008 + 0.022 * greatest(0, v_cap - 10000)::numeric / 40000); end if;
  if v_f.stage_id is not null then
    select kind into v_stage from public.competition_stages where id = v_f.stage_id;
    if v_stage in ('round_of_64', 'round_of_32', 'round_of_16', 'quarter_final')
       and public.fd_tier_of(v_f.home_club_id, v_f.season_id) > public.fd_tier_of(v_f.away_club_id, v_f.season_id) then
      v_adv := v_adv + 0.01;
    end if;
  end if;
  return round(least(v_adv, 0.04), 4);
end;
$$;

-- ---------------------------------------------------------------------
-- Spieltagsablauf (B4)
-- ---------------------------------------------------------------------
create or replace function public.fd_current_slot(p_world uuid)
returns public.season_slots
language sql
stable
set search_path = ''
as $$
  select s.* from public.season_slots s join public.career_worlds w on w.id = s.world_id
  where s.world_id = p_world and s.season_id = w.current_season_id and s.ordinal = w.current_slot;
$$;

create or replace function public.fd_slot_fixture_ids(p_world uuid)
returns setof uuid
language sql
stable
set search_path = ''
as $$
  select f.id from public.fixtures f
  join public.competitions c on c.id = f.competition_id
  join public.career_worlds w on w.id = f.world_id
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where f.world_id = p_world and f.season_id = w.current_season_id and f.slot_key = s.slot_key and c.kind::text <> 'friendly' and f.status <> 'cancelled';
$$;

create or replace function public.fd_begin_slot(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state <> 'pending' then return; end if;
  update public.season_slots set state = 'live', started_at = now() where id = v_slot.id;
  update public.career_worlds set current_date_in_world = v_slot.slot_date where id = p_world;
  if v_slot.kind = 'season_end' then
    perform public.fd_end_season(p_world);
    return;
  end if;
  perform public.fd_try_release(p_world);
end;
$$;

create or replace function public.set_matchday_ready(p_world uuid, p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_ctx text;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_world.status <> 'season' or v_slot.id is null or v_slot.state <> 'pending' then
    raise exception 'Gerade ist kein Termin in Vorbereitung.' using errcode = 'P0001', hint = 'not_preparing';
  end if;
  v_ctx := 'slot:' || v_slot.id::text;
  insert into public.multiplayer_readiness(world_id, user_id, context, ready)
  values (p_world, v_member.user_id, v_ctx, coalesce(p_ready, false))
  on conflict (world_id, user_id, context) do update set ready = excluded.ready, updated_at = now();
  if not exists (
    select 1 from public.clubs c where c.world_id = p_world and c.control = 'human'
      and not exists (select 1 from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = c.manager_user_id and r.context = v_ctx and r.ready)
  ) then
    perform public.fd_begin_slot(p_world);
  end if;
  return public.matchday_state(p_world);
end;
$$;

-- Timeout-Regel: der Host darf den Termin starten bzw. die Freigabe erzwingen
create or replace function public.force_start_slot(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world public.career_worlds;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if v_world.host_user_id <> auth.uid() then
    raise exception 'Nur der Host kann den Termin starten.' using errcode = '42501', hint = 'host_only';
  end if;
  if v_world.status <> 'season' then
    raise exception 'Gerade ist kein Termin in Vorbereitung.' using errcode = 'P0001', hint = 'not_preparing';
  end if;
  perform public.fd_begin_slot(p_world);
  return public.matchday_state(p_world);
end;
$$;

create or replace function public.set_fixture_decision(p_fixture uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_club uuid;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if not found then raise exception 'Spiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  select id into v_club from public.clubs where id in (v_f.home_club_id, v_f.away_club_id) and manager_user_id = auth.uid();
  if v_club is null then raise exception 'Nicht dein Spiel.' using errcode = '42501', hint = 'forbidden'; end if;
  if p_decision not in ('live', 'skip') then raise exception 'Ungültige Wahl.' using errcode = '22023', hint = 'invalid'; end if;
  if p_fixture not in (select public.fd_slot_fixture_ids(v_f.world_id)) or (public.fd_current_slot(v_f.world_id)).state <> 'live' then
    raise exception 'Dieses Spiel steht gerade nicht an.' using errcode = 'P0001', hint = 'not_current';
  end if;
  insert into public.fixture_decisions(fixture_id, club_id, world_id, decision) values (p_fixture, v_club, v_f.world_id, p_decision)
  on conflict (fixture_id, club_id) do update set decision = excluded.decision, updated_at = now();
  return public.matchday_state(v_f.world_id);
end;
$$;

-- Zustand für die Spieltagsseite (ohne Ergebnisse vor der Freigabe)
create or replace function public.matchday_state(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_club uuid;
  v_window jsonb;
begin
  select * into v_world from public.career_worlds where id = p_world;
  v_slot := public.fd_current_slot(p_world);
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  v_window := public.fd_window_info(p_world, v_club);
  return jsonb_build_object(
    'status', v_world.status,
    'is_host', v_world.host_user_id = v_member.user_id,
    'my_club', v_club,
    'date', v_world.current_date_in_world,
    'season', (select jsonb_build_object('id', s.id, 'year', s.year) from public.seasons s where s.id = v_world.current_season_id),
    'slot', case when v_slot.id is null then null else jsonb_build_object(
      'id', v_slot.id, 'ordinal', v_slot.ordinal, 'key', v_slot.slot_key, 'kind', v_slot.kind, 'label', v_slot.label,
      'date', v_slot.slot_date, 'state', v_slot.state, 'started_at', v_slot.started_at, 'matchday', v_slot.matchday) end,
    'readiness', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', c.manager_user_id, 'club', c.name, 'username', p.username,
        'ready', coalesce((select r.ready from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = c.manager_user_id and r.context = 'slot:' || v_slot.id::text), false))
        order by c.name)
      from public.clubs c left join public.profiles p on p.id = c.manager_user_id
      where c.world_id = p_world and c.control = 'human'), '[]'::jsonb),
    'fixtures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'competition', c.name, 'kind', c.kind, 'status', f.status, 'neutral', f.neutral_venue, 'leg', f.leg,
        'home', jsonb_build_object('id', h.id, 'name', h.name, 'short_name', h.short_name, 'control', h.control, 'color', hb.primary_color),
        'away', jsonb_build_object('id', a.id, 'name', a.name, 'short_name', a.short_name, 'control', a.control, 'color', ab.primary_color),
        'mine', v_club in (f.home_club_id, f.away_club_id),
        'decisions', coalesce((select jsonb_object_agg(d.club_id, d.decision) from public.fixture_decisions d where d.fixture_id = f.id), '{}'::jsonb),
        'result', case when public.can_see_fixture_result(f.id) then (select jsonb_build_object('home', r.home_goals, 'away', r.away_goals, 'hp', r.home_penalties, 'ap', r.away_penalties) from public.fixture_results r where r.fixture_id = f.id) end
      ) order by (v_club in (f.home_club_id, f.away_club_id)) desc, (h.control = 'human' or a.control = 'human') desc, c.tier nulls last, h.name)
      from public.fixtures f join public.competitions c on c.id = f.competition_id
      join public.clubs h on h.id = f.home_club_id join public.clubs a on a.id = f.away_club_id
      left join public.club_branding hb on hb.club_id = h.id left join public.club_branding ab on ab.club_id = a.id
      where f.id in (select public.fd_slot_fixture_ids(p_world))), '[]'::jsonb),
    'last_slot', (
      select jsonb_build_object('label', s.label, 'key', s.slot_key) from public.season_slots s
      where s.season_id = v_world.current_season_id and s.ordinal = v_world.current_slot - 1),
    'next_slots', coalesce((
      select jsonb_agg(jsonb_build_object('label', s.label, 'date', s.slot_date, 'kind', s.kind) order by s.ordinal)
      from public.season_slots s where s.season_id = v_world.current_season_id and s.ordinal > v_world.current_slot and s.ordinal <= v_world.current_slot + 4), '[]'::jsonb),
    'window', v_window
  );
end;
$$;

-- Für den Match-Server: welche Spiele des laufenden Termins headless berechnet werden
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
  where f.id in (select public.fd_slot_fixture_ids(p_world))
    and s.state = 'live'
    and (
      (f.status = 'scheduled' and (
        not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human')
        or not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human'
                       and not exists (select 1 from public.fixture_decisions d where d.fixture_id = f.id and d.club_id = c.id and d.decision = 'skip'))
        or s.started_at < now() - interval '10 minutes'))
      or (f.status = 'live' and ms.updated_at < now() - interval '6 minutes')
    )
  order by (select count(*) from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human') desc, f.id;
$$;

create or replace function public.admin_world_member(p_world uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.world_members where world_id = p_world and user_id = p_user)
$$;

-- Elfmeterschießen (Pokal / Relegation) – deterministisch aus dem Spiel-Seed und der Schützenqualität
create or replace function public.fd_shootout(p_fixture uuid)
returns int[]
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_q numeric[] := array[0, 0];
  v_qh numeric;
  v_qa numeric;
  v_s int[] := array[0, 0];
  v_k integer := 0;
  v_side integer;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  select coalesce(avg((pa.attributes ->> 'penalties')::numeric), 60) into v_qh
  from public.players p join public.player_attributes pa on pa.player_id = p.id where p.club_id = v_f.home_club_id and pa.kind = 'outfield';
  select coalesce(avg((pa.attributes ->> 'penalties')::numeric), 60) into v_qa
  from public.players p join public.player_attributes pa on pa.player_id = p.id where p.club_id = v_f.away_club_id and pa.kind = 'outfield';
  v_q := array[v_qh, v_qa];
  loop
    v_k := v_k + 1;
    for v_side in 1..2 loop
      if public.fd_hash01(v_f.rng_seed || ':pen:' || v_k || ':' || v_side) < 0.62 + v_q[v_side] / 500 then v_s[v_side] := v_s[v_side] + 1; end if;
    end loop;
    exit when (v_k >= 5 and v_s[1] <> v_s[2]) or v_k > 30;
    -- vorzeitige Entscheidung in den ersten fünf
    exit when v_k < 5 and (v_s[1] > v_s[2] + (5 - v_k) or v_s[2] > v_s[1] + (5 - v_k));
  end loop;
  if v_s[1] = v_s[2] then v_s[1] := v_s[1] + 1; end if;
  return v_s;
end;
$$;

-- ---------------------------------------------------------------------
-- Match-Setup mit Sperren/Verletzungen, Zuschauer-Heimvorteil und Terminprüfung
-- ---------------------------------------------------------------------
drop function if exists public.fd_match_team(uuid, date);
create or replace function public.fd_match_team(p_club uuid, p_date date, p_scope public.discipline_scope, p_season uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'clubId', c.id, 'name', c.name, 'shortName', c.short_name, 'control', c.control, 'managerUserId', c.manager_user_id,
    'color', coalesce(b.primary_color, '#1d4ed8'), 'colorAlt', coalesce(b.secondary_color, '#ffffff'),
    'kit', b.kit, 'capacity', s.capacity,
    'squad', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'shirt', coalesce(p.shirt_number, 0), 'name', p.last_name, 'first_name', p.first_name,
        'main_position', p.main_position, 'secondary_positions', to_jsonb(p.secondary_positions), 'overall', p.overall,
        'fitness', p.fitness, 'kind', pa.kind, 'attributes', pa.attributes, 'nationality', p.nationality, 'region', p.region, 'age', p.age,
        'unavailable', exists (select 1 from public.injuries i where i.player_id = p.id and p_date between i.starts_on and i.ends_on)
          or (p_scope is not null and exists (select 1 from public.disciplinary_records d where d.player_id = p.id and d.scope = p_scope
                and d.season_id = p_season and d.suspension_matches > d.served_matches))
      ) order by p.shirt_number nulls last)
      from public.players p join public.player_attributes pa on pa.player_id = p.id
      where p.club_id = c.id and not p.retired), '[]'::jsonb),
    'settings', (select to_jsonb(t) - 'club_id' - 'world_id' - 'updated_at' from public.tactics t where t.club_id = c.id),
    'profiles', coalesce((
      select jsonb_object_agg(tp.name, jsonb_build_object(
        'formation_code', tp.formation_code,
        'team_instructions', tp.team_instructions,
        'advanced_options', tp.advanced_options,
        'slots', coalesce((select jsonb_agg(jsonb_build_object('slotIndex', sl.slot_index, 'position', sl.position, 'x', sl.x, 'y', sl.y, 'playerId', sl.player_id) order by sl.slot_index)
                           from public.tactical_profile_slots sl where sl.profile_id = tp.id), '[]'::jsonb),
        'instructions', coalesce((select jsonb_object_agg(pi.player_id, to_jsonb(pi.instructions)) from public.player_instructions pi where pi.profile_id = tp.id), '{}'::jsonb)
      ))
      from public.tactical_profiles tp where tp.club_id = c.id), '{}'::jsonb),
    'setPieces', coalesce((
      select jsonb_object_agg(k.kind, k.ids) from (
        select sp.kind, jsonb_agg(sp.player_id order by sp.priority) as ids from public.set_piece_assignments sp where sp.club_id = c.id group by sp.kind
      ) k), '{}'::jsonb)
  )
  from public.clubs c
  left join public.club_branding b on b.club_id = c.id
  left join public.stadiums s on s.club_id = c.id
  where c.id = p_club;
$$;

create or replace function public.fd_fixture_scope(p_fixture uuid)
returns public.discipline_scope
language sql stable set search_path = '' as $$
  select case c.kind::text when 'domestic_cup' then 'domestic_cup'::public.discipline_scope
                          when 'champions_league' then 'uefa'::public.discipline_scope when 'europa_league' then 'uefa'::public.discipline_scope
                          when 'friendly' then null else 'league'::public.discipline_scope end
  from public.fixtures f join public.competitions c on c.id = f.competition_id where f.id = p_fixture
$$;

create or replace function public.admin_match_setup(p_fixture uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    'checkpoint', v_session.checkpoint
  );
end;
$$;

-- Ergebnis speichern – idempotent. Pflichtspiele: Fitness, Verletzungen, Karten/Sperren, Zuschauer,
-- Elfmeterschießen; danach wird die gemeinsame Freigabe geprüft.
create or replace function public.admin_finish_match(p_fixture uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
          jsonb_build_object('stats', p_result -> 'stats', 'playerOfTheMatch', p_result -> 'playerOfTheMatch'),
          v_att, v_pen[1], v_pen[2]);

  insert into public.match_events(fixture_id, world_id, match_second, type, club_id, player_id, secondary_player_id, payload)
  select p_fixture, v_f.world_id, greatest(0, round(coalesce((e ->> 'second')::numeric, (e ->> 'tick')::numeric * 0.75)))::int, e ->> 'type',
         (v_side_club ->> (e ->> 'side'))::uuid,
         (select p.id from public.players p where p.id::text = e ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         (select p.id from public.players p where p.id::text = e ->> 'otherId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         jsonb_build_object('minute', e -> 'minute', 'text', e -> 'text', 'xg', e -> 'xg')
  from jsonb_array_elements(coalesce(p_result -> 'events', '[]'::jsonb)) e
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
  if v_kind <> 'friendly' then perform public.fd_try_release(v_f.world_id); end if;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- ---------------------------------------------------------------------
-- Gemeinsame Freigabe, Abrechnung und Fortschritt
-- ---------------------------------------------------------------------
create or replace function public.fd_pay(p_club uuid, p_kind public.transaction_kind, p_amount bigint, p_key text, p_desc text, p_season uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_amount = 0 or not exists (select 1 from public.finances where club_id = p_club) then return; end if;
  perform public.post_transaction(p_club, p_kind, p_amount, p_key, p_desc, p_season, true);
end;
$$;

create or replace function public.fd_try_release(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state <> 'live' or v_slot.kind = 'season_end' then return; end if;
  if exists (select 1 from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(p_world)) and f.status not in ('finished', 'released')) then
    return;
  end if;
  perform public.fd_release_slot(p_world);
end;
$$;

create or replace function public.fd_release_slot(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
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
      select case when f.comp_kind = 'domestic_cup' then ticket_price_cup else ticket_price_league end, capacity
      into v_price, v_cap from public.stadiums where club_id = f.home_club_id;
      if v_price is not null then
        perform public.fd_pay(f.home_club_id, 'ticket_income', v_res.attendance::bigint * v_price, 'fx:' || f.id || ':tickets',
          'Zuschauer ' || v_res.attendance || ' · ' || v_slot.label, f.season_id);
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
    for r in select pc.club_id, sum(pc.annual_salary) as total from public.player_contracts pc
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and pc.active group by pc.club_id loop
      perform public.fd_pay(r.club_id, 'salary', (-(r.total / 34))::bigint, 'slot:' || v_slot.id || ':salary:' || r.club_id, 'Gehälter · ' || v_slot.label, v_slot.season_id);
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

  -- Nach dem 34. Spieltag: Platzierungsprämien und Relegation
  if v_slot.kind = 'league' and v_slot.matchday = 34 then
    perform public.fd_after_last_matchday(p_world);
  end if;

  update public.season_slots set state = 'released', released_at = now() where id = v_slot.id;
  select * into v_next from public.season_slots where season_id = v_slot.season_id and ordinal = v_slot.ordinal + 1;
  -- G2: Regeneration +15 je freiem Tag bis zum nächsten Termin
  v_days := greatest(1, coalesce(v_next.slot_date, v_slot.slot_date + 7) - v_slot.slot_date);
  update public.players p set fitness = least(100, p.fitness + 15 * greatest(1, v_days - 1))
  where p.world_id = p_world and p.club_id is not null;
  update public.career_worlds set current_slot = current_slot + 1,
    current_week = current_week + (v_slot.kind = 'league')::int,
    current_date_in_world = coalesce(v_next.slot_date, v_slot.slot_date) - 1
  where id = p_world;
end;
$$;

-- Platzierungsprämien (I6) und Relegationsspiele (C3) nach dem letzten Spieltag
create or replace function public.fd_after_last_matchday(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  r record;
  v_comp uuid;
  v_up uuid;
  v_down uuid;
  v_stage uuid;
  v_tie uuid;
  v_t smallint;
  v_r1 public.season_slots;
  v_r2 public.season_slots;
begin
  select * into v_world from public.career_worlds where id = p_world;
  for r in select c.id, c.tier from public.competitions c where c.season_id = v_world.current_season_id and c.kind = 'league' loop
    perform public.fd_pay(t.club_id, 'placement_prize',
      (select amount from public.prize_templates where competition_kind = 'league' and tier = r.tier and prize_key = 'placement_' || t.pos),
      'season:' || v_world.current_season_id || ':placement:' || t.club_id, 'Platzierungsprämie Platz ' || t.pos, v_world.current_season_id)
    from public.fd_table(r.id) t;
  end loop;
  select * into v_r1 from public.season_slots where season_id = v_world.current_season_id and slot_key = 'R1';
  select * into v_r2 from public.season_slots where season_id = v_world.current_season_id and slot_key = 'R2';
  for v_t in 1..2 loop
    select t.club_id into v_down from public.fd_table((select id from public.competitions where season_id = v_world.current_season_id and kind = 'league' and tier = v_t)) t where t.pos = 16;
    select t.club_id into v_up from public.fd_table((select id from public.competitions where season_id = v_world.current_season_id and kind = 'league' and tier = v_t + 1)) t where t.pos = 3;
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_world.current_season_id, 'relegation', 'GER', v_t, case v_t when 1 then 'Relegation Bundesliga' else 'Relegation 2. Bundesliga' end)
    on conflict do nothing;
    select id into v_comp from public.competitions where season_id = v_world.current_season_id and kind = 'relegation' and tier = v_t;
    insert into public.competition_stages(competition_id, world_id, kind, ordinal, two_legged) values (v_comp, p_world, 'relegation', 1, true)
    on conflict (competition_id, kind) do nothing;
    select id into v_stage from public.competition_stages where competition_id = v_comp and kind = 'relegation';
    if exists (select 1 from public.ties where stage_id = v_stage) then continue; end if;
    insert into public.ties(stage_id, world_id, club_a_id, club_b_id) values (v_stage, p_world, v_down, v_up) returning id into v_tie;
    insert into public.fixtures(world_id, season_id, competition_id, stage_id, tie_id, leg, slot_key, scheduled_date, home_club_id, away_club_id)
    values (p_world, v_world.current_season_id, v_comp, v_stage, v_tie, 1, 'R1', v_r1.slot_date, v_up, v_down),
           (p_world, v_world.current_season_id, v_comp, v_stage, v_tie, 2, 'R2', v_r2.slot_date, v_down, v_up);
  end loop;
end;
$$;

-- Saisonabschluss (J2): Sponsor-Saisonprämien, Auf-/Abstieg, neue Saison, Vorbereitung
create or replace function public.fd_end_season(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_old public.seasons;
  v_new uuid;
  v_slot public.season_slots;
  v_tiers uuid[] := array[null, null, null]::uuid[];
  v_tier smallint;
  v_comp uuid;
  v_moves jsonb := '[]'::jsonb;
  r record;
  v_newtier jsonb := '{}'::jsonb;
  v_rel_win uuid;
  v_rel_lose uuid;
  v_ama uuid[];
  v_pos integer;
  v_ga integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  select * into v_old from public.seasons where id = v_world.current_season_id;
  v_slot := public.fd_current_slot(p_world);

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
      perform public.fd_pay(r.club_id, 'sponsor', so.amount, 'season:' || v_old.id || ':sponsorbonus:' || r.club_id, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
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
    perform public.fd_pay(v_rel_win, 'sponsor', so.amount, 'season:' || v_old.id || ':sponsorbonus:' || v_rel_win, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
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
    values (p_world, v_new, 'league', 'GER', v_tier, case v_tier when 1 then 'Bundesliga' when 2 then '2. Bundesliga' else '3. Liga' end)
    returning id into v_comp;
    insert into public.competition_entries(competition_id, club_id, world_id)
    select v_comp, (k)::uuid, p_world from jsonb_each_text(v_newtier) e(k, v) where v::int = v_tier;
  end loop;
  -- Sicherung: jede Liga exakt 18 Vereine
  if exists (select 1 from public.competitions c where c.season_id = v_new and c.kind = 'league'
             and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18) then
    raise exception 'Auf-/Abstieg ergibt keine 18er-Ligen' using errcode = 'P0001', hint = 'league_size';
  end if;

  -- Saisonwechsel: Alter +1, Verträge (Verlängerungen folgen in Phase 9 – vorerst automatisch +2 Jahre)
  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
  update public.player_contracts set end_season_year = end_season_year + 2
  where world_id = p_world and active and end_season_year <= v_old.year;
  update public.disciplinary_records set served_matches = suspension_matches where world_id = p_world and season_id = v_old.id;
  update public.players set fitness = 100 where world_id = p_world;

  update public.season_slots set state = 'released', released_at = now() where season_id = v_old.id and slot_key = 'END';
  update public.seasons set status = 'closed' where id = v_old.id;
  update public.career_worlds set current_season_id = v_new, status = 'preseason', current_slot = 0, current_week = 0,
    current_date_in_world = make_date(v_old.year + 1, 7, 1)
  where id = p_world;
  delete from public.multiplayer_readiness where world_id = p_world and context = 'preseason';
end;
$$;

-- Vorbereitung: Sobald alle bereit sind, startet die Saison (ersetzt Phase-4-Version)
create or replace function public.set_preseason_ready(p_world uuid, p_ready boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_active public.tactical_profile_name;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status <> 'preseason' then
    raise exception 'Die Saisonvorbereitung ist abgeschlossen.' using errcode = 'P0001', hint = 'not_preseason';
  end if;
  if coalesce(p_ready, false) then
    if not exists (select 1 from public.sponsor_contracts where club_id = v_club and season_id = v_world.current_season_id) then
      raise exception 'Wähle zuerst einen Sponsor.' using errcode = 'P0001', hint = 'sponsor_required';
    end if;
    select active_profile into v_active from public.tactics where club_id = v_club;
    if (select count(*) from public.tactical_profile_slots s join public.tactical_profiles t on t.id = s.profile_id
        where t.club_id = v_club and t.name = v_active and s.player_id is not null) <> 11 then
      raise exception 'Stelle im aktiven Taktikprofil zuerst eine vollständige Elf auf.' using errcode = 'P0001', hint = 'lineup_incomplete';
    end if;
  end if;
  insert into public.multiplayer_readiness(world_id, user_id, context, ready)
  values (p_world, auth.uid(), 'preseason', coalesce(p_ready, false))
  on conflict (world_id, user_id, context) do update set ready = excluded.ready, updated_at = now();
  if not exists (
    select 1 from public.clubs c where c.world_id = p_world and c.control = 'human'
      and not exists (select 1 from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = c.manager_user_id and r.context = 'preseason' and r.ready)
  ) then
    perform public.fd_start_season(p_world);
  end if;
end;
$$;

-- Host darf die Saison starten, wenn einzelne Manager nicht reagieren (Timeout-Regel)
create or replace function public.force_start_season(p_world uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_world public.career_worlds;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.host_user_id <> auth.uid() then
    raise exception 'Nur der Host kann die Saison starten.' using errcode = '42501', hint = 'host_only';
  end if;
  if v_world.status <> 'preseason' then
    raise exception 'Die Saisonvorbereitung ist abgeschlossen.' using errcode = 'P0001', hint = 'not_preseason';
  end if;
  -- Manager ohne Sponsor erhalten den Sicherheitsvertrag
  insert into public.sponsor_contracts(world_id, club_id, season_id, sponsor_offer_id)
  select p_world, c.id, v_world.current_season_id,
         (select so.id from public.sponsor_offers so where so.tier = coalesce(public.fd_club_tier(c.id, v_world.current_season_id), 2) and so.kind = 'per_league_match' limit 1)
  from public.clubs c where c.world_id = p_world and c.control = 'human'
  on conflict (club_id, season_id) do nothing;
  perform public.fd_start_season(p_world);
end;
$$;

-- ---------------------------------------------------------------------
-- Phase 8: Transferfenster, Transfers, Free Agents (H1–H5)
-- ---------------------------------------------------------------------
-- Offenes Fenster: Vorbereitung bis einschließlich Spieltag 5 bzw. nach Spieltag 17 bis einschließlich 22
create or replace function public.fd_open_window(p_world uuid)
returns public.transfer_windows
language plpgsql
stable
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_next smallint;
  v_win public.transfer_windows;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status = 'preseason' then
    select * into v_win from public.transfer_windows where season_id = v_world.current_season_id and window_no = 1;
    return v_win;
  end if;
  if v_world.status <> 'season' then return null; end if;
  select min(s.matchday) into v_next from public.season_slots s
  where s.season_id = v_world.current_season_id and s.kind = 'league' and s.state <> 'released';
  select * into v_win from public.transfer_windows w
  where w.season_id = v_world.current_season_id and v_next between w.next_matchday_from and w.next_matchday_to;
  return v_win;
end;
$$;

create or replace function public.fd_window_info(p_world uuid, p_club uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_win public.transfer_windows := public.fd_open_window(p_world);
begin
  return jsonb_build_object(
    'open', v_win.id is not null,
    'window_no', v_win.window_no,
    'until_matchday', v_win.next_matchday_to,
    'signings', case when v_win.id is null or p_club is null then 0 else (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = p_club and t.kind in ('transfer', 'free_agent')) end,
    'sales', case when v_win.id is null or p_club is null then 0 else (select count(*) from public.transfers t where t.window_id = v_win.id and t.from_club_id = p_club and t.kind = 'transfer') end,
    'max_signings', 5, 'max_sales', 5, 'min_squad', 16, 'max_squad', 30);
end;
$$;

-- Saisonvorbereitung (Transfers in der Vorbereitung): Fenster 1 schon vor dem Saisonstart anlegen
create or replace function public.fd_ensure_windows(p_world uuid)
returns void language sql set search_path = '' as $$
  insert into public.transfer_windows(world_id, season_id, window_no, next_matchday_from, next_matchday_to)
  select p_world, w.current_season_id, x.n, x.a, x.b from public.career_worlds w,
       (values (1::smallint, 1::smallint, 5::smallint), (2::smallint, 18::smallint, 22::smallint)) x(n, a, b)
  where w.id = p_world and w.current_season_id is not null
  on conflict (season_id, window_no) do nothing;
$$;

-- Wechsel durchführen (atomar): Geld, Vertrag, Kader, Trikotnummer, Taktik aufräumen, Protokoll
create or replace function public.fd_complete_transfer(p_player uuid, p_from uuid, p_to uuid, p_fee bigint, p_salary bigint, p_years integer,
                                                      p_offer uuid, p_kind public.transfer_kind, p_window uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_year integer;
  v_shirt smallint;
begin
  select * into v_p from public.players where id = p_player for update;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  v_year := public.fd_season_year(v_world.current_season_id);
  if p_fee > 0 then
    perform public.post_transaction(p_to, 'transfer_fee_paid', -p_fee, 'transfer:' || coalesce(p_offer::text, p_player::text || ':' || now()::text) || ':paid',
      'Ablöse ' || v_p.first_name || ' ' || v_p.last_name, v_world.current_season_id,
      (select control = 'ai' from public.clubs where id = p_to));
    if p_from is not null then
      perform public.fd_pay(p_from, 'transfer_fee_received', p_fee, 'transfer:' || coalesce(p_offer::text, p_player::text || ':' || now()::text) || ':recv',
        'Verkauf ' || v_p.first_name || ' ' || v_p.last_name, v_world.current_season_id);
    end if;
  end if;
  update public.player_contracts set active = false where player_id = p_player and active;
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  values (v_p.world_id, p_player, p_to, v_year, v_year + greatest(1, least(5, p_years)) - 1, p_salary, v_p.age);
  -- Trikotnummer: Wunschnummer, sonst niedrigste freie
  select n into v_shirt from (
    select coalesce(v_p.preferred_shirt_number, v_p.shirt_number) as n where coalesce(v_p.preferred_shirt_number, v_p.shirt_number) is not null
    union all select g::smallint from generate_series(2, 99) g
  ) x where n not in (select shirt_number from public.players where club_id = p_to and shirt_number is not null) limit 1;
  -- Aus Aufstellungen, Anweisungen und Standards des alten Vereins entfernen
  if p_from is not null then
    update public.tactical_profile_slots s set player_id = null from public.tactical_profiles t
    where t.id = s.profile_id and t.club_id = p_from and s.player_id = p_player;
    delete from public.player_instructions pi using public.tactical_profiles t where t.id = pi.profile_id and t.club_id = p_from and pi.player_id = p_player;
    delete from public.set_piece_assignments where club_id = p_from and player_id = p_player;
  end if;
  update public.players set club_id = p_to, shirt_number = v_shirt, in_draft_pool = false where id = p_player;
  delete from public.free_agents where player_id = p_player;
  insert into public.transfers(world_id, season_id, window_id, player_id, from_club_id, to_club_id, kind, fee, offer_id)
  values (v_p.world_id, v_world.current_season_id, p_window, p_player, p_from, p_to, p_kind, p_fee, p_offer);
  update public.transfer_offers set status = 'expired', responded_at = now()
  where player_id = p_player and status in ('pending', 'countered') and (p_offer is null or id <> p_offer);
end;
$$;

create or replace function public.fd_check_buy(p_world uuid, p_club uuid, p_fee bigint, p_win public.transfer_windows)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_win.id is null then raise exception 'Das Transferfenster ist geschlossen.' using errcode = 'P0001', hint = 'window_closed'; end if;
  if (select count(*) from public.transfers t where t.window_id = p_win.id and t.to_club_id = p_club and t.kind in ('transfer', 'free_agent')) >= 5 then
    raise exception 'In diesem Fenster sind bereits fünf Neuzugänge erfolgt.' using errcode = 'P0001', hint = 'limit_signings';
  end if;
  if (select count(*) from public.players where club_id = p_club) >= 30 then
    raise exception 'Der Kader ist voll (maximal 30 Spieler).' using errcode = 'P0001', hint = 'squad_full';
  end if;
  if (select balance from public.finances where club_id = p_club) < p_fee then
    raise exception 'Nicht genügend Geld auf dem Vereinskonto.' using errcode = 'P0001', hint = 'insufficient_funds';
  end if;
end;
$$;

create or replace function public.fd_check_sell(p_club uuid, p_win public.transfer_windows)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_win.id is null then raise exception 'Das Transferfenster ist geschlossen.' using errcode = 'P0001', hint = 'window_closed'; end if;
  if (select count(*) from public.transfers t where t.window_id = p_win.id and t.from_club_id = p_club and t.kind = 'transfer') >= 5 then
    raise exception 'In diesem Fenster sind bereits fünf Verkäufe erfolgt.' using errcode = 'P0001', hint = 'limit_sales';
  end if;
  if (select count(*) from public.players where club_id = p_club) <= 16 then
    raise exception 'Der Kader darf nicht unter 16 Spieler fallen.' using errcode = 'P0001', hint = 'squad_min';
  end if;
end;
$$;

-- H3: Zustimmung des Spielers (Gehalt, Liga, Reputation, Aussicht auf Einsatzzeit)
create or replace function public.fd_player_demand(p_player uuid, p_to uuid)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_from_tier smallint;
  v_to_tier smallint;
  v_rep numeric;
  v_rank integer;
  v_f numeric := 1;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  v_from_tier := case when v_p.club_id is null then 3 else public.fd_tier_of(v_p.club_id, v_world.current_season_id) end;
  v_to_tier := public.fd_tier_of(p_to, v_world.current_season_id);
  select reputation into v_rep from public.clubs where id = p_to;
  select count(*) + 1 into v_rank from public.players where club_id = p_to and main_position = v_p.main_position and overall > v_p.overall;
  v_f := v_f + 0.12 * (v_to_tier - v_from_tier);           -- Abstieg in der Ligahierarchie kostet mehr
  v_f := v_f - (v_rep - 50) / 250;                          -- attraktive Vereine bekommen Rabatt
  v_f := v_f + case when v_rank > 2 then 0.1 * (v_rank - 2) else 0 end; -- wenig Einsatzzeit
  return (round(public.fd_salary_demand(v_p.market_value, v_p.age) * greatest(0.8, least(1.8, v_f)) / 10000) * 10000)::bigint;
end;
$$;

-- Angebot abgeben. KI-Vereine antworten sofort (annehmen, Gegenangebot, ablehnen); Menschen später.
create or replace function public.make_transfer_offer(p_player uuid, p_fee bigint, p_salary bigint, p_years integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_club uuid;
  v_from public.clubs;
  v_win public.transfer_windows;
  v_offer uuid;
  v_required bigint;
  v_demand bigint;
  v_important boolean;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or v_p.club_id is null then raise exception 'Spieler nicht gefunden oder vereinslos.' using errcode = 'P0001', hint = 'not_found'; end if;
  v_club := public.fd_require_team(v_p.world_id);
  if v_p.club_id = v_club then raise exception 'Der Spieler gehört bereits zu deinem Verein.' using errcode = 'P0001', hint = 'own_player'; end if;
  if p_fee is null or p_fee < 0 or p_salary is null or p_salary <= 0 or p_years not between 1 and 5 then
    raise exception 'Ungültiges Angebot.' using errcode = '22023', hint = 'invalid_offer';
  end if;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_buy(v_p.world_id, v_club, p_fee, v_win);
  select * into v_from from public.clubs where id = v_p.club_id;
  insert into public.transfer_offers(world_id, window_id, player_id, from_club_id, to_club_id, fee, annual_salary, contract_years)
  values (v_p.world_id, v_win.id, p_player, v_p.club_id, v_club, p_fee, p_salary, p_years) returning id into v_offer;

  if v_from.control = 'human' then
    return jsonb_build_object('status', 'pending', 'offer', v_offer, 'message', 'Angebot gesendet. ' || v_from.name || ' entscheidet.');
  end if;

  -- KI-Verein: Stammspieler sind teurer
  v_important := (select count(*) from public.players where club_id = v_p.club_id and overall > v_p.overall) < 14;
  v_required := (round(v_p.market_value * case when v_important then 1.3 else 1.05 end / 100000) * 100000)::bigint;
  if p_fee < v_required then
    if p_fee >= v_required * 0.7 then
      update public.transfer_offers set status = 'countered', counter_fee = v_required, responded_at = now() where id = v_offer;
      return jsonb_build_object('status', 'countered', 'offer', v_offer, 'counter_fee', v_required,
        'message', v_from.name || ' fordert ' || to_char(v_required / 1e6, 'FM999990D0') || ' Mio. €.');
    end if;
    update public.transfer_offers set status = 'rejected', responded_at = now() where id = v_offer;
    return jsonb_build_object('status', 'rejected', 'offer', v_offer, 'message', v_from.name || ' lehnt das Angebot ab.');
  end if;
  begin
    perform public.fd_check_sell(v_p.club_id, v_win);
  exception when others then
    update public.transfer_offers set status = 'rejected', responded_at = now() where id = v_offer;
    return jsonb_build_object('status', 'rejected', 'offer', v_offer, 'message', v_from.name || ' darf in diesem Fenster niemanden mehr abgeben.');
  end;
  v_demand := public.fd_player_demand(p_player, v_club);
  if p_salary < v_demand then
    update public.transfer_offers set status = 'countered', counter_fee = p_fee, counter_salary = v_demand, responded_at = now() where id = v_offer;
    return jsonb_build_object('status', 'countered', 'offer', v_offer, 'counter_salary', v_demand,
      'message', 'Der Verein ist einverstanden, aber ' || v_p.last_name || ' verlangt ' || to_char(v_demand / 1e6, 'FM999990D00') || ' Mio. € Jahresgehalt.');
  end if;
  update public.transfer_offers set status = 'completed', responded_at = now() where id = v_offer;
  perform public.fd_complete_transfer(p_player, v_p.club_id, v_club, p_fee, p_salary, p_years, v_offer, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'offer', v_offer, 'message', v_p.first_name || ' ' || v_p.last_name || ' wechselt zu deinem Verein!');
end;
$$;

-- Gegenangebot annehmen (Käufer)
create or replace function public.accept_counter_offer(p_offer uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.transfer_offers;
  v_fee bigint;
  v_salary bigint;
  v_win public.transfer_windows;
  v_p public.players;
begin
  select * into v_o from public.transfer_offers where id = p_offer for update;
  if not found or not public.is_club_manager(v_o.to_club_id) then raise exception 'Angebot nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_o.status <> 'countered' then raise exception 'Kein offenes Gegenangebot.' using errcode = 'P0001', hint = 'not_countered'; end if;
  select * into v_p from public.players where id = v_o.player_id for update;
  if v_p.club_id is distinct from v_o.from_club_id then raise exception 'Der Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  v_win := public.fd_open_window(v_o.world_id);
  v_fee := coalesce(v_o.counter_fee, v_o.fee);
  v_salary := greatest(coalesce(v_o.counter_salary, v_o.annual_salary), public.fd_player_demand(v_o.player_id, v_o.to_club_id));
  perform public.fd_check_buy(v_o.world_id, v_o.to_club_id, v_fee, v_win);
  perform public.fd_check_sell(v_o.from_club_id, v_win);
  update public.transfer_offers set status = 'completed', fee = v_fee, annual_salary = v_salary, responded_at = now() where id = p_offer;
  perform public.fd_complete_transfer(v_o.player_id, v_o.from_club_id, v_o.to_club_id, v_fee, v_salary, v_o.contract_years, p_offer, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'message', v_p.first_name || ' ' || v_p.last_name || ' wechselt zu deinem Verein!');
end;
$$;

-- Antwort des abgebenden menschlichen Managers
create or replace function public.respond_transfer_offer(p_offer uuid, p_action text, p_counter_fee bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_o public.transfer_offers;
  v_win public.transfer_windows;
  v_demand bigint;
  v_p public.players;
begin
  select * into v_o from public.transfer_offers where id = p_offer for update;
  if not found or not public.is_club_manager(v_o.from_club_id) then raise exception 'Angebot nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_o.status <> 'pending' then raise exception 'Das Angebot ist nicht mehr offen.' using errcode = 'P0001', hint = 'not_pending'; end if;
  if p_action = 'reject' then
    update public.transfer_offers set status = 'rejected', responded_at = now() where id = p_offer;
    return jsonb_build_object('status', 'rejected');
  elsif p_action = 'counter' then
    if p_counter_fee is null or p_counter_fee <= v_o.fee then raise exception 'Das Gegenangebot muss höher sein.' using errcode = '22023', hint = 'invalid'; end if;
    update public.transfer_offers set status = 'countered', counter_fee = p_counter_fee, responded_at = now() where id = p_offer;
    return jsonb_build_object('status', 'countered');
  elsif p_action = 'accept' then
    select * into v_p from public.players where id = v_o.player_id for update;
    v_win := public.fd_open_window(v_o.world_id);
    perform public.fd_check_sell(v_o.from_club_id, v_win);
    perform public.fd_check_buy(v_o.world_id, v_o.to_club_id, v_o.fee, v_win);
    v_demand := public.fd_player_demand(v_o.player_id, v_o.to_club_id);
    if v_o.annual_salary < v_demand then
      update public.transfer_offers set status = 'countered', counter_fee = v_o.fee, counter_salary = v_demand, responded_at = now() where id = p_offer;
      return jsonb_build_object('status', 'countered', 'message', 'Vereine einig – der Spieler verlangt mehr Gehalt. Der Käufer muss zustimmen.');
    end if;
    update public.transfer_offers set status = 'completed', responded_at = now() where id = p_offer;
    perform public.fd_complete_transfer(v_o.player_id, v_o.from_club_id, v_o.to_club_id, v_o.fee, v_o.annual_salary, v_o.contract_years, p_offer, 'transfer', v_win.id);
    return jsonb_build_object('status', 'completed');
  end if;
  raise exception 'Ungültige Aktion.' using errcode = '22023', hint = 'invalid';
end;
$$;

create or replace function public.withdraw_transfer_offer(p_offer uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.transfer_offers set status = 'withdrawn', responded_at = now()
  where id = p_offer and status in ('pending', 'countered') and public.is_club_manager(to_club_id);
  if not found then raise exception 'Angebot nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
end;
$$;

-- Spieler an einen KI-Verein verkaufen (KI bietet 85–95 % des Marktwerts)
create or replace function public.sell_to_ai(p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_win public.transfer_windows;
  v_buyer uuid;
  v_fee bigint;
  v_tier smallint;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or not public.is_club_manager(v_p.club_id) then raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_sell(v_p.club_id, v_win);
  v_fee := (round(v_p.market_value * (0.85 + public.fd_hash01(v_p.id::text || v_win.id::text) * 0.1) / 100000) * 100000)::bigint;
  -- passender KI-Käufer: Liga nach Stärke, Budget, Platz im Kader, Neuzugangslimit
  v_tier := case when v_p.overall >= 78 then 1 when v_p.overall >= 71 then 2 else 3 end;
  select c.id into v_buyer from public.clubs c join public.finances f on f.club_id = c.id
  where c.world_id = v_p.world_id and c.control = 'ai' and not c.amateur and f.balance >= v_fee
    and public.fd_tier_of(c.id, v_world.current_season_id) = v_tier
    and (select count(*) from public.players where club_id = c.id) < 28
    and (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = c.id and t.kind in ('transfer', 'free_agent')) < 5
  order by md5(c.id::text || p_player::text) limit 1;
  if v_buyer is null then
    return jsonb_build_object('status', 'rejected', 'message', 'Kein KI-Verein kann sich den Spieler gerade leisten.');
  end if;
  perform public.fd_complete_transfer(p_player, v_p.club_id, v_buyer, v_fee, greatest(public.fd_salary_demand(v_p.market_value, v_p.age), 50000), 3, null, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'fee', v_fee, 'buyer', (select name from public.clubs where id = v_buyer),
    'message', v_p.last_name || ' wechselt für ' || to_char(v_fee / 1e6, 'FM999990D0') || ' Mio. € zu ' || (select name from public.clubs where id = v_buyer) || '.');
end;
$$;

-- H4: Free Agent verpflichten – eindeutig durch Zeilensperre
create or replace function public.sign_free_agent(p_player uuid, p_years integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fa public.free_agents;
  v_p public.players;
  v_club uuid;
  v_win public.transfer_windows;
begin
  select * into v_fa from public.free_agents where player_id = p_player for update skip locked;
  if not found then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  select * into v_p from public.players where id = p_player for update;
  if v_p.club_id is not null then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  v_club := public.fd_require_team(v_p.world_id);
  if (select reputation from public.clubs where id = v_club) < v_fa.min_club_reputation then
    raise exception 'Der Spieler möchte nur zu einem renommierteren Verein.' using errcode = 'P0001', hint = 'reputation';
  end if;
  if p_years not between 1 and 5 then raise exception 'Ungültige Laufzeit.' using errcode = '22023', hint = 'invalid'; end if;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_buy(v_p.world_id, v_club, 0, v_win);
  perform public.fd_complete_transfer(p_player, null, v_club, 0, v_fa.annual_salary, p_years, null, 'free_agent', v_win.id);
  return jsonb_build_object('status', 'completed', 'message', v_p.first_name || ' ' || v_p.last_name || ' unterschreibt bei deinem Verein.');
end;
$$;

-- Spieler freistellen: wird Free Agent, Abfindung 50 % des Restgehalts
create or replace function public.release_player(p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_c public.player_contracts;
  v_world public.career_worlds;
  v_comp bigint;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or not public.is_club_manager(v_p.club_id) then raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  if public.fd_open_window(v_p.world_id) is null or (public.fd_open_window(v_p.world_id)).id is null then
    raise exception 'Freistellungen sind nur im Transferfenster möglich.' using errcode = 'P0001', hint = 'window_closed';
  end if;
  if (select count(*) from public.players where club_id = v_p.club_id) <= 16 then
    raise exception 'Der Kader darf nicht unter 16 Spieler fallen.' using errcode = 'P0001', hint = 'squad_min';
  end if;
  select * into v_c from public.player_contracts where player_id = p_player and active;
  v_comp := coalesce(v_c.annual_salary, 0) * greatest(0, v_c.end_season_year - public.fd_season_year(v_world.current_season_id) + 1) / 2;
  perform public.fd_pay(v_p.club_id, 'adjustment', -v_comp, 'release:' || p_player || ':' || now()::text, 'Abfindung ' || v_p.last_name, v_world.current_season_id);
  update public.tactical_profile_slots s set player_id = null from public.tactical_profiles t where t.id = s.profile_id and t.club_id = v_p.club_id and s.player_id = p_player;
  delete from public.player_instructions pi using public.tactical_profiles t where t.id = pi.profile_id and t.club_id = v_p.club_id and pi.player_id = p_player;
  delete from public.set_piece_assignments where club_id = v_p.club_id and player_id = p_player;
  update public.player_contracts set active = false where player_id = p_player and active;
  insert into public.transfers(world_id, season_id, window_id, player_id, from_club_id, kind)
  values (v_p.world_id, v_world.current_season_id, (public.fd_open_window(v_p.world_id)).id, p_player, v_p.club_id, 'release');
  update public.players set club_id = null, shirt_number = null where id = p_player;
  insert into public.free_agents(player_id, world_id, annual_salary) values (p_player, v_p.world_id, public.fd_salary_demand(v_p.market_value, v_p.age))
  on conflict (player_id) do nothing;
  return jsonb_build_object('status', 'released', 'compensation', v_comp);
end;
$$;

-- Eigene Verhandlungen
create or replace function public.my_transfer_offers(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'status', o.status, 'fee', o.fee, 'salary', o.annual_salary, 'years', o.contract_years,
      'counter_fee', o.counter_fee, 'counter_salary', o.counter_salary, 'created_at', o.created_at,
      'direction', case when o.to_club_id = v_club then 'out' else 'in' end,
      'player', jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'position', p.main_position, 'overall', p.overall, 'age', p.age, 'value', p.market_value),
      'from', jsonb_build_object('id', fc.id, 'name', fc.name), 'to', jsonb_build_object('id', tc.id, 'name', tc.name)
    ) order by o.created_at desc)
    from public.transfer_offers o join public.players p on p.id = o.player_id
    left join public.clubs fc on fc.id = o.from_club_id join public.clubs tc on tc.id = o.to_club_id
    where o.world_id = p_world and (o.to_club_id = v_club or o.from_club_id = v_club) and o.created_at > now() - interval '60 days'
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Stadion, Tickets, Finanzen (I3, I4)
-- ---------------------------------------------------------------------
create or replace function public.set_ticket_prices(p_world uuid, p_league integer, p_cup integer, p_international integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if p_league not between 5 and 500 or p_cup not between 5 and 500 or p_international not between 5 and 500 then
    raise exception 'Ticketpreise zwischen 5 und 500 €.' using errcode = '22023', hint = 'invalid';
  end if;
  update public.stadiums set ticket_price_league = p_league, ticket_price_cup = p_cup, ticket_price_international = p_international where club_id = v_club;
end;
$$;

-- Ausbau nur in der Saisonvorbereitung (Saisonwechsel), je +5.000 Plätze für 25 Mio. €
create or replace function public.expand_stadium(p_world uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_cap integer;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status <> 'preseason' then
    raise exception 'Ein Ausbau ist nur zum Saisonwechsel (Vorbereitung) möglich.' using errcode = 'P0001', hint = 'not_preseason';
  end if;
  select capacity into v_cap from public.stadiums where club_id = v_club for update;
  if v_cap >= 50000 then raise exception 'Das Stadion hat bereits die Maximalgröße.' using errcode = 'P0001', hint = 'max'; end if;
  perform public.post_transaction(v_club, 'stadium_expansion', -25000000, 'expand:' || v_club || ':' || v_world.current_season_id || ':' || v_cap,
    'Stadionausbau auf ' || (v_cap + 5000) || ' Plätze', v_world.current_season_id);
  update public.stadiums set capacity = v_cap + 5000 where club_id = v_club;
  return jsonb_build_object('capacity', v_cap + 5000);
end;
$$;

create or replace function public.finance_overview(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
begin
  select * into v_world from public.career_worlds where id = p_world;
  return jsonb_build_object(
    'balance', (select balance from public.finances where club_id = v_club),
    'salaries', (select coalesce(sum(annual_salary), 0) from public.player_contracts where club_id = v_club and active),
    'stadium', (select to_jsonb(s) - 'world_id' from public.stadiums s where s.club_id = v_club),
    'status', v_world.status,
    'season_totals', coalesce((select jsonb_object_agg(kind, total) from (
        select kind, sum(amount) as total from public.financial_transactions where club_id = v_club and season_id = v_world.current_season_id group by kind) x), '{}'::jsonb),
    'transactions', coalesce((select jsonb_agg(to_jsonb(t) - 'world_id' - 'idempotency_key' order by t.id desc) from (
        select * from public.financial_transactions where club_id = v_club order by id desc limit 60) t), '[]'::jsonb),
    'last_attendance', (select jsonb_build_object('attendance', r.attendance, 'label', s.label) from public.fixtures f
        join public.fixture_results r on r.fixture_id = f.id join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
        where f.home_club_id = v_club and f.status = 'released' and r.attendance is not null order by f.scheduled_date desc limit 1)
  );
end;
$$;

-- Torschützen- und Vorlagenliste (nur freigegebene Spiele)
create or replace function public.league_leaders(p_comp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'scorers', coalesce((select jsonb_agg(x order by (x ->> 'goals')::int desc, (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'club', c.short_name, 'goals', sum(ms.goals), 'assists', sum(ms.assists),
                                  'games', count(*), 'rating', round(avg(ms.rating), 2)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id)
        group by p.id, c.short_name having sum(ms.goals) > 0 order by sum(ms.goals) desc, sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'assists', coalesce((select jsonb_agg(x order by (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'club', c.short_name, 'assists', sum(ms.assists), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id)
        group by p.id, c.short_name having sum(ms.assists) > 0 order by sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'ratings', coalesce((select jsonb_agg(x order by (x ->> 'rating')::numeric desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'club', c.short_name, 'rating', round(avg(ms.rating), 2), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id) and ms.minutes >= 45
        group by p.id, c.short_name having count(*) >= greatest(1, (select max(matchday) from public.fixtures where competition_id = p_comp and status = 'released') / 3)
        order by avg(ms.rating) desc limit 20) s), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.fd_hash01(text)', 'public.fd_tier_of(uuid, uuid)', 'public.fd_season_year(uuid)', 'public.fd_human_clubs(uuid)',
    'public.fd_salary_demand(bigint, integer)', 'public.fd_ensure_amateurs(uuid)', 'public.fd_schedule_league(uuid)',
    'public.fd_draw_cup_round(uuid, public.stage_kind, uuid[])', 'public.fd_start_season(uuid)', 'public.fd_table(uuid)',
    'public.fd_expected_attendance(uuid)', 'public.fd_home_advantage(uuid)', 'public.fd_current_slot(uuid)', 'public.fd_slot_fixture_ids(uuid)',
    'public.fd_begin_slot(uuid)', 'public.fd_shootout(uuid)', 'public.fd_match_team(uuid, date, public.discipline_scope, uuid)',
    'public.fd_fixture_scope(uuid)', 'public.fd_pay(uuid, public.transaction_kind, bigint, text, text, uuid)', 'public.fd_try_release(uuid)',
    'public.fd_release_slot(uuid)', 'public.fd_after_last_matchday(uuid)', 'public.fd_end_season(uuid)', 'public.fd_open_window(uuid)',
    'public.fd_window_info(uuid, uuid)', 'public.fd_ensure_windows(uuid)',
    'public.fd_complete_transfer(uuid, uuid, uuid, bigint, bigint, integer, uuid, public.transfer_kind, uuid)',
    'public.fd_check_buy(uuid, uuid, bigint, public.transfer_windows)', 'public.fd_check_sell(uuid, public.transfer_windows)',
    'public.fd_player_demand(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.set_matchday_ready(uuid, boolean)', 'public.force_start_slot(uuid)', 'public.set_fixture_decision(uuid, text)',
    'public.matchday_state(uuid)', 'public.set_preseason_ready(uuid, boolean)', 'public.force_start_season(uuid)',
    'public.make_transfer_offer(uuid, bigint, bigint, integer)', 'public.accept_counter_offer(uuid)',
    'public.respond_transfer_offer(uuid, text, bigint)', 'public.withdraw_transfer_offer(uuid)', 'public.sell_to_ai(uuid)',
    'public.sign_free_agent(uuid, integer)', 'public.release_player(uuid)', 'public.my_transfer_offers(uuid)',
    'public.set_ticket_prices(uuid, integer, integer, integer)', 'public.expand_stadium(uuid)', 'public.finance_overview(uuid)',
    'public.league_leaders(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.admin_pending_fixtures(uuid)', 'public.admin_world_member(uuid, uuid)', 'public.admin_match_setup(uuid)', 'public.admin_finish_match(uuid, jsonb)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
grant all on public.season_slots, public.fixture_decisions to service_role;
grant select on public.season_slots, public.fixture_decisions to authenticated;
