-- Neubaukosten gelten nur für die erlaubten Größen bei der Vereinsgründung.
-- Ein später ausgebautes Stadion darf den Abruf der Karrierewelt nicht blockieren.
do $migration$
declare
  v_def text := pg_get_functiondef('public.lobby_state(uuid)'::regprocedure);
  v_old text := 'public.fd_scaled(public.stadium_build_cost(s.capacity), least(1, public.fd_capital_factor(v_world.country_code, v_world.start_tier)))';
  v_new text := 'case when s.capacity between 10000 and 50000 and (s.capacity - 10000) % 5000 = 0 then public.fd_scaled(public.stadium_build_cost(s.capacity), least(1, public.fd_capital_factor(v_world.country_code, v_world.start_tier))) else 0 end';
begin
  if position(v_old in v_def) = 0 then raise exception 'Unerwartete Definition von lobby_state'; end if;
  execute replace(v_def, v_old, v_new);
end;
$migration$;
