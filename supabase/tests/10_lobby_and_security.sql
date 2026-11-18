-- Integrationstests Phase 1/2: Benutzer, Welt, Lobby, Verein, Sicherheit
\set ON_ERROR_STOP on
\set QUIET on

create function tests.club_payload(p_name text, p_short text, p_capacity integer default 25000) returns jsonb
language sql as $$
  select jsonb_build_object(
    'name', p_name, 'shortName', p_short,
    'primaryColor', '#1E7A46', 'secondaryColor', '#FFFFFF', 'accentColor', '#F2C14E',
    'crest', jsonb_build_object('shape','shield','pattern','stripes','symbol','lion','primary','#1E7A46',
                                'secondary','#FFFFFF','accent','#F2C14E','borderWidth',3,'initials',p_short,'foundedYear',1911),
    'kit', jsonb_build_object('pattern','stripes','primary','#1E7A46','secondary','#FFFFFF'),
    'stadiumName', 'Waldstadion', 'stadiumCapacity', p_capacity);
$$;
grant execute on function tests.club_payload(text, text, integer) to authenticated, service_role;

insert into auth.users(id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-00000000000e');

-- ------------------------------------------------------------------
-- Benutzername
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(null);
select tests.expect_error($$ select public.set_username('Alice') $$, 'not_authenticated');

select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.expect_error($$ select public.create_world('Freundesliga') $$, 'profile_required');
select tests.expect_error($$ select public.set_username('<script>') $$, 'invalid_username');
select tests.expect_error($$ select public.set_username('ab') $$, 'invalid_username');
select (public.set_username('Alice')).username = 'Alice' as ok \gset
select tests.assert(:'ok'::boolean, 'Profil angelegt');

select tests.login('00000000-0000-0000-0000-00000000000b');
select tests.expect_error($$ select public.set_username(' ALICE ') $$, 'username_taken');
select public.set_username('Bob') is not null as ok \gset
select tests.login('00000000-0000-0000-0000-00000000000c');
select public.set_username('Carla') is not null as ok \gset
select tests.login('00000000-0000-0000-0000-00000000000d');
select public.set_username('Dario') is not null as ok \gset
select tests.login('00000000-0000-0000-0000-00000000000e');
select public.set_username('Emil') is not null as ok \gset

-- ------------------------------------------------------------------
-- Welt erstellen und beitreten
-- ------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.expect_error($$ select public.create_world('x') $$, 'invalid_world_name');
select (r ->> 'world_id') as world_id, (r ->> 'invite_code') as code from (select public.create_world('Freundesliga') r) s \gset
select tests.assert(:'code' ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$', 'Einladungscode hat sechs gültige Zeichen');
select tests.assert((select difficulty from public.career_worlds where id = :'world_id') = 'medium', 'Standard-Schwierigkeit ist Mittel');

select tests.login('00000000-0000-0000-0000-00000000000b');
select tests.assert((select count(*) from public.career_worlds where id = :'world_id') = 0, 'Nichtmitglied sieht die Welt nicht');
select tests.assert((public.join_world('ZZZZZZ') ->> 'error') = 'world_not_found', 'falscher Code liefert world_not_found');
select tests.assert((public.join_world('abc') ->> 'error') = 'invalid_invite_code', 'kaputter Code liefert invalid_invite_code');
select tests.assert(
  (public.join_world(lower(substr(:'code', 1, 3)) || '-' || lower(substr(:'code', 4, 3))) ->> 'world_id') = :'world_id',
  'Beitritt mit Kleinbuchstaben und Bindestrich');
select tests.assert((public.join_world(:'code') ->> 'world_id') = :'world_id', 'erneuter Beitritt ist idempotent');
select tests.assert((select count(*) from public.world_members where world_id = :'world_id') = 2, 'zwei Mitglieder');

reset role;
select tests.assert((select count(*) from public.join_attempts where user_id = '00000000-0000-0000-0000-00000000000b') = 2,
  'Fehlversuche werden trotz Fehlerantwort protokolliert');
set role authenticated;

select tests.login('00000000-0000-0000-0000-00000000000c');
select tests.expect_error(format($$ select public.lobby_state(%L) $$, :'world_id'), 'not_a_member');
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('FC Test', 'FCT')) $$, :'world_id'), 'not_a_member');

