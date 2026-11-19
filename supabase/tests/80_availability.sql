-- Verletzungen, Sperren, Einsatzberechtigung, Aufstellungsprüfung, Trainingsfortschritt
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select fixture_id as nfx, scheduled_date as ndate, scope as nscope from public.fd_next_fixture(:'host_club') \gset
select tests.assert(:'nfx' <> '', 'nächstes Pflichtspiel gefunden');
-- Stammspieler im aktiven Profil
select sl.player_id as starter, sl.slot_index as sidx from public.tactics t join public.tactical_profiles tp on tp.club_id = t.club_id and tp.name = t.active_profile
join public.tactical_profile_slots sl on sl.profile_id = tp.id join public.players p on p.id = sl.player_id
where t.club_id = :'host_club' and p.main_position <> 'GK' order by sl.slot_index limit 1 \gset
select tests.assert(jsonb_array_length(public.fd_lineup_issues(:'host_club')) = 0, 'Ausgangslage: gültige Aufstellung');

-- Verletzung über das nächste Spiel hinaus
insert into public.injuries(world_id, player_id, kind, starts_on, ends_on) values (:'world', :'starter', 'Muskelfaserriss', :'ndate'::date - 1, :'ndate'::date + 10);
set role authenticated;
select tests.login(:'host');
select public.squad_availability(:'host_club') -> :'starter' as av \gset
select public.lineup_issues(:'world') as issues \gset
reset role;
select tests.assert((:'av'::jsonb ->> 'unavailable')::boolean, 'verletzter Spieler nicht einsatzberechtigt');
select tests.assert((:'av'::jsonb -> 'injury' ->> 'kind') = 'Muskelfaserriss' and (:'av'::jsonb -> 'injury' ->> 'matches')::int >= 1, 'Verletzung mit Ausfalldauer und betroffenen Spielen');
select tests.assert(jsonb_array_length(:'issues'::jsonb) = 1 and (:'issues'::jsonb -> 0 ->> 'reason') = 'injured', 'Startelf-Prüfung meldet den Verletzten');

-- Bereitmeldung blockiert, solange er in der Startelf steht (nur wenn gerade ein Termin vorbereitet wird)
select (public.fd_current_slot(:'world')).state as slot_state \gset
select case when :'slot_state' = 'pending' then 1 else 0 end as can_ready \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.set_matchday_ready(%L, true) $$, :'world'), 'lineup_invalid') where :can_ready = 1;
reset role;

-- Ersetzen: Spieler aus der Startelf nehmen → gültig
update public.tactical_profile_slots sl set player_id = (
  select p.id from public.players p where p.club_id = :'host_club' and p.main_position <> 'GK'
    and not exists (select 1 from public.tactical_profile_slots s2 where s2.profile_id = sl.profile_id and s2.player_id = p.id)
    and not exists (select 1 from public.injuries i where i.player_id = p.id) limit 1)
from public.tactics t join public.tactical_profiles tp on tp.club_id = t.club_id and tp.name = t.active_profile
where t.club_id = :'host_club' and sl.profile_id = tp.id and sl.player_id = :'starter';
select tests.assert(jsonb_array_length(public.fd_lineup_issues(:'host_club')) = 0, 'nach dem Ersetzen gültig');

-- Sperre gilt nur im betroffenen Wettbewerb
select p.id as susp from public.players p where p.club_id = :'host_club' and p.id <> :'starter' order by p.overall desc limit 1 \gset
insert into public.disciplinary_records(world_id, player_id, season_id, scope, card, suspension_matches, served_matches)
values (:'world', :'susp', (select current_season_id from public.career_worlds where id = :'world'), :'nscope', 'red', 2, 0);
select tests.assert((public.fd_player_availability(:'host_club') -> :'susp' ->> 'unavailable')::boolean, 'Rotsperre im Wettbewerb des nächsten Spiels');
select tests.assert((public.fd_player_availability(:'host_club') -> :'susp' -> 'suspensions' -> 0 ->> 'remaining')::int = 2, 'verbleibende Sperrspiele');
update public.disciplinary_records set scope = case when :'nscope' = 'league' then 'domestic_cup' else 'league' end::public.discipline_scope where player_id = :'susp';
select tests.assert(not (public.fd_player_availability(:'host_club') -> :'susp' ->> 'unavailable')::boolean, 'Sperre in anderem Wettbewerb: einsatzberechtigt');

-- Fremde Vereine: lesbar für Mitglieder (Scouting), nicht für Fremde
set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000dead');
select tests.expect_error(format($$ select public.squad_availability(%L) $$, :'host_club'), 'forbidden');
reset role;

-- Training meldet den Entwicklungsfortschritt
select p.id as trainee from public.players p where p.club_id = :'host_club' and not exists (
  select 1 from public.training_sessions s join public.career_worlds w on w.id = s.world_id where s.player_id = p.id and s.season_id = w.current_season_id and s.week_no = w.current_week)
  order by p.age limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.schedule_training(:'world', :'trainee', 'technique') as tr \gset
reset role;
select tests.assert((:'tr'::jsonb ->> 'points')::numeric > 0 and (:'tr'::jsonb ->> 'total_points')::numeric >= (:'tr'::jsonb ->> 'points')::numeric, 'Training liefert Fortschritt');
