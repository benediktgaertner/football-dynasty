-- =====================================================================
-- Migration 0010: Phase 3 – Weltinitialisierung und Snake-Draft (D1–D4, H5, C1, C2, C7)
--
-- Ablauf:
--   1. Der Host klickt „Draft starten“. Die Netlify-Function /api/start-draft prüft sein Token,
--      erzeugt mit packages/shared deterministisch aus dem Welt-Seed die KI-Vereine,
--      KI-Kader und den Draft-Pool und ruft admin_start_draft() mit dem Service-Role-Schlüssel auf.
--   2. admin_start_draft() prüft alles erneut und speichert die Welt in EINER Transaktion.
--   3. Die Manager wählen reihum per make_draft_pick() (Zeilensperre, Budget, Reserve).
-- =====================================================================

alter table public.players add column if not exists preferred_shirt_number smallint check (preferred_shirt_number between 1 and 99);

-- D3: Snake-Reihenfolge. Muss identisch zu snakeDraftManagerIndex() in packages/shared sein (Paritätstest).
create or replace function public.fd_snake_index(p_managers integer, p_pick integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when (p_pick / p_managers) % 2 = 0 then p_pick % p_managers else p_managers - 1 - (p_pick % p_managers) end;
$$;

-- E1/K1: Taktik-Grundausstattung eines Vereins (drei Profile mit festen Namen)
create or replace function public.fd_init_club_tactics(p_world uuid, p_club uuid, p_formation text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_profile public.tactical_profile_name;
  v_profile_id uuid;
  v_formation text := coalesce((select code from public.formations where code = p_formation), '4-4-2');
begin
  insert into public.tactics(club_id, world_id) values (p_club, p_world) on conflict (club_id) do nothing;
  foreach v_profile in array array['offensive', 'neutral', 'defensive']::public.tactical_profile_name[] loop
    insert into public.tactical_profiles(world_id, club_id, name, formation_code, team_instructions)
    values (p_world, p_club, v_profile, v_formation, public.fd_default_team_instructions(v_profile))
    on conflict (club_id, name) do nothing
    returning id into v_profile_id;
    if v_profile_id is not null then
      insert into public.tactical_profile_slots(profile_id, slot_index, position, x, y)
      select v_profile_id, (s ->> 'index')::smallint, (s ->> 'position')::public.player_position, (s ->> 'x')::numeric, (s ->> 'y')::numeric
      from public.formations f, jsonb_array_elements(f.slots) s
      where f.code = v_formation;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- Weltinitialisierung + Draft-Start (nur Service-Role, aufgerufen von /api/start-draft)
-- ---------------------------------------------------------------------
create or replace function public.admin_start_draft(p_world uuid, p_user uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  -- Payload prüfen (der Server vertraut auch der eigenen Function nicht blind)
  if p_payload is null or (p_payload ->> 'version') is distinct from '1' then
    raise exception 'Ungültige Initialisierungsdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if jsonb_array_length(p_payload -> 'ai_clubs') <> 54 - v_humans
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 1) <> 18
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 2) <> 18 - v_humans
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 3) <> 18 then
    raise exception 'Ungültige Vereinsverteilung im Payload.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload -> 'players') p where p -> 'club_key' = 'null'::jsonb) <> 400
     or exists (select 1 from jsonb_array_elements(p_payload -> 'players') p
                where p -> 'club_key' = 'null'::jsonb and (p ->> 'overall')::int > 83) then
    raise exception 'Der Draft-Pool muss aus genau 400 Spielern mit Stärke ≤ 83 bestehen.' using errcode = '22023', hint = 'invalid_payload';
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
    values (p_world, v_season, 'league', 'GER', v_tier, case v_tier when 1 then 'Bundesliga' when 2 then '2. Bundesliga' else '3. Liga' end)
    returning id into v_comp_id;
    v_comp := v_comp || v_comp_id;
  end loop;

  -- KI-Vereine (IDs vorab, damit Spieler über club_key zugeordnet werden können)
  create temp table if not exists fd_tmp_club_map (key text primary key, id uuid not null, tier smallint not null) on commit drop;
  truncate fd_tmp_club_map;
  insert into fd_tmp_club_map(key, id, tier)
  select c ->> 'key', gen_random_uuid(), (c ->> 'tier')::smallint from jsonb_array_elements(p_payload -> 'ai_clubs') c;

  insert into public.clubs(id, world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, founded_year, reputation)
  select m.id, p_world, 'GER', c ->> 'name', '', c ->> 'short_name', '', 'ai', (c ->> 'founded_year')::smallint,
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

  -- Ligazugehörigkeit: KI nach Payload, Menschen in die 2. Bundesliga (C1)
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[m.tier], m.id, p_world from fd_tmp_club_map m;
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[2], c.id, p_world from public.clubs c where c.world_id = p_world and c.control = 'human';

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
  v_capital := public.starting_capital(v_world.difficulty);
  for r in select c.id, s.capacity from public.clubs c join public.stadiums s on s.club_id = c.id
           where c.world_id = p_world and c.control = 'human' loop
    perform public.post_transaction(r.id, 'starting_capital', v_capital, 'start:' || r.id,
      'Startkapital (' || v_world.difficulty || ')', v_season);
    perform public.post_transaction(r.id, 'stadium_build', -public.stadium_build_cost(r.capacity), 'stadium_build:' || r.id,
      'Stadionbau (' || r.capacity || ' Plätze)', v_season);
  end loop;

  -- D3: zufällige Draftreihenfolge der menschlichen Vereine
  select array_agg(id order by gen_random_uuid()) into v_order
  from public.clubs where world_id = p_world and control = 'human';
  insert into public.draft_sessions(world_id, status, club_order, picks_per_club, current_pick, started_at)
  values (p_world, 'running', v_order, 22, 0, now())
  returning id into v_draft;

  update public.career_worlds set status = 'draft', current_season_id = v_season where id = p_world;

  select count(*) into v_count from fd_tmp_players;
  return jsonb_build_object('draft_id', v_draft, 'season_id', v_season, 'ai_clubs', 54 - v_humans, 'players', v_count);
