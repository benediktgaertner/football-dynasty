-- =====================================================================
-- Migration 0006: Row Level Security und Rechte (A2, A3)
--
-- Prinzip:
--   * Clients (Rolle `authenticated`) dürfen Tabellen ausschließlich LESEN – und nur,
--     was ihre Karrierewelt betrifft.
--   * Jede Schreiboperation läuft über geprüfte SECURITY-DEFINER-RPCs (Migration 0007)
--     oder über den Match-Server mit Service-Role-Schlüssel.
--   * Rechte werden immer aus auth.uid() abgeleitet, nie aus übermittelten Namen oder IDs.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Hilfsfunktionen für Policies (security definer, damit Policies nicht rekursiv werden)
-- ---------------------------------------------------------------------
create or replace function public.is_world_member(p_world uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.world_members m
    where m.world_id = p_world and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_club_manager(p_club uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.clubs c
    where c.id = p_club and c.manager_user_id = (select auth.uid())
  );
$$;

create or replace function public.shares_world_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.world_members a
    join public.world_members b on a.world_id = b.world_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;

-- B4/F14: Ergebnis sichtbar, wenn gemeinsam freigegeben – oder wenn die eigene
-- Partie bereits beendet ist (Spielzusammenfassung für die Beteiligten).
create or replace function public.can_see_fixture_result(p_fixture uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.fixtures f
    where f.id = p_fixture
      and public.is_world_member(f.world_id)
      and (
        f.status = 'released'
        or (f.status = 'finished' and (public.is_club_manager(f.home_club_id) or public.is_club_manager(f.away_club_id)))
      )
  );
$$;

-- ---------------------------------------------------------------------
-- RLS überall einschalten
-- ---------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    -- Kein FORCE: Die Eigentümerrolle der SECURITY-DEFINER-RPCs muss weiterhin schreiben können.
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Tabellenrechte: nur Lesen für angemeldete Benutzer, nichts für anon
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
-- verborgene bzw. interne Daten komplett sperren
revoke select on public.player_hidden from authenticated;
revoke select on public.club_name_blocklist from authenticated;

-- ---------------------------------------------------------------------
-- Lese-Policies
-- ---------------------------------------------------------------------

-- Referenzdaten
create policy read_reference on public.associations for select to authenticated using (true);
create policy read_reference on public.formations for select to authenticated using (true);
create policy read_reference on public.sponsor_offers for select to authenticated using (true);
create policy read_reference on public.prize_templates for select to authenticated using (true);

-- Profile: eigenes Profil und Profile von Mitspielern derselben Welt
create policy read_profiles on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.shares_world_with(id));

-- Welten
create policy read_worlds on public.career_worlds for select to authenticated
  using (public.is_world_member(id));

-- Weltöffentliche Tabellen: für alle Mitglieder der Welt lesbar
do $$
declare t text;
begin
  foreach t in array array[
    'world_members', 'association_strength_history', 'seasons', 'clubs', 'managers', 'club_branding',
    'stadiums', 'players', 'player_attributes', 'player_development', 'player_contracts', 'draft_sessions',
    'draft_picks', 'transfer_windows', 'transfers', 'free_agents', 'injuries', 'disciplinary_records',
    'competitions', 'competition_stages', 'competition_groups', 'group_memberships', 'competition_entries',
    'ties', 'draws', 'fixtures', 'standings', 'season_awards', 'career_history', 'competition_records',
    'coefficients_association', 'coefficients_club', 'european_qualification_slots',
    'club_season_european_status', 'competition_prize_schedules', 'multiplayer_readiness',
    'sponsor_contracts', 'match_sessions'
  ] loop
    execute format(
      'create policy read_world_members on public.%I for select to authenticated using (public.is_world_member(world_id))', t);
  end loop;
end $$;

-- Private Vereinsdaten: nur der Manager des Vereins
create policy read_own on public.finances for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.financial_transactions for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.tactics for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.tactical_profiles for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.set_piece_assignments for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.training_sessions for select to authenticated using (public.is_club_manager(club_id));
create policy read_own on public.tactical_profile_slots for select to authenticated
  using (exists (select 1 from public.tactical_profiles p where p.id = profile_id and public.is_club_manager(p.club_id)));
create policy read_own on public.player_instructions for select to authenticated
  using (exists (select 1 from public.tactical_profiles p where p.id = profile_id and public.is_club_manager(p.club_id)));
-- Angebote sehen nur die beteiligten Vereine
create policy read_involved on public.transfer_offers for select to authenticated
  using (public.is_club_manager(to_club_id) or (from_club_id is not null and public.is_club_manager(from_club_id)));

-- Ergebnisse, Ereignisse und Spielerstatistiken erst nach Freigabe (B4/F14)
create policy read_released on public.fixture_results for select to authenticated using (public.can_see_fixture_result(fixture_id));
create policy read_released on public.match_events for select to authenticated using (public.can_see_fixture_result(fixture_id));
create policy read_released on public.match_player_stats for select to authenticated using (public.can_see_fixture_result(fixture_id));

-- player_hidden, club_name_blocklist: keine Policy → kein Zugriff für Clients

-- ---------------------------------------------------------------------
-- Funktionsrechte: standardmäßig nichts ausführbar; RPCs werden in 0007 einzeln freigegeben
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_world_member(uuid) to authenticated;
grant execute on function public.is_club_manager(uuid) to authenticated;
grant execute on function public.shares_world_with(uuid) to authenticated;
grant execute on function public.can_see_fixture_result(uuid) to authenticated;
grant execute on function public.normalize_name(text) to authenticated;
grant execute on function public.stadium_build_cost(integer) to authenticated;
grant execute on function public.starting_capital(public.difficulty) to authenticated;
-- in CHECK-Constraints verwendet
grant execute on function public.is_hex_color(text) to authenticated;
grant execute on function public.valid_attributes(text, jsonb) to authenticated;

-- Künftig angelegte Funktionen ebenfalls nicht automatisch für alle ausführbar
alter default privileges in schema public revoke execute on functions from public;
