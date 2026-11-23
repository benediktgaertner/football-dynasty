-- =====================================================================
-- Migration 0047: Fanshop (Merchandising) und Kreditzinsen
--   * Neue Buchungstypen merchandising, merch_purchase, merch_storage, loan_interest
--     (ALTER TYPE ... ADD VALUE als eigene Anweisungen am Anfang; die Werte werden hier nur zur Laufzeit verwendet).
--   * Finanzgruppen: merchandising (Einnahme), merch_costs und interest (Ausgaben) im Finanzdashboard.
--   * Fanshop: merch_products (Katalog), club_merch (Preis, Lager, Nachbestellung je Verein), merch_history
--     (Abrechnung je Spieltermin, nur für Menschen-Vereine). Abrechnung serverseitig und idempotent
--     beim Freigeben eines Termins (Trigger auf season_slots), auch für KI-Vereine (ohne Historie).
--   * Kreditzinsen: negativer Kontostand ist erlaubt, wird aber je Ligaspieltag gestaffelt verzinst.
--   * RPCs: merch_overview, merch_set_price, merch_order, merch_set_reorder, finance_debt.
-- Idempotent und ohne Datenverlust.
-- =====================================================================

alter type public.transaction_kind add value if not exists 'merchandising';
alter type public.transaction_kind add value if not exists 'merch_purchase';
alter type public.transaction_kind add value if not exists 'merch_storage';
alter type public.transaction_kind add value if not exists 'loan_interest';

-- ---------- Finanzgruppen ----------
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

