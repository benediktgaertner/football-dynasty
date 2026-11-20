-- =====================================================================
-- 0031 MP3-Upload (RLS-Fix), freie Ultragruppen, Fahnen, KI-Fankultur, drei Trikots, Spielvorbereitung
-- Ursache „new row violates row-level security policy“: In den Storage-Policies aus 0030 wurde
-- `name` innerhalb der Unterabfrage auf clubs.name (Vereinsname) statt auf storage.objects.name
-- (Dateipfad) aufgelöst – die Prüfung war damit immer falsch. Jetzt prüft eine Funktion mit
-- eindeutigem Parameter den Pfad <welt>/<verein>/<datei>.mp3 gegen den angemeldeten Manager.
-- Wiederholbar: alle Anweisungen sind idempotent. Keine Daten werden gelöscht.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Speicher: Hymnen und Fangesänge (Bucket club-audio)
-- ---------------------------------------------------------------------
create or replace function public.fd_can_manage_audio(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_object_name, '') ~* '^[0-9a-f-]{36}/[0-9a-f-]{36}/[^/]+\.mp3$'
    and exists (
      select 1 from public.clubs c
      where c.manager_user_id = (select auth.uid())
        and c.world_id::text = split_part(p_object_name, '/', 1)
        and c.id::text = split_part(p_object_name, '/', 2));
$$;
revoke execute on function public.fd_can_manage_audio(text) from public, anon;
grant execute on function public.fd_can_manage_audio(text) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  -- Bucket: öffentlich lesbar (Abspielen im Browser), nur MP3, höchstens 10 MB
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('club-audio', 'club-audio', true, 10485760, array['audio/mpeg', 'audio/mp3'])
  on conflict (id) do update set public = true, file_size_limit = 10485760, allowed_mime_types = array['audio/mpeg', 'audio/mp3'];
  execute 'drop policy if exists club_audio_insert on storage.objects';
  execute 'drop policy if exists club_audio_select on storage.objects';
  execute 'drop policy if exists club_audio_update on storage.objects';
  execute 'drop policy if exists club_audio_delete on storage.objects';
  -- Nur angemeldete Manager, nur im Ordner des eigenen Vereins (keine öffentlichen Schreibrechte)
  execute $p$create policy club_audio_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'club-audio' and public.fd_can_manage_audio(name))$p$;
  execute $p$create policy club_audio_select on storage.objects for select to authenticated
    using (bucket_id = 'club-audio' and public.fd_can_manage_audio(name))$p$;
  execute $p$create policy club_audio_update on storage.objects for update to authenticated
    using (bucket_id = 'club-audio' and public.fd_can_manage_audio(name))
    with check (bucket_id = 'club-audio' and public.fd_can_manage_audio(name))$p$;
  execute $p$create policy club_audio_delete on storage.objects for delete to authenticated
    using (bucket_id = 'club-audio' and public.fd_can_manage_audio(name))$p$;
end $$;

-- Tabelle club_audio: Lesen für Mitglieder der Welt (Policy aus 0030); Schreiben ausschließlich über
-- die geprüften RPCs (security definer) – direkte INSERT/UPDATE/DELETE sind per RLS gesperrt.
alter table public.club_audio enable row level security;
revoke insert, update, delete on public.club_audio from anon, authenticated;

-- Nur noch MP3 (Upload); die Datei muss im Ordner des eigenen Vereins tatsächlich existieren
create or replace function public.save_club_audio(p_world uuid, p_id uuid, p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_kind text := p_payload ->> 'kind';
  v_name text := btrim(coalesce(p_payload ->> 'name', ''));
  v_path text := nullif(p_payload ->> 'storage_path', '');
  v_exists boolean := true;
  v_id uuid;
begin
  if v_kind not in ('anthem', 'chant') then
    raise exception 'Ungültige Art (Hymne oder Fangesang).' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if char_length(v_name) not between 2 and 40 then raise exception 'Der Name muss 2 bis 40 Zeichen haben.' using errcode = '22023', hint = 'invalid_name'; end if;
  if coalesce(p_payload ->> 'situation', '') not in ('', 'attack', 'goal', 'behind', 'lead', 'derby') then
    raise exception 'Ungültige Spielsituation.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if p_payload ->> 'ultra_id' is not null and not exists (
       select 1 from public.club_fan_culture fc, jsonb_array_elements(fc.ultras) u where fc.club_id = v_club and u ->> 'id' = p_payload ->> 'ultra_id') then
    raise exception 'Ultragruppe nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  if p_id is null then
    if v_path is null or split_part(v_path, '/', 1) <> p_world::text or split_part(v_path, '/', 2) <> v_club::text or v_path !~* '\.mp3$' then
      raise exception 'Die Datei gehört nicht zu deinem Verein.' using errcode = '22023', hint = 'invalid_file';
    end if;
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = ''club-audio'' and name = $1)' into v_exists using v_path;
    end if;
    if not v_exists then
      raise exception 'Die hochgeladene Datei wurde nicht gefunden – bitte erneut hochladen.' using errcode = 'P0001', hint = 'file_missing';
    end if;
    if (select count(*) from public.club_audio where club_id = v_club and kind = v_kind) >= (case v_kind when 'anthem' then 6 else 24 end) then
      raise exception 'Höchstzahl erreicht (6 Hymnen, 24 Fangesänge).' using errcode = 'P0001', hint = 'limit';
    end if;
    insert into public.club_audio(club_id, world_id, kind, ultra_id, name, source, storage_path, situation, volume, enabled)
    values (v_club, p_world, v_kind, p_payload ->> 'ultra_id', v_name, 'upload', v_path, nullif(p_payload ->> 'situation', ''),
            least(1, greatest(0, coalesce((p_payload ->> 'volume')::numeric, 0.85))), coalesce((p_payload ->> 'enabled')::boolean, true))
    returning id into v_id;
    -- Erste Hymne/erster Gesang wird automatisch offizielle Hymne bzw. Signatur-Fangesang
    update public.club_audio set is_official = true
    where id = v_id and kind = 'anthem' and not exists (select 1 from public.club_audio x where x.club_id = v_club and x.kind = 'anthem' and x.is_official and x.id <> v_id);
    update public.club_audio set is_signature = true
    where id = v_id and kind = 'chant' and not exists (select 1 from public.club_audio x where x.club_id = v_club and x.kind = 'chant' and x.is_signature and x.id <> v_id);
  else
    update public.club_audio set name = v_name, ultra_id = p_payload ->> 'ultra_id',
      situation = nullif(p_payload ->> 'situation', ''), volume = least(1, greatest(0, coalesce((p_payload ->> 'volume')::numeric, volume))),
      enabled = coalesce((p_payload ->> 'enabled')::boolean, enabled)
    where id = p_id and club_id = v_club returning id into v_id;
    if v_id is null then raise exception 'Eintrag nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Fahnen (Anzahl, Verteilung in der Heimkurve) und frei platzierte Ultragruppen
