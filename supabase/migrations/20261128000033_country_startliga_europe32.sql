-- =============================================================================
-- 0033: Länderauswahl, individuelle Startliga, Europapokal-Qualifikation (32 Teams)
-- =============================================================================
-- Bestehende Welten: Deutschland, 2. Liga, Wirtschaftsfaktor 1 → unverändert.

-- 1) Welteinstellungen -----------------------------------------------------------
alter table public.career_worlds add column if not exists country_code char(3) not null default 'GER' references public.associations(code);
alter table public.career_worlds add column if not exists start_tier smallint not null default 2;
alter table public.career_worlds add column if not exists economy_factor numeric(8,4) not null default 1;
alter table public.career_worlds add column if not exists amateur_names text[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'career_worlds_start_tier_check') then
    alter table public.career_worlds add constraint career_worlds_start_tier_check check (start_tier between 1 and 3);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'career_worlds_economy_factor_check') then
    alter table public.career_worlds add constraint career_worlds_economy_factor_check check (economy_factor > 0 and economy_factor <= 5);
  end if;
end $$;
comment on column public.career_worlds.country_code is 'Spielland: drei Ligen à 18 Vereine mit Spielbetrieb';
comment on column public.career_worlds.start_tier is 'Startliga aller menschlichen Manager (1–3)';
comment on column public.career_worlds.economy_factor is 'Wirtschaftsniveau des Spiellands (Deutschland = 1): Prämien, Sponsoren, Zuschauer';

-- Landestypische Liga- und Pokalnamen (Quelle: packages/shared/src/world/country.ts)
create table if not exists public.country_league_names (
  code char(3) primary key references public.associations(code),
  tier1 text not null, tier2 text not null, tier3 text not null, cup text not null
);
alter table public.country_league_names enable row level security;
drop policy if exists read_country_league_names on public.country_league_names;
create policy read_country_league_names on public.country_league_names for select to authenticated using (true);
grant select on public.country_league_names to authenticated;

-- Europapokal: Grund der Qualifikation je Teilnehmer (Transparenz und Tests)
create table if not exists public.ec_qualifications (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  competition text not null check (competition in ('cl', 'el')),
  reason text not null,
  association_code char(3) not null,
  association_rank smallint,
  primary key (season_id, club_id)
);
create index if not exists ec_qualifications_world_idx on public.ec_qualifications(world_id, season_id);
alter table public.ec_qualifications enable row level security;
drop policy if exists read_ec_qualifications on public.ec_qualifications;
create policy read_ec_qualifications on public.ec_qualifications for select to authenticated
  using (world_id = any ((select public.fd_my_world_ids())::uuid[]));
grant select on public.ec_qualifications to authenticated;

-- 2) Skalierung (Spiegel von country.ts) ------------------------------------------
create or replace function public.fd_country_transform(p_strength numeric, p_target numeric)
returns numeric language sql immutable set search_path = '' as $$
  select 85 + 0.345 * (p_strength - 92) - (85 - p_target) * least(1, 0.6 + 0.4 * p_strength / 92);
$$;

create or replace function public.fd_country_shift(p_code text, p_tier integer)
returns numeric language sql stable set search_path = '' as $$
  select round(public.fd_country_transform(a.start_strength, case p_tier when 1 then 80 when 2 then 74 else 68.5 end) - 74, 1)
  from public.associations a where a.code = p_code;
$$;

create or replace function public.fd_capital_factor(p_code text, p_tier integer)
returns numeric language sql stable set search_path = '' as $$
  select case when p_code = 'GER' and p_tier = 2 then 1::numeric
              else round(least(4, greatest(0.03, exp(0.2 * public.fd_country_shift(p_code, p_tier)))), 4) end;
$$;

create or replace function public.fd_economy_factor_for(p_code text)
returns numeric language sql stable set search_path = '' as $$
  select case when p_code = 'GER' then 1::numeric
              else round(least(1.3, greatest(0.05, exp(0.2 * (public.fd_country_transform(a.start_strength, 80) - 80)))), 4) end
  from public.associations a where a.code = p_code;
$$;

create or replace function public.fd_draft_pool_max(p_code text, p_tier integer)
returns integer language sql stable set search_path = '' as $$
  select least(92, 83 + greatest(0, round(public.fd_country_shift(p_code, p_tier))))::integer;
$$;

create or replace function public.fd_world_country(p_world uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce((select w.country_code::text from public.career_worlds w where w.id = p_world), 'GER');
$$;

create or replace function public.fd_world_economy(p_world uuid)
returns numeric language sql stable set search_path = '' as $$
  select coalesce((select w.economy_factor from public.career_worlds w where w.id = p_world), 1);
$$;

-- Betrag × Wirtschaftsfaktor (Faktor 1: unverändert)
create or replace function public.fd_scaled(p_amount bigint, p_factor numeric)
returns bigint language sql immutable set search_path = '' as $$
  select case when p_amount is null then null when p_factor = 1 then p_amount else round(p_amount * p_factor)::bigint end;
$$;

create or replace function public.fd_league_name(p_code text, p_tier integer)
returns text language sql stable set search_path = '' as $$
  select coalesce((select case p_tier when 1 then n.tier1 when 2 then n.tier2 else n.tier3 end from public.country_league_names n where n.code = p_code),
                  case p_tier when 1 then 'Bundesliga' when 2 then '2. Bundesliga' else '3. Liga' end);
$$;

create or replace function public.fd_cup_name(p_code text)
returns text language sql stable set search_path = '' as $$
  select coalesce((select n.cup from public.country_league_names n where n.code = p_code), 'DFB-Pokal');
$$;

-- Aktive Länder: das Spielland der Welt
create or replace function public.fd_active_assocs(p_world uuid)
returns text[] language sql stable set search_path = '' as $$
  select array[public.fd_world_country(p_world)];
$$;

revoke execute on function public.fd_country_transform(numeric, numeric) from public, anon;
revoke execute on function public.fd_country_shift(text, integer) from public, anon;
revoke execute on function public.fd_capital_factor(text, integer) from public, anon;
revoke execute on function public.fd_economy_factor_for(text) from public, anon;
revoke execute on function public.fd_draft_pool_max(text, integer) from public, anon;
revoke execute on function public.fd_world_country(uuid) from public, anon;
revoke execute on function public.fd_world_economy(uuid) from public, anon;
revoke execute on function public.fd_scaled(bigint, numeric) from public, anon;
revoke execute on function public.fd_league_name(text, integer) from public, anon;
revoke execute on function public.fd_cup_name(text) from public, anon;

-- 3) Welt anlegen: Land und Startliga --------------------------------------------
drop function if exists public.create_world(text, public.difficulty);
create or replace function public.create_world(p_name text, p_difficulty public.difficulty default 'medium',
                                               p_country text default 'GER', p_start_tier integer default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.fd_require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_country text := upper(btrim(coalesce(p_country, 'GER')));
  v_world uuid;
  v_code text;
  v_try integer := 0;
begin
  if char_length(v_name) < 3 or char_length(v_name) > 40 then
    raise exception 'Name der Karrierewelt: 3–40 Zeichen.' using errcode = '22023', hint = 'invalid_world_name';
  end if;
  if not exists (select 1 from public.associations where code = v_country) then
    raise exception 'Unbekanntes Land.' using errcode = '22023', hint = 'invalid_country';
  end if;
  if p_start_tier is null or p_start_tier not between 1 and 3 then
    raise exception 'Startliga: 1., 2. oder 3. Liga.' using errcode = '22023', hint = 'invalid_start_tier';
  end if;
  -- Missbrauchsschutz: höchstens 5 offene Lobbys je Host
  if (select count(*) from public.career_worlds w where w.host_user_id = v_user and w.status = 'lobby') >= 5 then
    raise exception 'Du hast bereits fünf offene Lobbys.' using errcode = 'P0001', hint = 'too_many_lobbies';
  end if;

  loop
    v_try := v_try + 1;
    v_code := public.fd_generate_invite_code();
    begin
      insert into public.career_worlds(name, invite_code, host_user_id, difficulty, seed, country_code, start_tier)
      values (v_name, v_code, v_user, coalesce(p_difficulty, 'medium'), encode(extensions.gen_random_bytes(16), 'hex'), v_country, p_start_tier)
      returning id into v_world;
      exit;
    exception when unique_violation then
      if v_try >= 20 then raise; end if;
    end;
  end loop;

  insert into public.world_members(world_id, user_id, role) values (v_world, v_user, 'host');
  return jsonb_build_object('world_id', v_world, 'invite_code', v_code);
end;
$$;
revoke execute on function public.create_world(text, public.difficulty, text, integer) from public, anon;
grant execute on function public.create_world(text, public.difficulty, text, integer) to authenticated;

-- Host ändert Land/Startliga in der Lobby (alle müssen danach erneut bestätigen)
create or replace function public.set_world_setup(p_world uuid, p_country text, p_start_tier integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_country text := upper(btrim(coalesce(p_country, '')));
begin
  if v_member.role <> 'host' then
    raise exception 'Nur der Host legt Land und Startliga fest.' using errcode = '42501', hint = 'host_only';
  end if;
  select * into v_world from public.career_worlds where id = p_world for update;
  if v_world.status <> 'lobby' then
    raise exception 'Land und Startliga sind nach dem Draft-Start fest.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;
  if not exists (select 1 from public.associations where code = v_country) then
    raise exception 'Unbekanntes Land.' using errcode = '22023', hint = 'invalid_country';
  end if;
  if p_start_tier is null or p_start_tier not between 1 and 3 then
    raise exception 'Startliga: 1., 2. oder 3. Liga.' using errcode = '22023', hint = 'invalid_start_tier';
  end if;
  if v_world.country_code::text = v_country and v_world.start_tier = p_start_tier then return; end if;
  update public.career_worlds set country_code = v_country, start_tier = p_start_tier where id = p_world;
  -- gegründete Vereine wechseln mit ins neue Land
  update public.clubs set association_code = v_country where world_id = p_world and control = 'human';
  update public.multiplayer_readiness set ready = false, updated_at = now() where world_id = p_world and context = 'lobby';
end;
$$;
revoke execute on function public.set_world_setup(uuid, text, integer) from public, anon;
grant execute on function public.set_world_setup(uuid, text, integer) to authenticated;
CREATE OR REPLACE FUNCTION public.lobby_state(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_members jsonb;
  v_all_ready boolean;
begin
  select * into v_world from public.career_worlds where id = p_world;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'username', p.username,
      'role', m.role,
      'last_seen_at', m.last_seen_at,
      'ready', coalesce(r.ready, false),
      'club', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'name', c.name, 'short_name', c.short_name,
        'primary_color', b.primary_color, 'secondary_color', b.secondary_color, 'accent_color', b.accent_color,
        'crest', b.crest, 'kit', b.kit,
        'stadium_name', s.name, 'stadium_capacity', s.capacity,
        'stadium_cost', public.fd_scaled(public.stadium_build_cost(s.capacity), least(1, public.fd_capital_factor(v_world.country_code, v_world.start_tier)))
      ) end
    ) order by m.joined_at), '[]'::jsonb),
    bool_and(coalesce(r.ready, false) and c.id is not null)
  into v_members, v_all_ready
  from public.world_members m
  join public.profiles p on p.id = m.user_id
  left join public.multiplayer_readiness r on r.world_id = m.world_id and r.user_id = m.user_id and r.context = 'lobby'
  left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
  left join public.club_branding b on b.club_id = c.id
  left join public.stadiums s on s.club_id = c.id
  where m.world_id = p_world;

  return jsonb_build_object(
    'world', jsonb_build_object(
      'id', v_world.id, 'name', v_world.name, 'invite_code', v_world.invite_code, 'status', v_world.status,
      'difficulty', v_world.difficulty, 'host_user_id', v_world.host_user_id,
      'starting_capital', public.fd_scaled(public.starting_capital(v_world.difficulty), public.fd_capital_factor(v_world.country_code, v_world.start_tier)),
      'country_code', v_world.country_code, 'start_tier', v_world.start_tier,
      'country_name', (select a.name from public.associations a where a.code = v_world.country_code),
      'league_names', (select jsonb_build_object('1', n.tier1, '2', n.tier2, '3', n.tier3, 'cup', n.cup) from public.country_league_names n where n.code = v_world.country_code),
      'capital_factor', public.fd_capital_factor(v_world.country_code, v_world.start_tier),
      'economy_factor', public.fd_economy_factor_for(v_world.country_code)
    ),
    'me', jsonb_build_object('user_id', v_member.user_id, 'role', v_member.role),
    'members', v_members,
    'all_ready', coalesce(v_all_ready, false)
  );
