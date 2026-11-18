-- =====================================================================
-- Migration 0008: Supabase Realtime (A1)
-- Lobby-, Draft- und Kalenderänderungen werden per postgres_changes an die Clients
-- gemeldet. RLS gilt auch für Realtime: Jeder sieht nur Änderungen seiner Welt.
-- Die Clients laden bei einer Meldung den Zustand über die RPCs neu, statt Daten
-- aus dem Ereignis zu übernehmen (eine einzige verbindliche Quelle).
-- =====================================================================
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'Publikation supabase_realtime fehlt (lokale Testdatenbank) – übersprungen.';
    return;
  end if;
  foreach t in array array[
    'career_worlds', 'world_members', 'clubs', 'club_branding', 'stadiums', 'multiplayer_readiness',
    'draft_sessions', 'draft_picks', 'fixtures'
  ] loop
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
