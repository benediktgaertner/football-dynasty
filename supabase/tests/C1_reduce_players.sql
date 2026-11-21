-- Internationale Spielerdaten: Spielland + UEFA-Top-20 voll, übrige Länder je Verein die besten elf;
-- Historie geschützt, Mannschaftsstärke erhalten, temporäre Europapokal-Bank nicht transferierbar.
\set ON_ERROR_STOP on
\set QUIET on
select current_season_id as season from public.career_worlds where id = :'world' \gset
select tests.assert(public.fd_full_squad_assoc(:'world', 'GER') and public.fd_full_squad_assoc(:'world', 'ENG') and public.fd_full_squad_assoc(:'world', 'CRO'), 'Spielland und Top 20 mit vollen Kadern');
select tests.assert(not public.fd_full_squad_assoc(:'world', 'MDA') and not public.fd_full_squad_assoc(:'world', 'SMR'), 'Moldau/San Marino reduziert');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code = 'SMR'
  and (select count(*) from public.players p where p.club_id = c.id and not p.temporary and not exists (select 1 from public.transfers t where t.player_id = p.id)) > 11), 'neue kleine Länder: höchstens 11 Spieler je Verein (ohne spätere Zugänge)');
select tests.assert((select min(n) from (select count(*) n from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.association_code = 'MDA' group by c.id) x) = 22, 'Ausgangslage: Moldau mit vollen Kadern');

begin;
create temporary table t_before on commit drop as
  select c.id, c.association_code, public.fd_club_strength(c.id) st, (select count(*) from public.players p where p.club_id = c.id) n
  from public.clubs c where c.world_id = :'world';
-- ein Spieler mit Historie (Transfer) bleibt geschützt
select p.id as hist from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.association_code = 'MDA' order by p.overall limit 1 \gset
insert into public.transfers(world_id, season_id, player_id, to_club_id, kind) select :'world', :'season', :'hist', club_id, 'transfer' from public.players where id = :'hist';
select (public.fd_reduce_world_players(:'world', true) ->> 'removed')::int as dry \gset
select (public.fd_reduce_world_players(:'world') ->> 'removed')::int as removed \gset
select tests.assert(:removed = :dry and :removed > 0, 'Bereinigung entfernt ' || :removed || ' Spieler (Trockenlauf identisch)');
select tests.assert(exists (select 1 from public.players where id = :'hist'), 'Spieler mit Historie geschützt');
select tests.assert(not exists (select 1 from public.clubs c join t_before b on b.id = c.id where c.association_code <> 'MDA' and c.association_code <> 'SMR'
  and (select count(*) from public.players p where p.club_id = c.id) <> b.n), 'Spielland, Top-20 und menschliche Kader unverändert');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code = 'MDA' and not exists (
  select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id where e.club_id = c.id and co.season_id = :'season' and co.kind::text in ('champions_league', 'europa_league'))
  and ((select count(*) from public.players p where p.club_id = c.id and p.main_position = 'GK') < 1
    or (select count(*) from public.players p where p.club_id = c.id) not between 11 and 12)), 'Moldau: elf Spieler mit Torwart (geschützte bleiben zusätzlich)');
select tests.assert((select count(*) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.association_code = 'MDA'
  and public.fd_pos_group(p.main_position::text) = 'DEF') >= 4 * (select count(*) from public.clubs where world_id = :'world' and association_code = 'MDA'), 'je Verein mindestens vier Verteidiger');
select tests.assert((select avg(abs(public.fd_club_strength(b.id) - b.st)) from t_before b where b.association_code = 'MDA') < 0.6,
  'Mannschaftsstärke praktisch unverändert (Ø Abweichung ' || (select round(avg(abs(public.fd_club_strength(b.id) - b.st)), 2) from t_before b where b.association_code = 'MDA') || ')');
select tests.assert((public.fd_reduce_world_players(:'world') ->> 'removed')::int = 0, 'zweiter Lauf entfernt nichts (idempotent)');

-- Temporäre Ersatzbank für Europapokal-Teilnehmer mit kleinem Kader
select c.id as small from public.clubs c where c.world_id = :'world' and c.association_code = 'MDA' order by c.reputation desc limit 1 \gset
select id as clc from public.competitions where season_id = :'season' and kind::text = 'champions_league' \gset
insert into public.competition_entries(competition_id, club_id, world_id) values (:'clc', :'small', :'world') on conflict do nothing;
select public.fd_club_strength(:'small') as st_small \gset
select public.fd_ensure_ec_bench(:'world', :'season');
select tests.assert((select count(*) from public.players where club_id = :'small') >= 16, 'Europapokal: Bank auf 16 Spieler ergänzt');
select tests.assert((select count(*) from public.players where club_id = :'small' and temporary) between 4 and 7, 'Ergänzungsspieler als temporär markiert');
select tests.assert(public.fd_club_strength(:'small') = :st_small, 'Stärke ohne Ergänzungsspieler unverändert');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
select tests.assert(not exists (select 1 from jsonb_array_elements(public.transfer_market_search(:'world', jsonb_build_object('club', :'small'), 100, 0) -> 'rows') r
  join public.players p on p.id = (r ->> 'id')::uuid where p.temporary), 'Ergänzungsspieler nicht auf dem Transfermarkt');
select id as tmp from public.players where club_id = :'small' and temporary limit 1 \gset
select tests.expect_error(format($$ select public.fd_complete_transfer(%L, %L, %L, 0, 100000, 1, null, 'transfer', null) $$, :'tmp', :'small', (select id from public.clubs where world_id = :'world' and association_code = 'ENG' limit 1)), 'not_transferable');
select tests.assert(jsonb_array_length(public.fd_match_team(:'small', current_date, null, :'season') -> 'squad') >= 16, 'Match-Setup mit Ersatzbank');
select public.fd_cleanup_temporary_players(:'world');
select tests.assert(not exists (select 1 from public.players where world_id = :'world' and temporary and club_id is not null), 'Saisonende: Ergänzungsspieler entfernt');
rollback;
\echo 'OK C1_reduce_players'
