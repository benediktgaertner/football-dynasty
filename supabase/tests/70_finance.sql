-- Finanzen: Gehaltsformel, exakte Gehaltsverteilung, Ticketbuchungen, Kontoabgleich, Preissperre
\set ON_ERROR_STOP on
\set QUIET on

\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset

-- Formel identisch zu TypeScript contractSalary (packages/shared/test/rules.test.ts)
select tests.assert(public.fd_salary(70, 25, 2, 50, 3) = 330000, 'Formel: Stärke 70, 2. Liga = 330.000 €');
select tests.assert(public.fd_salary(76, 26, 2, 50, 3) = 805000, 'Formel: Stärke 76 = 805.000 €');
select tests.assert(public.fd_salary(75, 26, 1, 50, 3) > public.fd_salary(75, 26, 3, 50, 3), 'Spielklasse wirkt');
select tests.assert(public.fd_salary(75, 34, 2, 50, 3) > public.fd_salary(75, 22, 2, 50, 3), 'Alter wirkt');
select tests.assert(public.fd_salary(40, 18, 4, 0, 1) = 30000, 'Mindestgehalt');

-- Saison 1 lief komplett: Gehälter wurden genau einmal je Ligatermin gebucht, in Summe = Jahresgehalt (nicht 112 %)
select s.id as s1 from public.seasons s where s.world_id = :'world' order by s.year limit 1 \gset
select tests.assert(not exists (
  select 1 from public.financial_transactions where world_id = :'world' and kind = 'salary' group by idempotency_key having count(*) > 1), 'keine doppelte Gehaltsbuchung');
select tests.assert((select count(distinct t.idempotency_key) from public.financial_transactions t where t.club_id = :'host_club' and t.kind = 'salary' and t.season_id = :'s1')
  = (select count(*) from public.season_slots where season_id = :'s1' and kind = 'league'), 'je Ligatermin genau eine Gehaltsbuchung');
-- KI-Verein ohne Kaderänderung in Saison 1: Summe der Gehaltsbuchungen = Jahresgehälter
select c.id as stable_club from public.clubs c where c.world_id = :'world' and c.control = 'ai' and c.association_code = 'GER' and not c.amateur
  and not exists (select 1 from public.transfers t where (t.to_club_id = c.id or t.from_club_id = c.id) and t.season_id = :'s1')
  and not exists (select 1 from public.player_contracts pc where pc.club_id = c.id and pc.start_season_year > (select year from public.seasons where id = :'s1'))
  order by c.name limit 1 \gset
select tests.assert(-(select sum(amount) from public.financial_transactions where club_id = :'stable_club' and kind = 'salary' and season_id = :'s1')
  = (select sum(pc.annual_salary) from public.player_contracts pc where pc.club_id = :'stable_club' and pc.active), 'Gehaltsbuchungen der Saison = Jahresgehalt (exakt)');

-- Ticketbuchungen mit Zuschauerzahl, nur Heimspiele, positiv
select tests.assert(exists (select 1 from public.financial_transactions where world_id = :'world' and kind = 'ticket_income'
  and description ~ '^Ticketverkauf – [0-9.]+ Zuschauer · ' and amount > 0), 'Buchungstext „Ticketverkauf – N Zuschauer“');
select tests.assert(not exists (select 1 from public.financial_transactions t join public.fixtures f on t.idempotency_key = 'fx:' || f.id || ':tickets'
  where t.club_id <> f.home_club_id), 'Tickets nur für den Heimverein');
select tests.assert(not exists (select 1 from public.financial_transactions t join public.fixtures f on t.idempotency_key = 'fx:' || f.id || ':tickets'
  join public.fixture_results r on r.fixture_id = f.id join public.stadiums s on s.club_id = f.home_club_id where r.attendance > s.capacity), 'nie mehr Zuschauer als Plätze');

-- Kontostand = Summe aller Buchungen, für jeden Verein der Welt
select tests.assert(not exists (select 1 from public.finances fi where fi.world_id = :'world'
  and fi.balance <> coalesce((select sum(amount) from public.financial_transactions t where t.club_id = fi.club_id), 0)), 'Kontostand = Summe der Buchungen (alle Vereine)' || coalesce(' – Abweichung: ' || (
  select string_agg(c.name || ' (' || c.control || case when c.amateur then ', Amateur' else '' end || '): Konto ' || fi.balance || ' / Buchungen ' || coalesce((select sum(amount) from public.financial_transactions t where t.club_id = fi.club_id), 0), '; ')
  from public.finances fi join public.clubs c on c.id = fi.club_id where fi.world_id = :'world'
  and fi.balance <> coalesce((select sum(amount) from public.financial_transactions t where t.club_id = fi.club_id), 0)), ''));

-- Neuberechnung bestehender Gehälter: aufgeblähte Altverträge werden nach Formel korrigiert, Konto unverändert
select balance as bal_before from public.finances where club_id = :'host_club' \gset
update public.player_contracts set annual_salary = annual_salary * 3 where club_id = :'host_club' and active;
select public.fd_rescale_salaries(:'world') as rescale \gset
select tests.assert(not exists (select 1 from public.player_contracts pc join public.players p on p.id = pc.player_id join public.clubs c on c.id = pc.club_id
  join public.career_worlds w on w.id = pc.world_id where pc.world_id = :'world' and pc.active
  and pc.annual_salary <> public.fd_salary(p.overall, p.age, public.fd_tier_of(c.id, w.current_season_id), c.reputation, greatest(1, pc.end_season_year - pc.start_season_year + 1))),
  'alle Verträge entsprechen der Formel');
select tests.assert((select balance from public.finances where club_id = :'host_club') = :bal_before, 'Kontostand bleibt bei der Neuberechnung unverändert');
select tests.assert((select sum(pc.annual_salary) from public.player_contracts pc join public.clubs c on c.id = pc.club_id
  where c.world_id = :'world' and c.control = 'ai' and public.fd_tier_of(c.id, (select current_season_id from public.career_worlds where id = :'world')) = 2 and pc.active)
  / nullif((select count(*) from public.clubs c where c.world_id = :'world' and c.control = 'ai' and public.fd_tier_of(c.id, (select current_season_id from public.career_worlds where id = :'world')) = 2), 0)
  between 4000000 and 14000000, 'Ø Zweitligakader kostet einstelligen Millionenbetrag: ' ||
  (select round(sum(pc.annual_salary) / 1e6 / count(distinct c.id), 2) from public.player_contracts pc join public.clubs c on c.id = pc.club_id
   where c.world_id = :'world' and c.control = 'ai' and public.fd_tier_of(c.id, (select current_season_id from public.career_worlds where id = :'world')) = 2 and pc.active) || ' Mio.');

-- Übersicht für den Manager
set role authenticated;
select tests.login(:'host');
select public.finance_overview(:'world') as fo \gset
reset role;
select tests.assert((:'fo'::jsonb ->> 'ledger_ok')::boolean, 'Übersicht: Kontoabgleich ok');
select tests.assert((:'fo'::jsonb -> 'tickets') is not null and (:'fo'::jsonb ->> 'league_slots')::int >= 34, 'Übersicht: Ticketbilanz und Ligatermine');
