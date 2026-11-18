-- Phase 3: Vorbereitung einer Welt mit zwei bereiten Managern (wird vor 21_draft.sql ausgeführt)
\set ON_ERROR_STOP on
insert into auth.users(id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.set_username('Hosti') is not null;
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.set_username('Gasti') is not null;
select tests.login('00000000-0000-0000-0000-0000000000c1');
select public.set_username('Zaungast') is not null;

select tests.login('00000000-0000-0000-0000-0000000000a1');
select (public.create_world('Draftwelt') ->> 'invite_code') as code \gset
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.join_world(:'code');
select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.upsert_my_club((select world_id from public.my_worlds() limit 1), tests.club_payload('Test', 'TES', 30000));
select public.set_ready((select world_id from public.my_worlds() limit 1), true);
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.upsert_my_club((select world_id from public.my_worlds() limit 1), tests.club_payload('Würzburger Kickers Neu', 'WKN', 50000));
reset role;
