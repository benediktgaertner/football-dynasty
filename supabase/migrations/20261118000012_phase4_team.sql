-- =====================================================================
-- Migration 0012: Phase 4 – Mannschaftsmanagement
-- Taktikprofile (E1–E3), Vereinseinstellungen und Automatik (E4), Standards (F9),
-- Zusatztraining (G1/G4), Sponsorwahl (I7, B2.12) und Bereitschaft für den Saisonstart.
-- Die erlaubten Werte entsprechen packages/shared/src/tactics.ts (Paritätstest).
-- =====================================================================

alter table public.career_worlds add column if not exists current_week smallint not null default 0;

-- ---------------------------------------------------------------------
-- Validierung
-- ---------------------------------------------------------------------
create or replace function public.fd_valid_team_instructions(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if (select count(*) from jsonb_object_keys(p)) <> 12 then return false; end if;
  foreach k in array array['mentality','tempo','attackWidth','crossFrequency','pressingIntensity','defensiveLine','defensiveWidth'] loop
    if coalesce(jsonb_typeof(p -> k) <> 'number' or (p ->> k) !~ '^[1-5]$', true) then return false; end if;
  end loop;
  return coalesce((p ->> 'buildUp') = any (array['short','mixed','direct','long'])
     and (p ->> 'attackFocus') = any (array['left','center','right','both_wings','flexible'])
     and (p ->> 'chanceCreation') = any (array['patient','mixed','quick'])
     and (p ->> 'onBallWon') = any (array['hold','organized','counter'])
     and (p ->> 'onBallLost') = any (array['retreat','hold_position','counter_press']), false);
end;
$$;

create or replace function public.fd_valid_advanced_options(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (array[
      'pressingTrigger','pressingDirection','offsideTrap','restDefense','marking','tackling','positionRotation',
      'overload','throughBalls','crossHeight','boxPresence','transitionCover','pressTargets','manMarking'])) then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(p)) <> 14 then return false; end if;
  return coalesce((p ->> 'pressingTrigger') = any (array['always','back_pass','bad_touch','wide_areas','own_half_only'])
     and (p ->> 'pressingDirection') = any (array['center','balanced','wings'])
     and jsonb_typeof(p -> 'offsideTrap') = 'boolean'
     and jsonb_typeof(p -> 'positionRotation') = 'boolean'
     and jsonb_typeof(p -> 'transitionCover') = 'boolean'
     and jsonb_typeof(p -> 'restDefense') = 'number' and (p ->> 'restDefense') in ('2','3','4')
     and (p ->> 'marking') = any (array['zonal','mixed','man'])
     and jsonb_typeof(p -> 'tackling') = 'number' and (p ->> 'tackling') in ('1','2','3')
     and (p ->> 'overload') = any (array['none','left','center','right'])
     and jsonb_typeof(p -> 'throughBalls') = 'number' and (p ->> 'throughBalls') in ('1','2','3')
     and (p ->> 'crossHeight') = any (array['low','mixed','high'])
     and jsonb_typeof(p -> 'boxPresence') = 'number' and (p ->> 'boxPresence') in ('1','2','3')
     and jsonb_typeof(p -> 'pressTargets') = 'array' and jsonb_array_length(p -> 'pressTargets') <= 3
     and jsonb_typeof(p -> 'manMarking') = 'array' and jsonb_array_length(p -> 'manMarking') <= 3, false);
end;
$$;

-- E3: erlaubte Anweisungen je Position
create or replace function public.fd_allowed_instructions(p_position public.player_position)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case
    when p_position = 'GK' then array['short_distribution','long_kicks','sweeper_keeper','conservative_positioning']
    when p_position = 'CB' then array['conservative','step_up','support_buildup']
    when p_position in ('LB','RB','LWB','RWB') then array['stay_back','overlap','invert','cross_often']
    when p_position in ('CDM','CM','CAM') then array['hold_position','get_forward','safe_passes','risky_passes','roam']
    when p_position in ('LM','RM','LW','RW') then array['stay_wide','cut_inside','to_byline','track_back','run_into_space']
    else array['run_in_behind','come_short','stay_central','drift_wide','shoot_more']
  end;
$$;

create or replace function public.fd_valid_player_instructions(p_position public.player_position, p_codes text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_codes <@ public.fd_allowed_instructions(p_position)
     and cardinality(p_codes) = (select count(distinct c) from unnest(p_codes) c)
     and not exists (
       select 1 from (values
         ('run_in_behind','come_short'), ('stay_central','drift_wide'), ('stay_wide','cut_inside'),
         ('hold_position','get_forward'), ('hold_position','roam'), ('safe_passes','risky_passes'),
         ('stay_back','overlap'), ('stay_back','invert'), ('overlap','invert'), ('conservative','step_up'),
         ('short_distribution','long_kicks'), ('sweeper_keeper','conservative_positioning')) x(a, b)
       where x.a = any (p_codes) and x.b = any (p_codes)), false);