-- ---------------------------------------------------------------------
create or replace function public.fd_valid_flag(f jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(f) = 'object'
    and coalesce(f ->> 'shape', '') in ('rect', 'square', 'triangle', 'swallow', 'banner')
    and coalesce(f ->> 'size', '') in ('s', 'm', 'l')
    and coalesce(f ->> 'pattern', '') in ('solid', 'stripes_h', 'stripes_v', 'diagonal', 'halves', 'cross', 'checker', 'star')
    and public.fd_hex_list(f -> 'colors', 3)
    and char_length(coalesce(f ->> 'text', '')) <= 16
    and (not f ? 'count' or (jsonb_typeof(f -> 'count') = 'number' and (f ->> 'count')::numeric between 1 and 12))
    and (not f ? 'from' or (jsonb_typeof(f -> 'from') = 'number' and (f ->> 'from')::numeric between 0 and 1))
    and (not f ? 'to' or (jsonb_typeof(f -> 'to') = 'number' and (f ->> 'to')::numeric between 0 and 1))
    and coalesce((f ->> 'from')::numeric, 0) <= coalesce((f ->> 'to')::numeric, 1);
$$;

-- Bereich in Stadion-Metern (Spielfeld 105 × 68, Ursprung linke obere Ecke). Gesperrt: Spielfeld samt
-- Rand und der Gästeblock (rechte Seite, obere 42 %).
create or replace function public.fd_valid_area(a jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare x numeric; y numeric; w numeric; h numeric;
begin
  if a is null or jsonb_typeof(a) <> 'object' then return false; end if;
  begin
    x := (a ->> 'x')::numeric; y := (a ->> 'y')::numeric; w := (a ->> 'w')::numeric; h := (a ->> 'h')::numeric;
  exception when others then return false;
  end;
  if x is null or y is null or w is null or h is null or w not between 2 and 80 or h not between 2 and 80 then return false; end if;
  if x < -40 or x + w > 145 or y < -40 or y + h > 108 then return false; end if;
  -- nicht auf dem Spielfeld/Innenraum
  if x < 105 + 1.3 and x + w > -1.3 and y < 68 + 1.3 and y + h > -1.3 then return false; end if;
  -- nicht im Gästeblock
  if x + w > 105 + 1.3 and y < 68 * 0.42 then return false; end if;
  return true;
end;
$$;

create or replace function public.fd_valid_ultras(u jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(u) = 'array' and jsonb_array_length(u) <= 4
    and not exists (
      select 1 from jsonb_array_elements(u) g
      where jsonb_typeof(g) <> 'object'
         or char_length(btrim(coalesce(g ->> 'name', ''))) not between 3 and 32
         or char_length(coalesce(g ->> 'id', '')) not between 4 and 40
         or char_length(coalesce(g ->> 'banner', '')) > 28
         or coalesce(g ->> 'block', 'home_curve') not in ('home_curve', 'main_stand', 'back_stand', 'corner_left', 'corner_right')
         or not public.fd_hex_list(g -> 'colors', 3)
         or (g ? 'area' and g -> 'area' <> 'null'::jsonb and not public.fd_valid_area(g -> 'area'))
         or (g ? 'flags' and (jsonb_typeof(g -> 'flags') <> 'number' or (g ->> 'flags')::numeric not between 0 and 16))
         or (g ? 'flag' and g -> 'flag' <> 'null'::jsonb and not public.fd_valid_flag(g -> 'flag')))
    -- Gruppen dürfen sich nicht überlagern
    and not exists (
      select 1 from jsonb_array_elements(u) with ordinality a(g, i), jsonb_array_elements(u) with ordinality b(g, j)
      where a.i < b.j and a.g ? 'area' and b.g ? 'area' and a.g -> 'area' <> 'null'::jsonb and b.g -> 'area' <> 'null'::jsonb
        and (a.g -> 'area' ->> 'x')::numeric < (b.g -> 'area' ->> 'x')::numeric + (b.g -> 'area' ->> 'w')::numeric
        and (b.g -> 'area' ->> 'x')::numeric < (a.g -> 'area' ->> 'x')::numeric + (a.g -> 'area' ->> 'w')::numeric
        and (a.g -> 'area' ->> 'y')::numeric < (b.g -> 'area' ->> 'y')::numeric + (b.g -> 'area' ->> 'h')::numeric
        and (b.g -> 'area' ->> 'y')::numeric < (a.g -> 'area' ->> 'y')::numeric + (a.g -> 'area' ->> 'h')::numeric);
$$;

-- save_fan_culture (0030) begrenzt auf 8 Fahnen-Designs; zusätzlich höchstens 40 Fahnen insgesamt
create or replace function public.save_fan_culture(p_world uuid, p_flags jsonb, p_ultras jsonb, p_default_choreo uuid, p_auto boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if jsonb_typeof(coalesce(p_flags, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_flags, '[]'::jsonb)) > 8
     or exists (select 1 from jsonb_array_elements(coalesce(p_flags, '[]'::jsonb)) f where not public.fd_valid_flag(f))
     or (select coalesce(sum(coalesce((f ->> 'count')::int, 3)), 0) from jsonb_array_elements(coalesce(p_flags, '[]'::jsonb)) f) > 40 then
    raise exception 'Ungültige Fahnen (höchstens 8 Designs und 40 Fahnen).' using errcode = '22023', hint = 'invalid_flags';
  end if;
  if not public.fd_valid_ultras(coalesce(p_ultras, '[]'::jsonb)) then
    raise exception 'Ungültige Ultragruppen: höchstens 4, Name 3–32 Zeichen, nur auf Heimtribünen, nicht überlappend.' using errcode = '22023', hint = 'invalid_ultras';
  end if;
  if p_default_choreo is not null and not exists (select 1 from public.club_choreos where id = p_default_choreo and club_id = v_club) then
    raise exception 'Choreografie nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  insert into public.club_fan_culture(club_id, world_id, flags, ultras, default_choreo_id, auto_choreo, updated_at)
  values (v_club, p_world, coalesce(p_flags, '[]'::jsonb), coalesce(p_ultras, '[]'::jsonb), p_default_choreo, coalesce(p_auto, true), now())
  on conflict (club_id) do update set flags = excluded.flags, ultras = excluded.ultras, default_choreo_id = excluded.default_choreo_id,
    auto_choreo = excluded.auto_choreo, updated_at = now();
  return public.fan_culture(p_world);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Drei Trikots (Heim, Auswärts, Spezial)
-- ---------------------------------------------------------------------
alter table public.club_branding add column if not exists kits jsonb;

-- Farbabstand wie packages/shared/src/color.ts (colorDistance)
create or replace function public.fd_color_dist(a text, b text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare r1 int; g1 int; b1 int; r2 int; g2 int; b2 int; rm numeric;
begin
  if not public.is_hex_color(a) or not public.is_hex_color(b) then return 0; end if;
  r1 := ('x' || substr(a, 2, 2))::bit(8)::int; g1 := ('x' || substr(a, 4, 2))::bit(8)::int; b1 := ('x' || substr(a, 6, 2))::bit(8)::int;
  r2 := ('x' || substr(b, 2, 2))::bit(8)::int; g2 := ('x' || substr(b, 4, 2))::bit(8)::int; b2 := ('x' || substr(b, 6, 2))::bit(8)::int;
  rm := (r1 + r2) / 2.0;
  return sqrt((2 + rm / 256) * (r1 - r2) ^ 2 + 4 * (g1 - g2) ^ 2 + (2 + (255 - rm) / 256) * (b1 - b2) ^ 2);
end;
$$;

-- Trikotsatz eines Vereins (Standard aus dem bisherigen Trikot, wenn noch nichts gespeichert)
create or replace function public.fd_club_kits(p_club uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(b.kits, jsonb_build_object(
    'home', coalesce(b.kit, jsonb_build_object('pattern', 'solid', 'primary', coalesce(b.primary_color, '#1D4ED8'), 'secondary', coalesce(b.secondary_color, '#FFFFFF'))),
    'away', jsonb_build_object('pattern', 'solid',
              'primary', case when public.fd_color_dist(coalesce(b.secondary_color, '#FFFFFF'), coalesce(b.primary_color, '#1D4ED8')) >= 150 then coalesce(b.secondary_color, '#FFFFFF')
                              when public.fd_color_dist('#F4EBD0', coalesce(b.primary_color, '#1D4ED8')) >= 150 then '#F4EBD0' else '#1B1B1B' end,
              'secondary', coalesce(b.primary_color, '#1D4ED8')),
    'special', jsonb_build_object('pattern', 'sash',
              'primary', case when public.fd_color_dist('#1B1B1B', coalesce(b.primary_color, '#1D4ED8')) >= 150 then '#1B1B1B' else '#F2A93B' end,
              'secondary', coalesce(b.primary_color, '#1D4ED8'))))
  from public.club_branding b where b.club_id = p_club;
$$;

create or replace function public.save_kits(p_world uuid, p_kits jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if jsonb_typeof(p_kits) <> 'object' or not (p_kits ? 'home' and p_kits ? 'away' and p_kits ? 'special')
     or not public.fd_valid_kit(p_kits -> 'home') or not public.fd_valid_kit(p_kits -> 'away') or not public.fd_valid_kit(p_kits -> 'special') then
    raise exception 'Ungültige Trikots.' using errcode = '22023', hint = 'invalid_kits';
  end if;
  update public.club_branding set kits = jsonb_build_object('home', p_kits -> 'home', 'away', p_kits -> 'away', 'special', p_kits -> 'special'),
    kit = p_kits -> 'home'
  where club_id = v_club;
  return public.fd_club_kits(v_club);
end;
$$;
revoke execute on function public.save_kits(uuid, jsonb) from public, anon;
grant execute on function public.save_kits(uuid, jsonb) to authenticated;

-- Trikotwahl je Partie
create table if not exists public.fixture_kits (
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  variant text not null default 'home' check (variant in ('home', 'away', 'special')),
  confirmed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (fixture_id, club_id)
);
create index if not exists fixture_kits_club on public.fixture_kits(club_id);
alter table public.fixture_kits enable row level security;
drop policy if exists read_world_members on public.fixture_kits;
create policy read_world_members on public.fixture_kits for select to authenticated using (world_id = any ((select public.fd_my_world_ids())::uuid[]));

-- Trikot eines Vereins in einer Partie: Auswahl des Managers, sonst automatisch (Heim: Heimtrikot,
-- Gast: erstes Trikot ohne Farbkonflikt zum Heimtrikot, sonst das mit dem größten Abstand)
create or replace function public.fd_fixture_kit(p_fixture uuid, p_club uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_kits jsonb := public.fd_club_kits(p_club);
  v_var text;
  v_other jsonb;
  v_best text;
  v_bestd numeric := -1;
  v text;
  d numeric;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  select variant into v_var from public.fixture_kits where fixture_id = p_fixture and club_id = p_club;
  if v_var is null then
    if p_club = v_f.home_club_id then v_var := 'home';
    else
      v_other := public.fd_fixture_kit(p_fixture, v_f.home_club_id);
      foreach v in array array['home', 'away', 'special'] loop
        d := least(public.fd_color_dist(v_kits -> v ->> 'primary', v_other ->> 'primary'), public.fd_color_dist(v_kits -> v ->> 'primary', '#3C7A3A') * 1.25);
        if d >= 150 then v_best := v; exit; end if;
        if d > v_bestd then v_bestd := d; v_best := v; end if;
      end loop;
      v_var := coalesce(v_best, 'away');
    end if;
  end if;
  return (v_kits -> v_var) || jsonb_build_object('variant', v_var);
end;
$$;
-- ---------------------------------------------------------------------
-- 4. Spielvorbereitung: nach „Ich bin bereit“ aller Manager → Trikot/Choreo wählen → bestätigen
--    → Termin startet (Einlauf). Frist 2 Minuten, danach Start mit den automatischen Werten.
-- ---------------------------------------------------------------------
alter table public.season_slots drop constraint if exists season_slots_state_check;
alter table public.season_slots add constraint season_slots_state_check check (state in ('pending', 'prep', 'live', 'released'));
alter table public.season_slots add column if not exists prep_until timestamptz;

-- Menschliche Vereine mit eigenem Spiel im aktuellen Termin
create or replace function public.fd_prep_clubs(p_world uuid)
returns table(fixture_id uuid, club_id uuid, is_home boolean)
language sql
stable
set search_path = ''
as $$
  select f.id, c.id, c.id = f.home_club_id
  from public.fixtures f join public.clubs c on c.id in (f.home_club_id, f.away_club_id)
  where f.id in (select public.fd_slot_fixture_ids(p_world)) and c.control = 'human' and f.status = 'scheduled';
$$;

create or replace function public.fd_start_prep(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state <> 'pending' then return; end if;
  if v_slot.kind = 'season_end' or not exists (select 1 from public.fd_prep_clubs(p_world)) then
    perform public.fd_begin_slot(p_world);
    return;
  end if;
  update public.season_slots set state = 'prep', prep_until = now() + interval '2 minutes' where id = v_slot.id;
  -- Ausgangswerte: automatische Trikotwahl, noch nicht bestätigt
  insert into public.fixture_kits(fixture_id, club_id, world_id, variant, confirmed)
  select p.fixture_id, p.club_id, p_world, public.fd_fixture_kit(p.fixture_id, p.club_id) ->> 'variant', false
  from public.fd_prep_clubs(p_world) p
  on conflict (fixture_id, club_id) do update set confirmed = false, updated_at = now();
end;
$$;

-- Vorbereitung beenden, wenn alle bestätigt haben oder die Frist abgelaufen ist
create or replace function public.fd_prep_try_finish(p_world uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state <> 'prep' then return false; end if;
  if v_slot.prep_until > now() and exists (
       select 1 from public.fd_prep_clubs(p_world) p
       where not exists (select 1 from public.fixture_kits k where k.fixture_id = p.fixture_id and k.club_id = p.club_id and k.confirmed)) then
    return false;
  end if;
  perform public.fd_begin_slot(p_world);
  return true;
end;
$$;

create or replace function public.prep_state(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_club uuid := (select id from public.clubs where world_id = p_world and manager_user_id = v_member.user_id);
  v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state <> 'prep' then return jsonb_build_object('active', false); end if;
  return jsonb_build_object(
    'active', true,
    'seconds_left', greatest(0, extract(epoch from (v_slot.prep_until - now()))::int),
    'label', v_slot.label,
    'managers', coalesce((select jsonb_agg(jsonb_build_object('club', c.name, 'username', pr.username, 'confirmed', coalesce(k.confirmed, false)) order by c.name)
                          from public.fd_prep_clubs(p_world) p join public.clubs c on c.id = p.club_id left join public.profiles pr on pr.id = c.manager_user_id
                          left join public.fixture_kits k on k.fixture_id = p.fixture_id and k.club_id = p.club_id), '[]'::jsonb),
    'fixture', (select jsonb_build_object(
        'id', f.id, 'is_home', f.home_club_id = v_club, 'neutral', f.neutral_venue,
        'competition', (select jsonb_build_object('kind', co.kind, 'tier', co.tier, 'association', co.association_code, 'name', co.name) from public.competitions co where co.id = f.competition_id),
        'home', jsonb_build_object('id', h.id, 'name', h.name, 'short', h.short_name, 'control', h.control, 'kits', public.fd_club_kits(h.id),
                                   'kit', public.fd_fixture_kit(f.id, h.id), 'confirmed', coalesce((select confirmed from public.fixture_kits where fixture_id = f.id and club_id = h.id), h.control = 'ai')),
        'away', jsonb_build_object('id', a.id, 'name', a.name, 'short', a.short_name, 'control', a.control, 'kits', public.fd_club_kits(a.id),
                                   'kit', public.fd_fixture_kit(f.id, a.id), 'confirmed', coalesce((select confirmed from public.fixture_kits where fixture_id = f.id and club_id = a.id), a.control = 'ai')),
        'stadium', (select jsonb_build_object('capacity', st.capacity, 'design', st.design) from public.stadiums st where st.club_id = h.id),
        'choreo', (select ch.design || jsonb_build_object('id', ch.id, 'name', ch.name) from public.fixture_choreos x join public.club_choreos ch on ch.id = x.choreo_id where x.fixture_id = f.id),
        'choreos', case when f.home_club_id = v_club then coalesce((select jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name, 'design', ch.design) order by ch.created_at)
                                                                    from public.club_choreos ch where ch.club_id = v_club), '[]'::jsonb) end,
        'home_colors', jsonb_build_array(hb.primary_color, hb.secondary_color))
      from public.fixtures f join public.clubs h on h.id = f.home_club_id join public.clubs a on a.id = f.away_club_id
      left join public.club_branding hb on hb.club_id = h.id
      where f.id in (select fixture_id from public.fd_prep_clubs(p_world) where club_id = v_club))
  );
end;
$$;

-- Auswahl speichern: Trikot (jeder Manager für sein Team), Choreografie (nur Heimverein), Bestätigung
create or replace function public.set_prep_choice(p_world uuid, p_fixture uuid, p_variant text, p_choreo uuid, p_set_choreo boolean, p_confirm boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_club uuid := (select id from public.clubs where world_id = p_world and manager_user_id = v_member.user_id);
  v_slot public.season_slots;
  v_f public.fixtures;
begin
  perform 1 from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_slot.id is null or v_slot.state <> 'prep' then
    raise exception 'Die Spielvorbereitung ist bereits beendet.' using errcode = 'P0001', hint = 'not_prep';
  end if;
  select * into v_f from public.fixtures where id = p_fixture;
  if not exists (select 1 from public.fd_prep_clubs(p_world) p where p.fixture_id = p_fixture and p.club_id = v_club) then
    raise exception 'Das ist nicht deine Partie.' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_variant is not null and p_variant not in ('home', 'away', 'special') then
    raise exception 'Ungültiges Trikot.' using errcode = '22023', hint = 'invalid_kit';
  end if;
  if coalesce(p_set_choreo, false) then
    if v_f.home_club_id <> v_club or v_f.neutral_venue then
      raise exception 'Die Choreografie bestimmt der Heimverein.' using errcode = '42501', hint = 'not_home';
    end if;
    if p_choreo is null then delete from public.fixture_choreos where fixture_id = p_fixture;
    else
      if not exists (select 1 from public.club_choreos where id = p_choreo and club_id = v_club) then
        raise exception 'Choreografie nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
      end if;
      insert into public.fixture_choreos(fixture_id, club_id, world_id, choreo_id) values (p_fixture, v_club, p_world, p_choreo)
      on conflict (fixture_id) do update set choreo_id = excluded.choreo_id;
    end if;
  end if;
  insert into public.fixture_kits(fixture_id, club_id, world_id, variant, confirmed)
  values (p_fixture, v_club, p_world, coalesce(p_variant, public.fd_fixture_kit(p_fixture, v_club) ->> 'variant'), coalesce(p_confirm, false))
  on conflict (fixture_id, club_id) do update set variant = coalesce(p_variant, public.fixture_kits.variant),
    confirmed = coalesce(p_confirm, public.fixture_kits.confirmed), updated_at = now();
  perform public.fd_prep_try_finish(p_world);
  return public.prep_state(p_world);
end;
$$;

-- Frist abgelaufen? Jeder Manager darf den Start auslösen (blockiert nie dauerhaft)
create or replace function public.prep_tick(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_member public.world_members := public.fd_require_member(p_world);
begin
  perform 1 from public.career_worlds where id = p_world for update;
  perform public.fd_prep_try_finish(p_world);
  return public.matchday_state(p_world);
end;
$$;

revoke execute on function public.prep_state(uuid) from public, anon;
revoke execute on function public.set_prep_choice(uuid, uuid, text, uuid, boolean, boolean) from public, anon;
revoke execute on function public.prep_tick(uuid) from public, anon;
grant execute on function public.prep_state(uuid) to authenticated;
grant execute on function public.set_prep_choice(uuid, uuid, text, uuid, boolean, boolean) to authenticated;
grant execute on function public.prep_tick(uuid) to authenticated;
revoke execute on function public.fd_start_prep(uuid) from public, anon, authenticated;
revoke execute on function public.fd_prep_try_finish(uuid) from public, anon, authenticated;
revoke execute on function public.fd_prep_clubs(uuid) from public, anon, authenticated;
revoke execute on function public.fd_fixture_kit(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Fans im Match: Heimverein (eigene Fankultur bzw. automatisch für KI), Gäste im Gästeblock
-- ---------------------------------------------------------------------
create or replace function public.fd_fan_view(p_fixture uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'flags', coalesce(fc.flags, '[]'::jsonb),
    'ultras', coalesce(fc.ultras, '[]'::jsonb),
    'choreo', coalesce(
      (select ch.design || jsonb_build_object('name', ch.name) from public.fixture_choreos x join public.club_choreos ch on ch.id = x.choreo_id where x.fixture_id = f.id),
      case when coalesce(fc.auto_choreo, true) then
        coalesce((select ch.design || jsonb_build_object('name', ch.name) from public.club_choreos ch where ch.id = fc.default_choreo_id),
                 jsonb_build_object('pattern', 'stripes', 'colors', jsonb_build_array(b.primary_color, b.secondary_color), 'text', h.short_name, 'motif', 'crest', 'block', 'home_curve', 'name', 'Standard'))
      end),
    'audio', jsonb_build_object(
      'anthem', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume)
                 from public.club_audio a where a.club_id = h.id and a.kind = 'anthem' and a.enabled and a.source = 'upload' order by a.is_official desc, a.created_at limit 1),
      'signature', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume)
                    from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled and a.source = 'upload' order by a.is_signature desc, a.created_at limit 1),
      'chants', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume, 'situation', a.situation))
                          from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled and a.source = 'upload' and a.situation is not null), '[]'::jsonb)),
    'walkout', (select c.kind::text <> 'friendly' from public.competitions c where c.id = f.competition_id),
    -- Für automatisch erzeugte Fankultur (KI-Vereine) und den Gästeblock: nur Name/Farben, keine Zusatzabfragen im Spiel
    'home_club', jsonb_build_object('id', h.id, 'name', h.name, 'short', h.short_name, 'control', h.control, 'colors', jsonb_build_array(b.primary_color, b.secondary_color)),
    'away', jsonb_build_object('id', a2.id, 'name', a2.name, 'short', a2.short_name, 'control', a2.control,
                               'colors', jsonb_build_array(ab.primary_color, ab.secondary_color),
                               'flags', coalesce(afc.flags, '[]'::jsonb),
                               'ultra', (select u from jsonb_array_elements(coalesce(afc.ultras, '[]'::jsonb)) u limit 1))
  )
  from public.fixtures f join public.clubs h on h.id = f.home_club_id join public.clubs a2 on a2.id = f.away_club_id
  left join public.club_branding b on b.club_id = h.id
  left join public.club_branding ab on ab.club_id = a2.id
  left join public.club_fan_culture fc on fc.club_id = h.id
  left join public.club_fan_culture afc on afc.club_id = a2.id
  where f.id = p_fixture;
$$;
revoke execute on function public.fd_fan_view(uuid) from public, anon, authenticated;

-- Leserechte explizit (Supabase vergibt sie standardmäßig; RLS beschränkt auf Mitglieder der Welt)
grant select on public.club_audio, public.club_fan_culture, public.club_choreos, public.fixture_choreos, public.fixture_kits to authenticated;
grant all on public.club_audio, public.club_fan_culture, public.club_choreos, public.fixture_choreos, public.fixture_kits to service_role;
-- set_matchday_ready
CREATE OR REPLACE FUNCTION public.set_matchday_ready(p_world uuid, p_ready boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- alle bereit ⇒ Spielvorbereitung (Trikots, Choreografie), danach Start
    perform public.fd_start_prep(p_world);
  end if;
  return public.matchday_state(p_world);
end;
$function$;

-- fd_begin_slot
CREATE OR REPLACE FUNCTION public.fd_begin_slot(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_slot public.season_slots := public.fd_current_slot(p_world);
begin
  if v_slot.id is null or v_slot.state not in ('pending', 'prep') then return; end if;
  update public.season_slots set state = 'live', started_at = now() where id = v_slot.id;
  update public.career_worlds set current_date_in_world = v_slot.slot_date where id = p_world;
  if v_slot.kind = 'season_end' then
    perform public.fd_end_season(p_world);
    return;
  end if;
  perform public.fd_try_release(p_world);
end;
$function$;

-- admin_sweep_world
CREATE OR REPLACE FUNCTION public.admin_sweep_world(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '20s'
AS $function$
declare
  v_pending uuid[];
  v_live boolean := (public.fd_current_slot(p_world)).state = 'live';
begin
  -- Spielvorbereitung: nach Ablauf der Frist automatisch starten (blockiert den Spieltag nie)
  begin perform public.fd_prep_try_finish(p_world); exception when others then raise warning 'Vorbereitung: %', sqlerrm; end;
  v_live := (public.fd_current_slot(p_world)).state = 'live';
  if v_live then
    begin perform public.fd_compact_batch(p_world, 8); exception when others then raise warning 'Kompaktberechnung: %', sqlerrm; end;
    begin perform public.fd_try_release(p_world); exception when others then raise warning 'Freigabe: %', sqlerrm; end;
  elsif not exists (select 1 from public.fd_world_bg where world_id = p_world and last_run > now() - interval '55 seconds') then
    insert into public.fd_world_bg(world_id, last_run) values (p_world, now()) on conflict (world_id) do update set last_run = now();
    begin perform public.fd_auto_begin(p_world); exception when others then raise warning 'Automatischer Start: %', sqlerrm; end;
    begin perform public.fd_dev_aging_batch(p_world, 2000); exception when others then raise warning 'Alterung: %', sqlerrm; end;
    begin perform public.fd_ai_training_batch(p_world, 25); exception when others then raise warning 'KI-Training: %', sqlerrm; end;
    begin perform public.fd_ai_transfer_batch(p_world, 25); exception when others then raise warning 'KI-Transfers: %', sqlerrm; end;
    begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
    begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state, 'training_left', 0, 'aging_left', 0);
end;
$function$;

-- admin_due_worlds
CREATE OR REPLACE FUNCTION public.admin_due_worlds()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  -- laufender Spieltag: sofort (Spielberechnung, Freigabe)
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  -- sonst Hintergrundarbeit höchstens einmal pro Minute je Welt
  select w.id from public.career_worlds w
  left join public.fd_world_bg b on b.world_id = w.id
  where w.status::text in ('preseason', 'season', 'season_end') and (b.last_run is null or b.last_run < now() - interval '60 seconds')
    and exists (select 1 from public.world_members m where m.world_id = w.id and m.last_seen_at > now() - interval '2 days')
  union
  -- Spielvorbereitung mit abgelaufener Frist
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'prep' and s.prep_until < now();
$function$;

-- matchday_state
CREATE OR REPLACE FUNCTION public.matchday_state(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_member public.world_members := public.fd_require_member(p_world);
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_club uuid;
  v_window jsonb;
begin
  select * into v_world from public.career_worlds where id = p_world;
  v_slot := public.fd_current_slot(p_world);
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = v_member.user_id;
  v_window := public.fd_window_info(p_world, v_club);
  return jsonb_build_object(
    'status', v_world.status,
    'is_host', v_world.host_user_id = v_member.user_id,
    'my_club', v_club,
    'date', v_world.current_date_in_world,
    'season', (select jsonb_build_object('id', s.id, 'year', s.year) from public.seasons s where s.id = v_world.current_season_id),
    'slot', case when v_slot.id is null then null else jsonb_build_object(
      'id', v_slot.id, 'ordinal', v_slot.ordinal, 'key', v_slot.slot_key, 'kind', v_slot.kind, 'label', v_slot.label,
      'date', v_slot.slot_date, 'state', v_slot.state, 'prep_until', v_slot.prep_until, 'started_at', v_slot.started_at, 'matchday', v_slot.matchday) end,
    'readiness', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', c.manager_user_id, 'club', c.name, 'username', p.username,
        'ready', coalesce((select r.ready from public.multiplayer_readiness r where r.world_id = p_world and r.user_id = c.manager_user_id and r.context = 'slot:' || v_slot.id::text), false))
        order by c.name)
      from public.clubs c left join public.profiles p on p.id = c.manager_user_id
      where c.world_id = p_world and c.control = 'human'), '[]'::jsonb),
    'fixtures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'competition', c.name, 'kind', c.kind, 'status', f.status, 'neutral', f.neutral_venue, 'leg', f.leg,
        'home', jsonb_build_object('id', h.id, 'name', h.name, 'short_name', h.short_name, 'control', h.control, 'color', hb.primary_color),
        'away', jsonb_build_object('id', a.id, 'name', a.name, 'short_name', a.short_name, 'control', a.control, 'color', ab.primary_color),
        'mine', v_club in (f.home_club_id, f.away_club_id),
        'decisions', coalesce((select jsonb_object_agg(d.club_id, d.decision) from public.fixture_decisions d where d.fixture_id = f.id), '{}'::jsonb),
        'result', case when public.can_see_fixture_result(f.id) then (select jsonb_build_object('home', r.home_goals, 'away', r.away_goals, 'hp', r.home_penalties, 'ap', r.away_penalties) from public.fixture_results r where r.fixture_id = f.id) end
      ) order by (v_club in (f.home_club_id, f.away_club_id)) desc, (h.control = 'human' or a.control = 'human') desc, c.tier nulls last, h.name)
      from public.fixtures f join public.competitions c on c.id = f.competition_id
      join public.clubs h on h.id = f.home_club_id join public.clubs a on a.id = f.away_club_id
      left join public.club_branding hb on hb.club_id = h.id left join public.club_branding ab on ab.club_id = a.id
      where f.id in (select public.fd_slot_fixture_ids(p_world))), '[]'::jsonb),
    'last_slot', (
      select jsonb_build_object('label', s.label, 'key', s.slot_key) from public.season_slots s
      where s.season_id = v_world.current_season_id and s.ordinal = v_world.current_slot - 1),
    'next_slots', coalesce((
      select jsonb_agg(jsonb_build_object('label', s.label, 'date', s.slot_date, 'kind', s.kind) order by s.ordinal)
      from public.season_slots s where s.season_id = v_world.current_season_id and s.ordinal > v_world.current_slot and s.ordinal <= v_world.current_slot + 4), '[]'::jsonb),
    'window', v_window
  );
