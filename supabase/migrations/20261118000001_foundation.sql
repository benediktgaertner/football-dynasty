-- =====================================================================
-- Football Dynasty – Migration 0001: Grundlagen
-- Erweiterungen, Aufzählungstypen, Hilfsfunktionen, globale Referenzdaten
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Aufzählungstypen
-- ---------------------------------------------------------------------
create type public.difficulty as enum ('easy', 'medium', 'hard');
create type public.world_status as enum ('lobby', 'draft', 'preseason', 'season', 'season_end');
create type public.member_role as enum ('host', 'manager');
create type public.club_control as enum ('human', 'ai');
create type public.player_position as enum (
  'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'
);
create type public.tactical_profile_name as enum ('offensive', 'neutral', 'defensive');
create type public.competition_kind as enum (
  'league', 'domestic_cup', 'champions_league', 'europa_league', 'relegation', 'abstract_fourth_tier'
);
create type public.european_status as enum (
  'none', 'cl_qualifying', 'champions_league', 'el_qualifying', 'europa_league'
);
create type public.stage_kind as enum (
  'league_round', 'qualifying_1', 'qualifying_2', 'group', 'round_of_64', 'round_of_32',
  'round_of_16', 'quarter_final', 'semi_final', 'final', 'relegation'
);
create type public.fixture_status as enum ('scheduled', 'live', 'finished', 'released', 'cancelled');
create type public.draft_status as enum ('pending', 'running', 'finished');
create type public.transaction_kind as enum (
  'starting_capital', 'stadium_build', 'stadium_expansion', 'draft_purchase', 'transfer_fee_paid',
  'transfer_fee_received', 'salary', 'ticket_income', 'match_bonus', 'placement_prize', 'sponsor',
  'competition_prize', 'stadium_running_cost', 'adjustment'
);
create type public.transfer_kind as enum ('draft', 'transfer', 'free_agent', 'release', 'retirement');
create type public.offer_status as enum ('pending', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired', 'completed');
create type public.card_kind as enum ('yellow', 'second_yellow', 'red');
create type public.discipline_scope as enum ('league', 'domestic_cup', 'uefa');
create type public.region as enum ('europe', 'south_america', 'africa', 'asia', 'north_central_america', 'oceania');

-- ---------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------

-- C7.1: Normalisierung für Namenseindeutigkeit. Muss identisch zu
-- packages/shared/src/naming.ts::normalizeName arbeiten (Paritätstest in supabase/tests).
create or replace function public.normalize_name(p text)
returns text
language sql
stable
set search_path = ''
as $$
  select regexp_replace(lower(extensions.unaccent(coalesce(p, ''))), '[^a-z0-9]', '', 'g');
$$;

-- I3: Stadionbaukosten. Muss identisch zu stadiumBuildCost() in packages/shared arbeiten.
create or replace function public.stadium_build_cost(p_capacity integer)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_capacity is null or p_capacity < 10000 or p_capacity > 50000 or (p_capacity - 10000) % 5000 <> 0 then
    raise exception 'Ungültige Stadionkapazität: %', p_capacity using errcode = '22023', hint = 'invalid_capacity';
  end if;
  return round(p_capacity::numeric * 1000 * power(0.98::numeric, (p_capacity - 10000) / 5000))::bigint;
end;
$$;

-- I1: Startkapital je Schwierigkeitsgrad.
create or replace function public.starting_capital(p_difficulty public.difficulty)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case p_difficulty when 'easy' then 320000000 when 'medium' then 260000000 else 210000000 end::bigint;
$$;

create or replace function public.is_hex_color(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select p is not null and p ~ '^#[0-9a-fA-F]{6}$'; $$;

-- Generischer updated_at-Trigger
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Globale Referenzdaten (für alle Karrierewelten gleich, nur lesbar)
-- ---------------------------------------------------------------------

-- C5: 55 UEFA-Verbände (Startwerte; die Weiterentwicklung erfolgt pro Welt)
create table public.associations (
  code char(3) primary key,
  name text not null,
  naming_profile text not null,
  start_strength numeric(5,2) not null check (start_strength between 0 and 100),
  league_size smallint not null check (league_size between 8 and 24)
);

-- E1: Formationsvorlagen
create table public.formations (
  code text primary key,
  name text not null,
  slots jsonb not null check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) = 11)
);

-- C7.1: Sperrliste realer Profi- und Traditionsvereine (normalisiert)
create table public.club_name_blocklist (
  id bigint generated always as identity primary key,
  association_code char(3) references public.associations(code),
  name_normalized text not null unique
);

-- I7: Sponsorenkatalog je Spielklasse
create table public.sponsor_offers (
  id smallint primary key,
  tier smallint not null check (tier between 1 and 3),
  code text not null,
  name text not null,
  kind text not null check (kind in ('per_league_match', 'per_league_win', 'per_league_point', 'per_league_goal', 'max_goals_against', 'placement_at_most', 'promotion', 'champion')),
  amount bigint not null check (amount > 0),
  threshold integer,
  unique (tier, code)
);

-- C9.3 / I6: Prämientabellen (Vorlage; jede Saison kopiert die gültigen Werte, damit spätere
-- Balancing-Änderungen laufende Saisons nicht rückwirkend verändern)
create table public.prize_templates (
  competition_kind public.competition_kind not null,
  tier smallint not null default 0,
  prize_key text not null,
  amount bigint not null check (amount >= 0),
  primary key (competition_kind, tier, prize_key)
);
