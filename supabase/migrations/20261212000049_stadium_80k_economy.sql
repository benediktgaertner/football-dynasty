-- =====================================================================
-- Migration 0049: Stadion bis 80.000 Plätze, neue Zuschauer- und Ausbauökonomie
--   * Kapazität 10.000 – 80.000 in 5.000er-Schritten (Neubau beim Vereinsstart bleibt bis 50.000).
--   * Zuschauer: absolute Nachfrage (Spielklasse, Ruf, Preis, Form, Gegner) statt fester Auslastungsquote;
--     Zuschauer = Nachfrage, begrenzt durch die Kapazität (sanfte Sättigung ab 85 % Auslastung).
--     Ein größeres Stadion bringt nur dann mehr Zuschauer, wenn die Nachfrage es füllt.
--   * Ausbaukosten je 5.000er-Schritt: 3,2 Mio. € + 30 € je vorhandenem Platz (30.000 → 4,1 Mio., 75.000 → 5,45 Mio.),
--     skaliert mit dem Wirtschaftsniveau der Welt. Break-even für ausgelastete Stadien im Lauf der zweiten Saison.
--   * Betriebs-/Instandhaltungskosten je Heimspiel wachsen mit der Größe; neue Gastronomie-Einnahmen (catering_income).
--   * stadium_expansion_quote: Break-even-Prognose vor jedem Ausbau (Tickets, Gastronomie, Fanshop, Kosten).
--   * Heimvorteil: Größenanteil begrenzt (80.000 sind nicht doppelt so laut wie 40.000).
--   * Fanshop: Käuferbasis hängt an den echten Zuschauern, nicht mehr an der Stadiongröße.
-- Bestehende Stadien und Spielstände bleiben unverändert (nur Berechnung ändert sich). Idempotent.
-- =====================================================================

alter type public.transaction_kind add value if not exists 'catering_income';

-- Kapazitätsgrenze 80.000
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'public.stadiums'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%capacity%' and conname <> 'stadiums_design_valid' loop
    execute format('alter table public.stadiums drop constraint %I', c.conname);
  end loop;
  alter table public.stadiums add constraint stadiums_capacity_check check (capacity between 10000 and 80000 and (capacity - 10000) % 5000 = 0);
end $$;

-- ---------- Bausteine ----------
create or replace function public.fd_stadium_expansion_step_cost(p_capacity integer)
returns bigint language sql immutable set search_path = '' as $$
  select 3200000::bigint + 30::bigint * p_capacity;
$$;

create or replace function public.fd_stadium_running_cost(p_capacity integer)
returns bigint language sql immutable set search_path = '' as $$
  select 2::bigint * p_capacity + (greatest(p_capacity - 30000, 0)::bigint * p_capacity) / 40000;
$$;

create or replace function public.fd_catering_income(p_attendance integer, p_price integer)
returns bigint language sql immutable set search_path = '' as $$
  select round(p_attendance::numeric * p_price * 0.28)::bigint;
$$;

-- Zuschauer = Nachfrage, bei hoher Auslastung sanft gesättigt (selten ganz ausverkauft)
create or replace function public.fd_soft_attendance(p_capacity integer, p_demand numeric)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_demand <= p_capacity * 0.85 then p_demand
              else p_capacity * (0.85 + 0.15 * (1 - exp(-(p_demand / p_capacity - 0.85) / 0.15))) end;
$$;

-- Absolute Nachfrage nach Plätzen (unabhängig von der Stadiongröße)
create or replace function public.fd_stadium_demand(p_club uuid, p_season uuid, p_kind text, p_price integer, p_away_rep numeric, p_form numeric, p_imp numeric)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tier smallint := public.fd_tier_of(p_club, p_season);
  v_rep numeric;
  v_fans numeric;
  v_ref numeric;
  v_trep numeric;
begin
  select reputation into v_rep from public.clubs where id = p_club;
  v_fans := case v_tier when 1 then 34000 when 2 then 19000 when 3 then 9500 else 4600 end;
  v_trep := case v_tier when 1 then 75 when 2 then 55 when 3 then 38 else 30 end;
  v_ref := case v_tier when 1 then 45 when 2 then 30 when 3 then 20 else 12 end * case when p_kind = 'domestic_cup' then 0.85 else 1 end;
  return v_fans
    * least(1.35, power(v_ref / greatest(p_price, 1), 0.7))
    * greatest(0.6, 1 + (v_rep - v_trep) / 100)
    * (1 + (v_rep - 50) / 400)
    * (1 + (p_away_rep - 50) / 250)
    * p_form * p_imp;
