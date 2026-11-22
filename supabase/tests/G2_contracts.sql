-- Vertragsmanagement beim Saisonabschluss (Migration 0038): Barometer-Parität TS = SQL, Verlängerung, Ablehnung,
-- Reduktion nur bei Zustimmung, Auflösung mit genau einer Abfindungsbuchung, keine Doppelabschlüsse,
-- keine Transfers im Saisonabschluss, KI-Verträge nach dem Saisonwechsel. Alles in einer Transaktion (zurückgerollt).
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
select current_season_id as season from public.career_worlds where id = :'world' \gset
select year as year from public.seasons where id = :'season' \gset
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset

begin;
-- Hilfsfunktion: SQL muss einen Fehler auslösen (egal welchen)
create function tests.fails(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end $$;
grant execute on function tests.fails(text) to authenticated;

-- ------------------------------------------------------------------
-- 0) Außerhalb des Saisonabschlusses: keine Vertragsverhandlungen
-- ------------------------------------------------------------------
select tests.assert(not public.fd_season_end_phase(:'world'), 'laufende Saison ist nicht Saisonabschluss');
select p.id as pre_player from public.players p where p.club_id = :'host_club' order by p.id limit 1 \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.contract_negotiate(%L, 500000, 2) $$, :'pre_player'), 'not_season_end');
select tests.assert((public.contract_overview(:'world') -> 'phase' ->> 'active')::boolean = false, 'Übersicht außerhalb des Abschlusses: Phase inaktiv');
select tests.assert(not (public.contract_overview(:'world') -> 'phase' ->> 'can_edit')::boolean, 'Übersicht außerhalb des Abschlusses: nicht editierbar');
reset role;

-- ------------------------------------------------------------------
-- 1) Parität TS = SQL (feste Fälle aus packages/shared/test/contracts.test.ts)
-- ------------------------------------------------------------------
create function tests.cp(p_s0 float8, p_s1 float8, p_mkt float8, p_ovr int, p_dovr int, p_rating float8, p_share float8, p_age int, p_years int,
                         p_tier int, p_place int, p_teams int, p_rep float8) returns float8 language sql as
$$ select public.fd_contract_prob(p_s0, p_s1, p_mkt, p_ovr, p_dovr, p_rating, p_share, p_age, p_years, p_tier, p_place, p_teams, p_rep) $$;
select tests.assert(abs(tests.cp(400000, 400000, 400000, 68, 0, 6.4, 0.1, 27, 2, 2, 9, 18, 50) - 0.75337) < 5e-6, 'Parität bench_same');
select tests.assert(abs(tests.cp(900000, 900000, 1200000, 78, 2, 7.3, 0.93, 26, 3, 2, 5, 18, 50) - 0.330641) < 5e-6, 'Parität star_same');
select tests.assert(abs(tests.cp(900000, 1215000, 1200000, 78, 2, 7.3, 0.93, 26, 3, 2, 5, 18, 50) - 0.908525) < 5e-6, 'Parität star_raise');
select tests.assert(abs(tests.cp(800000, 800000, 700000, 72, -2, 6.3, 0.5, 34, 1, 2, 9, 18, 50) - 0.98342) < 5e-6, 'Parität old_same');
select tests.assert(abs(tests.cp(800000, 640000, 700000, 72, -2, 6.3, 0.5, 34, 1, 2, 9, 18, 50) - 0.820047) < 5e-6, 'Parität old_cut20');
select tests.assert(abs(tests.cp(800000, 480000, 700000, 72, -2, 6.3, 0.5, 34, 1, 2, 9, 18, 50) - 0.142867) < 5e-6, 'Parität old_cut40');
select tests.assert(abs(tests.cp(150000, 150000, 200000, 64, 3, null, 0.05, 20, 4, 1, 2, 18, 80) - 0.32107) < 5e-6, 'Parität young_bench');
select tests.assert(abs(tests.cp(500000, 550000, 520000, 74, 0, null, null, 30, 3, 2, null, null, 50) - 0.922972) < 5e-6, 'Parität unknown (ohne Statistik)');
select tests.assert(public.fd_contract_termination_fee(1000000, 2) = 1400000 and public.fd_contract_termination_fee(1000000, 0) = 0, 'Abfindung Restgehalt × 0,7');
select tests.assert(public.fd_contract_x(gen_random_uuid(), :'season') between 0 and 1, 'feste Zufallszahl im Bereich 0–1');

