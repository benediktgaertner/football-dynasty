-- Bei typischer Stadiongröße einer Liga bleibt die Nachfrage unverändert.
-- Ein größerer Standort erhöht das Fanpotenzial mit abnehmendem Grenzertrag.
create or replace function public.fd_stadium_capacity_factor(p_capacity integer, p_tier integer)
returns numeric language sql immutable set search_path = '' as $$
  select least(1.4, greatest(0.7, power(
    greatest(coalesce(p_capacity, 0), 1)::numeric /
    (case p_tier when 1 then 50000 when 2 then 25000 when 3 then 12500 else 8000 end), 0.35)));
$$;

create or replace function public.fd_stadium_demand(p_club uuid, p_season uuid, p_kind text, p_price integer, p_away_rep numeric, p_form numeric, p_imp numeric)
returns numeric language plpgsql stable set search_path = '' as $$
declare
  v_tier smallint := public.fd_tier_of(p_club, p_season);
  v_rep numeric;
  v_capacity integer;
  v_fans numeric;
  v_ref numeric;
  v_trep numeric;
begin
  select reputation into v_rep from public.clubs where id = p_club;
  select capacity into v_capacity from public.stadiums where club_id = p_club;
  v_fans := case v_tier when 1 then 52000 when 2 then 29000 when 3 then 14500 else 7000 end;
  v_trep := case v_tier when 1 then 75 when 2 then 55 when 3 then 38 else 30 end;
  v_ref := case v_tier when 1 then 45 when 2 then 30 when 3 then 20 else 12 end * case when p_kind = 'domestic_cup' then 0.85 else 1 end;
  return v_fans * public.fd_stadium_capacity_factor(coalesce(v_capacity, 8000), v_tier)
    * least(1.35, power(v_ref / greatest(p_price, 1), 0.7))
    * greatest(0.6, 1 + (v_rep - v_trep) / 100)
    * (1 + (v_rep - 50) / 400)
    * (1 + (p_away_rep - 50) / 200)
    * p_form * p_imp;
end;
$$;

-- Die Ausbauprognose verwendet bereits das Fanpotenzial der größeren Arena.
do $migration$
declare
  v_def text := pg_get_functiondef('public.stadium_expansion_quote(uuid)'::regprocedure);
  v_old text := 'v_a1 := greatest(public.fd_soft_attendance(v_cap + 5000, v_d), (v_cap + 5000) * 0.08);';
  v_new text := 'v_a1 := greatest(public.fd_soft_attendance(v_cap + 5000, v_d * public.fd_stadium_capacity_factor(v_cap + 5000, public.fd_tier_of(v_club, v_world.current_season_id)) / public.fd_stadium_capacity_factor(v_cap, public.fd_tier_of(v_club, v_world.current_season_id))), (v_cap + 5000) * 0.08);';
begin
  if position(v_old in v_def) = 0 then raise exception 'Unerwartete Definition der Stadionprognose'; end if;
  v_def := replace(v_def, v_old, v_new);
  v_old := '''demand'', round(v_d),';
  v_new := '''demand'', round(v_d), ''demand_after'', round(v_d * public.fd_stadium_capacity_factor(v_cap + 5000, public.fd_tier_of(v_club, v_world.current_season_id)) / public.fd_stadium_capacity_factor(v_cap, public.fd_tier_of(v_club, v_world.current_season_id))),';
  if position(v_old in v_def) = 0 then raise exception 'Unerwartete Ausgabe der Stadionprognose'; end if;
  execute replace(v_def, v_old, v_new);
end;
$migration$;
