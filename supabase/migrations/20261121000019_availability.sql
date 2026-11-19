-- =====================================================================
-- Migration 0019: Verletzungen, Sperren, Einsatzberechtigung, Trainingsfortschritt
--   * fd_player_availability(club): je Spieler Verletzung (bis, Tage, betroffene Spiele), Sperren je
--     Wettbewerb (Karte, verbleibende Spiele) und Einsatzberechtigung für das nächste Pflichtspiel.
--     Zentrale Quelle für Team-Management, Spielerprofile, Kalender und Match-Setup.
--   * fd_lineup_issues(club): Nicht einsatzberechtigte Spieler in der Startelf des aktiven Profils.
--     set_matchday_ready blockiert, bis die Aufstellung gültig ist (die Engine füllt zusätzlich regelkonform auf).
--   * schedule_training liefert den erhaltenen Entwicklungsfortschritt zurück.
-- =====================================================================

-- Nächstes offenes Pflichtspiel eines Vereins (Datum und Wettbewerbsbereich für Sperren)
create or replace function public.fd_next_fixture(p_club uuid)
returns table (fixture_id uuid, scheduled_date date, scope public.discipline_scope, season_id uuid)
language sql
stable
set search_path = ''
as $$
  select f.id, f.scheduled_date, public.fd_fixture_scope(f.id), f.season_id
  from public.fixtures f join public.competitions c on c.id = f.competition_id
  where (f.home_club_id = p_club or f.away_club_id = p_club) and f.status in ('scheduled', 'live') and c.kind::text <> 'friendly'
  order by f.scheduled_date, f.id
  limit 1;
$$;