-- ------------------------------------------------------------------
-- Vereinsgründung
-- ------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-00000000000a');
select public.upsert_my_club(:'world_id', tests.club_payload('SV Grünwald 1911', 'SVG')) as club_a \gset
select tests.assert(:'club_a' is not null, 'Verein A gegründet');

-- Validierung
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('SV Grünwald 1911', 'SVG', 12500)) $$, :'world_id'), 'invalid_capacity');
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('SV Grünwald 1911', 'svg')) $$, :'world_id'), 'invalid_short_name');
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('<b>X</b>', 'XXX')) $$, :'world_id'), 'invalid_club_name');
select tests.expect_error(format($$ select public.upsert_my_club(%L,
  jsonb_set(tests.club_payload('SV Grünwald 1911', 'SVG'), '{crest,evil}', '"<script>"')) $$, :'world_id'), 'invalid_crest');
select tests.expect_error(format($$ select public.upsert_my_club(%L,
  jsonb_set(tests.club_payload('SV Grünwald 1911', 'SVG'), '{crest,initials}', '"<s>"')) $$, :'world_id'), 'invalid_crest');
select tests.expect_error(format($$ select public.upsert_my_club(%L,
  jsonb_set(tests.club_payload('SV Grünwald 1911', 'SVG'), '{primaryColor}', '"red"')) $$, :'world_id'), 'invalid_colors');
select tests.expect_error(format($$ select public.upsert_my_club(%L,
  jsonb_set(tests.club_payload('SV Grünwald 1911', 'SVG'), '{kit,pattern}', '"plaid"')) $$, :'world_id'), 'invalid_kit');

-- Bearbeiten erzeugt keinen zweiten Verein
select public.upsert_my_club(:'world_id', tests.club_payload('SV Grünwald 1911', 'SVG', 30000)) = :'club_a' as same \gset
select tests.assert(:'same'::boolean, 'Bearbeiten aktualisiert denselben Verein');

select tests.login('00000000-0000-0000-0000-00000000000b');
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('sv grunwald-1911', 'BOB')) $$, :'world_id'), 'club_name_taken');
select tests.expect_error(format($$ select public.upsert_my_club(%L, tests.club_payload('Bobs Elf', 'SVG')) $$, :'world_id'), 'short_name_taken');
-- Menschliche Vereine dürfen reale Namen tragen (Sperrliste gilt nur für KI-Vereine, C7.1)
select public.upsert_my_club(:'world_id', tests.club_payload('Borussia Dortmund', 'BVB', 10000)) as club_b \gset
select tests.assert(:'club_b' is not null, 'Verein B gegründet (realer Name für Menschen erlaubt)');

-- ------------------------------------------------------------------
-- Bereitschaft und Schwierigkeit
-- ------------------------------------------------------------------
select public.set_ready(:'world_id', true);
select tests.assert(((public.lobby_state(:'world_id')) ->> 'all_ready')::boolean = false, 'noch nicht alle bereit');
select tests.expect_error(format($$ select public.set_world_difficulty(%L, 'hard') $$, :'world_id'), 'host_only');

