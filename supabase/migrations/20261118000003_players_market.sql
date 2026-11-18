-- =====================================================================
-- Migration 0003: Spieler, Verträge, Draft, Transfers, Training, Verletzungen, Disziplin
-- =====================================================================

-- D1: Spieler (Stammdaten, je Welt genau einmal; der Verein steht direkt am Spieler,
-- damit es keine doppelten Spielerstammdaten pro Verein geben kann)
create table public.players (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  nationality char(3) not null,
  region public.region not null,
  age smallint not null check (age between 15 and 45),
  main_position public.player_position not null,
  secondary_positions public.player_position[] not null default '{}',
  overall smallint not null check (overall between 1 and 99),
  fitness numeric(5,2) not null default 100 check (fitness between 0 and 100),
  market_value bigint not null check (market_value >= 0),
  shirt_number smallint check (shirt_number between 1 and 99),
  club_id uuid references public.clubs(id) on delete set null,
  in_draft_pool boolean not null default false,
  retired boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index players_world_idx on public.players(world_id);
create index players_club_idx on public.players(club_id);
create index players_pool_idx on public.players(world_id) where in_draft_pool;
-- Trikotnummer je Verein eindeutig
create unique index players_shirt_unique on public.players(club_id, shirt_number) where club_id is not null and shirt_number is not null;
create trigger players_touch before update on public.players
  for each row execute function public.touch_updated_at();

-- G4: verborgenes Potenzial – eigene Tabelle ohne Lese-Policy, damit es kein Client sehen kann
create table public.player_hidden (
  player_id uuid primary key references public.players(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  potential smallint not null check (potential between 1 and 99),
  development_points numeric(8,2) not null default 0,
  injury_proneness numeric(4,3) not null default 0.5 check (injury_proneness between 0 and 1)
);

-- D5: Attribute (Feldspieler: 15 Werte; Torhüter: eigenes System). Struktur wird per CHECK geprüft.
create or replace function public.valid_attributes(p_kind text, p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
  k text;
begin
  if p_kind = 'outfield' then
    v_keys := array['pace','shooting','passing','dribbling','defending','physical','stamina','gameIntelligence','heading','mentality','freeKicks','penalties','corners','crossing','throwIns'];
  elsif p_kind = 'goalkeeper' then
    v_keys := array['reflexes','handling','positioning','oneOnOne','commandOfArea','distribution','kicking','reactionSpeed','gameIntelligence','mentality','stamina','penalties'];
  else
    return false;
  end if;
  if jsonb_typeof(p) <> 'object' then return false; end if;
  -- keine fremden Schlüssel
  if exists (select 1 from jsonb_object_keys(p) x where x <> all (v_keys)) then return false; end if;
  foreach k in array v_keys loop
    if jsonb_typeof(p -> k) <> 'number' or (p ->> k)::numeric < 1 or (p ->> k)::numeric > 99 then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create table public.player_attributes (
  player_id uuid primary key references public.players(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  kind text not null check (kind in ('outfield', 'goalkeeper')),
  attributes jsonb not null,
  updated_at timestamptz not null default now(),
  constraint player_attributes_valid check (public.valid_attributes(kind, attributes))
);

-- G3/G5/G6: Entwicklungsprotokoll (Verbesserungen in der Saison, Verschlechterungen nur zum Saisonwechsel)
create table public.player_development (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  kind text not null check (kind in ('in_season_improvement', 'season_change_decline', 'season_change_age')),
  overall_before smallint not null,
  overall_after smallint not null,
  attribute_changes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  -- G5: altersbedingte Verschlechterungen dürfen die Gesamtstärke nur zum Saisonwechsel senken
  constraint player_development_direction check (
    (kind = 'in_season_improvement' and overall_after >= overall_before) or kind <> 'in_season_improvement'
  )
);
create index player_development_player_idx on public.player_development(player_id, season_id);

-- H5/H6: Verträge
create table public.player_contracts (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  start_season_year integer not null,
  end_season_year integer not null check (end_season_year >= start_season_year),
  annual_salary bigint not null check (annual_salary > 0),
  age_at_signing smallint not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
-- genau ein aktiver Vertrag je Spieler
create unique index player_contracts_one_active on public.player_contracts(player_id) where active;

-- D3: Snake-Draft
create table public.draft_sessions (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null unique references public.career_worlds(id) on delete cascade,
  status public.draft_status not null default 'pending',
  club_order uuid[] not null, -- zufällige Reihenfolge der menschlichen Vereine (Runde 1)
  picks_per_club smallint not null default 22,
  current_pick integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  constraint draft_sessions_pick_range check (current_pick between 0 and cardinality(club_order) * picks_per_club)
);

create table public.draft_picks (
  id bigint generated always as identity primary key,
  draft_id uuid not null references public.draft_sessions(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  pick_index integer not null,
  club_id uuid not null references public.clubs(id) on delete cascade,
  player_id uuid not null references public.players(id),
  price bigint not null check (price >= 0),
  created_at timestamptz not null default now(),
  -- A3: keine doppelten Picks, kein Spieler zweimal
  unique (draft_id, pick_index),
  unique (draft_id, player_id)
);

-- H1: Transferfenster
create table public.transfer_windows (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  window_no smallint not null check (window_no in (1, 2)),
  next_matchday_from smallint not null,
  next_matchday_to smallint not null,
  unique (season_id, window_no)
);

-- H3: Verhandlungen (unbegrenzt viele)
create table public.transfer_offers (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  window_id uuid not null references public.transfer_windows(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  from_club_id uuid references public.clubs(id) on delete cascade,
  to_club_id uuid not null references public.clubs(id) on delete cascade,
  fee bigint not null default 0 check (fee >= 0),
  annual_salary bigint not null check (annual_salary > 0),
  contract_years smallint not null check (contract_years between 1 and 5),
  status public.offer_status not null default 'pending',
  counter_fee bigint,
  counter_salary bigint,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create index transfer_offers_player_idx on public.transfer_offers(player_id, status);

-- H2: abgeschlossene Wechsel (Grundlage der Limits)
create table public.transfers (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  window_id uuid references public.transfer_windows(id) on delete set null,
  player_id uuid not null references public.players(id) on delete cascade,
  from_club_id uuid references public.clubs(id) on delete set null,
  to_club_id uuid references public.clubs(id) on delete set null,
  kind public.transfer_kind not null,
  fee bigint not null default 0 check (fee >= 0),
  offer_id uuid unique references public.transfer_offers(id),
  created_at timestamptz not null default now()
);
create index transfers_window_to_idx on public.transfers(window_id, to_club_id);
create index transfers_window_from_idx on public.transfers(window_id, from_club_id);

-- H4: Free-Agent-Pool (ein Spieler steht höchstens einmal im Pool)
create table public.free_agents (
  player_id uuid primary key references public.players(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  annual_salary bigint not null check (annual_salary > 0),
  min_club_reputation numeric(5,2) not null default 0,
  listed_at timestamptz not null default now()
);

-- G1: Zusatztraining (max. 5 Spieler je Woche, je Spieler max. 1 Einheit je Woche)
create table public.training_sessions (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  week_no smallint not null,
  player_id uuid not null references public.players(id) on delete cascade,
  focus text not null check (focus in ('offense', 'defense', 'technique', 'physical', 'tactics', 'set_pieces')),
  training_date date not null,
  created_at timestamptz not null default now(),
  unique (player_id, season_id, week_no)
);
create index training_sessions_club_week on public.training_sessions(club_id, season_id, week_no);

-- F10: Verletzungen
create table public.injuries (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  fixture_id uuid, -- FK in Migration 0005
  kind text not null,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  created_at timestamptz not null default now()
);
create index injuries_player_idx on public.injuries(player_id, ends_on);

-- F10/C8.3: Karten und Sperren wettbewerbsgetrennt
create table public.disciplinary_records (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  scope public.discipline_scope not null,
  fixture_id uuid, -- FK in Migration 0005
  card public.card_kind,
  suspension_matches smallint not null default 0 check (suspension_matches >= 0),
  served_matches smallint not null default 0 check (served_matches >= 0),
  created_at timestamptz not null default now(),
  constraint disciplinary_served check (served_matches <= suspension_matches)
);
create index disciplinary_player_scope on public.disciplinary_records(player_id, scope, season_id);
