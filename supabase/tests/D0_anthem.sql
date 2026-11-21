-- Einlauf: Länge der Heimhymne speichern (bestimmt die Einlaufdauer) und im Match-Setup ausliefern
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
begin;
insert into storage.objects(bucket_id, name) values ('club-audio', :'world' || '/' || :'host_club' || '/hymne-lang.mp3');
set role authenticated;
select tests.login(:'host');
select public.save_club_audio(:'world', null, jsonb_build_object('kind', 'anthem', 'name', 'Lange Hymne', 'storage_path', :'world' || '/' || :'host_club' || '/hymne-lang.mp3')) as aid \gset
select public.set_club_audio_duration(:'aid', 187.456);
select tests.expect_error(format($$ select public.set_club_audio_duration(%L, 2000) $$, :'aid'), 'invalid');
select tests.login(:'guest');
select tests.expect_error(format($$ select public.set_club_audio_duration(%L, 60) $$, :'aid'), 'not_found');
reset role;
select tests.assert((select duration_sec from public.club_audio where id = :'aid') = 187.46, 'Hymnenlänge gespeichert');
update public.club_audio set is_official = (id = :'aid') where club_id = :'host_club' and kind = 'anthem';
select f.id as fx from public.fixtures f where f.home_club_id = :'host_club' order by f.scheduled_date desc limit 1 \gset
select tests.assert((public.fd_fan_view(:'fx') -> 'audio' -> 'anthem' ->> 'duration')::numeric = 187.46, 'Match-Setup liefert die Hymnenlänge (Einlauf = volle Länge)');
rollback;
\echo 'OK D0_anthem'
