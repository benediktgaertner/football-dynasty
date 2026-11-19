-- =====================================================================
-- Migration 0018: Finanzen – Gehälter, Ticketumsätze, Bilanz
--   * Gehaltsformel (identisch zu packages/shared/src/rules/economy.ts contractSalary):
--     330.000 € × 1,16^(Stärke − 70) × Alter × Spielklasse × Vereinsgröße × Laufzeit, auf 5.000 € gerundet.
--     Ein durchschnittlicher Zweitligakader (22 Spieler) kostet ≈ 6–10 Mio. € pro Jahr (vorher ≈ 25–30 Mio. €).
--   * Bestehende aktive Verträge und Free-Agent-Forderungen werden einmalig nach der Formel neu berechnet
--     (Laufzeit, Verein und Spieler bleiben; nur das Jahresgehalt ändert sich). Kontostände bleiben unverändert.
--   * Fehler behoben: Gehälter wurden je Ligatermin mit Jahresgehalt/34 abgebucht. Die Saison hat aber 38
--     Ligatermine (3. Liga mit 20 Teams), alle Vereine zahlten also 112 %. Jetzt exakt verteilt (Summe = Jahresgehalt).
--   * Buchungstext „Ticketverkauf – 16.500 Zuschauer · 3. Spieltag“, Ticketpreise während eines laufenden
--     Termins gesperrt (Zuschauerzahl und Einnahme beruhen auf demselben Preis).
--   * Spielzusammenfassung: Zuschauer, Auslastung, Ticketeinnahmen (fixture_gate); Saisonbilanz mit Tickets;
--     Abgleich Kontostand = Summe aller Buchungen.
-- =====================================================================

create or replace function public.fd_typical_tier(p_overall integer)
returns smallint language sql immutable set search_path = '' as $$
  select (case when p_overall >= 77 then 1 when p_overall >= 71 then 2 when p_overall >= 64 then 3 else 4 end)::smallint;
$$;