end;
$function$;

-- admin_match_setup
CREATE OR REPLACE FUNCTION public.admin_match_setup(p_fixture uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- gewähltes Trikot (Spielvorbereitung) bzw. automatische Wahl ohne Farbkonflikt
    'home', public.fd_match_team(v_f.home_club_id, v_date, v_scope, v_f.season_id)
      || (select jsonb_build_object('kit', k - 'variant', 'color', k ->> 'primary', 'colorAlt', k ->> 'secondary', 'kitVariant', k ->> 'variant') from (select public.fd_fixture_kit(v_f.id, v_f.home_club_id) k) x),
    'away', public.fd_match_team(v_f.away_club_id, v_date, v_scope, v_f.season_id)
      || (select jsonb_build_object('kit', k - 'variant', 'color', k ->> 'primary', 'colorAlt', k ->> 'secondary', 'kitVariant', k ->> 'variant') from (select public.fd_fixture_kit(v_f.id, v_f.away_club_id) k) x),
    'checkpoint', v_session.checkpoint,
    -- Stadion für die Darstellung: Design des Heimvereins und dieselbe Zuschauerzahl wie Ticketverkauf/Ergebnis
    'stadium', (select jsonb_build_object('name', st.name, 'capacity', st.capacity, 'design', st.design,
                  'weather', public.fd_weather(v_f.id), 'atmosphere', public.fd_atmosphere(v_f.id),
                  'competition', (select jsonb_build_object('kind', c.kind, 'tier', c.tier, 'association', c.association_code, 'name', c.name)
                                  from public.competitions c where c.id = v_f.competition_id),
                  'attendance', case when v_f.neutral_venue then round(st.capacity * 0.8)
                                     when v_kind = 'friendly' then round(st.capacity * 0.18)
                                     else coalesce((select r.attendance from public.fixture_results r where r.fixture_id = v_f.id), public.fd_expected_attendance(p_fixture)) end,
                  'fans', public.fd_fan_view(v_f.id))
                from public.stadiums st where st.club_id = v_f.home_club_id)
  );
