-- 0031: MP3-Upload-Rechte, freie Ultragruppen, Fahnen, drei Trikots, Spielvorbereitung
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset

-- ------------------------------------------------------------------
-- Speicherrechte (Ursache des RLS-Fehlers: Pfadprüfung)
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.assert(public.fd_can_manage_audio(:'world' || '/' || :'host_club' || '/hymne.mp3'), 'Manager darf in den Ordner seines Vereins hochladen');
select tests.assert(not public.fd_can_manage_audio(:'world' || '/' || :'guest_club' || '/hymne.mp3'), 'fremder Verein: kein Upload');
select tests.assert(not public.fd_can_manage_audio(:'world' || '/' || :'host_club' || '/hymne.exe'), 'nur MP3');
select tests.assert(not public.fd_can_manage_audio(:'host_club' || '/hymne.mp3'), 'falscher Pfadaufbau');
-- Upload wie supabase-js (INSERT in storage.objects unter RLS): eigener Ordner erlaubt, fremder gesperrt
insert into storage.objects(bucket_id, name) values ('club-audio', :'world' || '/' || :'host_club' || '/upload-test.mp3');
select tests.expect_error(format($$ insert into storage.objects(bucket_id, name) values ('club-audio', %L) $$, :'world' || '/' || :'guest_club' || '/fremd.mp3'), 'row-level security');
select tests.expect_error($$ insert into storage.objects(bucket_id, name) values ('club-audio', 'irgendwo/datei.mp3') $$, 'row-level security');
-- Datei vorhanden ⇒ Eintrag wird gespeichert; Datei fehlt ⇒ klare Meldung
select public.save_club_audio(:'world', null, jsonb_build_object('kind', 'anthem', 'name', 'Upload-Test', 'storage_path', :'world' || '/' || :'host_club' || '/upload-test.mp3')) as up_anthem \gset
select tests.assert(exists (select 1 from public.club_audio where id = :'up_anthem' and source = 'upload'), 'Upload ⇒ Datenbankeintrag verknüpft');
select tests.expect_error(format($$ select public.save_club_audio(%L, null, jsonb_build_object('kind', 'anthem', 'name', 'Fehlt', 'storage_path', %L)) $$,
  :'world', :'world' || '/' || :'host_club' || '/gibt-es-nicht.mp3'), 'file_missing');
select tests.login(:'guest');
delete from storage.objects where name = :'world' || '/' || :'host_club' || '/upload-test.mp3';
reset role;
select tests.assert(exists (select 1 from storage.objects where name = :'world' || '/' || :'host_club' || '/upload-test.mp3'), 'fremder Verein kann die Datei nicht löschen');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.save_club_audio(%L, null, jsonb_build_object('kind', 'anthem', 'name', 'Fremd', 'storage_path', %L)) $$,
  :'world', :'world' || '/' || :'guest_club' || '/x.mp3'), 'invalid_file');
select tests.expect_error(format($$ select public.save_club_audio(%L, null, '{"kind":"anthem","name":"Ohne Datei"}') $$, :'world'), 'invalid_file');
insert into storage.objects(bucket_id, name) values ('club-audio', :'world' || '/' || :'host_club' || '/zwei.mp3');
select public.save_club_audio(:'world', null, jsonb_build_object('kind', 'chant', 'name', 'Zweiter Gesang', 'storage_path', :'world' || '/' || :'host_club' || '/zwei.mp3')) as chant2 \gset
select tests.assert((select count(*) from public.club_audio where club_id = :'host_club' and kind = 'chant') >= 2, 'mehrere Fangesänge je Verein');
select tests.assert((select count(*) from public.club_audio where club_id = :'host_club' and kind = 'chant' and is_signature) = 1, 'genau ein Signatur-Fangesang');
-- direkte Tabellenänderungen sind gesperrt (nur über geprüfte Funktionen)
select tests.expect_error($$ insert into public.club_audio(club_id, world_id, kind, name, source) select id, world_id, 'anthem', 'X', 'upload' from public.clubs limit 1 $$, 'permission denied');
select tests.login(:'guest');
select tests.expect_error(format($$ select public.save_club_audio(%L, %L, '{"kind":"chant","name":"Übernommen"}') $$, :'world', :'chant2'), 'not_found');
select public.delete_club_audio(:'world', :'chant2'::uuid);
reset role;
select tests.assert(exists (select 1 from public.club_audio where id = :'chant2'), 'fremder Verein kann nicht löschen');

