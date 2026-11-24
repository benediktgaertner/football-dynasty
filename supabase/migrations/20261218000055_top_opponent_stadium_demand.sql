-- Ein Spitzengegner zieht bei Preisen bis 40 Euro mehr Interessenten an,
-- als Plätze verfügbar sind. Bei niedrigeren Gegnerwerten klingt dieser
-- zusätzliche Nachfrageeffekt stetig ab.
create or replace function public.fd_stadium_demand_at_capacity(
  p_club uuid, p_season uuid, p_kind text, p_price integer,
  p_away_rep numeric, p_form numeric, p_imp numeric, p_capacity integer
)
returns numeric language plpgsql stable set search_path = '' as $$
declare
  v_tier smallint := public.fd_tier_of(p_club, p_season);
  v_rep numeric;
  v_fans numeric;
  v_ref numeric;
  v_trep numeric;
  v_demand numeric;
  v_top_opponent_demand numeric;
begin
  select reputation into v_rep from public.clubs where id = p_club;
  v_fans := case v_tier when 1 then 52000 when 2 then 29000 when 3 then 14500 else 7000 end;
  v_trep := case v_tier when 1 then 75 when 2 then 55 when 3 then 38 else 30 end;
  v_ref := case v_tier when 1 then 45 when 2 then 30 when 3 then 20 else 12 end * case when p_kind = 'domestic_cup' then 0.85 else 1 end;
  v_demand := v_fans * public.fd_stadium_capacity_factor(p_capacity, v_tier)
    * least(1.35, power(v_ref / greatest(p_price, 1), 0.7))
    * greatest(0.6, 1 + (v_rep - v_trep) / 100)
    * (1 + (v_rep - 50) / 400)
    * (1 + (p_away_rep - 50) / 200)
    * p_form * p_imp;
  v_top_opponent_demand := p_capacity * 1.05
    * power(greatest(0, least(100, p_away_rep)) / 100, 8)
    * least(1.35, power(40::numeric / greatest(p_price, 1), 0.7));
  return greatest(v_demand, v_top_opponent_demand);
end;
$$;

create or replace function public.fd_stadium_demand(p_club uuid, p_season uuid, p_kind text, p_price integer, p_away_rep numeric, p_form numeric, p_imp numeric)
returns numeric language plpgsql stable set search_path = '' as $$
declare
  v_capacity integer;
begin
  select capacity into v_capacity from public.stadiums where club_id = p_club;
  return public.fd_stadium_demand_at_capacity(p_club, p_season, p_kind, p_price, p_away_rep, p_form, p_imp, coalesce(v_capacity, 8000));
end;
$$;

revoke execute on function public.fd_stadium_demand_at_capacity(uuid, uuid, text, integer, numeric, numeric, numeric, integer) from public, anon;
grant execute on function public.fd_stadium_demand_at_capacity(uuid, uuid, text, integer, numeric, numeric, numeric, integer) to authenticated, service_role;

-- Die Prognose eines Ausbaus verwendet dieselbe Berechnung wie ein Spiel.
do $migration$
declare
  v_def text := pg_get_functiondef('public.stadium_expansion_quote(uuid)'::regprocedure);
  v_old text := 'v_d * public.fd_stadium_capacity_factor(v_cap + 5000, public.fd_tier_of(v_club, v_world.current_season_id)) / public.fd_stadium_capacity_factor(v_cap, public.fd_tier_of(v_club, v_world.current_season_id))';
  v_new text := 'public.fd_stadium_demand_at_capacity(v_club, v_world.current_season_id, ''league'', v_price, 50, 1, 1, v_cap + 5000)';
begin
  if position(v_old in v_def) = 0 then raise exception 'Unerwartete Definition der Stadionprognose'; end if;
  execute replace(v_def, v_old, v_new);
end;
$migration$;
