-- 0037: Finanzdashboard – Gruppenzuordnung, Summen = Rohbuchungen, Timeline, Zugriffsschutz
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
begin;
insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000f1');
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset
select current_season_id as cur from public.career_worlds where id = :'world' \gset

-- Zuordnung: jeder vorhandene Buchungstyp (auch der neue) landet in genau einer bekannten Gruppe
select tests.assert('contract_termination' = any (enum_range(null::public.transaction_kind)::text[]), 'Buchungstyp contract_termination vorhanden');
select tests.assert(not exists (select 1 from unnest(enum_range(null::public.transaction_kind)::text[]) k
  where public.fd_finance_group(k, '', 1) is null or public.fd_finance_group(k, '', -1) is null), 'jeder transaction_kind hat eine Gruppe');
select tests.assert(public.fd_finance_group('ticket_income', '', 5) = 'ticket_sales'
  and public.fd_finance_group('match_bonus', '', 5) = 'match_bonus'
  and public.fd_finance_group('sponsor', '', 5) = 'sponsors'
  and public.fd_finance_group('transfer_fee_received', '', 5) = 'transfer_sales'
  and public.fd_finance_group('competition_prize', '', 5) = 'competition_prizes'
  and public.fd_finance_group('placement_prize', '', 5) = 'competition_prizes'
  and public.fd_finance_group('salary', '', -5) = 'salaries'
  and public.fd_finance_group('transfer_fee_paid', '', -5) = 'transfer_purchases'
  and public.fd_finance_group('draft_purchase', '', -5) = 'transfer_purchases'
  and public.fd_finance_group('stadium_build', '', -5) = 'stadium_expansion'
  and public.fd_finance_group('stadium_expansion', '', -5) = 'stadium_expansion'
  and public.fd_finance_group('contract_termination', '', -5) = 'contract_termination'
  and public.fd_finance_group('stadium_running_cost', '', -5) = 'other_expense'
  and public.fd_finance_group('adjustment', 'Abfindung Meier', -5) = 'contract_termination'
  and public.fd_finance_group('adjustment', 'Korrektur', -5) = 'other_expense'
  and public.fd_finance_group('adjustment', 'Korrektur', 5) = 'other_income'
  and public.fd_finance_group('starting_capital', '', 5) = 'starting_capital', 'Zuordnung der Buchungstypen zu Gruppen');

-- zusätzliche Buchungen (Vertragsauflösung neuer Typ, Altform Abfindung, Doppelbuchung mit gleichem Schlüssel)
select public.post_transaction(:'host_club', 'contract_termination', -250000, 'g1:term', 'Vertragsauflösung Test', :'cur', true);
select public.post_transaction(:'host_club', 'contract_termination', -250000, 'g1:term', 'Vertragsauflösung Test', :'cur', true);
select public.post_transaction(:'host_club', 'adjustment', -100000, 'g1:old', 'Abfindung Altfall', :'cur', true);
select public.post_transaction(:'host_club', 'transfer_fee_received', 3000000, 'g1:sale', 'Verkauf Test', :'cur', true);
select public.post_transaction(:'host_club', 'transfer_fee_paid', -1200000, 'g1:buy', 'Kauf Test', :'cur', true);

set role authenticated;
select tests.login(:'host');
select public.finance_season_report(:'world') as rep \gset
select public.finance_season_report(:'world', :'cur') as rep2 \gset
select public.finance_season_report(:'world', null) as rep3 \gset
reset role;

select tests.assert(:'rep'::jsonb = :'rep2'::jsonb and :'rep'::jsonb = :'rep3'::jsonb, 'ohne Saison = laufende Saison');
select tests.assert((:'rep'::jsonb ->> 'club_id')::uuid = :'host_club', 'Bericht gehört zum eigenen Verein');
select tests.assert(not (:'rep'::jsonb ->> 'empty')::boolean and jsonb_array_length(:'rep'::jsonb -> 'groups') = 11, 'Saison nicht leer, 11 Gruppen');

