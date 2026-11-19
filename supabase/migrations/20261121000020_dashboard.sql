-- =====================================================================
-- Migration 0020: Dashboard, Spieltagsübersicht, Spieler- und Vereinsprofile
--   Grundsatz: Alle Auswertungen lesen nur freigegebene Spiele (status = 'released') – verborgene
--   Ergebnisse laufender Termine sind über keine dieser Funktionen erreichbar.
--   Geheime Taktiken, Anweisungen und geplante Aufstellungen anderer Manager werden nie ausgegeben;
--   sichtbar ist nur die Startelf/Formation aus bereits freigegebenen Spielen.
-- =====================================================================

-- Gesehene Spieltagsübersichten je Manager (Pflichtübersicht nach jeder Freigabe, übersteht Neuladen)
create table if not exists public.matchday_reviews (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null references public.season_slots(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (user_id, slot_id)
);
alter table public.matchday_reviews enable row level security;

create or replace function public.fd_club_color(p_club uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce((select primary_color from public.club_branding where club_id = p_club), '#3a4a3a')
$$;

create or replace function public.fd_club_ref(p_club uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name, 'control', c.control,
    'color', coalesce(b.primary_color, '#3a4a3a'), 'color2', coalesce(b.secondary_color, '#ffffff'), 'crest', b.crest)
  from public.clubs c left join public.club_branding b on b.club_id = c.id where c.id = p_club
$$;

-- Ligawettbewerb eines Vereins in einer Saison
create or replace function public.fd_league_of(p_club uuid, p_season uuid)
returns uuid language sql stable set search_path = '' as $$
  select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
  where e.club_id = p_club and c.season_id = p_season and c.kind = 'league' limit 1
$$;

-- Tabelle mit Zusatzspalten (nur aus freigegebenen Spielen fortgeschrieben)
create or replace function public.fd_table_rows(p_comp uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('pos', t.pos, 'club', public.fd_club_ref(t.club_id), 'played', s.played, 'won', s.won, 'drawn', s.drawn,
    'lost', s.lost, 'gf', s.goals_for, 'ga', s.goals_against, 'gd', t.gd, 'points', t.points) order by t.pos), '[]'::jsonb)
  from public.fd_table(p_comp) t join public.standings s on s.club_id = t.club_id and s.competition_id = p_comp and s.group_id is null
$$;

-- ---------------------------------------------------------------------
-- Pflicht-Spieltagsübersicht
-- ---------------------------------------------------------------------
create or replace function public.pending_review(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_member public.world_members := public.fd_require_member(p_world); v_slot public.season_slots;
begin
  select s.* into v_slot from public.season_slots s join public.career_worlds w on w.id = s.world_id and w.current_season_id = s.season_id
  where s.world_id = p_world and s.state = 'released' and s.kind <> 'season_end'
  order by s.ordinal desc limit 1;
  if v_slot.id is null or exists (select 1 from public.matchday_reviews r where r.user_id = v_member.user_id and r.slot_id = v_slot.id) then
    return null;
  end if;
  return jsonb_build_object('slot_id', v_slot.id, 'label', v_slot.label, 'date', v_slot.slot_date);
end;
$$;

create or replace function public.mark_review_seen(p_world uuid, p_slot uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_member public.world_members := public.fd_require_member(p_world);
begin
  if not exists (select 1 from public.season_slots where id = p_slot and world_id = p_world and state = 'released') then
    raise exception 'Termin nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  insert into public.matchday_reviews(world_id, user_id, slot_id) values (p_world, v_member.user_id, p_slot) on conflict do nothing;
end;
$$;

create or replace function public.matchday_report(p_world uuid, p_slot uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_slot public.season_slots;
  v_club uuid;
  v_comp uuid;
  v_out jsonb;
begin
  select * into v_slot from public.season_slots where id = p_slot and world_id = p_world;
  if v_slot.id is null or v_slot.state <> 'released' then
    raise exception 'Die Ergebnisse dieses Termins sind noch nicht freigegeben.' using errcode = 'P0001', hint = 'not_released';
  end if;
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  v_comp := public.fd_league_of(v_club, v_slot.season_id);

  with fx as (
    select f.*, c.name as comp_name, c.kind::text as comp_kind, coalesce(c.tier, 9) as comp_tier, r.home_goals, r.away_goals, r.home_penalties, r.away_penalties, r.attendance
    from public.fixtures f join public.competitions c on c.id = f.competition_id join public.fixture_results r on r.fixture_id = f.id
    where f.world_id = p_world and f.season_id = v_slot.season_id and f.slot_key = v_slot.slot_key and f.status = 'released' and c.kind::text <> 'friendly'
  ),
  games as (
    select fx.competition_id, fx.comp_name, fx.comp_kind, fx.comp_tier, jsonb_agg(jsonb_build_object(
      'id', fx.id, 'home', public.fd_club_ref(fx.home_club_id), 'away', public.fd_club_ref(fx.away_club_id),
      'hg', fx.home_goals, 'ag', fx.away_goals, 'hp', fx.home_penalties, 'ap', fx.away_penalties, 'attendance', fx.attendance,
      'mine', v_club in (fx.home_club_id, fx.away_club_id),
      'events', coalesce((select jsonb_agg(jsonb_build_object('type', e.type, 'minute', coalesce((e.payload ->> 'minute')::int, e.match_second / 60 + 1),
                   'player_id', e.player_id, 'name', p.first_name || ' ' || p.last_name, 'home', e.club_id = fx.home_club_id) order by e.match_second)
                 from public.match_events e join public.players p on p.id = e.player_id
                 where e.fixture_id = fx.id and e.type in ('goal', 'red', 'second_yellow')), '[]'::jsonb)
    ) order by (v_club in (fx.home_club_id, fx.away_club_id)) desc, fx.id) as games
    from fx group by fx.competition_id, fx.comp_name, fx.comp_kind, fx.comp_tier
  ),
  delta as (
    select club_id, sum(pts) as pts, sum(gf) as gf, sum(ga) as ga, count(*) as games from (
      select fx.home_club_id as club_id, case when fx.home_goals > fx.away_goals then 3 when fx.home_goals = fx.away_goals then 1 else 0 end as pts, fx.home_goals as gf, fx.away_goals as ga
      from fx where fx.competition_id = v_comp
      union all
      select fx.away_club_id, case when fx.away_goals > fx.home_goals then 3 when fx.home_goals = fx.away_goals then 1 else 0 end, fx.away_goals, fx.home_goals
      from fx where fx.competition_id = v_comp) d group by club_id
  ),
  prev as (
    select s.club_id, (row_number() over (order by s.points - coalesce(d.pts, 0) desc,
             (s.goals_for - coalesce(d.gf, 0)) - (s.goals_against - coalesce(d.ga, 0)) desc, s.goals_for - coalesce(d.gf, 0) desc, c.name))::int as prev_pos,
           s.played - coalesce(d.games, 0) as prev_played
    from public.standings s join public.clubs c on c.id = s.club_id left join delta d on d.club_id = s.club_id
    where s.competition_id = v_comp and s.group_id is null
  ),
  slot_stats as (
    select ms.*, p.first_name || ' ' || p.last_name as name from public.match_player_stats ms join public.players p on p.id = ms.player_id
    where ms.fixture_id in (select id from fx)
  )
  select jsonb_build_object(
    'slot', jsonb_build_object('id', v_slot.id, 'label', v_slot.label, 'date', v_slot.slot_date, 'kind', v_slot.kind, 'matchday', v_slot.matchday),
    'my_club', v_club,
    'competitions', coalesce((select jsonb_agg(jsonb_build_object('id', g.competition_id, 'name', g.comp_name, 'kind', g.comp_kind, 'games', g.games)
                     order by case g.comp_kind when 'league' then 0 else 1 end, g.comp_tier) from games g), '[]'::jsonb),
    'table', case when v_comp is null then null else (
      select jsonb_build_object('name', (select name from public.competitions where id = v_comp),
        'rows', coalesce(jsonb_agg(jsonb_build_object('pos', t.pos, 'prev', case when pr.prev_played > 0 then pr.prev_pos end, 'club', public.fd_club_ref(t.club_id),
                 'played', s.played, 'gf', s.goals_for, 'ga', s.goals_against, 'gd', t.gd, 'points', t.points, 'mine', t.club_id = v_club) order by t.pos), '[]'::jsonb))
      from public.fd_table(v_comp) t join public.standings s on s.club_id = t.club_id and s.competition_id = v_comp and s.group_id is null
      left join prev pr on pr.club_id = t.club_id) end,
    'top_ratings', coalesce((select jsonb_agg(x) from (select jsonb_build_object('player_id', ss.player_id, 'name', ss.name, 'club', public.fd_club_ref(ss.club_id),
                     'rating', ss.rating, 'goals', ss.goals, 'assists', ss.assists) as x
                     from slot_stats ss where ss.minutes >= 45 and ss.rating is not null order by ss.rating desc, ss.goals desc limit 5) y), '[]'::jsonb),
    'top_scorers', coalesce((select jsonb_agg(x) from (select jsonb_build_object('player_id', ss.player_id, 'name', ss.name, 'club', public.fd_club_ref(ss.club_id),
                     'goals', ss.goals, 'assists', ss.assists) as x
                     from slot_stats ss where ss.goals > 0 order by ss.goals desc, ss.assists desc, ss.rating desc nulls last limit 5) y), '[]'::jsonb),
    'seen', exists (select 1 from public.matchday_reviews r where r.user_id = v_member.user_id and r.slot_id = v_slot.id)
  ) into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------
-- Dashboard
-- ---------------------------------------------------------------------
create or replace function public.dashboard(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_club uuid;
  v_comp uuid;
  v_next record;
begin
  select * into v_world from public.career_worlds where id = p_world;
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  v_comp := public.fd_league_of(v_club, v_world.current_season_id);
  select * into v_next from public.fd_next_fixture(v_club);
  return jsonb_build_object(
    'my_club', public.fd_club_ref(v_club),
    'league', case when v_comp is null then null else jsonb_build_object('id', v_comp, 'name', (select name from public.competitions where id = v_comp), 'rows', public.fd_table_rows(v_comp)) end,
    'next', case when v_next.fixture_id is null then null else (
      select jsonb_build_object('id', f.id, 'date', f.scheduled_date, 'status', f.status, 'home', f.home_club_id = v_club,
        'opponent', public.fd_club_ref(case when f.home_club_id = v_club then f.away_club_id else f.home_club_id end),
        'competition', c.name, 'kind', c.kind, 'matchday', f.matchday, 'leg', f.leg, 'neutral', f.neutral_venue,
        'label', (select s.label from public.season_slots s where s.season_id = f.season_id and s.slot_key = f.slot_key),
        'stadium', (select st.name from public.stadiums st where st.club_id = case when f.neutral_venue then null else f.home_club_id end))
      from public.fixtures f join public.competitions c on c.id = f.competition_id where f.id = v_next.fixture_id) end,
    'calendar', coalesce((select jsonb_agg(x order by (x ->> 'date'), x ->> 'id') from (
        select jsonb_build_object('id', f.id, 'date', f.scheduled_date, 'status', f.status, 'home', f.home_club_id = v_club, 'competition', c.name, 'kind', c.kind,
          'label', (select s.label from public.season_slots s where s.season_id = f.season_id and s.slot_key = f.slot_key),
          'opponent', public.fd_club_ref(case when f.home_club_id = v_club then f.away_club_id else f.home_club_id end)) as x
        from public.fixtures f join public.competitions c on c.id = f.competition_id
        where (f.home_club_id = v_club or f.away_club_id = v_club) and f.status in ('scheduled', 'live') and c.kind::text <> 'friendly'
        order by f.scheduled_date limit 6) q), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by (x ->> 'date') desc) from (
        select jsonb_build_object('id', f.id, 'date', f.scheduled_date, 'home', f.home_club_id = v_club, 'competition', c.name,
          'opponent', public.fd_club_ref(case when f.home_club_id = v_club then f.away_club_id else f.home_club_id end),
          'gf', case when f.home_club_id = v_club then r.home_goals else r.away_goals end, 'ga', case when f.home_club_id = v_club then r.away_goals else r.home_goals end) as x
        from public.fixtures f join public.competitions c on c.id = f.competition_id join public.fixture_results r on r.fixture_id = f.id
        where (f.home_club_id = v_club or f.away_club_id = v_club) and f.status = 'released' and c.kind::text <> 'friendly'
        order by f.scheduled_date desc limit 5) q), '[]'::jsonb),
    'leaders', case when v_comp is null then null else public.league_leaders(v_comp) end,
    'best_offense', (select jsonb_build_object('club', public.fd_club_ref(s.club_id), 'value', s.goals_for, 'played', s.played) from public.standings s
                     where s.competition_id = v_comp and s.group_id is null and s.played > 0 order by s.goals_for desc, s.goals_against limit 1),
    'best_defense', (select jsonb_build_object('club', public.fd_club_ref(s.club_id), 'value', s.goals_against, 'played', s.played) from public.standings s
                     where s.competition_id = v_comp and s.group_id is null and s.played > 0 order by s.goals_against, s.goals_for desc limit 1),
    'pending_review', public.pending_review(p_world)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Spielerprofil (öffentliche Werte; Gehalt und Entwicklung nur für den eigenen Verein)
-- ---------------------------------------------------------------------
create or replace function public.player_profile(p_player uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_own boolean;
begin
  select * into v_p from public.players where id = p_player;
  if v_p.id is null or not public.is_world_member(v_p.world_id) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  v_own := v_p.club_id is not null and public.is_club_manager(v_p.club_id);
  return jsonb_build_object(
    'id', v_p.id, 'first_name', v_p.first_name, 'last_name', v_p.last_name, 'age', v_p.age, 'nationality', v_p.nationality,
    'main_position', v_p.main_position, 'secondary_positions', v_p.secondary_positions, 'overall', v_p.overall, 'fitness', v_p.fitness,
    'market_value', v_p.market_value, 'shirt', v_p.shirt_number, 'retired', v_p.retired,
    'attributes', (select jsonb_build_object('kind', pa.kind, 'values', pa.attributes) from public.player_attributes pa where pa.player_id = v_p.id),
    'club', case when v_p.club_id is null then null else public.fd_club_ref(v_p.club_id) end,
    'free_agent', (select jsonb_build_object('salary', fa.annual_salary) from public.free_agents fa where fa.player_id = v_p.id),
    'contract', (select jsonb_build_object('start', pc.start_season_year, 'end', pc.end_season_year, 'salary', case when v_own then pc.annual_salary end)
                 from public.player_contracts pc where pc.player_id = v_p.id and pc.active),
    'status', case when v_p.club_id is null then null else public.fd_player_availability(v_p.club_id) -> v_p.id::text end,
    'season', (select jsonb_build_object('apps', count(*), 'minutes', coalesce(sum(ms.minutes), 0), 'goals', coalesce(sum(ms.goals), 0), 'assists', coalesce(sum(ms.assists), 0),
                 'rating', round(avg(ms.rating), 2), 'shots', coalesce(sum(ms.shots), 0), 'xg', coalesce(sum(ms.xg), 0))
               from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id
               where ms.player_id = v_p.id and f.status = 'released' and f.season_id = v_world.current_season_id),
    'by_competition', coalesce((select jsonb_agg(jsonb_build_object('competition', c.name, 'apps', x.apps, 'goals', x.goals, 'assists', x.assists, 'rating', x.rating))
               from (select f.competition_id, count(*) as apps, sum(ms.goals) as goals, sum(ms.assists) as assists, round(avg(ms.rating), 2) as rating
                     from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id
                     where ms.player_id = v_p.id and f.status = 'released' and f.season_id = v_world.current_season_id group by f.competition_id) x
               join public.competitions c on c.id = x.competition_id), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('season', s.year, 'apps', x.apps, 'goals', x.goals, 'assists', x.assists, 'rating', x.rating) order by s.year desc)
               from (select f.season_id, count(*) as apps, sum(ms.goals) as goals, sum(ms.assists) as assists, round(avg(ms.rating), 2) as rating
                     from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id
                     where ms.player_id = v_p.id and f.status = 'released' group by f.season_id) x
               join public.seasons s on s.id = x.season_id), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by (x ->> 'date') desc) from (
               select jsonb_build_object('date', f.scheduled_date, 'competition', c.name, 'rating', ms.rating, 'goals', ms.goals, 'assists', ms.assists, 'minutes', ms.minutes,
                 'opponent', public.fd_club_ref(case when f.home_club_id = ms.club_id then f.away_club_id else f.home_club_id end)) as x
               from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.competitions c on c.id = f.competition_id
               where ms.player_id = v_p.id and f.status = 'released' order by f.scheduled_date desc limit 6) q), '[]'::jsonb),
    'development', case when v_own then jsonb_build_object(
        'points', (select development_points from public.player_hidden where player_id = v_p.id),
        'trainings', (select count(*) from public.training_sessions t where t.player_id = v_p.id and t.season_id = v_world.current_season_id)) end,
    'own', v_own
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Vereinsprofil (Scouting): Kader, Stärke, zuletzt bekannte Formation, Ergebnisse
-- ---------------------------------------------------------------------
create or replace function public.club_profile(p_club uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.clubs;
  v_world public.career_worlds;
  v_comp uuid;
  v_last record;
  v_av jsonb;
begin
  select * into v_c from public.clubs where id = p_club;
  if v_c.id is null or not public.is_world_member(v_c.world_id) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_c.world_id;
  v_comp := public.fd_league_of(p_club, v_world.current_season_id);
  v_av := public.fd_player_availability(p_club);
  -- letzte freigegebene Partie mit gespeicherter Startelf
  select f.id, f.home_club_id = p_club as is_home, r.summary -> 'lineups' -> (case when f.home_club_id = p_club then 'home' else 'away' end) as lineup, f.scheduled_date
  into v_last
  from public.fixtures f join public.fixture_results r on r.fixture_id = f.id
  where (f.home_club_id = p_club or f.away_club_id = p_club) and f.status = 'released'
    and r.summary -> 'lineups' -> (case when f.home_club_id = p_club then 'home' else 'away' end) is not null
  order by f.scheduled_date desc limit 1;
  return jsonb_build_object(
    'club', public.fd_club_ref(p_club),
    'founded', v_c.founded_year, 'reputation', v_c.reputation, 'amateur', v_c.amateur,
    'country', (select jsonb_build_object('code', a.code, 'name', a.name) from public.associations a where a.code = v_c.association_code),
    'league', coalesce((select name from public.competitions where id = v_comp), v_c.league_name, case when v_c.amateur then 'Amateurliga' end),
    'manager', (select p.username from public.profiles p where p.id = v_c.manager_user_id),
    'stadium', (select jsonb_build_object('name', s.name, 'capacity', s.capacity) from public.stadiums s where s.club_id = p_club),
    'position', (select t.pos from public.fd_table(v_comp) t where t.club_id = p_club),
    'table_size', (select count(*) from public.standings s where s.competition_id = v_comp and s.group_id is null),
    'strength', (select round(avg(o), 1) from (select p.overall as o from public.players p where p.club_id = p_club and not p.retired order by p.overall desc limit 11) x),
    'squad_avg', (select round(avg(p.overall), 1) from public.players p where p.club_id = p_club and not p.retired),
    'squad', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.first_name || ' ' || p.last_name, 'last_name', p.last_name, 'shirt', p.shirt_number,
               'position', p.main_position, 'age', p.age, 'overall', p.overall, 'nationality', p.nationality, 'fitness', p.fitness,
               'rating', st.rating, 'apps', coalesce(st.apps, 0), 'goals', coalesce(st.goals, 0), 'assists', coalesce(st.assists, 0),
               'status', v_av -> p.id::text)
               order by case p.main_position when 'GK' then 0 when 'CB' then 1 when 'LB' then 2 when 'RB' then 3 when 'LWB' then 4 when 'RWB' then 5 when 'CDM' then 6
                 when 'CM' then 7 when 'CAM' then 8 when 'LM' then 9 when 'RM' then 10 when 'LW' then 11 when 'RW' then 12 when 'CF' then 13 else 14 end, p.overall desc)
             from public.players p
             left join lateral (select count(*) as apps, round(avg(ms.rating), 2) as rating, sum(ms.goals) as goals, sum(ms.assists) as assists
                                from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id
                                where ms.player_id = p.id and f.status = 'released' and f.season_id = v_world.current_season_id) st on true
             where p.club_id = p_club and not p.retired), '[]'::jsonb),
    'formation', case when v_last.id is null then null else jsonb_build_object('date', v_last.scheduled_date, 'code', v_last.lineup ->> 'formation',
        'slots', (select jsonb_agg(jsonb_build_object('player_id', sl ->> 'playerId', 'position', sl ->> 'position', 'x', (sl ->> 'x')::numeric, 'y', (sl ->> 'y')::numeric,
                   'name', p.last_name, 'shirt', p.shirt_number, 'overall', p.overall))
                  from jsonb_array_elements(v_last.lineup -> 'slots') sl left join public.players p on p.id::text = sl ->> 'playerId')) end,
    'results', coalesce((select jsonb_agg(x order by (x ->> 'date') desc) from (
        select jsonb_build_object('id', f.id, 'date', f.scheduled_date, 'competition', c.name, 'home', f.home_club_id = p_club,
          'opponent', public.fd_club_ref(case when f.home_club_id = p_club then f.away_club_id else f.home_club_id end),
          'gf', case when f.home_club_id = p_club then r.home_goals else r.away_goals end, 'ga', case when f.home_club_id = p_club then r.away_goals else r.home_goals end,
          'pf', case when f.home_club_id = p_club then r.home_penalties else r.away_penalties end, 'pa', case when f.home_club_id = p_club then r.away_penalties else r.home_penalties end) as x
        from public.fixtures f join public.competitions c on c.id = f.competition_id join public.fixture_results r on r.fixture_id = f.id
        where (f.home_club_id = p_club or f.away_club_id = p_club) and f.status = 'released' and f.season_id = v_world.current_season_id and c.kind::text <> 'friendly') q), '[]'::jsonb)
  );