end;
$function$
;


CREATE OR REPLACE FUNCTION public.admin_draft_context(p_world uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when w.id is null then null else jsonb_build_object(
    'id', w.id,
    'seed', w.seed,
    'status', w.status,
    'host_user_id', w.host_user_id,
    'country', w.country_code,
    'start_tier', w.start_tier,
    'humans', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name) order by c.created_at)
      from public.clubs c where c.world_id = w.id and c.control = 'human'
    ), '[]'::jsonb)
  ) end
  from (select 1) one
  left join public.career_worlds w on w.id = p_world;
$function$
;


CREATE OR REPLACE FUNCTION public.admin_europe_status(p_world uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'seed', w.seed,
    'status', w.status,
    'country', w.country_code,
    'clubs', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'short_name', c.short_name)) from public.clubs c where c.world_id = w.id), '[]'::jsonb),
    'done', coalesce((select jsonb_agg(distinct c.association_code) from public.clubs c where c.world_id = w.id and c.association_code <> w.country_code), '[]'::jsonb)
  )
  from public.career_worlds w where w.id = p_world;
$function$
;


CREATE OR REPLACE FUNCTION public.europe_market_status(p_world uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when not public.is_world_member(p_world) then null else jsonb_build_object(
    'associations', (select count(distinct c.association_code) from public.clubs c where c.world_id = p_world and c.association_code <> public.fd_world_country(p_world)),
    'total', (select count(*) from public.associations a where a.code <> public.fd_world_country(p_world)),
    'world_status', (select w.status from public.career_worlds w where w.id = p_world)
  ) end;
$function$
;


CREATE OR REPLACE FUNCTION public.admin_add_europe(p_world uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_code text := p_payload ->> 'association_code';
  v_year integer;
  r record;
  v_clubs integer;
  v_players integer;
  v_name text;
  v_short text;
  v_try integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if not found then raise exception 'Welt nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_code is null or v_code = v_world.country_code::text or not exists (select 1 from public.associations where code = v_code) then
    raise exception 'Ungültiger Verband.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  -- idempotent: ein Verband wird nur einmal angelegt
  if exists (select 1 from public.clubs where world_id = p_world and association_code = v_code) then
    return jsonb_build_object('status', 'exists', 'association', v_code);
  end if;
  v_year := coalesce(public.fd_season_year(v_world.current_season_id), extract(year from now())::int);

  create temp table if not exists fd_tmp_eu_clubs (key text primary key, id uuid not null) on commit drop;
  delete from fd_tmp_eu_clubs where true;
  insert into fd_tmp_eu_clubs(key, id) select c ->> 'key', gen_random_uuid() from jsonb_array_elements(p_payload -> 'clubs') c;

  -- Vereine einzeln anlegen: bei gleichzeitigen Aufrufen (zwei Manager) Konflikte bei Name/Kürzel auflösen
  for r in select m.id, c from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key' loop
    v_name := r.c ->> 'name';
    v_short := r.c ->> 'short_name';
    if exists (select 1 from public.clubs where world_id = p_world and name_normalized = public.normalize_name(v_name)) then
      v_name := left(v_name, 27) || ' ' || v_code;
    end if;
    v_try := 0;
    while exists (select 1 from public.clubs where world_id = p_world and short_name_normalized = public.normalize_name(v_short)) and v_try < 200 loop
      v_try := v_try + 1;
      v_short := left(regexp_replace(upper(r.c ->> 'short_name'), '[^A-ZÄÖÜ]', '', 'g') || 'XX', 2) || lpad(((v_try * 37 + length(v_code)) % 90 + 10)::text, 2, '0');
    end loop;
    insert into public.clubs(id, world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, founded_year, reputation, level, league_name)
    values (r.id, p_world, v_code, v_name, '', v_short, '', 'ai', (r.c ->> 'founded_year')::smallint,
            least(100, greatest(0, (r.c ->> 'reputation')::numeric)), (r.c ->> 'level')::smallint, r.c ->> 'league_name');
  end loop;

  insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
  select m.id, p_world, c ->> 'primary', c ->> 'secondary', c ->> 'accent', c -> 'crest', c -> 'kit'
  from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key';

  insert into public.stadiums(club_id, world_id, name, capacity)
  select m.id, p_world, c ->> 'stadium_name', (c ->> 'capacity')::integer
  from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key';

  insert into public.finances(club_id, world_id, balance) select id, p_world, 0 from fd_tmp_eu_clubs;
  for r in select m.id, (c ->> 'balance')::bigint as balance
           from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key' loop
    perform public.post_transaction(r.id, 'starting_capital', r.balance, 'start:' || r.id, 'Startkapital', v_world.current_season_id);
  end loop;

  create temp table if not exists fd_tmp_eu_players (
    id uuid primary key, club_id uuid, first text, last text, nat text, region text, age smallint, pos text,
    sec jsonb, overall smallint, potential smallint, value bigint, salary bigint, pref_shirt smallint,
    kind text, attrs jsonb, contract_years smallint, shirt smallint
  ) on commit drop;
  delete from fd_tmp_eu_players where true;
  insert into fd_tmp_eu_players
  select gen_random_uuid(), m.id, p ->> 'first', p ->> 'last', p ->> 'nat', p ->> 'region', (p ->> 'age')::smallint, p ->> 'pos',
         p -> 'sec', (p ->> 'overall')::smallint, (p ->> 'potential')::smallint, (p ->> 'value')::bigint, (p ->> 'salary')::bigint,
         (p ->> 'prefShirt')::smallint, p ->> 'kind', p -> 'attrs', nullif(p ->> 'contract_years', '')::smallint, nullif(p ->> 'shirt', '')::smallint
  from jsonb_array_elements(p_payload -> 'players') p
  left join fd_tmp_eu_clubs m on m.key = p ->> 'club_key';
  if exists (select 1 from fd_tmp_eu_players where club_id is not null and (contract_years is null or contract_years not between 1 and 5))
     or exists (select 1 from fd_tmp_eu_players t where t.club_id is null and (t.contract_years is not null or t.shirt is not null)) then
    raise exception 'Ungültige Spielerdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  insert into public.players(id, world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                             overall, fitness, market_value, shirt_number, preferred_shirt_number, club_id, in_draft_pool)
  select t.id, p_world, t.first, t.last, t.nat, t.region::public.region, t.age, t.pos::public.player_position,
         coalesce(array(select jsonb_array_elements_text(t.sec))::public.player_position[], '{}'),
         t.overall, 100, t.value, t.shirt, t.pref_shirt, t.club_id, false
  from fd_tmp_eu_players t;
  insert into public.player_attributes(player_id, world_id, kind, attributes) select id, p_world, kind, attrs from fd_tmp_eu_players;
  insert into public.player_hidden(player_id, world_id, potential) select id, p_world, greatest(potential, overall) from fd_tmp_eu_players;
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, id, club_id, v_year, v_year + contract_years - 1, salary, age from fd_tmp_eu_players where club_id is not null;
  insert into public.free_agents(player_id, world_id, annual_salary) select id, p_world, salary from fd_tmp_eu_players where club_id is null;

  select count(*) into v_clubs from fd_tmp_eu_clubs;
  select count(*) into v_players from fd_tmp_eu_players;
  return jsonb_build_object('status', 'created', 'association', v_code, 'clubs', v_clubs, 'players', v_players);
end;
$function$
;


CREATE OR REPLACE FUNCTION public.upsert_my_club(p_world uuid, p_club jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
  v_name text := btrim(coalesce(p_club ->> 'name', ''));
  v_short text := btrim(coalesce(p_club ->> 'shortName', ''));
  v_primary text := p_club ->> 'primaryColor';
  v_secondary text := p_club ->> 'secondaryColor';
  v_accent text := p_club ->> 'accentColor';
  v_crest jsonb := p_club -> 'crest';
  v_kit jsonb := p_club -> 'kit';
  v_stadium_name text := btrim(coalesce(p_club ->> 'stadiumName', ''));
  v_capacity integer;
  v_club uuid;
  v_username text;
  v_constraint text;
  v_profile public.tactical_profile_name;
  v_profile_id uuid;
begin
  select status into v_status from public.career_worlds where id = p_world for update;
  if v_status <> 'lobby' then
    raise exception 'Vereine können nur vor dem Draft gegründet oder geändert werden.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;

  if p_club is null or jsonb_typeof(p_club) <> 'object' then
    raise exception 'Vereinsdaten fehlen.' using errcode = '22023', hint = 'invalid_club';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 32 or v_name !~ '^[[:alnum:] .''&-]+$' then
    raise exception 'Vereinsname: 3–32 Zeichen, Buchstaben, Ziffern, Leerzeichen und . '' & -' using errcode = '22023', hint = 'invalid_club_name';
  end if;
  if v_short !~ '^[A-ZÄÖÜ0-9]{3,4}$' then
    raise exception 'Kurzname: 3–4 Großbuchstaben oder Ziffern.' using errcode = '22023', hint = 'invalid_short_name';
  end if;
  if not (public.is_hex_color(v_primary) and public.is_hex_color(v_secondary) and public.is_hex_color(v_accent)) then
    raise exception 'Ungültige Vereinsfarben.' using errcode = '22023', hint = 'invalid_colors';
  end if;
  if not public.fd_valid_crest(v_crest) then
    raise exception 'Ungültiges Wappen.' using errcode = '22023', hint = 'invalid_crest';
  end if;
  if not public.fd_valid_kit(v_kit) then
    raise exception 'Ungültiges Trikotdesign.' using errcode = '22023', hint = 'invalid_kit';
  end if;
  if char_length(v_stadium_name) < 3 or char_length(v_stadium_name) > 40 or v_stadium_name !~ '^[[:alnum:] .''&-]+$' then
    raise exception 'Stadionname: 3–40 Zeichen.' using errcode = '22023', hint = 'invalid_stadium_name';
  end if;
  if jsonb_typeof(p_club -> 'stadiumCapacity') <> 'number' or (p_club ->> 'stadiumCapacity') !~ '^[0-9]+$' then
    raise exception 'Ungültige Stadiongröße.' using errcode = '22023', hint = 'invalid_capacity';
  end if;
  v_capacity := (p_club ->> 'stadiumCapacity')::integer;
  perform public.stadium_build_cost(v_capacity); -- prüft 10.000–50.000 in 5.000er-Schritten

  select username into v_username from public.profiles where id = v_member.user_id;

  begin
    select id into v_club from public.clubs c where c.world_id = p_world and c.manager_user_id = v_member.user_id for update;
    if v_club is null then
      insert into public.clubs(world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, manager_user_id, founded_year)
      values (p_world, public.fd_world_country(p_world), v_name, '', v_short, '', 'human', v_member.user_id,
              case when jsonb_typeof(v_crest -> 'foundedYear') = 'number' then (v_crest ->> 'foundedYear')::smallint end)
      returning id into v_club;

      insert into public.managers(world_id, club_id, user_id, display_name) values (p_world, v_club, v_member.user_id, v_username);
      insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
      values (v_club, p_world, v_primary, v_secondary, v_accent, v_crest, v_kit);
      insert into public.stadiums(club_id, world_id, name, capacity) values (v_club, p_world, v_stadium_name, v_capacity);
      -- I2: Bankkonto. Startkapital und Stadionkosten werden beim Draft-Start gebucht (I3),
      -- weil der Host den Schwierigkeitsgrad bis dahin noch ändern darf.
      insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 0);
      insert into public.tactics(club_id, world_id) values (v_club, p_world);
      -- E1: genau drei Taktikprofile mit festen Namen
      foreach v_profile in array array['offensive', 'neutral', 'defensive']::public.tactical_profile_name[] loop
        insert into public.tactical_profiles(world_id, club_id, name, formation_code, team_instructions)
        values (p_world, v_club, v_profile, '4-4-2', public.fd_default_team_instructions(v_profile))
        returning id into v_profile_id;
        insert into public.tactical_profile_slots(profile_id, slot_index, position, x, y)
        select v_profile_id, (s ->> 'index')::smallint, (s ->> 'position')::public.player_position, (s ->> 'x')::numeric, (s ->> 'y')::numeric
        from public.formations f, jsonb_array_elements(f.slots) s
        where f.code = '4-4-2';
      end loop;
    else
      update public.clubs set name = v_name, short_name = v_short,
        founded_year = case when jsonb_typeof(v_crest -> 'foundedYear') = 'number' then (v_crest ->> 'foundedYear')::smallint end
      where id = v_club;
      update public.club_branding set primary_color = v_primary, secondary_color = v_secondary, accent_color = v_accent,
        crest = v_crest, kit = v_kit
      where club_id = v_club;
      update public.stadiums set name = v_stadium_name, capacity = v_capacity where club_id = v_club;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'clubs_name_unique' then
      raise exception 'Dieser Vereinsname ist in dieser Karrierewelt bereits vergeben.' using errcode = '23505', hint = 'club_name_taken';
    elsif v_constraint = 'clubs_short_unique' then
      raise exception 'Dieser Kurzname ist bereits vergeben.' using errcode = '23505', hint = 'short_name_taken';
    elsif v_constraint is null or v_constraint = '' then
      raise exception 'Dieser Vereinsname ist reserviert. Bitte wähle einen fiktiven Namen.' using errcode = '23505', hint = 'club_name_blocked';
    else
      raise;
    end if;
  end;

  -- Änderungen heben die eigene Bereitschaft auf
  update public.multiplayer_readiness set ready = false, updated_at = now()
  where world_id = p_world and user_id = v_member.user_id and context = 'lobby';
  return v_club;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.admin_start_draft(p_world uuid, p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_humans integer;
  v_season uuid;
  v_year integer := extract(year from now())::integer;
  v_comp uuid[] := array[]::uuid[];
  v_comp_id uuid;
  v_tier integer;
  v_capital bigint;
  v_order uuid[];
  v_draft uuid;
  r record;
  v_count integer;
  v_cc text;
  v_st integer;
  v_k numeric;
  v_pool_max integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if not found then
    raise exception 'Karrierewelt nicht gefunden.' using errcode = 'P0002', hint = 'world_not_found';
  end if;
  if v_world.status <> 'lobby' then
    -- idempotent: ein zweiter Klick startet nichts neu
    return jsonb_build_object('already_started', true, 'status', v_world.status);
  end if;
  if v_world.host_user_id <> p_user then
    raise exception 'Nur der Host darf den Draft starten.' using errcode = '42501', hint = 'host_only';
  end if;
  if exists (
    select 1 from public.world_members m
    left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
    left join public.multiplayer_readiness rd on rd.world_id = m.world_id and rd.user_id = m.user_id and rd.context = 'lobby'
    where m.world_id = p_world and (c.id is null or not coalesce(rd.ready, false))
  ) then
    raise exception 'Noch nicht alle Manager haben ihren Verein gegründet und Bereitschaft bestätigt.' using errcode = 'P0001', hint = 'not_all_ready';
  end if;

  select count(*) into v_humans from public.clubs where world_id = p_world and control = 'human';
  v_cc := v_world.country_code::text;
  v_st := v_world.start_tier;
  v_k := public.fd_capital_factor(v_cc, v_st);
  v_pool_max := public.fd_draft_pool_max(v_cc, v_st) + (case when v_cc = 'GER' and v_st = 2 then 0 else 1 end); -- +1: Rundungstoleranz TS/SQL
  -- Payload muss zum Spielland und zur Startliga der Welt passen (ältere Payloads: Deutschland, 2. Liga)
  if coalesce(p_payload ->> 'country', 'GER') <> v_cc or coalesce((p_payload ->> 'start_tier')::int, 2) <> v_st then
    raise exception 'Initialisierungsdaten passen nicht zu Land/Startliga der Welt.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  -- Payload prüfen (der Server vertraut auch der eigenen Function nicht blind)
  if p_payload is null or (p_payload ->> 'version') is distinct from '1' then
    raise exception 'Ungültige Initialisierungsdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if jsonb_array_length(p_payload -> 'ai_clubs') <> 54 - v_humans
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 1) <> 18 - (case when v_st = 1 then v_humans else 0 end)
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 2) <> 18 - (case when v_st = 2 then v_humans else 0 end)
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 3) <> 18 - (case when v_st = 3 then v_humans else 0 end) then
    raise exception 'Ungültige Vereinsverteilung im Payload.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload -> 'players') p where p -> 'club_key' = 'null'::jsonb) <> 400
     or exists (select 1 from jsonb_array_elements(p_payload -> 'players') p
                where p -> 'club_key' = 'null'::jsonb and (p ->> 'overall')::int > v_pool_max) then
    raise exception 'Der Draft-Pool muss aus genau 400 Spielern mit zulässiger Startstärke bestehen.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload -> 'ai_clubs') c
             where not public.fd_valid_crest(c -> 'crest') or not public.fd_valid_kit(c -> 'kit')
                or not public.is_hex_color(c ->> 'primary') or not public.is_hex_color(c ->> 'secondary') or not public.is_hex_color(c ->> 'accent')) then
    raise exception 'Ungültiges Branding im Payload.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  -- Saison und die drei Ligen (C1)
  insert into public.seasons(world_id, year, status) values (p_world, v_year, 'planned') returning id into v_season;
  for v_tier in 1..3 loop
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_season, 'league', v_cc, v_tier, public.fd_league_name(v_cc, v_tier))
    returning id into v_comp_id;
    v_comp := v_comp || v_comp_id;
  end loop;

  -- KI-Vereine (IDs vorab, damit Spieler über club_key zugeordnet werden können)
  create temp table if not exists fd_tmp_club_map (key text primary key, id uuid not null, tier smallint not null) on commit drop;
  truncate fd_tmp_club_map;
  insert into fd_tmp_club_map(key, id, tier)
  select c ->> 'key', gen_random_uuid(), (c ->> 'tier')::smallint from jsonb_array_elements(p_payload -> 'ai_clubs') c;

  insert into public.clubs(id, world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, founded_year, reputation)
  select m.id, p_world, v_cc, c ->> 'name', '', c ->> 'short_name', '', 'ai', (c ->> 'founded_year')::smallint,
         least(100, greatest(0, (c ->> 'reputation')::numeric))
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
  select m.id, p_world, c ->> 'primary', c ->> 'secondary', c ->> 'accent', c -> 'crest', c -> 'kit'
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.stadiums(club_id, world_id, name, capacity)
  select m.id, p_world, c ->> 'stadium_name', (c ->> 'capacity')::integer
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.managers(world_id, club_id, display_name, ai_profile)
  select p_world, m.id, c ->> 'manager_name', c -> 'ai_profile'
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.finances(club_id, world_id, balance) select id, p_world, 0 from fd_tmp_club_map;

  for r in select m.id, (c ->> 'balance')::bigint as balance, c -> 'ai_profile' ->> 'preferred_formation' as formation
           from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key' loop
    perform public.post_transaction(r.id, 'starting_capital', r.balance, 'start:' || r.id, 'Startkapital', v_season);
    perform public.fd_init_club_tactics(p_world, r.id, r.formation);
  end loop;

  -- Ligazugehörigkeit: KI nach Payload, Menschen in die gewählte Startliga
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[m.tier], m.id, p_world from fd_tmp_club_map m;
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[v_st], c.id, p_world from public.clubs c where c.world_id = p_world and c.control = 'human';
  update public.clubs set association_code = v_cc where world_id = p_world and control = 'human' and association_code <> v_cc;

  -- Spieler (KI-Kader und Draft-Pool)
  create temp table if not exists fd_tmp_players (
    id uuid primary key, club_id uuid, first text, last text, nat text, region text, age smallint, pos text,
    sec jsonb, overall smallint, potential smallint, value bigint, salary bigint, pref_shirt smallint,
    kind text, attrs jsonb, contract_years smallint, shirt smallint
  ) on commit drop;
  truncate fd_tmp_players;
  insert into fd_tmp_players
  select gen_random_uuid(), m.id, p ->> 'first', p ->> 'last', p ->> 'nat', p ->> 'region', (p ->> 'age')::smallint, p ->> 'pos',
         p -> 'sec', (p ->> 'overall')::smallint, (p ->> 'potential')::smallint, (p ->> 'value')::bigint, (p ->> 'salary')::bigint,
         (p ->> 'prefShirt')::smallint, p ->> 'kind', p -> 'attrs', nullif(p ->> 'contract_years', '')::smallint, nullif(p ->> 'shirt', '')::smallint
  from jsonb_array_elements(p_payload -> 'players') p
  left join fd_tmp_club_map m on m.key = p ->> 'club_key';

  if exists (select 1 from fd_tmp_players where club_id is null and (contract_years is not null or shirt is not null))
     or exists (select 1 from fd_tmp_players where club_id is not null and (contract_years is null or contract_years not between 1 and 5)) then
    raise exception 'Ungültige Spielerdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  insert into public.players(id, world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                             overall, fitness, market_value, shirt_number, preferred_shirt_number, club_id, in_draft_pool)
  select t.id, p_world, t.first, t.last, t.nat, t.region::public.region, t.age, t.pos::public.player_position,
         coalesce(array(select jsonb_array_elements_text(t.sec))::public.player_position[], '{}'),
         t.overall, 100, t.value, t.shirt, t.pref_shirt, t.club_id, t.club_id is null
  from fd_tmp_players t;

  insert into public.player_attributes(player_id, world_id, kind, attributes)
  select id, p_world, kind, attrs from fd_tmp_players;

  insert into public.player_hidden(player_id, world_id, potential)
  select id, p_world, greatest(potential, overall) from fd_tmp_players;

  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, id, club_id, v_year, v_year + contract_years - 1, salary, age from fd_tmp_players where club_id is not null;

  -- D1/H4: Der Pool steht zugleich als Free-Agent-Markt bereit; Gehalt nach H5 (Alter bei Vertragsabschluss)
  insert into public.free_agents(player_id, world_id, annual_salary)
  select id, p_world, salary from fd_tmp_players where club_id is null;

  -- I1/I3: Startkapital und Stadionkosten der menschlichen Vereine vor dem Draft buchen
  -- Startkapital und Stadionbau nach Startliga und Landesstärke (Deutschland, 2. Liga: Faktor 1)
  v_capital := public.fd_scaled(public.starting_capital(v_world.difficulty), v_k);
  for r in select c.id, s.capacity from public.clubs c join public.stadiums s on s.club_id = c.id
           where c.world_id = p_world and c.control = 'human' loop
    perform public.post_transaction(r.id, 'starting_capital', v_capital, 'start:' || r.id,
      'Startkapital (' || v_world.difficulty || ')', v_season);
    perform public.post_transaction(r.id, 'stadium_build', -public.fd_scaled(public.stadium_build_cost(r.capacity), least(1, v_k)), 'stadium_build:' || r.id,
      'Stadionbau (' || r.capacity || ' Plätze)', v_season);
  end loop;

  -- D3: zufällige Draftreihenfolge der menschlichen Vereine
  select array_agg(id order by gen_random_uuid()) into v_order
  from public.clubs where world_id = p_world and control = 'human';
  insert into public.draft_sessions(world_id, status, club_order, picks_per_club, current_pick, started_at)
  values (p_world, 'running', v_order, 22, 0, now())
  returning id into v_draft;

  update public.career_worlds set status = 'draft', current_season_id = v_season,
    economy_factor = public.fd_economy_factor_for(v_cc),
    amateur_names = case when jsonb_typeof(p_payload -> 'amateur_names') = 'array'
                         then (select array_agg(left(x, 32)) from jsonb_array_elements_text(p_payload -> 'amateur_names') x) end
  where id = p_world;

  select count(*) into v_count from fd_tmp_players;
  return jsonb_build_object('draft_id', v_draft, 'season_id', v_season, 'ai_clubs', 54 - v_humans, 'players', v_count);