create or replace function public.fd_salary(p_overall integer, p_age integer, p_tier integer, p_reputation numeric, p_years integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select greatest(30000, round(
    330000 * power(1.16::numeric, p_overall - 70)
    * case when p_age <= 20 then 0.7 when p_age <= 23 then 0.85 when p_age <= 27 then 1.0 when p_age <= 30 then 1.1 when p_age <= 33 then 1.2 else 1.25 end
    * case when coalesce(p_tier, 4) <= 1 then 1.25 when p_tier = 2 then 1.0 when p_tier = 3 then 0.8 else 0.55 end
    * least(1.15, greatest(0.85, 0.85 + coalesce(p_reputation, 50) / 333))
    * case when p_years <= 1 then 1.08 when p_years = 2 then 1.04 when p_years = 3 then 1.0 when p_years = 4 then 0.97 else 0.95 end
    / 5000) * 5000)::bigint;
$$;

-- Altes Hilfsmittel bleibt aufrufbar, nutzt aber die neue Formel (Stärke aus dem Marktwert ist nicht nötig:
-- alle Aufrufer übergeben jetzt Spieler direkt). Für eventuelle Altaufrufe: grobe Rückrechnung über den Marktwert.
create or replace function public.fd_salary_demand(p_value bigint, p_age integer)
returns bigint language sql immutable set search_path = '' as $$
  select public.fd_salary(
    (case when p_value >= 20500000 then 80 when p_value >= 12600000 then 78 when p_value >= 8400000 then 76 when p_value >= 5800000 then 74
          when p_value >= 2600000 then 70 when p_value >= 800000 then 65 else 60 end), p_age, 2, 50, 3);
$$;

-- Gehaltsforderung bei Verhandlungen: Formel mit Spielklasse und Ruf des neuen Vereins
create or replace function public.fd_player_demand(p_player uuid, p_to uuid)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_from_tier smallint;
  v_to_tier smallint;
  v_rep numeric;
  v_rank integer;
  v_f numeric := 1;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  v_from_tier := case when v_p.club_id is null then public.fd_typical_tier(v_p.overall) else public.fd_tier_of(v_p.club_id, v_world.current_season_id) end;
  v_to_tier := public.fd_tier_of(p_to, v_world.current_season_id);
  select reputation into v_rep from public.clubs where id = p_to;
  select count(*) + 1 into v_rank from public.players where club_id = p_to and main_position = v_p.main_position and overall > v_p.overall;
  -- Wechsel in eine tiefere Liga kostet einen Aufschlag (gegenüber dem bisherigen Niveau)
  v_f := v_f + greatest(0, v_to_tier - v_from_tier) * 0.12;
  -- wenig Einsatzzeit in Aussicht
  v_f := v_f + case when v_rank > 2 then 0.1 * (v_rank - 2) else 0 end;
  return (round(public.fd_salary(v_p.overall, v_p.age, least(v_from_tier, v_to_tier), v_rep, 3) * least(1.6, v_f) / 5000) * 5000)::bigint;
end;
$$;

-- Angepasste Funktionen (Basis: letzte Fassung, nur markierte Stellen geändert)
create or replace function public.fd_release_slot(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_nleague integer;
  v_kleague integer;
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
          'Ticketverkauf – ' || replace(to_char(v_res.attendance, 'FM999,999'), ',', '.') || ' Zuschauer · ' || v_slot.label, f.season_id);
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
    select count(*) into v_nleague from public.season_slots where season_id = v_slot.season_id and kind = 'league';
    select count(*) into v_kleague from public.season_slots where season_id = v_slot.season_id and kind = 'league' and ordinal <= v_slot.ordinal;
    for r in select pc.club_id, sum(pc.annual_salary) as total from public.player_contracts pc
             join public.clubs c on c.id = pc.club_id where c.world_id = p_world and c.association_code = 'GER' and pc.active group by pc.club_id loop
      -- Jahresgehalt exakt auf alle Ligatermine der Saison verteilt (Summe = Jahresgehalt, Rundungsrest im letzten Termin)
      perform public.fd_pay(r.club_id, 'salary', -(floor(r.total * v_kleague / v_nleague) - floor(r.total * (v_kleague - 1) / v_nleague))::bigint, 'slot:' || v_slot.id || ':salary:' || r.club_id, 'Gehälter · ' || v_slot.label, v_slot.season_id);
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

create or replace function public.sell_to_ai(p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_win public.transfer_windows;
  v_buyer uuid;
  v_fee bigint;
  v_tier smallint;
  v_name text;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or not public.is_club_manager(v_p.club_id) then raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_sell(v_p.club_id, v_win);
  v_fee := (round(v_p.market_value * (0.85 + public.fd_hash01(v_p.id::text || v_win.id::text) * 0.1) / 100000) * 100000)::bigint;
  v_tier := case when v_p.overall >= 78 then 1 when v_p.overall >= 71 then 2 when v_p.overall >= 64 then 3 else 4 end;
  select c.id into v_buyer from public.clubs c join public.finances f on f.club_id = c.id
  where c.world_id = v_p.world_id and c.control = 'ai' and not c.amateur and f.balance >= v_fee
    and public.fd_tier_of(c.id, v_world.current_season_id) in (v_tier, greatest(1, v_tier - 1))
    and (select count(*) from public.players where club_id = c.id) < 28
    and (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = c.id and t.kind in ('transfer', 'free_agent')) < 5
  order by (public.fd_tier_of(c.id, v_world.current_season_id) = v_tier) desc, md5(c.id::text || p_player::text) limit 1;
  if v_buyer is null then
    return jsonb_build_object('status', 'rejected', 'message', 'Kein KI-Verein kann sich den Spieler gerade leisten.');
  end if;
  select c.name || case when c.association_code <> 'GER' then ' (' || a.name || ')' else '' end into v_name
  from public.clubs c join public.associations a on a.code = c.association_code where c.id = v_buyer;
  perform public.fd_complete_transfer(p_player, v_p.club_id, v_buyer, v_fee, public.fd_salary(v_p.overall, v_p.age, public.fd_tier_of(v_buyer, v_world.current_season_id), (select reputation from public.clubs where id = v_buyer), 3), 3, null, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'fee', v_fee, 'buyer', v_name,
    'message', v_p.last_name || ' wechselt für ' || to_char(v_fee / 1e6, 'FM999990D0') || ' Mio. € zu ' || v_name || '.');
end;
$$;

create or replace function public.release_player(p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_c public.player_contracts;
  v_world public.career_worlds;
  v_comp bigint;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or not public.is_club_manager(v_p.club_id) then raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden'; end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  if public.fd_open_window(v_p.world_id) is null or (public.fd_open_window(v_p.world_id)).id is null then
    raise exception 'Freistellungen sind nur im Transferfenster möglich.' using errcode = 'P0001', hint = 'window_closed';
  end if;
  if (select count(*) from public.players where club_id = v_p.club_id) <= 16 then
    raise exception 'Der Kader darf nicht unter 16 Spieler fallen.' using errcode = 'P0001', hint = 'squad_min';
  end if;
  select * into v_c from public.player_contracts where player_id = p_player and active;
  v_comp := coalesce(v_c.annual_salary, 0) * greatest(0, v_c.end_season_year - public.fd_season_year(v_world.current_season_id) + 1) / 2;
  perform public.fd_pay(v_p.club_id, 'adjustment', -v_comp, 'release:' || p_player || ':' || now()::text, 'Abfindung ' || v_p.last_name, v_world.current_season_id);
  update public.tactical_profile_slots s set player_id = null from public.tactical_profiles t where t.id = s.profile_id and t.club_id = v_p.club_id and s.player_id = p_player;
  delete from public.player_instructions pi using public.tactical_profiles t where t.id = pi.profile_id and t.club_id = v_p.club_id and pi.player_id = p_player;
  delete from public.set_piece_assignments where club_id = v_p.club_id and player_id = p_player;
  update public.player_contracts set active = false where player_id = p_player and active;
  insert into public.transfers(world_id, season_id, window_id, player_id, from_club_id, kind)
  values (v_p.world_id, v_world.current_season_id, (public.fd_open_window(v_p.world_id)).id, p_player, v_p.club_id, 'release');
  update public.players set club_id = null, shirt_number = null where id = p_player;
  insert into public.free_agents(player_id, world_id, annual_salary) values (p_player, v_p.world_id, public.fd_salary(v_p.overall, v_p.age, public.fd_typical_tier(v_p.overall), 50, 2))
  on conflict (player_id) do nothing;
  return jsonb_build_object('status', 'released', 'compensation', v_comp);
end;
$$;

create or replace function public.set_ticket_prices(p_world uuid, p_league integer, p_cup integer, p_international integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_club uuid := public.fd_require_team(p_world);
begin
  if p_league not between 5 and 500 or p_cup not between 5 and 500 or p_international not between 5 and 500 then
    raise exception 'Ticketpreise zwischen 5 und 500 €.' using errcode = '22023', hint = 'invalid';
  end if;
  -- Während eines laufenden Termins gesperrt: Zuschauerzahl (bei Anpfiff) und Einnahmen (bei Freigabe) nutzen denselben Preis
  if (public.fd_current_slot(p_world)).state = 'live' then
    raise exception 'Ticketpreise können während eines laufenden Spieltags nicht geändert werden.' using errcode = 'P0001', hint = 'slot_live';
  end if;
  update public.stadiums set ticket_price_league = p_league, ticket_price_cup = p_cup, ticket_price_international = p_international where club_id = v_club;
end;
$$;

-- Ticketumsatz, Zuschauer und Auslastung eines Spiels (nur wenn das Ergebnis sichtbar ist)
create or replace function public.fixture_gate(p_fixture uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_att integer;
  v_cap integer;
  v_price integer;
  v_kind text;
  v_income bigint;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  if not found or not public.is_world_member(v_f.world_id) or not public.can_see_fixture_result(p_fixture) then return null; end if;
  select attendance into v_att from public.fixture_results where fixture_id = p_fixture;
  if v_att is null or v_f.neutral_venue then return null; end if;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  select capacity, case when v_kind = 'domestic_cup' then ticket_price_cup else ticket_price_league end into v_cap, v_price
  from public.stadiums where club_id = v_f.home_club_id;
  -- Verbuchte Einnahme (nach Freigabe), sonst Zuschauer × aktueller (während des Termins gesperrter) Preis
  select amount into v_income from public.financial_transactions where club_id = v_f.home_club_id and idempotency_key = 'fx:' || p_fixture || ':tickets';
  return jsonb_build_object('attendance', v_att, 'capacity', v_cap, 'utilization', round(v_att::numeric / greatest(v_cap, 1) * 100, 1),
    'ticket_price', v_price, 'income', coalesce(v_income, v_att::bigint * v_price), 'booked', v_income is not null,
    'home_club_id', v_f.home_club_id, 'friendly', v_kind = 'friendly');
end;
$$;

create or replace function public.finance_overview(p_world uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_nleague integer;
begin
  select * into v_world from public.career_worlds where id = p_world;
  select count(*) into v_nleague from public.season_slots where season_id = v_world.current_season_id and kind = 'league';
  return jsonb_build_object(
    'balance', (select balance from public.finances where club_id = v_club),
    'salaries', (select coalesce(sum(annual_salary), 0) from public.player_contracts where club_id = v_club and active),
    'squad_size', (select count(*) from public.players where club_id = v_club),
    'league_slots', greatest(v_nleague, 1),
    'stadium', (select to_jsonb(s) - 'world_id' from public.stadiums s where s.club_id = v_club),
    'status', v_world.status,
    'slot_live', (public.fd_current_slot(p_world)).state = 'live',
    'season_totals', coalesce((select jsonb_object_agg(kind, total) from (
        select kind, sum(amount) as total from public.financial_transactions where club_id = v_club and season_id = v_world.current_season_id group by kind) x), '{}'::jsonb),
    'season_sum', (select coalesce(sum(amount), 0) from public.financial_transactions where club_id = v_club and season_id = v_world.current_season_id),
    'tickets', (select jsonb_build_object('income', coalesce(sum(t.amount), 0), 'games', count(*),
                  'avg_attendance', coalesce(round(avg(r.attendance)), 0),
                  'avg_utilization', coalesce(round(avg(r.attendance::numeric / greatest(st.capacity, 1)) * 100, 1), 0))
                from public.financial_transactions t
                join public.fixtures f on t.idempotency_key = 'fx:' || f.id || ':tickets'
                join public.fixture_results r on r.fixture_id = f.id
                join public.stadiums st on st.club_id = v_club
                where t.club_id = v_club and t.kind = 'ticket_income' and t.season_id = v_world.current_season_id),
    -- Kontrolle: Kontostand muss der Summe aller Buchungen entsprechen
    'ledger_ok', (select f.balance = coalesce((select sum(amount) from public.financial_transactions where club_id = v_club), 0) from public.finances f where f.club_id = v_club),
    'transactions', coalesce((select jsonb_agg(to_jsonb(t) - 'world_id' - 'idempotency_key' order by t.id desc) from (
        select * from public.financial_transactions where club_id = v_club order by id desc limit 80) t), '[]'::jsonb),
    'last_attendance', (select jsonb_build_object('attendance', r.attendance, 'label', s.label) from public.fixtures f
        join public.fixture_results r on r.fixture_id = f.id join public.season_slots s on s.season_id = f.season_id and s.slot_key = f.slot_key
        where f.home_club_id = v_club and f.status = 'released' and r.attendance is not null order by f.scheduled_date desc limit 1)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Einmalige Neuberechnung bestehender Gehälter (kontrolliert, protokolliert)
-- ---------------------------------------------------------------------
create table if not exists public.fd_data_migrations (key text primary key, applied_at timestamptz not null default now(), info jsonb);
alter table public.fd_data_migrations enable row level security;

create or replace function public.fd_rescale_salaries(p_world uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer; v_fa integer; v_before numeric; v_after numeric;
begin
  select coalesce(sum(annual_salary), 0) into v_before from public.player_contracts where active and (p_world is null or world_id = p_world);
  update public.player_contracts pc
  set annual_salary = public.fd_salary(p.overall, p.age, public.fd_tier_of(pc.club_id, w.current_season_id), c.reputation,
                                       greatest(1, pc.end_season_year - pc.start_season_year + 1))
  from public.players p, public.clubs c, public.career_worlds w
  where pc.active and p.id = pc.player_id and c.id = pc.club_id and w.id = pc.world_id and (p_world is null or pc.world_id = p_world);
  get diagnostics v_n = row_count;
  update public.free_agents fa set annual_salary = public.fd_salary(p.overall, p.age, public.fd_typical_tier(p.overall), 50, 2)
  from public.players p where p.id = fa.player_id and (p_world is null or fa.world_id = p_world);
  get diagnostics v_fa = row_count;
  select coalesce(sum(annual_salary), 0) into v_after from public.player_contracts where active and (p_world is null or world_id = p_world);
  return jsonb_build_object('contracts', v_n, 'free_agents', v_fa, 'total_before', v_before, 'total_after', v_after);
end;
$$;
revoke execute on function public.fd_rescale_salaries(uuid) from public, anon, authenticated;

do $$
declare v_info jsonb;
begin
  if exists (select 1 from public.fd_data_migrations where key = '0018_salaries') then return; end if;
  v_info := public.fd_rescale_salaries(null);
  insert into public.fd_data_migrations(key, info) values ('0018_salaries', v_info);
  raise notice 'Gehälter neu berechnet: %', v_info;
end $$;

-- Amateurvereine: Startkapital als Buchung (vorher direkt aufs Konto, Kontostand ≠ Summe der Buchungen)
create or replace function public.fd_ensure_amateurs(p_world uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_need integer;
  v_prefix text[] := array['SV', 'TuS', 'FC', 'SpVgg', 'TSV', 'SC', 'VfL', 'SG', 'FV', 'DJK'];
  v_towns text[] := array['Hollerbach', 'Kesselbrunn', 'Lindenau', 'Morsbach', 'Eichenried', 'Weidenthal', 'Steinwalde',
                          'Birkenhain', 'Rosenau', 'Falkenried', 'Grünwiesen', 'Ahornfeld', 'Buchenloh', 'Erlenbrück',
                          'Haselgrund', 'Mühlenau', 'Tannheim', 'Ulmenhof', 'Wiesenbach', 'Zedernfeld'];
  v_i integer;
  v_club uuid;
  v_name text;
  v_short text;
  v_target integer;
  v_n integer := 0;
  v_ger uuid[];
  v_first text[];
  v_last text[];
begin
  select * into v_world from public.career_worlds where id = p_world;
  if (select count(*) from public.clubs where world_id = p_world and amateur) >= 10 then return; end if;
  -- Quellen einmalig: deutsche Vereine und Namenslisten (nicht der ganze europäische Pool)
  select array_agg(id) into v_ger from public.clubs where world_id = p_world and association_code = 'GER' and not amateur;
  select array_agg(first_name order by id), array_agg(last_name order by md5(id::text)) into v_first, v_last
  from public.players where world_id = p_world and club_id = any(v_ger);
  create temp table if not exists fd_tmp_ama_src (src_id uuid, rn integer, is_gk boolean) on commit drop;
  v_need := 10 - (select count(*) from public.clubs where world_id = p_world and amateur);
  v_i := 0;
  while v_need > 0 and v_i < 200 loop
    v_i := v_i + 1;
    v_name := v_prefix[1 + floor(public.fd_hash01(v_world.seed || ':ap:' || v_i) * 10)::int] || ' '
           || v_towns[1 + floor(public.fd_hash01(v_world.seed || ':at:' || v_i) * 20)::int];
    v_short := 'AM' || lpad(((select count(*) from public.clubs where world_id = p_world and amateur) + 1 + v_n)::text, 2, '0');
    if exists (select 1 from public.clubs where world_id = p_world and (name_normalized = public.normalize_name(v_name) or short_name_normalized = public.normalize_name(v_short)))
       or exists (select 1 from public.club_name_blocklist b where b.name_normalized = public.normalize_name(v_name)) then
      continue;
    end if;
    insert into public.clubs(world_id, association_code, name, short_name, control, reputation, amateur, name_normalized, short_name_normalized)
    values (p_world, 'GER', v_name, v_short, 'ai', 25, true, '', '')
    returning id into v_club;
    insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
    select v_club, p_world, b.primary_color, b.secondary_color, b.accent_color, b.crest, b.kit
    from public.club_branding b join public.clubs c on c.id = b.club_id
    where c.world_id = p_world and c.control = 'ai' and not c.amateur
    order by md5(v_club::text || b.club_id::text) limit 1;
    -- Kader: 16 Feldspieler + 2 Torhüter, schwächer, abgeleitet aus Spielern deutscher Vereine.
    -- Eine Sortierung je Verein (Quelle), Namen per Index aus vorab gesammelten Listen, Attribute
    -- skaliert vom Quellspieler – schnell auch bei sehr großem (europaweitem) Spielerpool.
    v_target := 58 + floor(public.fd_hash01(v_club::text) * 6)::int;
    delete from fd_tmp_ama_src where true;
    insert into fd_tmp_ama_src(src_id, rn, is_gk)
    select x.id, x.rn, x.is_gk from (
      select pl.id, pl.main_position = 'GK' as is_gk,
             row_number() over (partition by (pl.main_position = 'GK') order by md5(v_club::text || pl.id::text)) as rn
      from public.players pl where pl.world_id = p_world and not pl.retired and pl.club_id = any(v_ger)
    ) x where (x.is_gk and x.rn <= 2) or (not x.is_gk and x.rn <= 16);
    insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                               overall, fitness, market_value, shirt_number, club_id)
    select p_world,
           v_first[1 + floor(public.fd_hash01(v_club::text || s.src_id::text || 'f') * array_length(v_first, 1))::int],
           v_last[1 + floor(public.fd_hash01(v_club::text || s.src_id::text || 'l') * array_length(v_last, 1))::int],
           p.nationality, p.region, p.age, p.main_position, p.secondary_positions,
           greatest(40, least(70, v_target + (p.overall - 70) / 4)), 100, 100000,
           case when s.is_gk then (case when s.rn = 1 then 1 else 18 end) else s.rn + 1 end, v_club
    from fd_tmp_ama_src s join public.players p on p.id = s.src_id
    order by s.is_gk desc, s.rn;
    -- Attribute: skaliert vom Quellspieler gleicher Position (Zuordnung über Trikotnummer)
    insert into public.player_attributes(player_id, world_id, kind, attributes)
    select np.id, p_world, pa.kind,
           (select jsonb_object_agg(k, greatest(20, least(80, round((v::numeric) * np.overall / greatest(op.overall, 1)))))
            from jsonb_each_text(pa.attributes) as a(k, v))
    from public.players np
    join fd_tmp_ama_src s on (case when s.is_gk then (case when s.rn = 1 then 1 else 18 end) else s.rn + 1 end) = np.shirt_number
    join public.players op on op.id = s.src_id
    join public.player_attributes pa on pa.player_id = op.id
    where np.club_id = v_club;
    insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 0);
    perform public.post_transaction(v_club, 'starting_capital', 2000000, 'start:' || v_club, 'Startkapital', v_world.current_season_id);
    perform public.fd_init_club_tactics(p_world, v_club, '4-4-2');
    v_need := v_need - 1;
    v_n := v_n + 1;
  end loop;
end;
$$;


-- Einmaliger Abgleich: fehlende Buchung für bereits vorhandene Abweichungen nachtragen (Kontostand unverändert)
do $$
declare r record; v_n integer := 0;
begin
  for r in select f.club_id, f.world_id, f.balance, coalesce((select sum(t.amount) from public.financial_transactions t where t.club_id = f.club_id), 0) as booked
           from public.finances f loop
    if r.balance <> r.booked then
      insert into public.financial_transactions(world_id, club_id, season_id, kind, amount, balance_after, idempotency_key, description)
      values (r.world_id, r.club_id, null, 'starting_capital', r.balance - r.booked, r.balance, 'reconcile:' || r.club_id, 'Startkapital (nachgetragen)')
      on conflict on constraint financial_transactions_idem do nothing;
      v_n := v_n + 1;
    end if;
  end loop;
  if v_n > 0 then raise notice 'Kontoabgleich: % Vereine nachgebucht', v_n; end if;
end $$;

-- Rechte
revoke execute on function public.fd_salary(integer, integer, integer, numeric, integer) from public, anon;
revoke execute on function public.fd_typical_tier(integer) from public, anon;
grant execute on function public.fd_salary(integer, integer, integer, numeric, integer) to authenticated, service_role;
grant execute on function public.fd_typical_tier(integer) to authenticated, service_role;
revoke execute on function public.fixture_gate(uuid) from public, anon;
grant execute on function public.fixture_gate(uuid) to authenticated;
