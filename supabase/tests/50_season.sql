-- Phase 7 + 8: Saisonstart, Spielplan, Spieltagsablauf (B4), Tabellen, Pokal, Relegation, Saisonwechsel,
-- Finanzen und Transfers. Ergebnisse werden hier direkt über admin_finish_match eingetragen
-- (die Engine-Berechnung testet der Ende-zu-Ende-Test).
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'

select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select id as guest_club from public.clubs where world_id = :'world' and manager_user_id = :'guest' \gset

-- Hilfsfunktion: alle offenen Spiele des aktuellen Termins mit deterministischen Ergebnissen abschließen
create or replace function tests.finish_slot(p_world uuid) returns integer language plpgsql as $$
declare f record; n integer := 0;
begin
  for f in select fx.id, fx.rng_seed from public.fixtures fx where fx.id in (select public.fd_slot_fixture_ids(p_world)) and fx.status in ('scheduled', 'live') loop
    perform public.admin_finish_match(f.id, jsonb_build_object(
      'score', jsonb_build_array(floor(public.fd_hash01(f.rng_seed || 'h') * 4)::int, floor(public.fd_hash01(f.rng_seed || 'a') * 3)::int),
      'possessionHome', 50, 'stats', jsonb_build_object('home', jsonb_build_object('xg', 1.2), 'away', jsonb_build_object('xg', 1.0)),
      'events', '[]'::jsonb, 'players', '[]'::jsonb));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------------
-- Saisonstart
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'guest');
select tests.expect_error(format($$ select public.force_start_season(%L) $$, :'world'), 'host_only');
select tests.login(:'host');
select public.force_start_season(:'world');
reset role;

select tests.assert((select status from public.career_worlds where id = :'world') = 'season', 'Saison läuft');
select current_season_id as season from public.career_worlds where id = :'world' \gset
select tests.assert((select count(*) from public.season_slots where season_id = :'season') = 43, '43 Termine in Saison 1 (34 Liga, 6 Pokal, 2 Relegation, Abschluss)');
select tests.assert(not exists (select 1 from public.season_slots where season_id = :'season' and kind = 'europe'), 'Saison 1: keine Europapokal-Termine');
select tests.assert(not exists (select 1 from public.competitions c where c.season_id = :'season' and c.kind::text in ('champions_league', 'europa_league')), 'Saison 1: kein Europapokal, niemand automatisch qualifiziert');
select tests.assert(not exists (select 1 from public.ec_qualifications where season_id = :'season'), 'Saison 1: keine Qualifikationseinträge');
select tests.assert(not exists (select 1 from public.season_slots s1 join public.season_slots s2 on s2.season_id = s1.season_id and s2.slot_date = s1.slot_date and s2.id <> s1.id where s1.season_id = :'season'), 'kein Termin doppelt an einem Tag');
select tests.assert((select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'league') = 918, '918 Ligaspiele');
select tests.assert(not exists (
  select 1 from public.competitions c where c.season_id = :'season' and c.kind = 'league'
    and exists (select 1 from public.competition_entries e where e.competition_id = c.id
                and (select count(*) from public.fixtures f where f.competition_id = c.id and e.club_id in (f.home_club_id, f.away_club_id)) <> 34)), 'jeder Verein 34 Ligaspiele');
select tests.assert(not exists (
  select 1 from (select f.competition_id, f.matchday, unnest(array[f.home_club_id, f.away_club_id]) as club
                 from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'league') x
  group by competition_id, matchday, club having count(*) > 1), 'kein Verein doppelt an einem Spieltag');
select tests.assert(not exists (
  select 1 from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'league'
  group by f.home_club_id, f.away_club_id having count(*) > 1), 'jede Paarung genau einmal mit Heimrecht');
select tests.assert((select count(*) from public.clubs where world_id = :'world' and amateur) = 10, '10 Amateurvereine (abstrakte 4. Liga)');
select tests.assert(not exists (select 1 from public.clubs c where c.amateur and c.world_id = :'world'
  and ((select count(*) from public.players p where p.club_id = c.id) < 18 or (select count(*) from public.players p where p.club_id = c.id and p.main_position = 'GK') < 2)), 'Amateure haben vollständige Kader');
select tests.assert((select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'domestic_cup') = 32, 'Pokal 1. Runde: 32 Spiele');
select tests.assert(not exists (select 1 from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'domestic_cup'
  and public.fd_tier_of(f.home_club_id, :'season') < public.fd_tier_of(f.away_club_id, :'season')), 'Pokal: Unterklassige haben Heimrecht');