end;
$function$
;


CREATE OR REPLACE FUNCTION public.fd_ensure_amateurs(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  v_ger uuid[];
  v_first text[];
  v_last text[];
  v_cc text;
  v_str numeric;
begin
  select * into v_world from public.career_worlds where id = p_world;
  v_cc := v_world.country_code::text;
  v_str := (select start_strength from public.associations where code = v_cc);
  if (select count(*) from public.clubs where world_id = p_world and amateur) >= 10 then return; end if;
  -- Quellen einmalig: deutsche Vereine und Namenslisten (nicht der ganze europäische Pool)
  select array_agg(id) into v_ger from public.clubs where world_id = p_world and association_code = v_cc and not amateur;
  select array_agg(first_name order by id), array_agg(last_name order by md5(id::text)) into v_first, v_last
  from public.players where world_id = p_world and club_id = any(v_ger);
  create temp table if not exists fd_tmp_ama_src (src_id uuid, rn integer, is_gk boolean) on commit drop;
  v_need := 10 - (select count(*) from public.clubs where world_id = p_world and amateur);
  v_i := 0;
  while v_need > 0 and v_i < 200 loop
    v_i := v_i + 1;
    if v_world.amateur_names is not null and v_i <= coalesce(array_length(v_world.amateur_names, 1), 0) then
      v_name := v_world.amateur_names[v_i]; -- landestypische Namen aus der Welterstellung
    else
      v_name := v_prefix[1 + floor(public.fd_hash01(v_world.seed || ':ap:' || v_i) * 10)::int] || ' '
             || v_towns[1 + floor(public.fd_hash01(v_world.seed || ':at:' || v_i) * 20)::int];
    end if;
    v_short := 'AM' || lpad(((select count(*) from public.clubs where world_id = p_world and amateur) + 1 + v_n)::text, 2, '0');
    if exists (select 1 from public.clubs where world_id = p_world and (name_normalized = public.normalize_name(v_name) or short_name_normalized = public.normalize_name(v_short)))
       or exists (select 1 from public.club_name_blocklist b where b.name_normalized = public.normalize_name(v_name)) then
      continue;
    end if;
    insert into public.clubs(world_id, association_code, name, short_name, control, reputation, amateur, name_normalized, short_name_normalized)
    values (p_world, v_cc, v_name, v_short, 'ai', 25, true, '', '')
    returning id into v_club;
    insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
    select v_club, p_world, b.primary_color, b.secondary_color, b.accent_color, b.crest, b.kit
    from public.club_branding b join public.clubs c on c.id = b.club_id
    where c.world_id = p_world and c.control = 'ai' and not c.amateur
    order by md5(v_club::text || b.club_id::text) limit 1;
    -- Kader: 16 Feldspieler + 2 Torhüter, schwächer, abgeleitet aus Spielern deutscher Vereine.
    -- Eine Sortierung je Verein (Quelle), Namen per Index aus vorab gesammelten Listen, Attribute
    -- skaliert vom Quellspieler – schnell auch bei sehr großem (europaweitem) Spielerpool.
    v_target := 58 + floor(public.fd_hash01(v_club::text) * 6)::int;
    if v_cc <> 'GER' then v_target := round(public.fd_country_transform(v_str, v_target))::int; end if;
    delete from fd_tmp_ama_src where true;
    insert into fd_tmp_ama_src(src_id, rn, is_gk)
    select x.id, x.rn, x.is_gk from (
      select pl.id, pl.main_position = 'GK' as is_gk,
             row_number() over (partition by (pl.main_position = 'GK') order by md5(v_club::text || pl.id::text)) as rn
      from public.players pl where pl.world_id = p_world and not pl.retired and pl.club_id = any(v_ger)
    ) x where (x.is_gk and x.rn <= 2) or (not x.is_gk and x.rn <= 16);
    insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                               overall, fitness, market_value, shirt_number, club_id)
    select p_world,
           v_first[1 + floor(public.fd_hash01(v_club::text || s.src_id::text || 'f') * array_length(v_first, 1))::int],
           v_last[1 + floor(public.fd_hash01(v_club::text || s.src_id::text || 'l') * array_length(v_last, 1))::int],
           p.nationality, p.region, p.age, p.main_position, p.secondary_positions,
           greatest(case when v_cc = 'GER' then 40 else 35 end, least(70, v_target + (p.overall - 70) / 4)), 100, 100000,
           case when s.is_gk then (case when s.rn = 1 then 1 else 18 end) else s.rn + 1 end, v_club
    from fd_tmp_ama_src s join public.players p on p.id = s.src_id
    order by s.is_gk desc, s.rn;
    -- Attribute: skaliert vom Quellspieler gleicher Position (Zuordnung über Trikotnummer)
    insert into public.player_attributes(player_id, world_id, kind, attributes)
    select np.id, p_world, pa.kind,
           (select jsonb_object_agg(k, greatest(20, least(80, round((v::numeric) * np.overall / greatest(op.overall, 1)))))
            from jsonb_each_text(pa.attributes) as a(k, v))
    from public.players np
    join fd_tmp_ama_src s on (case when s.is_gk then (case when s.rn = 1 then 1 else 18 end) else s.rn + 1 end) = np.shirt_number
    join public.players op on op.id = s.src_id
    join public.player_attributes pa on pa.player_id = op.id
    where np.club_id = v_club;
    insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 0);
    perform public.post_transaction(v_club, 'starting_capital', public.fd_scaled(2000000, v_world.economy_factor), 'start:' || v_club, 'Startkapital', v_world.current_season_id);
    perform public.fd_init_club_tactics(p_world, v_club, '4-4-2');
    v_need := v_need - 1;
    v_n := v_n + 1;
  end loop;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.fd_after_last_matchday(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
      public.fd_scaled((select amount from public.prize_templates where competition_kind = 'league' and tier = r.tier and prize_key = 'placement_' || t.pos), v_world.economy_factor),
      'season:' || v_world.current_season_id || ':placement:' || t.club_id, 'Platzierungsprämie Platz ' || t.pos, v_world.current_season_id)
    from public.fd_table(r.id) t;
  end loop;
  select * into v_r1 from public.season_slots where season_id = v_world.current_season_id and slot_key = 'R1';
  select * into v_r2 from public.season_slots where season_id = v_world.current_season_id and slot_key = 'R2';
  for v_t in 1..2 loop
    select t.club_id into v_down from public.fd_table((select id from public.competitions where season_id = v_world.current_season_id and kind = 'league' and tier = v_t)) t where t.pos = 16;
    select t.club_id into v_up from public.fd_table((select id from public.competitions where season_id = v_world.current_season_id and kind = 'league' and tier = v_t + 1)) t where t.pos = 3;
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_world.current_season_id, 'relegation', v_world.country_code, v_t, 'Relegation ' || public.fd_league_name(v_world.country_code, v_t))
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
$function$
;


