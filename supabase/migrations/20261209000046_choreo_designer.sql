-- =====================================================================
-- 0046 Choreografie-Designer (v2): Szenen und Elemente, Zufallswahl gespeicherter Choreografien
--  * fd_valid_choreo akzeptiert zusätzlich v2-Designs (Szenen/Elemente) mit strengen Grenzen (Größe, Anzahl, Werte);
--    bisherige Designs bleiben gültig, nichts wird verändert.
--  * club_fan_culture.choreo_random: optional wählt das Match-Setup je Partie zufällig eine gespeicherte Choreografie
--    (keine dauerhafte Änderung am Stadion; die Auswahl pro Heimspiel hat Vorrang).
--  * set_choreo_random / choreo_prefs: Einstellung setzen und lesen (nur der Manager des Vereins).
-- Wiederholbar, ohne Datenverlust.
-- =====================================================================
alter table public.club_fan_culture add column if not exists choreo_random boolean not null default false;

-- v2-Prüfung (Spiegel von validateChoreo in apps/web/src/lib/choreo/model.ts)
create or replace function public.fd_valid_regions(r jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(r) = 'array' and jsonb_array_length(r) between 1 and 24
    and not exists (
      select 1 from jsonb_array_elements(r) x
      where jsonb_typeof(x) <> 'object'
         or coalesce(x ->> 'side', '') not in ('N', 'S', 'W', 'E', 'NW', 'NE', 'SW', 'SE')
         or (x ? 'from' and (jsonb_typeof(x -> 'from') <> 'number' or (x ->> 'from')::numeric not between 0 and 1))
         or (x ? 'to' and (jsonb_typeof(x -> 'to') <> 'number' or (x ->> 'to')::numeric not between 0 and 1))
         or (x ? 'tiers' and jsonb_typeof(x -> 'tiers') <> 'null' and (jsonb_typeof(x -> 'tiers') <> 'array' or exists (
              select 1 from jsonb_array_elements(x -> 'tiers') t where jsonb_typeof(t) <> 'string' or (t #>> '{}') not in ('lower', 'middle', 'upper'))))
    );
$$;

create or replace function public.fd_num_between(v jsonb, lo numeric, hi numeric)
returns boolean
language sql
immutable
set search_path = ''
as $$ select jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric between lo and hi; $$;

create or replace function public.fd_valid_choreo_v2(d jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  n integer;
  e jsonb;
  k text;
  s jsonb;
  p jsonb;
begin
  if jsonb_typeof(d -> 'scenes') <> 'array' or jsonb_typeof(d -> 'elements') <> 'array' then return false; end if;
  n := jsonb_array_length(d -> 'scenes');
  if n not between 1 and 4 or jsonb_array_length(d -> 'elements') > 40 then return false; end if;
  if octet_length(d::text) > 24000 then return false; end if;
  for s in select * from jsonb_array_elements(d -> 'scenes') loop
    if jsonb_typeof(s) <> 'object' or not public.fd_num_between(s -> 'dur', 2, 30) then return false; end if;
  end loop;
  for e in select * from jsonb_array_elements(d -> 'elements') loop
    if jsonb_typeof(e) <> 'object' then return false; end if;
    k := e ->> 'kind';
    if k is null or k not in ('cards', 'blockflag', 'banner', 'fence', 'flags', 'confetti', 'streamers', 'smoke', 'wave') then return false; end if;
    if jsonb_typeof(e -> 'id') <> 'string' or char_length(e ->> 'id') not between 1 and 24 then return false; end if;
    if jsonb_typeof(e -> 's0') <> 'number' or jsonb_typeof(e -> 's1') <> 'number'
       or (e ->> 's0')::numeric <> trunc((e ->> 's0')::numeric) or (e ->> 's1')::numeric <> trunc((e ->> 's1')::numeric)
       or (e ->> 's0')::integer < 0 or (e ->> 's1')::integer < (e ->> 's0')::integer or (e ->> 's1')::integer >= n then return false; end if;
    if e ? 'text' and (jsonb_typeof(e -> 'text') <> 'string' or char_length(e ->> 'text') > 40) then return false; end if;
    if k <> 'flags' and not public.fd_hex_list(e -> 'colors', 4) then return false; end if;
    if k in ('cards', 'blockflag', 'flags', 'confetti', 'streamers', 'smoke', 'wave') and not public.fd_valid_regions(e -> 'regions') then return false; end if;
    if k in ('cards', 'blockflag') and coalesce(e ->> 'pattern', '') not in ('solid', 'stripes', 'stripes_v', 'checker', 'blocks', 'diagonal', 'wave', 'gradient', 'rays', 'mosaic') then return false; end if;
    if k in ('cards', 'blockflag') and coalesce(e ->> 'motif', 'none') not in ('none', 'star', 'heart', 'crown', 'crest', 'lion', 'eagle', 'anchor', 'castle', 'ball', 'bolt') then return false; end if;
    if k in ('cards', 'blockflag') and coalesce(e ->> 'reveal', 'fade') not in ('fade', 'sweep', 'down', 'up', 'none') then return false; end if;
    if k = 'cards' and e ? 'flip' and not public.fd_num_between(e -> 'flip', 1, 30) then return false; end if;
    if k = 'cards' and e ? 'colors2' and not public.fd_hex_list(e -> 'colors2', 4) then return false; end if;
    if k = 'banner' then
      if not (public.fd_num_between(e -> 'x', -80, 190) and public.fd_num_between(e -> 'y', -80, 150) and public.fd_num_between(e -> 'w', 2, 60)
              and public.fd_num_between(e -> 'h', 0.5, 20) and public.fd_num_between(e -> 'rot', -360, 360)) then return false; end if;
    end if;
    if k = 'fence' then
      if coalesce(e ->> 'side', '') not in ('N', 'S', 'W', 'E') or not (public.fd_num_between(e -> 'from', 0, 1) and public.fd_num_between(e -> 'to', 0, 1) and public.fd_num_between(e -> 'h', 0.4, 3)) then return false; end if;
    end if;
    if k = 'flags' then
      if not public.fd_num_between(e -> 'count', 1, 40) or coalesce(e ->> 'size', '') not in ('swing_s', 'swing_l', 'double') then return false; end if;
      if jsonb_typeof(e -> 'flag') <> 'object' or not public.fd_hex_list(e -> 'flag' -> 'colors', 4)
         or coalesce(e -> 'flag' ->> 'shape', '') not in ('rect', 'square', 'triangle', 'swallow', 'banner')
         or coalesce(e -> 'flag' ->> 'pattern', '') not in ('solid', 'stripes_h', 'stripes_v', 'diagonal', 'halves', 'cross', 'checker', 'star') then return false; end if;
      if e ? 'points' then
        if jsonb_typeof(e -> 'points') <> 'array' or jsonb_array_length(e -> 'points') > 40 then return false; end if;
        for p in select * from jsonb_array_elements(e -> 'points') loop
          if jsonb_typeof(p) <> 'object' or not (public.fd_num_between(p -> 'x', -80, 190) and public.fd_num_between(p -> 'y', -80, 150)) then return false; end if;
        end loop;
      end if;
    end if;
    if k in ('confetti', 'streamers', 'smoke') and not public.fd_num_between(e -> 'density', 1, 5) then return false; end if;
    if k = 'wave' and not public.fd_num_between(e -> 'speed', 0.3, 3) then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.fd_valid_choreo(d jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(d) = 'object'
    and coalesce(d ->> 'pattern', '') in ('stripes', 'blocks', 'checker', 'wave', 'gradient', 'rays', 'mosaic')
    and coalesce(d ->> 'motif', 'none') in ('none', 'star', 'heart', 'crown', 'crest', 'lion', 'eagle', 'anchor', 'castle')
    and coalesce(d ->> 'block', 'home_curve') in ('home_curve', 'main_stand', 'back_stand', 'all')
    and public.fd_hex_list(d -> 'colors', 4)
    and char_length(coalesce(d ->> 'text', '')) <= 24
    and (not (d ? 'v') or ((d ->> 'v') = '2' and public.fd_valid_choreo_v2(d)));
$$;

-- Zufallswahl je Verein: aus den gespeicherten Choreografien (nur der Manager des Vereins)
create or replace function public.set_choreo_random(p_world uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  insert into public.club_fan_culture(club_id, world_id, choreo_random) values (v_club, p_world, coalesce(p_on, false))
  on conflict (club_id) do update set choreo_random = excluded.choreo_random;
end;
$$;

create or replace function public.choreo_prefs(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  return jsonb_build_object('random', coalesce((select fc.choreo_random from public.club_fan_culture fc where fc.club_id = v_club), false),
                            'saved', (select count(*) from public.club_choreos where club_id = v_club));
end;
$$;

revoke execute on function public.set_choreo_random(uuid, boolean), public.choreo_prefs(uuid) from public, anon;
grant execute on function public.set_choreo_random(uuid, boolean), public.choreo_prefs(uuid) to authenticated;
revoke execute on function public.fd_valid_regions(jsonb), public.fd_num_between(jsonb, numeric, numeric), public.fd_valid_choreo_v2(jsonb) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fd_fan_view(p_fixture uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'flags', coalesce(fc.flags, '[]'::jsonb),
    'ultras', coalesce(fc.ultras, '[]'::jsonb),
    'choreo', coalesce(
      (select ch.design || jsonb_build_object('name', ch.name) from public.fixture_choreos x join public.club_choreos ch on ch.id = x.choreo_id where x.fixture_id = f.id),
      -- Zufallswahl (Vereinseinstellung): eine der gespeicherten Choreografien, je Partie fest (aus der Partie-ID), für alle Clients gleich
      case when coalesce(fc.choreo_random, false) then
        (select ch.design || jsonb_build_object('name', ch.name) from public.club_choreos ch where ch.club_id = h.id order by md5(f.id::text || ch.id::text) limit 1)
      end,
      case when coalesce(fc.auto_choreo, true) then
        coalesce((select ch.design || jsonb_build_object('name', ch.name) from public.club_choreos ch where ch.id = fc.default_choreo_id),
                 jsonb_build_object('pattern', 'stripes', 'colors', jsonb_build_array(b.primary_color, b.secondary_color), 'text', h.short_name, 'motif', 'crest', 'block', 'home_curve', 'name', 'Standard'))
      end),
    'audio', jsonb_build_object(
      'anthem', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume, 'duration', a.duration_sec, 'club_id', a.club_id)
                 from public.club_audio a where a.club_id = h.id and a.kind = 'anthem' and a.enabled and a.source = 'upload' order by a.is_official desc, a.created_at limit 1),
      'signature', (select jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume)
                    from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled and a.source = 'upload' order by a.is_signature desc, a.created_at limit 1),
      -- alle aktiven Gesänge: reguläre (Playlist), Torhymne (situation = goal), Signatur (nur Einlauf)
      'chants', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume,
                                  'situation', a.situation, 'signature', a.is_signature))
                          from public.club_audio a where a.club_id = h.id and a.kind = 'chant' and a.enabled and a.source = 'upload'), '[]'::jsonb)),
    'walkout', (select c.kind::text <> 'friendly' from public.competitions c where c.id = f.competition_id),
    -- Für automatisch erzeugte Fankultur (KI-Vereine) und den Gästeblock: nur Name/Farben, keine Zusatzabfragen im Spiel
    'home_club', jsonb_build_object('id', h.id, 'name', h.name, 'short', h.short_name, 'control', h.control, 'colors', jsonb_build_array(b.primary_color, b.secondary_color)),
    'away', jsonb_build_object('id', a2.id, 'name', a2.name, 'short', a2.short_name, 'control', a2.control,
                               'colors', jsonb_build_array(ab.primary_color, ab.secondary_color),
                               'flags', coalesce(afc.flags, '[]'::jsonb),
                               'ultra', (select u from jsonb_array_elements(coalesce(afc.ultras, '[]'::jsonb)) u limit 1),
                               -- Gästefans singen ihre eigenen Gesänge (leiser, im Gästeblock)
                               'chants', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'source', a.source, 'path', a.storage_path, 'volume', a.volume,
                                                          'situation', a.situation, 'signature', a.is_signature))
                                                  from public.club_audio a where a.club_id = a2.id and a.kind = 'chant' and a.enabled and a.source = 'upload'), '[]'::jsonb))
  )
  from public.fixtures f join public.clubs h on h.id = f.home_club_id join public.clubs a2 on a2.id = f.away_club_id
  left join public.club_branding b on b.club_id = h.id
  left join public.club_branding ab on ab.club_id = a2.id
  left join public.club_fan_culture fc on fc.club_id = h.id
  left join public.club_fan_culture afc on afc.club_id = a2.id
  where f.id = p_fixture;
$function$
;
revoke execute on function public.fd_fan_view(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';