-- ------------------------------------------------------------------
-- 2) Saisonabschluss: Welt auf den Termin „Saisonabschluss“ stellen
-- ------------------------------------------------------------------
update public.career_worlds set current_slot = (select ordinal from public.season_slots where season_id = :'season' and kind = 'season_end') where id = :'world';
select tests.assert(public.fd_season_end_phase(:'world'), 'Welt befindet sich im Saisonabschluss');
select tests.assert((public.fd_open_window(:'world')).id is null, 'kein Transferfenster im Saisonabschluss');

-- Transfers sind serverseitig gesperrt
select id as ai_player from public.players where club_id in (select id from public.clubs where world_id = :'world' and control = 'ai' and not amateur and association_code = 'GER') and overall between 66 and 70 order by id limit 1 \gset
select id as ai_club from public.clubs where id = (select club_id from public.players where id = :'ai_player') \gset
set role authenticated;
select tests.login(:'host');
select tests.assert(tests.fails(format($$ select public.make_transfer_offer(%L, 1000000, 900000, 2) $$, :'ai_player')), 'Transferangebot im Saisonabschluss abgelehnt');
select tests.assert(tests.fails(format($$ select public.sell_to_ai(%L) $$, (select id from public.players where club_id = :'host_club' order by id limit 1))), 'Verkauf im Saisonabschluss abgelehnt');
select tests.assert(tests.fails(format($$ select public.release_player(%L) $$, (select id from public.players where club_id = :'host_club' order by id limit 1))), 'Freistellung im Saisonabschluss abgelehnt');
reset role;
select tests.expect_error(format($$ select public.fd_complete_transfer(%L, %L, %L, 0, 500000, 2, null, 'transfer', null) $$, :'ai_player', :'ai_club', :'host_club'), 'season_end_phase');

-- ------------------------------------------------------------------
-- 3) Testspieler vorbereiten (feste Szenarien; Spieler mit der kleinsten festen Zufallszahl x)
-- ------------------------------------------------------------------
select p.id as pb from public.players p where p.club_id = :'host_club' and p.overall <= 80 order by public.fd_contract_x(p.id, :'season'), p.id limit 1 \gset
select p.id as pc from public.players p where p.club_id = :'host_club' and p.overall <= 80 and p.id <> :'pb' order by public.fd_contract_x(p.id, :'season'), p.id limit 1 \gset
select p.id as pa from public.players p where p.club_id = :'host_club' and p.overall <= 80 and p.id not in (:'pb', :'pc') order by public.fd_contract_x(p.id, :'season'), p.id limit 1 \gset
select p.id as pd from public.players p where p.club_id = :'host_club' and p.overall <= 80 and p.id not in (:'pb', :'pc', :'pa') order by p.id limit 1 \gset
select p.id as pe from public.players p where p.club_id = :'host_club' and p.overall <= 80 and p.id not in (:'pb', :'pc', :'pa', :'pd') order by p.id limit 1 \gset
select p.id as pg from public.players p where p.club_id = :'host_club' and p.overall <= 80 and p.id not in (:'pb', :'pc', :'pa', :'pd', :'pe') order by p.id limit 1 \gset
select p.id as pelite from public.players p where p.club_id = :'host_club' and p.id not in (:'pb', :'pc', :'pa', :'pd', :'pe', :'pg') order by p.id limit 1 \gset
select tests.assert(public.fd_contract_x(:'pb', :'season') < 0.5 and public.fd_contract_x(:'pc', :'season') < 0.5 and public.fd_contract_x(:'pa', :'season') < 0.5,
  'Testspieler mit kleiner fester Zufallszahl vorhanden');
select count(*) as squad_n from public.players where club_id = :'host_club' and not retired \gset
select tests.assert(:squad_n >= 20, 'Kader mit mindestens 20 Spielern (' || :squad_n || ')');

