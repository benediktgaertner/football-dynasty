-- Saisonaler Free-Agent-Markt (Migration 0038): begrenzte Zahl neuer FA, nie über 82 OVR, plausible Verteilung,
-- Pool wächst nicht unkontrolliert, bestehende Verpflichtungen unverändert, Zweitligist vs. Erstligist.
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select current_season_id as season from public.career_worlds where id = :'world' \gset
select year as year from public.seasons where id = :'season' \gset
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
begin;
-- Nutzenmodell: starke Spieler sind für tiefere Ligen deutlich teurer
select tests.assert(public.fd_fa_elite_penalty(82, 2) = 10 and public.fd_fa_elite_penalty(82, 3) = 20 and public.fd_fa_elite_penalty(70, 3) = 0 and public.fd_fa_elite_penalty(76, 2) = 0, 'Elite-Abzug: ab 76 OVR, je Liga unter der ersten');
update public.transfer_windows set next_matchday_from = 1, next_matchday_to = 34 where season_id = :'season' and window_no = 2;
-- Vergleich über die Ligen statt zweier Einzelvereine (nach 0039 hängt die Einsatzchance bei einem einzelnen Spitzenklub
-- stark vom Kader ab): 20 vereinslose Spieler als 25-jährige zentrale Mittelfeldspieler, Durchschnittsnutzen aller
-- KI-Vereine der 1. bzw. 2. Liga, gleiches Gehalt und gleiche Laufzeit ⇒ Gehaltsfaktor, den die 2. Liga zum Gleichziehen braucht.
create temp table g3_fa on commit drop as
  select f.player_id from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = :'world' and p.club_id is null order by p.id limit 20;
update public.free_agents set annual_salary = 1000000, min_club_reputation = 0 where player_id in (select player_id from g3_fa);
create temp table g3_l on commit drop as
  select co.tier, e.club_id from public.competition_entries e join public.competitions co on co.id = e.competition_id join public.clubs c on c.id = e.club_id
  where co.season_id = :'season' and co.kind = 'league' and co.tier in (1, 2) and c.control = 'ai';
create or replace function pg_temp.g3_ratio() returns table(avg_f numeric, min_f numeric) language sql as $f$
  with r as (select f.player_id,
      (select avg(public.fd_fa_utility(f.player_id, l.club_id, 1000000, 3)) from g3_l l where l.tier = 1) ua,
      (select avg(public.fd_fa_utility(f.player_id, l.club_id, 1000000, 3)) from g3_l l where l.tier = 2) ub,
      public.fd_fa_money_pref(f.player_id, 25) m from g3_fa f)
  select round(avg(exp((ua - ub) / (40 * m))), 2), round(min(exp((ua - ub) / (40 * m))), 2) from r;
$f$;
update public.players set overall = 82, age = 25, main_position = 'CM' where id in (select player_id from g3_fa);
select avg_f as ratio82, min_f as min82 from pg_temp.g3_ratio() \gset
update public.players set overall = 70 where id in (select player_id from g3_fa);
select avg_f as ratio70 from pg_temp.g3_ratio() \gset
select tests.assert(:ratio82 >= 1.5, 'Zweitligist braucht für einen 82er im Schnitt mindestens +50 % Gehalt (Faktor ' || :ratio82 || ')');
select tests.assert(:min82 >= 1.25, 'auch im ungünstigsten Fall mindestens +25 % (Faktor ' || :min82 || ')');
select tests.assert(:ratio82 > :ratio70, 'Abstand bei 82 OVR größer als bei 70 OVR (' || :ratio82 || ' vs. ' || :ratio70 || ')');

-- Kappung: großer Pool ⇒ keine neuen Free Agents
select public.fd_fa_market_cap(:'world') as cap \gset
select tests.assert(:cap between 8 and 40, 'Obergrenze neuer Free Agents je Saison: ' || :cap);

-- Verteilung der Auswahl (200 simulierte Saisons über dieselben Gewichte): häufig > gelegentlich > selten > extrem selten, nie > 82
create temporary table fd_g3_cand on commit drop as
select p.id, p.overall from public.players p join public.clubs c on c.id = p.club_id where p.world_id = :'world' and c.control = 'ai' and not p.temporary and p.overall <= 82;
create temporary table fd_g3_sim on commit drop as
select s, b, count(*) n from (
  select s, case when overall < 55 then 'lt55' when overall <= 72 then 'a' when overall <= 77 then 'b' when overall <= 80 then 'c' else 'd' end b
  from (select s, c.overall, row_number() over (partition by s order by public.fd_fa_race_key(c.id, 'sim' || s, c.overall)) rn
        from generate_series(1, 200) s cross join fd_g3_cand c where c.overall >= 40) x where rn <= :cap) y group by s, b;
