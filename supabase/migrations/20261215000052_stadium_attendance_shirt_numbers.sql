create or replace function public.set_shirt_number(p_world uuid, p_player uuid, p_number integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
begin
  if p_number is null or p_number not between 1 and 99 then
    raise exception 'Die Trikotnummer muss zwischen 1 und 99 liegen.' using errcode = '22023';
  end if;
  update public.players set shirt_number = p_number
  where id = p_player and club_id = v_club and world_id = p_world;
  if not found then
    raise exception 'Spieler gehört nicht zu deinem Verein.' using errcode = '42501';
  end if;
exception when unique_violation then
  raise exception 'Diese Trikotnummer ist bereits vergeben.' using errcode = '23505';
end;
$$;

create or replace function public.stadium_attendance_forecast(p_world uuid, p_price integer)
returns jsonb
language plpgsql
stable security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_capacity integer;
  v_price integer;
  v_current_demand numeric;
  v_proposed_demand numeric;
  v_current integer;
  v_proposed integer;
  v_tier integer;
  v_reputation numeric;
begin
  if p_price is null or p_price not between 5 and 500 then
    raise exception 'Der Ticketpreis muss zwischen 5 und 500 liegen.' using errcode = '22023';
  end if;
  select * into strict v_world from public.career_worlds where id = p_world;
  select capacity, ticket_price_league into strict v_capacity, v_price from public.stadiums where club_id = v_club;
  select reputation into strict v_reputation from public.clubs where id = v_club;
  v_tier := public.fd_tier_of(v_club, v_world.current_season_id);
  v_current_demand := public.fd_stadium_demand(v_club, v_world.current_season_id, 'league', v_price, 50, 1, 1);
  v_proposed_demand := public.fd_stadium_demand(v_club, v_world.current_season_id, 'league', p_price, 50, 1, 1);
  v_current := (round(greatest(public.fd_soft_attendance(v_capacity, v_current_demand), v_capacity * 0.08) / 10) * 10)::integer;
  v_proposed := (round(greatest(public.fd_soft_attendance(v_capacity, v_proposed_demand), v_capacity * 0.08) / 10) * 10)::integer;
  return jsonb_build_object(
    'capacity', v_capacity, 'tier', v_tier, 'reputation', v_reputation,
    'current_price', v_price, 'proposed_price', p_price,
    'current_demand', round(v_current_demand), 'proposed_demand', round(v_proposed_demand),
    'current_attendance', v_current, 'proposed_attendance', v_proposed,
    'current_utilization', round(v_current::numeric * 100 / greatest(v_capacity, 1), 1),
    'proposed_utilization', round(v_proposed::numeric * 100 / greatest(v_capacity, 1), 1)
  );
end;
$$;

revoke execute on function public.set_shirt_number(uuid, uuid, integer), public.stadium_attendance_forecast(uuid, integer) from public, anon;
grant execute on function public.set_shirt_number(uuid, uuid, integer), public.stadium_attendance_forecast(uuid, integer) to authenticated;

-- Die Anzahl der Ligavereine muss vor dem Filtern auf den Heimverein gezählt werden.
do $migration$
declare
  v_def text := pg_get_functiondef('public.fd_expected_attendance(uuid)'::regprocedure);
  v_old text := $old$select t.pos, count(*) over () into v_pos, v_n from public.fd_table((select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
                                                                where e.club_id = v_home.id and c.season_id = v_f.season_id and c.kind = 'league' limit 1)) t
  where t.club_id = v_home.id;$old$;
  v_new text := $new$select t.pos, t.club_count into v_pos, v_n from (
    select standings.club_id, standings.pos, count(*) over () as club_count
    from public.fd_table((select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
                          where e.club_id = v_home.id and c.season_id = v_f.season_id and c.kind = 'league' limit 1)) standings
  ) t where t.club_id = v_home.id;$new$;
begin
  v_def := replace(v_def, E'\r\n', E'\n');
  v_old := replace(v_old, E'\r\n', E'\n');
  if position(v_old in v_def) = 0 then
    raise exception 'fd_expected_attendance hat eine unerwartete Definition';
  end if;
  execute replace(v_def, v_old, v_new);
end;
$migration$;
