-- =====================================================================
-- 0028 Hotfix „Sparmodus“ für kleine Supabase-Instanzen (Free-Plan, CPU-Drosselung)
-- Wöchentliches KI-Training und KI-Transfers nur noch für Vereine mit Spielbetrieb in dieser Saison
-- (eigene Ligen/Pokale). Die übrigen Europa-Vereine (reiner Transfermarkt) werden je Woche einmal
-- als erledigt markiert – die Datenbank wird dadurch um rund 90 % entlastet.
-- Rückgängig: update public.fd_settings set value = 'false' where key = 'sparmodus';
-- =====================================================================
create table if not exists public.fd_settings (key text primary key, value text not null);
alter table public.fd_settings enable row level security;
insert into public.fd_settings(key, value) values ('sparmodus', 'true') on conflict (key) do update set value = 'true';

create or replace function public.fd_skip_inactive_ai(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
begin
  if coalesce((select value from public.fd_settings where key = 'sparmodus'), 'false') <> 'true' then return; end if;
  select * into v_w from public.career_worlds where id = p_world;
  if v_w.current_season_id is null then return; end if;
  insert into public.world_week_log(world_id, season_id, week_no, job) values (p_world, v_w.current_season_id, v_w.current_week, 'skip_inactive')
  on conflict do nothing;
  if not found then return; end if;
  create temporary table if not exists fd_tmp_inactive (club_id uuid primary key) on commit drop;
  truncate fd_tmp_inactive;
  insert into fd_tmp_inactive
  select cl.id from public.clubs cl
  where cl.world_id = p_world and cl.control = 'ai'
    and not exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                    where e.club_id = cl.id and co.season_id = v_w.current_season_id);
  insert into public.ai_training_log(club_id, season_id, week_no, world_id, trainees)
  select club_id, v_w.current_season_id, v_w.current_week, p_world, 0 from fd_tmp_inactive on conflict do nothing;
  insert into public.ai_transfer_log(club_id, season_id, week_no, world_id)
  select club_id, v_w.current_season_id, v_w.current_week, p_world from fd_tmp_inactive on conflict do nothing;
end;
$$;
revoke execute on function public.fd_skip_inactive_ai(uuid) from public, anon, authenticated;

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
    begin perform public.fd_skip_inactive_ai(p_world); exception when others then raise warning 'Sparmodus: %', sqlerrm; end;
    begin perform public.fd_dev_aging_batch(p_world, 1000); exception when others then raise warning 'Alterung: %', sqlerrm; end;
    begin perform public.fd_ai_training_batch(p_world, 12); exception when others then raise warning 'KI-Training: %', sqlerrm; end;
    begin perform public.fd_ai_transfer_batch(p_world, 12); exception when others then raise warning 'KI-Transfers: %', sqlerrm; end;
    begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
    begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state, 'training_left', 0, 'aging_left', 0);
end;
$$;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_sweep_world(uuid) to service_role;

-- Aufgestaute Arbeit der laufenden Woche sofort für inaktive Vereine abhaken
do $$
declare w record;
begin
  for w in select id from public.career_worlds where current_season_id is not null loop
    perform public.fd_skip_inactive_ai(w.id);
  end loop;
end $$;

-- Tabellenpflege nach den vielen Änderungen
analyze public.players;
analyze public.player_attributes;
analyze public.training_sessions;
analyze public.ai_training_log;
analyze public.ai_transfer_log;
