-- 0041: Liga-Einstellungen – KI-Stadionatmosphäre (vom Liga-Host verwaltete MP3-Dateien)
--
-- Drei Kategorien je Liga (Spielwelt): chant (Fangesänge der KI-Vereine), boo (Pfiffe/Buhrufe der Heimfans),
-- goal (Torjubel). Dateien liegen im privaten Storage-Bucket „world-audio“ unter <welt>/<kategorie>/<id>.mp3.
-- Schreiben (Upload, Eintrag, Löschen) ausschließlich der gespeicherte Host der Welt (career_worlds.host_user_id),
-- Lesen (Liste, signierte Abspiel-URLs) alle Mitglieder der Welt. Keine öffentlichen Schreibrechte.
-- Bestehende Daten werden nicht verändert. Idempotent (mehrfach ausführbar).

create table if not exists public.world_ai_audio (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  category text not null check (category in ('chant', 'boo', 'goal')),
  name text not null check (char_length(name) between 1 and 80),
  storage_path text not null unique,
  duration numeric(7, 2) not null check (duration > 0 and duration <= 600),
  size_bytes integer check (size_bytes is null or size_bytes between 1 and 15728640),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists world_ai_audio_world_idx on public.world_ai_audio(world_id, category, created_at);

alter table public.world_ai_audio enable row level security;
drop policy if exists world_ai_audio_select on public.world_ai_audio;
create policy world_ai_audio_select on public.world_ai_audio for select to authenticated using (public.is_world_member(world_id));
revoke all on public.world_ai_audio from anon;
revoke insert, update, delete on public.world_ai_audio from authenticated;
grant select on public.world_ai_audio to authenticated;

-- Host-Recht aus der gespeicherten Eigentümerschaft (nicht aus dem Frontend)
create or replace function public.fd_is_world_host(p_world uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.career_worlds w where w.id = p_world and w.host_user_id = (select auth.uid()));
$$;
revoke execute on function public.fd_is_world_host(uuid) from public, anon;
grant execute on function public.fd_is_world_host(uuid) to authenticated;

-- Storage-Pfad prüfen: <welt-uuid>/<chant|boo|goal>/<uuid>.mp3; schreiben = Host, lesen = Mitglied
create or replace function public.fd_world_audio_access(p_name text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_world uuid;
begin
  if coalesce(p_name, '') !~* '^[0-9a-f-]{36}/(chant|boo|goal)/[0-9a-f-]{36}\.mp3$' then return false; end if;
  v_world := split_part(p_name, '/', 1)::uuid;
  return case when p_write then public.fd_is_world_host(v_world) else public.is_world_member(v_world) end;
end;
$$;
revoke execute on function public.fd_world_audio_access(text, boolean) from public, anon;
grant execute on function public.fd_world_audio_access(text, boolean) to authenticated;

do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  -- privater Bucket: nur MP3, höchstens 15 MB; Abspielen über kurzlebige signierte URLs
  insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('world-audio', 'world-audio', false, 15728640, array['audio/mpeg', 'audio/mp3'])
  on conflict (id) do update set public = false, file_size_limit = 15728640, allowed_mime_types = array['audio/mpeg', 'audio/mp3'];
  execute 'drop policy if exists world_audio_select on storage.objects';
  execute 'drop policy if exists world_audio_insert on storage.objects';
  execute 'drop policy if exists world_audio_update on storage.objects';
  execute 'drop policy if exists world_audio_delete on storage.objects';
  execute $p$create policy world_audio_select on storage.objects for select to authenticated
    using (bucket_id = 'world-audio' and public.fd_world_audio_access(name, false))$p$;
  execute $p$create policy world_audio_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'world-audio' and public.fd_world_audio_access(name, true))$p$;
  execute $p$create policy world_audio_update on storage.objects for update to authenticated
    using (bucket_id = 'world-audio' and public.fd_world_audio_access(name, true))
    with check (bucket_id = 'world-audio' and public.fd_world_audio_access(name, true))$p$;
  execute $p$create policy world_audio_delete on storage.objects for delete to authenticated
    using (bucket_id = 'world-audio' and public.fd_world_audio_access(name, true))$p$;
exception when others then raise notice 'Speicher-Bucket world-audio bitte prüfen: %', sqlerrm;
end $$;

-- Liste der KI-Audiodateien einer Liga (alle Mitglieder; identisch für alle) + Host-Kennzeichen
create or replace function public.world_ai_audio_settings(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  return jsonb_build_object(
    'world', (select jsonb_build_object('id', w.id, 'name', w.name, 'status', w.status) from public.career_worlds w where w.id = p_world),
    'is_host', public.fd_is_world_host(p_world),
    'limit', 40,
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'category', a.category, 'name', a.name, 'path', a.storage_path,
                'duration', a.duration, 'size', a.size_bytes, 'created_at', a.created_at) order by a.category, a.created_at, a.id)
              from public.world_ai_audio a where a.world_id = p_world), '[]'::jsonb));