$$;

-- G4: Entwicklungspunkte einer Zusatzeinheit (identisch zu trainingDevelopmentPoints)
create or replace function public.fd_training_points(p_age integer, p_overall integer, p_potential integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(1.0 * (case when p_age <= 20 then 1.5 when p_age <= 23 then 1.3 when p_age <= 27 then 1.0
                           when p_age <= 30 then 0.75 when p_age <= 33 then 0.5 else 0.25 end)
                   * (case when p_potential > p_overall then 1 else 0.2 end), 2);
$$;

-- Eigener Verein in einer Welt mit abgeschlossenem Draft
create or replace function public.fd_require_team(p_world uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
  v_club uuid;
begin
  select status into v_status from public.career_worlds where id = p_world;
  if v_status not in ('preseason', 'season', 'season_end') then
    raise exception 'Das Team-Management ist erst nach dem Draft verfügbar.' using errcode = 'P0001', hint = 'team_not_available';
  end if;
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  if v_club is null then
    raise exception 'Du hast in dieser Welt keinen Verein.' using errcode = 'P0001', hint = 'club_required';
  end if;
  return v_club;
end;
$$;

-- ---------------------------------------------------------------------
-- E1–E3: Taktikprofil speichern
-- p_data = { formation_code, team_instructions, advanced_options,
--            slots: [{slot_index, position, x, y, player_id}] (11),
--            player_instructions: { "<player_id>": ["code", …] } }
-- ---------------------------------------------------------------------
create or replace function public.save_tactical_profile(p_world uuid, p_profile public.tactical_profile_name, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_profile uuid;
  v_slots jsonb := p_data -> 'slots';
  v_instr jsonb := coalesce(p_data -> 'player_instructions', '{}'::jsonb);
  r record;
begin
  if p_profile is null then
    raise exception 'Profil fehlt.' using errcode = '22023', hint = 'invalid_profile';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or not exists (select 1 from public.formations where code = p_data ->> 'formation_code') then
    raise exception 'Unbekannte Formation.' using errcode = '22023', hint = 'invalid_formation';
  end if;
  if not public.fd_valid_team_instructions(p_data -> 'team_instructions') then
    raise exception 'Ungültige Mannschaftsanweisungen.' using errcode = '22023', hint = 'invalid_team_instructions';
  end if;
  if not public.fd_valid_advanced_options(p_data -> 'advanced_options') then
    raise exception 'Ungültige taktische Spezialoptionen.' using errcode = '22023', hint = 'invalid_advanced_options';
  end if;

  -- Aufstellung prüfen
  if v_slots is null or jsonb_typeof(v_slots) <> 'array' or jsonb_array_length(v_slots) <> 11 then
    raise exception 'Eine Aufstellung braucht genau 11 Positionen.' using errcode = '22023', hint = 'invalid_lineup';
  end if;
  if (select count(distinct (s ->> 'slot_index')::int) from jsonb_array_elements(v_slots) s
      where (s ->> 'slot_index') ~ '^([0-9]|10)$') <> 11 then
    raise exception 'Ungültige Positionsnummern.' using errcode = '22023', hint = 'invalid_lineup';
  end if;
  if exists (select 1 from jsonb_array_elements(v_slots) s
             where coalesce((s ->> 'position') = any (enum_range(null::public.player_position)::text[])
                and jsonb_typeof(s -> 'x') = 'number' and jsonb_typeof(s -> 'y') = 'number'
                and (s ->> 'x')::numeric between 0 and 100 and (s ->> 'y')::numeric between 0 and 100, false) is false) then
    raise exception 'Ungültige Position in der Aufstellung.' using errcode = '22023', hint = 'invalid_lineup';
  end if;
  if (select count(*) from jsonb_array_elements(v_slots) s where s ->> 'position' = 'GK') <> 1 then
    raise exception 'Es muss genau ein Torwart aufgestellt sein.' using errcode = '22023', hint = 'invalid_lineup';
  end if;
  if exists (select 1 from jsonb_array_elements(v_slots) s where (s ->> 'player_id') is null)
     or (select count(distinct s ->> 'player_id') from jsonb_array_elements(v_slots) s) <> 11 then
    raise exception 'Alle 11 Positionen müssen mit verschiedenen Spielern besetzt sein.' using errcode = '22023', hint = 'invalid_lineup';
  end if;
  if exists (select 1 from jsonb_array_elements(v_slots) s
             where not exists (select 1 from public.players p where p.id::text = s ->> 'player_id' and p.club_id = v_club)) then
    raise exception 'Ein Spieler gehört nicht zu deinem Kader.' using errcode = '42501', hint = 'foreign_player';
  end if;

  -- Individuelle Anweisungen: nur für aufgestellte Spieler und passend zur Position
  if jsonb_typeof(v_instr) <> 'object' then
    raise exception 'Ungültige Spieleranweisungen.' using errcode = '22023', hint = 'invalid_player_instructions';
  end if;
  for r in select key, value from jsonb_each(v_instr) loop
    if jsonb_typeof(r.value) <> 'array' or not exists (select 1 from jsonb_array_elements(v_slots) s where s ->> 'player_id' = r.key)
       or not public.fd_valid_player_instructions(
            (select (s ->> 'position')::public.player_position from jsonb_array_elements(v_slots) s where s ->> 'player_id' = r.key),
            array(select jsonb_array_elements_text(r.value))) then
      raise exception 'Ungültige oder widersprüchliche Spieleranweisungen.' using errcode = '22023', hint = 'invalid_player_instructions';
    end if;
  end loop;

  select id into v_profile from public.tactical_profiles where club_id = v_club and name = p_profile for update;
  update public.tactical_profiles
  set formation_code = p_data ->> 'formation_code',
      team_instructions = p_data -> 'team_instructions',
      advanced_options = p_data -> 'advanced_options',
      updated_at = now()
  where id = v_profile;

  delete from public.player_instructions where profile_id = v_profile;
  delete from public.tactical_profile_slots where profile_id = v_profile;
  insert into public.tactical_profile_slots(profile_id, slot_index, player_id, position, x, y)
  select v_profile, (s ->> 'slot_index')::smallint, (s ->> 'player_id')::uuid, (s ->> 'position')::public.player_position,
         round((s ->> 'x')::numeric, 2), round((s ->> 'y')::numeric, 2)
  from jsonb_array_elements(v_slots) s;
  insert into public.player_instructions(profile_id, player_id, instructions)
  select v_profile, key::uuid, array(select jsonb_array_elements_text(value))
  from jsonb_each(v_instr) where jsonb_array_length(value) > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- E4/F9: Vereinsweite Einstellungen
-- ---------------------------------------------------------------------
create or replace function public.save_club_tactics(p_world uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_profiles text[] := array['offensive','neutral','defensive'];
  v_enabled boolean := coalesce((p_data ->> 'auto_switch_enabled')::boolean, false);
  v_minute integer;
begin
  if coalesce((p_data ->> 'active_profile') = any (v_profiles)
       and jsonb_typeof(p_data -> 'auto_substitutions') = 'boolean'
       and jsonb_typeof(p_data -> 'auto_switch_enabled') = 'boolean'
       and (p_data ->> 'corner_routine') = any (array['short','near_post','far_post','penalty_spot'])
       and (p_data ->> 'defensive_set_piece') = any (array['zonal','man','mixed']), false) is false then
    raise exception 'Ungültige Einstellungen.' using errcode = '22023', hint = 'invalid_settings';
  end if;
  if v_enabled then
    if coalesce((p_data ->> 'auto_switch_minute') ~ '^[0-9]{1,2}$', false) is false then
      raise exception 'Minute für den automatischen Taktikwechsel fehlt.' using errcode = '22023', hint = 'invalid_settings';
    end if;
    v_minute := (p_data ->> 'auto_switch_minute')::integer;
    if coalesce(v_minute between 1 and 89
       and (p_data ->> 'auto_switch_when_trailing') = any (v_profiles)
       and (p_data ->> 'auto_switch_when_leading') = any (v_profiles), false) is false then
      raise exception 'Automatischer Taktikwechsel: Minute 1–89 und je ein Profil für Rückstand und Führung wählen.' using errcode = '22023', hint = 'invalid_settings';
    end if;
  end if;
  update public.tactics set
    active_profile = (p_data ->> 'active_profile')::public.tactical_profile_name,
    auto_substitutions = (p_data ->> 'auto_substitutions')::boolean,
    auto_switch_enabled = v_enabled,
    auto_switch_minute = case when v_enabled then v_minute end,
    auto_switch_when_trailing = case when v_enabled then (p_data ->> 'auto_switch_when_trailing')::public.tactical_profile_name end,
    auto_switch_when_leading = case when v_enabled then (p_data ->> 'auto_switch_when_leading')::public.tactical_profile_name end,
    corner_routine = p_data ->> 'corner_routine',
    defensive_set_piece = p_data ->> 'defensive_set_piece',
    updated_at = now()
  where club_id = v_club;
end;
$$;

-- F9: Standardschützen inkl. Ersatzschützen; p_data = { "free_kick": [id1, id2, id3], … }
create or replace function public.save_set_pieces(p_world uuid, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  r record;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_data) k where k <> all (array['free_kick','penalty','corner_left','corner_right','throw_in','target_man'])) then
    raise exception 'Ungültige Standards.' using errcode = '22023', hint = 'invalid_set_pieces';
  end if;
  for r in select key, value from jsonb_each(p_data) loop
    if jsonb_typeof(r.value) <> 'array' or jsonb_array_length(r.value) > 3
       or (select count(distinct v) from jsonb_array_elements_text(r.value) v) <> jsonb_array_length(r.value)
       or exists (select 1 from jsonb_array_elements_text(r.value) v
                  where not exists (select 1 from public.players p where p.id::text = v and p.club_id = v_club)) then
      raise exception 'Ungültige Schützen für %.', r.key using errcode = '22023', hint = 'invalid_set_pieces';
    end if;
  end loop;
  delete from public.set_piece_assignments where club_id = v_club;
  insert into public.set_piece_assignments(club_id, world_id, kind, priority, player_id)
  select v_club, p_world, e.key, x.ord::smallint, x.v::uuid
  from jsonb_each(p_data) e, jsonb_array_elements_text(e.value) with ordinality x(v, ord);
end;
$$;

-- ---------------------------------------------------------------------
-- G1: Zusatztraining (max. 5 verschiedene Spieler je Woche, je Spieler 1 Einheit, −20 Fitness)
-- ---------------------------------------------------------------------
create or replace function public.schedule_training(p_world uuid, p_player uuid, p_focus text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_player public.players;
  v_hidden public.player_hidden;
  v_count integer;
  v_points numeric;
begin
  if coalesce(p_focus = any (array['offense','defense','technique','physical','tactics','set_pieces']), false) is false then
    raise exception 'Ungültiger Trainingsschwerpunkt.' using errcode = '22023', hint = 'invalid_focus';
  end if;
  select * into v_world from public.career_worlds where id = p_world;
  select * into v_player from public.players where id = p_player and club_id = v_club for update;
  if not found then
    raise exception 'Dieser Spieler gehört nicht zu deinem Kader.' using errcode = '42501', hint = 'foreign_player';
  end if;
  -- Sperre auf den Verein: parallele Trainingsbuchungen werden nacheinander gezählt
  perform 1 from public.tactics where club_id = v_club for update;
  select count(*) into v_count from public.training_sessions
  where club_id = v_club and season_id = v_world.current_season_id and week_no = v_world.current_week;
  if v_count >= 5 then
    raise exception 'In dieser Woche haben bereits fünf Spieler zusätzlich trainiert.' using errcode = 'P0001', hint = 'training_limit';
  end if;
  begin
    insert into public.training_sessions(world_id, club_id, season_id, week_no, player_id, focus, training_date)
    values (p_world, v_club, v_world.current_season_id, v_world.current_week, p_player, p_focus,
            coalesce(v_world.current_date_in_world, current_date));
  exception when unique_violation then
    raise exception 'Dieser Spieler hat diese Woche schon zusätzlich trainiert.' using errcode = 'P0001', hint = 'already_trained';
  end;

  select * into v_hidden from public.player_hidden where player_id = p_player for update;
  v_points := public.fd_training_points(v_player.age, v_player.overall, v_hidden.potential);
  update public.player_hidden set development_points = development_points + v_points where player_id = p_player;
  update public.players set fitness = greatest(0, fitness - 20) where id = p_player;
  return jsonb_build_object('fitness', greatest(0, v_player.fitness - 20), 'week', v_world.current_week, 'trainees_this_week', v_count + 1);
end;
$$;

-- ---------------------------------------------------------------------
-- I7: Sponsor wählen (genau einer je Saison, in der Saisonvorbereitung änderbar)
-- ---------------------------------------------------------------------
create or replace function public.fd_club_tier(p_club uuid, p_season uuid)
returns smallint
language sql
stable
set search_path = ''
as $$
  select c.tier from public.competition_entries e join public.competitions c on c.id = e.competition_id
  where e.club_id = p_club and c.season_id = p_season and c.kind = 'league' limit 1;
$$;

create or replace function public.choose_sponsor(p_world uuid, p_offer smallint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_tier smallint;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status <> 'preseason' then
    raise exception 'Sponsoren werden zu Beginn der Saison gewählt.' using errcode = 'P0001', hint = 'sponsor_locked';
  end if;
  v_tier := public.fd_club_tier(v_club, v_world.current_season_id);
  if not exists (select 1 from public.sponsor_offers where id = p_offer and tier = v_tier) then
    raise exception 'Dieses Angebot gilt nicht für deine Liga.' using errcode = '22023', hint = 'invalid_sponsor';
  end if;
  insert into public.sponsor_contracts(world_id, club_id, season_id, sponsor_offer_id)
  values (p_world, v_club, v_world.current_season_id, p_offer)
  on conflict (club_id, season_id) do update set sponsor_offer_id = excluded.sponsor_offer_id;
  -- Änderungen heben die Bereitschaft auf
  update public.multiplayer_readiness set ready = false, updated_at = now()
  where world_id = p_world and context = 'preseason' and user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------
-- B2.12: Bereitschaft für den Saisonstart (Sponsor gewählt, aktives Profil vollständig)
-- ---------------------------------------------------------------------
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
end;
$$;

-- ---------------------------------------------------------------------
-- Zustand für die Team-Oberfläche
-- ---------------------------------------------------------------------
create or replace function public.team_context(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    'sponsor_offers', (select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]'::jsonb) from public.sponsor_offers o where o.tier = v_tier),
    'readiness', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', p.username, 'club', c.name,
                                    'ready', coalesce(r.ready, false)) order by m.joined_at), '[]'::jsonb)
                  from public.world_members m join public.profiles p on p.id = m.user_id
                  left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
                  left join public.multiplayer_readiness r on r.world_id = m.world_id and r.user_id = m.user_id and r.context = 'preseason'
                  where m.world_id = p_world)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.fd_valid_team_instructions(jsonb)', 'public.fd_valid_advanced_options(jsonb)',
    'public.fd_allowed_instructions(public.player_position)', 'public.fd_valid_player_instructions(public.player_position, text[])',
    'public.fd_training_points(integer, integer, integer)', 'public.fd_require_team(uuid)', 'public.fd_club_tier(uuid, uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.save_tactical_profile(uuid, public.tactical_profile_name, jsonb)', 'public.save_club_tactics(uuid, jsonb)',
    'public.save_set_pieces(uuid, jsonb)', 'public.schedule_training(uuid, uuid, text)', 'public.choose_sponsor(uuid, smallint)',
    'public.set_preseason_ready(uuid, boolean)', 'public.team_context(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Nachbesserung Phase 2: Wappen- und Trikotprüfung null-sicher machen.
-- Vorher konnte ein Wert null (z. B. "shape": null) die Prüfung umgehen, weil
-- SQL-Vergleiche mit null weder wahr noch falsch ergeben.
-- ---------------------------------------------------------------------
create or replace function public.fd_valid_crest(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k
             where k <> all (array['shape','pattern','symbol','primary','secondary','accent','borderWidth','initials','foundedYear'])) then
    return false;
  end if;
  return coalesce((p ->> 'shape') = any (array['shield','classic','round','diamond','hexagon','banner'])
     and (p ->> 'pattern') = any (array['solid','halves','stripes','hoops','sash','quarters','chevron'])
     and (p ->> 'symbol') = any (array['none','ball','lion','eagle','crown','star','lightning'])
     and public.is_hex_color(p ->> 'primary')
     and public.is_hex_color(p ->> 'secondary')
     and public.is_hex_color(p ->> 'accent')
     and jsonb_typeof(p -> 'borderWidth') = 'number'
     and (p ->> 'borderWidth') ~ '^[0-6]$'
     and jsonb_typeof(p -> 'initials') = 'string'
     and (p ->> 'initials') ~ '^[A-ZÄÖÜ0-9.&]{1,4}$'
     and (jsonb_typeof(p -> 'foundedYear') = 'null'
          or (jsonb_typeof(p -> 'foundedYear') = 'number' and (p ->> 'foundedYear') ~ '^[0-9]{4}$'
              and (p ->> 'foundedYear')::int between 1850 and 2100)), false);
end;
$$;

create or replace function public.fd_valid_kit(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (array['pattern','primary','secondary'])) then
    return false;
  end if;
  return coalesce((p ->> 'pattern') = any (array['solid','stripes','hoops','halves','sash'])
     and public.is_hex_color(p ->> 'primary')
     and public.is_hex_color(p ->> 'secondary'), false);
end;
$$;
revoke execute on function public.fd_valid_crest(jsonb) from public, anon, authenticated;
revoke execute on function public.fd_valid_kit(jsonb) from public, anon, authenticated;

grant all on all tables in schema public to service_role;
