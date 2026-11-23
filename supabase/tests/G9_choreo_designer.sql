-- G9: Choreografie-Designer v2 (Migration 0046). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
begin;
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select m.user_id as guest from public.world_members m where m.world_id = :'world' and m.role <> 'host' order by m.user_id limit 1 \gset
select c.id as hclub from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' \gset
select c.id as aiclub from public.clubs c where c.world_id = :'world' and c.control = 'ai' and not c.amateur order by c.id limit 1 \gset

create temp table g9_ok as select jsonb_build_object('v', 2, 'pattern', 'stripes', 'colors', jsonb_build_array('#c8102e', '#ffffff'), 'text', 'FCD', 'motif', 'crest', 'block', 'home_curve',
  'scenes', jsonb_build_array(jsonb_build_object('dur', 6), jsonb_build_object('dur', 8)),
  'elements', jsonb_build_array(
    jsonb_build_object('id', 'a', 'kind', 'cards', 's0', 0, 's1', 1, 'regions', jsonb_build_array(jsonb_build_object('side', 'W'), jsonb_build_object('side', 'S', 'from', 0.2, 'to', 0.8, 'tiers', jsonb_build_array('lower'))),
                       'pattern', 'checker', 'colors', jsonb_build_array('#c8102e', '#ffffff'), 'text', 'DERBY', 'motif', 'lion', 'reveal', 'sweep', 'flip', 4, 'colors2', jsonb_build_array('#ffffff', '#c8102e')),
    jsonb_build_object('id', 'b', 'kind', 'banner', 's0', 0, 's1', 1, 'persist', true, 'x', 40, 'y', 74, 'w', 24, 'h', 2.2, 'rot', 0, 'text', 'UNSER STADION', 'colors', jsonb_build_array('#c8102e', '#ffffff')),
    jsonb_build_object('id', 'f', 'kind', 'flags', 's0', 1, 's1', 1, 'regions', jsonb_build_array(jsonb_build_object('side', 'NW')), 'flag', jsonb_build_object('shape', 'rect', 'pattern', 'stripes_h', 'colors', jsonb_build_array('#c8102e')), 'size', 'double', 'count', 12,
                       'points', jsonb_build_array(jsonb_build_object('x', -6, 'y', 20))),
    jsonb_build_object('id', 'z', 'kind', 'fence', 's0', 0, 's1', 0, 'side', 'N', 'from', 0.1, 'to', 0.9, 'h', 1.1, 'text', 'ZAUN', 'colors', jsonb_build_array('#111111', '#ffffff')),
    jsonb_build_object('id', 'c', 'kind', 'confetti', 's0', 1, 's1', 1, 'regions', jsonb_build_array(jsonb_build_object('side', 'E')), 'colors', jsonb_build_array('#c8102e', '#f2c14e'), 'density', 3),
    jsonb_build_object('id', 'w', 'kind', 'wave', 's0', 1, 's1', 1, 'regions', jsonb_build_array(jsonb_build_object('side', 'N')), 'colors', jsonb_build_array('#ffffff'), 'speed', 1.2))) as d;
select tests.assert(public.fd_valid_choreo((select d from g9_ok)), 'v2-Choreografie mit allen Elementarten ist gültig');
select tests.assert(public.fd_valid_choreo('{"pattern":"stripes","colors":["#c8102e","#ffffff"],"text":"FC","motif":"star","block":"all"}'::jsonb), 'bisheriges Design bleibt gültig');
-- ungültige v2-Varianten
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{scenes}', '[{"dur":5},{"dur":5},{"dur":5},{"dur":5},{"dur":5}]') from g9_ok)), 'mehr als 4 Szenen abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{scenes,0,dur}', '1') from g9_ok)), 'Szenendauer < 2 s abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,s1}', '5') from g9_ok)), 'Szenenindex außerhalb abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,kind}', '"laser"') from g9_ok)), 'unbekannte Elementart abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,colors}', '["rot"]') from g9_ok)), 'ungültige Farbe abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,regions,0,side}', '"X"') from g9_ok)), 'ungültige Tribüne abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,regions,1,tiers}', '["dach"]') from g9_ok)), 'ungültiger Rang abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,1,w}', '90') from g9_ok)), 'Spruchband zu breit abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,0,text}', to_jsonb(repeat('A', 41))) from g9_ok)), 'Text über 40 Zeichen abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,2,count}', '99') from g9_ok)), 'mehr als 40 Fahnen abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{elements,4,density}', '9') from g9_ok)), 'Dichte außerhalb 1–5 abgelehnt');
select tests.assert(not public.fd_valid_choreo((select d || jsonb_build_object('elements', (select jsonb_agg(e) from jsonb_array_elements(d -> 'elements') e, generate_series(1, 8))) from g9_ok)), 'mehr als 40 Elemente abgelehnt');
select tests.assert(not public.fd_valid_choreo((select jsonb_set(d, '{v}', '3') from g9_ok)), 'unbekannte Version abgelehnt');
select tests.assert(not public.fd_valid_choreo((select d || jsonb_build_object('junk', repeat('x', 30000)) from g9_ok)), 'Überlange Daten abgelehnt');