create or replace function public.fd_finance_side(p_group text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_group = 'starting_capital' then 'opening'
              when p_group in ('ticket_sales', 'match_bonus', 'sponsors', 'merchandising', 'transfer_sales', 'competition_prizes', 'other_income') then 'income'
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
  from (values ('ticket_sales', 1), ('match_bonus', 2), ('sponsors', 3), ('merchandising', 4), ('transfer_sales', 5), ('competition_prizes', 6), ('other_income', 7),
               ('salaries', 8), ('transfer_purchases', 9), ('stadium_expansion', 10), ('contract_termination', 11), ('merch_costs', 12), ('interest', 13), ('other_expense', 14)) k(key, ord)
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

-- ---------- Fanshop: Tabellen ----------
create table if not exists public.merch_products (
  key text primary key,
  label text not null,
  base_price integer not null check (base_price > 0),
  unit_cost integer not null check (unit_cost > 0),
  penetration numeric(6,4) not null check (penetration > 0),   -- Käufer je Besucher und Spiel
  storage_rate numeric(6,4) not null default 0.002,             -- Lagerkosten je Termin in Anteil des Lagerwerts
  sort integer not null
);
insert into public.merch_products(key, label, base_price, unit_cost, penetration, sort) values
  ('home_jersey', 'Heimtrikot', 90, 38, 0.0150, 1),
  ('away_jersey', 'Auswärtstrikot', 90, 38, 0.0080, 2),
  ('special_jersey', 'Sondertrikot', 110, 48, 0.0030, 3),
  ('scarf', 'Schal', 25, 7, 0.0400, 4),
  ('cap', 'Cap', 22, 6, 0.0200, 5),
  ('flag', 'Fahne', 15, 4, 0.0150, 6)
on conflict (key) do nothing;

create table if not exists public.club_merch (
  club_id uuid not null references public.clubs(id) on delete cascade,
  product_key text not null references public.merch_products(key),
  price integer not null check (price > 0),
  stock integer not null default 0 check (stock >= 0),
  reorder_target integer not null default 0 check (reorder_target >= 0 and reorder_target <= 50000),
  updated_at timestamptz not null default now(),
  primary key (club_id, product_key)
);

create table if not exists public.merch_history (
  club_id uuid not null references public.clubs(id) on delete cascade,
  slot_id uuid not null references public.season_slots(id) on delete cascade,
  product_key text not null references public.merch_products(key),
  season_id uuid not null references public.seasons(id) on delete cascade,
  price integer not null,
  units integer not null,
  revenue bigint not null,
  unit_cost integer not null,
  storage_cost bigint not null default 0,
  stock_after integer not null,
  home boolean not null,
  primary key (club_id, slot_id, product_key)
);
create index if not exists merch_history_season_idx on public.merch_history(club_id, season_id);

alter table public.merch_products enable row level security;
alter table public.club_merch enable row level security;
alter table public.merch_history enable row level security;
revoke all on public.merch_products, public.club_merch, public.merch_history from anon, authenticated;

-- ---------- Abrechnung je Termin (Fanshop + Kreditzinsen) ----------
create or replace function public.fd_slot_economy(p_slot uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot public.season_slots;
  r record;
  p record;
  v_rank integer; v_n integer; v_rankf numeric; v_pool numeric; v_demand numeric; v_el numeric;
  v_units integer; v_need integer; v_rev bigint; v_store bigint; v_buy bigint; v_stock integer;
  v_total_rev bigint; v_total_store bigint; v_bal bigint; v_rate numeric; v_int bigint; v_nleague integer;
begin
  select * into v_slot from public.season_slots where id = p_slot;
  if v_slot.id is null or v_slot.kind = 'season_end' then return; end if;
  select count(*) into v_nleague from public.season_slots where season_id = v_slot.season_id and kind = 'league';

  for r in
    select x.club_id, x.is_home, x.att, c.reputation, c.control::text as control, coalesce(st.capacity, 5000) as capacity
    from (
      select f.home_club_id as club_id, true as is_home, coalesce(res.attendance, 0) as att
        from public.fixtures f left join public.fixture_results res on res.fixture_id = f.id
       where f.season_id = v_slot.season_id and f.slot_key = v_slot.slot_key and f.status in ('finished', 'released')
      union all
      select f.away_club_id, false, 0
        from public.fixtures f
       where f.season_id = v_slot.season_id and f.slot_key = v_slot.slot_key and f.status in ('finished', 'released')
    ) x
    join public.clubs c on c.id = x.club_id
    left join public.stadiums st on st.club_id = x.club_id
    where exists (select 1 from public.finances fi where fi.club_id = x.club_id)
  loop
    -- Tabellenplatz (Ligaerfolg) -> Nachfragefaktor 0,75..1,25
    select (select count(*) + 1 from public.standings s2 where s2.competition_id = s.competition_id and s2.group_id is null and s2.points > s.points),
           (select count(*) from public.standings s3 where s3.competition_id = s.competition_id and s3.group_id is null)
      into v_rank, v_n
      from public.standings s join public.competitions co on co.id = s.competition_id
     where s.club_id = r.club_id and s.group_id is null and co.season_id = v_slot.season_id and co.kind::text = 'league' limit 1;
    v_rankf := case when v_rank is null then 1 else 1.25 - 0.5 * (v_rank - 1)::numeric / greatest(v_n - 1, 1) end;
    -- Käuferbasis: Heimspiel = Zuschauer + Online/Fernkäufer; Auswärtsspiel = mitgereiste und Fernfans
    v_pool := case when r.is_home then r.att + r.capacity * 0.35 * r.reputation / 100
                   else r.capacity * 0.30 * r.reputation / 100 + 800 end;

    insert into public.club_merch(club_id, product_key, price, stock)
    select r.club_id, mp.key, mp.base_price, case when r.control = 'ai' then 0 else 400 end from public.merch_products mp
    on conflict do nothing;

    v_total_rev := 0; v_total_store := 0; v_buy := 0;
    for p in
      select cm.product_key, cm.price, cm.stock, cm.reorder_target, mp.base_price, mp.unit_cost, mp.penetration, mp.storage_rate
        from public.club_merch cm join public.merch_products mp on mp.key = cm.product_key
       where cm.club_id = r.club_id
    loop
      if exists (select 1 from public.merch_history h where h.club_id = r.club_id and h.slot_id = p_slot and h.product_key = p.product_key) then continue; end if;
      v_el := least(3, greatest(0.15, power(p.base_price::numeric / p.price, 1.8)));
      v_demand := v_pool * p.penetration * (0.55 + r.reputation / 100 * 0.9) * v_rankf * v_el
                  * (case when p.product_key = 'special_jersey' and v_slot.kind <> 'league' then 1.6 else 1 end)
                  * (0.92 + (abs(hashtext(r.club_id::text || p_slot::text || p.product_key)) % 1000) / 1000.0 * 0.16);
      v_stock := p.stock;
      -- KI: kauft nach Bedarf; Menschen: Nachbestellung auf Zielbestand, nur wenn das Konto es deckt
      if r.control = 'ai' then
        v_need := greatest(0, ceil(v_demand * 1.2)::integer - v_stock);
      elsif p.reorder_target > v_stock then
        v_need := p.reorder_target - v_stock;
        select balance into v_bal from public.finances where club_id = r.club_id;
        if v_bal < v_need::bigint * p.unit_cost then v_need := greatest(0, floor(greatest(v_bal, 0)::numeric / p.unit_cost)::integer); end if;
      else v_need := 0; end if;
      if v_need > 0 then
        perform public.fd_pay(r.club_id, 'merch_purchase', -(v_need::bigint * p.unit_cost), 'merch:buy:' || p_slot || ':' || r.club_id || ':' || p.product_key,
          'Fanshop-Einkauf ' || v_need || ' × ' || p.product_key, v_slot.season_id);
        v_stock := v_stock + v_need;
      end if;
      v_units := least(v_stock, floor(v_demand)::integer);
      v_rev := v_units::bigint * p.price;
      v_stock := v_stock - v_units;
      v_store := floor(v_stock::numeric * p.unit_cost * p.storage_rate)::bigint;
      v_total_rev := v_total_rev + v_rev; v_total_store := v_total_store + v_store;
      update public.club_merch set stock = v_stock, updated_at = now() where club_id = r.club_id and product_key = p.product_key;
      if r.control <> 'ai' then
        insert into public.merch_history(club_id, slot_id, product_key, season_id, price, units, revenue, unit_cost, storage_cost, stock_after, home)
        values (r.club_id, p_slot, p.product_key, v_slot.season_id, p.price, v_units, v_rev, p.unit_cost, v_store, v_stock, r.is_home)
        on conflict do nothing;
      end if;
    end loop;
    perform public.fd_pay(r.club_id, 'merchandising', v_total_rev, 'merch:rev:' || p_slot || ':' || r.club_id, 'Fanshop-Verkauf · ' || v_slot.label, v_slot.season_id);
    perform public.fd_pay(r.club_id, 'merch_storage', -v_total_store, 'merch:store:' || p_slot || ':' || r.club_id, 'Lagerkosten Fanshop · ' || v_slot.label, v_slot.season_id);
  end loop;

  -- Kreditzinsen: je Ligaspieltag, nur bei negativem Kontostand, gestaffelt (Jahreszins / Anzahl Ligatermine)
  if v_slot.kind = 'league' and v_nleague > 0 then
    for r in
      select fi.club_id, fi.balance from public.finances fi
       where fi.balance < 0 and exists (select 1 from public.fixtures f where f.season_id = v_slot.season_id and f.slot_key = v_slot.slot_key
                                         and fi.club_id in (f.home_club_id, f.away_club_id))
    loop
      v_int := public.fd_interest_amount(-r.balance) / v_nleague;
      if v_int > 0 then
        perform public.fd_pay(r.club_id, 'loan_interest', -v_int, 'interest:' || p_slot || ':' || r.club_id,
          'Kreditzinsen auf ' || to_char(-r.balance, 'FM999G999G999G999') || ' € Schulden · ' || v_slot.label, v_slot.season_id);
      end if;
    end loop;
  end if;
end;
$$;

-- Jahreszins in Stufen: bis 10 Mio. 6 %, bis 50 Mio. 11 %, darüber 18 % (nur auf den jeweiligen Anteil)
create or replace function public.fd_interest_amount(p_debt bigint)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select floor(least(p_debt, 10000000) * 0.06 + greatest(least(p_debt, 50000000) - 10000000, 0) * 0.11 + greatest(p_debt - 50000000, 0) * 0.18)::bigint;
$$;

create or replace function public.fd_slot_economy_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'released' and old.state is distinct from 'released' then
    begin
      perform public.fd_slot_economy(new.id);
    exception when others then
      -- die Freigabe eines Termins darf nie an der Nebenwirtschaft scheitern
      raise warning 'fd_slot_economy % fehlgeschlagen: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;
drop trigger if exists season_slots_economy on public.season_slots;
create trigger season_slots_economy after update of state on public.season_slots
  for each row execute function public.fd_slot_economy_trigger();

-- ---------- RPCs ----------
create or replace function public.merch_overview(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_season uuid; v_res jsonb;
begin
  select current_season_id into v_season from public.career_worlds where id = p_world;
  insert into public.club_merch(club_id, product_key, price, stock)
  select v_club, mp.key, mp.base_price, 400 from public.merch_products mp on conflict do nothing;
  select jsonb_build_object(
    'products', coalesce((select jsonb_agg(jsonb_build_object('key', mp.key, 'label', mp.label, 'price', cm.price, 'base_price', mp.base_price,
        'unit_cost', mp.unit_cost, 'stock', cm.stock, 'reorder_target', cm.reorder_target, 'margin', cm.price - mp.unit_cost,
        'season_units', coalesce(h.u, 0), 'season_revenue', coalesce(h.r, 0), 'season_profit', coalesce(h.r - h.u * mp.unit_cost - h.s, 0),
        'recent_units', coalesce(rc.avg_u, 0),
        'reorder_needed', cm.stock < coalesce(rc.avg_u, 0) * 2) order by mp.sort)
      from public.club_merch cm join public.merch_products mp on mp.key = cm.product_key
      left join (select product_key, sum(units)::bigint u, sum(revenue) r, sum(storage_cost) s from public.merch_history where club_id = v_club and season_id = v_season group by product_key) h on h.product_key = mp.key
      left join (select product_key, round(avg(units)) avg_u from (select product_key, units, row_number() over (partition by product_key order by slot_id desc) rn from public.merch_history where club_id = v_club) z where rn <= 3 group by product_key) rc on rc.product_key = mp.key
      where cm.club_id = v_club), '[]'::jsonb),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object('ordinal', s.ordinal, 'label', s.label, 'revenue', t.r, 'profit', t.p, 'units', t.u, 'home', t.home) order by s.ordinal)
      from (select slot_id, sum(revenue) r, sum(revenue - units::bigint * unit_cost - storage_cost) p, sum(units)::bigint u, bool_or(home) home from public.merch_history where club_id = v_club and season_id = v_season group by slot_id) t
      join public.season_slots s on s.id = t.slot_id), '[]'::jsonb),
    'season', (select jsonb_build_object('revenue', coalesce(sum(revenue), 0), 'units', coalesce(sum(units), 0),
        'profit', coalesce(sum(revenue - units::bigint * unit_cost - storage_cost), 0),
        'margin', coalesce(round(sum(revenue - units::bigint * unit_cost) * 100.0 / nullif(sum(revenue), 0), 1), 0),
        'storage', coalesce(sum(storage_cost), 0))
      from public.merch_history where club_id = v_club and season_id = v_season),
    'balance', (select balance from public.finances where club_id = v_club),
    'slot_live', coalesce((select (public.fd_current_slot(p_world)).state = 'live'), false)
  ) into v_res;
  return v_res;