select tests.assert((select count(*) from public.standings s join public.competitions c on c.id = s.competition_id where c.season_id = :'season' and c.kind = 'league') = 54, 'Tabellen angelegt');

-- ------------------------------------------------------------------
-- B4: Termin vorbereiten, starten, Live/Überspringen, Freigabe
-- ------------------------------------------------------------------
set role authenticated;
select tests.login(:'host');
select tests.assert((public.matchday_state(:'world') -> 'slot' ->> 'key') = 'C1', 'erster Termin: Pokal 1. Runde');
select tests.assert((public.matchday_state(:'world') -> 'window' ->> 'open')::boolean, 'Transferfenster 1 offen');
select public.set_matchday_ready(:'world', true);
select tests.assert((public.matchday_state(:'world') -> 'slot' ->> 'state') = 'pending', 'wartet auf den Gast');
-- Ergebnisse dürfen vor dem Start nicht berechnet werden
reset role;
select id as cupfx from public.fixtures where id in (select public.fd_slot_fixture_ids(:'world')) limit 1 \gset
set role service_role;
select tests.expect_error(format($$ select public.admin_match_setup(%L) $$, :'cupfx'), 'slot_not_live');
reset role;
set role authenticated;
select tests.login(:'guest');
select public.set_matchday_ready(:'world', true);
select tests.assert((public.matchday_state(:'world') -> 'slot' ->> 'state') = 'prep', 'alle bereit ⇒ Spielvorbereitung');
-- Spielvorbereitung: Trikot wählen und bestätigen (Gast zuerst), danach startet der Termin
select (public.prep_state(:'world') -> 'fixture' ->> 'id') as gfx \gset
select tests.assert((public.prep_state(:'world') ->> 'seconds_left')::int between 1 and 120, 'Vorbereitung mit Frist');
select tests.expect_error(format($$ select public.set_prep_choice(%L, %L, 'purple', null, false, true) $$, :'world', :'gfx'), 'invalid_kit');
select public.set_prep_choice(:'world', :'gfx', 'away', null, false, true);
select tests.assert((public.matchday_state(:'world') -> 'slot' ->> 'state') = 'prep', 'wartet auf die Bestätigung des zweiten Managers');
select tests.login(:'host');
select (public.prep_state(:'world') -> 'fixture' ->> 'id') as hfx0 \gset
select tests.expect_error(format($$ select public.set_prep_choice(%L, %L, 'home', null, false, true) $$, :'world', :'gfx'), 'forbidden');
select public.set_prep_choice(:'world', :'hfx0', 'special', null, false, true);
select tests.assert((public.matchday_state(:'world') -> 'slot' ->> 'state') = 'live', 'alle bestätigt ⇒ Termin läuft');
reset role;
select tests.assert((select variant from public.fixture_kits where fixture_id = :'hfx0' and club_id = :'host_club') = 'special', 'Trikotwahl gespeichert');
select tests.assert((select variant from public.fixture_kits where fixture_id = :'gfx' and club_id = :'guest_club') = 'away', 'Trikotwahl des Gasts gespeichert');
set role authenticated;
select tests.login(:'guest');
reset role;
-- menschliche Spiele werden erst nach „Überspringen“ headless berechnet
select tests.assert(not exists (select 1 from public.admin_pending_fixtures(:'world') p join public.fixtures f on f.id = p
  where :'host_club' in (f.home_club_id, f.away_club_id)), 'eigenes Spiel nicht ohne Entscheidung');
select id as hostfx from public.fixtures where id in (select public.fd_slot_fixture_ids(:'world')) and :'host_club' in (home_club_id, away_club_id) \gset
set role authenticated;
select tests.login(:'host');
select public.set_fixture_decision(:'hostfx', 'skip');
select tests.login(:'guest');
select tests.expect_error(format($$ select public.set_fixture_decision(%L, 'skip') $$, :'hostfx'), 'forbidden');
reset role;
select tests.assert(exists (select 1 from public.admin_pending_fixtures(:'world') p where p = :'hostfx'), 'Überspringen ⇒ headless');
-- alle bis auf ein Spiel abschließen: noch keine Freigabe, Ergebnisse anderer verborgen
select public.admin_finish_match(f.id, '{"score":[1,0],"events":[],"players":[]}'::jsonb)
from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(:'world')) and f.id <> :'hostfx' and not (:'guest_club' in (f.home_club_id, f.away_club_id));
set role authenticated;
select tests.login(:'host');
select tests.assert((select count(*) from public.fixture_results r join public.fixtures f on f.id = r.fixture_id
  where f.slot_key = 'C1' and f.season_id = :'season') = 0, 'keine fremden Ergebnisse vor der Freigabe');