end;
$$;

-- Startelf/Formation im Ergebnis speichern (öffentlich nach Freigabe)
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
  v_scope public.discipline_scope;
  v_date date;
  v_att integer;
  v_pen int[];
  v_needs_pen boolean := false;
  v_first public.fixture_results;
  r record;
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
  v_scope := public.fd_fixture_scope(p_fixture);
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;

  -- K.-o.: Elfmeterschießen bei Gleichstand (Einzelspiel bzw. Gesamtergebnis nach dem Rückspiel)
  if v_f.tie_id is not null then
    if v_f.leg is null then
      v_needs_pen := v_hg = v_ag;
    elsif v_f.leg = 2 then
      select r2.* into v_first from public.fixture_results r2 join public.fixtures f1 on f1.id = r2.fixture_id
      where f1.tie_id = v_f.tie_id and f1.leg = 1;
      -- Hinspiel: Gastgeber des Rückspiels war Gast
      v_needs_pen := v_first.fixture_id is not null and (v_hg + v_first.away_goals) = (v_ag + v_first.home_goals);
    end if;
    if v_needs_pen then v_pen := public.fd_shootout(p_fixture); end if;
  end if;
  v_att := case when v_kind = 'friendly' then null else public.fd_expected_attendance(p_fixture) end;

  insert into public.fixture_results(fixture_id, world_id, home_goals, away_goals, home_xg, away_xg, home_possession, summary,
                                     attendance, home_penalties, away_penalties)
  values (p_fixture, v_f.world_id, v_hg, v_ag,
          (p_result -> 'stats' -> 'home' ->> 'xg')::numeric, (p_result -> 'stats' -> 'away' ->> 'xg')::numeric,
          (p_result ->> 'possessionHome')::numeric,
          jsonb_build_object('stats', p_result -> 'stats', 'playerOfTheMatch', p_result -> 'playerOfTheMatch', 'lineups', p_result -> 'lineups'),
          v_att, v_pen[1], v_pen[2]);

  insert into public.match_events(fixture_id, world_id, match_second, type, club_id, player_id, secondary_player_id, payload)
  select p_fixture, v_f.world_id, greatest(0, round(coalesce((e ->> 'second')::numeric, (e ->> 'tick')::numeric * 0.75)))::int, e ->> 'type',
         (v_side_club ->> (e ->> 'side'))::uuid,
         (select p.id from public.players p where p.id::text = e ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         (select p.id from public.players p where p.id::text = e ->> 'otherId' and p.club_id in (v_f.home_club_id, v_f.away_club_id)),
         jsonb_build_object('minute', e -> 'minute', 'text', e -> 'text', 'xg', e -> 'xg')
  from jsonb_array_elements(coalesce(p_result -> 'events', '[]'::jsonb)) e
  where e ->> 'type' in ('kickoff','goal','save','chance','woodwork','yellow','second_yellow','red','injury','sub','halftime','fulltime','penalty','tactic','miss');

  insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, goals, assists, shots, shots_on_target, xg,
    passes, passes_completed, tackles_won, interceptions, saves, rating, fitness_start, fitness_end, yellow, red)
  select p_fixture, p.id, p.club_id, v_f.world_id,
         least(120, (s ->> 'minutes')::int), (s ->> 'goals')::int, (s ->> 'assists')::int, (s ->> 'shots')::int, (s ->> 'shotsOnTarget')::int,
         (s ->> 'xg')::numeric, least(32000, (s ->> 'passes')::int), least(32000, (s ->> 'passesCompleted')::int), (s ->> 'tacklesWon')::int,
         (s ->> 'interceptions')::int, (s ->> 'saves')::int, (s ->> 'rating')::numeric,
         greatest(0, least(100, (s ->> 'fitnessStart')::numeric)), greatest(0, least(100, (s ->> 'fitnessEnd')::numeric)),
         coalesce((s ->> 'yellow')::int, 0), coalesce((s ->> 'red')::boolean, false)
  from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
  join public.players p on p.id::text = s ->> 'playerId'
  where p.club_id = (v_side_club ->> (s ->> 'side'))::uuid
  on conflict do nothing;

  if v_kind <> 'friendly' then
    -- Fitness übernehmen
    update public.players p set fitness = greatest(0, least(100, (s ->> 'fitnessEnd')::numeric))
    from jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s
    where p.id::text = s ->> 'playerId' and p.club_id in (v_f.home_club_id, v_f.away_club_id);
    -- F10: Verletzungen (1–5 Wochen), wirken wettbewerbsübergreifend
    insert into public.injuries(world_id, player_id, fixture_id, kind, starts_on, ends_on)
    select v_f.world_id, ms.player_id, p_fixture, 'Spielverletzung', v_date,
           v_date + (7 + floor(public.fd_hash01(v_f.rng_seed || ms.player_id::text) * 28))::int
    from public.match_player_stats ms
    join jsonb_array_elements(coalesce(p_result -> 'players', '[]'::jsonb)) s on s ->> 'playerId' = ms.player_id::text
    where ms.fixture_id = p_fixture and coalesce((s ->> 'injured')::boolean, false);
    -- F10: Karten und Sperren (Rot: 2 Spiele, Gelb-Rot: 1 Spiel, jede 5. Gelbe: 1 Spiel) – je Wettbewerb getrennt
    for r in select ms.player_id, ms.yellow, ms.red from public.match_player_stats ms where ms.fixture_id = p_fixture and (ms.yellow > 0 or ms.red) loop
      if r.red then
        insert into public.disciplinary_records(world_id, player_id, season_id, scope, fixture_id, card, suspension_matches)
        values (v_f.world_id, r.player_id, v_f.season_id, v_scope, p_fixture, case when r.yellow >= 2 then 'second_yellow'::public.card_kind else 'red'::public.card_kind end,
                case when r.yellow >= 2 then 1 else 2 end);
      elsif r.yellow = 1 then
        insert into public.disciplinary_records(world_id, player_id, season_id, scope, fixture_id, card, suspension_matches)
        values (v_f.world_id, r.player_id, v_f.season_id, v_scope, p_fixture, 'yellow',
                case when (select count(*) from public.disciplinary_records d where d.player_id = r.player_id and d.season_id = v_f.season_id
                           and d.scope = v_scope and d.card = 'yellow') % 5 = 4 then 1 else 0 end);
      end if;
    end loop;
  end if;

  update public.fixtures set status = (case when v_kind = 'friendly' then 'released' else 'finished' end)::public.fixture_status,
                             released_at = case when v_kind = 'friendly' then now() else released_at end
  where id = p_fixture;
  update public.match_sessions set status = 'finished', finished_at = now(), updated_at = now() where fixture_id = p_fixture;
  if v_kind <> 'friendly' then perform public.fd_try_release(v_f.world_id); end if;
  return jsonb_build_object('status', 'saved');