-- Statistiken der Saison: fixe Szenarien (Einsätze, Minuten, Bewertung)
select count(*) as games from public.fixtures f join public.competitions co on co.id = f.competition_id
  where f.season_id = :'season' and f.status = 'released' and co.kind::text <> 'friendly' and :'host_club' in (f.home_club_id, f.away_club_id) \gset
select tests.assert(:games >= 20, 'Verein hat freigegebene Pflichtspiele (' || :games || ')');
delete from public.match_player_stats s using public.fixtures f where f.id = s.fixture_id and f.season_id = :'season' and s.player_id in (:'pa', :'pb', :'pc', :'pd', :'pe', :'pg');
-- pb: Leistungsträger (alle Spiele, 7,3); pa: Ersatz (3 Einsätze, 6,4); pc: ältere Stammkraft (jedes zweite Spiel, 6,3)
insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, rating)
select f.id, :'pb', :'host_club', :'world', 90, 7.3 from public.fixtures f join public.competitions co on co.id = f.competition_id
  where f.season_id = :'season' and f.status = 'released' and co.kind::text <> 'friendly' and :'host_club' in (f.home_club_id, f.away_club_id);
insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, rating)
select x.id, :'pa', :'host_club', :'world', 90, 6.4 from (select f.id from public.fixtures f join public.competitions co on co.id = f.competition_id
  where f.season_id = :'season' and f.status = 'released' and co.kind::text <> 'friendly' and :'host_club' in (f.home_club_id, f.away_club_id) order by f.id limit 3) x;
insert into public.match_player_stats(fixture_id, player_id, club_id, world_id, minutes, rating)
select x.id, :'pc', :'host_club', :'world', 90, 6.3 from (select f.id, row_number() over (order by f.id) rn from public.fixtures f join public.competitions co on co.id = f.competition_id
  where f.season_id = :'season' and f.status = 'released' and co.kind::text <> 'friendly' and :'host_club' in (f.home_club_id, f.away_club_id)) x where x.rn % 2 = 0;

-- Stärke und Alter: pa 27 J./OVR 68 unverändert, pb 26 J. 76→78, pc 34 J. 74→72
update public.players set overall = 68, age = 27 where id = :'pa';
update public.players set overall = 78, age = 26 where id = :'pb';
update public.players set overall = 72, age = 34 where id = :'pc';
update public.players set age = 25 where id in (:'pd', :'pe', :'pg');
insert into public.player_season_development(player_id, season_id, world_id, club_id, age, position, ovr_start, attrs_start)
select p.id, :'season', :'world', :'host_club', p.age, p.main_position, v.o, '{}'::jsonb from public.players p
join (values (:'pa'::uuid, 68), (:'pb'::uuid, 76), (:'pc'::uuid, 74)) v(id, o) on v.id = p.id
on conflict (player_id, season_id) do update set ovr_start = excluded.ovr_start;
-- Verträge: pa zu marktüblichem Gehalt (läuft aus), pb/pc zum Gehalt der Vorjahresstärke (laufen aus), pd läuft 2 weitere Jahre,
-- pe/pg laufen aus; der Verein hat einen Spieler über 82 mit auslaufendem Vertrag
select public.fd_salary(68, 27, 2, 50, 3) as s_pa, public.fd_salary(76, 26, 2, 50, 3) as s_pb, public.fd_salary(74, 32, 2, 50, 3) as s_pc \gset
update public.player_contracts set annual_salary = :s_pa, end_season_year = :year where player_id = :'pa' and active;
update public.player_contracts set annual_salary = :s_pb, end_season_year = :year where player_id = :'pb' and active;
update public.player_contracts set annual_salary = :s_pc, end_season_year = :year where player_id = :'pc' and active;
update public.player_contracts set end_season_year = :year + 2 where player_id = :'pd' and active;
update public.player_contracts set end_season_year = :year where player_id in (:'pe', :'pg') and active;
update public.players set overall = 85, age = 28 where id = :'pelite';
update public.player_contracts set end_season_year = :year where player_id = :'pelite' and active;

