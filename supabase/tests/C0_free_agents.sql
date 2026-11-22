-- Free-Agent-Verhandlungen: Barometer (kalibriert), Konkurrenz Erstligist vs. finanzstarker Zweitligist,
-- garantierte Entscheidung, KI-Angebote, Budget/Limit, Vertraulichkeit. Alles in einer Transaktion (zurückgerollt).
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select current_season_id as season from public.career_worlds where id = :'world' \gset
begin;
-- Transferfenster für den Test öffnen
update public.transfer_windows set next_matchday_from = 1, next_matchday_to = 34 where season_id = :'season' and window_no = 2;
select tests.assert((public.fd_open_window(:'world')).id is not null, 'Transferfenster offen (Test)');
delete from public.fa_applications where world_id = :'world' and status = 'pending';
update public.free_agents set decision_on = null, first_interest_on = null where world_id = :'world';

-- Vereine: A = sportlich attraktiver Erstligist, B = finanzstarker Zweitligist, C = schwacher Drittligist
select e.club_id as club_a from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
  join public.fd_table(co.id) t on t.club_id = e.club_id where co.season_id = :'season' and co.kind = 'league' and co.tier = 1 and c.control = 'ai' order by t.pos limit 1 \gset
select e.club_id as club_b from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
  join public.fd_table(co.id) t on t.club_id = e.club_id where co.season_id = :'season' and co.kind = 'league' and co.tier = 2 and c.control = 'ai' order by t.pos limit 1 \gset
select e.club_id as club_c from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
  join public.fd_table(co.id) t on t.club_id = e.club_id where co.season_id = :'season' and co.kind = 'league' and co.tier = 3 and c.control = 'ai' order by t.pos desc limit 1 \gset
update public.clubs set reputation = 82 where id = :'club_a';
update public.clubs set reputation = 45 where id = :'club_b';
update public.clubs set reputation = 5 where id = :'club_c';
update public.finances set balance = 400000000 where club_id in (:'club_a', :'club_b', :'club_c');
delete from public.transfers where to_club_id in (:'club_a', :'club_b', :'club_c') and season_id = :'season';

-- Spieler: 25 Jahre, ZM, OVR 84, Forderung 850.000 €
select f.player_id as fa from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = :'world' and p.club_id is null order by p.id limit 1 \gset
select f.player_id as fa2 from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = :'world' and p.club_id is null and f.player_id <> :'fa' order by p.id limit 1 \gset
update public.players set overall = 84, age = 25, main_position = 'CM' where id in (:'fa', :'fa2');
-- gleiche Einsatzchance bei beiden Vereinen (kein besserer Mittelfeldspieler)
update public.players set overall = least(overall, 83) where club_id in (:'club_a', :'club_b') and public.fd_pos_group(main_position::text) = 'MID';
update public.free_agents set annual_salary = 850000, min_club_reputation = 0 where player_id in (:'fa', :'fa2');

-- 1) Erstligist mit 70 % der Forderung schlägt Zweitligist mit 100 %
select public.fd_fa_apply(:'fa', :'club_a', 3, 595000);
select public.fd_fa_apply(:'fa', :'club_b', 3, 850000);
select tests.assert((select prob from public.fd_fa_board(:'fa') where club_id = :'club_a') > (select prob from public.fd_fa_board(:'fa') where club_id = :'club_b'),
  'sportlich attraktiver Erstligist überzeugt mit weniger Gehalt (A ' || (select round(prob * 100) from public.fd_fa_board(:'fa') where club_id = :'club_a')
  || ' vs. B ' || (select round(prob * 100) from public.fd_fa_board(:'fa') where club_id = :'club_b') || ')');
