-- =====================================================================
-- Migration 0007: RPCs für Benutzer, Karrierewelt, Lobby und Vereinsgründung (Phase 2)
-- Alle Funktionen prüfen die Identität über auth.uid() und validieren jede Eingabe.
-- Fehler tragen im Feld `hint` einen maschinenlesbaren Code für die Oberfläche.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Interne Helfer
-- ---------------------------------------------------------------------
create or replace function public.fd_require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'Nicht angemeldet.' using errcode = '28000', hint = 'not_authenticated';
  end if;
  if not exists (select 1 from public.profiles p where p.id = v) then
    raise exception 'Bitte zuerst einen Benutzernamen wählen.' using errcode = 'P0001', hint = 'profile_required';
  end if;
  return v;
end;
$$;

create or replace function public.fd_require_member(p_world uuid)
returns public.world_members
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user uuid := public.fd_require_user();
  v_member public.world_members;
begin
  select * into v_member from public.world_members m where m.world_id = p_world and m.user_id = v_user;
  if not found then
    raise exception 'Du bist kein Mitglied dieser Karrierewelt.' using errcode = '42501', hint = 'not_a_member';
  end if;
  return v_member;
end;
$$;

-- B1: sicherer, zufälliger sechsstelliger Code (Ablehnungsstichprobe gegen Modulo-Verzerrung)
create or replace function public.fd_generate_invite_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- 31 Zeichen
  v_code text := '';
  v_byte integer;
begin
  while char_length(v_code) < 6 loop
    v_byte := get_byte(extensions.gen_random_bytes(1), 0);
    if v_byte < 248 then -- 248 = 8 × 31
      v_code := v_code || substr(v_alphabet, (v_byte % 31) + 1, 1);
    end if;
  end loop;
  return v_code;
end;
$$;

-- B3: Wappen-Konfiguration streng prüfen (keine fremden Schlüssel, nur erlaubte Werte)
create or replace function public.fd_valid_crest(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k
             where k <> all (array['shape','pattern','symbol','primary','secondary','accent','borderWidth','initials','foundedYear'])) then
    return false;
  end if;
  return (p ->> 'shape') = any (array['shield','classic','round','diamond','hexagon','banner'])
     and (p ->> 'pattern') = any (array['solid','halves','stripes','hoops','sash','quarters','chevron'])
     and (p ->> 'symbol') = any (array['none','ball','lion','eagle','crown','star','lightning'])
     and public.is_hex_color(p ->> 'primary')
     and public.is_hex_color(p ->> 'secondary')
     and public.is_hex_color(p ->> 'accent')
     and jsonb_typeof(p -> 'borderWidth') = 'number'
     and (p ->> 'borderWidth') ~ '^[0-6]$'
     and jsonb_typeof(p -> 'initials') = 'string'
     and (p ->> 'initials') ~ '^[A-ZÄÖÜ0-9.&]{1,4}$'
     and (jsonb_typeof(p -> 'foundedYear') = 'null'
          or (jsonb_typeof(p -> 'foundedYear') = 'number' and (p ->> 'foundedYear') ~ '^[0-9]{4}$'
              and (p ->> 'foundedYear')::int between 1850 and 2100));
end;
$$;

create or replace function public.fd_valid_kit(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (array['pattern','primary','secondary'])) then
    return false;
  end if;
  return (p ->> 'pattern') = any (array['solid','stripes','hoops','halves','sash'])
     and public.is_hex_color(p ->> 'primary')
     and public.is_hex_color(p ->> 'secondary');
end;
$$;

