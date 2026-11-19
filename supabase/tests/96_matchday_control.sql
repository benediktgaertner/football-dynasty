-- Spieltagssteuerung: Sperre gegen doppelte Simulation, automatische Neuversuche, Ersatzergebnis
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
-- Termin starten, falls noch nicht geschehen
select public.fd_begin_slot(:'world') where (public.fd_current_slot(:'world')).state = 'pending';
select tests.assert((public.fd_current_slot(:'world')).state = 'live', 'Spieltag läuft');
select tests.assert(:'world' in (select public.admin_due_worlds()::text), 'Server findet die Welt mit laufendem Spieltag ohne Client');
select f.id as fx from public.fixtures f
where f.id in (select public.fd_slot_fixture_ids(:'world')) and f.status = 'scheduled'
  and not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human')
order by f.id limit 1 \gset
select tests.assert(:'fx' in (select public.admin_pending_fixtures(:'world')::text), 'KI-Partie steht sofort zur Berechnung an');

set role service_role;
select tests.assert((public.admin_claim_fixture(:'fx', 'A') ->> 'ok')::boolean, 'Instanz A übernimmt die Partie');
select tests.assert(not (public.admin_claim_fixture(:'fx', 'B') ->> 'ok')::boolean, 'Instanz B darf dieselbe Partie nicht parallel simulieren');
select public.admin_fixture_failed(:'fx', 'Testfehler');
select tests.assert(:'fx' in (select public.admin_pending_fixtures(:'world')::text), 'fehlgeschlagene Partie wird sofort erneut angeboten');
select tests.assert((public.admin_claim_fixture(:'fx', 'B') ->> 'attempts')::int = 2, 'Neuversuch zählt Versuche');
-- Abgebrochene Berechnung (Instanz stürzt ab): nach Ablauf der Sperre wieder verfügbar
reset role;
update public.fixture_jobs set claimed_at = now() - interval '5 minutes' where fixture_id = :'fx';
set role service_role;
select tests.assert(:'fx' in (select public.admin_pending_fixtures(:'world')::text), 'abgebrochene Berechnung wird nach Ablauf der Sperre erneut verarbeitet');
select tests.assert((public.admin_claim_fixture(:'fx', 'C') ->> 'ok')::boolean, 'abgelaufene Sperre kann übernommen werden');
-- Ersatzergebnis
select public.admin_fallback_result(:'fx') ->> 'status' as fb \gset
select tests.assert(:'fb' = 'saved', 'Ersatzergebnis gespeichert');
reset role;
select home_goals as hg, away_goals as ag from public.fixture_results where fixture_id = :'fx' \gset
set role service_role;
select tests.assert(public.admin_fallback_result(:'fx') ->> 'status' = 'already_saved', 'Ersatzergebnis nie doppelt');
select tests.assert(public.admin_finish_match(:'fx', '{"score":[9,9],"events":[],"players":[],"stats":{}}'::jsonb) ->> 'status' = 'already_saved', 'gespeichertes Ergebnis wird nie überschrieben');
select tests.assert(not (public.admin_claim_fixture(:'fx', 'D') ->> 'ok')::boolean, 'beendete Partie wird nie erneut simuliert');
reset role;
select tests.assert((select home_goals = :hg and away_goals = :ag from public.fixture_results where fixture_id = :'fx'), 'Ergebnis unverändert');
select tests.assert((select state from public.fixture_jobs where fixture_id = :'fx') = 'fallback', 'Status „fallback“ dokumentiert');
select tests.assert((select status::text from public.fixtures where id = :'fx') = 'finished', 'Ergebnis bis zur Freigabe verborgen (finished, nicht released)');
select tests.assert(:'fx' not in (select public.admin_pending_fixtures(:'world')::text), 'nicht mehr offen');
-- Statusanzeige für Mitglieder, nicht für Fremde
select p.id as outsider from public.profiles p where not exists (select 1 from public.world_members m where m.world_id = :'world' and m.user_id = p.id) limit 1 \gset
set role authenticated;
select tests.login(:'host');
select tests.assert(public.matchday_processing(:'world') ->> :'fx' = 'fallback', 'Verarbeitungsstand für Manager sichtbar');
select tests.login(:'outsider');
select tests.expect_error(format($$ select public.matchday_processing(%L) $$, :'world'), 'not_a_member');
reset role;
\echo '>>> 96_matchday_control: Sperre, Neuversuch und Ersatzergebnis funktionieren'