reset role;
select tests.finish_slot(:'world');
select tests.assert((select state from public.season_slots where season_id = :'season' and slot_key = 'C1') = 'released', 'alle Spiele fertig ⇒ Freigabe');
select tests.assert((select current_slot from public.career_worlds where id = :'world') = 2, 'nächster Termin');
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id where st.kind = 'round_of_32'
  and st.competition_id = (select id from public.competitions where season_id = :'season' and kind = 'domestic_cup')) = 16, 'Pokal 2. Runde ausgelost');
set role authenticated;
select tests.login(:'guest');
select tests.assert((select count(*) from public.fixture_results r join public.fixtures f on f.id = r.fixture_id
  where f.slot_key = 'C1' and f.season_id = :'season') = 32, 'nach der Freigabe sieht jeder alle Ergebnisse');
reset role;

-- 1. Spieltag: Tabelle, Prämien, Zuschauer, Gehälter
select balance as bal_before from public.finances where club_id = :'host_club' \gset
set role authenticated; select tests.login(:'host'); select public.force_start_slot(:'world'); reset role;
select tests.finish_slot(:'world');
select tests.assert((select state from public.season_slots where season_id = :'season' and slot_key = 'L1') = 'released', 'Spieltag 1 freigegeben');
select tests.assert((select sum(played) from public.standings s join public.competitions c on c.id = s.competition_id where c.season_id = :'season' and c.kind = 'league') = 54, 'jeder Verein hat ein Spiel');
select tests.assert((select sum(points) from public.standings s join public.competitions c on c.id = s.competition_id where c.season_id = :'season')
  = (select sum(case when r.home_goals = r.away_goals then 2 else 3 end) from public.fixture_results r join public.fixtures f on f.id = r.fixture_id where f.slot_key = 'L1' and f.season_id = :'season'),
  'Punkte stimmen');
select tests.assert(exists (select 1 from public.financial_transactions where club_id = :'host_club' and kind = 'salary'), 'Gehälter gebucht');
select tests.assert(exists (select 1 from public.financial_transactions where club_id = :'host_club' and kind = 'match_bonus'), 'Spielprämie gebucht');
select tests.assert(exists (select 1 from public.fixture_results r join public.fixtures f on f.id = r.fixture_id where f.slot_key = 'L1' and f.season_id = :'season' and r.attendance > 0), 'Zuschauerzahlen erfasst');
select tests.assert((select count(*) from public.financial_transactions where kind = 'ticket_income' and world_id = :'world') >= 27, 'Ticketeinnahmen der Heimvereine');

-- ------------------------------------------------------------------
-- Phase 8: Transfers (Fenster offen bis Spieltag 5)
-- ------------------------------------------------------------------
select p.id as target, p.market_value as target_value, p.club_id as target_club from public.players p join public.clubs c on c.id = p.club_id
where c.world_id = :'world' and c.control = 'ai' and not c.amateur and public.fd_tier_of(c.id, :'season') = 3 order by p.overall desc limit 1 \gset
select p.id as fa from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = :'world' order by p.overall desc limit 1 \gset
select id as mine from public.players where club_id = :'host_club' order by overall limit 1 \gset
select public.post_transaction(:'host_club', 'adjustment', 80000000, 'test:boost', 'Testgeld');
set role authenticated;
select tests.login(:'host');
select tests.assert((public.make_transfer_offer(:'target', 0, 100000, 2) ->> 'status') = 'rejected', 'KI lehnt Nullangebot ab');
-- 85 % der KI-Bewertung liegt sicher im Bereich „zögern“ (0,6–1,15); der Marktwert allein kann je nach Spieler darunter liegen
reset role;
select public.fd_ai_valuation(:'target') as target_val \gset
set role authenticated;
select tests.login(:'host');
select public.make_transfer_offer(:'target', (:target_val * 0.85)::bigint, 100000, 2) as hes \gset
select tests.assert((:'hes'::jsonb ->> 'status') = 'pending', 'KI zögert bei einem Angebot zum Marktwert (Antwort frühestens nach einer Woche)');
select public.withdraw_transfer_offer((:'hes'::jsonb ->> 'offer')::uuid);
select public.make_transfer_offer(:'target', (:target_value * 2.5)::bigint, 5000000, 3) as deal \gset
select tests.assert((:'deal'::jsonb ->> 'status') = 'completed', 'Transfer abgeschlossen');
reset role;
select tests.assert((select club_id from public.players where id = :'target') = :'host_club', 'Spieler gehört jetzt dem Host');
select tests.assert((select count(*) from public.player_contracts where player_id = :'target' and active) = 1, 'genau ein aktiver Vertrag');
select tests.assert(not exists (select 1 from public.tactical_profile_slots s join public.tactical_profiles t on t.id = s.profile_id where t.club_id = :'target_club' and s.player_id = :'target'),
  'aus der Aufstellung des alten Vereins entfernt');