end;
$$;

-- Datei eintragen (nach dem Upload in den Storage); nur Host, Datei muss im richtigen Ordner existieren
create or replace function public.add_world_ai_audio(p_world uuid, p_category text, p_name text, p_path text, p_duration numeric, p_size integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.fd_is_world_host(p_world) then raise exception 'Nur der Liga-Host kann die KI-Stadionatmosphäre bearbeiten.' using errcode = '42501', hint = 'not_host'; end if;
  if p_category not in ('chant', 'boo', 'goal') then raise exception 'Ungültige Kategorie.' using errcode = '22023', hint = 'invalid_category'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'Der Dateiname muss 1 bis 80 Zeichen haben.' using errcode = '22023', hint = 'invalid_name'; end if;
  if coalesce(p_path, '') !~* ('^' || p_world::text || '/' || p_category || '/[0-9a-f-]{36}\.mp3$') then
    raise exception 'Ungültiger Speicherpfad.' using errcode = '22023', hint = 'invalid_path';
  end if;
  if not (coalesce(p_duration, 0) > 0 and p_duration <= 600) then raise exception 'Die Dauer der MP3 konnte nicht gelesen werden.' using errcode = '22023', hint = 'invalid_duration'; end if;
  if to_regclass('storage.objects') is not null and not exists (select 1 from storage.objects o where o.bucket_id = 'world-audio' and o.name = p_path) then
    raise exception 'Die Datei wurde nicht gefunden – bitte erneut hochladen.' using errcode = '22023', hint = 'file_missing';
  end if;
  if (select count(*) from public.world_ai_audio a where a.world_id = p_world and a.category = p_category) >= 40 then
    raise exception 'Höchstens 40 Dateien je Kategorie.' using errcode = '22023', hint = 'limit';
  end if;
  insert into public.world_ai_audio(world_id, category, name, storage_path, duration, size_bytes, created_by)
  values (p_world, p_category, v_name, p_path, round(p_duration, 2), p_size, (select auth.uid()))
  on conflict (storage_path) do update set name = excluded.name, duration = excluded.duration
  returning id into v_id;
  return (select jsonb_build_object('id', a.id, 'category', a.category, 'name', a.name, 'path', a.storage_path, 'duration', a.duration, 'size', a.size_bytes, 'created_at', a.created_at)
          from public.world_ai_audio a where a.id = v_id);
end;
$$;

-- Datei austragen; liefert den Speicherpfad (die App löscht danach das Objekt im Storage – ebenfalls nur als Host erlaubt)
create or replace function public.delete_world_ai_audio(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v public.world_ai_audio;
begin
  select * into v from public.world_ai_audio where id = p_id;
  if v.id is null then raise exception 'Datei nicht gefunden.' using errcode = '22023', hint = 'not_found'; end if;
  if not public.fd_is_world_host(v.world_id) then raise exception 'Nur der Liga-Host kann die KI-Stadionatmosphäre bearbeiten.' using errcode = '42501', hint = 'not_host'; end if;
  delete from public.world_ai_audio where id = p_id;
  return v.storage_path;
end;
$$;

revoke execute on function public.world_ai_audio_settings(uuid) from public, anon;
revoke execute on function public.add_world_ai_audio(uuid, text, text, text, numeric, integer) from public, anon;
revoke execute on function public.delete_world_ai_audio(uuid) from public, anon;
grant execute on function public.world_ai_audio_settings(uuid) to authenticated;
grant execute on function public.add_world_ai_audio(uuid, text, text, text, numeric, integer) to authenticated;
grant execute on function public.delete_world_ai_audio(uuid) to authenticated;