select tests.login('00000000-0000-0000-0000-00000000000a');
select public.set_ready(:'world_id', true);
select tests.assert(((public.lobby_state(:'world_id')) ->> 'all_ready')::boolean, 'alle bereit');
select public.set_world_difficulty(:'world_id', 'hard');
select tests.assert(((public.lobby_state(:'world_id')) ->> 'all_ready')::boolean = false, 'Schwierigkeitswechsel setzt Bereitschaft zurück');
select tests.assert(((public.lobby_state(:'world_id')) #>> '{world,starting_capital}')::bigint = 210000000, 'Startkapital Schwer = 210 Mio.');
select tests.assert(
  (select (m -> 'club' ->> 'stadium_cost')::bigint from jsonb_array_elements(public.lobby_state(:'world_id') -> 'members') m
   where m ->> 'username' = 'Alice') = public.stadium_build_cost(30000),
  'Lobby zeigt Stadionkosten des aktuellen Stadions');

-- ------------------------------------------------------------------
-- RLS: Lesen nur innerhalb der Welt, private Daten nur für den Eigentümer
-- ------------------------------------------------------------------
select tests.assert((select count(*) from public.clubs where world_id = :'world_id') = 2, 'Mitglied sieht beide Vereine');
select tests.assert((select count(*) from public.club_branding where world_id = :'world_id') = 2, 'Mitglied sieht beide Wappen');
select tests.assert((select count(*) from public.tactical_profiles) = 3, 'eigene drei Taktikprofile sichtbar, fremde nicht');
select tests.assert((select count(*) from public.finances) = 1, 'nur eigenes Bankkonto sichtbar');
select tests.assert((select count(*) from public.tactical_profile_slots) = 33, 'eigene 3 × 11 Positionen sichtbar');

select tests.expect_error(format($$ insert into public.clubs(world_id, association_code, name, name_normalized, short_name, short_name_normalized, control)
  values (%L, 'GER', 'Hack FC', '', 'HCK', '', 'ai') $$, :'world_id'), 'permission denied');
select tests.expect_error(format($$ update public.finances set balance = 999999999 where club_id = %L $$, :'club_a'), 'permission denied');
select tests.expect_error(format($$ update public.career_worlds set difficulty = 'easy' where id = %L $$, :'world_id'), 'permission denied');
select tests.expect_error(format($$ select public.post_transaction(%L, 'adjustment', 1000000, 'hack', 'hack') $$, :'club_a'), 'permission denied');
select tests.expect_error($$ select * from public.player_hidden $$, 'permission denied');
select tests.expect_error($$ select * from public.club_name_blocklist $$, 'permission denied');
select tests.expect_error($$ select public.fd_generate_invite_code() $$, 'permission denied');

select tests.login('00000000-0000-0000-0000-00000000000c');
select tests.assert((select count(*) from public.clubs) = 0, 'Fremder sieht keine Vereine');
select tests.assert((select count(*) from public.profiles) = 1, 'Fremder sieht nur das eigene Profil');

reset role;
set role anon;
select tests.expect_error($$ select * from public.clubs $$, 'permission denied');
select tests.expect_error($$ select public.create_world('Anon-Welt') $$, 'permission denied');
reset role;

-- ------------------------------------------------------------------
-- Struktur-Invarianten (als Superuser geprüft)
-- ------------------------------------------------------------------
select tests.assert((select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) = 0, 'RLS auf allen Tabellen aktiv');
select tests.assert(not exists (
  select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (has_table_privilege('anon', c.oid, 'select')
      or has_table_privilege('authenticated', c.oid, 'insert')
      or has_table_privilege('authenticated', c.oid, 'update')
      or has_table_privilege('authenticated', c.oid, 'delete'))
), 'anon liest nichts, authenticated schreibt nirgends direkt');
select tests.assert((select count(*) from public.tactical_profiles where club_id = :'club_a') = 3, 'genau drei Taktikprofile je Verein');
select tests.assert((select array_agg(name order by name)::text from public.tactical_profiles where club_id = :'club_a') = '{offensive,neutral,defensive}',
  'feste Profilnamen');
select tests.assert((select count(*) from public.finances where club_id = :'club_a' and balance = 0) = 1, 'Konto vor Draft-Start leer (Buchung beim Draft-Start)');
select tests.assert((select count(*) from pg_publication_tables where pubname = 'supabase_realtime') = 9, 'Realtime-Tabellen registriert');

-- KI-Vereine dürfen keine realen Namen tragen (C7.1)
select tests.expect_error(format($$ insert into public.clubs(world_id, association_code, name, name_normalized, short_name, short_name_normalized, control)
  values (%L, 'GER', 'FC Bayern München', '', 'FCB', '', 'ai') $$, :'world_id'), 'club_name_blocked');
insert into public.clubs(world_id, association_code, name, name_normalized, short_name, short_name_normalized, control)
values (:'world_id', 'GER', 'TSV Hohenwalde 1897', '', 'TSH', '', 'ai') returning id as club_ai \gset

-- ------------------------------------------------------------------
-- Finanzbuchungen: idempotent, keine unerlaubt negativen Konten
-- ------------------------------------------------------------------
insert into public.finances(club_id, world_id, balance) values (:'club_ai', :'world_id', 0);
select public.post_transaction(:'club_ai', 'starting_capital', 100, 'cap-1', 'Start') as tx1 \gset
select public.post_transaction(:'club_ai', 'starting_capital', 100, 'cap-1', 'Start doppelt') as tx2 \gset
select tests.assert(:'tx1' = :'tx2', 'gleicher Schlüssel bucht nicht doppelt');
select tests.assert((select balance from public.finances where club_id = :'club_ai') = 100, 'Kontostand 100');
select tests.expect_error(format($$ select public.post_transaction(%L, 'draft_purchase', -150, 'buy-1', 'zu teuer') $$, :'club_ai'), 'insufficient_funds');
select public.post_transaction(:'club_ai', 'salary', -150, 'sal-1', 'Gehalt', null, true);
select tests.assert((select balance from public.finances where club_id = :'club_ai') = -50, 'Pflichtkosten dürfen ausdrücklich ins Minus');
select tests.assert((select balance_after from public.financial_transactions where idempotency_key = 'sal-1') = -50, 'balance_after protokolliert');

-- ------------------------------------------------------------------
-- B4/F14: Ergebnisse bleiben bis zur Freigabe verborgen
-- ------------------------------------------------------------------
insert into public.seasons(world_id, year) values (:'world_id', 2026) returning id as season \gset
insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
values (:'world_id', :'season', 'league', 'GER', 2, '2. Bundesliga') returning id as comp \gset
insert into public.fixtures(world_id, season_id, competition_id, matchday, slot_key, scheduled_date, home_club_id, away_club_id, status)
values (:'world_id', :'season', :'comp', 1, 'S2026-MD01', '2026-08-01', :'club_a', :'club_ai', 'finished') returning id as fx \gset
insert into public.fixture_results(fixture_id, world_id, home_goals, away_goals) values (:'fx', :'world_id', 2, 1);

set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 1, 'beteiligter Manager sieht sein beendetes Spiel');
select tests.login('00000000-0000-0000-0000-00000000000b');
select tests.assert((select count(*) from public.fixtures where id = :'fx') = 1, 'Spielplan ist sichtbar');
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 0, 'unbeteiligter Manager sieht das Ergebnis vor der Freigabe nicht');
reset role;
update public.fixtures set status = 'released', released_at = now() where id = :'fx';
set role authenticated;
select tests.assert((select count(*) from public.fixture_results where fixture_id = :'fx') = 1, 'nach Freigabe sehen alle das Ergebnis');