set role authenticated;
select tests.login(:'host');
-- Free Agent: Bewerbung, Entscheidung frühestens nach 7 Tagen, ein Vertrag
select tests.assert((public.sign_free_agent(:'fa', 2) ->> 'status') = 'applied', 'Bewerbung beim Free Agent');
select tests.expect_error(format($$ select public.sign_free_agent(%L, 2) $$, :'fa'), 'already_applied');
select tests.login(:'guest');
select tests.assert((public.sign_free_agent(:'fa', 2) ->> 'status') = 'applied', 'zweiter Interessent innerhalb der Woche');
select tests.login(:'host');
reset role;
select tests.assert((select decision_on = first_interest_on + 7 from public.free_agents where player_id = :'fa'), 'Frist exakt 7 Kalendertage');
select tests.assert(public.fd_fa_process(:'world') = 0, 'keine Entscheidung vor Fristablauf');
update public.free_agents set decision_on = public.fd_world_date(:'world') where player_id = :'fa';
select public.fd_fa_process(:'world');
select tests.assert(not exists (select 1 from public.fa_applications where player_id = :'fa' and status = 'pending'), 'Entscheidung automatisch getroffen');
select tests.assert((select count(*) from public.fa_applications where player_id = :'fa' and status = 'signed') <= 1, 'höchstens ein Vertrag');
select (select count(*) from public.transfers where player_id = :'fa' and to_club_id = :'host_club') as fa_host \gset
set role authenticated;
select tests.login(:'host');
select tests.assert((public.sell_to_ai(:'mine') ->> 'status') = 'completed', 'Verkauf an KI');
select tests.assert((public.matchday_state(:'world') -> 'window' ->> 'signings')::int = 1 + :fa_host, 'Limitzähler Neuzugänge');
-- Mensch ↔ Mensch
select p.id as gplayer from public.players p where p.club_id = :'guest_club' order by p.overall desc limit 1 \gset
select (public.make_transfer_offer(:'gplayer', 1000000, 9000000, 2) ->> 'offer') as hoffer \gset
select tests.login(:'guest');
select tests.assert(jsonb_array_length(public.my_transfer_offers(:'world')) >= 1, 'Gast sieht das Angebot');
select public.respond_transfer_offer(:'hoffer', 'counter', 30000000);
select tests.login(:'host');
select tests.expect_error(format($$ select public.respond_transfer_offer(%L, 'accept') $$, :'hoffer'), 'not_found');
select public.withdraw_transfer_offer(:'hoffer');
select public.set_ticket_prices(:'world', 28, 18, 40);
select tests.expect_error(format($$ select public.expand_stadium(%L) $$, :'world'), 'not_preseason');
select tests.assert((public.finance_overview(:'world') ->> 'balance')::bigint is not null, 'Finanzübersicht');
reset role;

-- ------------------------------------------------------------------
-- Rest der Saison durchspielen (Host startet jeden Termin)
-- ------------------------------------------------------------------
select set_config('fd.world', :'world', false);
select id as bl from public.competitions where season_id = :'season' and kind = 'league' and tier = 1 \gset
select id as bl2 from public.competitions where season_id = :'season' and kind = 'league' and tier = 2 \gset
select avg(age) as age_before from public.players where club_id = :'host_club' \gset
do $$
declare i integer := 0;
begin
  while (select status from public.career_worlds where id = current_setting('fd.world')::uuid) = 'season' and i < 60 loop
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
    perform public.fd_begin_slot(current_setting('fd.world')::uuid);
    perform tests.finish_slot(current_setting('fd.world')::uuid);
    i := i + 1;
  end loop;
end $$;