-- Summen = Rohbuchungen (ohne Doppelzählung: doppelte Idempotenz-Buchung zählt einmal)
select coalesce(sum(amount), 0) as raw_sum, count(*) as raw_n from public.financial_transactions where club_id = :'host_club' and (season_id = :'cur' or (season_id is null and id >= (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur'))) \gset
select (sum((g ->> 'amount')::bigint) filter (where g ->> 'side' = 'income') - sum((g ->> 'amount')::bigint) filter (where g ->> 'side' = 'expense')
        + (:'rep'::jsonb ->> 'starting_capital')::bigint) as grp_sum,
       sum((g ->> 'count')::int) as grp_n
  from jsonb_array_elements(:'rep'::jsonb -> 'groups') g \gset
select tests.assert(:grp_sum = :raw_sum, 'Summe aller Gruppen (+Startkapital) = Summe der Buchungen: ' || :grp_sum || ' / ' || :raw_sum);
select tests.assert(:grp_n + (select count(*) from public.financial_transactions where club_id = :'host_club' and (season_id = :'cur' or (season_id is null and id >= (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur'))) and kind = 'starting_capital') = :raw_n
  and (:'rep'::jsonb ->> 'booking_count')::int = :raw_n, 'jede Buchung genau einmal gezählt (' || :raw_n || ')');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'host_club' and idempotency_key = 'g1:term') = 1, 'Doppelbuchung mit gleichem Schlüssel entsteht nicht');

-- einzelne Gruppen gegen Rohdaten
select tests.assert((select (g ->> 'amount')::bigint from jsonb_array_elements(:'rep'::jsonb -> 'groups') g where g ->> 'key' = 'contract_termination') = 350000, 'Vertragsauflösungen: neuer Typ und Altform Abfindung = 350.000 €');
select tests.assert((select (g ->> 'amount')::bigint from jsonb_array_elements(:'rep'::jsonb -> 'groups') g where g ->> 'key' = 'salaries')
  = -(select sum(amount) from public.financial_transactions where club_id = :'host_club' and (season_id = :'cur' or (season_id is null and id >= (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur'))) and kind = 'salary'), 'Gehälter = Summe der Gehaltsbuchungen');
select tests.assert((select (g ->> 'amount')::bigint from jsonb_array_elements(:'rep'::jsonb -> 'groups') g where g ->> 'key' = 'ticket_sales')
  = coalesce((select sum(amount) from public.financial_transactions where club_id = :'host_club' and (season_id = :'cur' or (season_id is null and id >= (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur'))) and kind = 'ticket_income'), 0), 'Ticketverkäufe = Summe der Ticketbuchungen');
select tests.assert((:'rep'::jsonb -> 'metrics' ->> 'net_transfer')::bigint = (select sum(amount) from public.financial_transactions where club_id = :'host_club' and (season_id = :'cur' or (season_id is null and id >= (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur'))) and kind in ('transfer_fee_received', 'transfer_fee_paid', 'draft_purchase')),
  'Netto-Transferbilanz = Verkäufe − Käufe (inkl. Draft)');
select tests.assert((:'rep'::jsonb -> 'metrics' ->> 'saldo')::bigint = :raw_sum - (:'rep'::jsonb ->> 'starting_capital')::bigint, 'Saisonsaldo = Einnahmen − Ausgaben');
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'metrics' -> 'top') between 1 and 3
  and (select sum((t ->> 'share')::numeric) from jsonb_array_elements(:'rep'::jsonb -> 'metrics' -> 'top') t) <= 300, 'Top-Einflussfaktoren (max. 3, mit Anteil)');

-- Timeline: Startpunkt, aufsteigend, letzter Punkt = Kontostand
select tests.assert(:'rep'::jsonb -> 'timeline' -> 0 ->> 'kind' = 'opening', 'Timeline beginnt mit Start-/Saisonstartpunkt');
select tests.assert((select bool_and((e.value ->> 'x')::numeric > (lag_x)) from (
    select e.value, lag((e.value ->> 'x')::numeric) over (order by e.ordinality) as lag_x from jsonb_array_elements(:'rep'::jsonb -> 'timeline') with ordinality e) e where lag_x is not null), 'Timeline-X streng aufsteigend');
select tests.assert((:'rep'::jsonb -> 'timeline' -> -1 ->> 'balance')::bigint = (select balance from public.finances where club_id = :'host_club')
  and (:'rep'::jsonb ->> 'balance')::bigint = (select balance from public.finances where club_id = :'host_club'), 'letzter Timeline-Punkt = finances.balance');
select tests.assert((:'rep'::jsonb -> 'timeline' -> 0 ->> 'balance')::bigint + (:'rep'::jsonb -> 'metrics' ->> 'saldo')::bigint
  = (:'rep'::jsonb -> 'timeline' -> -1 ->> 'balance')::bigint, 'Startpunkt + Saldo = Endpunkt');
select tests.assert((select count(*) from jsonb_array_elements(:'rep'::jsonb -> 'timeline') e where e ->> 'kind' = 'league') >= 20, 'Timeline: Ligaspieltage als Punkte');

-- Saisonliste und historische Saison
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'seasons') >= 2 and (:'rep'::jsonb -> 'seasons' -> 0 ->> 'current')::boolean, 'Saisonliste mit laufender Saison zuerst');
select s.id as old_season from public.seasons s where s.world_id = :'world' and s.id <> :'cur'
  and exists (select 1 from public.financial_transactions t where t.club_id = :'host_club' and t.season_id = s.id) order by s.year limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.finance_season_report(:'world', :'old_season') as old \gset
reset role;
select tests.assert((:'old'::jsonb -> 'timeline' -> -1 ->> 'balance')::bigint = (select balance_after from public.financial_transactions where club_id = :'host_club' and id < (select min(id) from public.financial_transactions where club_id = :'host_club' and season_id = :'cur') order by id desc limit 1)
  and (:'old'::jsonb ->> 'season_id')::uuid = :'old_season', 'historische Saison: Endpunkt = letzte Buchung der Saison');

-- Leere Saison: ehrlicher Leerzustand (neue Saison ohne Buchungen)
insert into public.seasons(world_id, year, status) values (:'world', 2999, 'planned') returning id as empty_season \gset
set role authenticated;
select tests.login(:'host');
select public.finance_season_report(:'world', :'empty_season') as emp \gset
reset role;
select tests.assert((:'emp'::jsonb ->> 'empty')::boolean and jsonb_array_length(:'emp'::jsonb -> 'timeline') = 0
  and (:'emp'::jsonb -> 'metrics' ->> 'income')::bigint = 0 and (:'emp'::jsonb -> 'metrics' ->> 'expense')::bigint = 0 and jsonb_array_length(:'emp'::jsonb -> 'metrics' -> 'top') = 0, 'leere Saison: leer, Nullwerte, keine erfundenen Punkte');

-- Zugriff: anderer Manager sieht nur den eigenen Verein; Fremde/anonyme Aufrufer scheitern; fremde Saison nicht abrufbar
set role authenticated;
select tests.login(:'guest');
select public.finance_season_report(:'world') as grep \gset
reset role;
select tests.assert((:'grep'::jsonb ->> 'club_id')::uuid = :'guest_club' and :'guest_club' <> :'host_club'
  and (:'grep'::jsonb ->> 'balance')::bigint = (select balance from public.finances where club_id = :'guest_club'), 'zweiter Manager erhält nur seinen eigenen Verein');
select tests.assert(not exists (select 1 from jsonb_array_elements(:'grep'::jsonb -> 'groups') g where g ->> 'key' = 'contract_termination' and (g ->> 'amount')::bigint <> 0), 'fremde Sonderbuchungen tauchen nicht auf');
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000f1');
select tests.expect_error(format($$ select public.finance_season_report(%L) $$, :'world'), 'profile_required');
select public.set_username('G1Fremder') is not null as ok \gset
select tests.expect_error(format($$ select public.finance_season_report(%L) $$, :'world'), 'not_a_member');
reset role;
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.finance_season_report(%L, %L) $$, :'world', gen_random_uuid()), 'season_not_found');
reset role;
set role anon;
select tests.expect_error(format($$ select public.finance_season_report(%L) $$, :'world'), 'permission denied');
reset role;
rollback;