-- Zweitligist muss deutlich mehr zahlen: bei 125 % des Erstliga-Gehalts noch unterlegen
select tests.assert(public.fd_fa_utility(:'fa', :'club_a', 595000, 3) > public.fd_fa_utility(:'fa', :'club_b', round(595000 * 1.25)::bigint, 3), 'Zweitligist braucht deutlich mehr als +25 % Gehalt');
-- 2) Zweitligist erhöht massiv (250 % der Forderung, Obergrenze) ⇒ liegt vorn
update public.fa_applications set annual_salary = 2125000 where player_id = :'fa' and club_id = :'club_b';
select public.fd_fa_refresh(:'fa');
select tests.assert((select prob from public.fd_fa_board(:'fa') where club_id = :'club_b') > (select prob from public.fd_fa_board(:'fa') where club_id = :'club_a'),
  'finanzstarker Zweitligist gleicht mit deutlich höherem Gehalt aus (B ' || (select round(prob * 100) from public.fd_fa_board(:'fa') where club_id = :'club_b')
  || ', Nutzen A ' || public.fd_fa_utility(:'fa', :'club_a', 595000, 3) || ' / B ' || public.fd_fa_utility(:'fa', :'club_b', 2125000, 3) || ')');
select tests.assert((select sum(prob) from public.fd_fa_board(:'fa')) <= 1.0001, 'Barometer zusammen höchstens 100');

-- 3) Kalibrierung: Zufallsentscheidung nach demselben Modell (5000 Ziehungen) ≈ Barometer
select array_agg(utility order by created_at) as u from public.fa_applications a where a.player_id = :'fa' and a.status = 'pending' \gset
select tests.assert(not exists (
  select 1 from (select x, count(*)::numeric / 5000 fr from (select public.fd_fa_draw(:'u'::numeric[], public.fd_fa_mu(84, 25)) x from generate_series(1, 5000)) q where x is not null group by x) s
  join (select ordinality i, p from unnest(public.fd_fa_probs(:'u'::numeric[], public.fd_fa_mu(84, 25))) with ordinality p) pr on pr.i = s.x
  where abs(s.fr - pr.p) > 0.03), 'Barometer ist kalibriert (Häufigkeit ≈ Wahrscheinlichkeit)');

-- 4) Entscheidung nach Ablauf: bei akzeptablem Angebot unterschreibt er garantiert
update public.fa_applications set annual_salary = 2125000 where player_id = :'fa' and club_id = :'club_b';
select public.fd_fa_refresh(:'fa');
select tests.assert((select sum(prob) from public.fd_fa_board(:'fa')) > 0.99, 'mindestens ein sehr gutes Angebot (Summe > 99 %)');
update public.free_agents set decision_on = public.fd_world_date(:'world') where player_id = :'fa';
select public.fd_fa_process(:'world');
select tests.assert((select club_id from public.players where id = :'fa') in (:'club_a', :'club_b'), 'Spieler hat sich für einen Interessenten entschieden');
select tests.assert((select count(*) from public.fa_applications where player_id = :'fa' and status = 'signed') = 1
  and (select count(*) from public.fa_applications where player_id = :'fa' and status = 'lost') = 1, 'ein Zuschlag, eine Absage');
select tests.assert((select pc.annual_salary from public.player_contracts pc where pc.player_id = :'fa' and pc.active) =
  (select a.annual_salary from public.fa_applications a where a.player_id = :'fa' and a.status = 'signed'), 'Vertrag mit dem angebotenen Gehalt');

-- 5) Nur unzureichende Angebote ⇒ bleibt vereinslos
select public.fd_fa_apply(:'fa2', :'club_c', 1, 340000);
select tests.assert((select prob from public.fd_fa_board(:'fa2')) < 0.01, 'schlechtes Angebot: Barometer ≈ 0 (' || (select round(prob * 100, 2) from public.fd_fa_board(:'fa2')) || ')');
update public.free_agents set decision_on = public.fd_world_date(:'world') where player_id = :'fa2';
select public.fd_fa_process(:'world');
select tests.assert((select club_id from public.players where id = :'fa2') is null, 'unzureichendes Angebot ⇒ bleibt vereinslos');
select tests.assert((select note from public.fa_applications where player_id = :'fa2' order by created_at desc limit 1) like 'Kein Angebot%', 'Begründung gespeichert');

-- 6) Budget: Angebot über dem Kontostand wird abgelehnt
update public.finances set balance = 100000 where club_id = :'club_c';
select tests.expect_error(format($$ select public.fd_fa_apply(%L, %L, 2, 850000) $$, :'fa2', :'club_c'), 'insufficient_funds');
-- Limit: zwei Free Agents pro Saison
insert into public.transfers(world_id, season_id, player_id, to_club_id, kind) select :'world', :'season', id, :'club_c', 'free_agent' from public.players where world_id = :'world' limit 2;
update public.finances set balance = 400000000 where club_id = :'club_c';
select tests.expect_error(format($$ select public.fd_fa_apply(%L, %L, 2, 850000) $$, :'fa2', :'club_c'), 'fa_limit');