end;
$$;

create or replace function public.merch_set_price(p_world uuid, p_product text, p_price integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_base integer;
begin
  select base_price into v_base from public.merch_products where key = p_product;
  if v_base is null then raise exception 'Unbekanntes Produkt.' using errcode = 'P0001', hint = 'merch_product'; end if;
  if p_price is null or p_price < ceil(v_base * 0.4) or p_price > v_base * 3 then
    raise exception 'Preis außerhalb des erlaubten Bereichs (% – % €).', ceil(v_base * 0.4), v_base * 3 using errcode = 'P0001', hint = 'merch_price';
  end if;
  if coalesce((select (public.fd_current_slot(p_world)).state = 'live'), false) then
    raise exception 'Während eines laufenden Spieltags sind die Preise gesperrt.' using errcode = 'P0001', hint = 'slot_live';
  end if;
  insert into public.club_merch(club_id, product_key, price) values (v_club, p_product, p_price)
  on conflict (club_id, product_key) do update set price = excluded.price, updated_at = now();
end;
$$;

create or replace function public.merch_order(p_world uuid, p_product text, p_qty integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_cost integer; v_stock integer; v_season uuid;
begin
  select unit_cost into v_cost from public.merch_products where key = p_product;
  if v_cost is null then raise exception 'Unbekanntes Produkt.' using errcode = 'P0001', hint = 'merch_product'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 20000 then raise exception 'Menge 1 – 20.000.' using errcode = 'P0001', hint = 'merch_qty'; end if;
  insert into public.club_merch(club_id, product_key, price, stock)
  select v_club, p_product, base_price, 400 from public.merch_products where key = p_product on conflict do nothing;
  select stock into v_stock from public.club_merch where club_id = v_club and product_key = p_product for update;
  if v_stock + p_qty > 50000 then raise exception 'Lager fasst höchstens 50.000 Stück je Produkt.' using errcode = 'P0001', hint = 'merch_capacity'; end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  -- Einkauf muss durch das Konto gedeckt sein (kein Einkauf auf Pump)
  perform public.post_transaction(v_club, 'merch_purchase', -(p_qty::bigint * v_cost), 'merch:order:' || gen_random_uuid(),
    'Fanshop-Einkauf ' || p_qty || ' × ' || p_product, v_season);
  update public.club_merch set stock = stock + p_qty, updated_at = now() where club_id = v_club and product_key = p_product;
  return jsonb_build_object('stock', v_stock + p_qty, 'cost', p_qty::bigint * v_cost);
end;
$$;

create or replace function public.merch_set_reorder(p_world uuid, p_product text, p_target integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if p_target is null or p_target < 0 or p_target > 50000 then raise exception 'Zielbestand 0 – 50.000.' using errcode = 'P0001', hint = 'merch_qty'; end if;
  update public.club_merch set reorder_target = p_target, updated_at = now() where club_id = v_club and product_key = p_product;
end;
$$;

create or replace function public.finance_debt(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_bal bigint; v_season uuid; v_n integer;
begin
  select balance into v_bal from public.finances where club_id = v_club;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  select count(*) into v_n from public.season_slots where season_id = v_season and kind = 'league';
  return jsonb_build_object(
    'balance', v_bal, 'debt', greatest(-v_bal, 0),
    'interest_per_matchday', case when v_bal < 0 and v_n > 0 then public.fd_interest_amount(-v_bal) / v_n else 0 end,
    'interest_season', coalesce((select -sum(amount) from public.financial_transactions where club_id = v_club and season_id = v_season and kind::text = 'loan_interest'), 0),
    'tiers', jsonb_build_array(jsonb_build_object('upto', 10000000, 'rate', 6), jsonb_build_object('upto', 50000000, 'rate', 11), jsonb_build_object('upto', null, 'rate', 18)));
end;
$$;

revoke all on function public.merch_overview(uuid), public.merch_set_price(uuid, text, integer), public.merch_order(uuid, text, integer),
  public.merch_set_reorder(uuid, text, integer), public.finance_debt(uuid) from public, anon;
grant execute on function public.merch_overview(uuid), public.merch_set_price(uuid, text, integer), public.merch_order(uuid, text, integer),
  public.merch_set_reorder(uuid, text, integer), public.finance_debt(uuid) to authenticated;
revoke all on function public.fd_slot_economy(uuid), public.fd_interest_amount(bigint), public.fd_slot_economy_trigger() from public, anon, authenticated;
grant execute on function public.fd_interest_amount(bigint) to authenticated;
revoke all on function public.finance_season_report(uuid, uuid), public.fd_finance_group(text, text, bigint), public.fd_finance_side(text) from public, anon;
grant execute on function public.finance_season_report(uuid, uuid), public.fd_finance_group(text, text, bigint), public.fd_finance_side(text) to authenticated;
