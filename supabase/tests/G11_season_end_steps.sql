-- G11: Saisonwechsel in Schritten (Migration 0048). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
select current_season_id as season from public.career_worlds where id = :'world' \gset
begin;
do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if; end $$;
create function pg_temp.begin_wrapper(w uuid) returns void language sql security definer as $$ select public.fd_begin_slot(w) $$;
grant execute on function pg_temp.begin_wrapper(uuid) to public;
update public.career_worlds set current_slot = (select ordinal from public.season_slots where season_id = :'season' and kind = 'season_end') where id = :'world';
update public.season_slots set state = 'pending' where season_id = :'season' and kind = 'season_end';
select count(*) as n_clubs from public.clubs where world_id = :'world' \gset

-- Aus dem Spiel (PostgREST, session_user = authenticator): nur Auftrag anlegen, kein Rechnen
set session authorization authenticator;
select pg_temp.begin_wrapper(:'world');
reset session authorization;
select tests.assert((select state from public.season_slots where season_id = :'season' and kind = 'season_end') = 'live', 'Termin Saisonende läuft');
select tests.assert((select status from public.career_worlds where id = :'world') <> 'preseason' and (select current_season_id from public.career_worlds where id = :'world') = :'season', 'Saisonwechsel wurde nicht inline ausgeführt');
select tests.assert(exists (select 1 from public.season_end_jobs where world_id = :'world' and season_id = :'season' and step = 0 and done_at is null), 'Auftrag angelegt (Schritt 0)');
-- Der Sweep meldet „noch Arbeit“ und führt genau einen Schritt aus
select public.admin_sweep_world(:'world') ->> 'aging_left' as left1 \gset
select tests.assert(:left1 = '1', 'Sweep: Saisonwechsel noch nicht fertig');
select tests.assert((select step from public.season_end_jobs where world_id = :'world' and season_id = :'season') = 1, 'Sweep führte genau einen Schritt aus');
select tests.assert((select new_season_id from public.season_end_jobs where world_id = :'world' and season_id = :'season') is not null and exists (select 1 from public.seasons where id = (select new_season_id from public.season_end_jobs where world_id = :'world' and season_id = :'season') and year = (select year + 1 from public.seasons where id = :'season')), 'Schritt 0 legte die neue Saison an');
select tests.assert((select current_season_id from public.career_worlds where id = :'world') = :'season', 'Welt bleibt bis Schritt 4 in der alten Saison');
-- Restliche Schritte einzeln
select public.fd_season_end_step(:'world');   -- 1
select public.fd_season_end_step(:'world');   -- 2
select public.fd_season_end_step(:'world');   -- 3
select tests.assert((select status from public.career_worlds where id = :'world') <> 'preseason', 'vor Schritt 4 noch Saison');
select public.fd_season_end_step(:'world');   -- 4
select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason' and (select current_season_id from public.career_worlds where id = :'world') <> :'season', 'Schritt 4: neue Saison aktiv');
select tests.assert(exists (select 1 from public.season_end_jobs where world_id = :'world' and done_at is null), 'Auftrag noch offen (Jugend, Aufräumen folgen)');
select tests.assert((select count(*) from public.competition_entries e join public.competitions c on c.id = e.competition_id where c.season_id = (select current_season_id from public.career_worlds where id = :'world') and c.kind = 'league') > 0, 'neue Ligen haben Teilnehmer');
select public.fd_season_end_step(:'world');   -- 5
select (public.fd_season_end_step(:'world') ->> 'done')::boolean as fin \gset
select tests.assert((:'fin')::boolean, 'letzter Schritt meldet fertig');
select tests.assert(not exists (select 1 from public.season_end_jobs where world_id = :'world' and done_at is null), 'kein offener Auftrag');
select tests.assert((public.fd_season_end_step(:'world') ->> 'done')::boolean, 'weiterer Aufruf ist wirkungslos');
select tests.assert(public.admin_sweep_world(:'world') ->> 'aging_left' = '0', 'Sweep: nichts mehr zu tun');
select tests.assert(not exists (select 1 from public.players where world_id = :'world' and club_id is not null and not retired and age > 45), 'Alterung angewandt');
select tests.assert((select count(*) from public.clubs where world_id = :'world') = :n_clubs, 'Vereinsanzahl unverändert');

-- Fehlerpfad: der Sweep zählt Fehlversuche, wiederholt aber nicht endlos
rollback;
begin;
update public.career_worlds set current_slot = (select ordinal from public.season_slots where season_id = :'season' and kind = 'season_end') where id = :'world';
update public.season_slots set state = 'live' where season_id = :'season' and kind = 'season_end';
insert into public.season_end_jobs(world_id, season_id, attempts, error) values (:'world', :'season', 5, 'x');
select tests.assert(public.admin_sweep_world(:'world') ->> 'aging_left' = '0', 'nach 5 Fehlversuchen keine automatische Wiederholung');
select tests.assert(not exists (select 1 from public.admin_due_worlds() w where w = :'world' and false), 'admin_due_worlds läuft');
rollback;
\echo 'OK G11'
