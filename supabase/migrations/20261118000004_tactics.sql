-- =====================================================================
-- Migration 0004: Taktik (E1–E4, F9)
-- Taktikdaten sind privat: nur der eigene Manager (und der Server) darf sie lesen.
-- =====================================================================

-- E4 + Vereinsweite Einstellungen
create table public.tactics (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  active_profile public.tactical_profile_name not null default 'neutral',
  auto_substitutions boolean not null default false,
  auto_switch_enabled boolean not null default false,
  auto_switch_minute smallint check (auto_switch_minute between 1 and 89),
  auto_switch_when_trailing public.tactical_profile_name,
  auto_switch_when_leading public.tactical_profile_name,
  corner_routine text not null default 'far_post' check (corner_routine in ('short', 'near_post', 'far_post', 'penalty_spot')),
  defensive_set_piece text not null default 'mixed' check (defensive_set_piece in ('zonal', 'man', 'mixed')),
  updated_at timestamptz not null default now()
);

-- E1: genau drei Profile mit festen Namen je Verein
create table public.tactical_profiles (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  name public.tactical_profile_name not null,
  formation_code text not null references public.formations(code),
  -- E2: zwölf Grundeinstellungen
  team_instructions jsonb not null,
  -- E2: fortgeschrittene Optionen
  advanced_options jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (club_id, name)
);

-- E1: Startelf und frei verschobene Positionen eines Profils
create table public.tactical_profile_slots (
  profile_id uuid not null references public.tactical_profiles(id) on delete cascade,
  slot_index smallint not null check (slot_index between 0 and 10),
  player_id uuid references public.players(id) on delete set null,
  position public.player_position not null,
  x numeric(5,2) not null check (x between 0 and 100),
  y numeric(5,2) not null check (y between 0 and 100),
  primary key (profile_id, slot_index)
);
create unique index tactical_profile_slots_player on public.tactical_profile_slots(profile_id, player_id) where player_id is not null;

-- E3: individuelle Anweisungen
create table public.player_instructions (
  profile_id uuid not null references public.tactical_profiles(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  instructions text[] not null default '{}',
  primary key (profile_id, player_id)
);

-- F9: Standardschützen inkl. Ersatzschützen (priority 1 = erster Schütze)
create table public.set_piece_assignments (
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  kind text not null check (kind in ('free_kick', 'penalty', 'corner_left', 'corner_right', 'throw_in', 'target_man')),
  priority smallint not null check (priority between 1 and 5),
  player_id uuid not null references public.players(id) on delete cascade,
  primary key (club_id, kind, priority)
);
