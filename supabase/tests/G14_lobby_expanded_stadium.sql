-- Bestehende Stadien über der Neubaugrenze dürfen die Lobby nicht blockieren.
\set ON_ERROR_STOP on
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select c.id as club from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' limit 1 \gset

begin;
update public.stadiums set capacity = 80000 where club_id = :'club';
select tests.login(:'host');
set local role authenticated;
select tests.assert(exists (
  select 1 from jsonb_array_elements(public.lobby_state(:'world')->'members') m
  where m->>'user_id' = :'host' and (m->'club'->>'stadium_capacity')::integer = 80000
), 'Lobby lädt ein ausgebautes Stadion mit 80.000 Plätzen');
reset role;

update public.stadiums set capacity = 50000 where club_id = :'club';
set local role authenticated;
select tests.assert(exists (
  select 1 from jsonb_array_elements(public.lobby_state(:'world')->'members') m
  where m->>'user_id' = :'host' and (m->'club'->>'stadium_cost')::numeric > 0
), 'Lobby zeigt Neubaukosten für ein Stadion mit 50.000 Plätzen');
rollback;
