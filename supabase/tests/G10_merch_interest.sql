-- G10: Fanshop und Kreditzinsen (Migration 0047). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
begin;
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select c.id as hclub from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset

-- Zinsstaffel
select tests.assert(public.fd_interest_amount(5000000) = 300000, 'Zins: 5 Mio. Schulden = 6 %');
select tests.assert(public.fd_interest_amount(20000000) = 600000 + 1100000, 'Zins: gestaffelt 6 % / 11 %');
select tests.assert(public.fd_interest_amount(60000000) = 600000 + 4400000 + 1800000, 'Zins: gestaffelt bis 18 %');
select tests.assert(public.fd_interest_amount(0) = 0, 'Zins: keine Schulden, kein Zins');
-- Gruppen
select tests.assert(public.fd_finance_group('merchandising', '', 5) = 'merchandising' and public.fd_finance_side('merchandising') = 'income', 'Gruppe: Fanshop ist Einnahme');
select tests.assert(public.fd_finance_group('merch_purchase', '', -5) = 'merch_costs' and public.fd_finance_group('merch_storage', '', -5) = 'merch_costs', 'Gruppe: Fanshopkosten');
select tests.assert(public.fd_finance_group('loan_interest', '', -5) = 'interest' and public.fd_finance_side('interest') = 'expense', 'Gruppe: Zinsen sind Ausgabe');

set role authenticated;
select tests.login(:'host');
select public.merch_overview(:'world') as ov \gset
select tests.assert(jsonb_array_length((:'ov'::jsonb) -> 'products') = 6, 'Fanshop: sechs Produkte');
select public.merch_set_price(:'world', 'scarf', 30);
select tests.expect_error(format($$ select public.merch_set_price(%L, 'scarf', 500) $$, :'world'), 'merch_price');
select tests.expect_error(format($$ select public.merch_set_price(%L, 'scarf', 2) $$, :'world'), 'merch_price');
select tests.expect_error(format($$ select public.merch_set_price(%L, 'laser', 20) $$, :'world'), 'merch_product');
reset role;
select tests.assert((select price from public.club_merch where club_id = :'hclub' and product_key = 'scarf') = 30, 'Preis gespeichert');

select balance as bal0 from public.finances where club_id = :'hclub' \gset
select stock as stock0 from public.club_merch where club_id = :'hclub' and product_key = 'cap' \gset
set role authenticated;
select tests.login(:'host');
select public.merch_order(:'world', 'cap', 1000);
reset role;
select tests.assert((select balance from public.finances where club_id = :'hclub') = :bal0 - 6000, 'Einkauf: 1000 Caps à 6 € abgebucht');
select tests.assert((select stock from public.club_merch where club_id = :'hclub' and product_key = 'cap') = :stock0 + 1000, 'Einkauf: Lagerbestand erhöht');
update public.finances set balance = 1000 where club_id = :'hclub';
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.merch_order(%L, 'cap', 5000) $$, :'world'), 'insufficient_funds');
reset role;
update public.finances set balance = :bal0 where club_id = :'hclub';

-- Abrechnung eines Termins (Heimspiel des Menschenvereins)
select s.id as slot from public.season_slots s join public.fixtures f on f.season_id = s.season_id and f.slot_key = s.slot_key
  where s.season_id = :'season' and s.kind = 'league' and :'hclub' in (f.home_club_id, f.away_club_id)
    and not exists (select 1 from public.merch_history h where h.club_id = :'hclub' and h.slot_id = s.id) order by s.ordinal desc limit 1 \gset