CREATE OR REPLACE FUNCTION public.fd_end_season(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

  -- Saisonwechsel: Alter +1, Verträge (Verlängerungen folgen in Phase 9 – vorerst automatisch +2 Jahre)
  -- Entwicklungsbericht: Stand am Saisonende festhalten, danach Alterung (nur hier sinken Attribute)
  perform public.fd_dev_season_close(p_world, v_old.id);
  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
  insert into public.dev_aging_jobs(world_id, season_id) values (p_world, v_old.id) on conflict do nothing;
  perform public.fd_dev_season_aging(p_world, v_old.id, 2000); -- große Welten: Rest übernimmt der Server-Sweep
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
$function$
;


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
  v_ec boolean;
  v_ek integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if v_world.status <> 'preseason' then return; end if;
  select * into v_season from public.seasons where id = v_world.current_season_id;
  if exists (select 1 from public.season_slots where season_id = v_season.id) then return; end if;
  perform public.fd_ensure_amateurs(p_world);
  -- Europapokal erst ab Saison 2: Qualifikation nur über eine abgeschlossene Vorsaison
  v_ec := exists (select 1 from public.seasons s where s.world_id = p_world and s.status::text = 'closed' and s.id <> v_season.id);
  v_start := make_date(v_season.year, 8, 1);
  v_start := v_start + ((6 - extract(dow from v_start)::int + 7) % 7); -- erster Samstag im August

  -- Termine (Liga samstags, Pokal mittwochs, Winterpause nach dem 17. Spieltag)
  create temp table if not exists fd_tmp_slots (slot_key text, kind text, label text, slot_date date, matchday smallint, cup_stage public.stage_kind) on commit drop;
  delete from fd_tmp_slots where true; -- Supabase (pg-safeupdate) verlangt eine WHERE-Klausel
  insert into fd_tmp_slots values ('C1', 'cup', 'Pokal · 1. Runde', v_start, null, 'round_of_64');
  for v_md in 1..34 loop
    v_date := v_start + 7 * v_md + case when v_md > 17 then 35 else 0 end;
    insert into fd_tmp_slots values ('L' || v_md, 'league', v_md || '. Spieltag', v_date, v_md, null);
    -- Europapokal dienstags (ab Saison 2): 6 Gruppenspieltage, Achtel-, Viertel- und Halbfinale mit Hin- und Rückspiel
    v_ek := array_position(array[2, 4, 6, 9, 11, 13, 19, 21, 23, 25, 28, 30], v_md);
    if v_ec and v_ek is not null then
      insert into fd_tmp_slots values ('E' || v_ek, 'europe',
        case when v_ek <= 6 then 'Europapokal · Gruppenphase ' || v_ek
             when v_ek = 7 then 'Europapokal · Achtelfinale (Hinspiel)' when v_ek = 8 then 'Europapokal · Achtelfinale (Rückspiel)'
             when v_ek = 9 then 'Europapokal · Viertelfinale (Hinspiel)' when v_ek = 10 then 'Europapokal · Viertelfinale (Rückspiel)'
             when v_ek = 11 then 'Europapokal · Halbfinale (Hinspiel)' else 'Europapokal · Halbfinale (Rückspiel)' end,
        v_date + 3, null,
        case when v_ek <= 6 then 'group' when v_ek <= 8 then 'round_of_16' when v_ek <= 10 then 'quarter_final' else 'semi_final' end::public.stage_kind);
    end if;
    if v_md = 7 then insert into fd_tmp_slots values ('C2', 'cup', 'Pokal · 2. Runde', v_date + 4, null, 'round_of_32'); end if;
    if v_md = 13 then insert into fd_tmp_slots values ('C3', 'cup', 'Pokal · Achtelfinale', v_date + 4, null, 'round_of_16'); end if;
    if v_md = 20 then insert into fd_tmp_slots values ('C4', 'cup', 'Pokal · Viertelfinale', v_date + 4, null, 'quarter_final'); end if;
    if v_md = 27 then insert into fd_tmp_slots values ('C5', 'cup', 'Pokal · Halbfinale', v_date + 4, null, 'semi_final'); end if;
    if v_md = 34 then
      insert into fd_tmp_slots values ('R1', 'relegation', 'Relegation · Hinspiel', v_date + 4, null, null);
      insert into fd_tmp_slots values ('R2', 'relegation', 'Relegation · Rückspiel', v_date + 7, null, null);
      insert into fd_tmp_slots values ('C6', 'cup', 'Pokalfinale', v_date + 14, null, 'final');
      if v_ec then insert into fd_tmp_slots values ('E13', 'europe', 'Europapokal · Finale', v_date + 10, null, 'final'); end if;
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

  -- Pokal: 54 Profis + 10 Amateure (alle drei Ligen des Spiellands)
  insert into public.competitions(world_id, season_id, kind, association_code, name, neutral_final_venue)
  values (p_world, v_season.id, 'domestic_cup', v_world.country_code, public.fd_cup_name(v_world.country_code), 'Neutraler Finalort')
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
$function$
;


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
  v_eco numeric;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  v_eco := v_world.economy_factor;
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
          public.fd_scaled((select amount from public.prize_templates where competition_kind = 'league' and tier = f.comp_tier
             and prize_key = case when r.w = 1 then 'match_win' when r.d = 1 then 'match_draw' else 'match_loss' end), v_eco),
          'fx:' || f.id || ':bonus:' || r.club, 'Spielprämie ' || v_slot.label, f.season_id);
        -- I7: laufende Sponsorzahlungen
        for v_sp in select so.* from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
                    where sc.club_id = r.club and sc.season_id = f.season_id loop
          perform public.fd_pay(r.club, 'sponsor', public.fd_scaled(case v_sp.kind
              when 'per_league_match' then v_sp.amount when 'per_league_win' then v_sp.amount * r.w
              when 'per_league_point' then v_sp.amount * (3 * r.w + r.d) when 'per_league_goal' then v_sp.amount * r.gf else 0 end, v_eco),
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
        perform public.fd_pay(v_win, 'competition_prize', public.fd_scaled(v_cup_prize, v_eco), 'fx:' || f.id || ':cupprize', 'Pokalprämie ' || v_slot.label, f.season_id);
      end if;
    end if;
    -- I4: Zuschauereinnahmen und Stadionkosten (Heimverein)
    if not f.neutral_venue and v_res.attendance is not null then
      select case when f.comp_kind = 'domestic_cup' then ticket_price_cup when f.comp_kind in ('champions_league', 'europa_league') then ticket_price_international else ticket_price_league end, capacity
      into v_price, v_cap from public.stadiums where club_id = f.home_club_id;
      if v_price is not null then
        perform public.fd_pay(f.home_club_id, 'ticket_income', public.fd_scaled(v_res.attendance::bigint * v_price, case when f.comp_kind in ('champions_league', 'europa_league') then 1 else v_eco end), 'fx:' || f.id || ':tickets',
          'Ticketverkauf – ' || replace(to_char(v_res.attendance, 'FM999,999'), ',', '.') || ' Zuschauer · ' || v_slot.label, f.season_id);
        perform public.fd_pay(f.home_club_id, 'stadium_running_cost', -public.fd_scaled(v_cap::bigint * 2, v_eco), 'fx:' || f.id || ':stadiumcost',
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
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and c.association_code = v_world.country_code and pc.active group by pc.club_id loop
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
$function$
;


CREATE OR REPLACE FUNCTION public.sell_to_ai(p_player uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_win public.transfer_windows;
  v_buyer uuid;
  v_fee bigint;
  v_tier smallint;
  v_name text;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or not public.is_club_manager(v_p.club_id) then raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_sell(v_p.club_id, v_win);
  v_fee := (round(v_p.market_value * (0.85 + public.fd_hash01(v_p.id::text || v_win.id::text) * 0.1) / 100000) * 100000)::bigint;
  v_tier := case when v_p.overall >= 78 then 1 when v_p.overall >= 71 then 2 when v_p.overall >= 64 then 3 else 4 end;
  select c.id into v_buyer from public.clubs c join public.finances f on f.club_id = c.id
  where c.world_id = v_p.world_id and c.control = 'ai' and not c.amateur and f.balance >= v_fee
    and public.fd_tier_of(c.id, v_world.current_season_id) in (v_tier, greatest(1, v_tier - 1))
    and (select count(*) from public.players where club_id = c.id) < 28
    and (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = c.id and t.kind in ('transfer', 'free_agent')) < 5
  order by (public.fd_tier_of(c.id, v_world.current_season_id) = v_tier) desc, md5(c.id::text || p_player::text) limit 1;
  if v_buyer is null then
    return jsonb_build_object('status', 'rejected', 'message', 'Kein KI-Verein kann sich den Spieler gerade leisten.');
  end if;
  select c.name || case when c.association_code <> v_world.country_code then ' (' || a.name || ')' else '' end into v_name
  from public.clubs c join public.associations a on a.code = c.association_code where c.id = v_buyer;
  perform public.fd_complete_transfer(p_player, v_p.club_id, v_buyer, v_fee, public.fd_salary(v_p.overall, v_p.age, public.fd_tier_of(v_buyer, v_world.current_season_id), (select reputation from public.clubs where id = v_buyer), 3), 3, null, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'fee', v_fee, 'buyer', v_name,
    'message', v_p.last_name || ' wechselt für ' || to_char(v_fee / 1e6, 'FM999990D0') || ' Mio. € zu ' || v_name || '.');
end;
$function$
;


CREATE OR REPLACE FUNCTION public.transfer_market_options(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_season uuid;
  v_cc text := public.fd_world_country(p_world);
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  return jsonb_build_object(
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'strength', a.start_strength) order by a.start_strength desc, a.name)
      from public.associations a where exists (select 1 from public.clubs c where c.world_id = p_world and c.association_code = a.code)), '[]'::jsonb),
    'leagues', coalesce((
      select jsonb_agg(x order by (x ->> 'order')::int, x ->> 'name') from (
        select jsonb_build_object('key', v_cc || co.tier, 'name', co.name, 'country', v_cc, 'order', co.tier) as x
        from public.competitions co where co.season_id = v_season and co.kind = 'league'
        union all
        select jsonb_build_object('key', c.association_code, 'name', max(c.league_name), 'country', c.association_code, 'order', 10)
        from public.clubs c where c.world_id = p_world and c.association_code <> v_cc group by c.association_code
      ) l), '[]'::jsonb),
    'clubs', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name, 'country', c.association_code,
                                          'league', case when c.association_code = v_cc then v_cc || coalesce(public.fd_club_tier(c.id, v_season)::text, '4') else c.association_code end)
                       order by c.name)
      from public.clubs c where c.world_id = p_world and not c.amateur), '[]'::jsonb)
  );
