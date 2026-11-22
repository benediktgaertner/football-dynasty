-- =====================================================================
-- Migration 0037: Finanzdashboard (Saisonanalyse)
--   * Neuer Buchungstyp contract_termination (Vertragsauflösung/Abfindung). Hinweis: ALTER TYPE ... ADD VALUE
--     steht bewusst als eigene Anweisung ganz am Anfang und ohne Transaktionsblock; der neue Wert wird in
--     dieser Datei nur als Text (kind::text) verwendet.
--   * fd_finance_group(): zentrale Zuordnung transaction_kind -> Dashboard-Gruppe (Teil der DB-Tests).
--   * finance_season_report(): EIN Aufruf je Seitenaufruf, nur Mitglieder der Welt, nur der eigene Verein.
--     Alle Werte stammen ausschließlich aus public.financial_transactions / public.finances.
--     Zeitachse = Saisontermine (season_slots); Buchungen ohne Terminbezug (Transfers, Stadion) werden dem
--     zuletzt gebuchten Termin zugeordnet, Buchungen vor dem ersten Termin der „Vorbereitung“.
-- =====================================================================

alter type public.transaction_kind add value if not exists 'contract_termination';

-- Gruppen: Einnahmen ticket_sales, match_bonus, sponsors, transfer_sales, competition_prizes, other_income
--          Ausgaben  salaries, transfer_purchases, stadium_expansion, contract_termination, other_expense
--          Startkapital: starting_capital (Grundlage des Kontos, weder Einnahme noch Ausgabe)
create or replace function public.fd_finance_group(p_kind text, p_desc text, p_amount bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'starting_capital' then 'starting_capital'
    when 'ticket_income' then 'ticket_sales'
    when 'match_bonus' then 'match_bonus'
    when 'sponsor' then 'sponsors'
    when 'transfer_fee_received' then 'transfer_sales'
    when 'competition_prize' then 'competition_prizes'
    when 'placement_prize' then 'competition_prizes'
    when 'salary' then 'salaries'
    when 'transfer_fee_paid' then 'transfer_purchases'
    when 'draft_purchase' then 'transfer_purchases'
    when 'stadium_build' then 'stadium_expansion'
    when 'stadium_expansion' then 'stadium_expansion'
    when 'contract_termination' then 'contract_termination'
    -- Altbestand: Abfindungen wurden bisher als „adjustment“ mit Text „Abfindung …“ gebucht
    when 'adjustment' then case when p_desc like 'Abfindung%' and p_amount < 0 then 'contract_termination'
                                when p_amount >= 0 then 'other_income' else 'other_expense' end
    else case when p_amount >= 0 then 'other_income' else 'other_expense' end
  end;
$$;

create or replace function public.fd_finance_side(p_group text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_group = 'starting_capital' then 'opening'
              when p_group in ('ticket_sales', 'match_bonus', 'sponsors', 'transfer_sales', 'competition_prizes', 'other_income') then 'income'
              else 'expense' end;
$$;

create or replace function public.finance_season_report(p_world uuid, p_season_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_season public.seasons;
  v_balance bigint;
  v_n integer;
  v_capital bigint;
  v_opening bigint;
  v_timeline jsonb;
  v_groups jsonb;
  v_income bigint; v_expense bigint; v_salaries bigint; v_tsales bigint; v_tbuy bigint;
  v_top jsonb;
  v_tx jsonb;
  v_start bigint;
  v_next bigint;
begin
  select * into v_world from public.career_worlds where id = p_world;
  select * into v_season from public.seasons where world_id = p_world and id = coalesce(p_season_id, v_world.current_season_id);
  if not found then
    raise exception 'Saison nicht gefunden.' using errcode = 'P0001', hint = 'season_not_found';
  end if;
  select balance into v_balance from public.finances where club_id = v_club;

  -- Buchungen ohne Saisonbezug (season_id leer, z. B. nachgetragenes Startkapital) gehören zur Saison,
  -- in deren Buchungszeitraum (nach ID) sie liegen; so bleibt Startpunkt + Saldo = Endpunkt.
  select min(t.id) into v_start from public.financial_transactions t where t.club_id = v_club and t.season_id = v_season.id;
  select min(t.id) into v_next from public.financial_transactions t where t.club_id = v_club and t.season_id <> v_season.id and t.id > v_start;

  select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'amount', y.amount, 'balance_after', y.balance_after, 'grp', y.grp, 'run', y.run) order by y.id), '[]'::jsonb)
  into v_tx
  from (
    select x.id, x.amount, x.balance_after, x.grp, (max(coalesce(x.ord, 0)) over (order by x.id))::integer as run
    from (
      select t.id, t.amount, t.balance_after,
             public.fd_finance_group(t.kind::text, t.description, t.amount) as grp,
             coalesce(sl.ordinal, fsl.ordinal)::integer as ord
      from public.financial_transactions t
      left join (select id, ordinal from public.season_slots where season_id = v_season.id) sl
        on sl.id::text = substring(t.idempotency_key from '^slot:([0-9a-f-]{36}):')
      left join (select f.id, s.ordinal from public.fixtures f join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
                 where f.season_id = v_season.id and (f.home_club_id = v_club or f.away_club_id = v_club)) fsl
        on fsl.id::text = substring(t.idempotency_key from '^fx:([0-9a-f-]{36}):')
      where t.club_id = v_club and (t.season_id = v_season.id
        or (t.season_id is null and t.id >= v_start and (v_next is null or t.id < v_next)))
    ) x
  ) y;

  select count(*) into v_n from jsonb_array_elements(v_tx);
  select coalesce(sum(amount), 0) into v_capital from jsonb_to_recordset(v_tx) as q(id bigint, amount bigint, balance_after bigint, grp text, run integer) where grp = 'starting_capital';

  if v_n > 0 then
    select (f.balance_after - f.amount) + v_capital into v_opening from jsonb_to_recordset(v_tx) as f(id bigint, amount bigint, balance_after bigint, grp text, run integer) order by f.id limit 1;
    select jsonb_build_array(jsonb_build_object('x', 0, 'ordinal', 0, 'kind', 'opening',
             'label', case when v_capital <> 0 then 'Startkapital' else 'Saisonstart' end,
             'matchday', null, 'date', null, 'balance', v_opening, 'delta', 0, 'count', 0))
      || coalesce((
        select jsonb_agg(jsonb_build_object(
          'x', case when g.run = 0 then 0.5 else g.run end, 'ordinal', g.run,
          'kind', coalesce(sl.kind, 'prep'),
          'label', coalesce(sl.label, 'Vorbereitung und Transfers'),
          'matchday', sl.matchday, 'date', sl.slot_date,
          'balance', g.end_balance, 'delta', g.delta, 'count', g.n) order by g.run)
        from (select run, sum(amount) as delta, (array_agg(balance_after order by id desc))[1] as end_balance, count(*) as n
              from jsonb_to_recordset(v_tx) as q(id bigint, amount bigint, balance_after bigint, grp text, run integer) where grp <> 'starting_capital' group by run) g
        left join public.season_slots sl on sl.season_id = v_season.id and sl.ordinal = g.run
      ), '[]'::jsonb)
    into v_timeline;
  else
    v_timeline := '[]'::jsonb;
  end if;

  select jsonb_agg(jsonb_build_object('key', k.key, 'side', public.fd_finance_side(k.key),
           'amount', case when public.fd_finance_side(k.key) = 'expense' then -coalesce(s.total, 0) else coalesce(s.total, 0) end,
           'count', coalesce(s.n, 0)) order by k.ord)
  into v_groups
  from (values ('ticket_sales', 1), ('match_bonus', 2), ('sponsors', 3), ('transfer_sales', 4), ('competition_prizes', 5), ('other_income', 6),
               ('salaries', 7), ('transfer_purchases', 8), ('stadium_expansion', 9), ('contract_termination', 10), ('other_expense', 11)) k(key, ord)
  left join (select grp, sum(amount) as total, count(*) as n from jsonb_to_recordset(v_tx) as q(id bigint, amount bigint, balance_after bigint, grp text, run integer) group by grp) s on s.grp = k.key;

  select coalesce(sum((g ->> 'amount')::bigint) filter (where g ->> 'side' = 'income'), 0),
         coalesce(sum((g ->> 'amount')::bigint) filter (where g ->> 'side' = 'expense'), 0),
         coalesce(sum((g ->> 'amount')::bigint) filter (where g ->> 'key' = 'salaries'), 0),
         coalesce(sum((g ->> 'amount')::bigint) filter (where g ->> 'key' = 'transfer_sales'), 0),
         coalesce(sum((g ->> 'amount')::bigint) filter (where g ->> 'key' = 'transfer_purchases'), 0)
  into v_income, v_expense, v_salaries, v_tsales, v_tbuy
  from jsonb_array_elements(v_groups) g;

  select coalesce(jsonb_agg(t order by (t ->> 'amount')::bigint desc), '[]'::jsonb) into v_top from (
    select jsonb_build_object('key', g ->> 'key', 'side', g ->> 'side', 'amount', (g ->> 'amount')::bigint,
             'share', round((g ->> 'amount')::numeric * 100 / nullif(case when g ->> 'side' = 'income' then v_income else v_expense end, 0), 1)) as t
    from jsonb_array_elements(v_groups) g
    where g ->> 'side' in ('income', 'expense') and (g ->> 'amount')::bigint > 0
    order by (g ->> 'amount')::bigint desc limit 3) q;

  return jsonb_build_object(
    'club_id', v_club,
    'season_id', v_season.id,
    'current_season_id', v_world.current_season_id,
    'balance', v_balance,
    'empty', v_n = 0,
    'booking_count', v_n,
    'slot_count', (select count(*) from public.season_slots where season_id = v_season.id),
    'seasons', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'year', s.year, 'status', s.status,
                 'current', s.id = v_world.current_season_id,
                 'has_bookings', exists (select 1 from public.financial_transactions t where t.club_id = v_club and t.season_id = s.id)) order by s.year desc)
               from public.seasons s where s.world_id = p_world
                 and (s.id = v_world.current_season_id or exists (select 1 from public.financial_transactions t where t.club_id = v_club and t.season_id = s.id))), '[]'::jsonb),
    'timeline', v_timeline,
    'starting_capital', v_capital,
    'groups', v_groups,
    'metrics', jsonb_build_object('income', v_income, 'expense', v_expense, 'saldo', v_income - v_expense,
                 'salaries', v_salaries, 'transfer_income', v_tsales, 'transfer_spend', v_tbuy, 'net_transfer', v_tsales - v_tbuy, 'top', v_top)
  );
end;
$$;

revoke all on function public.finance_season_report(uuid, uuid) from public, anon;
grant execute on function public.finance_season_report(uuid, uuid) to authenticated;
revoke all on function public.fd_finance_group(text, text, bigint) from public, anon;
grant execute on function public.fd_finance_group(text, text, bigint) to authenticated;
revoke all on function public.fd_finance_side(text) from public, anon;
grant execute on function public.fd_finance_side(text) to authenticated;
