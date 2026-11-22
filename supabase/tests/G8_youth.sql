-- G8: Jugendabteilung und Karriereende (Migration 0043, Audit-Regressionstest). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
begin;
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select c.id as hclub from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' \gset
select c.id as aiclub from public.clubs c where c.world_id = :'world' and c.control = 'ai' and not c.amateur and c.association_code = (select country_code from public.career_worlds where id = :'world') order by c.id limit 1 \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset

-- Karriereende: 38-Jähriger eines KI-Vereins (ältester) endet sicher, 20-Jähriger nie
update public.players set age = 39 where id = (select id from public.players where club_id = :'aiclub' and main_position <> 'GK' order by id limit 1);
select id as oldp from public.players where club_id = :'aiclub' and age = 39 limit 1 \gset
select count(*) as n_ai_before from public.players where club_id = :'aiclub' and not retired \gset
select public.fd_youth_season_change(:'world', :'season') as res \gset
select tests.assert((select retired from public.players where id = :'oldp'), 'Karriereende: 39-Jähriger tritt zurück');
select tests.assert((select club_id is null from public.players where id = :'oldp') and not exists (select 1 from public.player_contracts where player_id = :'oldp' and active), 'Rentner: kein Verein, kein aktiver Vertrag');
select tests.assert(exists (select 1 from public.transfers where player_id = :'oldp' and kind = 'retirement'), 'Karriereende wird protokolliert');
select tests.assert(not exists (select 1 from public.players p join public.clubs c on c.id = p.club_id where p.world_id = :'world' and not c.amateur and p.age <= 30 and p.retired), 'keine jungen Rentner');
select tests.assert((select count(*) from public.players where club_id = :'aiclub' and not retired and not temporary) >= 16, 'KI-Kader bleibt ≥ 16');
-- Jahrgang
select tests.assert((select count(*) from public.youth_players where club_id = :'aiclub') >= 2, 'KI-Verein hat Jugendspieler');
select tests.assert(not exists (select 1 from public.youth_players where age not between 16 and 20 or overall > potential), 'Jugend: Alter 16–20, OVR ≤ Potenzial');
select tests.assert(not exists (select 1 from public.youth_players y join public.player_attributes pa on pa.player_id = y.id), 'Jugendspieler sind keine Kaderspieler');
select tests.assert(not exists (select 1 from public.youth_players y where not public.valid_attributes(y.kind, y.attributes)), 'Jugend: gültige Attribute');
-- Zweiter Lauf im selben Jahr entwickelt/übernimmt weiter (Alterung der Jugend), ohne Fehler
select public.fd_youth_season_change(:'world', :'season') as res2 \gset
select tests.assert(exists (select 1 from public.players p join public.player_contracts k on k.player_id = p.id and k.active where p.club_id = :'aiclub' and p.age <= 18), 'Jugend wurde in den Profikader übernommen (Vertrag aktiv)');
select tests.assert(not exists (select 1 from public.players p join public.clubs c on c.id = p.club_id where p.world_id = :'world' and not c.amateur and not p.temporary and not p.retired
  and not exists (select 1 from public.player_contracts k where k.player_id = p.id and k.active) and p.age <= 19), 'übernommene Spieler haben Verträge');

-- Menschlicher Verein: Ausbau nur in der Vorbereitung, Kosten, Rechte
set role authenticated;
select tests.login(:'host');
select public.youth_overview(:'world') as ov \gset
select tests.assert((:'ov'::jsonb ->> 'level')::int = 1, 'Standardstufe 1');
select tests.expect_error(format($$ select public.youth_upgrade(%L) $$, :'world'), 'not_preseason');
reset role;
update public.career_worlds set status = 'preseason' where id = :'world';
update public.finances set balance = 100000000 where club_id = :'hclub';
select balance as bal0 from public.finances where club_id = :'hclub' \gset
set role authenticated;
select tests.login(:'host');
select public.youth_upgrade(:'world');
reset role;
select tests.assert((select balance from public.finances where club_id = :'hclub') = :bal0 - 6000000, 'Ausbau kostet 6 Mio');
select tests.assert((select level from public.youth_academies where club_id = :'hclub') = 2, 'Stufe 2');
select tests.assert(exists (select 1 from public.financial_transactions where club_id = :'hclub' and kind = 'youth_academy' and amount = -6000000), 'Buchung youth_academy');
update public.finances set balance = 1000 where club_id = :'hclub';
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.youth_upgrade(%L) $$, :'world'), 'insufficient_funds');
reset role;
update public.finances set balance = 200000000 where club_id = :'hclub';
-- Jugendspieler übernehmen/entlassen, fremde nicht
select public.fd_youth_season_change(:'world', :'season');
select id as yid from public.youth_players where club_id = :'hclub' order by id limit 1 \gset
select id as yforeign from public.youth_players where club_id = :'aiclub' order by id limit 1 \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.youth_promote(%L) $$, :'yforeign'), 'forbidden');
select tests.expect_error(format($$ select public.youth_release(%L) $$, :'yforeign'), 'forbidden');
select (public.youth_overview(:'world') -> 'players') as pl \gset
select tests.assert(not (:'pl'::jsonb::text like '%potential%'), 'Potenzial wird nicht ausgeliefert');
select tests.expect_error($$ select * from public.youth_players $$, 'permission');
reset role;
rollback;
\echo 'OK G8'