end;
$function$
;


CREATE OR REPLACE FUNCTION public.transfer_market_search(p_world uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_season uuid;
  v_cc text := public.fd_world_country(p_world);
  v_my uuid;
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_result jsonb;
  v_sort text := coalesce(f ->> 'sort', 'overall');
  v_desc boolean := coalesce(f ->> 'dir', case when coalesce(f ->> 'sort', 'overall') in ('age', 'name') then 'asc' else 'desc' end) = 'desc';
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  select id into v_my from public.clubs where world_id = p_world and manager_user_id = auth.uid();
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  with tiers as (
    select ce.club_id, co.tier from public.competition_entries ce join public.competitions co on co.id = ce.competition_id
    where co.season_id = v_season and co.kind = 'league'
  ),
  base as (
    select p.id, p.first_name, p.last_name, p.age, p.main_position, p.secondary_positions, p.overall, p.market_value, p.nationality,
           c.id as club_id, c.name as club_name, c.short_name, c.control, c.association_code,
           case when c.id is null then null when c.association_code = v_cc then v_cc || coalesce(t.tier::text, '4') else c.association_code end as league_key,
           case when c.id is null then null when c.association_code = v_cc then coalesce((select co.name from public.competitions co where co.season_id = v_season and co.kind = 'league' and co.tier = t.tier limit 1), 'Amateurliga') else c.league_name end as league_name,
           fa.annual_salary as fa_salary, b.primary_color
    from public.players p
    left join public.clubs c on c.id = p.club_id
    left join tiers t on t.club_id = c.id
    left join public.free_agents fa on fa.player_id = p.id
    left join public.club_branding b on b.club_id = c.id
    where p.world_id = p_world and not p.retired
      and ((c.id is not null and not c.amateur and c.id is distinct from v_my) or (c.id is null and fa.player_id is not null))
      and (not coalesce((f ->> 'free_agents')::boolean, false) or c.id is null)
      and (f ->> 'country' is null or (c.id is not null and c.association_code = f ->> 'country') or (c.id is null and p.nationality = f ->> 'country'))
      and (f ->> 'club' is null or c.id = (f ->> 'club')::uuid)
      and (f ->> 'position' is null or p.main_position::text = f ->> 'position')
      and (f ->> 'nationality' is null or p.nationality = f ->> 'nationality')
      and (f ->> 'min_age' is null or p.age >= (f ->> 'min_age')::int)
      and (f ->> 'max_age' is null or p.age <= (f ->> 'max_age')::int)
      and (f ->> 'min_overall' is null or p.overall >= (f ->> 'min_overall')::int)
      and (f ->> 'max_overall' is null or p.overall <= (f ->> 'max_overall')::int)
      and (f ->> 'min_value' is null or p.market_value >= (f ->> 'min_value')::bigint)
      and (f ->> 'max_value' is null or p.market_value <= (f ->> 'max_value')::bigint)
      and (f ->> 'search' is null or (p.first_name || ' ' || p.last_name) ilike '%' || replace(replace(f ->> 'search', '%', ''), '_', '') || '%')
  ),
  filtered as (
    select * from base where f ->> 'league' is null or league_key = f ->> 'league'
  ),
  page as (
    select *, count(*) over () as total from filtered
    order by
      case when v_desc and v_sort = 'overall' then overall end desc nulls last,
      case when not v_desc and v_sort = 'overall' then overall end asc nulls last,
      case when v_desc and v_sort = 'value' then market_value end desc nulls last,
      case when not v_desc and v_sort = 'value' then market_value end asc nulls last,
      case when v_desc and v_sort = 'age' then age end desc nulls last,
      case when not v_desc and v_sort = 'age' then age end asc nulls last,
      case when v_desc and v_sort = 'name' then last_name end desc nulls last,
      case when not v_desc and v_sort = 'name' then last_name end asc nulls last,
      overall desc, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', coalesce((select total from page limit 1), 0),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'first_name', first_name, 'last_name', last_name, 'age', age, 'main_position', main_position,
      'secondary_positions', secondary_positions, 'overall', overall, 'market_value', market_value, 'nationality', nationality,
      'salary', fa_salary, 'league_key', league_key, 'league_name', league_name,
      'club', case when club_id is null then null else jsonb_build_object('id', club_id, 'name', club_name, 'short_name', short_name, 'control', control, 'association_code', association_code, 'color', primary_color) end
    )), '[]'::jsonb))
  into v_result from page;
  return v_result;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.team_context(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_tier smallint;
begin
  select * into v_world from public.career_worlds where id = p_world;
  v_tier := public.fd_club_tier(v_club, v_world.current_season_id);
  return jsonb_build_object(
    'world_status', v_world.status,
    'club_id', v_club,
    'tier', v_tier,
    'league', (select c.name from public.competitions c where c.season_id = v_world.current_season_id and c.kind = 'league' and c.tier = v_tier),
    'season_year', (select year from public.seasons where id = v_world.current_season_id),
    'week', v_world.current_week,
    'balance', (select balance from public.finances where club_id = v_club),
    'trainees_this_week', (select coalesce(jsonb_agg(jsonb_build_object('player_id', player_id, 'focus', focus)), '[]'::jsonb)
                           from public.training_sessions where club_id = v_club and season_id = v_world.current_season_id and week_no = v_world.current_week),
    'sponsor_offer_id', (select sponsor_offer_id from public.sponsor_contracts where club_id = v_club and season_id = v_world.current_season_id),
    'sponsor_offers', (select coalesce(jsonb_agg(to_jsonb(o) || jsonb_build_object('amount', public.fd_scaled(o.amount, v_world.economy_factor)) order by o.id), '[]'::jsonb) from public.sponsor_offers o where o.tier = v_tier),
    'readiness', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', p.username, 'club', c.name,
                                    'ready', coalesce(r.ready, false)) order by m.joined_at), '[]'::jsonb)
                  from public.world_members m join public.profiles p on p.id = m.user_id
                  left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
                  left join public.multiplayer_readiness r on r.world_id = m.world_id and r.user_id = m.user_id and r.context = 'preseason'
                  where m.world_id = p_world)
  );
