-- =====================================================================
-- 0027 Hotfix: Hintergrundarbeit drosseln (Timeouts bei Managern auf kleinen Supabase-Instanzen)
--  * Während ein Spieltag läuft: nur Spielberechnung und Freigabe – keine Hintergrundarbeit.
--  * Sonst je Sweep (alle 10 s) nur ein kleiner Block: 12 Vereine KI-Training, 12 Vereine KI-Transfers,
--    1.000 Spieler Alterung. Keine Dauerschleife mehr (training_left/aging_left = 0),
--    die Arbeit verteilt sich gleichmäßig über einige Minuten statt die Datenbank zu blockieren.
-- =====================================================================
create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '20s'
as $$
declare
  v_pending uuid[];
  v_live boolean := (public.fd_current_slot(p_world)).state = 'live';
begin
  if v_live then
    begin perform public.fd_try_release(p_world); exception when others then raise warning 'Freigabe: %', sqlerrm; end;
  else
    begin perform public.fd_dev_aging_batch(p_world, 1000); exception when others then raise warning 'Alterung: %', sqlerrm; end;
    begin perform public.fd_ai_training_batch(p_world, 12); exception when others then raise warning 'KI-Training: %', sqlerrm; end;
    begin perform public.fd_ai_transfer_batch(p_world, 12); exception when others then raise warning 'KI-Transfers: %', sqlerrm; end;
    begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
    begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state,
    'training_left', 0, 'aging_left', 0);
end;
$$;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_sweep_world(uuid) to service_role;

-- Laufende lange Abfragen einmalig abbrechen (Dashboard sofort wieder frei)
do $$
begin
  perform pg_cancel_backend(pid) from pg_stat_activity
  where pid <> pg_backend_pid() and state = 'active' and now() - query_start > interval '10 seconds'
    and datname = current_database() and query not ilike '%pg_stat_activity%';
exception when others then raise notice 'Abbrechen nicht möglich: %', sqlerrm;
end $$;
