-- Dashboard, Spieltagsübersicht, Profile: Inhalte und keine vorzeitige Freigabe verborgener Ergebnisse
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset

set role authenticated;
select tests.login(:'host');
select public.dashboard(:'world') as d \gset
reset role;
select tests.assert((:'d'::jsonb -> 'my_club' ->> 'id') = :'host_club', 'Dashboard: eigener Verein');
select tests.assert((:'d'::jsonb -> 'next') is not null and (:'d'::jsonb -> 'next' -> 'opponent' ->> 'name') is not null, 'Dashboard: nächste Begegnung mit Gegner');
select tests.assert(jsonb_array_length(:'d'::jsonb -> 'calendar') >= 1, 'Dashboard: Kalender');
select tests.assert(jsonb_array_length(:'d'::jsonb -> 'league' -> 'rows') >= 18, 'Dashboard: Ligatabelle');

-- Termin der Vorsaison (Saison 1) ist freigegeben: Übersicht abrufbar, Tabelle mit Vorplatz
select s.id as rslot from public.season_slots s where s.world_id = :'world' and s.state = 'released' and s.kind = 'league' order by s.ordinal desc limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.matchday_report(:'world', :'rslot') as rep \gset
reset role;
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'competitions') = 1, 'Übersicht: nur die eigene Liga');
select tests.assert((:'rep'::jsonb -> 'competitions' -> 0 ->> 'name') = (:'rep'::jsonb -> 'table' ->> 'name'), 'Übersicht: Ergebnisse der eigenen Liga');
select tests.assert((select count(*) from jsonb_array_elements(:'rep'::jsonb -> 'competitions') c, jsonb_array_elements(c -> 'games') g, jsonb_array_elements(g -> 'events') e where e ->> 'type' = 'goal')
  = (select count(*) from public.match_events e join public.fixtures f on f.id = e.fixture_id join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
     join public.competitions c on c.id = f.competition_id
     where s.id = :'rslot' and e.type = 'goal' and e.player_id is not null and f.status = 'released' and c.name = (:'rep'::jsonb -> 'table' ->> 'name')), 'Übersicht: alle Torschützen der eigenen Liga');
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'top_ratings') = least(5, (select count(*) from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id
  join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key join public.competitions c on c.id = f.competition_id
  where s.id = :'rslot' and ms.minutes >= 45 and ms.rating is not null and c.name = (:'rep'::jsonb -> 'table' ->> 'name'))), 'Übersicht: Top-Spieler des Spieltags');
select tests.assert((:'rep'::jsonb -> 'table' -> 'rows' -> 0 ->> 'prev') is not null, 'Übersicht: Tabellenveränderung');

-- Pflichtübersicht: gesehen markieren
set role authenticated;
select tests.login(:'host');
select public.mark_review_seen(:'world', :'rslot');
reset role;
select tests.assert(exists (select 1 from public.matchday_reviews where slot_id = :'rslot' and user_id = :'host'), 'Übersicht als gesehen gespeichert');

-- Keine vorzeitige Freigabe: nicht freigegebener Termin ist gesperrt
select s.id as pslot from public.season_slots s join public.career_worlds w on w.id = s.world_id and w.current_season_id = s.season_id
where s.world_id = :'world' and s.state <> 'released' order by s.ordinal limit 1 \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.matchday_report(%L, %L) $$, :'world', :'pslot'), 'not_released');
reset role;
-- Ein beendetes, aber nicht freigegebenes Spiel taucht in Profilen nicht auf
select f.id as hidden_fx, f.home_club_id as hclub from public.fixtures f where f.world_id = :'world' and f.status = 'scheduled' order by f.scheduled_date limit 1 \gset
insert into public.fixture_results(fixture_id, world_id, home_goals, away_goals) values (:'hidden_fx', :'world', 9, 0);
update public.fixtures set status = 'finished' where id = :'hidden_fx';
set role authenticated;
select tests.login(:'host');
select public.club_profile(:'hclub') as cp \gset
reset role;
select tests.assert(not exists (select 1 from jsonb_array_elements(:'cp'::jsonb -> 'results') r where r ->> 'id' = :'hidden_fx'), 'verborgenes Ergebnis nicht im Vereinsprofil');
update public.fixtures set status = 'scheduled' where id = :'hidden_fx';
delete from public.fixture_results where fixture_id = :'hidden_fx';

-- Vereinsprofil: Kader, Stärke, keine geheimen Taktikdaten
select tests.assert(jsonb_array_length(:'cp'::jsonb -> 'squad') >= 16 and (:'cp'::jsonb ->> 'strength') is not null, 'Vereinsprofil: Kader und Stärke');
select tests.assert(not (:'cp'::jsonb ? 'profiles') and not (:'cp'::jsonb ? 'instructions') and not (:'cp'::jsonb ? 'tactics'), 'Vereinsprofil: keine geheimen Taktiken');

-- Spielerprofil: fremder Spieler ohne Gehalt, eigener mit Gehalt
select p.id as foreign_player from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.id <> :'host_club' and c.control = 'ai' limit 1 \gset
select p.id as own_player from public.players p where p.club_id = :'host_club' limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.player_profile(:'foreign_player') as fp \gset
select public.player_profile(:'own_player') as op \gset
reset role;
select tests.assert((:'fp'::jsonb -> 'attributes' -> 'values') is not null and (:'fp'::jsonb -> 'contract' -> 'salary') = 'null'::jsonb, 'fremder Spieler: Werte ja, Gehalt nein');
select tests.assert((:'op'::jsonb -> 'contract' ->> 'salary')::bigint > 0 and (:'op'::jsonb -> 'development') is not null, 'eigener Spieler: Gehalt und Entwicklung');
set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000dead');
select tests.expect_error(format($$ select public.player_profile(%L) $$, :'own_player'), 'forbidden');
reset role;
