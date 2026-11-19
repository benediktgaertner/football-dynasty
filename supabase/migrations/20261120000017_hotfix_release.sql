-- =====================================================================
-- Migration 0017: Hotfix Spieltagsfreigabe
-- 1. Wettlauf: Enden zwei Spiele fast gleichzeitig (Live-Spiel + letztes KI-Spiel), sah jede Transaktion
--    das andere Spiel noch als offen – niemand gab den Termin frei („32/32 beendet“, nächste Woche lädt nicht).
--    fd_try_release sperrt jetzt zuerst die Welt und prüft danach (serialisiert, sieht die andere Transaktion).
-- 2. Freigabe schreibt die Fitness nur noch für Spieler unter 100 % (nicht alle ~18.000 Spieler Europas).
-- 3. retry_slot_release(): Weltmitglieder können einen hängenden Termin nachträglich freigeben lassen
--    (die Spieltagsseite ruft das automatisch auf, wenn alle Spiele beendet sind).
-- 4. Bereits hängende Termine werden beim Ausführen dieser Datei sofort freigegeben.
-- =====================================================================

create or replace function public.fd_try_release(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot public.season_slots;
begin
  -- Zuerst sperren, dann prüfen: gleichzeitige Spielabschlüsse warten aufeinander
  perform 1 from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_slot.id is null or v_slot.state <> 'live' or v_slot.kind = 'season_end' then return; end if;
  if exists (select 1 from public.fixtures f where f.id in (select public.fd_slot_fixture_ids(p_world)) and f.status not in ('finished', 'released')) then
    return;
  end if;
  perform public.fd_release_slot(p_world);
end;
$$;
revoke execute on function public.fd_try_release(uuid) from public, anon, authenticated;
grant execute on function public.fd_try_release(uuid) to service_role;

-- Freigabe ohne unnötige Schreibzugriffe (übrige Funktion unverändert aus Migration 0015)
create or replace function public.fd_release_slot(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_slot public.season_slots;
  v_next public.season_slots;
  f record;
  v_res public.fixture_results;
  v_tier smallint;
  v_hw integer; v_hd integer; v_hl integer;
  v_price integer;
  v_cap integer;
  v_win uuid;
  v_days integer;
  v_cup uuid;
  v_stage public.stage_kind;
  v_next_stage public.stage_kind;
  v_winners uuid[];
  v_first public.fixture_results;
  v_tie public.ties;
  v_cup_prize bigint;
  r record;
  v_sp record;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  v_slot := public.fd_current_slot(p_world);
  if v_slot.state <> 'live' then return; end if;

  for f in
    select fx.*, c.kind::text as comp_kind, c.tier as comp_tier, st.kind as stage_kind
    from public.fixtures fx join public.competitions c on c.id = fx.competition_id
    left join public.competition_stages st on st.id = fx.stage_id
    where fx.id in (select public.fd_slot_fixture_ids(p_world))
  loop
    select * into v_res from public.fixture_results where fixture_id = f.id;
    v_hw := (v_res.home_goals > v_res.away_goals)::int; v_hd := (v_res.home_goals = v_res.away_goals)::int; v_hl := (v_res.home_goals < v_res.away_goals)::int;
    if f.comp_kind = 'league' then
      update public.standings s set
        played = played + 1, won = won + v_hw, drawn = drawn + v_hd, lost = lost + v_hl,
        goals_for = goals_for + v_res.home_goals, goals_against = goals_against + v_res.away_goals, points = points + 3 * v_hw + v_hd,
        home = jsonb_build_object('p', (home ->> 'p')::int + 1, 'w', (home ->> 'w')::int + v_hw, 'd', (home ->> 'd')::int + v_hd, 'l', (home ->> 'l')::int + v_hl,
                                  'gf', (home ->> 'gf')::int + v_res.home_goals, 'ga', (home ->> 'ga')::int + v_res.away_goals)
      where s.competition_id = f.competition_id and s.club_id = f.home_club_id and s.group_id is null;
      update public.standings s set
        played = played + 1, won = won + v_hl, drawn = drawn + v_hd, lost = lost + v_hw,
        goals_for = goals_for + v_res.away_goals, goals_against = goals_against + v_res.home_goals, points = points + 3 * v_hl + v_hd,
        away = jsonb_build_object('p', (away ->> 'p')::int + 1, 'w', (away ->> 'w')::int + v_hl, 'd', (away ->> 'd')::int + v_hd, 'l', (away ->> 'l')::int + v_hw,
                                  'gf', (away ->> 'gf')::int + v_res.away_goals, 'ga', (away ->> 'ga')::int + v_res.home_goals)
      where s.competition_id = f.competition_id and s.club_id = f.away_club_id and s.group_id is null;
      -- I6: Spielprämien
      for r in select * from (values (f.home_club_id, v_hw, v_hd, v_res.home_goals, v_res.away_goals), (f.away_club_id, v_hl, v_hd, v_res.away_goals, v_res.home_goals)) x(club, w, d, gf, ga) loop
        perform public.fd_pay(r.club, 'match_bonus',
          (select amount from public.prize_templates where competition_kind = 'league' and tier = f.comp_tier
             and prize_key = case when r.w = 1 then 'match_win' when r.d = 1 then 'match_draw' else 'match_loss' end),
          'fx:' || f.id || ':bonus:' || r.club, 'Spielprämie ' || v_slot.label, f.season_id);
        -- I7: laufende Sponsorzahlungen
        for v_sp in select so.* from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
                    where sc.club_id = r.club and sc.season_id = f.season_id loop
          perform public.fd_pay(r.club, 'sponsor', case v_sp.kind
              when 'per_league_match' then v_sp.amount when 'per_league_win' then v_sp.amount * r.w
              when 'per_league_point' then v_sp.amount * (3 * r.w + r.d) when 'per_league_goal' then v_sp.amount * r.gf else 0 end,
            'fx:' || f.id || ':sponsor:' || r.club, 'Sponsor ' || v_sp.name || ' · ' || v_slot.label, f.season_id);
        end loop;
      end loop;
    elsif f.tie_id is not null then
      select * into v_tie from public.ties where id = f.tie_id;
      if f.leg is null then
        v_win := case when v_res.home_goals > v_res.away_goals then f.home_club_id when v_res.home_goals < v_res.away_goals then f.away_club_id
                      when coalesce(v_res.home_penalties, 0) > coalesce(v_res.away_penalties, 0) then f.home_club_id else f.away_club_id end;
        update public.ties set winner_club_id = v_win,
          decided_by = case when v_res.home_penalties is not null then 'penalties' else 'aggregate' end where id = f.tie_id;
      elsif f.leg = 2 then
        select r1.* into v_first from public.fixture_results r1 join public.fixtures f1 on f1.id = r1.fixture_id where f1.tie_id = f.tie_id and f1.leg = 1;
        v_win := case when v_res.home_goals + v_first.away_goals > v_res.away_goals + v_first.home_goals then f.home_club_id
                      when v_res.home_goals + v_first.away_goals < v_res.away_goals + v_first.home_goals then f.away_club_id
                      when coalesce(v_res.home_penalties, 0) > coalesce(v_res.away_penalties, 0) then f.home_club_id else f.away_club_id end;
        update public.ties set winner_club_id = v_win,
          decided_by = case when v_res.home_penalties is not null then 'penalties' else 'aggregate' end where id = f.tie_id;
      end if;
      -- Pokalprämien je Runde (Gewinner der Runde, in Mio. €: 0,5 · 1 · 2 · 4 · 8 · 15)
      if f.comp_kind = 'domestic_cup' and v_win is not null then
        v_cup_prize := case f.stage_kind when 'round_of_64' then 500000 when 'round_of_32' then 1000000 when 'round_of_16' then 2000000
                         when 'quarter_final' then 4000000 when 'semi_final' then 8000000 else 15000000 end;
        perform public.fd_pay(v_win, 'competition_prize', v_cup_prize, 'fx:' || f.id || ':cupprize', 'Pokalprämie ' || v_slot.label, f.season_id);
      end if;
    end if;
    -- I4: Zuschauereinnahmen und Stadionkosten (Heimverein)
    if not f.neutral_venue and v_res.attendance is not null then
      select case when f.comp_kind = 'domestic_cup' then ticket_price_cup else ticket_price_league end, capacity
      into v_price, v_cap from public.stadiums where club_id = f.home_club_id;
      if v_price is not null then
        perform public.fd_pay(f.home_club_id, 'ticket_income', v_res.attendance::bigint * v_price, 'fx:' || f.id || ':tickets',
          'Zuschauer ' || v_res.attendance || ' · ' || v_slot.label, f.season_id);
        perform public.fd_pay(f.home_club_id, 'stadium_running_cost', -(v_cap::bigint * 2), 'fx:' || f.id || ':stadiumcost',
          'Stadionbetrieb · ' || v_slot.label, f.season_id);
      end if;
    end if;
    -- Sperren abbüßen (nur Sperren aus früheren Spielen)
    update public.disciplinary_records d set served_matches = served_matches + 1
    from public.players p
    where p.id = d.player_id and p.club_id in (f.home_club_id, f.away_club_id)
      and d.scope = public.fd_fixture_scope(f.id) and d.season_id = f.season_id
      and d.suspension_matches > d.served_matches
      and (d.fixture_id is null or d.fixture_id not in (select public.fd_slot_fixture_ids(p_world)));
    update public.fixtures set status = 'released', released_at = now() where id = f.id;
  end loop;

  -- Gehälter je Ligaspieltag (Jahresgehalt / 34)
  if v_slot.kind = 'league' then
    for r in select pc.club_id, sum(pc.annual_salary) as total from public.player_contracts pc
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and c.association_code = 'GER' and pc.active group by pc.club_id loop
      perform public.fd_pay(r.club_id, 'salary', (-(r.total / 34))::bigint, 'slot:' || v_slot.id || ':salary:' || r.club_id, 'Gehälter · ' || v_slot.label, v_slot.season_id);
    end loop;
  end if;

  -- Pokal: nächste Runde auslosen
  if v_slot.kind = 'cup' and v_slot.cup_stage <> 'final' then
    select id into v_cup from public.competitions where season_id = v_slot.season_id and kind = 'domestic_cup';
    select array_agg(t.winner_club_id) into v_winners from public.ties t join public.competition_stages st on st.id = t.stage_id
    where st.competition_id = v_cup and st.kind = v_slot.cup_stage;
    v_next_stage := case v_slot.cup_stage when 'round_of_64' then 'round_of_32' when 'round_of_32' then 'round_of_16'
                    when 'round_of_16' then 'quarter_final' when 'quarter_final' then 'semi_final' else 'final' end;
    perform public.fd_draw_cup_round(v_cup, v_next_stage, v_winners);
  end if;

  -- Nach dem 34. Spieltag: Platzierungsprämien und Relegation
  if v_slot.kind = 'league' and v_slot.matchday = 34 then
    perform public.fd_after_last_matchday(p_world);
  end if;

  update public.season_slots set state = 'released', released_at = now() where id = v_slot.id;
  select * into v_next from public.season_slots where season_id = v_slot.season_id and ordinal = v_slot.ordinal + 1;
  -- G2: Regeneration +15 je freiem Tag bis zum nächsten Termin
  v_days := greatest(1, coalesce(v_next.slot_date, v_slot.slot_date + 7) - v_slot.slot_date);
  update public.players p set fitness = least(100, p.fitness + 15 * greatest(1, v_days - 1))
  where p.world_id = p_world and p.club_id is not null and p.fitness < 100;
  update public.career_worlds set current_slot = current_slot + 1,
    current_week = current_week + (v_slot.kind = 'league')::int,
    current_date_in_world = coalesce(v_next.slot_date, v_slot.slot_date) - 1
  where id = p_world;
end;
$$;


create or replace function public.retry_slot_release(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before integer;
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select current_slot into v_before from public.career_worlds where id = p_world;
  perform public.fd_try_release(p_world);
  return jsonb_build_object('released', (select current_slot from public.career_worlds where id = p_world) <> v_before);
end;
$$;
revoke execute on function public.retry_slot_release(uuid) from public, anon;
grant execute on function public.retry_slot_release(uuid) to authenticated;

-- Hängende Termine sofort freigeben
do $$
declare w record; v_before integer; v_after integer;
begin
  for w in select id, name, current_slot from public.career_worlds where status = 'season' loop
    begin
      perform public.fd_try_release(w.id);
      select current_slot into v_after from public.career_worlds where id = w.id;
      if v_after <> w.current_slot then raise notice 'Welt „%“: hängender Termin freigegeben.', w.name; end if;
    exception when others then
      raise warning 'Welt „%“: Freigabe fehlgeschlagen: %', w.name, sqlerrm;
    end;
  end loop;
end $$;
