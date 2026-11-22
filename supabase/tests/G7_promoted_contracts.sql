-- G7: Aufsteigende Amateurvereine erhalten Verträge (Migration 0042, Audit-Regressionstest)
\set ON_ERROR_STOP on
\set QUIET on
begin;
select c.id as club from public.clubs c where c.world_id = :'world' and c.control = 'ai' and not c.amateur
  and (select count(*) from public.players p where p.club_id = c.id and not p.temporary and not p.retired) >= 16 order by c.id limit 1 \gset
select count(*) as n_players from public.players where club_id = :'club' and not temporary and not retired \gset
-- Verein wird Amateur (Verträge weg, wie in Produktion) und steigt dann auf
update public.clubs set amateur = true where id = :'club';
delete from public.player_contracts where club_id = :'club';
select tests.assert(not exists (select 1 from public.player_contracts where club_id = :'club' and active), 'Amateurverein ohne Verträge (Ausgangslage)');
update public.clubs set amateur = false where id = :'club';
select tests.assert((select count(*) from public.player_contracts where club_id = :'club' and active) = :n_players, 'Aufstieg: jeder Spieler erhält genau einen aktiven Vertrag');
select tests.assert(not exists (select 1 from public.player_contracts where club_id = :'club' and (annual_salary <= 0 or end_season_year <= start_season_year)), 'Verträge plausibel (Gehalt > 0, Laufzeit 2 Jahre)');
-- Idempotenz: erneutes Setzen ändert nichts
select md5(string_agg(id::text, ',' order by id)) as h1 from public.player_contracts where club_id = :'club' \gset
update public.clubs set amateur = true where id = :'club';
update public.clubs set amateur = false where id = :'club';
select tests.assert((select md5(string_agg(id::text, ',' order by id)) from public.player_contracts where club_id = :'club') = :'h1', 'Idempotent: bestehende Verträge bleiben unverändert');
rollback;
\echo 'OK G7'
