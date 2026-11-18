-- Phase 4: Mannschaftsmanagement (läuft nach 22_draft_complete in der Draftwelt)
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
\set stranger '00000000-0000-0000-0000-0000000000c1'

select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset

-- Gültige Aufstellung (4-4-2, Torwart + 10 Feldspieler des Hosts) als JSON vorbereiten
create temp table lineup as
with gk as (select id from public.players where club_id = :'host_club' and main_position = 'GK' order by overall desc limit 1),
     field as (select id, row_number() over (order by overall desc) as rn from public.players where club_id = :'host_club' and main_position <> 'GK' limit 10),
     slots as (select (s ->> 'index')::int as idx, s ->> 'position' as pos, (s ->> 'x')::numeric as x, (s ->> 'y')::numeric as y
               from public.formations f, jsonb_array_elements(f.slots) s where f.code = '4-4-2')
select s.idx, s.pos, s.x, s.y, case when s.idx = 0 then (select id from gk) else (select id from field where rn = s.idx) end as player_id
from slots s;
grant select on lineup to authenticated;

select jsonb_agg(jsonb_build_object('slot_index', idx, 'position', pos, 'x', x, 'y', y, 'player_id', player_id)) as slots from lineup \gset
select player_id as striker from lineup where idx = 10 \gset
select player_id as keeper from lineup where idx = 0 \gset
select id as foreign_player from public.players where club_id = :'guest_club' limit 1 \gset

\set ti '{"mentality":4,"buildUp":"short","tempo":4,"attackWidth":4,"attackFocus":"both_wings","chanceCreation":"patient","crossFrequency":2,"pressingIntensity":5,"defensiveLine":4,"defensiveWidth":3,"onBallWon":"counter","onBallLost":"counter_press"}'
\set ao '{"pressingTrigger":"back_pass","pressingDirection":"wings","offsideTrap":true,"restDefense":3,"marking":"zonal","tackling":2,"positionRotation":false,"overload":"left","throughBalls":3,"crossHeight":"low","boxPresence":2,"transitionCover":true,"pressTargets":[],"manMarking":[]}'

create function pg_temp.profile(p_slots jsonb, p_ti jsonb, p_ao jsonb, p_instr jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('formation_code', '4-4-2', 'team_instructions', p_ti, 'advanced_options', p_ao, 'slots', p_slots, 'player_instructions', p_instr)
$$;

set role authenticated;
select tests.login(:'stranger');
select tests.expect_error(format($$ select public.team_context(%L) $$, :'world'), 'not_a_member');

select tests.login(:'host');
select tests.assert((public.team_context(:'world') ->> 'tier')::int = 2, 'Team-Kontext: 2. Bundesliga');
select tests.assert(jsonb_array_length(public.team_context(:'world') -> 'sponsor_offers') = 10, 'zehn Sponsorenangebote für die eigene Liga');

-- ------------------------------------------------------------------
-- Taktikprofil
-- ------------------------------------------------------------------
select public.save_tactical_profile(:'world', 'offensive', pg_temp.profile(:'slots'::jsonb, :'ti'::jsonb, :'ao'::jsonb,
  jsonb_build_object(:'striker', jsonb_build_array('run_in_behind', 'shoot_more'), :'keeper', jsonb_build_array('sweeper_keeper'))));
select tests.assert((select count(*) from public.tactical_profile_slots s join public.tactical_profiles t on t.id = s.profile_id
                     where t.club_id = :'host_club' and t.name = 'offensive' and s.player_id is not null) = 11, 'Startelf gespeichert');
select tests.assert((select team_instructions ->> 'pressingIntensity' from public.tactical_profiles where club_id = :'host_club' and name = 'offensive') = '5',
  'Mannschaftsanweisungen gespeichert');
select tests.assert((select instructions from public.player_instructions i join public.tactical_profiles t on t.id = i.profile_id
                     where t.club_id = :'host_club' and i.player_id = :'striker') = '{run_in_behind,shoot_more}', 'Individuelle Anweisungen gespeichert');

-- Ungültige Aufstellungen
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile((%L::jsonb) - 10, %L, %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_lineup');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(jsonb_set(%L::jsonb, '{5,position}', '"GK"'), %L, %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_lineup');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(jsonb_set(%L::jsonb, '{5,player_id}', to_jsonb(%L::text)), %L, %L)) $$, :'world', :'slots', :'striker', :'ti', :'ao'), 'invalid_lineup');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(jsonb_set(%L::jsonb, '{5,player_id}', to_jsonb(%L::text)), %L, %L)) $$, :'world', :'slots', :'foreign_player', :'ti', :'ao'), 'foreign_player');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(jsonb_set(%L::jsonb, '{5,x}', '150'), %L, %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_lineup');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(jsonb_set(%L::jsonb, '{5,position}', 'null'), %L, %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_lineup');
-- Ungültige Taktik (fremder Schlüssel, Wert außerhalb, null-Werte)
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, (%L::jsonb) || '{"secretBonus":9}', %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_team_instructions');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, (%L::jsonb) || '{"tempo":6}', %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_team_instructions');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, (%L::jsonb) || '{"buildUp":null}', %L)) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_team_instructions');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, (%L::jsonb) || '{"marking":null}')) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_advanced_options');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, (%L::jsonb) - 'tackling')) $$, :'world', :'slots', :'ti', :'ao'), 'invalid_advanced_options');
-- Unpassende und widersprüchliche Anweisungen
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, %L, jsonb_build_object(%L, jsonb_build_array('overlap')))) $$, :'world', :'slots', :'ti', :'ao', :'striker'), 'invalid_player_instructions');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, %L, jsonb_build_object(%L, jsonb_build_array('run_in_behind', 'come_short')))) $$, :'world', :'slots', :'ti', :'ao', :'striker'), 'invalid_player_instructions');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, %L, jsonb_build_object(%L, jsonb_build_array('shoot_more')))) $$, :'world', :'slots', :'ti', :'ao', :'foreign_player'), 'invalid_player_instructions');

