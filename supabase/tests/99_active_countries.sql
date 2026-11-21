-- Aktive Länder, Europapokal mit Kompaktberechnung, schlanke KI-Spiele, Fankultur, Stadionsound
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset

-- Testablauf: Saison 2 begann (Test 50) bevor die Europa-Vereine angelegt wurden (Test 60).
-- In echten Welten entstehen sie vor dem Saisonstart – hier den Europapokal einmal neu aufsetzen.
delete from public.competitions where season_id = :'season' and kind::text in ('champions_league', 'europa_league');
select public.fd_setup_europe(:'world', :'season');

-- ------------------------------------------------------------------
-- Zentrale Regel: aktive Länder = Länder mit menschlichem Manager
-- ------------------------------------------------------------------
select tests.assert(public.fd_active_assocs(:'world') = array['GER'], 'aktive Länder: nur GER (beide Manager spielen in Deutschland)');
select tests.assert((select count(distinct association_code) from public.clubs where world_id = :'world') > 1, 'Welt enthält weitere Länder (Transfermarkt)');
select tests.assert(not exists (select 1 from public.competitions c where c.season_id = :'season' and c.kind = 'league' and c.association_code <> 'GER'),
  'keine nationalen Ligen in nicht aktiven Ländern');
-- Verbindlicher Test: je regulärem Ligaspieltag genau 27 Spiele (3 × 9), alle in deutschen Ligen
select tests.assert(not exists (
  select 1 from public.season_slots s
  where s.season_id = :'season' and s.kind = 'league'
    and (select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id
         where f.season_id = s.season_id and f.slot_key = s.slot_key and c.kind = 'league' and c.association_code = 'GER') <> 27),
  'jeder Ligaspieltag: 9 + 9 + 9 = 27 Spiele');
select tests.assert(not exists (
  select 1 from public.fixtures f join public.competitions c on c.id = f.competition_id join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
  where f.season_id = :'season' and s.kind = 'league' and c.kind <> 'league'), 'an Ligaspieltagen keine weiteren Spiele');

-- Vereine mit Spielbetrieb: alle deutschen + Europapokal-Teilnehmer, sonst niemand
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code = 'GER'
  and c.id not in (select public.fd_active_club_ids(:'world'))), 'alle deutschen Vereine aktiv');
select tests.assert(not exists (select 1 from public.fd_active_clubs a join public.clubs c on c.id = a.club_id
  where a.world_id = :'world' and c.association_code <> 'GER'
    and not exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                    where e.club_id = c.id and co.season_id = :'season' and co.kind::text in ('champions_league', 'europa_league'))),
  'ausländische Vereine nur aktiv, wenn im Europapokal');
select count(*) as inactive from public.clubs c where c.world_id = :'world' and c.id not in (select public.fd_active_club_ids(:'world')) \gset
select tests.assert(:inactive > 0, 'es gibt Vereine ohne Spielbetrieb (' || :inactive || ')');

-- Europapokal-Teilnehmer aus nicht aktiven Ländern: nach Stärke, starke deutlich häufiger dabei
select tests.assert((select count(*) from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
  where co.season_id = :'season' and co.kind::text in ('champions_league', 'europa_league') and c.association_code <> 'GER') > 0, 'ausländische Teilnehmer im Europapokal');
select tests.assert(not exists (
  select 1 from (
    select c.association_code, public.fd_club_strength(c.id) st,
           -- über Ligaplätze qualifiziert (Pokalsieger: gewichtete Auslosung; Nachrücker füllen kleine Testwelten auf)
           exists (select 1 from public.ec_qualifications q where q.club_id = c.id and q.season_id = :'season'
                   and (q.reason like 'Meister%' or q.reason like 'Platz%')) sel
    from public.clubs c where c.world_id = :'world' and c.association_code <> 'GER' and not c.amateur
      and not exists (select 1 from public.ec_qualifications q where q.club_id = c.id and q.season_id = :'season' and (q.reason like 'Pokal%' or q.reason like 'Nachrücker%'))) x
  group by x.association_code
  having count(*) filter (where sel) > 0 and count(*) filter (where not sel) > 0
     and avg(st) filter (where sel) <= avg(st) filter (where not sel) + 2),
  'je Land: Teilnehmer deutlich stärker als Nicht-Teilnehmer');