-- E2: Ausgangswerte der zwölf Grundeinstellungen je Profil (frei editierbar, keine versteckten Boni)
create or replace function public.fd_default_team_instructions(p_profile public.tactical_profile_name)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'mentality', case p_profile when 'offensive' then 4 when 'defensive' then 2 else 3 end,
    'buildUp', 'mixed',
    'tempo', case p_profile when 'offensive' then 4 else 3 end,
    'attackWidth', 3,
    'attackFocus', 'flexible',
    'chanceCreation', 'mixed',
    'crossFrequency', 3,
    'pressingIntensity', case p_profile when 'offensive' then 4 when 'defensive' then 2 else 3 end,
    'defensiveLine', case p_profile when 'offensive' then 4 when 'defensive' then 2 else 3 end,
    'defensiveWidth', 3,
    'onBallWon', case p_profile when 'defensive' then 'counter' else 'organized' end,
    'onBallLost', case p_profile when 'offensive' then 'counter_press' when 'defensive' then 'retreat' else 'hold_position' end
  );
$$;

-- ---------------------------------------------------------------------
-- A2: Benutzername
-- ---------------------------------------------------------------------
create or replace function public.set_username(p_username text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_name text := btrim(coalesce(p_username, ''));
  v_norm text;
  v_profile public.profiles;
begin
  if v_user is null then
    raise exception 'Nicht angemeldet.' using errcode = '28000', hint = 'not_authenticated';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 20 or v_name !~ '^[[:alnum:]_. -]+$' then
    raise exception 'Benutzername: 3–20 Zeichen, nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich.'
      using errcode = '22023', hint = 'invalid_username';
  end if;
  v_norm := public.normalize_name(v_name);
  if char_length(v_norm) < 3 then
    raise exception 'Benutzername braucht mindestens drei Buchstaben oder Ziffern.' using errcode = '22023', hint = 'invalid_username';
  end if;
  begin
    insert into public.profiles(id, username, username_normalized)
    values (v_user, v_name, v_norm)
    on conflict (id) do update set username = excluded.username, username_normalized = excluded.username_normalized
    returning * into v_profile;
  exception when unique_violation then
    raise exception 'Dieser Benutzername ist bereits vergeben.' using errcode = '23505', hint = 'username_taken';
  end;
  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------
-- B1: Karrierewelt erstellen
-- ---------------------------------------------------------------------
create or replace function public.create_world(p_name text, p_difficulty public.difficulty default 'medium')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.fd_require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_world uuid;
  v_code text;
  v_try integer := 0;
begin
  if char_length(v_name) < 3 or char_length(v_name) > 40 then
    raise exception 'Name der Karrierewelt: 3–40 Zeichen.' using errcode = '22023', hint = 'invalid_world_name';
  end if;
  -- Missbrauchsschutz: höchstens 5 offene Lobbys je Host
  if (select count(*) from public.career_worlds w where w.host_user_id = v_user and w.status = 'lobby') >= 5 then
    raise exception 'Du hast bereits fünf offene Lobbys.' using errcode = 'P0001', hint = 'too_many_lobbies';
  end if;

  loop
    v_try := v_try + 1;
    v_code := public.fd_generate_invite_code();
    begin
      insert into public.career_worlds(name, invite_code, host_user_id, difficulty, seed)
      values (v_name, v_code, v_user, coalesce(p_difficulty, 'medium'), encode(extensions.gen_random_bytes(16), 'hex'))
      returning id into v_world;
      exit;
    exception when unique_violation then
      if v_try >= 20 then raise; end if;
    end;
  end loop;

  insert into public.world_members(world_id, user_id, role) values (v_world, v_user, 'host');
  return jsonb_build_object('world_id', v_world, 'invite_code', v_code);
end;
$$;

-- Missbrauchsschutz für Einladungscodes
create table public.join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_time on public.join_attempts(user_id, attempted_at);
alter table public.join_attempts enable row level security;
revoke all on public.join_attempts from anon, authenticated;

-- ---------------------------------------------------------------------
-- B1: Karrierewelt beitreten
-- ---------------------------------------------------------------------
-- Rückgabe: {"world_id": …} oder {"error": "<hint>", "message": "…"}.
-- Fehlversuche werden NICHT per Exception gemeldet, weil eine Exception auch den
-- protokollierten Versuch zurückrollen und damit die Begrenzung aushebeln würde.
create or replace function public.join_world(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.fd_require_user();
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g'));
  v_world public.career_worlds;
  v_members integer;
begin
  if (select count(*) from public.join_attempts a
      where a.user_id = v_user and a.attempted_at > now() - interval '10 minutes') >= 20 then
    raise exception 'Zu viele Versuche. Bitte warte einige Minuten.' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  if v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    insert into public.join_attempts(user_id) values (v_user);
    return jsonb_build_object('error', 'invalid_invite_code', 'message', 'Ungültiger Einladungscode.');
  end if;

  select * into v_world from public.career_worlds w where w.invite_code = v_code for update;
  if not found then
    insert into public.join_attempts(user_id) values (v_user);
    return jsonb_build_object('error', 'world_not_found', 'message', 'Keine Karrierewelt mit diesem Code gefunden.');
  end if;

  if exists (select 1 from public.world_members m where m.world_id = v_world.id and m.user_id = v_user) then
    return jsonb_build_object('world_id', v_world.id); -- bereits Mitglied: idempotent
  end if;

  if v_world.status <> 'lobby' then
    raise exception 'Diese Karrierewelt hat bereits begonnen.' using errcode = 'P0001', hint = 'world_not_joinable';
  end if;

  select count(*) into v_members from public.world_members m where m.world_id = v_world.id;
  -- 18 = Größe der 2. Bundesliga und Obergrenze des Draft-Pools (400 / 22)
  if v_members >= 18 then
    raise exception 'Diese Karrierewelt ist voll.' using errcode = 'P0001', hint = 'world_full';
  end if;

  insert into public.world_members(world_id, user_id, role) values (v_world.id, v_user, 'manager');
  return jsonb_build_object('world_id', v_world.id);
end;
$$;

-- ---------------------------------------------------------------------
-- Lobby verlassen (nur Nicht-Hosts, nur vor dem Draft)
-- ---------------------------------------------------------------------
create or replace function public.leave_world(p_world uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
begin
  select status into v_status from public.career_worlds where id = p_world for update;
  if v_status <> 'lobby' then
    raise exception 'Eine laufende Karriere kann nicht verlassen werden.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;
  if v_member.role = 'host' then
    raise exception 'Der Host kann die Lobby nicht verlassen.' using errcode = 'P0001', hint = 'host_cannot_leave';
  end if;
  delete from public.clubs c where c.world_id = p_world and c.manager_user_id = v_member.user_id;
  delete from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = v_member.user_id;
  delete from public.world_members m where m.world_id = p_world and m.user_id = v_member.user_id;
end;
$$;

-- ---------------------------------------------------------------------
-- B2.9 / I1: Schwierigkeitsgrad (nur Host, nur in der Lobby)
-- ---------------------------------------------------------------------
create or replace function public.set_world_difficulty(p_world uuid, p_difficulty public.difficulty)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
begin
  if v_member.role <> 'host' then
    raise exception 'Nur der Host darf den Schwierigkeitsgrad festlegen.' using errcode = '42501', hint = 'host_only';
  end if;
  select status into v_status from public.career_worlds where id = p_world for update;
  if v_status <> 'lobby' then
    raise exception 'Der Schwierigkeitsgrad ist nach dem Lobby-Start fest.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;
  if p_difficulty is null then
    raise exception 'Schwierigkeitsgrad fehlt.' using errcode = '22023', hint = 'invalid_difficulty';
  end if;
  update public.career_worlds set difficulty = p_difficulty where id = p_world and difficulty <> p_difficulty;
  if found then
    -- geänderte Bedingungen: alle müssen erneut bestätigen
    update public.multiplayer_readiness set ready = false, updated_at = now()
    where world_id = p_world and context = 'lobby';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- B2.3–8: Eigenen Verein gründen bzw. vor dem Draft bearbeiten
-- ---------------------------------------------------------------------
create or replace function public.upsert_my_club(p_world uuid, p_club jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
  v_name text := btrim(coalesce(p_club ->> 'name', ''));
  v_short text := btrim(coalesce(p_club ->> 'shortName', ''));
  v_primary text := p_club ->> 'primaryColor';
  v_secondary text := p_club ->> 'secondaryColor';
  v_accent text := p_club ->> 'accentColor';
  v_crest jsonb := p_club -> 'crest';
  v_kit jsonb := p_club -> 'kit';
  v_stadium_name text := btrim(coalesce(p_club ->> 'stadiumName', ''));
  v_capacity integer;
  v_club uuid;
  v_username text;
  v_constraint text;
  v_profile public.tactical_profile_name;
  v_profile_id uuid;
begin
  select status into v_status from public.career_worlds where id = p_world for update;
  if v_status <> 'lobby' then
    raise exception 'Vereine können nur vor dem Draft gegründet oder geändert werden.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;

  if p_club is null or jsonb_typeof(p_club) <> 'object' then
    raise exception 'Vereinsdaten fehlen.' using errcode = '22023', hint = 'invalid_club';
  end if;
  if char_length(v_name) < 3 or char_length(v_name) > 32 or v_name !~ '^[[:alnum:] .''&-]+$' then
    raise exception 'Vereinsname: 3–32 Zeichen, Buchstaben, Ziffern, Leerzeichen und . '' & -' using errcode = '22023', hint = 'invalid_club_name';
  end if;
  if v_short !~ '^[A-ZÄÖÜ0-9]{3,4}$' then
    raise exception 'Kurzname: 3–4 Großbuchstaben oder Ziffern.' using errcode = '22023', hint = 'invalid_short_name';
  end if;
  if not (public.is_hex_color(v_primary) and public.is_hex_color(v_secondary) and public.is_hex_color(v_accent)) then
    raise exception 'Ungültige Vereinsfarben.' using errcode = '22023', hint = 'invalid_colors';
  end if;
  if not public.fd_valid_crest(v_crest) then
    raise exception 'Ungültiges Wappen.' using errcode = '22023', hint = 'invalid_crest';
  end if;
  if not public.fd_valid_kit(v_kit) then
    raise exception 'Ungültiges Trikotdesign.' using errcode = '22023', hint = 'invalid_kit';
  end if;
  if char_length(v_stadium_name) < 3 or char_length(v_stadium_name) > 40 or v_stadium_name !~ '^[[:alnum:] .''&-]+$' then
    raise exception 'Stadionname: 3–40 Zeichen.' using errcode = '22023', hint = 'invalid_stadium_name';
  end if;
  if jsonb_typeof(p_club -> 'stadiumCapacity') <> 'number' or (p_club ->> 'stadiumCapacity') !~ '^[0-9]+$' then
    raise exception 'Ungültige Stadiongröße.' using errcode = '22023', hint = 'invalid_capacity';
  end if;
  v_capacity := (p_club ->> 'stadiumCapacity')::integer;
  perform public.stadium_build_cost(v_capacity); -- prüft 10.000–50.000 in 5.000er-Schritten

  select username into v_username from public.profiles where id = v_member.user_id;

  begin
    select id into v_club from public.clubs c where c.world_id = p_world and c.manager_user_id = v_member.user_id for update;
    if v_club is null then
      insert into public.clubs(world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, manager_user_id, founded_year)
      values (p_world, 'GER', v_name, '', v_short, '', 'human', v_member.user_id,
              case when jsonb_typeof(v_crest -> 'foundedYear') = 'number' then (v_crest ->> 'foundedYear')::smallint end)
      returning id into v_club;

      insert into public.managers(world_id, club_id, user_id, display_name) values (p_world, v_club, v_member.user_id, v_username);
      insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
      values (v_club, p_world, v_primary, v_secondary, v_accent, v_crest, v_kit);
      insert into public.stadiums(club_id, world_id, name, capacity) values (v_club, p_world, v_stadium_name, v_capacity);
      -- I2: Bankkonto. Startkapital und Stadionkosten werden beim Draft-Start gebucht (I3),
      -- weil der Host den Schwierigkeitsgrad bis dahin noch ändern darf.
      insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 0);
      insert into public.tactics(club_id, world_id) values (v_club, p_world);
      -- E1: genau drei Taktikprofile mit festen Namen
      foreach v_profile in array array['offensive', 'neutral', 'defensive']::public.tactical_profile_name[] loop
        insert into public.tactical_profiles(world_id, club_id, name, formation_code, team_instructions)
        values (p_world, v_club, v_profile, '4-4-2', public.fd_default_team_instructions(v_profile))
        returning id into v_profile_id;
        insert into public.tactical_profile_slots(profile_id, slot_index, position, x, y)
        select v_profile_id, (s ->> 'index')::smallint, (s ->> 'position')::public.player_position, (s ->> 'x')::numeric, (s ->> 'y')::numeric
        from public.formations f, jsonb_array_elements(f.slots) s
        where f.code = '4-4-2';
      end loop;
    else
      update public.clubs set name = v_name, short_name = v_short,
        founded_year = case when jsonb_typeof(v_crest -> 'foundedYear') = 'number' then (v_crest ->> 'foundedYear')::smallint end
      where id = v_club;
      update public.club_branding set primary_color = v_primary, secondary_color = v_secondary, accent_color = v_accent,
        crest = v_crest, kit = v_kit
      where club_id = v_club;
      update public.stadiums set name = v_stadium_name, capacity = v_capacity where club_id = v_club;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'clubs_name_unique' then
      raise exception 'Dieser Vereinsname ist in dieser Karrierewelt bereits vergeben.' using errcode = '23505', hint = 'club_name_taken';
    elsif v_constraint = 'clubs_short_unique' then
      raise exception 'Dieser Kurzname ist bereits vergeben.' using errcode = '23505', hint = 'short_name_taken';
    elsif v_constraint is null or v_constraint = '' then
      raise exception 'Dieser Vereinsname ist reserviert. Bitte wähle einen fiktiven Namen.' using errcode = '23505', hint = 'club_name_blocked';
    else
      raise;
    end if;
  end;

  -- Änderungen heben die eigene Bereitschaft auf
  update public.multiplayer_readiness set ready = false, updated_at = now()
  where world_id = p_world and user_id = v_member.user_id and context = 'lobby';
  return v_club;
end;
$$;

-- ---------------------------------------------------------------------
-- B2.10: Bereitschaft bestätigen
-- ---------------------------------------------------------------------
create or replace function public.set_ready(p_world uuid, p_ready boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_status public.world_status;
begin
  select status into v_status from public.career_worlds where id = p_world;
  if v_status <> 'lobby' then
    raise exception 'Die Lobby ist bereits abgeschlossen.' using errcode = 'P0001', hint = 'world_not_in_lobby';
  end if;
  if coalesce(p_ready, false) and not exists (
    select 1 from public.clubs c where c.world_id = p_world and c.manager_user_id = v_member.user_id
  ) then
    raise exception 'Gründe zuerst deinen Verein.' using errcode = 'P0001', hint = 'club_required';
  end if;
  insert into public.multiplayer_readiness(world_id, user_id, context, ready)
  values (p_world, v_member.user_id, 'lobby', coalesce(p_ready, false))
  on conflict (world_id, user_id, context) do update set ready = excluded.ready, updated_at = now();
end;
$$;

-- B4: Anwesenheit (Grundlage der Timeout-Regeln)
create or replace function public.touch_presence(p_world uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_member public.world_members := public.fd_require_member(p_world);
begin
  update public.world_members set last_seen_at = now() where world_id = p_world and user_id = v_member.user_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Lobby-Zustand in einem Aufruf (für die Oberfläche)
-- ---------------------------------------------------------------------
create or replace function public.lobby_state(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_members jsonb;
  v_all_ready boolean;
begin
  select * into v_world from public.career_worlds where id = p_world;

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id,
      'username', p.username,
      'role', m.role,
      'last_seen_at', m.last_seen_at,
      'ready', coalesce(r.ready, false),
      'club', case when c.id is null then null else jsonb_build_object(
        'id', c.id, 'name', c.name, 'short_name', c.short_name,
        'primary_color', b.primary_color, 'secondary_color', b.secondary_color, 'accent_color', b.accent_color,
        'crest', b.crest, 'kit', b.kit,
        'stadium_name', s.name, 'stadium_capacity', s.capacity,
        'stadium_cost', public.stadium_build_cost(s.capacity)
      ) end
    ) order by m.joined_at), '[]'::jsonb),
    bool_and(coalesce(r.ready, false) and c.id is not null)
  into v_members, v_all_ready
  from public.world_members m
  join public.profiles p on p.id = m.user_id
  left join public.multiplayer_readiness r on r.world_id = m.world_id and r.user_id = m.user_id and r.context = 'lobby'
  left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
  left join public.club_branding b on b.club_id = c.id
  left join public.stadiums s on s.club_id = c.id
  where m.world_id = p_world;

  return jsonb_build_object(
    'world', jsonb_build_object(
      'id', v_world.id, 'name', v_world.name, 'invite_code', v_world.invite_code, 'status', v_world.status,
      'difficulty', v_world.difficulty, 'host_user_id', v_world.host_user_id,
      'starting_capital', public.starting_capital(v_world.difficulty)
    ),
    'me', jsonb_build_object('user_id', v_member.user_id, 'role', v_member.role),
    'members', v_members,
    'all_ready', coalesce(v_all_ready, false)
  );
end;
$$;

-- Eigene Welten für die Startseite
create or replace function public.my_worlds()
returns table (world_id uuid, name text, status public.world_status, role public.member_role, invite_code text, member_count bigint, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.name, w.status, m.role, w.invite_code::text,
         (select count(*) from public.world_members x where x.world_id = w.id), m.joined_at
  from public.world_members m
  join public.career_worlds w on w.id = m.world_id
  where m.user_id = auth.uid()
  order by m.joined_at desc;
$$;

-- ---------------------------------------------------------------------
-- Rechte: interne Helfer gesperrt, RPCs nur für angemeldete Benutzer
-- (Supabase vergibt für neue Funktionen standardmäßig Rechte an anon/authenticated –
--  deshalb hier ausdrücklich.)
-- ---------------------------------------------------------------------
revoke execute on function public.fd_require_user() from public, anon, authenticated;
revoke execute on function public.fd_require_member(uuid) from public, anon, authenticated;
revoke execute on function public.fd_generate_invite_code() from public, anon, authenticated;
revoke execute on function public.fd_valid_crest(jsonb) from public, anon, authenticated;
revoke execute on function public.fd_valid_kit(jsonb) from public, anon, authenticated;
revoke execute on function public.fd_default_team_instructions(public.tactical_profile_name) from public, anon, authenticated;
revoke execute on function public.post_transaction(uuid, public.transaction_kind, bigint, text, text, uuid, boolean) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'public.set_username(text)',
    'public.create_world(text, public.difficulty)',
    'public.join_world(text)',
    'public.leave_world(uuid)',
    'public.set_world_difficulty(uuid, public.difficulty)',
    'public.upsert_my_club(uuid, jsonb)',
    'public.set_ready(uuid, boolean)',
    'public.touch_presence(uuid)',
    'public.lobby_state(uuid)',
    'public.my_worlds()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
