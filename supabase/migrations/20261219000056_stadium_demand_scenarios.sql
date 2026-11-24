-- Nachfrage als Anteil der Stadionkapazität. Der Gegner beeinflusst das
-- Interesse stärker als der Preis; Tabellenplatz und Vereinsruf wirken mit.
create or replace function public.fd_stadium_demand_at_capacity(
  p_club uuid, p_season uuid, p_kind text, p_price integer,
  p_away_rep numeric, p_form numeric, p_imp numeric, p_capacity integer
)
returns numeric language plpgsql stable set search_path = '' as $$
declare
  v_rep numeric;
  v_price_effect numeric;
  v_opponent numeric;
  v_demand numeric;
  v_top_opponent_demand numeric;
begin
  select reputation into v_rep from public.clubs where id = p_club;
  v_opponent := greatest(0, least(100, p_away_rep));
  -- 40 Euro dient als günstiger Referenzpreis. Preissenkungen sind begrenzt,
  -- höhere Preise dämpfen die Nachfrage schrittweise.
  v_price_effect := greatest(-0.30, least(0.035, -0.18 * ln(greatest(p_price, 1)::numeric / 40)));
  v_demand := p_capacity
    * greatest(0.25, 0.91 + 0.24 * (v_opponent - 50) / 50 + v_price_effect)
    * (1 + greatest(-0.10, least(0.10, (v_rep - 50) / 500)))
    * (1 + (p_form - 1) * 0.35)
    * p_imp;
  -- Bei Ruf 100 und bis zu 40 Euro liegt das Interesse auch nach der
  -- spielabhängigen Schwankung über der Kapazität.
  v_top_opponent_demand := p_capacity * 1.05
    * power(v_opponent / 100, 8)
    * least(1.35, power(40::numeric / greatest(p_price, 1), 0.7));
  return greatest(v_demand, v_top_opponent_demand);
end;
$$;
