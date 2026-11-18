-- =====================================================================
-- Migration 0005: Wettbewerbe, Spielplan, Partien, Statistiken, europäische Wettbewerbe
-- Liga, Pokal, Champions League und Europa League sind Instanzen desselben Modells.
-- =====================================================================

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  kind public.competition_kind not null,
  association_code char(3) references public.associations(code), -- null für UEFA-Wettbewerbe
  tier smallint check (tier between 1 and 4),
  name text not null,
  neutral_final_venue text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (season_id, kind, association_code, tier)
);
create index competitions_world_season on public.competitions(world_id, season_id);

create table public.competition_stages (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  kind public.stage_kind not null,
  ordinal smallint not null,
  two_legged boolean not null default false,
  unique (competition_id, kind)
);

create table public.competition_groups (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.competition_stages(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  label char(1) not null check (label between 'A' and 'H'),
  unique (stage_id, label)
);

create table public.group_memberships (
  group_id uuid not null references public.competition_groups(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  pot smallint check (pot between 1 and 4),
  primary key (group_id, club_id)
);

-- Liga- und Wettbewerbsteilnahme je Saison (welcher Verein spielt in welcher Liga)
create table public.competition_entries (
  competition_id uuid not null references public.competitions(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  seed_rank smallint,
  primary key (competition_id, club_id)
);

-- K.-o.-Paarungen mit Hin- und Rückspiel bzw. Einzelspiel
create table public.ties (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references public.competition_stages(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_a_id uuid not null references public.clubs(id),
  club_b_id uuid not null references public.clubs(id),
  winner_club_id uuid references public.clubs(id),
  decided_by text check (decided_by in ('aggregate', 'extra_time', 'penalties')),
  check (club_a_id <> club_b_id)
);

-- C8.2: Auslosungen mit Seed und Protokoll (reproduzierbar)
create table public.draws (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  stage_id uuid not null references public.competition_stages(id) on delete cascade,
  seed text not null,
  pots jsonb,
  result jsonb not null,
  constraints_applied text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (stage_id)
);

-- J1: Spielplan. Ergebnisse stehen bewusst in einer eigenen Tabelle (fixture_results),
-- damit sie bis zur gemeinsamen Freigabe (B4/F14) per RLS verborgen bleiben.
create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  stage_id uuid references public.competition_stages(id) on delete cascade,
  group_id uuid references public.competition_groups(id) on delete cascade,
  tie_id uuid references public.ties(id) on delete cascade,
  leg smallint check (leg in (1, 2)),
  matchday smallint,
  -- B4: Spieltermin, der gemeinsam gestartet und freigegeben wird
  slot_key text not null,
  scheduled_date date not null,
  home_club_id uuid not null references public.clubs(id),
  away_club_id uuid not null references public.clubs(id),
  neutral_venue boolean not null default false,
  status public.fixture_status not null default 'scheduled',
  rng_seed text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  check (home_club_id <> away_club_id)
);
create index fixtures_world_slot on public.fixtures(world_id, slot_key);
create index fixtures_world_date on public.fixtures(world_id, scheduled_date);
create index fixtures_home_date on public.fixtures(home_club_id, scheduled_date);
create index fixtures_away_date on public.fixtures(away_club_id, scheduled_date);

create table public.fixture_results (
  fixture_id uuid primary key references public.fixtures(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  home_goals smallint not null check (home_goals >= 0),
  away_goals smallint not null check (away_goals >= 0),
  extra_time boolean not null default false,
  home_penalties smallint,
  away_penalties smallint,
  attendance integer check (attendance >= 0),
  home_xg numeric(5,2),
  away_xg numeric(5,2),
  home_possession numeric(4,1),
  summary jsonb not null default '{}',
  finished_at timestamptz not null default now()
);

-- F12: Laufende bzw. abgeschlossene autoritative Simulation einer Partie (genau eine je Fixture)
create table public.match_sessions (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null unique references public.fixtures(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  mode text not null check (mode in ('live', 'headless')),
  room_id text,
  engine_version text not null,
  status text not null default 'running' check (status in ('running', 'finished', 'aborted')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checkpoint jsonb -- Zustand für Wiederaufnahme nach Serverneustart
);

create table public.match_events (
  id bigint generated always as identity primary key,
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  match_second integer not null check (match_second >= 0),
  type text not null,
  club_id uuid references public.clubs(id),
  player_id uuid references public.players(id),
  secondary_player_id uuid references public.players(id),
  payload jsonb not null default '{}'
);
create index match_events_fixture on public.match_events(fixture_id, match_second);

create table public.match_player_stats (
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  club_id uuid not null references public.clubs(id),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  minutes smallint not null default 0,
  goals smallint not null default 0,
  assists smallint not null default 0,
  shots smallint not null default 0,
  shots_on_target smallint not null default 0,
  xg numeric(5,2) not null default 0,
  passes smallint not null default 0,
  passes_completed smallint not null default 0,
  tackles_won smallint not null default 0,
  interceptions smallint not null default 0,
  saves smallint not null default 0,
  rating numeric(3,1),
  fitness_start numeric(5,2),
  fitness_end numeric(5,2),
  primary key (fixture_id, player_id)
);
create index match_player_stats_player on public.match_player_stats(player_id);

alter table public.injuries add constraint injuries_fixture_fk foreign key (fixture_id) references public.fixtures(id) on delete set null;
alter table public.disciplinary_records add constraint disciplinary_fixture_fk foreign key (fixture_id) references public.fixtures(id) on delete set null;

-- C1: Tabellen (auch Gruppentabellen). Wird nur bei der Ergebnisfreigabe fortgeschrieben.
create table public.standings (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  competition_id uuid not null references public.competitions(id) on delete cascade,
  group_id uuid references public.competition_groups(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  played smallint not null default 0,
  won smallint not null default 0,
  drawn smallint not null default 0,
  lost smallint not null default 0,
  goals_for smallint not null default 0,
  goals_against smallint not null default 0,
  points smallint not null default 0,
  home jsonb not null default '{"p":0,"w":0,"d":0,"l":0,"gf":0,"ga":0}',
  away jsonb not null default '{"p":0,"w":0,"d":0,"l":0,"gf":0,"ga":0}',
  unique nulls not distinct (competition_id, group_id, club_id),
  check (played = won + drawn + lost),
  check (points = won * 3 + drawn)
);

-- J3: Auszeichnungen und Historie
create table public.season_awards (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  competition_id uuid references public.competitions(id) on delete cascade,
  kind text not null, -- champion, promoted, relegated, cup_winner, cl_winner, el_winner, top_scorer, top_assists, player_of_year …
  club_id uuid references public.clubs(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  value numeric
);
create index season_awards_season on public.season_awards(season_id, kind);

create table public.career_history (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  club_id uuid references public.clubs(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.competition_records (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  competition_kind public.competition_kind not null,
  record_key text not null,
  scope text not null check (scope in ('season', 'all_time')),
  season_id uuid references public.seasons(id) on delete cascade,
  club_id uuid references public.clubs(id) on delete set null,
  player_id uuid references public.players(id) on delete set null,
  value numeric not null,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (world_id, competition_kind, record_key, scope, season_id)
);

-- C9.1: Fünfjahreswertung
create table public.coefficients_association (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  association_code char(3) not null references public.associations(code),
  points numeric(8,3) not null default 0,
  participants smallint not null default 0,
  season_value numeric(8,3) not null default 0,
  five_year_total numeric(9,3) not null default 0,
  rank smallint,
  primary key (world_id, season_id, association_code)
);

create table public.coefficients_club (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  points numeric(8,3) not null default 0,
  five_year_total numeric(9,3) not null default 0,
  primary key (world_id, season_id, club_id)
);

-- C8.1/C9.2: vergebene Startplätze mit Begründung
create table public.european_qualification_slots (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade, -- Saison, in der gespielt wird
  competition_kind public.competition_kind not null check (competition_kind in ('champions_league', 'europa_league')),
  entry_stage public.stage_kind not null check (entry_stage in ('qualifying_1', 'group')),
  club_id uuid not null references public.clubs(id) on delete cascade,
  route text not null, -- z. B. cup_winner, league_place, el_title_holder, reallocated
  reason text not null,
  unique (season_id, competition_kind, club_id)
);

-- C9.2: genau eine europäische Zuordnung je Verein und Saison → keine doppelte Gruppenphase
create table public.club_season_european_status (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  status public.european_status not null default 'none',
  primary key (season_id, club_id)
);

-- C9.3: gültige Prämien je Saison (Kopie der Vorlage bei Saisonerstellung)
create table public.competition_prize_schedules (
  season_id uuid not null references public.seasons(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  competition_kind public.competition_kind not null,
  tier smallint not null default 0,
  prize_key text not null,
  amount bigint not null check (amount >= 0),
  primary key (season_id, competition_kind, tier, prize_key)
);