-- ------------------------------------------------------------------
-- Lobby verlassen, volle Welt, Begrenzung der Beitrittsversuche
-- ------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-00000000000a');
select tests.expect_error(format($$ select public.leave_world(%L) $$, :'world_id'), 'host_cannot_leave');
select tests.login('00000000-0000-0000-0000-00000000000b');
select public.leave_world(:'world_id');
select tests.assert((select count(*) from public.career_worlds where id = :'world_id') = 0, 'nach dem Verlassen keine Sicht mehr');
reset role;
select tests.assert((select count(*) from public.clubs where id = :'club_b') = 0, 'Verein des Ausgetretenen entfernt');

-- Welt auf 18 Mitglieder auffüllen
insert into auth.users(id) select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 17) g;
insert into public.profiles(id, username, username_normalized)
select ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'Fueller' || g, 'fueller' || g from generate_series(1, 17) g;
insert into public.world_members(world_id, user_id)
select :'world_id', ('00000000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid from generate_series(1, 17) g;
set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000000e');
select tests.expect_error(format($$ select public.join_world(%L) $$, :'code'), 'world_full');

select tests.login('00000000-0000-0000-0000-00000000000d');
select count(*) from (select public.join_world('ZZZZZ' || g) from generate_series(2, 9) g union all
                      select public.join_world('YYYYY' || g) from generate_series(2, 9) g union all
                      select public.join_world('XXXXX' || g) from generate_series(2, 5) g) s \gset
select tests.expect_error(format($$ select public.join_world(%L) $$, :'code'), 'rate_limited');
reset role;

\echo '>>> 10_lobby_and_security: alle Prüfungen bestanden'
