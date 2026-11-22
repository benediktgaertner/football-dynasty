-- 0041: KI-Stadionatmosphäre – nur der Host schreibt (Datenbank und Storage), Mitglieder lesen, Fremde nichts
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
\set outsider '00000000-0000-0000-0000-0000000000f6'
begin;
insert into auth.users(id) values (:'outsider') on conflict do nothing;
select tests.assert((select host_user_id from public.career_worlds where id = :'world') = :'host'::uuid, 'Testwelt: a1 ist Host');
select tests.assert(public.is_world_member(:'world') is not null, 'Hilfsfunktion vorhanden');
\set p1 :world/chant/11111111-1111-4111-8111-111111111111.mp3
\set p2 :world/boo/22222222-2222-4222-8222-222222222222.mp3
\set pbad :world/other/33333333-3333-4333-8333-333333333333.mp3

-- Host: Liste, Upload in den Storage, Eintrag
set role authenticated;
select tests.login(:'host');
select tests.assert((public.world_ai_audio_settings(:'world') ->> 'is_host')::boolean, 'Host wird anhand der gespeicherten Eigentümerschaft erkannt');
insert into storage.objects(bucket_id, name) values ('world-audio', :'p1'), ('world-audio', :'p2');
select tests.expect_error(format($$ insert into storage.objects(bucket_id, name) values ('world-audio', %L) $$, :'pbad'), 'row-level security');
select tests.assert((public.add_world_ai_audio(:'world', 'chant', 'Kurve laut.mp3', :'p1', 18.4, 300000) ->> 'name') = 'Kurve laut.mp3', 'Host trägt Fangesang ein');
select tests.assert((public.add_world_ai_audio(:'world', 'boo', 'Pfiffe', :'p2', 7.5) ->> 'category') = 'boo', 'Host trägt Pfiffe ein');
select tests.expect_error(format($$ select public.add_world_ai_audio(%L, 'goal', 'x', %L, 5) $$, :'world', :'world' || '/goal/44444444-4444-4444-8444-444444444444.mp3'), 'file_missing');
select tests.expect_error(format($$ select public.add_world_ai_audio(%L, 'goal', 'x', %L, 5) $$, :'world', :'p1'), 'invalid_path');
select tests.expect_error(format($$ select public.add_world_ai_audio(%L, 'fun', 'x', %L, 5) $$, :'world', :'p1'), 'invalid_category');
select tests.expect_error(format($$ select public.add_world_ai_audio(%L, 'chant', 'x', %L, 0) $$, :'world', :'p1'), 'invalid_duration');
reset role;

-- Mitglied (kein Host): sieht dieselbe Liste, darf nichts ändern – weder per RPC noch direkt im Storage/der Tabelle
set role authenticated;
select tests.login(:'guest');
select tests.assert(not (public.world_ai_audio_settings(:'world') ->> 'is_host')::boolean, 'Mitglied ist kein Host');
select tests.assert(jsonb_array_length(public.world_ai_audio_settings(:'world') -> 'files') = 2, 'Mitglied sieht die ligaweiten KI-Dateien');
select tests.assert((select count(*) from storage.objects where bucket_id = 'world-audio' and name = :'p1') = 1, 'Mitglied darf die Datei lesen (signierte Abspiel-URL)');
select tests.expect_error(format($$ insert into storage.objects(bucket_id, name) values ('world-audio', %L) $$, :'world' || '/goal/55555555-5555-4555-8555-555555555555.mp3'), 'row-level security');
select tests.expect_error(format($$ select public.add_world_ai_audio(%L, 'chant', 'x', %L, 5) $$, :'world', :'p1'), 'not_host');
select tests.expect_error(format($$ select public.delete_world_ai_audio(%L) $$, (select id from public.world_ai_audio where storage_path = :'p1')), 'not_host');
select tests.expect_error($$ insert into public.world_ai_audio(world_id, category, name, storage_path, duration, created_by) values (gen_random_uuid(), 'chant', 'x', 'y', 1, gen_random_uuid()) $$, 'permission denied');
delete from storage.objects where bucket_id = 'world-audio' and name = :'p1'; -- RLS: wirkt nicht
select tests.assert((select count(*) from storage.objects where bucket_id = 'world-audio' and name = :'p1') = 1, 'Mitglied kann Dateien im Storage nicht löschen');
reset role;

-- Fremder: weder Liste noch Datei
set role authenticated;
select tests.login(:'outsider');
select tests.expect_error(format($$ select public.world_ai_audio_settings(%L) $$, :'world'), 'forbidden');
select tests.assert((select count(*) from storage.objects where bucket_id = 'world-audio') = 0, 'Fremder sieht keine Dateien der Liga');
select tests.assert((select count(*) from public.world_ai_audio) = 0, 'Fremder sieht keine Einträge');
reset role;

-- Host löscht: Eintrag weg, Pfad zurück, Objekt im Storage löschbar
set role authenticated;
select tests.login(:'host');
select tests.assert(public.delete_world_ai_audio((select id from public.world_ai_audio where storage_path = :'p1')) = :'p1', 'Host löscht Eintrag, Pfad zurückgegeben');
delete from storage.objects where bucket_id = 'world-audio' and name = :'p1';
select tests.assert((select count(*) from storage.objects where bucket_id = 'world-audio' and name = :'p1') = 0, 'Host löscht die Datei im Storage');
select tests.assert(jsonb_array_length(public.world_ai_audio_settings(:'world') -> 'files') = 1, 'Liste nach dem Löschen aktuell');
reset role;
select tests.assert((select not public from storage.buckets where id = 'world-audio'), 'Bucket world-audio ist privat (keine öffentlichen Rechte)');
rollback;