-- ------------------------------------------------------------------
-- 4) Übersicht (alle Felder aus vorhandenen Tabellen)
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select public.contract_overview(:'world') as ov \gset
select tests.assert((:'ov'::jsonb -> 'phase' ->> 'active')::boolean and (:'ov'::jsonb -> 'phase' ->> 'can_edit')::boolean, 'Übersicht: Phase aktiv und editierbar');
select tests.assert(jsonb_array_length(:'ov'::jsonb -> 'players') = :squad_n, 'Übersicht: ein Eintrag je Spieler');
select tests.assert(not exists (select 1 from jsonb_array_elements(:'ov'::jsonb -> 'players') x
  where x -> 'name' is null or x -> 'position' is null or x -> 'age' is null or x -> 'overall' is null or x -> 'overall_change' is null or x -> 'appearances' is null
     or x -> 'minutes' is null or x -> 'salary' is null or x -> 'contract_years' is null or x -> 'remaining' is null or x -> 'end_year' is null or x -> 'inputs' is null),
  'Übersicht: Name, Position, Alter, OVR, OVR-Veränderung, Einsätze, Minuten, Gehalt, Laufzeit, Restlaufzeit, Vertragsende');
select x as jb from jsonb_array_elements(:'ov'::jsonb -> 'players') x where x ->> 'player_id' = :'pb' \gset
select tests.assert((:'jb'::jsonb ->> 'appearances')::int = :games and (:'jb'::jsonb ->> 'minutes')::int = 90 * :games and (:'jb'::jsonb ->> 'rating')::numeric = 7.3
  and (:'jb'::jsonb ->> 'overall_change')::int = 2 and (:'jb'::jsonb ->> 'remaining')::int = 0 and (:'jb'::jsonb ->> 'expiring')::boolean, 'Leistungsträger: Einsätze, Minuten, Ø-Bewertung, OVR +2, Restlaufzeit 0');
select tests.assert((:'jb'::jsonb ->> 'minutes_share')::numeric = 1, 'Leistungsträger: Minutenanteil 100 %');
select tests.assert((:'jb'::jsonb ->> 'salary')::bigint = :s_pb, 'Gehalt aus dem aktiven Vertrag');
select x as jd from jsonb_array_elements(:'ov'::jsonb -> 'players') x where x ->> 'player_id' = :'pd' \gset
reset role;
select tests.assert((:'jd'::jsonb ->> 'remaining')::int = 2 and not (:'jd'::jsonb ->> 'expiring')::boolean and (:'jd'::jsonb ->> 'termination_fee')::bigint = public.fd_contract_termination_fee((:'jd'::jsonb ->> 'salary')::bigint, 2),
  'laufender Vertrag: Restlaufzeit 2, Abfindung aus Restgehalt');

