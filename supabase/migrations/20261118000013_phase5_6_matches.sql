-- =====================================================================
-- Migration 0013: Phase 5 + 6 – Match Engine und Live-Spiele
-- Testspiele (bis der Saisonkalender in Phase 7 kommt), Spielaufbau für den
-- autoritativen Match-Server, Checkpoints und idempotentes Speichern der Ergebnisse.
-- Clients lesen nur; alles Schreibende läuft über diese Funktionen.
-- =====================================================================

alter type public.competition_kind add value if not exists 'friendly';

alter table public.match_sessions add column if not exists last_tick integer not null default 0;
alter table public.match_sessions add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------------------
-- Testspiel anlegen
-- ---------------------------------------------------------------------
create or replace function public.fd_friendly_competition(p_world uuid, p_season uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid;
begin
  select id into v_id from public.competitions where season_id = p_season and kind::text = 'friendly';
  if v_id is null then
    insert into public.competitions(world_id, season_id, kind, name)
    values (p_world, p_season, 'friendly'::text::public.competition_kind, 'Testspiele')
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.create_friendly(p_world uuid, p_opponent uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_opp public.clubs;
  v_comp uuid;
  v_id uuid;
begin
  select * into v_world from public.career_worlds where id = p_world;
  select * into v_opp from public.clubs where id = p_opponent and world_id = p_world;
  if not found or v_opp.id = v_club then
    raise exception 'Ungültiger Gegner.' using errcode = 'P0001', hint = 'invalid_opponent';
  end if;
  if (select count(*) from public.players where club_id = p_opponent) < 11
     or (select count(*) from public.players where club_id = v_club) < 11 then
    raise exception 'Beide Vereine brauchen mindestens 11 Spieler.' using errcode = 'P0001', hint = 'squad_too_small';
  end if;
  -- Höchstens ein offenes Testspiel je Verein
  if exists (select 1 from public.fixtures f join public.competitions c on c.id = f.competition_id
             where c.kind::text = 'friendly' and f.status in ('scheduled', 'live')
               and (v_club in (f.home_club_id, f.away_club_id) or p_opponent in (f.home_club_id, f.away_club_id))) then
    raise exception 'Einer der Vereine hat bereits ein offenes Testspiel.' using errcode = 'P0001', hint = 'friendly_open';
  end if;
  if (select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id
      where c.kind::text = 'friendly' and f.created_at > now() - interval '1 day'
        and v_club in (f.home_club_id, f.away_club_id)) >= 20 then
    raise exception 'Heute sind keine weiteren Testspiele möglich.' using errcode = 'P0001', hint = 'friendly_limit';
  end if;
  v_comp := public.fd_friendly_competition(p_world, v_world.current_season_id);
  insert into public.fixtures(world_id, season_id, competition_id, slot_key, scheduled_date, home_club_id, away_club_id)
  values (p_world, v_world.current_season_id, v_comp, 'friendly:' || gen_random_uuid()::text,
          coalesce(v_world.current_date_in_world, current_date), v_club, p_opponent)
  returning id into v_id;
  return v_id;
end;
$$;

-- Offenes Testspiel absagen (nur bevor es läuft)
create or replace function public.cancel_friendly(p_fixture uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_f public.fixtures;
begin
  select f.* into v_f from public.fixtures f join public.competitions c on c.id = f.competition_id
  where f.id = p_fixture and c.kind::text = 'friendly';
  if not found then raise exception 'Testspiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if not (public.is_club_manager(v_f.home_club_id) or public.is_club_manager(v_f.away_club_id)) then
    raise exception 'Nicht dein Spiel.' using errcode = '42501', hint = 'forbidden';
  end if;
  if v_f.status <> 'scheduled' then
    raise exception 'Das Spiel läuft bereits oder ist beendet.' using errcode = 'P0001', hint = 'not_cancellable';
  end if;
  update public.fixtures set status = 'cancelled' where id = p_fixture;
end;
$$;

-- Spiele des eigenen Vereins (Testspiele jetzt, Pflichtspiele ab Phase 7)
create or replace function public.my_fixtures(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_club uuid;
begin
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  return coalesce((
    select jsonb_agg(row order by (row ->> 'created_at') desc)
    from (
      select jsonb_build_object(
        'id', f.id, 'kind', c.kind, 'status', f.status, 'scheduled_date', f.scheduled_date, 'created_at', f.created_at,
        'home', jsonb_build_object('id', h.id, 'name', h.name, 'short_name', h.short_name, 'control', h.control, 'color', hb.primary_color),
        'away', jsonb_build_object('id', a.id, 'name', a.name, 'short_name', a.short_name, 'control', a.control, 'color', ab.primary_color),
        'mine', v_club in (f.home_club_id, f.away_club_id),
        'result', case when public.can_see_fixture_result(f.id) then
                    (select jsonb_build_object('home', r.home_goals, 'away', r.away_goals) from public.fixture_results r where r.fixture_id = f.id) end
      ) as row
      from public.fixtures f
      join public.competitions c on c.id = f.competition_id
      join public.clubs h on h.id = f.home_club_id
      join public.clubs a on a.id = f.away_club_id
      left join public.club_branding hb on hb.club_id = h.id
      left join public.club_branding ab on ab.club_id = a.id
      where f.world_id = p_world and f.status <> 'cancelled'
        and (v_club in (f.home_club_id, f.away_club_id) or f.status = 'live')
      order by f.created_at desc
      limit 30
    ) s
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Match-Server (nur service_role)
-- ---------------------------------------------------------------------
-- Rolle eines Nutzers in einer Partie: home / away / spectator / null
create or replace function public.admin_match_role(p_fixture uuid, p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when h.manager_user_id = p_user then 'home'
    when a.manager_user_id = p_user then 'away'
    when exists (select 1 from public.world_members m where m.world_id = f.world_id and m.user_id = p_user) then 'spectator'
  end
  from public.fixtures f
  join public.clubs h on h.id = f.home_club_id
  join public.clubs a on a.id = f.away_club_id
  where f.id = p_fixture;
$$;

create or replace function public.fd_match_team(p_club uuid, p_date date)
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

-- Alles, was der Server für den Start oder die Wiederaufnahme braucht. Setzt den Status auf „live“.
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
begin
  select * into v_f from public.fixtures where id = p_fixture for update;
  if not found then raise exception 'Spiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_f.status not in ('scheduled', 'live') then
    raise exception 'Das Spiel ist bereits beendet.' using errcode = 'P0001', hint = 'already_finished';
  end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;
  if v_f.status = 'scheduled' then
    update public.fixtures set status = 'live' where id = p_fixture;
  end if;
  insert into public.match_sessions(fixture_id, world_id, mode, engine_version)
  values (p_fixture, v_f.world_id, 'live', '1')
  on conflict (fixture_id) do update set status = 'running', updated_at = now()
  returning * into v_session;
  return jsonb_build_object(
    'fixtureId', v_f.id, 'worldId', v_f.world_id, 'seed', v_f.rng_seed, 'kind', v_kind, 'neutral', v_f.neutral_venue,
    'home', public.fd_match_team(v_f.home_club_id, v_date),
    'away', public.fd_match_team(v_f.away_club_id, v_date),
    'checkpoint', v_session.checkpoint
  );
end;
$$;

-- Checkpoint (Befehlsprotokoll + Tick) für die Wiederaufnahme nach einem Serverneustart
create or replace function public.admin_match_checkpoint(p_fixture uuid, p_tick integer, p_checkpoint jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.match_sessions set checkpoint = p_checkpoint, last_tick = p_tick, updated_at = now()
  where fixture_id = p_fixture and status = 'running';
$$;

-- Ergebnis speichern – idempotent: ein zweiter Aufruf ändert nichts.
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

  insert into public.fixture_results(fixture_id, world_id, home_goals, away_goals, home_xg, away_xg, home_possession, summary)
  values (p_fixture, v_f.world_id, v_hg, v_ag,
          (p_result -> 'stats' -> 'home' ->> 'xg')::numeric, (p_result -> 'stats' -> 'away' ->> 'xg')::numeric,
          (p_result ->> 'possessionHome')::numeric,
          jsonb_build_object('stats', p_result -> 'stats', 'playerOfTheMatch', p_result -> 'playerOfTheMatch'));

  insert into public.match_events(fixture_id, world_id, match_second, type, club_id, player_id, secondary_player_id, payload)
  select p_fixture, v_f.world_id, greatest(0, round((e ->> 'tick')::numeric * 0.75))::int, e ->> 'type',
         (v_side_club ->> (e ->> 'side'))::uuid,
         (select p.id from public.players p where p.id::text = e ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         (select p.id from public.players p where p.id::text = e ->> 'otherId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         jsonb_build_object('minute', e -> 'minute', 'text', e -> 'text', 'xg', e -> 'xg')
  from jsonb_array_elements(coalesce(p_result -> 'events', '[]'::jsonb)) e
  where e ->> 'type' in ('kickoff','goal','save','chance','woodwork','yellow','second_yellow','red','injury','sub','halftime','fulltime','penalty','tactic','miss');

  insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, goals, assists, shots, shots_on_target, xg,
    passes, passes_completed, tackles_won, interceptions, saves, rating, fitness_start, fitness_end)
  select p_fixture, p.id, p.club_id, v_f.world_id,
         least(120, (s ->> 'minutes')::int), (s ->> 'goals')::int, (s ->> 'assists')::int, (s ->> 'shots')::int, (s ->> 'shotsOnTarget')::int,
         (s ->> 'xg')::numeric, least(32000, (s ->> 'passes')::int), least(32000, (s ->> 'passesCompleted')::int), (s ->> 'tacklesWon')::int,
         (s ->> 'interceptions')::int, (s ->> 'saves')::int, (s ->> 'rating')::numeric,
         greatest(0, least(100, (s ->> 'fitnessStart')::numeric)), greatest(0, least(100, (s ->> 'fitnessEnd')::numeric))
  from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
  join public.players p on p.id::text = s ->> 'playerId'
  where p.club_id = (v_side_club ->> (s ->> 'side'))::uuid
  on conflict do nothing;

  -- Testspiele: Ergebnis sofort für alle sichtbar, keine dauerhaften Fitness-/Kartenfolgen.
  -- Pflichtspiele (ab Phase 7): Fitness übernehmen, Freigabe erst gemeinsam (B4).
  if v_kind <> 'friendly' then
    update public.players p set fitness = greatest(0, least(100, (s ->> 'fitnessEnd')::numeric))
    from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
    where p.id::text = s ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id);
  end if;
  update public.fixtures set status = (case when v_kind = 'friendly' then 'released' else 'finished' end)::public.fixture_status,
                             released_at = case when v_kind = 'friendly' then now() else released_at end
  where id = p_fixture;
  update public.match_sessions set status = 'finished', finished_at = now(), updated_at = now() where fixture_id = p_fixture;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- Partie abbrechen (z. B. Kader ungültig) – Testspiel wird abgesagt
create or replace function public.admin_abort_match(p_fixture uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.match_sessions set status = 'aborted', finished_at = now() where fixture_id = p_fixture and status = 'running';
  update public.fixtures f set status = 'cancelled'
  where f.id = p_fixture and f.status in ('scheduled', 'live')
    and exists (select 1 from public.competitions c where c.id = f.competition_id and c.kind::text = 'friendly');
end;
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.fd_friendly_competition(uuid, uuid)', 'public.fd_match_team(uuid, date)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.create_friendly(uuid, uuid)', 'public.cancel_friendly(uuid)', 'public.my_fixtures(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.admin_match_role(uuid, uuid)', 'public.admin_match_setup(uuid)', 'public.admin_match_checkpoint(uuid, integer, jsonb)',
    'public.admin_finish_match(uuid, jsonb)', 'public.admin_abort_match(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
grant execute on function public.fd_match_team(uuid, date) to service_role;
grant execute on function public.fd_friendly_competition(uuid, uuid) to service_role;
grant all on all tables in schema public to service_role;
