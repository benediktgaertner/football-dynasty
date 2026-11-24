-- Das Grundinteresse ist nach Ligastufe skaliert. Die Referenz ist ein Verein
-- mit Ruf 50 in Liga 1 bei 40 Euro und einem Stadion mit 50.000 Plätzen.
create or replace function public.fd_stadium_demand(p_club uuid, p_season uuid, p_kind text, p_price integer, p_away_rep numeric, p_form numeric, p_imp numeric)
returns numeric language plpgsql stable set search_path = '' as $$
declare
  v_tier smallint := public.fd_tier_of(p_club, p_season);
  v_rep numeric;
  v_fans numeric;
  v_ref numeric;
  v_trep numeric;
begin
  select reputation into v_rep from public.clubs where id = p_club;
  v_fans := case v_tier when 1 then 52000 when 2 then 29000 when 3 then 14500 else 7000 end;
  v_trep := case v_tier when 1 then 75 when 2 then 55 when 3 then 38 else 30 end;
  v_ref := case v_tier when 1 then 45 when 2 then 30 when 3 then 20 else 12 end * case when p_kind = 'domestic_cup' then 0.85 else 1 end;
  return v_fans * least(1.35, power(v_ref / greatest(p_price, 1), 0.7))
    * greatest(0.6, 1 + (v_rep - v_trep) / 100)
    * (1 + (v_rep - 50) / 400)
    * (1 + (p_away_rep - 50) / 200)
    * p_form * p_imp;
end;
$$;

-- Der Tabellenplatz beeinflusst die Nachfrage zwischen -17,5 % und +17,5 %.
do $migration$
declare
  v_def text := pg_get_functiondef('public.fd_expected_attendance(uuid)'::regprocedure);
  v_old text := '(0.5 - (v_pos - 1)::numeric / (v_n - 1)) * 0.2';
  v_new text := '(0.5 - (v_pos - 1)::numeric / (v_n - 1)) * 0.35';
begin
  if position(v_old in v_def) = 0 then raise exception 'Unerwartete Zuschauerberechnung'; end if;
  execute replace(v_def, v_old, v_new);
end;
$migration$;

create or replace function public.stadium_attendance_scenario(p_world uuid, p_price integer, p_away_rep integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_capacity integer; v_price integer; v_tier integer; v_reputation numeric;
  v_pos integer; v_n integer; v_form numeric := 1;
  v_current_demand numeric; v_proposed_demand numeric;
  v_current integer; v_proposed integer;
begin
  if p_price is null or p_price not between 5 and 500 or p_away_rep is null or p_away_rep not between 0 and 100 then
    raise exception 'Ungültiger Ticketpreis oder Gegner-Ruf.' using errcode = '22023';
  end if;
  select * into strict v_world from public.career_worlds where id = p_world;
  select capacity, ticket_price_league into strict v_capacity, v_price from public.stadiums where club_id = v_club;
  select reputation into strict v_reputation from public.clubs where id = v_club;
  v_tier := public.fd_tier_of(v_club, v_world.current_season_id);
  select t.pos, t.club_count into v_pos, v_n from (
    select s.club_id, s.pos, count(*) over () as club_count
    from public.fd_table((select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
      where e.club_id = v_club and c.season_id = v_world.current_season_id and c.kind = 'league' limit 1)) s
  ) t where t.club_id = v_club;
  if v_pos is not null and v_n > 1 and exists (select 1 from public.standings where club_id = v_club and played > 0) then
    v_form := 1 + (0.5 - (v_pos - 1)::numeric / (v_n - 1)) * 0.35;
  end if;
  v_current_demand := public.fd_stadium_demand(v_club, v_world.current_season_id, 'league', v_price, p_away_rep, v_form, 1);
  v_proposed_demand := public.fd_stadium_demand(v_club, v_world.current_season_id, 'league', p_price, p_away_rep, v_form, 1);
  v_current := (round(greatest(public.fd_soft_attendance(v_capacity, v_current_demand), v_capacity * 0.08) / 10) * 10)::integer;
  v_proposed := (round(greatest(public.fd_soft_attendance(v_capacity, v_proposed_demand), v_capacity * 0.08) / 10) * 10)::integer;
  return jsonb_build_object('capacity', v_capacity, 'tier', v_tier, 'reputation', v_reputation,
    'current_price', v_price, 'proposed_price', p_price, 'opponent_reputation', p_away_rep,
    'league_position', v_pos, 'league_teams', v_n, 'form_factor', round(v_form, 3),
    'current_demand', round(v_current_demand), 'proposed_demand', round(v_proposed_demand),
    'current_attendance', v_current, 'proposed_attendance', v_proposed,
    'current_utilization', round(v_current::numeric * 100 / greatest(v_capacity, 1), 1),
    'proposed_utilization', round(v_proposed::numeric * 100 / greatest(v_capacity, 1), 1));
end;
$$;
revoke execute on function public.stadium_attendance_scenario(uuid, integer, integer) from public, anon;
grant execute on function public.stadium_attendance_scenario(uuid, integer, integer) to authenticated;
