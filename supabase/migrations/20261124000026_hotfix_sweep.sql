-- =====================================================================
-- 0026 Hotfix: Hintergrundarbeit darf nie blockieren (statement timeout am Dashboard)
--  * Jeder Schritt (Alterung, KI-Training, KI-Transfers, Free Agents, Verhandlungen, Trainingspläne)
--    läuft in einem eigenen Ausnahmeblock: ein Fehler bei einem Spieler/Verein stoppt nichts mehr
--    und wird nicht alle 10 s mit voller Arbeit wiederholt.
--  * Sweep und Tagesverarbeitung mit Zeit- und Sperrlimit; Spielberechnung hat Vorrang.
--  * Hängende Hintergrundabfragen werden einmalig beendet, Statistiken aktualisiert.
-- =====================================================================

-- Einzelne Free-Agent-Entscheidung absichern
create or replace function public.fd_fa_process(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_win public.transfer_windows;
  v_date date;
  fa record;
  a record;
  v_best uuid;
  v_best_years integer;
  v_best_score numeric;
  v_s numeric;
  v_n integer := 0;
  v_p public.players;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  v_win := public.fd_open_window(p_world);
  for fa in select f.* from public.free_agents f where f.world_id = p_world and f.decision_on is not null and f.decision_on <= v_date
            order by f.decision_on, f.player_id limit 25 for update skip locked loop
    begin
      select * into v_p from public.players where id = fa.player_id;
      if v_win.id is null or v_p.club_id is not null then
        update public.fa_applications set status = 'expired', decided_at = now(), note = 'Transferfenster geschlossen'
        where player_id = fa.player_id and status = 'pending';
        update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id;
        continue;
      end if;
      v_best := null; v_best_score := null;
      for a in select * from public.fa_applications where player_id = fa.player_id and status = 'pending' order by created_at loop
        v_s := null;
        if public.fd_fa_signings(a.club_id, v_w.current_season_id) < 2 then
          begin
            perform public.fd_check_buy(p_world, a.club_id, 0, v_win);
            v_s := public.fd_fa_score(fa.player_id, a.club_id);
          exception when others then v_s := null;
          end;
        end if;
        if v_s is not null and (v_best_score is null or v_s > v_best_score) then v_best := a.club_id; v_best_score := v_s; v_best_years := a.contract_years; end if;
      end loop;
      if v_best is null then
        update public.fa_applications set status = 'declined', decided_at = now(), note = 'Der Spieler hat sich gegen alle Interessenten entschieden'
        where player_id = fa.player_id and status = 'pending';
      else
        perform public.fd_complete_transfer(fa.player_id, null, v_best, 0, fa.annual_salary, v_best_years, null, 'free_agent', v_win.id);
        update public.fa_applications set status = case when club_id = v_best then 'signed' else 'lost' end, decided_at = now(),
          note = case when club_id = v_best then null else 'Entscheidung für ' || (select name from public.clubs where id = v_best) end
        where player_id = fa.player_id and status = 'pending';
        v_n := v_n + 1;
      end if;
      update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id and v_best is null;
    exception when others then
      -- Fehler: Bewerbungen schließen statt endlos zu wiederholen
      update public.fa_applications set status = 'declined', decided_at = now(), note = left('Nicht möglich: ' || sqlerrm, 200)
      where player_id = fa.player_id and status = 'pending';
      update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id;
    end;
  end loop;
  return v_n;
end;
$$;

-- Tagesverarbeitung: jeder Teil für sich abgesichert
create or replace function public.fd_world_daily(p_world uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c record;
  v_plans integer := 0;
  v_fa integer := 0;
  v_offers integer := 0;
begin
  for c in select p.club_id from public.training_plans p join public.clubs cl on cl.id = p.club_id
           where p.world_id = p_world and p.active and cl.control = 'human' loop
    begin
      if public.fd_run_training_plan(c.club_id) is not null then v_plans := v_plans + 1; end if;
    exception when others then raise warning 'Trainingsplan %: %', c.club_id, sqlerrm;
    end;
  end loop;
  begin v_offers := public.fd_offers_process(p_world); exception when others then raise warning 'Verhandlungen: %', sqlerrm; end;
  begin v_fa := public.fd_fa_process(p_world); exception when others then raise warning 'Free Agents: %', sqlerrm; end;
  return jsonb_build_object('plans', v_plans, 'offers', v_offers, 'free_agents', v_fa);
end;
$$;

-- Verhandlungen: jede Antwort einzeln abgesichert
create or replace function public.fd_offers_process(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_date date := public.fd_world_date(p_world);
  v_open boolean := (public.fd_open_window(p_world)).id is not null;
  o record;
  v_n integer := 0;
begin
  if not v_open then
    update public.transfer_offers set status = 'expired', responded_at = now(), note = 'Transferfenster geschlossen'
    where world_id = p_world and status in ('pending', 'countered');
    return 0;
  end if;
  for o in select id from public.transfer_offers where world_id = p_world and status = 'pending' and next_response_on is not null and next_response_on <= v_date
           order by next_response_on, id limit 60 for update skip locked loop
    begin
      perform public.fd_seller_respond(o.id, false); v_n := v_n + 1;
    exception when others then
      update public.transfer_offers set status = 'rejected', responded_at = now(), note = left(sqlerrm, 200) where id = o.id;
    end;
  end loop;
  for o in select t.* from public.transfer_offers t join public.clubs c on c.id = t.to_club_id
           where t.world_id = p_world and t.status = 'countered' and c.control = 'ai' order by t.id limit 60 for update of t skip locked loop
    begin
      if o.counter_salary is not null and o.counter_fee = o.fee then
        update public.transfer_offers set annual_salary = greatest(annual_salary, o.counter_salary), status = 'pending', counter_fee = null where id = o.id;
        perform public.fd_offer_close(o.id);
      elsif o.counter_fee <= coalesce(o.ai_max, o.fee) and (select balance from public.finances where club_id = o.to_club_id) >= o.counter_fee then
        update public.transfer_offers set fee = o.counter_fee where id = o.id;
        perform public.fd_offer_log(o.id, 'buyer', 'accept', o.counter_fee);
        perform public.fd_offer_close(o.id);
      elsif o.round < 3 and v_date < coalesce(o.deadline_on, v_date + 1) and coalesce(o.ai_max, 0) > o.fee then
        perform public.fd_offer_rebid(o.id, least(o.ai_max, ((o.fee + o.counter_fee) / 2 / 50000) * 50000), 'buyer');
      else
        update public.transfer_offers set status = 'withdrawn', responded_at = now(), note = 'Käufer steigt aus' where id = o.id;
      end if;
    exception when others then
      update public.transfer_offers set status = 'withdrawn', responded_at = now(), note = left('Käufer steigt aus: ' || sqlerrm, 200) where id = o.id;
    end;
    v_n := v_n + 1;
  end loop;
  update public.transfer_offers set status = 'expired', responded_at = now(), note = 'Frist abgelaufen'
  where world_id = p_world and status = 'countered' and deadline_on is not null and deadline_on < v_date;
  return v_n;
end;
$$;

-- Sweep: Spielberechnung hat Vorrang, Hintergrundarbeit mit Zeit-/Sperrlimit und Ausnahmeblöcken
create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '3s'
set statement_timeout = '25s'
as $$
declare
  v_pending uuid[];
  v_left integer := 0;
  v_aging integer := 0;
  v_market integer := 0;
  v_live boolean := (public.fd_current_slot(p_world)).state = 'live';
begin
  if v_live then
    begin perform public.fd_try_release(p_world); exception when others then raise warning 'Freigabe: %', sqlerrm; end;
  end if;
  begin v_aging := public.fd_dev_aging_batch(p_world, 2000); exception when others then raise warning 'Alterung: %', sqlerrm; v_aging := 0; end;
  begin v_left := public.fd_ai_training_batch(p_world, 25); exception when others then raise warning 'KI-Training: %', sqlerrm; v_left := 0; end;
  begin v_market := public.fd_ai_transfer_batch(p_world, 25); exception when others then raise warning 'KI-Transfers: %', sqlerrm; v_market := 0; end;
  begin perform public.fd_ai_fa_interest(p_world); exception when others then raise warning 'KI-Free-Agents: %', sqlerrm; end;
  begin perform public.fd_world_daily(p_world); exception when others then raise warning 'Tagesverarbeitung: %', sqlerrm; end;
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state,
    -- während eines laufenden Spieltags keine Dauerschleife für Hintergrundarbeit
    'training_left', case when v_live then 0 else v_left + v_market end, 'aging_left', case when v_live then 0 else v_aging end);
end;
$$;

-- Freigabe eines Termins: Tagesverarbeitung darf die Freigabe nie verhindern
do $patch$
declare v_def text;
begin
  select pg_get_functiondef('public.fd_release_slot(uuid)'::regprocedure) into v_def;
  if position('perform public.fd_world_daily(p_world);' in v_def) > 0 and position('Tagesverarbeitung nach Freigabe' in v_def) = 0 then
    v_def := replace(v_def, 'perform public.fd_world_daily(p_world);',
      'begin perform public.fd_world_daily(p_world); exception when others then raise warning ''Tagesverarbeitung nach Freigabe: %'', sqlerrm; end;');
    execute v_def;
  end if;
end
$patch$;

revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_sweep_world(uuid) to service_role;
revoke execute on function public.fd_fa_process(uuid) from public, anon, authenticated;
revoke execute on function public.fd_world_daily(uuid) from public, anon, authenticated;
revoke execute on function public.fd_offers_process(uuid) from public, anon, authenticated;

-- Hängende Hintergrundabfragen (> 20 s) einmalig abbrechen, damit das Dashboard sofort wieder lädt
do $$
begin
  perform pg_cancel_backend(pid) from pg_stat_activity
  where pid <> pg_backend_pid() and state = 'active' and now() - query_start > interval '20 seconds'
    and datname = current_database() and query not ilike '%pg_stat_activity%';
exception when others then raise notice 'Abbrechen nicht möglich: %', sqlerrm;
end $$;

-- Statistiken für die neuen Tabellen/Indizes (bessere Abfragepläne)
analyze public.players;
analyze public.clubs;
analyze public.transfer_offers;
analyze public.transfers;
analyze public.training_sessions;
analyze public.fixtures;
analyze public.free_agents;
