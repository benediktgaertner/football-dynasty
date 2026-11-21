-- =============================================================================
-- 0035: Vereinshymne beim Einlauf in voller Länge
-- =============================================================================
-- Die Länge der hochgeladenen Hymne bestimmt die Dauer der Einlaufzeremonie (Match-Server).
-- Sie wird beim Hochladen bzw. beim ersten Abspielen vom Browser des Managers gemessen und gespeichert.
alter table public.club_audio add column if not exists duration_sec numeric(6,2);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'club_audio_duration_check') then
    alter table public.club_audio add constraint club_audio_duration_check check (duration_sec is null or duration_sec between 1 and 900);
  end if;
end $$;

create or replace function public.set_club_audio_duration(p_id uuid, p_seconds numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_club uuid;
begin
  select club_id into v_club from public.club_audio where id = p_id;
  if v_club is null or not public.is_club_manager(v_club) then
    raise exception 'Audiodatei nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  if p_seconds is null or p_seconds < 1 or p_seconds > 900 then
    raise exception 'Ungültige Länge.' using errcode = '22023', hint = 'invalid';
  end if;
  update public.club_audio set duration_sec = round(p_seconds, 2) where id = p_id;
end;
$$;
revoke execute on function public.set_club_audio_duration(uuid, numeric) from public, anon;
grant execute on function public.set_club_audio_duration(uuid, numeric) to authenticated;
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


notify pgrst, 'reload schema';