-- ------------------------------------------------------------------
-- 5) Verhandlung: Beispiele aus der Aufgabe, Zusage/Ablehnung, Reduktion nur mit Zustimmung
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
-- Ersatzspieler ohne Entwicklung: zufrieden mit gleichen Konditionen
select (public.contract_negotiate(:'pa', :s_pa, 2) ->> 'barometer')::int as b_pa \gset
select tests.assert(:b_pa >= 60, 'Ersatzspieler ohne Entwicklung ist mit gleichen Konditionen zufrieden (Barometer ' || :b_pa || ')');
reset role;
select tests.assert((select action from public.contract_plans where player_id = :'pa' and season_id = :'season') = 'renew', 'Zusage ⇒ Plan gespeichert');
set role authenticated;
select tests.login(:'host');
reset role;
-- Das Gehalt ändert sich erst mit der neuen Saison
select tests.assert((select annual_salary from public.player_contracts where player_id = :'pa' and active) = :s_pa, 'Vertrag bleibt bis zum Saisonwechsel unverändert');
set role authenticated;
select tests.login(:'host');
-- Leistungsträger 76→78 erwartet eine Erhöhung
select (public.contract_negotiate(:'pb', :s_pb, 3) ->> 'barometer')::int as b_pb_same \gset
select (public.contract_negotiate(:'pb', (ceil(:s_pb * 1.4 / 5000) * 5000)::bigint, 3) ->> 'barometer')::int as b_pb_raise \gset
select tests.assert(:b_pb_same < 50 and :b_pb_raise > 80, 'Leistungsträger erwartet Erhöhung: gleiches Gehalt ' || :b_pb_same || ', +40 % ' || :b_pb_raise);
reset role;
select tests.assert((select new_salary from public.contract_plans where player_id = :'pb' and season_id = :'season') = ceil(:s_pb * 1.4 / 5000) * 5000, 'Zusage zum erhöhten Gehalt gespeichert');
set role authenticated;
select tests.login(:'host');
-- Ablehnung: Mindestgehalt wird abgelehnt, der bestehende Plan bleibt unangetastet
select public.contract_negotiate(:'pb', (round(:s_pb * 0.4))::bigint, 3) ->> 'accepted' as acc_low \gset
select tests.assert(:'acc_low' = 'false', 'zu niedriges Angebot wird abgelehnt');
reset role;
select tests.assert((select new_salary from public.contract_plans where player_id = :'pb' and season_id = :'season') = ceil(:s_pb * 1.4 / 5000) * 5000, 'Ablehnung ändert den bestehenden Plan nicht');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.contract_negotiate(%L, 10, 3) $$, :'pb'), 'invalid_salary');
select tests.expect_error(format($$ select public.contract_negotiate(%L, 900000, 9) $$, :'pb'), 'invalid');
-- Älterer Spieler mit sinkender Stärke: moderate Reduktion wird akzeptiert, drastische nie
select public.contract_negotiate(:'pc', (round(:s_pc * 0.4))::bigint, 2) ->> 'accepted' as acc_cut40 \gset
select tests.assert(:'acc_cut40' = 'false', 'drastische Gehaltsreduktion wird abgelehnt');
reset role;
select tests.assert(not exists (select 1 from public.contract_plans where player_id = :'pc' and season_id = :'season'), 'abgelehnte Reduktion ⇒ kein Plan');
set role authenticated;
select tests.login(:'host');
select public.contract_negotiate(:'pc', (round(:s_pc * 0.8 / 5000) * 5000)::bigint, 2) as r_cut20 \gset
select tests.assert((:'r_cut20'::jsonb ->> 'barometer')::int >= 70 and (:'r_cut20'::jsonb ->> 'accepted')::boolean, 'älterer Spieler akzeptiert moderate Reduktion (Barometer ' || (:'r_cut20'::jsonb ->> 'barometer') || ')');
-- Idempotenz: dasselbe Angebot ergibt dieselbe Antwort und genau einen Plan
select public.contract_negotiate(:'pc', (round(:s_pc * 0.8 / 5000) * 5000)::bigint, 2) as r_cut20b \gset
select tests.assert(:'r_cut20'::jsonb ->> 'accepted' = :'r_cut20b'::jsonb ->> 'accepted' and :'r_cut20'::jsonb ->> 'barometer' = :'r_cut20b'::jsonb ->> 'barometer', 'gleiches Angebot ⇒ gleiche Entscheidung (deterministisch)');
reset role;
select tests.assert((select count(*) from public.contract_plans where player_id = :'pc' and season_id = :'season') = 1, 'kein Doppelabschluss: genau ein Plan je Spieler und Saison');
set role authenticated;
select tests.login(:'host');
-- Fremder Spieler
select tests.login(:'guest');
select tests.expect_error(format($$ select public.contract_negotiate(%L, 500000, 2) $$, :'pb'), 'forbidden');
select tests.expect_error(format($$ select public.contract_terminate(%L) $$, :'pd'), 'forbidden');
select tests.login(:'host');
-- Barometer wirklich = Wahrscheinlichkeit aus dem Server-Modell; Entscheidung = Barometer gegen feste Zahl x
select public.contract_negotiate(:'pb', (floor(:s_pb * 2.2 / 5000) * 5000)::bigint, 3) ->> 'accepted' as acc3 \gset
reset role;
select tests.assert(:'acc3'::boolean = (select public.fd_contract_x(:'pb', :'season') < public.fd_contract_prob(r.r_salary, (floor(:s_pb * 2.2 / 5000) * 5000), r.r_market, r.r_ovr, r.r_ovr - r.r_ovr_start, r.r_rating::float8, r.r_share, r.r_age, 3, r.r_tier, r.r_place, r.r_teams, r.r_rep::float8)
  from public.fd_contract_rows(:'world', :'season', :'host_club') r where r.r_player = :'pb'), 'Entscheidung folgt der festen Zufallszahl (x < Barometer)');
