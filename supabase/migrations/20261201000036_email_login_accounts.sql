-- =====================================================================
-- 0036: E-Mail-Login und Sicherung bestehender (anonymer) Accounts
--
-- Grundsätze:
-- * Die Kontoumstellung macht Supabase Auth selbst: Der anonyme Benutzer bekommt per
--   updateUser({ email }) eine E-Mail-Adresse und nach der Bestätigung per updateUser({ password })
--   ein Passwort. Die auth.users.id bleibt dabei UNVERÄNDERT – alle Vereine, Welten,
--   Mitgliedschaften usw. hängen weiter am selben Benutzer. Es wird nichts umgehängt.
-- * Diese Migration ändert KEINE Benutzer und KEINE Spieldaten. Sie
--   1. sichert die Zuordnung Benutzer → Profil → Welten/Vereine in fd_backup (nur lesbar für Admins),
--   2. verhindert, dass das Löschen eines auth-Benutzers Profil, Mitgliedschaften und Vereinszuordnung
--      kaskadierend mitlöscht (vorher: on delete cascade → ein versehentlich gelöschter anonymer
--      Benutzer hätte seine Karriere verloren),
--   3. stellt RPCs für den Kontostatus bereit (nur der eigene Account; keine fremden E-Mail-Adressen).
-- * Keine Passwörter in eigenen Tabellen; keine Zuordnung anhand von Managernamen.
-- Idempotent: mehrfaches Ausführen ist unschädlich.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Sicherung (einmalig; spätere Läufe ergänzen nur neue Benutzer)
-- ---------------------------------------------------------------------
create schema if not exists fd_backup;
revoke all on schema fd_backup from public;
do $$ begin
  revoke all on schema fd_backup from anon, authenticated;
exception when undefined_object then null; end $$;

create table if not exists fd_backup.accounts_0036 (
  user_id uuid primary key,
  email text,
  is_anonymous boolean,
  user_created_at timestamptz,
  last_sign_in_at timestamptz,
  username text,
  backed_up_at timestamptz not null default now()
);
create table if not exists fd_backup.ownership_0036 (
  kind text not null,          -- world_member | club_manager | world_host | manager
  object_id uuid not null,
  world_id uuid,
  user_id uuid not null,
  detail text,
  backed_up_at timestamptz not null default now(),
  primary key (kind, object_id, user_id)
);
alter table fd_backup.accounts_0036 enable row level security;
alter table fd_backup.ownership_0036 enable row level security;
do $$ begin
  revoke all on fd_backup.accounts_0036, fd_backup.ownership_0036 from anon, authenticated;
exception when undefined_object then null; end $$;

insert into fd_backup.accounts_0036 (user_id, email, is_anonymous, user_created_at, last_sign_in_at, username)
select u.id, u.email, u.is_anonymous, u.created_at, u.last_sign_in_at, p.username
from auth.users u left join public.profiles p on p.id = u.id
on conflict (user_id) do nothing;

insert into fd_backup.ownership_0036 (kind, object_id, world_id, user_id, detail)
select 'world_member', m.world_id, m.world_id, m.user_id, m.role::text from public.world_members m
union all
select 'club_manager', c.id, c.world_id, c.manager_user_id, c.name from public.clubs c where c.manager_user_id is not null
union all
select 'world_host', w.id, w.id, w.host_user_id, w.name from public.career_worlds w where w.host_user_id is not null
union all
select 'manager', g.id, null, g.user_id, null from public.managers g where g.user_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. Kein kaskadierendes Löschen von Karrieren über auth.users
--    (Löschen eines Benutzers mit Profil scheitert jetzt ausdrücklich, statt Daten mitzunehmen)
-- ---------------------------------------------------------------------
do $$
declare v_type "char";
begin
  select c.confdeltype into v_type from pg_constraint c
  where c.conname = 'profiles_id_fkey' and c.conrelid = 'public.profiles'::regclass;
  if v_type is distinct from 'r' then
    alter table public.profiles drop constraint if exists profiles_id_fkey;
    alter table public.profiles add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete restrict;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Einmalige Aufforderung „Account sichern“ (serverseitig gemerkt, gilt auf allen Geräten)
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists account_prompt_dismissed_at timestamptz;

-- Eigener Kontostatus. Liefert NUR Angaben zum angemeldeten Benutzer (auth.uid());
-- E-Mail-Adressen anderer Manager sind nicht abrufbar. Passwort-Hash wird nie zurückgegeben,
-- nur ob eines gesetzt ist.
create or replace function public.account_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', u.id,
    'is_anonymous', coalesce(u.is_anonymous, false),
    'email', case when u.email_confirmed_at is not null then u.email end,
    'email_confirmed', u.email is not null and u.email_confirmed_at is not null,
    'pending_email', coalesce(nullif(u.email_change, ''), case when u.email_confirmed_at is null then nullif(u.email, '') end),
    'has_password', coalesce(u.encrypted_password, '') <> '',
    'has_profile', p.id is not null,
    'username', p.username,
    'prompt_dismissed', p.account_prompt_dismissed_at is not null,
    'worlds', (select count(*) from public.world_members m where m.user_id = u.id),
    'clubs', (select count(*) from public.clubs c where c.manager_user_id = u.id)
  )
  from auth.users u
  left join public.profiles p on p.id = u.id
  where u.id = auth.uid();
$$;

create or replace function public.dismiss_account_prompt()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set account_prompt_dismissed_at = coalesce(account_prompt_dismissed_at, now())
  where id = auth.uid();
$$;

-- Managername vor der Registrierung prüfen (Namen sind ohnehin öffentlich sichtbar; keine E-Mail-Auskunft)
create or replace function public.username_available(p_username text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_username, ''));
  v_norm text;
begin
  if char_length(v_name) < 3 or char_length(v_name) > 20 or v_name !~ '^[[:alnum:]_. -]+$' then
    return false;
  end if;
  v_norm := public.normalize_name(v_name);
  if char_length(v_norm) < 3 then return false; end if;
  return not exists (
    select 1 from public.profiles p where p.username_normalized = v_norm and p.id is distinct from auth.uid()
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Neue Karrieren nur noch mit E-Mail-Account: anonyme Benutzer OHNE Profil können kein Profil mehr
--    anlegen (bestehende anonyme Manager mit Profil sind nicht betroffen und spielen normal weiter).
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
  if not exists (select 1 from public.profiles where id = v_user)
     and coalesce((select u.is_anonymous from auth.users u where u.id = v_user), false) then
    raise exception 'Bitte registriere dich mit E-Mail-Adresse und Passwort.' using errcode = '42501', hint = 'email_required';
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
revoke execute on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated;

revoke execute on function public.account_status() from public, anon;
revoke execute on function public.dismiss_account_prompt() from public, anon;
revoke execute on function public.username_available(text) from public;
grant execute on function public.account_status() to authenticated;
grant execute on function public.dismiss_account_prompt() to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Ergebnis (zur Kontrolle im SQL-Editor)
-- ---------------------------------------------------------------------
select
  (select count(*) from auth.users) as benutzer,
  (select count(*) from auth.users where is_anonymous) as davon_anonym,
  (select count(*) from public.profiles) as profile,
  (select count(*) from fd_backup.accounts_0036) as gesicherte_accounts,
  (select count(*) from fd_backup.ownership_0036) as gesicherte_zuordnungen,
  (select confdeltype = 'r' from pg_constraint where conname = 'profiles_id_fkey' and conrelid = 'public.profiles'::regclass) as loeschschutz_aktiv;