-- 7) Manager: Angebot abgeben und verbessern, Barometer steigt sofort; fremde Angebote vertraulich
select public.fd_fa_apply(:'fa2', :'club_b', 3, 1500000);
update public.finances set balance = 400000000 where club_id = (select id from public.clubs where world_id = :'world' and manager_user_id = :'host');
delete from public.transfers where season_id = :'season' and kind = 'free_agent' and to_club_id = (select id from public.clubs where world_id = :'world' and manager_user_id = :'host');
set role authenticated;
select tests.login(:'host');
-- Angebote relativ zur Forderung (feste Beträge sättigten bei billigen Free Agents beide bei Barometer 100 ⇒ Flake)
reset role;
select greatest(1000, round(annual_salary * 0.4 / 1000) * 1000) as lowo, round(annual_salary * 1.6 / 1000) * 1000 as higho from public.free_agents where player_id = :'fa2' \gset
set role authenticated;
select tests.login(:'host');
select (public.fa_offer(:'fa2', :lowo, 3) -> 'board') as b1 \gset
select (public.fa_offer(:'fa2', :higho, 3) -> 'board') as b2 \gset
-- Barometer: nie schlechter; strikt besser, solange es nicht bei 0 (Spieler will zu diesem Verein grundsätzlich nicht) oder 100 (gesättigt) liegt
select (select (x ->> 'barometer')::int from jsonb_array_elements(:'b1'::jsonb) x where (x ->> 'mine')::boolean) as bar1,
       (select (x ->> 'barometer')::int from jsonb_array_elements(:'b2'::jsonb) x where (x ->> 'mine')::boolean) as bar2 \gset
select tests.assert(:bar2 >= :bar1 and (:bar2 > :bar1 or :bar1 in (0, 100)), 'besseres Angebot ⇒ Barometer nie schlechter, steigt (' || :lowo || ' → ' || :bar1 || ', ' || :higho || ' → ' || :bar2 || ')');
select tests.assert(jsonb_array_length(:'b2'::jsonb) = 2, 'Konkurrenzverein im Ranking sichtbar');
select tests.assert(position('1500000' in public.fa_negotiation(:'fa2')::text) = 0, 'fremdes Gehaltsangebot nicht enthalten');
select tests.assert((public.fa_negotiation(:'fa2') -> 'model') is not null and (public.fa_negotiation(:'fa2') ->> 'days_left')::int between 0 and 7, 'Modell für Live-Vorschau und Restzeit');
select tests.expect_error($$ select annual_salary from public.fa_applications limit 1 $$, 'permission denied');
select tests.expect_error(format($$ select public.fa_offer(%L, 100, 3) $$, :'fa2'), 'invalid_salary');
reset role;

-- 8) KI-Vereine geben regelmäßig Angebote ab (mit Gehalt im Rahmen)
delete from public.world_week_log where world_id = :'world' and job = 'ai_fa';
delete from public.fa_applications a using public.clubs c where c.id = a.club_id and c.control = 'ai' and a.status = 'pending' and a.world_id = :'world';
select public.fd_ai_fa_interest(:'world') as ai_n \gset
select tests.assert(:ai_n > 0, 'KI-Angebote abgegeben (' || :ai_n || ')');
select tests.assert(not exists (select 1 from public.fa_applications a join public.free_agents f on f.player_id = a.player_id join public.clubs c on c.id = a.club_id
  where c.control = 'ai' and a.status = 'pending' and a.world_id = :'world' and (a.annual_salary < f.annual_salary * 0.5 or a.annual_salary > f.annual_salary * 1.6 + 10000)), 'KI-Gehälter im Rahmen 50–160 %');
select tests.assert((select avg(b.prob) from public.fa_applications a join public.clubs c on c.id = a.club_id and c.control = 'ai'
  cross join lateral public.fd_fa_board(a.player_id) b where a.status = 'pending' and a.world_id = :'world' and b.application_id = a.id) > 0.3, 'KI-Angebote sind realistisch (Ø Barometer > 30)');
rollback;
\echo 'OK C0_free_agents'
