-- Phase 5/6: Testspiele, Match-Setup, Checkpoints und idempotentes Speichern
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
\set stranger '00000000-0000-0000-0000-0000000000c1'

select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset
select id as ai_club from public.clubs where world_id = :'world' and control = 'ai' order by name limit 1 \gset

set role authenticated;
select tests.login(:'stranger');
select tests.expect_error(format($$ select public.create_friendly(%L, %L) $$, :'world', :'ai_club'), 'not_a_member');

select tests.login(:'host');
select tests.expect_error(format($$ select public.create_friendly(%L, %L) $$, :'world', :'host_club'), 'invalid_opponent');
select public.create_friendly(:'world', :'ai_club') as fx \gset
select tests.assert((select status from public.fixtures where id = :'fx') = 'scheduled', 'Testspiel angelegt');
select tests.expect_error(format($$ select public.create_friendly(%L, %L) $$, :'world', :'guest_club'), 'friendly_open');
select tests.assert(jsonb_array_length(public.my_fixtures(:'world')) >= 1, 'my_fixtures listet das Testspiel');

-- Clients dürfen nichts direkt schreiben und keine Admin-Funktionen aufrufen
select tests.expect_error(format($$ select public.admin_match_setup(%L) $$, :'fx'), '');
select tests.expect_error(format($$ select public.admin_finish_match(%L, '{}') $$, :'fx'), '');
select tests.expect_error(format($$ update public.fixtures set status = 'released' where id = %L $$, :'fx'), '');
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 0, 'kein Ergebnis ohne Server');

-- Gast darf das fremde Testspiel nicht absagen
select tests.login(:'guest');
select tests.expect_error(format($$ select public.cancel_friendly(%L) $$, :'fx'), 'forbidden');
reset role;

-- Match-Server
set role service_role;
select tests.assert(public.admin_match_role(:'fx', :'host') = 'home', 'Rolle Heim');
select tests.assert(public.admin_match_role(:'fx', :'guest') = 'spectator', 'Rolle Zuschauer');
select tests.assert(public.admin_match_role(:'fx', :'stranger') is null, 'Fremde haben keine Rolle');
select public.admin_match_setup(:'fx') as setup \gset
select tests.assert((:'setup'::jsonb -> 'home' ->> 'clubId')::uuid = :'host_club', 'Setup: Heimverein');
select tests.assert(jsonb_array_length(:'setup'::jsonb -> 'home' -> 'squad') >= 16, 'Setup: Kader mit Attributen');
select tests.assert(:'setup'::jsonb -> 'home' -> 'profiles' ? 'offensive', 'Setup: Taktikprofile');
select tests.assert((:'setup'::jsonb -> 'home' -> 'settings' ->> 'active_profile') is not null, 'Setup: Vereinseinstellungen');
select tests.assert((select status from public.fixtures where id = :'fx') = 'live', 'Status live');
select public.admin_match_checkpoint(:'fx', 1200, '{"tick":1200,"log":[]}');
select tests.assert((public.admin_match_setup(:'fx') -> 'checkpoint' ->> 'tick')::int = 1200, 'Checkpoint wird bei Wiederaufnahme geliefert');
reset role;

-- Ergebnis speichern
select id as scorer from public.players where club_id = :'host_club' and main_position <> 'GK' order by overall desc limit 1 \gset
select id as alien from public.players where club_id = :'guest_club' limit 1 \gset
set role service_role;
select public.admin_finish_match(:'fx', jsonb_build_object(
  'score', jsonb_build_array(2, 1), 'possessionHome', 55,
  'stats', jsonb_build_object('home', jsonb_build_object('xg', 1.8, 'goals', 2), 'away', jsonb_build_object('xg', 0.9, 'goals', 1)),
  'playerOfTheMatch', :'scorer',
  'events', jsonb_build_array(
     jsonb_build_object('tick', 1000, 'minute', 13, 'type', 'goal', 'side', 'home', 'playerId', :'scorer', 'text', 'Tor'),
     jsonb_build_object('tick', 1100, 'minute', 14, 'type', 'goal', 'side', 'home', 'playerId', :'alien', 'text', 'fremder Spieler'),
     jsonb_build_object('tick', 1200, 'minute', 15, 'type', 'foul', 'side', 'away', 'text', 'wird nicht gespeichert')),
  'players', jsonb_build_array(
     jsonb_build_object('playerId', :'scorer', 'side', 'home', 'minutes', 90, 'goals', 2, 'assists', 0, 'shots', 4, 'shotsOnTarget', 3, 'xg', 1.2,
        'passes', 30, 'passesCompleted', 25, 'tacklesWon', 1, 'interceptions', 0, 'saves', 0, 'rating', 8.4, 'fitnessStart', 100, 'fitnessEnd', 50),
     jsonb_build_object('playerId', :'alien', 'side', 'home', 'minutes', 90, 'goals', 0, 'assists', 0, 'shots', 0, 'shotsOnTarget', 0, 'xg', 0,
        'passes', 0, 'passesCompleted', 0, 'tacklesWon', 0, 'interceptions', 0, 'saves', 0, 'rating', 6, 'fitnessStart', 100, 'fitnessEnd', 50))
)) as r1 \gset
select tests.assert(:'r1'::jsonb ->> 'status' = 'saved', 'Ergebnis gespeichert');
select tests.assert((public.admin_finish_match(:'fx', '{"score":[9,9]}') ->> 'status') = 'already_saved', 'Zweiter Aufruf ist idempotent');
reset role;
select tests.assert((select home_goals from public.fixture_results where fixture_id = :'fx') = 2, 'Ergebnis unverändert nach zweitem Aufruf');
select tests.assert((select status from public.fixtures where id = :'fx') = 'released', 'Testspiel sofort freigegeben');
select tests.assert((select count(*) from public.match_player_stats where fixture_id = :'fx') = 1, 'Fremde Spieler werden nicht gespeichert');
select tests.assert((select count(*) from public.match_events where fixture_id = :'fx') = 2, 'Nur relevante Ereignisse gespeichert');
select tests.assert((select count(*) from public.match_events where fixture_id = :'fx' and player_id is null) = 1, 'Fremder Spieler im Ereignis wird entfernt');
select tests.assert((select fitness from public.players where id = :'scorer') > 50, 'Testspiel ändert keine Fitness');
select tests.assert((select status from public.match_sessions where fixture_id = :'fx') = 'finished', 'Session beendet');

-- Für alle Mitglieder sichtbar, für Fremde nicht
set role authenticated;
select tests.login(:'guest');
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 1, 'Gast sieht freigegebenes Testspiel');
select tests.login(:'stranger');
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 0, 'Fremder sieht nichts');
-- Neues Testspiel nach Abschluss möglich, Absagen vor Spielbeginn
select tests.login(:'host');
select public.create_friendly(:'world', :'guest_club') as fx2 \gset
select public.cancel_friendly(:'fx2');
select tests.assert((select status from public.fixtures where id = :'fx2') = 'cancelled', 'Testspiel abgesagt');
reset role;
\echo 'OK 40_matches'