set role authenticated;
select tests.login(:'host');
reset role;
-- für den Turnover-Test den Plan von pb wieder auf die erhöhte Fassung stellen
set role authenticated;
select tests.login(:'host');
select public.contract_negotiate(:'pb', (ceil(:s_pb * 1.4 / 5000) * 5000)::bigint, 3);
reset role;

-- ------------------------------------------------------------------
-- 6) Nicht verlängern, Spieler über 82, Auflösung gegen Abfindung
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.assert(public.contract_set_leave(:'pe', true) ->> 'status' = 'leaves', 'auslaufender Vertrag: nicht verlängern');
reset role;
select tests.assert((select action from public.contract_plans where player_id = :'pe' and season_id = :'season') = 'leave', 'Plan „geht zum Saisonwechsel“');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.contract_set_leave(%L, true) $$, :'pelite'), 'elite_stays');
select tests.expect_error(format($$ select public.contract_set_leave(%L, true) $$, :'pd'), 'not_expiring');
select tests.expect_error(format($$ select public.contract_terminate(%L) $$, :'pg'), 'expiring');
select tests.expect_error(format($$ select public.contract_terminate(%L) $$, :'pelite'), 'elite_stays');
select public.contract_set_leave(:'pe', false) ->> 'status' as st_clear \gset
reset role;
select tests.assert(:'st_clear' = 'cleared' and not exists (select 1 from public.contract_plans where player_id = :'pe' and season_id = :'season'), 'Entscheidung zurückgenommen');
set role authenticated;
select tests.login(:'host');
select public.contract_set_leave(:'pe', true);
reset role;

select balance as bal_before from public.finances where club_id = :'host_club' \gset
select annual_salary as sal_pd from public.player_contracts where player_id = :'pd' and active \gset
set role authenticated;
select tests.login(:'host');
select public.contract_terminate(:'pd') as term \gset
reset role;
select tests.assert((:'term'::jsonb ->> 'compensation')::bigint = public.fd_contract_termination_fee(:sal_pd, 2), 'Abfindung = Restgehalt × 0,7 (' || (:'term'::jsonb ->> 'compensation') || ')');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'host_club' and kind::text = 'contract_termination' and amount = -public.fd_contract_termination_fee(:sal_pd, 2)) = 1, 'genau eine Abfindungsbuchung');
select tests.assert((select balance from public.finances where club_id = :'host_club') = :bal_before - public.fd_contract_termination_fee(:sal_pd, 2), 'Kontostand um die Abfindung gemindert');
select tests.assert((select club_id from public.players where id = :'pd') is null and exists (select 1 from public.free_agents where player_id = :'pd')
  and not exists (select 1 from public.player_contracts where player_id = :'pd' and active), 'aufgelöster Spieler: vereinslos, ohne aktiven Vertrag, im Free-Agent-Pool');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.contract_terminate(%L) $$, :'pd'), 'forbidden');
reset role;
select tests.assert((select count(*) from public.financial_transactions where club_id = :'host_club' and kind::text = 'contract_termination') = 1, 'zweiter Versuch bucht nicht erneut');

-- ------------------------------------------------------------------
-- 7) Saisonwechsel: Pläne, Fallback, KI-Verträge, Idempotenz
-- ------------------------------------------------------------------
select count(*) as ai_expiring from public.player_contracts pc join public.clubs c on c.id = pc.club_id
  where pc.world_id = :'world' and pc.active and c.control = 'ai' and pc.end_season_year <= :year \gset
select tests.assert(:ai_expiring > 100, 'KI-Vereine haben auslaufende Verträge (' || :ai_expiring || ')');
select count(*) as fa_before from public.free_agents where world_id = :'world' \gset
select public.fd_begin_slot(:'world');
select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason', 'Saisonwechsel durchgeführt');
-- Pläne der Manager
select tests.assert((select annual_salary from public.player_contracts where player_id = :'pb' and active) = ceil(:s_pb * 1.4 / 5000) * 5000
  and (select end_season_year from public.player_contracts where player_id = :'pb' and active) = :year + 3, 'Erhöhung wirkt ab der neuen Saison (neues Gehalt, Vertragsende ' || (:year + 3) || ')');
