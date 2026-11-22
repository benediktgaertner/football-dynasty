-- Audit-Fix: Aufsteigende Amateurvereine (4. Liga → 3. Liga) bekamen keine Spielerverträge.
-- Folge: Spieler ohne Vertrag in Ligavereinen (kein Gehalt, kein Ablauf, Vertragsseite leer).
-- Lösung: Trigger auf clubs.amateur (true → false) legt für alle Vereinsspieler ohne aktiven Vertrag einen
-- Vertrag an (Gehalt wie fd_salary, 2 Jahre ab laufender Saison). Idempotent; bestehende Verträge bleiben unberührt.
create or replace function public.fd_contracts_for_promoted_club(p_club uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
  v_year integer;
  v_n integer;
begin
  select c.world_id into v_world from public.clubs c where c.id = p_club;
  if v_world is null then return 0; end if;
  select s.year into v_year from public.career_worlds w join public.seasons s on s.id = w.current_season_id where w.id = v_world;
  if v_year is null then return 0; end if;
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select v_world, p.id, p_club, v_year, v_year + 2,
         greatest(1, public.fd_salary(p.overall, p.age, public.fd_typical_tier(p.overall), 50, 2)), least(45, p.age)
  from public.players p
  where p.club_id = p_club and not p.retired and not p.temporary
    and not exists (select 1 from public.player_contracts k where k.player_id = p.id and k.active)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.fd_contracts_for_promoted_club(uuid) from public, anon, authenticated;

create or replace function public.fd_trg_promoted_club_contracts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.amateur and not new.amateur then
    perform public.fd_contracts_for_promoted_club(new.id);
  end if;
  return new;
end;
$$;
revoke all on function public.fd_trg_promoted_club_contracts() from public, anon, authenticated;

drop trigger if exists clubs_promoted_contracts on public.clubs;
create trigger clubs_promoted_contracts after update of amateur on public.clubs
  for each row when (old.amateur is distinct from new.amateur) execute function public.fd_trg_promoted_club_contracts();

-- Einmalige Nachbesserung: bereits aufgestiegene Vereine ohne Verträge (betrifft nur Spieler ohne aktiven Vertrag)
select public.fd_contracts_for_promoted_club(c.id)
from public.clubs c
where not c.amateur and exists (
  select 1 from public.players p where p.club_id = c.id and not p.retired and not p.temporary
    and not exists (select 1 from public.player_contracts k where k.player_id = p.id and k.active))
  and exists (select 1 from public.player_contracts k where k.club_id = c.id) is false
  and c.control = 'ai';