-- Taktik ist privat
select tests.login(:'guest');
select tests.assert((select count(*) from public.tactical_profile_slots s join public.tactical_profiles t on t.id = s.profile_id where t.club_id = :'host_club') = 0,
  'Gegner sieht die Aufstellung nicht');
select tests.assert((select count(*) from public.player_instructions) = 0, 'Gegner sieht keine Anweisungen');
select tests.expect_error(format($$ select public.save_tactical_profile(%L, 'neutral', pg_temp.profile(%L, %L, %L)) $$, :'world', :'slots', :'ti', :'ao'), 'foreign_player');

-- ------------------------------------------------------------------
-- E4/F9: Vereinseinstellungen und Standards
-- ------------------------------------------------------------------
select tests.login(:'host');
select public.save_club_tactics(:'world', '{"active_profile":"offensive","auto_substitutions":true,"auto_switch_enabled":true,"auto_switch_minute":70,"auto_switch_when_trailing":"offensive","auto_switch_when_leading":"defensive","corner_routine":"near_post","defensive_set_piece":"zonal"}');
reset role;
select tests.assert((select auto_switch_minute from public.tactics where club_id = :'host_club') = 70, 'E4: automatischer Taktikwechsel gespeichert');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.save_club_tactics(%L, '{"active_profile":"offensive","auto_substitutions":true,"auto_switch_enabled":true,"corner_routine":"near_post","defensive_set_piece":"zonal"}') $$, :'world'), 'invalid_settings');
select tests.expect_error(format($$ select public.save_club_tactics(%L, '{"active_profile":null,"auto_substitutions":true,"auto_switch_enabled":false,"corner_routine":"near_post","defensive_set_piece":"zonal"}') $$, :'world'), 'invalid_settings');
select tests.expect_error(format($$ select public.save_club_tactics(%L, '{"active_profile":"wild","auto_substitutions":true,"auto_switch_enabled":false,"corner_routine":"near_post","defensive_set_piece":"zonal"}') $$, :'world'), 'invalid_settings');