select coalesce(sum(n) filter (where b = 'a'), 0) as na, coalesce(sum(n) filter (where b = 'b'), 0) as nb, coalesce(sum(n) filter (where b = 'c'), 0) as nc,
       coalesce(sum(n) filter (where b = 'd'), 0) as nd, sum(n) as nt from fd_g3_sim \gset
select tests.assert(:na > :nb and :nb > :nc and :nc >= :nd, 'Verteilung: 55–72 (' || :na || ') > 73–77 (' || :nb || ') > 78–80 (' || :nc || ') ≥ 81–82 (' || :nd || ')');
select tests.assert(:na::numeric / :nt >= 0.6 and :nd::numeric / :nt <= 0.01, 'häufig 55–72 (≥ 60 %), 81–82 extrem selten (≤ 1 %)');

-- Welt in den Saisonabschluss, einige starke KI-Spieler laufen aus (müssen bleiben)
update public.career_worlds set current_slot = (select ordinal from public.season_slots where season_id = :'season' and kind = 'season_end') where id = :'world';
create temporary table fd_g3_elite on commit drop as
select pc.player_id from public.player_contracts pc join public.players p on p.id = pc.player_id join public.clubs c on c.id = p.club_id
where pc.world_id = :'world' and pc.active and c.control = 'ai' and pc.end_season_year <= :year and p.overall between 60 and 80
  and p.age <= 30 and not p.temporary -- keine Karriereenden, keine temporären Ersatzspieler (werden zum Saisonende entfernt)
order by pc.player_id limit 15;
update public.players set overall = 88 where id in (select player_id from fd_g3_elite);
-- Snapshots vorher
select count(*) as fa_before from public.free_agents where world_id = :'world' \gset
select md5(string_agg(f.player_id::text || ':' || f.annual_salary, ',' order by f.player_id)) as fa_hash from public.free_agents f where f.world_id = :'world' \gset
create temporary table fd_g3_ct on commit drop as select pc.id, pc.player_id, pc.club_id, pc.annual_salary, pc.end_season_year from public.player_contracts pc
  where pc.world_id = :'world' and pc.active and pc.end_season_year > :year;
select count(*) as signed_before from public.transfers where world_id = :'world' and kind = 'free_agent' \gset
select count(*) as players_before from public.players where world_id = :'world' \gset

select tests.assert((select count(*) from fd_g3_elite) >= 8, 'genug auslaufende Testspieler vorhanden (' || (select count(*) from fd_g3_elite) || ')');
select public.fd_begin_slot(:'world');
select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason', 'Saisonwechsel durchgeführt');
select count(*) as new_fa from public.fd_fa_market_players where season_id = :'season' \gset
select tests.assert(:new_fa > 0, 'nach dem Saisonwechsel gibt es neue Free Agents (' || :new_fa || ')');
select tests.assert(:new_fa <= :cap and :new_fa <= 40, 'begrenzte Zahl neuer Free Agents (' || :new_fa || ' ≤ ' || :cap || ')');
select tests.assert((select count(*) from public.free_agents where world_id = :'world') - :fa_before = :new_fa, 'Pool wächst genau um die neuen Free Agents');
select tests.assert(not exists (select 1 from public.fd_fa_market_players m where m.overall > 82) and not exists (
  select 1 from public.fd_fa_market_players m join public.players p on p.id = m.player_id where m.season_id = :'season' and p.overall > 82), 'kein neuer Free Agent über 82 OVR');
select tests.assert(not exists (select 1 from fd_g3_elite e join public.players p on p.id = e.player_id where p.club_id is null)
  and not exists (select 1 from fd_g3_elite e join public.free_agents f on f.player_id = e.player_id), 'auslaufende Spieler über 82 OVR verlängern immer (kein Free Agent)');