-- ------------------------------------------------------------------
-- Ultragruppen frei platziert, nie im Gästeblock, nicht überlappend; Fahnen mit Anzahl/Verteilung
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[]', '[{"id":"u-gast","name":"Gästeblock","colors":["#ff0000"],"area":{"x":110,"y":5,"w":8,"h":10}}]', null, true) $$, :'world'), 'invalid_ultras');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[]', '[{"id":"u-feld","name":"Spielfeld","colors":["#ff0000"],"area":{"x":40,"y":20,"w":8,"h":10}}]', null, true) $$, :'world'), 'invalid_ultras');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[]', '[{"id":"u-a1","name":"Gruppe A","colors":["#ff0000"],"area":{"x":-12,"y":10,"w":8,"h":20}},{"id":"u-b1","name":"Gruppe B","colors":["#00ff00"],"area":{"x":-10,"y":20,"w":6,"h":20}}]', null, true) $$, :'world'), 'invalid_ultras');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[{"shape":"rect","size":"l","pattern":"solid","colors":["#ff0000"],"count":30}]', '[]', null, true) $$, :'world'), 'invalid_flags');
select public.save_fan_culture(:'world',
  '[{"shape":"swallow","size":"l","pattern":"stripes_h","colors":["#c8102e","#ffffff"],"count":8,"from":0.1,"to":0.6},{"shape":"rect","size":"s","pattern":"checker","colors":["#000000","#ffd200"],"count":4,"from":0.5,"to":1}]',
  '[{"id":"u-kurve","name":"Nordkurve 1990","colors":["#c8102e","#111111"],"banner":"NORDKURVE","area":{"x":-14,"y":14,"w":10,"h":40},"flags":10},{"id":"u-haupt","name":"Westblock","colors":["#ffffff","#c8102e"],"area":{"x":30,"y":71,"w":20,"h":6},"flags":3}]',
  null, true);
select tests.assert((public.fan_culture(:'world') -> 'ultras' -> 0 -> 'area' ->> 'h')::numeric = 40, 'Position und Größe gespeichert');
select tests.assert((public.fan_culture(:'world') -> 'flags' -> 0 ->> 'count')::int = 8, 'Fahnenanzahl gespeichert');

-- ------------------------------------------------------------------
-- Drei Trikots, automatische Wahl ohne Farbkonflikt
-- ------------------------------------------------------------------
select tests.assert((public.fan_culture(:'world') -> 'kits') ?& array['home', 'away', 'special'], 'drei Trikots vorhanden');
select tests.expect_error(format($$ select public.save_kits(%L, '{"home":{"pattern":"solid","primary":"#ff0000","secondary":"#ffffff"}}') $$, :'world'), 'invalid_kits');
select public.save_kits(:'world', '{"home":{"pattern":"stripes","primary":"#C8102E","secondary":"#FFFFFF"},"away":{"pattern":"solid","primary":"#FFFFFF","secondary":"#C8102E"},"special":{"pattern":"sash","primary":"#111111","secondary":"#FFD200"}}');
reset role;
select tests.assert((select kit ->> 'pattern' from public.club_branding where club_id = :'host_club') = 'stripes', 'Heimtrikot = bisheriges Trikot (Kompatibilität)');
select tests.assert(not exists (select 1 from public.club_branding b where public.fd_club_kits(b.club_id) is null or not (public.fd_club_kits(b.club_id) ?& array['home', 'away', 'special'])), 'alle Vereine haben Trikotsätze (gespeichert oder Standard)');
-- Gast mit gleichfarbigem Heimtrikot ⇒ automatisch ein anderes Trikot
select f.id as kfx, f.home_club_id as kh, f.away_club_id as ka from public.fixtures f
where f.season_id = :'season' and f.status = 'scheduled' and f.home_club_id <> :'host_club' and f.away_club_id <> :'host_club' limit 1 \gset
update public.club_branding set kits = jsonb_build_object('home', public.fd_club_kits(:'kh') -> 'home',
  'away', '{"pattern":"solid","primary":"#1B1B1B","secondary":"#FFFFFF"}'::jsonb, 'special', '{"pattern":"solid","primary":"#F2A93B","secondary":"#000000"}'::jsonb)