end;
$$;

-- Bestenlisten mit IDs (anklickbare Spieler/Vereine)
create or replace function public.league_leaders(p_comp uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'scorers', coalesce((select jsonb_agg(x order by (x ->> 'goals')::int desc, (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'goals', sum(ms.goals), 'assists', sum(ms.assists),
                                  'games', count(*), 'rating', round(avg(ms.rating), 2)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id)
        group by p.id, c.id, c.short_name having sum(ms.goals) > 0 order by sum(ms.goals) desc, sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'assists', coalesce((select jsonb_agg(x order by (x ->> 'assists')::int desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'assists', sum(ms.assists), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id)
        group by p.id, c.id, c.short_name having sum(ms.assists) > 0 order by sum(ms.assists) desc limit 20) s), '[]'::jsonb),
    'ratings', coalesce((select jsonb_agg(x order by (x ->> 'rating')::numeric desc) from (
        select jsonb_build_object('player', p.first_name || ' ' || p.last_name, 'player_id', p.id, 'club_id', c.id, 'club', c.short_name, 'rating', round(avg(ms.rating), 2), 'games', count(*)) x
        from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.players p on p.id = ms.player_id
        join public.clubs c on c.id = ms.club_id
        where f.competition_id = p_comp and f.status = 'released' and public.is_world_member(f.world_id) and ms.minutes >= 45
        group by p.id, c.id, c.short_name having count(*) >= greatest(1, (select max(matchday) from public.fixtures where competition_id = p_comp and status = 'released') / 3)
        order by avg(ms.rating) desc limit 20) s), '[]'::jsonb)
  );
$$;


revoke execute on function public.fd_club_color(uuid) from public, anon, authenticated;
revoke execute on function public.fd_club_ref(uuid) from public, anon, authenticated;
revoke execute on function public.fd_league_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fd_table_rows(uuid) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['public.pending_review(uuid)', 'public.mark_review_seen(uuid, uuid)', 'public.matchday_report(uuid, uuid)',
                           'public.dashboard(uuid)', 'public.player_profile(uuid)', 'public.club_profile(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