select tests.assert((select annual_salary from public.player_contracts where player_id = :'pc' and active) = round(:s_pc * 0.8 / 5000) * 5000
  and (select end_season_year from public.player_contracts where player_id = :'pc' and active) = :year + 2, 'zugestimmte Reduktion wirkt ab der neuen Saison');
select tests.assert((select count(*) from public.player_contracts where player_id = :'pb' and active) = 1 and (select count(*) from public.player_contracts where player_id = :'pb' and not active) >= 1, 'genau ein aktiver Vertrag, alter bleibt als Historie');
select tests.assert((select start_season_year from public.player_contracts where player_id = :'pb' and active) = :year + 1, 'neuer Vertrag beginnt mit der neuen Saison');
select tests.assert((select club_id from public.players where id = :'pe') is null and exists (select 1 from public.free_agents where player_id = :'pe'), 'nicht verlängerter Spieler wird Free Agent');
select tests.assert((select annual_salary from public.player_contracts where player_id = :'pg' and active) = (select annual_salary from public.player_contracts where player_id = :'pg' and not active order by created_at desc limit 1)
  and (select end_season_year from public.player_contracts where player_id = :'pg' and active) = :year + 1, 'ohne Entscheidung: ein Jahr zu unveränderten Konditionen (Kaderschutz)');
select tests.assert((select club_id from public.players where id = :'pelite') = :'host_club' and exists (select 1 from public.player_contracts where player_id = :'pelite' and active and end_season_year > :year),
  'Spieler über 82 OVR bleibt (Vertrag verlängert, kein Free Agent)');
select tests.assert(not exists (select 1 from public.free_agents f join public.players p on p.id = f.player_id where f.player_id = :'pelite'), 'Spieler über 82 nicht im Free-Agent-Pool');
select tests.assert((select count(*) from public.contract_plans where season_id = :'season' and applied_at is not null) = 4, 'vier Pläne angewandt (Ersatzspieler, Erhöhung, Reduktion, Abgang)');
-- KI-Vereine: alle Verträge laufen in die neue Saison, kein falsches Gehalt
select tests.assert(not exists (select 1 from public.player_contracts pc join public.players p on p.id = pc.player_id join public.clubs c on c.id = p.club_id
  where pc.world_id = :'world' and pc.active and c.control = 'ai' and pc.end_season_year <= :year), 'KI: kein Vertrag mehr mit Ende in der alten Saison');
select tests.assert(not exists (select 1 from public.player_contracts pc where pc.world_id = :'world' and pc.active and (pc.annual_salary < 30000 or pc.end_season_year < pc.start_season_year or pc.end_season_year > :year + 5)), 'KI: Gehälter und Laufzeiten gültig');
select tests.assert(not exists (select 1 from public.player_contracts where world_id = :'world' and active group by player_id having count(*) > 1), 'nie zwei aktive Verträge');
select tests.assert((select count(*) from public.player_contracts pc join public.clubs c on c.id = pc.club_id where pc.world_id = :'world' and pc.active and c.control = 'ai' and pc.start_season_year = :year + 1) >= :ai_expiring * 0.85,
  'KI hat ihre auslaufenden Verträge (bis auf die neuen Free Agents und bereinigte Kader) verlängert');
select tests.assert((select (result ->> 'ai_renewed')::int from public.fd_fa_market_log where world_id = :'world' and season_id = :'season') > 100, 'Protokoll: KI-Verlängerungen');
-- Idempotenz
select count(*) as ct_before from public.player_contracts where world_id = :'world' \gset
select tests.assert(public.fd_contracts_season_change(:'world', :'season', :year) ->> 'status' = 'already_done', 'zweiter Durchlauf tut nichts');
select tests.assert((select count(*) from public.player_contracts where world_id = :'world') = :ct_before, 'keine doppelten Verträge');
-- Gehälter: Buchung nutzt die aktiven Verträge (neues Gehalt wirkt in der neuen Saison)
select tests.assert((select sum(annual_salary) from public.player_contracts where club_id = :'host_club' and active) > 0, 'Gehaltssumme der neuen Saison aus aktiven Verträgen');
rollback;
\echo 'OK G2_contracts'