end;
$function$
;


CREATE OR REPLACE FUNCTION public.europe_overview(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_season uuid;
begin
  if not public.is_world_member(p_world) then
    raise exception 'Kein Zugriff auf diese Welt.' using errcode = 'P0001', hint = 'forbidden';
  end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  return jsonb_build_object('season_id', v_season,
    'first_season', not exists (select 1 from public.seasons s where s.world_id = p_world and s.status::text = 'closed'),
    'competitions', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', co.id, 'kind', co.kind, 'name', co.name,
      'group_count', (select count(*) from public.competition_groups g join public.competition_stages st on st.id = g.stage_id where st.competition_id = co.id),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('label', g.label, 'table', (
          select jsonb_agg(jsonb_build_object('club_id', t.club_id, 'name', c.name, 'short', c.short_name, 'association', c.association_code,
                   'pos', t.pos, 'reason', (select q.reason from public.ec_qualifications q where q.season_id = co.season_id and q.club_id = t.club_id), 'points', t.points, 'gd', t.gd, 'gf', t.gf, 'played', s.played, 'won', s.won, 'drawn', s.drawn, 'lost', s.lost) order by t.pos)
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
$function$
;

-- Ablauf der Saisons mit 4 Gruppen (vor 0033), unverändert
CREATE OR REPLACE FUNCTION public.fd_europe_progress_v1(p_world uuid, p_slot public.season_slots, p_comp uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
  for co in select * from public.competitions where id = p_comp and season_id = p_slot.season_id and kind::text in ('champions_league', 'europa_league') loop
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
$function$
;


revoke execute on function public.fd_europe_progress_v1(uuid, public.season_slots, uuid) from public, anon, authenticated;
-- 4) Europapokal: Verbandsrangliste, Startplätze, 32 Teilnehmer je Wettbewerb -------------

-- Verbandsrangliste: Startstärke + Bonus aus den Europapokal-Ergebnissen der angegebenen Saison
create or replace function public.fd_ec_assoc_ranking(p_world uuid, p_ec_season uuid)
returns table(code text, score numeric, bonus numeric, rk integer)
language sql stable set search_path = '' as $$
  with pts as (
    select c.association_code::text as code, e.club_id,
           coalesce((select sum(s.points) from public.standings s where s.competition_id = co.id and s.club_id = e.club_id and s.group_id is not null), 0)
           + 3 * (select count(distinct st.id) from public.ties t join public.competition_stages st on st.id = t.stage_id
                  where st.competition_id = co.id and e.club_id in (t.club_a_id, t.club_b_id))
           + 3 * (select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id
                  where st.competition_id = co.id and st.kind = 'final' and t.winner_club_id = e.club_id) as p
    from public.competitions co
    join public.competition_entries e on e.competition_id = co.id
    join public.clubs c on c.id = e.club_id
    where p_ec_season is not null and co.season_id = p_ec_season and co.world_id = p_world
      and co.kind::text in ('champions_league', 'europa_league')
  ), b as (
    select code, least(6, round(0.35 * avg(p), 2)) as bonus, count(*) as n from pts group by code
  )
  select a.code::text, a.start_strength + coalesce(b.bonus, 0), coalesce(b.bonus, 0),
         (row_number() over (order by a.start_strength + coalesce(b.bonus, 0) desc, a.start_strength desc, a.code))::int
  from public.associations a left join b on b.code = a.code::text;
$$;

-- Startplätze je Verband (ohne die Zusatzplätze kleiner Nationen, die per gewichteter Auswahl vergeben werden)
-- Champions League: Rang 1–4 → 4, 5–6 → 3, 7–9 → 2, 10–11 → 1; bester Europapokal-Verband +1 (max. 5)
-- Europa League:    Rang 1–6 → 2 Ligaplätze, 7–9 → 1; Pokalsieger Rang 1–15
-- Spielland: mindestens Meister (CL) und Pokalsieger (EL)
create or replace function public.fd_ec_allocation(p_world uuid, p_ec_season uuid)
returns table(code text, score numeric, bonus numeric, rk integer, cl integer, el integer, cup boolean)
language sql stable set search_path = '' as $$
  with r as (select * from public.fd_ec_assoc_ranking(p_world, p_ec_season)),
  top as (select r.code from r where r.bonus > 0 order by r.bonus desc, r.score desc limit 1),
  cc as (select public.fd_world_country(p_world) as code)
  select r.code, r.score, r.bonus, r.rk,
         greatest(case when r.code = (select code from cc) then 1 else 0 end,
                  least(5, case when r.rk <= 4 then 4 when r.rk <= 6 then 3 when r.rk <= 9 then 2 when r.rk <= 11 then 1 else 0 end
                           + case when r.code in (select code from top) and r.rk <= 11 then 1 else 0 end)),
         case when r.rk <= 6 then 2 when r.rk <= 9 then 1 else 0 end,
         r.rk <= 15 or r.code = (select code from cc)
  from r;
$$;

-- Gewichtete Zufallsauswahl (deterministisch aus dem Welt-Seed): größter Schlüssel ln(u)/w gewinnt
create or replace function public.fd_wkey(p_text text, p_weight numeric)
returns double precision language sql immutable set search_path = '' as $$
  select ln(greatest(public.fd_hash01(p_text), 1e-9)) / greatest(p_weight, 1e-6)::double precision;
$$;

create or replace function public.fd_setup_europe(p_world uuid, p_season uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_cc text;
  v_prev uuid;
  v_prev_year integer;
  v_t1 uuid;
  v_cupwin uuid;
  v_ncl integer;
  v_nel integer;
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
  v_mem uuid[];
  v_round integer;
  v_pairs integer[] := array[1,2, 3,4,  4,1, 2,3,  1,3, 4,2,  2,1, 4,3,  1,4, 3,2,  3,1, 2,4];
  v_slot public.season_slots;
  v_k integer;
  v_seed text;
  v_code text;
  v_pos integer;
  v_a record;
  v_guard integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_cc := v_w.country_code::text;
  if exists (select 1 from public.competitions where season_id = p_season and kind::text in ('champions_league', 'europa_league')) then
    return jsonb_build_object('status', 'exists');
  end if;
  if not exists (select 1 from public.season_slots where season_id = p_season and kind = 'europe') then
    return jsonb_build_object('status', 'no_slots');
  end if;
  -- Qualifikation ausschließlich über die abgeschlossene Vorsaison (Saison 1: kein Europapokal)
  select id, year into v_prev, v_prev_year from public.seasons
  where world_id = p_world and status::text = 'closed' and id <> p_season order by year desc limit 1;
  if v_prev is null then return jsonb_build_object('status', 'first_season'); end if;
  delete from public.ec_qualifications where season_id = p_season; -- Neuaufbau (nur ohne Wettbewerbe möglich)
  v_seed := v_w.seed || ':' || p_season::text;

  create temporary table if not exists fd_tmp_ec (club_id uuid primary key, comp text, score numeric, assoc text, reason text, prio integer, strength numeric) on commit drop;
  delete from fd_tmp_ec where true;
  create temporary table if not exists fd_tmp_alloc (code text primary key, score numeric, bonus numeric, rk integer, cl integer, el integer, cup boolean) on commit drop;
  delete from fd_tmp_alloc where true;
  insert into fd_tmp_alloc select * from public.fd_ec_allocation(p_world, v_prev);
  -- Rangliste festhalten (Verlauf je Welt)
  insert into public.association_strength_history(world_id, association_code, season_year, strength)
  select p_world, code, v_prev_year, least(100, greatest(0, score)) from fd_tmp_alloc
  on conflict (world_id, association_code, season_year) do update set strength = excluded.strength;

  -- a) Spielland: Abschlusstabelle der 1. Liga der Vorsaison + Pokalsieger
  select id into v_t1 from public.competitions where season_id = v_prev and kind = 'league' and tier = 1;
  select cl, el into v_ncl, v_nel from fd_tmp_alloc where code = v_cc;
  if v_t1 is not null then
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select t.club_id, case when t.pos <= v_ncl then 'cl' else 'el' end, 1000 - t.pos, v_cc,
           case when t.pos = 1 then 'Meister' else 'Platz ' || t.pos || ' ' || public.fd_league_name(v_cc, 1) end, 1, public.fd_club_strength(t.club_id)
    from public.fd_table(v_t1) t where t.pos <= v_ncl + v_nel;
    select t.winner_club_id into v_cupwin from public.ties t join public.competition_stages st on st.id = t.stage_id
    join public.competitions c on c.id = st.competition_id where c.season_id = v_prev and c.kind = 'domestic_cup' and st.kind = 'final';
    if v_cupwin is not null and not exists (select 1 from fd_tmp_ec where club_id = v_cupwin) then
      -- Pokalsieger (auch aus 2./3. Liga): einziger Weg für Unterklassige
      insert into fd_tmp_ec values (v_cupwin, 'el', 900, v_cc, 'Pokalsieger', 1, public.fd_club_strength(v_cupwin));
    else
      -- Pokalsieger bereits über die Liga qualifiziert (oder kein Sieger): Platz geht an den nächstbesten Erstligisten
      select t.club_id, t.pos into v_club, v_pos from public.fd_table(v_t1) t
      where not exists (select 1 from fd_tmp_ec x where x.club_id = t.club_id) order by t.pos limit 1;
      if v_club is not null then
        insert into fd_tmp_ec values (v_club, 'el', 1000 - v_pos, v_cc,
          'Platz ' || v_pos || ' ' || public.fd_league_name(v_cc, 1) || case when v_cupwin is not null then ' (Pokalsieger bereits qualifiziert)' else ' (Pokalplatz)' end,
          1, public.fd_club_strength(v_club));
      end if;
    end if;
  end if;

  -- b) Übrige Länder (keine Simulation): Rangfolge je Land aus Stärke, Reputation und begrenztem Zufall
  create temporary table if not exists fd_tmp_ec_cand (club_id uuid primary key, assoc text, score numeric, strength numeric, rn integer) on commit drop;
  delete from fd_tmp_ec_cand where true;
  insert into fd_tmp_ec_cand(club_id, assoc, score, strength)
  select c.id, c.association_code::text,
         public.fd_club_strength(c.id) + coalesce(c.reputation, 0) * 0.05 + (public.fd_hash01(v_seed || ':ec:' || c.id::text) - 0.5) * 4,
         public.fd_club_strength(c.id)
  from public.clubs c
  where c.world_id = p_world and not c.amateur and c.control = 'ai' and c.association_code::text <> v_cc;
  update fd_tmp_ec_cand k set rn = x.rn from (
    select club_id, row_number() over (partition by assoc order by score desc, club_id) rn from fd_tmp_ec_cand) x
  where x.club_id = k.club_id;
  -- Champions League: Meister und Ligaplätze nach Länderrangliste
  insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
  select k.club_id, 'cl', k.score, k.assoc, case when k.rn = 1 then 'Meister' else 'Platz ' || k.rn end, 1, k.strength
  from fd_tmp_ec_cand k join fd_tmp_alloc a on a.code = k.assoc where k.rn <= a.cl;
  -- Europa League: nächstbeste Ligaplätze
  insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
  select k.club_id, 'el', k.score, k.assoc, 'Platz ' || k.rn, 1, k.strength
  from fd_tmp_ec_cand k join fd_tmp_alloc a on a.code = k.assoc where k.rn > a.cl and k.rn <= a.cl + a.el;
  -- Pokalsieger: gewichtete Zufallsauswahl unter den noch nicht qualifizierten Vereinen eines Landes
  for v_a in select * from fd_tmp_alloc where cup and code <> v_cc order by rk loop
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'el', k.score, k.assoc, 'Pokalsieger', 1, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_a.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by public.fd_wkey(v_seed || ':cup:' || k.club_id::text, exp(least(0, k.strength - (select max(strength) from fd_tmp_ec_cand m where m.assoc = v_a.code)) / 3.0)) desc
    limit 1;
  end loop;

  -- c) Kleinere Nationen: weitere Meister (CL) und Pokalsieger (EL) per gewichteter Länderauswahl
  v_guard := 0;
  while (select count(*) from fd_tmp_ec where comp = 'cl') < 32 and v_guard < 60 loop
    v_guard := v_guard + 1;
    select al.code into v_code from fd_tmp_alloc al
    where al.code <> v_cc and not exists (select 1 from fd_tmp_ec x where x.assoc = al.code and x.comp = 'cl')
      and exists (select 1 from fd_tmp_ec_cand k where k.assoc = al.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id))
    order by public.fd_wkey(v_seed || ':clsmall:' || al.code, power(al.score, 2)) desc limit 1;
    exit when v_code is null;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'cl', k.score, k.assoc, 'Meister (kleinere Nation)', 2, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id) order by k.rn limit 1;
  end loop;
  v_guard := 0;
  while (select count(*) from fd_tmp_ec where comp = 'el') < 32 and v_guard < 60 loop
    v_guard := v_guard + 1;
    select al.code into v_code from fd_tmp_alloc al
    where al.code <> v_cc and not exists (select 1 from fd_tmp_ec x where x.assoc = al.code and x.comp = 'el' and x.reason like 'Pokalsieger%')
      and exists (select 1 from fd_tmp_ec_cand k where k.assoc = al.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id))
    order by public.fd_wkey(v_seed || ':elsmall:' || al.code, power(al.score, 2)) desc limit 1;
    exit when v_code is null;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'el', k.score, k.assoc, 'Pokalsieger (kleinere Nation)', 2, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by public.fd_wkey(v_seed || ':cupsmall:' || k.club_id::text, exp(least(0, k.strength - (select max(strength) from fd_tmp_ec_cand m where m.assoc = v_code)) / 3.0)) desc
    limit 1;
  end loop;

  -- d) Sicherung: exakt 32 je Wettbewerb (fehlende Länder/Vereine → Nachrücker nach Stärke)
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, v_kind, k.score, k.assoc, 'Nachrücker', 3, k.strength from fd_tmp_ec_cand k
    left join public.associations s on s.code = k.assoc
    where not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by k.score + coalesce(s.start_strength, 0) * 0.1 desc, k.club_id
    limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    if v_t1 is not null then
      insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
      select t.club_id, v_kind, 1000 - t.pos, v_cc, 'Nachrücker (Platz ' || t.pos || ')', 3, public.fd_club_strength(t.club_id)
      from public.fd_table(v_t1) t where not exists (select 1 from fd_tmp_ec x where x.club_id = t.club_id)
      order by t.pos limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    end if;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select c.id, v_kind, 0, c.association_code, 'Nachrücker', 4, public.fd_club_strength(c.id) from public.clubs c
    where c.world_id = p_world and not c.amateur and not exists (select 1 from fd_tmp_ec x where x.club_id = c.id)
    order by public.fd_club_strength(c.id) desc, c.id
    limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    -- zu viele (nur theoretisch): schwächste Zusatzplätze streichen
    delete from fd_tmp_ec x where x.club_id in (
      select club_id from fd_tmp_ec where comp = v_kind order by prio asc, score desc offset 32);
  end loop;

  insert into public.ec_qualifications(world_id, season_id, club_id, competition, reason, association_code, association_rank)
  select p_world, p_season, x.club_id, x.comp, x.reason, x.assoc, a.rk from fd_tmp_ec x left join fd_tmp_alloc a on a.code = x.assoc
  on conflict do nothing;

  -- e) Wettbewerbe: 8 Gruppen à 4 (Lostöpfe nach Stärke, möglichst kein Land doppelt in einer Gruppe)
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into public.competitions(world_id, season_id, kind, association_code, name, neutral_final_venue)
    values (p_world, p_season, case v_kind when 'cl' then 'champions_league' else 'europa_league' end::public.competition_kind, null,
            case v_kind when 'cl' then 'Champions League' else 'Europa League' end, 'Neutraler Finalort')
    on conflict do nothing returning id into v_comp;
    if v_comp is null then
      select id into v_comp from public.competitions where season_id = p_season and kind::text = case v_kind when 'cl' then 'champions_league' else 'europa_league' end;
    end if;
    insert into public.competition_entries(competition_id, club_id, world_id, seed_rank)
    select v_comp, t.club_id, p_world, row_number() over (order by t.strength desc, t.club_id)
    from fd_tmp_ec t where t.comp = v_kind on conflict do nothing;
    insert into public.competition_stages(competition_id, world_id, kind, ordinal) values (v_comp, p_world, 'group', 1)
    on conflict (competition_id, kind) do update set ordinal = 1 returning id into v_stage;
    v_groups := array[]::uuid[];
    for v_g in 1..8 loop
      insert into public.competition_groups(stage_id, world_id, label) values (v_stage, p_world, chr(64 + v_g))
      on conflict (stage_id, label) do update set label = excluded.label returning id into v_club;
      v_groups := v_groups || v_club;
    end loop;
    v_grp_assoc := array['', '', '', '', '', '', '', ''];
    select array_agg(e.club_id order by e.seed_rank) into v_list from public.competition_entries e where e.competition_id = v_comp;
    for v_pot in 1..4 loop
      for v_club in select c from unnest(v_list[(v_pot - 1) * 8 + 1 : v_pot * 8]) c order by md5(v_seed || v_kind || v_pot || c::text) loop
        v_assoc := (select association_code from public.clubs where id = v_club);
        v_g := null;
        for v_try in select g from generate_series(1, 8) g order by md5(v_seed || v_club::text || g) loop
          if not exists (select 1 from public.group_memberships gm where gm.group_id = v_groups[v_try] and gm.pot = v_pot)
             and position('|' || v_assoc || '|' in v_grp_assoc[v_try]) = 0 then v_g := v_try; exit; end if;
        end loop;
        if v_g is null then
          select g into v_g from generate_series(1, 8) g
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
    for v_g in 1..8 loop
      select array_agg(gm.club_id order by gm.pot) into v_mem from public.group_memberships gm where gm.group_id = v_groups[v_g];
      continue when coalesce(array_length(v_mem, 1), 0) < 4;
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

