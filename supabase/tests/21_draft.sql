-- Phase 3: Weltinitialisierung und Snake-Draft
-- Erwartet psql-Variablen: world, dir (Verzeichnis mit payload.json und ungültigen Varianten)
\set ON_ERROR_STOP on
\set payload `cat :dir/payload.json`
\set bad_pool `cat :dir/pool399.json`
\set bad_overall `cat :dir/pool84.json`
\set bad_crest `cat :dir/badcrest.json`
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
\set stranger '00000000-0000-0000-0000-0000000000c1'

-- ------------------------------------------------------------------
-- Rechte und Vorbedingungen
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, '{}'::jsonb) $$, :'world', :'host'), 'permission denied');
reset role;

set role service_role;
-- Migration 0011: Kontext für die Netlify-Function, nur für service_role
select tests.assert((public.admin_draft_context(:'world') ->> 'status') = 'lobby', 'admin_draft_context liefert den Status');
select tests.assert(jsonb_array_length(public.admin_draft_context(:'world') -> 'humans') = 2, 'admin_draft_context liefert die menschlichen Vereine');
select tests.assert(public.admin_draft_context(gen_random_uuid()) is null, 'unbekannte Welt ergibt null');
select tests.assert((select count(*) from public.career_worlds where id = :'world') = 1, 'service_role darf Tabellen lesen (Migration 0011)');
reset role;
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.admin_draft_context(%L) $$, :'world'), 'permission denied');
reset role;

set role service_role;
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'guest', :'payload'), 'host_only');
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'host', :'payload'), 'not_all_ready');
reset role;

set role authenticated;
select tests.login(:'guest');
select public.set_ready(:'world', true);
select tests.expect_error(format($$ select public.make_draft_pick(%L, gen_random_uuid()) $$, :'world'), 'draft_not_running');
reset role;

set role service_role;
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'host', :'bad_pool'), 'invalid_payload');
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'host', :'bad_overall'), 'invalid_payload');
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'host', :'bad_crest'), 'invalid_payload');
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, '{"version":2}'::jsonb) $$, :'world', :'host'), 'invalid_payload');
select tests.assert((select status from public.career_worlds where id = :'world') = 'lobby', 'fehlgeschlagene Starts ändern nichts');

-- ------------------------------------------------------------------
-- Start
-- ------------------------------------------------------------------
select public.admin_start_draft(:'world', :'host', :'payload'::jsonb) as start_result \gset
select tests.assert((:'start_result'::jsonb ->> 'players')::int = 52 * 25 + 400, 'alle Spieler gespeichert');
select tests.assert((public.admin_start_draft(:'world', :'host', :'payload'::jsonb) ->> 'already_started')::boolean, 'zweiter Start ist wirkungslos');
reset role;

select tests.assert((select status from public.career_worlds where id = :'world') = 'draft', 'Welt im Status Draft');
select tests.assert((select count(*) from public.clubs where world_id = :'world') = 54, 'C1: 54 Vereine');
select tests.assert((select count(*) from public.competitions where world_id = :'world' and kind = 'league') = 3, 'drei Ligen');
select tests.assert(not exists (
  select 1 from public.competitions c where c.world_id = :'world'
  and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18), 'jede Liga hat 18 Vereine');
select tests.assert((select count(*) from public.competition_entries e join public.competitions c on c.id = e.competition_id
                     join public.clubs cl on cl.id = e.club_id where c.world_id = :'world' and c.tier = 2 and cl.control = 'human') = 2,
  'menschliche Vereine starten in der 2. Bundesliga');
select tests.assert((select count(*) from public.players where world_id = :'world' and in_draft_pool) = 400, 'D1: 400 Draft-Spieler');
select tests.assert((select max(overall) from public.players where world_id = :'world' and in_draft_pool) <= 83, 'D2: kein Pool-Spieler über 83');
select tests.assert((select count(*) from public.free_agents where world_id = :'world') = 400, 'Pool zugleich Free-Agent-Markt');
select tests.assert((select count(*) from public.player_hidden where world_id = :'world') = 1700, 'verborgenes Potenzial für alle Spieler');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.control = 'ai'
  and (select count(*) from public.players p where p.club_id = c.id) <> 25), 'KI-Kader vollständig');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world'
  and (select count(*) from public.tactical_profiles t where t.club_id = c.id) <> 3), 'jeder Verein hat genau drei Taktikprofile');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.control = 'ai'
  and not exists (select 1 from public.managers m where m.club_id = c.id)), 'K1: jeder KI-Verein hat einen Manager');
