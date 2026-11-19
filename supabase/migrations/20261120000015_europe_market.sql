-- =====================================================================
-- Migration 0015: Europaweiter Transfermarkt
--   * Erstligen aller UEFA-Verbände (ohne Deutschland) als KI-Vereine mit vollständigen Kadern.
--     Erzeugt werden sie in TypeScript (packages/shared/src/world/europe.ts, landestypische fiktive
--     Namen, Kürzel, Farben, Wappen) und über die Netlify-Funktion /api/ensure-europe je Verband
--     mit admin_add_europe() gespeichert. Bestehende Welten werden so sicher ergänzt –
--     nichts wird gelöscht oder neu erstellt; jede Ausführung ist idempotent.
--   * Suche/Filter für den großen Spielerpool (transfer_market_search, transfer_market_options) mit Indizes.
--   * Internationale Transfers: virtuelle Spielklasse (clubs.level) für Gehaltsforderung und KI-Käufer.
--   * Gehälter je Spieltag nur für die deutschen Ligen (ausländische Vereine haben keine Spieltagseinnahmen).
-- =====================================================================

alter table public.clubs add column if not exists level smallint check (level between 1 and 4);
alter table public.clubs add column if not exists league_name text;

create index if not exists clubs_world_assoc_idx on public.clubs(world_id, association_code);
create index if not exists players_world_overall_idx on public.players(world_id, overall desc) where not retired;
create index if not exists players_world_pos_overall_idx on public.players(world_id, main_position, overall desc) where not retired;
create index if not exists players_world_value_idx on public.players(world_id, market_value) where not retired;
create index if not exists players_world_age_idx on public.players(world_id, age) where not retired;
create index if not exists players_club_id_idx on public.players(club_id);
create index if not exists player_contracts_club_active_idx on public.player_contracts(club_id) where active;

-- Spielklasse: deutsche Ligen aus der Saison, ausländische Vereine aus clubs.level, sonst 4
create or replace function public.fd_tier_of(p_club uuid, p_season uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  select coalesce(public.fd_club_tier(p_club, p_season), (select c.level from public.clubs c where c.id = p_club), 4::smallint);
$$;

-- ---------------------------------------------------------------------
-- Aufbau (nur Service-Role)
-- ---------------------------------------------------------------------
create or replace function public.admin_europe_status(p_world uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'seed', w.seed,
    'status', w.status,
    'clubs', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'short_name', c.short_name)) from public.clubs c where c.world_id = w.id), '[]'::jsonb),
    'done', coalesce((select jsonb_agg(distinct c.association_code) from public.clubs c where c.world_id = w.id and c.association_code <> 'GER'), '[]'::jsonb)
  )
  from public.career_worlds w where w.id = p_world;
$$;

create or replace function public.admin_add_europe(p_world uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if v_code is null or v_code = 'GER' or not exists (select 1 from public.associations where code = v_code) then
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
$$;

revoke execute on function public.admin_europe_status(uuid) from public, anon, authenticated;
revoke execute on function public.admin_add_europe(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_europe_status(uuid) to service_role;
grant execute on function public.admin_add_europe(uuid, jsonb) to service_role;

-- Aufbaustand für die Oberfläche (jedes Weltmitglied)
create or replace function public.europe_market_status(p_world uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_world_member(p_world) then null else jsonb_build_object(
    'associations', (select count(distinct c.association_code) from public.clubs c where c.world_id = p_world and c.association_code <> 'GER'),
    'total', (select count(*) from public.associations a where a.code <> 'GER'),
    'world_status', (select w.status from public.career_worlds w where w.id = p_world)
  ) end;
$$;
grant execute on function public.europe_market_status(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Suche im gesamten Spielerpool
-- Filter (alle optional): country (Verbandskürzel des Vereins, bei Vereinslosen die Nationalität),
-- league ('GER1'…'GER3' oder Verbandskürzel), club, position, nationality, min_age, max_age,
-- min_overall, max_overall, min_value, max_value, search (Name), free_agents (true = nur vereinslos),
-- sort ('overall'|'value'|'age'|'name'), dir ('asc'|'desc')
-- ---------------------------------------------------------------------
create or replace function public.transfer_market_search(p_world uuid, p_filters jsonb default '{}'::jsonb, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season uuid;
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
           case when c.id is null then null when c.association_code = 'GER' then 'GER' || coalesce(t.tier::text, '4') else c.association_code end as league_key,
           case when c.id is null then null when c.association_code = 'GER' then coalesce((select co.name from public.competitions co where co.season_id = v_season and co.kind = 'league' and co.tier = t.tier limit 1), 'Amateurliga') else c.league_name end as league_name,
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
$$;
grant execute on function public.transfer_market_search(uuid, jsonb, integer, integer) to authenticated;

-- Filterwerte: Länder, Ligen, Vereine
create or replace function public.transfer_market_options(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season uuid;
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  return jsonb_build_object(
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'strength', a.start_strength) order by a.start_strength desc, a.name)
      from public.associations a where exists (select 1 from public.clubs c where c.world_id = p_world and c.association_code = a.code)), '[]'::jsonb),
    'leagues', coalesce((
      select jsonb_agg(x order by (x ->> 'order')::int, x ->> 'name') from (
        select jsonb_build_object('key', 'GER' || co.tier, 'name', co.name, 'country', 'GER', 'order', co.tier) as x
        from public.competitions co where co.season_id = v_season and co.kind = 'league'
        union all
        select jsonb_build_object('key', c.association_code, 'name', max(c.league_name), 'country', c.association_code, 'order', 10)
        from public.clubs c where c.world_id = p_world and c.association_code <> 'GER' group by c.association_code
      ) l), '[]'::jsonb),
    'clubs', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name, 'country', c.association_code,
                                          'league', case when c.association_code = 'GER' then 'GER' || coalesce(public.fd_club_tier(c.id, v_season)::text, '4') else c.association_code end)
                       order by c.name)
      from public.clubs c where c.world_id = p_world and not c.amateur), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.transfer_market_options(uuid) to authenticated;

-- KI-Käufer beim Verkauf: deutsche und ausländische Vereine passender Spielklasse
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
  select c.name || case when c.association_code <> 'GER' then ' (' || a.name || ')' else '' end into v_name
  from public.clubs c join public.associations a on a.code = c.association_code where c.id = v_buyer;
  perform public.fd_complete_transfer(p_player, v_p.club_id, v_buyer, v_fee, greatest(public.fd_salary_demand(v_p.market_value, v_p.age), 50000), 3, null, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'fee', v_fee, 'buyer', v_name,
    'message', v_p.last_name || ' wechselt für ' || to_char(v_fee / 1e6, 'FM999990D0') || ' Mio. € zu ' || v_name || '.');
end;
$$;

-- Gehälter je Spieltag nur für deutsche Vereine (übrige Funktion unverändert aus Migration 0014)
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
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and c.association_code = 'GER' and pc.active group by pc.club_id loop
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

-- Rechte: neue Funktionen nicht für anon
revoke execute on function public.europe_market_status(uuid) from public, anon;
revoke execute on function public.transfer_market_search(uuid, jsonb, integer, integer) from public, anon;
revoke execute on function public.transfer_market_options(uuid) from public, anon;
grant execute on function public.europe_market_status(uuid) to authenticated;
grant execute on function public.transfer_market_search(uuid, jsonb, integer, integer) to authenticated;
grant execute on function public.transfer_market_options(uuid) to authenticated;