-- K.-o.-Runden: Achtelfinale ergänzt (Reihenfolge der Stufen)
create or replace function public.fd_ec_ko_round(p_comp uuid, p_stage public.stage_kind, p_pairs uuid[], p_slot1 text, p_slot2 text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_c public.competitions;
  v_stage uuid;
  v_ord smallint := case p_stage when 'round_of_16' then 2 when 'quarter_final' then 3 when 'semi_final' then 4 else 5 end;
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
    continue when v_a is null or v_b is null;
    insert into public.ties(stage_id, world_id, club_a_id, club_b_id) values (v_stage, v_c.world_id, v_a, v_b) returning id into v_tie;
    if p_slot2 is null then
      -- Finale auf neutralem Platz
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

-- Fortschritt: Format mit 8 Gruppen (ab 0033); ältere Saisons mit 4 Gruppen laufen nach altem Ablauf weiter
create or replace function public.fd_europe_progress(p_world uuid, p_slot public.season_slots)
returns void
language plpgsql
set search_path = ''
as $$
declare
  co record;
  g record;
  v_first uuid[];
  v_second uuid[];
  v_win uuid[];
  v_pairs uuid[];
  v_c uuid;
  v_final uuid;
  v_seed text := (select seed from public.career_worlds where id = p_world);
  v_stage public.stage_kind;
  v_next public.stage_kind;
  v_need integer;
begin
  for co in select * from public.competitions where season_id = p_slot.season_id and kind::text in ('champions_league', 'europa_league') loop
    if (select count(*) from public.competition_groups cg join public.competition_stages st on st.id = cg.stage_id
        where st.competition_id = co.id and st.kind = 'group') <> 8 then
      perform public.fd_europe_progress_v1(p_world, p_slot, co.id);
      continue;
    end if;
    if p_slot.slot_key = 'E6' then
      v_first := array[]::uuid[]; v_second := array[]::uuid[];
      for g in select cg.id from public.competition_groups cg join public.competition_stages st on st.id = cg.stage_id
               where st.competition_id = co.id and st.kind = 'group' order by cg.label loop
        v_first := v_first || (select club_id from public.fd_group_table(g.id) where pos = 1);
        v_second := v_second || (select club_id from public.fd_group_table(g.id) where pos = 2);
      end loop;
      if coalesce(array_length(v_first, 1), 0) = 8 then
        for v_c in select unnest(v_first) loop perform public.fd_ec_prize(co.id, v_c, 'group_winner', 'gw', 'Gruppensieg'); end loop;
        for v_c in select unnest(v_second) loop perform public.fd_ec_prize(co.id, v_c, 'group_runner_up', 'gr', 'Gruppenzweiter'); end loop;
        for v_c in select unnest(v_first || v_second) loop perform public.fd_ec_prize(co.id, v_c, 'reach_round_of_16', 'r16', 'Achtelfinale erreicht'); end loop;
        -- Gruppensieger gegen Zweite einer Nachbargruppe: A1–B2, B1–A2, C1–D2, D1–C2, E1–F2, F1–E2, G1–H2, H1–G2
        v_pairs := array[v_first[1], v_second[2], v_first[2], v_second[1], v_first[3], v_second[4], v_first[4], v_second[3],
                         v_first[5], v_second[6], v_first[6], v_second[5], v_first[7], v_second[8], v_first[8], v_second[7]];
        perform public.fd_ec_ko_round(co.id, 'round_of_16', v_pairs, 'E7', 'E8');
      end if;
    elsif p_slot.slot_key in ('E8', 'E10', 'E12') then
      v_stage := case p_slot.slot_key when 'E8' then 'round_of_16' when 'E10' then 'quarter_final' else 'semi_final' end::public.stage_kind;
      v_need := case p_slot.slot_key when 'E8' then 8 when 'E10' then 4 else 2 end;
      select array_agg(t.winner_club_id order by md5(v_seed || co.id::text || t.winner_club_id::text)) into v_win
      from public.ties t join public.competition_stages st on st.id = t.stage_id
      where st.competition_id = co.id and st.kind = v_stage and t.winner_club_id is not null;
      if coalesce(array_length(v_win, 1), 0) = v_need then
        if p_slot.slot_key = 'E8' then
          for v_c in select unnest(v_win) loop perform public.fd_ec_prize(co.id, v_c, 'reach_quarter_final', 'qf', 'Viertelfinale erreicht'); end loop;
          perform public.fd_ec_ko_round(co.id, 'quarter_final', v_win, 'E9', 'E10');
        elsif p_slot.slot_key = 'E10' then
          for v_c in select unnest(v_win) loop perform public.fd_ec_prize(co.id, v_c, 'reach_semi_final', 'sf', 'Halbfinale erreicht'); end loop;
          perform public.fd_ec_ko_round(co.id, 'semi_final', v_win, 'E11', 'E12');
        else
          for v_c in select unnest(v_win) loop perform public.fd_ec_prize(co.id, v_c, 'reach_final', 'f', 'Finale erreicht'); end loop;
          perform public.fd_ec_ko_round(co.id, 'final', v_win, 'E13', null);
        end if;
      end if;
    elsif p_slot.slot_key = 'E13' then
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

-- Qualifikationsplätze der nationalen 1. Liga (Farbmarkierung der Tabelle)
create or replace function public.europe_places(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_cl integer;
  v_el integer;
  v_rk integer;
  v_cup uuid;
  v_t1 uuid;
  v_cup_pos integer;
begin
  if not public.is_world_member(p_world) then
    raise exception 'Kein Zugriff auf diese Welt.' using errcode = '42501', hint = 'forbidden';
  end if;
  select * into v_w from public.career_worlds where id = p_world;
  if v_w.current_season_id is null then return null; end if;
  -- Startplätze für die nächste Saison: Rangliste mit den Europapokal-Ergebnissen der laufenden Saison
  select a.cl, a.el, a.rk into v_cl, v_el, v_rk from public.fd_ec_allocation(p_world, v_w.current_season_id) a where a.code = v_w.country_code::text;
  select id into v_t1 from public.competitions where season_id = v_w.current_season_id and kind = 'league' and tier = 1;
  select t.winner_club_id into v_cup from public.ties t join public.competition_stages st on st.id = t.stage_id
  join public.competitions c on c.id = st.competition_id
  where c.season_id = v_w.current_season_id and c.kind = 'domestic_cup' and st.kind = 'final'
    and exists (select 1 from public.fixtures f where f.tie_id = t.id and f.status = 'released');
  if v_cup is not null and v_t1 is not null then
    select pos into v_cup_pos from public.fd_table(v_t1) where club_id = v_cup;
  end if;
  return jsonb_build_object(
    'competition_id', v_t1,
    'country', v_w.country_code,
    'association_rank', v_rk,
    'cl', v_cl,
    'el', v_el,
    'cup_winner', v_cup,
    'cup_winner_pos', v_cup_pos,
    -- Pokalsieger bereits über die Liga qualifiziert → nächster Platz rückt in die Europa League nach
    'extra_el_pos', case when v_cup is not null and v_cup_pos is not null and v_cup_pos <= v_cl + v_el then v_cl + v_el + 1 end,
    'cup_decided', v_cup is not null,
    'first_season', not exists (select 1 from public.seasons s where s.world_id = p_world and s.status::text = 'closed')
  );
end;
$$;
revoke execute on function public.europe_places(uuid) from public, anon;
grant execute on function public.europe_places(uuid) to authenticated;
revoke execute on function public.fd_ec_assoc_ranking(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fd_ec_allocation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fd_wkey(text, numeric) from public, anon, authenticated;
revoke execute on function public.fd_setup_europe(uuid, uuid) from public, anon, authenticated;
insert into public.country_league_names(code, tier1, tier2, tier3, cup) values
  ('ENG', 'Premier Division', 'Championship', 'League One', 'FA Cup'),
  ('ESP', 'Primera División', 'Segunda División', 'Primera Federación', 'Copa del Rey'),
  ('ITA', 'Serie A', 'Serie B', 'Serie C', 'Coppa Italia'),
  ('GER', 'Bundesliga', '2. Bundesliga', '3. Liga', 'DFB-Pokal'),
  ('FRA', 'Ligue 1', 'Ligue 2', 'National', 'Coupe de France'),
  ('POR', 'Primeira Liga', 'Segunda Liga', 'Liga 3', 'Taça de Portugal'),
  ('NED', 'Eredivisie', 'Eerste Divisie', 'Tweede Divisie', 'KNVB Beker'),
  ('BEL', 'Pro League', 'Challenger Pro League', 'Nationale 1', 'Belgischer Pokal'),
  ('TUR', 'Süper Lig', '1. Lig', '2. Lig', 'Türkiye Kupası'),
  ('CZE', '1. liga', 'Národní liga', 'ČFL', 'MOL Cup'),
  ('SCO', 'Premiership', 'Championship', 'League One', 'Scottish Cup'),
  ('AUT', 'Bundesliga', '2. Liga', 'Regionalliga', 'ÖFB-Cup'),
  ('SUI', 'Super League', 'Challenge League', 'Promotion League', 'Schweizer Cup'),
  ('GRE', 'Super League', 'Super League 2', 'Gamma Ethniki', 'Griechischer Pokal'),
  ('NOR', 'Eliteserien', 'OBOS-ligaen', 'PostNord-ligaen', 'NM Cup'),
  ('DEN', 'Superliga', '1. Division', '2. Division', 'Landspokal'),
  ('ISR', 'Ligat ha’Al', '2. Liga Israel', '3. Liga Israel', 'Pokal Israel'),
  ('POL', 'Ekstraklasa', 'I liga', 'II liga', 'Puchar Polski'),
  ('UKR', 'Premier-Liga', 'Perscha Liha', 'Druha Liha', 'Ukrainischer Pokal'),
  ('SRB', 'Prva liga', 'Druga liga', 'Srpska liga', 'Serbischer Pokal'),
  ('CRO', 'HNL', 'Prva NL', 'Druga NL', 'Kroatischer Pokal'),
  ('SWE', 'Allsvenskan', 'Superettan', 'Ettan', 'Svenska Cupen'),
  ('CYP', 'Protathlima', '2. Liga Zypern', '3. Liga Zypern', 'Pokal Zypern'),
  ('RUS', 'Premier-Liga', 'Erste Liga', 'Zweite Liga', 'Russischer Pokal'),
  ('HUN', 'NB I', 'NB II', 'NB III', 'Magyar Kupa'),
  ('ROU', 'Superliga', 'Liga II', 'Liga III', 'Cupa României'),
  ('SVK', 'Niké liga', '2. Liga Slowakei', '3. Liga Slowakei', 'Pokal Slowakei'),
  ('SVN', 'PrvaLiga', '2. Liga Slowenien', '3. Liga Slowenien', 'Pokal Slowenien'),
  ('BUL', 'Parva liga', '2. Liga Bulgarien', '3. Liga Bulgarien', 'Pokal Bulgarien'),
  ('AZE', 'Premyer Liqa', '2. Liga Aserbaidschan', '3. Liga Aserbaidschan', 'Pokal Aserbaidschan'),
  ('KAZ', 'Premier-Liga', '2. Liga Kasachstan', '3. Liga Kasachstan', 'Pokal Kasachstan'),
  ('BIH', 'Prva liga', '2. Liga Bosnien und Herzegowina', '3. Liga Bosnien und Herzegowina', 'Pokal Bosnien und Herzegowina'),
  ('MDA', 'Super Liga', '2. Liga Moldau', '3. Liga Moldau', 'Pokal Moldau'),
  ('ISL', 'Besta deild', '2. Liga Island', '3. Liga Island', 'Pokal Island'),
  ('FIN', 'Veikkausliiga', '2. Liga Finnland', '3. Liga Finnland', 'Pokal Finnland'),
  ('IRL', 'Premier Division', '2. Liga Irland', '3. Liga Irland', 'Pokal Irland'),
  ('ARM', 'Premier League', '2. Liga Armenien', '3. Liga Armenien', 'Pokal Armenien'),
  ('LVA', 'Virslīga', '2. Liga Lettland', '3. Liga Lettland', 'Pokal Lettland'),
  ('GEO', 'Erovnuli Liga', '2. Liga Georgien', '3. Liga Georgien', 'Pokal Georgien'),
  ('BLR', 'Premier-Liga', '2. Liga Belarus', '3. Liga Belarus', 'Pokal Belarus'),
  ('ALB', 'Kategoria Superiore', '2. Liga Albanien', '3. Liga Albanien', 'Pokal Albanien'),
  ('MKD', 'Prva liga', '2. Liga Nordmazedonien', '3. Liga Nordmazedonien', 'Pokal Nordmazedonien'),
  ('KOS', 'Kategoria Superiore', '2. Liga Kosovo', '3. Liga Kosovo', 'Pokal Kosovo'),
  ('LTU', 'Virslīga', '2. Liga Litauen', '3. Liga Litauen', 'Pokal Litauen'),
  ('LUX', 'BGL Ligue', '2. Liga Luxemburg', '3. Liga Luxemburg', 'Pokal Luxemburg'),
  ('FRO', 'Betri deildin', '2. Liga Färöer', '3. Liga Färöer', 'Pokal Färöer'),
  ('MNE', 'Prva liga', '2. Liga Montenegro', '3. Liga Montenegro', 'Pokal Montenegro'),
  ('NIR', 'Premier Division', '2. Liga Nordirland', '3. Liga Nordirland', 'Pokal Nordirland'),
  ('WAL', 'Cymru Premier', '2. Liga Wales', '3. Liga Wales', 'Pokal Wales'),
  ('EST', 'Meistriliiga', '2. Liga Estland', '3. Liga Estland', 'Pokal Estland'),
  ('MLT', 'Premier League', '2. Liga Malta', '3. Liga Malta', 'Pokal Malta'),
  ('GIB', 'National League', '2. Liga Gibraltar', '3. Liga Gibraltar', 'Pokal Gibraltar'),
  ('AND', 'Primera Divisió', '2. Liga Andorra', '3. Liga Andorra', 'Pokal Andorra'),
  ('LIE', 'Landesliga', '2. Liga Liechtenstein', '3. Liga Liechtenstein', 'Pokal Liechtenstein'),
  ('SMR', 'Campionato', '2. Liga San Marino', '3. Liga San Marino', 'Pokal San Marino')
on conflict (code) do update set tier1 = excluded.tier1, tier2 = excluded.tier2, tier3 = excluded.tier3, cup = excluded.cup;

-- Bestehende Welten: Deutschland, 2. Liga, Faktor 1 (Spaltendefaults); menschliche Vereine bleiben im Spielland
update public.clubs c set association_code = w.country_code
from public.career_worlds w where w.id = c.world_id and c.control = 'human' and c.association_code <> w.country_code and w.status = 'lobby';

notify pgrst, 'reload schema';
