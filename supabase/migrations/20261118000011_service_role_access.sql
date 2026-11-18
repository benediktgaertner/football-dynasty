-- =====================================================================
-- Migration 0011: Rechte der Server-Rolle (service_role) ausdrücklich setzen
--
-- Neuere Supabase-Projekte vergeben Tabellen- und Funktionsrechte nicht mehr
-- automatisch an alle Rollen. Der Match-Server und die Netlify-Function arbeiten
-- mit service_role; diese Rolle bekommt hier ausdrücklich die nötigen Rechte.
-- Für anon/authenticated ändert sich nichts.
-- =====================================================================

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- Alles, was die Function vor dem Draft-Start braucht, in einem Aufruf.
-- Nur für service_role ausführbar; unabhängig von Tabellenrechten (security definer).
create or replace function public.admin_draft_context(p_world uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when w.id is null then null else jsonb_build_object(
    'id', w.id,
    'seed', w.seed,
    'status', w.status,
    'host_user_id', w.host_user_id,
    'humans', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'short_name', c.short_name) order by c.created_at)
      from public.clubs c where c.world_id = w.id and c.control = 'human'
    ), '[]'::jsonb)
  ) end
  from (select 1) one
  left join public.career_worlds w on w.id = p_world;
$$;

revoke execute on function public.admin_draft_context(uuid) from public, anon, authenticated;
grant execute on function public.admin_draft_context(uuid) to service_role;
revoke execute on function public.admin_start_draft(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_start_draft(uuid, uuid, jsonb) to service_role;
