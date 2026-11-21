-- Welterstellung je Land und Startliga: Ligen, Skalierung, Draft, Saisonstart (Saison 1 ohne Europapokal)
-- Variablen: world, dir, country, tier
\set ON_ERROR_STOP on
\set QUIET on
select host_user_id as host from public.career_worlds where id = :'world' \gset
select set_config('fd.world', :'world', false);
select pg_read_file(:'dir' || '/payload.json') as payload \gset
select public.starting_capital('medium') as base_capital \gset
select public.fd_capital_factor(:'country', (:'tier')::int) as kf \gset

-- falscher Payload (Deutschland/2. Liga) für ein anderes Spielland wird abgelehnt
select tests.expect_error(format($$ select public.admin_start_draft(%L, %L, %L::jsonb) $$, :'world', :'host', pg_read_file(:'dir' || '/payload_ger.json')), 'invalid_payload');
select tests.assert((public.admin_start_draft(:'world', :'host', :'payload'::jsonb) ->> 'ai_clubs')::int = 52, '52 KI-Vereine angelegt');
select current_season_id as season from public.career_worlds where id = :'world' \gset

select tests.assert((select count(*) from public.competitions where season_id = :'season' and kind = 'league' and association_code = :'country') = 3, 'drei Ligen im Spielland');
select tests.assert(not exists (select 1 from public.competitions c where c.season_id = :'season' and c.kind = 'league'
  and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18), 'jede Liga 18 Vereine');
select tests.assert((select count(*) from public.competition_entries e join public.competitions c on c.id = e.competition_id join public.clubs cl on cl.id = e.club_id
  where c.season_id = :'season' and c.tier = (:'tier')::int and cl.control = 'human') = 2, 'beide Manager starten in der gewählten Liga');
select tests.assert((select name from public.competitions where season_id = :'season' and kind = 'league' and tier = 1) = (select tier1 from public.country_league_names where code = :'country'), 'landestypischer Name der 1. Liga');
select tests.assert(not exists (select 1 from public.clubs where world_id = :'world' and association_code <> :'country'), 'nur Vereine des Spiellands (Ausland folgt als Stammdaten)');
select tests.assert((select economy_factor from public.career_worlds where id = :'world') = public.fd_economy_factor_for(:'country'), 'Wirtschaftsfaktor gespeichert');
select tests.assert(coalesce(array_length((select amateur_names from public.career_worlds where id = :'world'), 1), 0) = case when :'country' = 'GER' then 0 else 30 end, 'Namen für Amateurvereine gespeichert');
select tests.assert((select max(overall) from public.players where world_id = :'world' and in_draft_pool) <= public.fd_draft_pool_max(:'country', (:'tier')::int) + 1, 'Draft-Pool im erlaubten Bereich');
-- Skalierung: Mannschaftsstärke folgt Liga und Land; Startkapital nach Liga und Land
select tests.assert((select avg(public.fd_club_strength(e.club_id)) from public.competition_entries e join public.competitions c on c.id = e.competition_id where c.season_id = :'season' and c.tier = 1 and e.club_id in (select id from public.clubs where control = 'ai'))
  > (select avg(public.fd_club_strength(e.club_id)) from public.competition_entries e join public.competitions c on c.id = e.competition_id where c.season_id = :'season' and c.tier = 3 and e.club_id in (select id from public.clubs where control = 'ai')), '1. Liga stärker als 3. Liga');
select tests.assert((select abs(avg(p.overall) - (74 + public.fd_country_shift(:'country', (:'tier')::int))) from public.players p where p.world_id = :'world' and p.in_draft_pool) < 3, 'Draft-Pool passend zu Startliga und Land skaliert');
select tests.assert((select sum(amount) from public.financial_transactions t join public.clubs c on c.id = t.club_id
  where c.world_id = :'world' and c.control = 'human' and t.kind = 'starting_capital') = 2 * public.fd_scaled(:base_capital, :kf), 'Startkapital skaliert');

-- Draft per Auto-Pick durchlaufen
do $$
declare v_world uuid := current_setting('fd.world')::uuid; v_guard integer := 0;
begin
  update public.world_members set last_seen_at = now() - interval '20 minutes' where world_id = v_world;
  while (select status from public.draft_sessions where world_id = v_world) = 'running' and v_guard < 100 loop
    update public.world_members set last_seen_at = now() - interval '20 minutes' where world_id = v_world;
    perform tests.login((select host_user_id from public.career_worlds where id = v_world));
    perform public.auto_pick_current(v_world);
    v_guard := v_guard + 1;
  end loop;
end $$;
select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason', 'Draft beendet, Vorbereitung');
select tests.assert(not exists (select 1 from public.finances f join public.clubs c on c.id = f.club_id where c.world_id = :'world' and f.balance < 0), 'kein negatives Konto nach dem Draft');

set role authenticated;
select tests.login(:'host');
select public.force_start_season(:'world');
reset role;
select tests.assert((select status from public.career_worlds where id = :'world') = 'season', 'Saison 1 läuft');
select tests.assert((select count(*) from public.season_slots where season_id = :'season') = 43, 'Saison 1: 43 Termine, kein Europapokal');
select tests.assert(not exists (select 1 from public.competitions where season_id = :'season' and kind::text in ('champions_league', 'europa_league')), 'Saison 1: keine Europapokal-Wettbewerbe');
select tests.assert((select name from public.competitions where season_id = :'season' and kind = 'domestic_cup') = (select cup from public.country_league_names where code = :'country'), 'landestypischer Pokalname');
select tests.assert((select count(*) from public.competition_entries e join public.competitions c on c.id = e.competition_id where c.season_id = :'season' and c.kind = 'domestic_cup') = 64, 'Pokal: alle drei Ligen + 10 Amateure');
select tests.assert((select count(*) from public.clubs where world_id = :'world' and amateur and association_code = :'country') = 10, '10 Amateurvereine im Spielland');
select tests.assert(:'country' = 'GER' or (select count(*) from public.clubs c where c.world_id = :'world' and c.amateur and exists (select 1 from public.career_worlds w where w.id = :'world' and c.name = any(w.amateur_names))) = 10, 'landestypische Amateurnamen');
select tests.assert(not exists (select 1 from public.season_slots s where s.season_id = :'season' and s.kind = 'league'
  and (select count(*) from public.fixtures f where f.season_id = :'season' and f.slot_key = s.slot_key) <> 27), '27 Ligaspiele je Spieltag');
select tests.assert((select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id where c.season_id = :'season' and c.kind = 'league') = 918, '918 Ligaspiele (3 × 306)');
select tests.assert(public.fd_active_assocs(:'world') = array[:'country'], 'aktives Land = Spielland');
\echo 'OK B2_country_world'
-- Europapokal-Startplätze des Spiellands (ab Saison 2): mindestens Meister (CL) und Pokalsieger (EL)
select tests.assert((select cl >= 1 and cl <= 5 and cup from public.fd_ec_allocation(:'world', null) where code = :'country'), 'Spielland: 1–5 CL-Plätze, Pokalsieger in der EL');
select tests.assert((select sum(cl) from public.fd_ec_allocation(:'world', null)) <= 32, 'Summe der festen CL-Plätze ≤ 32');
select tests.assert((select max(cl) from public.fd_ec_allocation(:'world', null)) <= 5, 'kein Land mit mehr als 5 CL-Plätzen');
\echo 'OK B2_country_world Europapokal-Plätze'
