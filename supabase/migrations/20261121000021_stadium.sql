-- =====================================================================
-- Migration 0021: Stadiondesign (kostenlos, rein optisch) und Fans im Match
--   * stadiums.design: Stil, Tribünen-, Sitz- und Akzentfarbe, Vereinsfarben im Stadion.
--   * save_stadium_design(): Name und Design des eigenen Stadions ändern – ohne Kosten und ohne Einfluss
--     auf Stärke, Heimvorteil oder Zuschauer.
--   * admin_match_setup liefert Stadion + Zuschauerzahl (dieselbe Berechnung wie Ticketverkauf und Ergebnis),
--     der Match-Server reicht sie an die 2D-Ansicht weiter (Fanmenge = reale Auslastung).
-- =====================================================================

alter table public.stadiums add column if not exists design jsonb not null default '{}'::jsonb;

create or replace function public.fd_valid_stadium_design(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and (p ->> 'style' is null or p ->> 'style' in ('classic', 'modern', 'arena', 'traditional'))
    and (p ->> 'stand' is null or public.is_hex_color(p ->> 'stand'))
    and (p ->> 'seat' is null or public.is_hex_color(p ->> 'seat'))
    and (p ->> 'accent' is null or public.is_hex_color(p ->> 'accent'))
    and (p -> 'club_colors' is null or jsonb_typeof(p -> 'club_colors') = 'boolean')
    and (p -> 'roof' is null or jsonb_typeof(p -> 'roof') = 'boolean')
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('style', 'stand', 'seat', 'accent', 'club_colors', 'roof'));
$$;
grant execute on function public.fd_valid_stadium_design(jsonb) to authenticated, service_role;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stadiums_design_valid') then
    alter table public.stadiums add constraint stadiums_design_valid check (public.fd_valid_stadium_design(design));
  end if;
end $$;

create or replace function public.save_stadium_design(p_world uuid, p_name text, p_design jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_club uuid := public.fd_require_team(p_world); v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v_name) not between 3 and 40 then
    raise exception 'Der Stadionname muss 3 bis 40 Zeichen haben.' using errcode = '22023', hint = 'invalid_name';
  end if;
  if not public.fd_valid_stadium_design(coalesce(p_design, '{}'::jsonb)) then
    raise exception 'Ungültiges Stadiondesign.' using errcode = '22023', hint = 'invalid_design';
  end if;
  update public.stadiums set name = v_name, design = coalesce(p_design, '{}'::jsonb) where club_id = v_club;
  return (select jsonb_build_object('name', name, 'design', design) from public.stadiums where club_id = v_club);
end;
$$;
revoke execute on function public.save_stadium_design(uuid, text, jsonb) from public, anon;
grant execute on function public.save_stadium_design(uuid, text, jsonb) to authenticated;

-- Match-Setup mit Stadion (übrige Funktion unverändert aus Migration 0014)
create or replace function public.admin_match_setup(p_fixture uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_kind text;
  v_date date;
  v_session public.match_sessions;
  v_scope public.discipline_scope;
begin
  select * into v_f from public.fixtures where id = p_fixture for update;
  if not found then raise exception 'Spiel nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_f.status not in ('scheduled', 'live') then
    raise exception 'Das Spiel ist bereits beendet.' using errcode = 'P0001', hint = 'already_finished';
  end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  if v_kind <> 'friendly' and p_fixture not in (select public.fd_slot_fixture_ids(v_f.world_id)) then
    raise exception 'Dieses Spiel steht noch nicht an.' using errcode = 'P0001', hint = 'not_current';
  end if;
  if v_kind <> 'friendly' and (public.fd_current_slot(v_f.world_id)).state <> 'live' then
    raise exception 'Der Spieltag wurde noch nicht gestartet – alle Manager müssen bereit sein.' using errcode = 'P0001', hint = 'slot_not_live';
  end if;
  select coalesce(current_date_in_world, current_date) into v_date from public.career_worlds where id = v_f.world_id;
  v_scope := public.fd_fixture_scope(p_fixture);
  if v_f.status = 'scheduled' then
    update public.fixtures set status = 'live' where id = p_fixture;
  end if;
  insert into public.match_sessions(fixture_id, world_id, mode, engine_version)
  values (p_fixture, v_f.world_id, 'live', '2')
  on conflict (fixture_id) do update set status = 'running', updated_at = now()
  returning * into v_session;
  return jsonb_build_object(
    'fixtureId', v_f.id, 'worldId', v_f.world_id, 'seed', v_f.rng_seed, 'kind', v_kind, 'neutral', v_f.neutral_venue,
    'homeAdvantage', case when v_kind = 'friendly' then null else public.fd_home_advantage(p_fixture) end,
    'home', public.fd_match_team(v_f.home_club_id, v_date, v_scope, v_f.season_id),
    'away', public.fd_match_team(v_f.away_club_id, v_date, v_scope, v_f.season_id),
    'checkpoint', v_session.checkpoint,
    -- Stadion für die Darstellung: Design des Heimvereins und dieselbe Zuschauerzahl wie Ticketverkauf/Ergebnis
    'stadium', (select jsonb_build_object('name', st.name, 'capacity', st.capacity, 'design', st.design,
                  'attendance', case when v_f.neutral_venue then round(st.capacity * 0.8)
                                     when v_kind = 'friendly' then round(st.capacity * 0.18)
                                     else coalesce((select r.attendance from public.fixture_results r where r.fixture_id = v_f.id), public.fd_expected_attendance(p_fixture)) end)
                from public.stadiums st where st.club_id = v_f.home_club_id)
  );
end;
$$;

