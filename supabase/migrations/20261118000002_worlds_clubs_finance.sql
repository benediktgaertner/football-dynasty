-- =====================================================================
-- Migration 0002: Benutzer, Karrierewelten, Vereine, Finanzen
-- =====================================================================

-- A2: Profil zu einem (anonymen oder dauerhaften) Supabase-Auth-Benutzer
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  username_normalized text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- B1: Karrierewelt
create table public.career_worlds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 40),
  invite_code char(6) not null unique check (invite_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  host_user_id uuid not null references public.profiles(id),
  difficulty public.difficulty not null default 'medium',
  status public.world_status not null default 'lobby',
  seed text not null,
  current_season_id uuid,
  current_date_in_world date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger career_worlds_touch before update on public.career_worlds
  for each row execute function public.touch_updated_at();

create table public.world_members (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'manager',
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (world_id, user_id)
);
create index world_members_user_idx on public.world_members(user_id);
-- genau ein Host je Welt
create unique index world_members_one_host on public.world_members(world_id) where role = 'host';

-- C5: Stärkeentwicklung der Verbände je Welt und Saisonjahr
create table public.association_strength_history (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  association_code char(3) not null references public.associations(code),
  season_year integer not null,
  strength numeric(5,2) not null check (strength between 0 and 100),
  primary key (world_id, association_code, season_year)
);

-- Saisons
create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  year integer not null,
  is_generated_history boolean not null default false, -- C8.1: fiktive Vorsaison der Startsaison
  status text not null default 'planned' check (status in ('planned', 'running', 'closing', 'closed')),
  starts_on date,
  ends_on date,
  created_at timestamptz not null default now(),
  unique (world_id, year)
);
alter table public.career_worlds
  add constraint career_worlds_current_season_fk foreign key (current_season_id) references public.seasons(id) on delete set null;

-- Vereine (menschlich oder KI)
create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  association_code char(3) not null references public.associations(code),
  name text not null,
  name_normalized text not null,
  short_name text not null check (short_name ~ '^[A-ZÄÖÜ0-9]{3,4}$'),
  short_name_normalized text not null,
  control public.club_control not null,
  manager_user_id uuid references public.profiles(id) on delete set null,
  founded_year smallint check (founded_year between 1850 and 2100),
  reputation numeric(5,2) not null default 50 check (reputation between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- C7.1: eindeutige Namen und Kurznamen je Welt (normalisiert)
  constraint clubs_name_unique unique (world_id, name_normalized),
  constraint clubs_short_unique unique (world_id, short_name_normalized),
  constraint clubs_human_has_manager check (control = 'ai' or manager_user_id is not null)
);
-- B1: genau ein Verein je menschlichem Manager und Welt
create unique index clubs_one_per_manager on public.clubs(world_id, manager_user_id) where manager_user_id is not null;
create index clubs_world_idx on public.clubs(world_id);
create trigger clubs_touch before update on public.clubs
  for each row execute function public.touch_updated_at();

create or replace function public.clubs_normalize()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  new.name_normalized := public.normalize_name(new.name);
  new.short_name_normalized := public.normalize_name(new.short_name);
  -- C7.1: Die Sperrliste realer Vereine gilt für generierte (KI-)Vereine. Menschliche
  -- Vereinsnamen nehmen nur an der Eindeutigkeitsprüfung teil.
  if new.control = 'ai' and exists (select 1 from public.club_name_blocklist b where b.name_normalized = new.name_normalized) then
    raise exception 'Dieser Vereinsname ist reserviert. Bitte wähle einen fiktiven Namen.'
      using errcode = '23505', hint = 'club_name_blocked';
  end if;
  return new;
end;
$$;
create trigger clubs_normalize_trg before insert or update of name, short_name on public.clubs
  for each row execute function public.clubs_normalize();