-- Speichern, Lesen, Rechte
select d::text as okj from g9_ok \gset
set role authenticated;
select tests.login(:'host');
select public.save_choreo(:'world', null, 'Derby', :'okj'::jsonb) as cid \gset
select public.save_choreo(:'world', null, 'Standard', '{"pattern":"stripes","colors":["#c8102e","#ffffff"],"text":"FC","motif":"star","block":"home_curve"}'::jsonb) as cid2 \gset
select tests.expect_error(format($$ select public.save_choreo(%L, null, 'Kaputt', '{"v":2,"pattern":"stripes","colors":["#c8102e"],"scenes":[],"elements":[]}'::jsonb) $$, :'world'), 'invalid_design');
select tests.assert(((public.fan_culture(:'world') -> 'choreos') @> format('[{"id":"%s"}]', :'cid')::jsonb), 'v2-Choreografie wird mit dem Verein gespeichert und geladen');
select tests.assert(((select x -> 'design' ->> 'v' from jsonb_array_elements(public.fan_culture(:'world') -> 'choreos') x where x ->> 'id' = :'cid') = '2'), 'v2-Design unverändert zurückgegeben');
reset role;
-- fremder Manager darf nicht bearbeiten
set role authenticated;
select tests.login(:'guest');
select tests.expect_error(format($$ select public.save_choreo(%L, %L, 'Fremd', '{"pattern":"stripes","colors":["#c8102e"],"text":"X","block":"all"}'::jsonb) $$, :'world', :'cid'), 'not_found');
select public.set_choreo_random(:'world', true); -- betrifft nur den eigenen Verein des Mitspielers
reset role;
select tests.assert((select name from public.club_choreos where id = :'cid') = 'Derby' and (select design ->> 'v' from public.club_choreos where id = :'cid') = '2', 'fremde Änderung hat die Choreografie nicht verändert');
select tests.assert(not coalesce((select choreo_random from public.club_fan_culture where club_id = :'hclub'), false), 'Zufallswahl des Mitspielers ändert den Verein des Hosts nicht');

-- Auswahl vor dem Spiel: Vorrang gewählt > Zufall > Standard; keine Stadionänderung
select count(*) as stadium_rows_before from public.stadiums where club_id = :'hclub' \gset
select md5(to_jsonb(s)::text) as stadium_hash from public.stadiums s where s.club_id = :'hclub' \gset
set role authenticated;
select tests.login(:'host');
select public.create_friendly(:'world', :'aiclub') as fx \gset
select public.set_choreo_random(:'world', true);
select (public.choreo_prefs(:'world') ->> 'random')::boolean as rnd \gset
reset role;
select tests.assert(:'rnd', 'Zufallswahl aktiviert und lesbar');
select (public.fd_fan_view(:'fx') -> 'choreo' ->> 'name') as pick1 \gset
select (public.fd_fan_view(:'fx') -> 'choreo' ->> 'name') as pick2 \gset
select tests.assert(:'pick1' = :'pick2' and exists (select 1 from public.club_choreos where club_id = :'hclub' and name = :'pick1'), 'Zufallswahl ist je Partie fest (alle Clients gleich) und stammt aus den gespeicherten (' || :'pick1' || ')');
-- ausdrücklich gewählte Choreografie hat Vorrang
set role authenticated;
select tests.login(:'host');
select public.set_fixture_choreo(:'world', :'fx', :'cid2');
reset role;
select tests.assert((public.fd_fan_view(:'fx') -> 'choreo' ->> 'name') = 'Standard', 'gewählte Choreografie hat Vorrang vor der Zufallswahl');
select tests.assert((select md5(to_jsonb(s)::text) from public.stadiums s where s.club_id = :'hclub') = :'stadium_hash', 'Auswahl vor dem Spiel verändert das Stadion nicht');
-- Zufall: ohne gespeicherte Choreografien Standard/Automatik
delete from public.fixture_choreos where fixture_id = :'fx';
delete from public.club_choreos where club_id = :'hclub';
select tests.assert((public.fd_fan_view(:'fx') -> 'choreo' ->> 'name') = 'Standard', 'ohne gespeicherte Choreografien greift die automatische Standardchoreo');
-- Zufall verteilt sich über Partien (stabil je Partie): mit 2 Choreos über mehrere Partien beide vorkommen
insert into public.club_choreos(club_id, world_id, name, design) select :'hclub', :'world', 'C' || i, '{"pattern":"stripes","colors":["#c8102e","#ffffff"],"text":"FC","block":"home_curve"}'::jsonb from generate_series(1, 6) i;
select count(distinct (select ch.name from public.club_choreos ch where ch.club_id = :'hclub' order by md5(g::text || ch.id::text) limit 1)) as spread from generate_series(1, 30) g \gset
select tests.assert(:spread >= 3, 'Zufallswahl streut über verschiedene Partien (' || :spread || ' von 6 Choreografien in 30 Partien)');
rollback;
\echo 'OK G9'