select public.save_set_pieces(:'world', jsonb_build_object('penalty', jsonb_build_array(:'striker', :'keeper'), 'free_kick', jsonb_build_array(:'striker')));
select tests.assert((select count(*) from public.set_piece_assignments where club_id = :'host_club') = 3, 'F9: Schützen inkl. Ersatzschütze gespeichert');
select tests.expect_error(format($$ select public.save_set_pieces(%L, jsonb_build_object('penalty', jsonb_build_array(%L))) $$, :'world', :'foreign_player'), 'invalid_set_pieces');
select tests.expect_error(format($$ select public.save_set_pieces(%L, jsonb_build_object('penalty', jsonb_build_array(%L, %L))) $$, :'world', :'striker', :'striker'), 'invalid_set_pieces');
select tests.expect_error(format($$ select public.save_set_pieces(%L, '{"bananas":[]}') $$, :'world'), 'invalid_set_pieces');

-- ------------------------------------------------------------------
-- G1: Training
-- ------------------------------------------------------------------
reset role;
select fitness as fit_before from public.players where id = :'striker' \gset
select development_points as dev_before from public.player_hidden where player_id = :'striker' \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.schedule_training(%L, %L, null) $$, :'world', :'striker'), 'invalid_focus');
select tests.expect_error(format($$ select public.schedule_training(%L, %L, 'offense') $$, :'world', :'foreign_player'), 'foreign_player');
select public.schedule_training(:'world', :'striker', 'offense');
select tests.expect_error(format($$ select public.schedule_training(%L, %L, 'defense') $$, :'world', :'striker'), 'already_trained');
select public.schedule_training(:'world', player_id, 'technique') from lineup where idx in (1, 2, 3, 4);
select tests.expect_error(format($$ select public.schedule_training(%L, %L, 'physical') $$, :'world',
  (select player_id from lineup where idx = 5)), 'training_limit');
select tests.assert(jsonb_array_length(public.team_context(:'world') -> 'trainees_this_week') = 5, 'genau fünf Trainierende diese Woche');
reset role;
select tests.assert((select fitness from public.players where id = :'striker') = greatest(0, :fit_before - 20), 'G1: Training kostet 20 Fitness');
select tests.assert((select development_points from public.player_hidden where player_id = :'striker') > :dev_before, 'G1: Entwicklungspunkte gesammelt');
select tests.assert((select overall from public.players where id = :'striker') = (select overall from lineup l join public.players p on p.id = l.player_id where l.idx = 10),
  'Training ändert die Stärke nicht sofort');

-- ------------------------------------------------------------------
-- I7 / B2.12: Sponsor und Bereitschaft
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'guest');
select tests.expect_error(format($$ select public.set_preseason_ready(%L, true) $$, :'world'), 'sponsor_required');
select tests.expect_error(format($$ select public.choose_sponsor(%L, 1::smallint) $$, :'world'), 'invalid_sponsor'); -- Angebot der 1. Liga
select public.choose_sponsor(:'world', 18::smallint);
select tests.expect_error(format($$ select public.set_preseason_ready(%L, true) $$, :'world'), 'lineup_incomplete');

select tests.login(:'host');
select public.choose_sponsor(:'world', 11::smallint);
select public.choose_sponsor(:'world', 20::smallint);
select tests.assert((public.team_context(:'world') ->> 'sponsor_offer_id')::int = 20, 'Sponsor bis Saisonstart änderbar');
select public.set_preseason_ready(:'world', true);
select tests.assert((select ready from jsonb_to_recordset(public.team_context(:'world') -> 'readiness') x(username text, ready boolean) where username = 'Hosti'),
  'Bereitschaft für den Saisonstart gesetzt');
reset role;

-- Nachbesserung: null-Werte umgehen die Wappenprüfung nicht mehr
select tests.assert(public.fd_valid_crest('{"shape":null,"pattern":"solid","symbol":"none","primary":"#000000","secondary":"#FFFFFF","accent":"#F2C14E","borderWidth":2,"initials":"FC","foundedYear":null}') = false,
  'Wappen mit null-Werten wird abgelehnt');
select tests.assert(public.fd_valid_kit('{"pattern":null,"primary":"#000000","secondary":"#FFFFFF"}') = false, 'Trikot mit null-Werten wird abgelehnt');

\echo '>>> 30_team: alle Prüfungen bestanden'