select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason', 'Saison beendet ⇒ neue Vorbereitung');
select current_season_id as season2 from public.career_worlds where id = :'world' \gset
select tests.assert(:'season2' <> :'season', 'neue Saison angelegt');
select tests.assert((select count(*) from public.season_slots where season_id = :'season' and state = 'released') = 43, 'alle 43 Termine abgeschlossen');
select tests.assert(not exists (select 1 from public.season_awards where season_id = :'season' and kind in ('cl_winner', 'el_winner')), 'Saison 1: keine Europapokalsieger');
select tests.assert((select count(*) from public.fixtures where season_id = :'season' and status not in ('released', 'cancelled')
  and competition_id in (select id from public.competitions where season_id = :'season' and kind::text <> 'friendly')) = 0, 'alle Pflichtspiele freigegeben');
select tests.assert(not exists (select 1 from public.competitions c where c.season_id = :'season2' and c.kind = 'league'
  and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18), 'jede neue Liga hat 18 Vereine');
select tests.assert((select count(distinct e.club_id) from public.competition_entries e join public.competitions c on c.id = e.competition_id
  where c.season_id = :'season2' and c.kind = 'league') = 54, '54 verschiedene Vereine');
select tests.assert((select count(*) from public.fd_table(:'bl2') t join public.competition_entries e on e.club_id = t.club_id
  join public.competitions c on c.id = e.competition_id where c.season_id = :'season2' and c.tier = 1 and t.pos <= 2) = 2, 'Platz 1 und 2 der 2. Liga steigen auf');
select tests.assert((select count(*) from public.fd_table(:'bl') t join public.competition_entries e on e.club_id = t.club_id
  join public.competitions c on c.id = e.competition_id where c.season_id = :'season2' and c.tier = 2 and t.pos >= 17) = 2, 'Platz 17 und 18 der Bundesliga steigen ab');
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id join public.competitions c on c.id = st.competition_id
  where c.season_id = :'season' and c.kind = 'relegation' and t.winner_club_id is not null) = 2, 'zwei Relegationen entschieden');
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id
  where st.kind = 'final' and t.winner_club_id is not null and st.competition_id = (select id from public.competitions where season_id = :'season' and kind = 'domestic_cup')) = 1, 'Pokalsieger ermittelt');
select tests.assert((select count(*) from public.clubs where world_id = :'world' and amateur) = 10, 'weiterhin 10 Amateurvereine');
select tests.assert(exists (select 1 from public.financial_transactions where club_id = :'host_club' and kind = 'placement_prize'), 'Platzierungsprämie gezahlt');
select tests.assert((select avg(age) from public.players where club_id = :'host_club') > :age_before - 1.5, 'Alter fortgeschrieben');
select tests.assert((select count(*) from public.financial_transactions where world_id = :'world' and idempotency_key like 'season:' || :'season' || ':placement:%') = 54, 'Prämien genau einmal je Verein');

-- Vorbereitung Saison 2: Stadionausbau möglich, erneute Bereitschaft startet die Saison
set role authenticated;
select tests.login(:'host');
select tests.assert((public.expand_stadium(:'world') ->> 'capacity')::int > 0, 'Stadionausbau in der Vorbereitung');
select public.force_start_season(:'world');
reset role;
select tests.assert((select status from public.career_worlds where id = :'world') = 'season', 'Saison 2 läuft');
select tests.assert((select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season2' and c.kind = 'league') = 918, 'Saison 2: 918 Ligaspiele');
select tests.assert((select count(*) from public.season_slots where season_id = :'season2' and kind = 'europe') = 13, 'Saison 2: 13 Europapokal-Termine (6 Gruppe, AF/VF/HF je 2, Finale)');
select tests.assert(exists (select 1 from public.competitions c where c.season_id = :'season2' and c.kind::text = 'champions_league'), 'Saison 2: Europapokal angelegt');
-- Qualifikation aus der abgeschlossenen Saison 1: Platz 1–4 CL, 5–6 EL, Pokalsieger EL (bzw. Nachrücker)
select tests.assert((select count(*) from public.ec_qualifications q join public.fd_table(:'bl') t on t.club_id = q.club_id
  where q.season_id = :'season2' and q.competition = 'cl' and t.pos <= 4) = 4, 'Saison 2: Bundesliga-Platz 1–4 in der Champions League');
select tests.assert((select count(*) from public.ec_qualifications q join public.fd_table(:'bl') t on t.club_id = q.club_id
  where q.season_id = :'season2' and q.competition = 'el' and t.pos in (5, 6)) = 2, 'Saison 2: Bundesliga-Platz 5 und 6 in der Europa League');
\echo 'OK 50_season Saison 2 Europapokal'
\echo 'OK 50_season'