select tests.assert((select count(*) from public.player_contracts where world_id = :'world' and active) = 1300, 'KI-Spieler haben Verträge');
select tests.assert(
  (select balance from public.finances f join public.clubs c on c.id = f.club_id where c.world_id = :'world' and c.manager_user_id = :'host')
  = public.starting_capital('medium') - public.stadium_build_cost(30000), 'I1/I3: Startkapital minus Stadion gebucht');
select tests.assert((select count(*) from public.financial_transactions t join public.clubs c on c.id = t.club_id
                     where c.world_id = :'world' and c.control = 'human') = 4, 'je Mensch zwei Startbuchungen');
select tests.assert((select status from public.draft_sessions where world_id = :'world') = 'running', 'Draft läuft');

-- ------------------------------------------------------------------
-- Picks
-- ------------------------------------------------------------------
select c.manager_user_id as first_user, c.id as first_club
from public.draft_sessions d join public.clubs c on c.id = d.club_order[1] where d.world_id = :'world' \gset
select c.manager_user_id as second_user, c.id as second_club
from public.draft_sessions d join public.clubs c on c.id = d.club_order[2] where d.world_id = :'world' \gset
select id as star from public.players where world_id = :'world' and in_draft_pool order by overall desc, market_value desc limit 1 \gset

set role authenticated;
select tests.login(:'stranger');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'star'), 'not_a_member');
select tests.login(:'second_user');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'star'), 'not_your_turn');
select tests.assert((public.draft_state(:'world') ->> 'current_club_id') = :'first_club', 'Zustand nennt den Verein am Zug');
select tests.assert(jsonb_array_length(public.draft_state(:'world') -> 'upcoming') = 12, 'Vorschau der nächsten Picks');

select tests.login(:'first_user');
select tests.expect_error(format($$ select public.make_draft_pick(%L, gen_random_uuid()) $$, :'world'), 'player_not_available');
select (public.make_draft_pick(:'world', :'star') ->> 'pick_index')::int = 0 as ok \gset
select tests.assert(:'ok'::boolean, 'erster Pick gespeichert');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'star'), 'not_your_turn');

select tests.login(:'second_user');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'star'), 'player_not_available');
reset role;

select tests.assert((select club_id from public.players where id = :'star') = :'first_club', 'Spieler gehört dem Verein');
select tests.assert(not exists (select 1 from public.free_agents where player_id = :'star'), 'Spieler nicht mehr Free Agent');
select tests.assert((select end_season_year - start_season_year from public.player_contracts where player_id = :'star' and active) = 2,
  'H5: drei Jahre Vertrag');
select tests.assert(
  (select balance from public.finances where club_id = :'first_club') =
  public.starting_capital('medium') - public.stadium_build_cost(case when :'first_user' = :'host' then 30000 else 50000 end)
  - (select market_value from public.players where id = :'star'), 'Marktwert vollständig abgezogen');
select tests.assert((select shirt_number from public.players where id = :'star') is not null, 'Trikotnummer vergeben');

-- Reserve-Regel: wer zu wenig übrig ließe, darf den teuren Spieler nicht nehmen
select id as pricey from public.players where world_id = :'world' and in_draft_pool order by market_value desc limit 1 \gset
select balance as saved_balance from public.finances where club_id = :'second_club' \gset
update public.finances set balance = (select market_value from public.players where id = :'pricey') + 1000 where club_id = :'second_club';
set role authenticated;
select tests.login(:'second_user');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'pricey'), 'budget_reserve');
reset role;
update public.finances set balance = 1000 where club_id = :'second_club';
set role authenticated;
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world', :'pricey'), 'insufficient_funds');
reset role;
update public.finances set balance = :saved_balance where club_id = :'second_club';

-- Auto-Pick: nur Host, nur bei abwesendem Manager
set role authenticated;
select tests.login(:'guest');
select tests.expect_error(format($$ select public.auto_pick_current(%L) $$, :'world'), 'host_only');
reset role;
update public.world_members set last_seen_at = now() where world_id = :'world';
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.auto_pick_current(%L) $$, :'world'), 'manager_active');
reset role;

\echo '>>> 21_draft: alle Prüfungen bestanden'
