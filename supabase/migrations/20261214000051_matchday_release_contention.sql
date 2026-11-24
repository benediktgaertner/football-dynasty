-- Ergebnis speichern und Spieltagsfreigabe dürfen sich bei gleichzeitigem
-- Abschluss mehrerer Partien nicht gegenseitig blockieren. Ist die Welt
-- gerade belegt, holt der nächste Sweep oder retry_slot_release die Freigabe nach.
create or replace function public.fd_try_release(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot public.season_slots;
begin
  begin
    perform 1 from public.career_worlds where id = p_world for update nowait;
  exception when lock_not_available then
    return;
  end;

  v_slot := public.fd_current_slot(p_world);
  if v_slot.id is null or v_slot.state <> 'live' or v_slot.kind = 'season_end' then return; end if;
  if exists (select 1 from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(p_world)) and f.status not in ('finished', 'released')) then
    return;
  end if;
  perform public.fd_release_slot(p_world);
end;
$$;