end;
$$;

-- ---------------------------------------------------------------------
-- D3: Reserve für den ungünstigsten Fall.
-- Für jeden künftigen eigenen Pick wird angenommen, dass alle anderen Vereine vorher die
-- billigsten Spieler genommen haben. Wer nach dem Kauf diese Summe noch bezahlen kann,
-- kann seinen Kader garantiert auf 22 Spieler auffüllen – egal, was die anderen tun.
-- ---------------------------------------------------------------------
create or replace function public.fd_draft_reserve(p_draft public.draft_sessions, p_club uuid, p_exclude uuid)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_n integer := cardinality(p_draft.club_order);
  v_total integer := v_n * p_draft.picks_per_club;
  v_prices bigint[];
  v_others integer := 0;
  v_mine integer := 0;
  v_reserve bigint := 0;
  v_rank integer;
  i integer;
begin
  select coalesce(array_agg(market_value order by market_value), '{}') into v_prices
  from public.players where world_id = p_draft.world_id and in_draft_pool and id <> p_exclude;
  for i in (p_draft.current_pick + 1)..(v_total - 1) loop
    if p_draft.club_order[public.fd_snake_index(v_n, i) + 1] = p_club then
      v_rank := v_others + v_mine + 1; -- 1-basiert: so viele billigere sind bis dahin schon weg
      if v_rank > cardinality(v_prices) then
        return 9223372036854775807; -- unerfüllbar
      end if;
      v_reserve := v_reserve + v_prices[v_rank];
      v_mine := v_mine + 1;
    else
      v_others := v_others + 1;
    end if;
  end loop;
  return v_reserve;
end;
$$;