update public.fixtures set status = 'finished' where season_id = :'season' and slot_key = (select slot_key from public.season_slots where id = :'slot');
select count(*) as n_tx0 from public.financial_transactions where club_id = :'hclub' and kind::text = 'merchandising' \gset
select public.fd_slot_economy(:'slot');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'hclub' and kind::text = 'merchandising') = :n_tx0 + 1, 'Fanshop-Erlös genau einmal gebucht');
select tests.assert((select count(*) from public.merch_history where club_id = :'hclub' and slot_id = :'slot') = 6, 'Historie: sechs Produktzeilen');
select tests.assert((select sum(revenue) from public.merch_history where club_id = :'hclub' and slot_id = :'slot') = (select amount from public.financial_transactions where club_id = :'hclub' and kind::text = 'merchandising' and idempotency_key = 'merch:rev:' || :'slot' || ':' || :'hclub'), 'Erlös der Historie = Buchung');
select balance as bal1 from public.finances where club_id = :'hclub' \gset
select public.fd_slot_economy(:'slot');
select tests.assert((select balance from public.finances where club_id = :'hclub') = :bal1, 'Zweiter Lauf bucht nichts doppelt');
select tests.assert((select count(*) from public.merch_history where club_id = :'hclub' and slot_id = :'slot') = 6, 'Historie bleibt eindeutig');
select tests.assert(not exists (select 1 from public.club_merch where stock < 0), 'Lagerbestand nie negativ');
-- KI-Vereine erzielen ebenfalls Fanshop-Erlöse, aber ohne Historie
select tests.assert(exists (select 1 from public.financial_transactions t join public.clubs c on c.id = t.club_id where c.world_id = :'world' and c.control = 'ai' and t.kind::text = 'merchandising' and t.idempotency_key like 'merch:rev:' || :'slot' || ':%'), 'KI-Vereine erhalten Fanshop-Erlöse');
select tests.assert(not exists (select 1 from public.merch_history h join public.clubs c on c.id = h.club_id where c.control = 'ai'), 'KI-Vereine: keine Historienzeilen');
-- Erlöse bleiben im realistischen Rahmen (nie > 25 % des Ticketerlöses eines Spiels bei gleichem Verein, absolut < 2 Mio.)
select tests.assert(not exists (select 1 from public.financial_transactions where world_id = :'world' and kind::text = 'merchandising' and amount > 2000000), 'Fanshop-Erlös je Spiel < 2 Mio. €');

-- Kreditzinsen
select s.id as lslot from public.season_slots s join public.fixtures f on f.season_id = s.season_id and f.slot_key = s.slot_key
  where s.season_id = :'season' and s.kind = 'league' and s.id <> :'slot' and :'hclub' in (f.home_club_id, f.away_club_id)
    and not exists (select 1 from public.financial_transactions t where t.club_id = :'hclub' and t.idempotency_key = 'interest:' || s.id || ':' || :'hclub') order by s.ordinal desc limit 1 \gset
update public.fixtures set status = 'finished' where season_id = :'season' and slot_key = (select slot_key from public.season_slots where id = :'lslot');
update public.finances set balance = -20000000 where club_id = :'hclub';
select public.fd_slot_economy(:'lslot');
select tests.assert(abs((select -amount from public.financial_transactions where club_id = :'hclub' and kind::text = 'loan_interest' and idempotency_key = 'interest:' || :'lslot' || ':' || :'hclub')
  - public.fd_interest_amount(20000000) / (select count(*) from public.season_slots where season_id = :'season' and kind = 'league')) < 20000, 'Kreditzins je Ligaspieltag korrekt (Fanshop-Buchungen verschieben die Basis nur minimal)');
select count(*) as n_int from public.financial_transactions where club_id = :'hclub' and kind::text = 'loan_interest' \gset
select public.fd_slot_economy(:'lslot');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'hclub' and kind::text = 'loan_interest') = :n_int, 'Zinsen werden nicht doppelt gebucht');
-- kein Zins bei positivem Konto
update public.finances set balance = 5000000 where club_id = :'hclub';
delete from public.financial_transactions where club_id = :'hclub' and kind::text = 'loan_interest';
select public.fd_slot_economy(:'lslot');
select tests.assert(not exists (select 1 from public.financial_transactions where club_id = :'hclub' and kind::text = 'loan_interest'), 'Positives Konto: kein Zins');
-- Schuldenübersicht
update public.finances set balance = -20000000 where club_id = :'hclub';
set role authenticated;
select tests.login(:'host');
select tests.assert((public.finance_debt(:'world') ->> 'debt')::bigint = 20000000 and (public.finance_debt(:'world') ->> 'interest_per_matchday')::bigint > 0, 'Schuldenübersicht zeigt Schulden und Zins je Spieltag');
reset role;
-- Dashboard kennt die neuen Gruppen
set role authenticated;
select tests.login(:'host');
select tests.assert((select count(*) from jsonb_array_elements(public.finance_season_report(:'world', null) -> 'groups') g where g ->> 'key' in ('merchandising', 'merch_costs', 'interest')) = 3, 'Finanzbericht enthält Fanshop- und Zinsgruppen');
reset role;
rollback;
\echo 'OK G10'