-- Startplätze nach Länderrangliste: kein Land mit mehr als 5 Champions-League-Plätzen (Nachrücker füllen nur Lücken kleiner Testwelten)
select tests.assert(not exists (select 1 from public.ec_qualifications q
  where q.season_id = :'season' and q.competition = 'cl' and q.reason not like 'Nachrücker%'
  group by q.association_code having count(*) > 5), 'höchstens 5 CL-Plätze je Land');

-- Hintergrundarbeit nur für aktive Vereine (keine Markierungszeilen für inaktive mehr)
delete from public.ai_training_log where world_id = :'world';
select public.fd_ai_training_batch(:'world', 5000);
select tests.assert(not exists (select 1 from public.ai_training_log l where l.world_id = :'world' and l.club_id not in (select public.fd_active_club_ids(:'world'))),
  'KI-Training nur für Vereine mit Spielbetrieb');
select tests.assert(exists (select 1 from public.ai_training_log l where l.world_id = :'world'), 'KI-Training läuft weiter');

-- ------------------------------------------------------------------
-- Bis zum nächsten Europapokal-Termin spielen
-- ------------------------------------------------------------------
select set_config('fd.world', :'world', false);
do $$
declare i integer := 0;
begin
  while (public.fd_current_slot(current_setting('fd.world')::uuid)).kind <> 'europe' and i < 30 loop
    perform public.fd_begin_slot(current_setting('fd.world')::uuid);
    perform tests.finish_slot(current_setting('fd.world')::uuid);
    i := i + 1;
  end loop;
end $$;
select (public.fd_current_slot(:'world')).slot_key as eslot \gset
select tests.assert(:'eslot' like 'E%', 'Europapokal-Termin erreicht (' || :'eslot' || ')');

-- Termin ohne menschliches Spiel startet automatisch, sonst wie gewohnt
select exists (select 1 from public.fixtures f join public.clubs c on c.id in (f.home_club_id, f.away_club_id)
  where f.season_id = :'season' and f.slot_key = :'eslot' and c.control = 'human') as human_in_ec \gset
select public.fd_auto_begin(:'world') as auto_started \gset
select tests.assert(:'auto_started'::boolean = not :'human_in_ec'::boolean, 'automatischer Start nur ohne menschliches Spiel');
select public.fd_begin_slot(:'world');
select tests.assert((public.fd_current_slot(:'world')).state = 'live', 'Europapokal-Termin läuft');

-- Kompakte Spiele gehen nicht an den Match-Server, werden gesammelt in der DB berechnet
select count(*) as compact_n from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(:'world')) and public.fd_fixture_compact(f.id) \gset
select tests.assert(:compact_n > 0, 'kompakte Europapokal-Spiele vorhanden (' || :compact_n || ')');
set role service_role;
select tests.assert(not exists (select 1 from public.admin_pending_fixtures(:'world') p where public.fd_fixture_compact(p)), 'Match-Server bekommt keine kompakten Spiele');
reset role;
select public.fd_compact_batch(:'world', 100);
select tests.assert((select count(*) from public.fd_sim_log where world_id = :'world' and slot_key = :'eslot' and mode = 'compact') = :compact_n, 'alle kompakten Spiele berechnet und protokolliert');
select tests.assert(not exists (select 1 from public.match_events e join public.fixtures f on f.id = e.fixture_id
  where f.season_id = :'season' and f.slot_key = :'eslot' and e.type not in ('goal', 'yellow', 'second_yellow', 'red', 'injury')), 'kompakte Spiele: nur Tore, Karten, Verletzungen');
select tests.assert((select count(*) from public.match_events e join public.fixtures f on f.id = e.fixture_id
  where f.season_id = :'season' and f.slot_key = :'eslot' and e.type = 'goal')
  = (select sum(r.home_goals + r.away_goals) from public.fixture_results r join public.fixtures f on f.id = r.fixture_id where f.season_id = :'season' and f.slot_key = :'eslot'),
  'jedes Tor hat einen Torschützen');