end;
$$;

create or replace function public.fd_expected_attendance(p_fixture uuid)
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_kind text;
  v_cap integer;
  v_price integer;
  v_home public.clubs;
  v_away public.clubs;
  v_form numeric := 1;
  v_imp numeric := 1;
  v_pos integer;
  v_n integer;
  v_stage public.stage_kind;
  v_demand numeric;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if v_f.neutral_venue then return 0; end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  select * into v_home from public.clubs where id = v_f.home_club_id;
  select * into v_away from public.clubs where id = v_f.away_club_id;
  select capacity, case when v_kind = 'domestic_cup' then ticket_price_cup when v_kind in ('champions_league', 'europa_league') then ticket_price_international else ticket_price_league end
  into v_cap, v_price from public.stadiums where club_id = v_home.id;
  v_cap := coalesce(v_cap, 8000);
  v_price := coalesce(v_price, 12);
  select t.pos, count(*) over () into v_pos, v_n from public.fd_table((select e.competition_id from public.competition_entries e join public.competitions c on c.id = e.competition_id
                                                                where e.club_id = v_home.id and c.season_id = v_f.season_id and c.kind = 'league' limit 1)) t
  where t.club_id = v_home.id;
  if v_pos is not null and v_n > 1 and exists (select 1 from public.standings where club_id = v_home.id and played > 0) then
    v_form := 1 + (0.5 - (v_pos - 1)::numeric / (v_n - 1)) * 0.2;
  end if;
  if v_f.stage_id is not null then
    select kind into v_stage from public.competition_stages where id = v_f.stage_id;
    v_imp := case v_stage when 'round_of_64' then 1.0 when 'round_of_32' then 1.05 when 'round_of_16' then 1.1 when 'quarter_final' then 1.15 when 'semi_final' then 1.25 when 'relegation' then 1.3 else 1.3 end;
  end if;
  v_demand := public.fd_stadium_demand(v_home.id, v_f.season_id, v_kind, v_price, v_away.reputation, v_form, v_imp)
            * (0.97 + public.fd_hash01(v_f.rng_seed || ':att') * 0.06);
  return (round(greatest(public.fd_soft_attendance(v_cap, v_demand), v_cap * 0.08) / 10) * 10)::int;
end;
$$;