-- KI- bzw. menschliche Manageridentität je Verein (K1)
create table public.managers (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null unique references public.clubs(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  display_name text not null,
  ai_profile jsonb, -- Persönlichkeit/Neigungen eines KI-Managers (Risikofreude, Rotation, Jugendfokus …)
  created_at timestamptz not null default now()
);

-- B3, B2.5–7: Branding
create table public.club_branding (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  primary_color text not null check (public.is_hex_color(primary_color)),
  secondary_color text not null check (public.is_hex_color(secondary_color)),
  accent_color text not null check (public.is_hex_color(accent_color)),
  crest jsonb not null,
  kit jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger club_branding_touch before update on public.club_branding
  for each row execute function public.touch_updated_at();

-- I3: Stadion
create table public.stadiums (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  name text not null check (char_length(name) between 3 and 40),
  capacity integer not null check (capacity between 10000 and 50000 and (capacity - 10000) % 5000 = 0),
  ticket_price_league integer not null default 25 check (ticket_price_league between 5 and 500),
  ticket_price_cup integer not null default 20 check (ticket_price_cup between 5 and 500),
  ticket_price_international integer not null default 35 check (ticket_price_international between 5 and 500),
  updated_at timestamptz not null default now()
);
create trigger stadiums_touch before update on public.stadiums
  for each row execute function public.touch_updated_at();

-- I2: Ein Bankkonto je Verein
create table public.finances (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  balance bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- I2: Nachvollziehbare, idempotente Buchungen
create table public.financial_transactions (
  id bigint generated always as identity primary key,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  kind public.transaction_kind not null,
  amount bigint not null check (amount <> 0),
  balance_after bigint not null,
  idempotency_key text not null,
  description text not null,
  created_at timestamptz not null default now(),
  -- A3/N3: Schutz vor doppelten Buchungen (z. B. Prämien)
  constraint financial_transactions_idem unique (world_id, idempotency_key)
);
create index financial_transactions_club_idx on public.financial_transactions(club_id, created_at);

-- Zentrale Buchungsfunktion. Nur serverseitig aufrufbar (kein EXECUTE für anon/authenticated).
-- Gibt die Transaktions-ID zurück; ein zweiter Aufruf mit demselben Schlüssel bucht nicht erneut.
create or replace function public.post_transaction(
  p_club uuid,
  p_kind public.transaction_kind,
  p_amount bigint,
  p_idempotency_key text,
  p_description text,
  p_season uuid default null,
  p_allow_negative boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
  v_balance bigint;
  v_existing bigint;
  v_id bigint;
begin
  select f.world_id, f.balance into v_world, v_balance
  from public.finances f where f.club_id = p_club
  for update;
  if not found then
    raise exception 'Kein Bankkonto für Verein %', p_club using errcode = 'P0002';
  end if;

  select t.id into v_existing from public.financial_transactions t
  where t.world_id = v_world and t.idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if not p_allow_negative and v_balance + p_amount < 0 then
    raise exception 'Nicht genügend Geld auf dem Vereinskonto.' using errcode = 'P0001', hint = 'insufficient_funds';
  end if;

  update public.finances set balance = balance + p_amount, updated_at = now() where club_id = p_club;
  insert into public.financial_transactions(world_id, club_id, season_id, kind, amount, balance_after, idempotency_key, description)
  values (v_world, p_club, p_season, p_kind, p_amount, v_balance + p_amount, p_idempotency_key, p_description)
  returning id into v_id;
  return v_id;
end;
$$;

-- I7: gewählter Sponsorenvertrag je Verein und Saison (genau einer)
create table public.sponsor_contracts (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  sponsor_offer_id smallint not null references public.sponsor_offers(id),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (club_id, season_id)
);

-- B2.10 / B4: Bereitschaft je Kontext (z. B. 'lobby', 'matchday:<fixture-slot-id>')
create table public.multiplayer_readiness (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  context text not null check (char_length(context) between 1 and 80),
  ready boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (world_id, user_id, context)
);