end;
$function$;

-- fan_culture
CREATE OR REPLACE FUNCTION public.fan_culture(p_world uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_fc public.club_fan_culture;
  v_next record;
begin
  select * into v_fc from public.club_fan_culture where club_id = v_club;
  select f.id, f.scheduled_date, s.label, a.name as opponent, c.kind::text as kind into v_next
  from public.fixtures f join public.career_worlds w on w.id = f.world_id
  join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
  join public.clubs a on a.id = f.away_club_id join public.competitions c on c.id = f.competition_id
  where f.world_id = p_world and f.season_id = w.current_season_id and f.home_club_id = v_club and f.status = 'scheduled'
    and not f.neutral_venue and c.kind::text <> 'friendly'
  order by s.ordinal limit 1;
  return jsonb_build_object(
    'club_id', v_club,
    'kits', public.fd_club_kits(v_club),
    'club', (select jsonb_build_object('name', c.name, 'short', c.short_name, 'primary', b.primary_color, 'secondary', b.secondary_color,
                                       'capacity', st.capacity, 'design', st.design,
                                       'attendance', (select r.attendance from public.fixture_results r join public.fixtures f on f.id = r.fixture_id
                                                      where f.home_club_id = c.id and r.attendance is not null order by f.scheduled_date desc limit 1))
             from public.clubs c left join public.club_branding b on b.club_id = c.id left join public.stadiums st on st.club_id = c.id where c.id = v_club),
    'flags', coalesce(v_fc.flags, '[]'::jsonb),
    'ultras', coalesce(v_fc.ultras, '[]'::jsonb),
    'default_choreo_id', v_fc.default_choreo_id,
    'auto_choreo', coalesce(v_fc.auto_choreo, true),
    'choreos', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'design', design) order by created_at) from public.club_choreos where club_id = v_club), '[]'::jsonb),
    'audio', coalesce((select jsonb_agg(to_jsonb(a) - 'world_id' order by a.kind, a.created_at) from public.club_audio a where a.club_id = v_club), '[]'::jsonb),
    'next_home', case when v_next.id is null then null else jsonb_build_object('fixture_id', v_next.id, 'date', v_next.scheduled_date, 'label', v_next.label,
      'opponent', v_next.opponent, 'kind', v_next.kind, 'choreo_id', (select choreo_id from public.fixture_choreos where fixture_id = v_next.id)) end
  );
end;
$function$;
-- ---------------------------------------------------------------------
-- 6. Abschluss
-- ---------------------------------------------------------------------
-- Bestehende Trikots als Heimtrikot übernehmen, Auswärts-/Spezialtrikot vorbelegen (nur wo noch nichts gespeichert ist)
update public.club_branding b set kits = public.fd_club_kits(b.club_id) where b.kits is null;
insert into public.fd_data_migrations(key) values ('0031_mp3_kits_prep') on conflict do nothing;