-- ---------------------------------------------------------------------
-- Interner Pick (prüft Spieler, Budget, Reserve; Reihenfolge prüft der Aufrufer)
-- ---------------------------------------------------------------------
create or replace function public.fd_execute_pick(p_draft public.draft_sessions, p_club uuid, p_player uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_player public.players;
  v_salary bigint;
  v_balance bigint;
  v_cheapest bigint;
  v_is_cheapest boolean;
  v_allow_negative boolean;
  v_reserve bigint;
  v_shirt smallint;
  v_year integer;
  v_season uuid;
  v_total integer := cardinality(p_draft.club_order) * p_draft.picks_per_club;
  v_finished boolean;
begin
  select p.* into v_player from public.players p
  where p.id = p_player and p.world_id = p_draft.world_id and p.in_draft_pool
  for update;
  if not found then
    raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'player_not_available';
  end if;
  select annual_salary into v_salary from public.free_agents where player_id = p_player;

  select balance into v_balance from public.finances where club_id = p_club for update;
  select min(market_value) into v_cheapest from public.players where world_id = p_draft.world_id and in_draft_pool;
  v_is_cheapest := v_player.market_value <= v_cheapest;

  if v_balance < v_player.market_value and not v_is_cheapest then
    raise exception 'Nicht genügend Geld für diesen Spieler.' using errcode = 'P0001', hint = 'insufficient_funds';
  end if;
  -- Der günstigste verfügbare Spieler ist immer erlaubt. Für alle anderen gilt die Reserve.
  if not v_is_cheapest then
    v_reserve := public.fd_draft_reserve(p_draft, p_club, p_player);
    if v_balance - v_player.market_value < v_reserve then
      raise exception 'Nach diesem Kauf bliebe nicht genug Geld, um den Kader sicher auf 22 Spieler aufzufüllen.'
        using errcode = 'P0001', hint = 'budget_reserve';
    end if;
  end if;
  -- Notfallregel (D3 „exakt 22 Spieler“): Reicht das Geld nicht einmal für den günstigsten
  -- Spieler, wird er trotzdem verpflichtet und der Fehlbetrag als Minus geführt.
  v_allow_negative := v_is_cheapest and v_balance < v_player.market_value;

  select s.id, s.year into v_season, v_year from public.career_worlds w join public.seasons s on s.id = w.current_season_id
  where w.id = p_draft.world_id;

  perform public.post_transaction(p_club, 'draft_purchase', -v_player.market_value,
    'draft:' || p_draft.id || ':' || p_draft.current_pick,
    'Draft: ' || v_player.first_name || ' ' || v_player.last_name, v_season, v_allow_negative);

  insert into public.draft_picks(draft_id, world_id, pick_index, club_id, player_id, price)
  values (p_draft.id, p_draft.world_id, p_draft.current_pick, p_club, p_player, v_player.market_value);

  -- Trikotnummer: Wunschnummer, sonst die kleinste freie
  if v_player.preferred_shirt_number is not null and not exists (
    select 1 from public.players where club_id = p_club and shirt_number = v_player.preferred_shirt_number) then
    v_shirt := v_player.preferred_shirt_number;
  else
    select min(n)::smallint into v_shirt from generate_series(1, 99) n
    where not exists (select 1 from public.players where club_id = p_club and shirt_number = n);
  end if;

  update public.players set club_id = p_club, in_draft_pool = false, shirt_number = v_shirt where id = p_player;
  delete from public.free_agents where player_id = p_player;

  -- H5: drei Jahre Vertrag, Gehalt automatisch nach Stärke und Alter
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  values (p_draft.world_id, p_player, p_club, v_year, v_year + 2, v_salary, v_player.age);

  insert into public.transfers(world_id, season_id, player_id, to_club_id, kind, fee)
  values (p_draft.world_id, v_season, p_player, p_club, 'draft', v_player.market_value);

  v_finished := p_draft.current_pick + 1 >= v_total;
  update public.draft_sessions
  set current_pick = current_pick + 1,
      status = case when v_finished then 'finished'::public.draft_status else status end,
      finished_at = case when v_finished then now() else finished_at end
  where id = p_draft.id;
  if v_finished then
    update public.career_worlds set status = 'preseason' where id = p_draft.world_id;
  end if;

  return jsonb_build_object('pick_index', p_draft.current_pick, 'club_id', p_club, 'player_id', p_player,
                            'price', v_player.market_value, 'shirt_number', v_shirt, 'finished', v_finished);
end;
$$;

-- ---------------------------------------------------------------------
-- D3: Pick durch den Manager, der an der Reihe ist
-- ---------------------------------------------------------------------
create or replace function public.make_draft_pick(p_world uuid, p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_draft public.draft_sessions;
  v_club uuid;
begin
  -- Zeilensperre: parallele Picks werden nacheinander abgearbeitet
  select * into v_draft from public.draft_sessions where world_id = p_world for update;
  if not found or v_draft.status <> 'running' then
    raise exception 'Der Draft läuft nicht.' using errcode = 'P0001', hint = 'draft_not_running';
  end if;
  v_club := v_draft.club_order[public.fd_snake_index(cardinality(v_draft.club_order), v_draft.current_pick) + 1];
  if not exists (select 1 from public.clubs where id = v_club and manager_user_id = v_member.user_id) then
    raise exception 'Du bist nicht an der Reihe.' using errcode = 'P0001', hint = 'not_your_turn';
  end if;
  update public.world_members set last_seen_at = now() where world_id = p_world and user_id = v_member.user_id;
  return public.fd_execute_pick(v_draft, v_club, p_player);
end;
$$;

-- ---------------------------------------------------------------------
-- B4/D3: Der Host darf für einen seit 15 Minuten abwesenden Manager automatisch wählen,
-- damit eine getrennte Person den Draft nicht dauerhaft blockiert.
-- Auswahl: Positionsgruppe mit dem größten Bedarf, darin der stärkste bezahlbare Spieler.
-- ---------------------------------------------------------------------
create or replace function public.auto_pick_current(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_draft public.draft_sessions;
  v_club uuid;
  v_manager uuid;
  v_last_seen timestamptz;
  v_balance bigint;
  v_cap bigint;
  v_candidate uuid;
  v_group text;
begin
  if v_member.role <> 'host' then
    raise exception 'Nur der Host kann für abwesende Manager wählen.' using errcode = '42501', hint = 'host_only';
  end if;
  select * into v_draft from public.draft_sessions where world_id = p_world for update;
  if not found or v_draft.status <> 'running' then
    raise exception 'Der Draft läuft nicht.' using errcode = 'P0001', hint = 'draft_not_running';
  end if;
  v_club := v_draft.club_order[public.fd_snake_index(cardinality(v_draft.club_order), v_draft.current_pick) + 1];
  select c.manager_user_id, m.last_seen_at into v_manager, v_last_seen
  from public.clubs c join public.world_members m on m.world_id = c.world_id and m.user_id = c.manager_user_id
  where c.id = v_club;
  if v_last_seen > now() - interval '15 minutes' then
    raise exception 'Der Manager am Zug ist noch aktiv.' using errcode = 'P0001', hint = 'manager_active';
  end if;

  select balance into v_balance from public.finances where club_id = v_club;
  -- Budgetbewusst: pro Pick höchstens das 2,5-Fache des Durchschnitts je offenem Kaderplatz
  v_cap := (v_balance * 5) / (2 * greatest(1, v_draft.picks_per_club
             - (select count(*) from public.draft_picks where draft_id = v_draft.id and club_id = v_club)));

  -- Bedarf: Zielkader 2 TW, 7 Abwehr, 7 Mittelfeld, 6 Angriff
  -- relativer Bedarf: fehlende Torhüter (2 von 2) zählen so viel wie fehlende Verteidiger (7 von 7)
  select g into v_group from (
    select g, (need - coalesce(have, 0))::numeric / need as deficit, ord from (values ('GK', 2, 1), ('DEF', 7, 2), ('MID', 7, 3), ('ATT', 6, 4)) t(g, need, ord)
    left join (
      select case when p.main_position = 'GK' then 'GK'
                  when p.main_position in ('CB','LB','RB','LWB','RWB') then 'DEF'
                  when p.main_position in ('CDM','CM','CAM','LM','RM') then 'MID' else 'ATT' end as grp, count(*) as have
      from public.players p where p.club_id = v_club group by 1
    ) h on h.grp = t.g
  ) d order by deficit desc, ord limit 1;

  select p.id into v_candidate
  from public.players p
  where p.world_id = p_world and p.in_draft_pool
    and (case when p.main_position = 'GK' then 'GK'
              when p.main_position in ('CB','LB','RB','LWB','RWB') then 'DEF'
              when p.main_position in ('CDM','CM','CAM','LM','RM') then 'MID' else 'ATT' end) = v_group
    and p.market_value <= v_cap
    and v_balance - p.market_value >= public.fd_draft_reserve(v_draft, v_club, p.id)
  order by p.overall desc, p.market_value
  limit 1;

  if v_candidate is null then
    -- günstigster Spieler der Bedarfsgruppe, falls er die Reserve einhält
    select p.id into v_candidate
    from public.players p
    where p.world_id = p_world and p.in_draft_pool
      and (case when p.main_position = 'GK' then 'GK'
                when p.main_position in ('CB','LB','RB','LWB','RWB') then 'DEF'
                when p.main_position in ('CDM','CM','CAM','LM','RM') then 'MID' else 'ATT' end) = v_group
      and v_balance - p.market_value >= public.fd_draft_reserve(v_draft, v_club, p.id)
    order by p.market_value, p.overall desc
    limit 1;
  end if;

  if v_candidate is null then
    -- Notfall: günstigster Spieler insgesamt
    select id into v_candidate from public.players where world_id = p_world and in_draft_pool order by market_value, overall desc limit 1;
  end if;
  return public.fd_execute_pick(v_draft, v_club, v_candidate) || jsonb_build_object('auto', true);
end;
$$;

-- ---------------------------------------------------------------------
-- L4: Draft-Zustand für die Oberfläche
-- ---------------------------------------------------------------------
create or replace function public.draft_state(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_draft public.draft_sessions;
  v_n integer;
  v_total integer;
  v_current uuid;
  v_upcoming jsonb;
  v_clubs jsonb;
  v_picks jsonb;
  v_my_club uuid;
begin
  select * into v_draft from public.draft_sessions where world_id = p_world;
  if not found then
    return jsonb_build_object('status', 'none');
  end if;
  v_n := cardinality(v_draft.club_order);
  v_total := v_n * v_draft.picks_per_club;
  if v_draft.current_pick < v_total then
    v_current := v_draft.club_order[public.fd_snake_index(v_n, v_draft.current_pick) + 1];
  end if;
  select id into v_my_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;

  select coalesce(jsonb_agg(jsonb_build_object('pick_index', i, 'club_id',
           v_draft.club_order[public.fd_snake_index(v_n, i) + 1]) order by i), '[]'::jsonb)
  into v_upcoming
  from generate_series(v_draft.current_pick, least(v_draft.current_pick + 11, v_total - 1)) i;

  select coalesce(jsonb_agg(jsonb_build_object(
      'club_id', c.id, 'name', c.name, 'short_name', c.short_name, 'order', o.ord,
      'primary_color', b.primary_color, 'secondary_color', b.secondary_color, 'crest', b.crest,
      'manager', p.username, 'manager_user_id', c.manager_user_id, 'last_seen_at', m.last_seen_at,
      'balance', f.balance,
      'picks', (select count(*) from public.draft_picks dp where dp.draft_id = v_draft.id and dp.club_id = c.id)
    ) order by o.ord), '[]'::jsonb)
  into v_clubs
  from unnest(v_draft.club_order) with ordinality o(club_id, ord)
  join public.clubs c on c.id = o.club_id
  join public.club_branding b on b.club_id = c.id
  join public.finances f on f.club_id = c.id
  left join public.profiles p on p.id = c.manager_user_id
  left join public.world_members m on m.world_id = c.world_id and m.user_id = c.manager_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'pick_index', dp.pick_index, 'club_id', dp.club_id, 'player_id', dp.player_id, 'price', dp.price,
      'name', pl.first_name || ' ' || pl.last_name, 'position', pl.main_position, 'overall', pl.overall,
      'age', pl.age, 'nationality', pl.nationality, 'shirt_number', pl.shirt_number
    ) order by dp.pick_index desc), '[]'::jsonb)
  into v_picks
  from public.draft_picks dp join public.players pl on pl.id = dp.player_id
  where dp.draft_id = v_draft.id;

  return jsonb_build_object(
    'status', v_draft.status,
    'draft_id', v_draft.id,
    'current_pick', v_draft.current_pick,
    'total_picks', v_total,
    'picks_per_club', v_draft.picks_per_club,
    'round', least(v_draft.current_pick / v_n + 1, v_draft.picks_per_club),
    'current_club_id', v_current,
    'my_club_id', v_my_club,
    'is_host', v_member.role = 'host',
    'upcoming', v_upcoming,
    'clubs', v_clubs,
    'picks', v_picks
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
revoke execute on function public.fd_snake_index(integer, integer) from public, anon, authenticated;
revoke execute on function public.fd_init_club_tactics(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fd_execute_pick(public.draft_sessions, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fd_draft_reserve(public.draft_sessions, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_start_draft(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_start_draft(uuid, uuid, jsonb) to service_role;

do $$
declare f text;
begin
  foreach f in array array['public.make_draft_pick(uuid, uuid)', 'public.auto_pick_current(uuid)', 'public.draft_state(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