select tests.assert((select sum(ms.goals) from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id where f.season_id = :'season' and f.slot_key = :'eslot')
  = (select sum(r.home_goals + r.away_goals) from public.fixture_results r join public.fixtures f on f.id = r.fixture_id where f.season_id = :'season' and f.slot_key = :'eslot'),
  'Torschützen in der Spielerstatistik');
select tests.assert(not exists (select 1 from public.fixtures f where f.season_id = :'season' and f.slot_key = :'eslot' and public.fd_fixture_compact(f.id)
  and (select count(*) from public.match_player_stats ms where ms.fixture_id = f.id) <> 22), 'je kompaktem Spiel 22 Einsatzspieler');
select tests.assert((select count(*) from public.fixture_results r where r.fixture_id in (select f.id from public.fixtures f where f.season_id = :'season' and f.slot_key = :'eslot' and public.fd_fixture_compact(f.id))) = :compact_n, 'nie doppelt: ein Ergebnis je Spiel');
select public.fd_compact_batch(:'world', 100) as again \gset
select tests.assert(:again = 0, 'abgeschlossene Spiele werden nicht erneut berechnet');
select tests.finish_slot(:'world');
select tests.assert((select state from public.season_slots where season_id = :'season' and slot_key = :'eslot') = 'released', 'Europapokal-Termin freigegeben');
select tests.assert((select sum(played) from public.standings s join public.competitions c on c.id = s.competition_id
  where c.season_id = :'season' and c.kind::text in ('champions_league', 'europa_league')) >= 32, 'Gruppentabellen aktualisiert');
select tests.assert(exists (select 1 from public.fd_leaders_cache lc join public.competitions c on c.id = lc.competition_id
  where c.season_id = :'season' and c.kind::text = 'champions_league' and jsonb_array_length(lc.data -> 'scorers') > 0), 'Torschützenliste Europapokal (Cache)');

-- Reine KI-Ligaspiele: nur Tore, Karten, Verletzungen werden gespeichert; menschliche Spiele vollständig
do $$
declare i integer := 0;
begin
  while (public.fd_current_slot(current_setting('fd.world')::uuid)).kind <> 'league' and i < 10 loop
    perform public.fd_begin_slot(current_setting('fd.world')::uuid);
    perform tests.finish_slot(current_setting('fd.world')::uuid);
    i := i + 1;
  end loop;
end $$;
select public.fd_begin_slot(:'world');
select f.id as aifx from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(:'world'))
  and not exists (select 1 from public.clubs c where c.id in (f.home_club_id, f.away_club_id) and c.control = 'human') limit 1 \gset
select f.id as hufx from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(:'world')) and :'host_club' in (f.home_club_id, f.away_club_id) \gset
select public.admin_finish_match(:'aifx', '{"score":[1,0],"events":[{"type":"kickoff","side":"home","second":0},{"type":"chance","side":"home","second":300},{"type":"save","side":"away","second":310},{"type":"goal","side":"home","second":900},{"type":"yellow","side":"away","second":1200},{"type":"fulltime","side":null,"second":5400}],"players":[]}'::jsonb);
select public.admin_finish_match(:'hufx', '{"score":[0,0],"events":[{"type":"kickoff","side":"home","second":0},{"type":"chance","side":"home","second":300},{"type":"fulltime","side":null,"second":5400}],"players":[]}'::jsonb);
select tests.assert((select string_agg(type, ',' order by match_second) from public.match_events where fixture_id = :'aifx') = 'goal,yellow', 'KI-Spiel: nur Tor und Karte gespeichert');
select tests.assert((select count(*) from public.match_events where fixture_id = :'hufx') = 3, 'Spiel mit Manager: alle Ereignisse gespeichert');
select tests.finish_slot(:'world');

-- Nachweis je Termin
select tests.assert(exists (select 1 from public.admin_sim_report(:'world') where mode = 'compact'), 'Simulationsbericht verfügbar');

