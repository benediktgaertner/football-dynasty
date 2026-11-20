-- =====================================================================
-- 0029: Dauerhafte Entlastung der Datenbank (Messung pg_stat_statements im Free-Plan)
--  1. Realtime: Die Spielseiten laden jetzt per leichtem Polling nach. „fixtures“ wird nicht mehr
--     über Realtime veröffentlicht (häufigste Änderungen während der Spieltage). Lobby/Draft bleiben live.
--  2. admin_due_worlds war mit ~400 ms alle 10 s teuer: jetzt nur noch Indexabfragen.
--     Hintergrundarbeit je Welt höchstens einmal pro Minute; laufende Spieltage sofort.
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fixtures') then
    execute 'alter publication supabase_realtime drop table public.fixtures';
  end if;
end $$;

create table if not exists public.fd_world_bg (
  world_id uuid primary key references public.career_worlds(id) on delete cascade,
  last_run timestamptz not null default now()
);
alter table public.fd_world_bg enable row level security;

create or replace function public.admin_due_worlds()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- laufender Spieltag: sofort (Spielberechnung, Freigabe)
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  -- sonst Hintergrundarbeit höchstens einmal pro Minute je Welt
  select w.id from public.career_worlds w
  left join public.fd_world_bg b on b.world_id = w.id
  where w.status::text in ('preseason', 'season', 'season_end') and (b.last_run is null or b.last_run < now() - interval '60 seconds');
$$;

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
  elsif not exists (select 1 from public.fd_world_bg where world_id = p_world and last_run > now() - interval '55 seconds') then
    insert into public.fd_world_bg(world_id, last_run) values (p_world, now()) on conflict (world_id) do update set last_run = now();
    begin perform public.fd_skip_inactive_ai(p_world); exception when others then raise warning 'Sparmodus: %', sqlerrm; end;
    begin perform public.fd_dev_aging_batch(p_world, 2000); exception when others then raise warning 'Alterung: %', sqlerrm; end;
    begin perform public.fd_ai_training_batch(p_world, 25); exception when others then raise warning 'KI-Training: %', sqlerrm; end;
    begin perform public.fd_ai_transfer_batch(p_world, 25); exception when others then raise warning 'KI-Transfers: %', sqlerrm; end;
    begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
    begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  end if;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state, 'training_left', 0, 'aging_left', 0);
end;
$$;
revoke execute on function public.admin_due_worlds() from public, anon, authenticated;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_due_worlds() to service_role;
grant execute on function public.admin_sweep_world(uuid) to service_role;

-- Messwerte zurücksetzen, damit die Wirkung sichtbar wird
do $$ begin perform extensions.pg_stat_statements_reset(); exception when others then null; end $$;