where club_id = :'ka';
select tests.assert(public.fd_color_dist('#C8102E', '#C8102E') = 0 and public.fd_color_dist('#000000', '#FFFFFF') > 600, 'Farbabstand wie in TypeScript');
select tests.assert((public.fd_fixture_kit(:'kfx', :'kh') ->> 'variant') = 'home', 'Heimverein: Heimtrikot');
select tests.assert((public.fd_fixture_kit(:'kfx', :'ka') ->> 'variant') <> 'home', 'Gast mit gleichem Heimtrikot wählt automatisch ein anderes');

-- ------------------------------------------------------------------
-- Spielvorbereitung: Choreo nur Heimverein, Frist startet automatisch
-- ------------------------------------------------------------------
select set_config('fd.world', :'world', false);
do $$
declare i integer := 0;
begin
  -- bis zu einem Termin, an dem beide Manager spielen
  while i < 40 and not (
    (public.fd_current_slot(current_setting('fd.world')::uuid)).kind = 'league'
    and (select count(*) from public.fd_prep_clubs(current_setting('fd.world')::uuid)) >= 2) loop
    perform public.fd_begin_slot(current_setting('fd.world')::uuid);
    perform tests.finish_slot(current_setting('fd.world')::uuid);
    i := i + 1;
  end loop;
end $$;
select ((public.fd_current_slot(:'world')).state = 'pending' and (select count(*) from public.fd_prep_clubs(:'world')) >= 1) as can_prep \gset
\if :can_prep
select public.fd_start_prep(:'world');
select tests.assert((public.fd_current_slot(:'world')).state = 'prep', 'Vorbereitung gestartet');
select f.id as pfx, (f.home_club_id = :'host_club') as host_home from public.fixtures f
where f.id in (select fixture_id from public.fd_prep_clubs(:'world') where club_id = :'host_club') \gset
select id as ch from public.club_choreos where club_id = :'host_club' limit 1 \gset
set role authenticated;
select tests.login(:'host');
select tests.assert((public.prep_state(:'world') -> 'fixture' -> 'home' -> 'kits') ?& array['home', 'away', 'special'], 'Vorschau zeigt beide Trikotsätze');
\if :host_home
select public.set_prep_choice(:'world', :'pfx', 'home', :'ch'::uuid, true, false);
reset role;
select tests.assert(exists (select 1 from public.fixture_choreos where fixture_id = :'pfx' and choreo_id = :'ch'), 'Heimverein wählt die Choreografie');
\else
select tests.expect_error(format($$ select public.set_prep_choice(%L, %L, 'home', %L, true, false) $$, :'world', :'pfx', :'ch'), 'not_home');
reset role;
\endif
-- Frist abgelaufen ⇒ Start ohne weitere Bestätigung (Sweep bzw. jeder Manager über prep_tick)
update public.season_slots set prep_until = now() - interval '1 second' where id = (public.fd_current_slot(:'world')).id;
select tests.assert(:'world'::uuid in (select public.admin_due_worlds()), 'Sweep erkennt abgelaufene Vorbereitung');
set role authenticated;
select tests.login(:'guest');
select public.prep_tick(:'world');
reset role;
select tests.assert((public.fd_current_slot(:'world')).state = 'live', 'Frist abgelaufen ⇒ Termin läuft');
set role service_role;
select tests.assert((public.admin_match_setup(:'pfx') -> 'home' ->> 'kitVariant') is not null, 'Match-Setup liefert die Trikotwahl');
select tests.assert((public.admin_match_setup(:'pfx') -> 'stadium' -> 'fans' -> 'away' ->> 'name') is not null, 'Gästefans im Match-Setup');
select tests.assert(jsonb_typeof(public.admin_match_setup(:'pfx') -> 'stadium' -> 'fans' -> 'away' -> 'chants') = 'array', 'Gästegesänge im Match-Setup (0032)');
select tests.assert(not exists (select 1 from jsonb_array_elements(public.admin_match_setup(:'pfx') -> 'stadium' -> 'fans' -> 'audio' -> 'chants') x where not (x ? 'signature')), 'Gesänge mit Signatur-Kennzeichen (Playlist ohne Signatur)');
reset role;
select tests.finish_slot(:'world');
\else
select 'Hinweis: kein Termin mit menschlichem Spiel mehr in dieser Testsaison – Vorbereitung bereits in 50_season geprüft' as hinweis;
\endif