-- ------------------------------------------------------------------
-- Fankultur und Stadionsound
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[{"shape":"rect","size":"m","pattern":"solid","colors":["red"]}]', '[]', null, true) $$, :'world'), 'invalid_flags');
select tests.expect_error(format($$ select public.save_fan_culture(%L, '[]', '[{"id":"u1xx","name":"X","colors":["#ff0000"],"block":"home_curve"}]', null, true) $$, :'world'), 'invalid_ultras');
select public.save_choreo(:'world', null, 'Blockfahne', '{"pattern":"stripes","colors":["#c8102e","#ffffff"],"text":"FÜR IMMER","motif":"star","block":"home_curve"}') as choreo \gset
select tests.expect_error(format($$ select public.save_choreo(%L, null, 'X', '{"pattern":"laser","colors":["#ffffff"]}') $$, :'world'), 'invalid_name');
select public.save_fan_culture(:'world',
  '[{"shape":"swallow","size":"l","pattern":"stripes_h","colors":["#c8102e","#ffffff"],"text":"ULTRAS"},{"shape":"rect","size":"m","pattern":"checker","colors":["#000000","#ffd200"]}]',
  '[{"id":"ultra-1","name":"Nordkurve 1990","colors":["#c8102e","#111111"],"banner":"NORDKURVE","block":"home_curve","flag":{"shape":"rect","size":"l","pattern":"halves","colors":["#c8102e","#111111"]}}]',
  :'choreo'::uuid, true);
select tests.assert(jsonb_array_length(public.fan_culture(:'world') -> 'flags') = 2, 'Fahnen gespeichert');
select tests.assert((public.fan_culture(:'world') -> 'ultras' -> 0 ->> 'name') = 'Nordkurve 1990', 'Ultragruppe gespeichert');
select (public.fan_culture(:'world') -> 'next_home' ->> 'fixture_id') as nexthome \gset
select public.set_fixture_choreo(:'world', :'nexthome', :'choreo'::uuid);
insert into storage.objects(bucket_id, name) values ('club-audio', :'world' || '/' || :'host_club' || '/hymne.mp3'), ('club-audio', :'world' || '/' || :'host_club' || '/tor.mp3');
select public.save_club_audio(:'world', null, jsonb_build_object('kind', 'anthem', 'name', 'Unsere Hymne', 'storage_path', :'world' || '/' || :'host_club' || '/hymne.mp3')) as anthem \gset
select public.save_club_audio(:'world', null, jsonb_build_object('kind', 'chant', 'name', 'Torgesang', 'situation', 'goal', 'storage_path', :'world' || '/' || :'host_club' || '/tor.mp3')) as chant \gset
select tests.expect_error(format($$ select public.save_club_audio(%L, null, '{"kind":"chant","source":"upload","name":"Fremd","storage_path":"x/y/z.mp3"}') $$, :'world'), 'invalid_file');
select public.set_audio_role(:'world', :'anthem', 'official');
select public.set_audio_role(:'world', :'chant', 'signature');
reset role;
select tests.assert((public.fd_fan_view(:'nexthome') -> 'choreo' ->> 'name') = 'Blockfahne', 'gewählte Choreografie erscheint beim Heimspiel');
select tests.assert((public.fd_fan_view(:'nexthome') -> 'audio' -> 'anthem' ->> 'name') = 'Unsere Hymne', 'offizielle Hymne beim Heimspiel');
select tests.assert((public.fd_fan_view(:'nexthome') -> 'audio' -> 'signature' ->> 'name') = 'Torgesang', 'Signatur-Fangesang beim Heimspiel');
select tests.assert(jsonb_array_length(public.fd_fan_view(:'nexthome') -> 'audio' -> 'chants') = 1, 'Gesang für Spielsituation');
select tests.assert((public.fd_fan_view(:'nexthome') ->> 'walkout')::boolean, 'Einlaufzeremonie bei Pflichtspielen');
-- Gäste dürfen fremde Fankultur nicht ändern
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.expect_error(format($$ select public.set_fixture_choreo(%L, %L, null) $$, :'world', :'nexthome'), 'not_home');
reset role;
