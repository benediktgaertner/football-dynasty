-- Minimale Nachbildung der Supabase-Umgebung für lokale Datenbanktests ohne Docker.
-- Wird NUR in der Testdatenbank ausgeführt, niemals in Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  is_anonymous boolean not null default true,
  email text
);

-- entspricht der Supabase-Implementierung von auth.uid()
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Supabase legt diese Publikation an; hier zum Testen von Migration 0008
create publication supabase_realtime;
