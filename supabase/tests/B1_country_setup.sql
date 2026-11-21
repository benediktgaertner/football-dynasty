-- Welterstellung mit Spielland und Startliga: Lobby mit zwei bereiten Managern
-- Variablen: country, tier, tag (eine Hex-Ziffer für eindeutige Test-Benutzer)
\set ON_ERROR_STOP on
\set QUIET on
select ('00000000-0000-0000-0000-0000000000' || :'tag' || 'd') as u1, ('00000000-0000-0000-0000-0000000000' || :'tag' || 'e') as u2 \gset
insert into auth.users(id) values (:'u1'), (:'u2') on conflict do nothing;
set role authenticated;
select tests.login(:'u1');
select public.set_username('Land' || :'tag' || 'a') is not null;
select tests.login(:'u2');
select public.set_username('Land' || :'tag' || 'b') is not null;
select tests.login(:'u1');
-- zuerst Deutschland, dann in der Lobby auf Land/Startliga wechseln (Host-RPC)
select (public.create_world('Länderwelt ' || :'country', 'medium') ->> 'world_id') as w \gset
select (select invite_code from public.career_worlds where id = :'w') as code \gset
select public.upsert_my_club(:'w', tests.club_payload('Heim ' || :'tag', 'H' || upper(:'tag') || 'M', 20000));
select public.set_ready(:'w', true);
select tests.login(:'u2');
select public.join_world(:'code');
select tests.expect_error(format($$ select public.set_world_setup(%L, %L, %s) $$, :'w', :'country', :'tier'), 'host_only');
select public.upsert_my_club(:'w', tests.club_payload('Gast ' || :'tag', 'G' || upper(:'tag') || 'S', 15000));
select public.set_ready(:'w', true);
select tests.login(:'u1');
select tests.expect_error(format($$ select public.set_world_setup(%L, 'XXX', 1) $$, :'w'), 'invalid_country');
select tests.expect_error(format($$ select public.set_world_setup(%L, 'GER', 4) $$, :'w'), 'invalid_start_tier');
select public.set_world_setup(:'w', :'country', (:'tier')::int);
select tests.assert(not exists (select 1 from public.multiplayer_readiness where world_id = :'w' and context = 'lobby' and ready), 'Wechsel von Land/Liga hebt Bereitschaft auf');
select tests.assert((public.lobby_state(:'w') -> 'world' ->> 'country_code') = :'country', 'Lobby zeigt das Spielland');
select tests.assert((public.lobby_state(:'w') -> 'world' ->> 'start_tier')::int = (:'tier')::int, 'Lobby zeigt die Startliga');
select public.set_ready(:'w', true);
select tests.login(:'u2');
select public.set_ready(:'w', true);
reset role;
select tests.assert((select count(*) from public.clubs where world_id = :'w' and control = 'human' and association_code = :'country') = 2, 'Vereine der Manager gehören zum Spielland');
\echo 'OK B1_country_setup'