-- Heimvorteil: Größenanteil begrenzt (höchstens 1,25-fach der Wirkung eines 50.000er-Stadions)
create or replace function public.fd_home_advantage(p_fixture uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_cap integer;
  v_att integer;
  v_occ numeric;
  v_adv numeric := 0;
  v_stage public.stage_kind;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if v_f.neutral_venue then return null; end if;
  select capacity into v_cap from public.stadiums where club_id = v_f.home_club_id;
  v_cap := coalesce(v_cap, 8000);
  v_att := public.fd_expected_attendance(p_fixture);
  v_occ := v_att::numeric / v_cap;
  if v_occ > 0.5 then v_adv := (v_occ - 0.5) / 0.5 * (0.008 + 0.022 * least(1.25, greatest(0, v_cap - 10000)::numeric / 40000)); end if;
  if v_f.stage_id is not null then
    select kind into v_stage from public.competition_stages where id = v_f.stage_id;
    if v_stage in ('round_of_64', 'round_of_32', 'round_of_16', 'quarter_final')
       and public.fd_tier_of(v_f.home_club_id, v_f.season_id) > public.fd_tier_of(v_f.away_club_id, v_f.season_id) then
      v_adv := v_adv + 0.01;
    end if;
  end if;
  return round(least(v_adv, 0.04), 4);
end;
$$;

-- ---------- Betriebskosten und Gastronomie beim Freigeben eines Termins ----------
do $$
declare
  v_def text;
  v_new text;
  v_old1 constant text := '-public.fd_scaled(v_cap::bigint * 2, v_eco)';
  v_new1 constant text := '-public.fd_scaled(public.fd_stadium_running_cost(v_cap), v_eco)';
  v_anchor constant text := E'        perform public.fd_pay(f.home_club_id, ''stadium_running_cost''';
  v_cater constant text := E'        perform public.fd_pay(f.home_club_id, ''catering_income'', public.fd_scaled(public.fd_catering_income(v_res.attendance, v_price), case when f.comp_kind in (''champions_league'', ''europa_league'') then 1 else v_eco end), ''fx:'' || f.id || '':catering'',\n          ''Gastronomie · '' || v_slot.label, f.season_id);\n';
begin
  select pg_get_functiondef('public.fd_release_slot(uuid)'::regprocedure) into v_def;
  if position('fd_catering_income' in v_def) > 0 then return; end if;  -- bereits angewandt
  if position(v_old1 in v_def) = 0 or position(v_anchor in v_def) = 0 then raise exception 'Patch fd_release_slot fehlgeschlagen'; end if;
  v_new := replace(v_def, v_old1, v_new1);
  v_new := replace(v_new, v_anchor, v_cater || v_anchor);
  execute v_new;
end $$;

-- ---------- Fanshop: Käuferbasis aus echten Zuschauern ----------
do $$
declare
  v_def text;
  v_old constant text := E'v_pool := case when r.is_home then r.att + r.capacity * 0.35 * r.reputation / 100\n                   else r.capacity * 0.30 * r.reputation / 100 + 800 end;';
  v_new constant text := E'v_pool := case when r.is_home then (case when r.att > 0 then r.att else r.capacity * 0.6 end) * 1.35\n                   else 800 + 0.32 * coalesce((select avg(fr.attendance) from public.fixtures hf join public.fixture_results fr on fr.fixture_id = hf.id\n                                                where hf.home_club_id = r.club_id and hf.season_id = v_slot.season_id and fr.attendance is not null), r.capacity * 0.6) end;';
begin
  select pg_get_functiondef('public.fd_slot_economy(uuid)'::regprocedure) into v_def;
  if position(v_old in v_def) = 0 then
    if position('end) * 1.35' in v_def) > 0 then return; end if;
    raise exception 'Patch fd_slot_economy fehlgeschlagen';
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- Gastronomie gehört im Finanzdashboard zu den Ticketverkäufen
create or replace function public.fd_finance_group(p_kind text, p_desc text, p_amount bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'starting_capital' then 'starting_capital'
    when 'ticket_income' then 'ticket_sales'
    when 'catering_income' then 'ticket_sales'
    when 'match_bonus' then 'match_bonus'
    when 'sponsor' then 'sponsors'
    when 'merchandising' then 'merchandising'
    when 'transfer_fee_received' then 'transfer_sales'
    when 'competition_prize' then 'competition_prizes'
    when 'placement_prize' then 'competition_prizes'
    when 'salary' then 'salaries'
    when 'transfer_fee_paid' then 'transfer_purchases'
    when 'draft_purchase' then 'transfer_purchases'
    when 'stadium_build' then 'stadium_expansion'
    when 'stadium_expansion' then 'stadium_expansion'
    when 'contract_termination' then 'contract_termination'
    when 'merch_purchase' then 'merch_costs'
    when 'merch_storage' then 'merch_costs'
    when 'loan_interest' then 'interest'
    when 'adjustment' then case when p_desc like 'Abfindung%' and p_amount < 0 then 'contract_termination'
                                when p_amount >= 0 then 'other_income' else 'other_expense' end
    else case when p_amount >= 0 then 'other_income' else 'other_expense' end
  end;
$$;

-- ---------- Prognose und Ausbau ----------
-- Erwartete Heimspiele je Saison (Liga 17 + durchschnittlich zwei weitere) und Fanshop-Marge je Zuschauer (€)
create or replace function public.stadium_expansion_quote(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_cap integer; v_price integer;
  v_d numeric; v_a0 numeric; v_a1 numeric; v_da numeric;
  v_games constant integer := 19;
  v_merch constant numeric := 2.4;
  v_tickets numeric; v_cater numeric; v_shop numeric; v_run numeric; v_net numeric; v_cost bigint; v_pb numeric;
begin
  select * into v_world from public.career_worlds where id = p_world;
  select capacity, ticket_price_league into v_cap, v_price from public.stadiums where club_id = v_club;
  if v_cap >= 80000 then
    return jsonb_build_object('capacity', v_cap, 'next_capacity', null, 'max', true);
  end if;
  v_d := public.fd_stadium_demand(v_club, v_world.current_season_id, 'league', v_price, 50, 1, 1);
  v_a0 := greatest(public.fd_soft_attendance(v_cap, v_d), v_cap * 0.08);
  v_a1 := greatest(public.fd_soft_attendance(v_cap + 5000, v_d), (v_cap + 5000) * 0.08);
  v_da := v_a1 - v_a0;
  v_tickets := public.fd_scaled((v_da * v_price * v_games)::bigint, v_world.economy_factor);
  v_cater := public.fd_scaled((v_da * v_price * 0.28 * v_games)::bigint, v_world.economy_factor);
  v_shop := v_da * v_merch * v_games;
  v_run := public.fd_scaled((public.fd_stadium_running_cost(v_cap + 5000) - public.fd_stadium_running_cost(v_cap)) * v_games, v_world.economy_factor);
  v_net := v_tickets + v_cater + v_shop - v_run;
  v_cost := public.fd_scaled(public.fd_stadium_expansion_step_cost(v_cap), v_world.economy_factor);
  v_pb := case when v_net > 0 then v_cost / v_net else null end;
  return jsonb_build_object(
    'capacity', v_cap, 'next_capacity', v_cap + 5000, 'max', false, 'cost', v_cost,
    'demand', round(v_d), 'attendance_now', round(v_a0), 'attendance_after', round(v_a1), 'extra_attendance', round(v_da),
    'utilization_now', round(v_a0 / v_cap * 100, 1), 'utilization_after', round(v_a1 / (v_cap + 5000) * 100, 1),
    'games', v_games, 'annual_tickets', round(v_tickets), 'annual_catering', round(v_cater), 'annual_merch', round(v_shop),
    'annual_running_extra', round(v_run), 'annual_net', round(v_net), 'payback_years', case when v_pb is null then null else round(v_pb, 2) end,
    'verdict', case when v_pb is null then 'not_profitable' when v_pb <= 1 then 'first_season' when v_pb <= 2 then 'second_season'
                    when v_pb <= 3 then 'third_season' when v_pb <= 5 then 'long_term' else 'not_profitable' end);
end;
$$;

create or replace function public.expand_stadium(p_world uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_cap integer;
  v_cost bigint;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status <> 'preseason' then
    raise exception 'Ein Ausbau ist nur zum Saisonwechsel (Vorbereitung) möglich.' using errcode = 'P0001', hint = 'not_preseason';
  end if;
  select capacity into v_cap from public.stadiums where club_id = v_club for update;
  if v_cap >= 80000 then raise exception 'Das Stadion hat bereits die Maximalgröße.' using errcode = 'P0001', hint = 'max'; end if;
  v_cost := public.fd_scaled(public.fd_stadium_expansion_step_cost(v_cap), v_world.economy_factor);
  perform public.post_transaction(v_club, 'stadium_expansion', -v_cost, 'expand:' || v_club || ':' || v_world.current_season_id || ':' || v_cap,
    'Stadionausbau auf ' || (v_cap + 5000) || ' Plätze', v_world.current_season_id);
  update public.stadiums set capacity = v_cap + 5000 where club_id = v_club;
  return jsonb_build_object('capacity', v_cap + 5000, 'cost', v_cost);
end;
$$;

revoke execute on function public.stadium_expansion_quote(uuid), public.expand_stadium(uuid) from public, anon;
grant execute on function public.stadium_expansion_quote(uuid), public.expand_stadium(uuid) to authenticated;
revoke execute on function public.fd_stadium_expansion_step_cost(integer), public.fd_stadium_running_cost(integer), public.fd_catering_income(integer, integer),
  public.fd_soft_attendance(integer, numeric), public.fd_stadium_demand(uuid, uuid, text, integer, numeric, numeric, numeric) from public, anon;
grant execute on function public.fd_stadium_expansion_step_cost(integer), public.fd_stadium_running_cost(integer), public.fd_catering_income(integer, integer),
  public.fd_soft_attendance(integer, numeric) to authenticated;
revoke execute on function public.fd_finance_group(text, text, bigint) from public, anon;
grant execute on function public.fd_finance_group(text, text, bigint) to authenticated;
notify pgrst, 'reload schema';