select tests.assert(not exists (select 1 from fd_g3_elite e join public.player_contracts pc on pc.player_id = e.player_id and pc.active where pc.end_season_year <= :year)
  and (select count(*) from fd_g3_elite e join public.player_contracts pc on pc.player_id = e.player_id and pc.active) = (select count(*) from fd_g3_elite), 'alle ' || (select count(*) from fd_g3_elite) || ' haben einen neuen aktiven Vertrag ' || coalesce((select string_agg(p.age || 'J/' || p.overall || '/ret=' || p.retired || '/tmp=' || p.temporary || '/club=' || coalesce(p.club_id::text, 'null') || '/ct=' || (select count(*) from public.player_contracts q where q.player_id = e.player_id and q.active) || '/end=' || coalesce((select max(q.end_season_year) from public.player_contracts q where q.player_id = e.player_id and q.active)::text, '-'), '; ') from fd_g3_elite e join public.players p on p.id = e.player_id where not exists (select 1 from public.player_contracts q where q.player_id = e.player_id and q.active and q.end_season_year > :year)), '') || ' | abgelaufen: ' || coalesce((select string_agg(p.age || 'J/ovr' || p.overall || '/end' || q.end_season_year || '/y' || :year || '/club=' || coalesce(p.club_id::text,'null'), '; ') from fd_g3_elite e join public.players p on p.id = e.player_id join public.player_contracts q on q.player_id = e.player_id and q.active where q.end_season_year <= :year), '-'));
select tests.assert(not exists (select 1 from public.fd_fa_market_players m join public.players p on p.id = m.player_id where m.season_id = :'season' and p.club_id is not null), 'neue Free Agents sind vereinslos');
select tests.assert(not exists (select 1 from public.fd_fa_market_players m join public.free_agents f on f.player_id = m.player_id where m.season_id = :'season' group by m.season_id, m.player_id having count(*) > 1)
  and (select count(*) from public.fd_fa_market_players m join public.free_agents f on f.player_id = m.player_id where m.season_id = :'season') = :new_fa, 'jeder neue Free Agent genau einmal im Pool');
select tests.assert(not exists (select 1 from public.fd_fa_market_players m join public.players p on p.id = m.player_id where m.season_id = :'season' and m.overall < 40), 'plausible Stärken');
select count(*) filter (where overall between 55 and 72) as c1, count(*) filter (where overall between 73 and 77) as c2, count(*) filter (where overall >= 78) as c3 from public.fd_fa_market_players where season_id = :'season' \gset
select tests.assert(:c1 >= :c2 and :c3 <= 3, 'Verteilung der neuen Free Agents plausibel (55–72: ' || :c1 || ', 73–77: ' || :c2 || ', 78+: ' || :c3 || ')');
-- Bestehendes bleibt unverändert
select tests.assert((select md5(string_agg(f.player_id::text || ':' || f.annual_salary, ',' order by f.player_id)) from public.free_agents f
  where f.world_id = :'world' and not exists (select 1 from public.fd_fa_market_players m where m.player_id = f.player_id and m.season_id = :'season')) = :'fa_hash', 'bisherige Free Agents unverändert');
select tests.assert(not exists (select 1 from fd_g3_ct b join public.players p on p.id = b.player_id
  left join public.player_contracts pc on pc.id = b.id and pc.active and pc.club_id = b.club_id and pc.annual_salary = b.annual_salary and pc.end_season_year = b.end_season_year
  where pc.id is null and p.club_id is not null), 'laufende Verträge (bereits Verpflichtete) unverändert');
select tests.assert((select count(*) from public.transfers where world_id = :'world' and kind = 'free_agent') = :signed_before, 'bestehende Verpflichtungen unverändert');
select tests.assert((select count(*) from public.players where world_id = :'world') <= :players_before, 'Spielerpool wächst nicht (keine neuen Spieler)');
-- Neue Free Agents sind im Free-Agent-Prozess nutzbar (Vorbereitung: Fenster 1 offen)
select m.player_id as nfa from public.fd_fa_market_players m where m.season_id = :'season' order by m.player_id limit 1 \gset
update public.finances set balance = 400000000 where club_id = :'host_club';
delete from public.transfers where season_id = (select current_season_id from public.career_worlds where id = :'world') and kind = 'free_agent' and to_club_id = :'host_club';
set role authenticated;
select tests.login(:'host');
select tests.assert((public.fa_negotiation(:'nfa') ->> 'available')::boolean, 'neuer Free Agent ist verhandelbar');
select public.fa_offer(:'nfa', (select (public.fa_negotiation(:'nfa') ->> 'ask')::bigint), 3) is not null as offered \gset
select tests.assert(:'offered' = 't', 'Angebot an neuen Free Agent möglich');
reset role;
rollback;
\echo 'OK G3_free_agents'
