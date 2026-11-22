-- 0040: Vereinsprofil – Absturz (schwarzer Bildschirm) bei Vereinen, deren letztes freigegebenes Spiel
-- eine Kompakt-Simulation war (KI-gegen-KI im Europapokal, Migration 0030). Dort steht die Aufstellung nur als
-- Liste von Spieler-IDs (summary.lineups.home = ["id", …]) ohne Positionen; club_profile lieferte dann
-- formation.slots = null und die Seite stürzte beim Rendern ab.
-- Korrektur: Als „zuletzt bekannte Formation“ zählt nur ein Spiel mit vollständiger Aufstellung (slots-Array).
-- Keine Datenänderung, nur die Funktion wird ersetzt. Idempotent.
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
    and jsonb_typeof(r.summary -> 'lineups' -> (case when f.home_club_id = p_club then 'home' else 'away' end) -> 'slots') = 'array'
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
        'slots', coalesce((select jsonb_agg(jsonb_build_object('player_id', sl ->> 'playerId', 'position', sl ->> 'position', 'x', (sl ->> 'x')::numeric, 'y', (sl ->> 'y')::numeric,
                   'name', p.last_name, 'shirt', p.shirt_number, 'overall', p.overall))
                  from jsonb_array_elements(v_last.lineup -> 'slots') sl left join public.players p on p.id::text = sl ->> 'playerId'), '[]'::jsonb)) end,
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