create or replace function public.fd_player_availability(p_club uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_today date;
  v_next record;
  v_out jsonb;
begin
  select w.* into v_world from public.career_worlds w join public.clubs c on c.world_id = w.id where c.id = p_club;
  v_today := coalesce(v_world.current_date_in_world, current_date);
  select * into v_next from public.fd_next_fixture(p_club);
  select coalesce(jsonb_object_agg(p.id, jsonb_build_object(
    'injury', (select jsonb_build_object('kind', i.kind, 'until', i.ends_on, 'days', greatest(0, i.ends_on - v_today),
                 'matches', (select count(*) from public.fixtures f join public.competitions c on c.id = f.competition_id
                             where (f.home_club_id = p_club or f.away_club_id = p_club) and f.status in ('scheduled', 'live')
                               and c.kind::text <> 'friendly' and f.scheduled_date between v_today and i.ends_on))
               from public.injuries i where i.player_id = p.id and i.ends_on >= v_today order by i.ends_on desc limit 1),
    'suspensions', coalesce((select jsonb_agg(jsonb_build_object('scope', d.scope, 'card', d.card, 'remaining', d.suspension_matches - d.served_matches))
                             from public.disciplinary_records d where d.player_id = p.id and d.season_id = v_world.current_season_id
                               and d.suspension_matches > d.served_matches), '[]'::jsonb),
    'unavailable', v_next.fixture_id is not null and (
        exists (select 1 from public.injuries i where i.player_id = p.id and v_next.scheduled_date between i.starts_on and i.ends_on)
        or (v_next.scope is not null and exists (select 1 from public.disciplinary_records d where d.player_id = p.id and d.scope = v_next.scope
              and d.season_id = v_next.season_id and d.suspension_matches > d.served_matches))),
    'next_scope', v_next.scope, 'next_date', v_next.scheduled_date
  )), '{}'::jsonb) into v_out
  from public.players p where p.club_id = p_club;
  return v_out;
end;
$$;

-- Für alle Weltmitglieder lesbar (Verletzungen und Sperren sind öffentlich)
create or replace function public.squad_availability(p_club uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_world_member((select world_id from public.clubs where id = p_club)) then
    raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden';
  end if;
  return public.fd_player_availability(p_club);
end;
$$;

create or replace function public.fd_lineup_issues(p_club uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with av as (select public.fd_player_availability(p_club) as a)
  select coalesce(jsonb_agg(jsonb_build_object('player_id', sl.player_id, 'name', p.first_name || ' ' || p.last_name, 'slot', sl.slot_index,
           'reason', case when (av.a -> sl.player_id::text -> 'injury') <> 'null'::jsonb then 'injured' else 'suspended' end)), '[]'::jsonb)
  from public.tactics t
  join public.tactical_profiles tp on tp.club_id = t.club_id and tp.name = t.active_profile
  join public.tactical_profile_slots sl on sl.profile_id = tp.id
  join public.players p on p.id = sl.player_id
  cross join av
  where t.club_id = p_club and coalesce((av.a -> sl.player_id::text ->> 'unavailable')::boolean, false);
$$;

create or replace function public.lineup_issues(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  return public.fd_lineup_issues(v_club);
end;
$$;

create or replace function public.set_matchday_ready(p_world uuid, p_ready boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_ctx text;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_world.status <> 'season' or v_slot.id is null or v_slot.state <> 'pending' then
    raise exception 'Gerade ist kein Termin in Vorbereitung.' using errcode = 'P0001', hint = 'not_preparing';
  end if;
  -- Nicht einsatzberechtigte Spieler in der Startelf: erst ersetzen, dann bereit melden
  if coalesce(p_ready, false) and jsonb_array_length(public.fd_lineup_issues((select id from public.clubs where world_id = p_world and manager_user_id = v_member.user_id))) > 0 then
    raise exception 'In deiner Startelf stehen verletzte oder gesperrte Spieler. Bitte ersetze sie in „Aufstellung & Taktik“.' using errcode = 'P0001', hint = 'lineup_invalid';
  end if;
  v_ctx := 'slot:' || v_slot.id::text;
  insert into public.multiplayer_readiness(world_id, user_id, context, ready)
  values (p_world, v_member.user_id, v_ctx, coalesce(p_ready, false))
  on conflict (world_id, user_id, context) do update set ready = excluded.ready, updated_at = now();
  if not exists (
    select 1 from public.clubs c where c.world_id = p_world and c.control = 'human'
      and not exists (select 1 from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = c.manager_user_id and r.context = v_ctx and r.ready)
  ) then
    perform public.fd_begin_slot(p_world);
  end if;
  return public.matchday_state(p_world);
end;
$$;

create or replace function public.schedule_training(p_world uuid, p_player uuid, p_focus text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_player public.players;
  v_hidden public.player_hidden;
  v_count integer;
  v_points numeric;
begin
  if coalesce(p_focus = any (array['offense','defense','technique','physical','tactics','set_pieces']), false) is false then
    raise exception 'Ungültiger Trainingsschwerpunkt.' using errcode = '22023', hint = 'invalid_focus';
  end if;
  select * into v_world from public.career_worlds where id = p_world;
  select * into v_player from public.players where id = p_player and club_id = v_club for update;
  if not found then
    raise exception 'Dieser Spieler gehört nicht zu deinem Kader.' using errcode = '42501', hint = 'foreign_player';
  end if;
  -- Sperre auf den Verein: parallele Trainingsbuchungen werden nacheinander gezählt
  perform 1 from public.tactics where club_id = v_club for update;
  select count(*) into v_count from public.training_sessions
  where club_id = v_club and season_id = v_world.current_season_id and week_no = v_world.current_week;
  if v_count >= 5 then
    raise exception 'In dieser Woche haben bereits fünf Spieler zusätzlich trainiert.' using errcode = 'P0001', hint = 'training_limit';
  end if;
  begin
    insert into public.training_sessions(world_id, club_id, season_id, week_no, player_id, focus, training_date)
    values (p_world, v_club, v_world.current_season_id, v_world.current_week, p_player, p_focus,
            coalesce(v_world.current_date_in_world, current_date));
  exception when unique_violation then
    raise exception 'Dieser Spieler hat diese Woche schon zusätzlich trainiert.' using errcode = 'P0001', hint = 'already_trained';
  end;

  select * into v_hidden from public.player_hidden where player_id = p_player for update;
  v_points := public.fd_training_points(v_player.age, v_player.overall, v_hidden.potential);
  update public.player_hidden set development_points = development_points + v_points where player_id = p_player;
  update public.players set fitness = greatest(0, fitness - 20) where id = p_player;
  return jsonb_build_object('fitness', greatest(0, v_player.fitness - 20), 'week', v_world.current_week, 'trainees_this_week', v_count + 1,
    'points', v_points, 'total_points', coalesce(v_hidden.development_points, 0) + v_points);
end;
$$;


revoke execute on function public.fd_next_fixture(uuid) from public, anon, authenticated;
revoke execute on function public.fd_player_availability(uuid) from public, anon, authenticated;
revoke execute on function public.fd_lineup_issues(uuid) from public, anon, authenticated;
revoke execute on function public.squad_availability(uuid) from public, anon;
revoke execute on function public.lineup_issues(uuid) from public, anon;
grant execute on function public.squad_availability(uuid) to authenticated;
grant execute on function public.lineup_issues(uuid) to authenticated;
