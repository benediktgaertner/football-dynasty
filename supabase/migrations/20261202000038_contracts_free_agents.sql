-- =============================================================================
-- 0038: Vertragsmanagement beim Saisonabschluss + saisonaler Free-Agent-Markt
-- =============================================================================
-- Ablauf der Saison: Nach dem letzten Termin (Relegation/Pokalfinale) steht der Termin „Saisonabschluss“ (kind season_end)
-- an. Solange er nicht gestartet ist, befindet sich die Welt im Saisonabschluss (Phase fd_season_end_phase): Verträge
-- können verhandelt werden, reguläre Transfers sind gesperrt. Mit dem Start des Termins läuft fd_end_season:
--   * Pläne der Manager werden angewandt (Verlängerung/neues Gehalt/Dauer ab der neuen Saison, Abgänge),
--   * undecided auslaufende Verträge menschlicher Vereine werden um ein Jahr zu unveränderten Konditionen verlängert
--     (Kaderschutz; der Hinweis steht in der App),
--   * KI-Vereine (auch internationale) verwalten ihre Verträge set-basiert nach denselben Grundsätzen (Barometer),
--   * höchstens wenige Spieler pro Saison werden neue Free Agents (Verteilung nach Stärke, nie > 82 OVR).
-- Vertragsattraktivität (Barometer 0–100): packages/shared/src/rules/contracts.ts (identisch zu fd_contract_prob).

alter type public.transaction_kind add value if not exists 'contract_termination';

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------
-- Entscheidung je Spieler und Saison (genau eine; Primärschlüssel verhindert Doppelabschlüsse)
create table if not exists public.contract_plans (
  player_id uuid not null references public.players(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  action text not null check (action in ('renew', 'leave')),
  new_salary bigint check (new_salary is null or new_salary > 0),
  new_years smallint check (new_years is null or new_years between 1 and 5),
  new_end_year integer,
  previous_salary bigint,
  barometer smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  primary key (player_id, season_id),
  constraint contract_plans_renew_fields check (action <> 'renew' or (new_salary is not null and new_years is not null and new_end_year is not null))
);
create index if not exists contract_plans_world_season on public.contract_plans(world_id, season_id);
alter table public.contract_plans enable row level security;
revoke all on public.contract_plans from anon, authenticated;

-- Protokoll des saisonalen Free-Agent-Markts (je Welt und Saison genau einmal)
create table if not exists public.fd_fa_market_log (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  created_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb,
  primary key (world_id, season_id)
);
alter table public.fd_fa_market_log enable row level security;
revoke all on public.fd_fa_market_log from anon, authenticated;

create table if not exists public.fd_fa_market_players (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  overall smallint not null,
  from_club_id uuid references public.clubs(id) on delete set null,
  primary key (season_id, player_id)
);
alter table public.fd_fa_market_players enable row level security;
revoke all on public.fd_fa_market_players from anon, authenticated;

-- ---------------------------------------------------------------------
-- Saisonabschluss-Phase und serverseitige Transfersperre
-- ---------------------------------------------------------------------
create or replace function public.fd_season_end_phase(p_world uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.career_worlds w
    left join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
    where w.id = p_world and (w.status::text = 'season_end' or (w.status::text = 'season' and s.kind = 'season_end' and s.state <> 'released')));
$$;

-- Während des Saisonabschlusses ist kein Transferfenster offen (alle Transfer-RPCs prüfen das Fenster)
create or replace function public.fd_open_window(p_world uuid)
returns public.transfer_windows
language plpgsql
stable
set search_path = ''
as $$
declare
  v_world public.career_worlds;
  v_next smallint;
  v_win public.transfer_windows;
begin
  select * into v_world from public.career_worlds where id = p_world;
  -- Saisonabschluss: keine regulären Transfers
  if public.fd_season_end_phase(p_world) then return null; end if;
  if v_world.status = 'preseason' then
    select * into v_win from public.transfer_windows where season_id = v_world.current_season_id and window_no = 1;
    return v_win;
  end if;
  if v_world.status <> 'season' then return null; end if;
  select min(s.matchday) into v_next from public.season_slots s
  where s.season_id = v_world.current_season_id and s.kind = 'league' and s.state <> 'released';
  select * into v_win from public.transfer_windows w
  where w.season_id = v_world.current_season_id and v_next between w.next_matchday_from and w.next_matchday_to;
  return v_win;
end;
$$;


-- Zusätzliche Sicherung an der zentralen Stelle jedes Wechsels
CREATE OR REPLACE FUNCTION public.fd_complete_transfer(p_player uuid, p_from uuid, p_to uuid, p_fee bigint, p_salary bigint, p_years integer, p_offer uuid, p_kind transfer_kind, p_window uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_p public.players;
  v_world public.career_worlds;
  v_year integer;
  v_shirt smallint;
begin
  select * into v_p from public.players where id = p_player for update;
  if public.fd_season_end_phase(v_p.world_id) then
    raise exception 'Im Saisonabschluss sind keine Transfers möglich.' using errcode = 'P0001', hint = 'season_end_phase';
  end if;
  if v_p.temporary then
    raise exception 'Ergänzungsspieler sind nicht transferierbar.' using errcode = 'P0001', hint = 'not_transferable';
  end if;
  select * into v_world from public.career_worlds where id = v_p.world_id;
  v_year := public.fd_season_year(v_world.current_season_id);
  if p_fee > 0 then
    perform public.post_transaction(p_to, 'transfer_fee_paid', -p_fee, 'transfer:' || coalesce(p_offer::text, p_player::text || ':' || now()::text) || ':paid',
      'Ablöse ' || v_p.first_name || ' ' || v_p.last_name, v_world.current_season_id,
      (select control = 'ai' from public.clubs where id = p_to));
    if p_from is not null then
      perform public.fd_pay(p_from, 'transfer_fee_received', p_fee, 'transfer:' || coalesce(p_offer::text, p_player::text || ':' || now()::text) || ':recv',
        'Verkauf ' || v_p.first_name || ' ' || v_p.last_name, v_world.current_season_id);
    end if;
  end if;
  update public.player_contracts set active = false where player_id = p_player and active;
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  values (v_p.world_id, p_player, p_to, v_year, v_year + greatest(1, least(5, p_years)) - 1, p_salary, v_p.age);
  -- Trikotnummer: Wunschnummer, sonst niedrigste freie
  select n into v_shirt from (
    select coalesce(v_p.preferred_shirt_number, v_p.shirt_number) as n where coalesce(v_p.preferred_shirt_number, v_p.shirt_number) is not null
    union all select g::smallint from generate_series(2, 99) g
  ) x where n not in (select shirt_number from public.players where club_id = p_to and shirt_number is not null) limit 1;
  -- Aus Aufstellungen, Anweisungen und Standards des alten Vereins entfernen
  if p_from is not null then
    update public.tactical_profile_slots s set player_id = null from public.tactical_profiles t
    where t.id = s.profile_id and t.club_id = p_from and s.player_id = p_player;
    delete from public.player_instructions pi using public.tactical_profiles t where t.id = pi.profile_id and t.club_id = p_from and pi.player_id = p_player;
    delete from public.set_piece_assignments where club_id = p_from and player_id = p_player;
  end if;
  update public.players set club_id = p_to, shirt_number = v_shirt, in_draft_pool = false where id = p_player;
  delete from public.free_agents where player_id = p_player;
  insert into public.transfers(world_id, season_id, window_id, player_id, from_club_id, to_club_id, kind, fee, offer_id)
  values (v_p.world_id, v_world.current_season_id, p_window, p_player, p_from, p_to, p_kind, p_fee, p_offer);
  update public.transfer_offers set status = 'expired', responded_at = now()
  where player_id = p_player and status in ('pending', 'countered') and (p_offer is null or id <> p_offer);
end;
$function$

;


-- Freistellung (Fenster-Regel unverändert): Spieler über 82 OVR werden nie ablösefrei Free Agent
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
  if v_p.overall > 82 then
    raise exception 'Spieler über 82 OVR verlassen den Verein nie ablösefrei. Verkaufe den Spieler über den Transfermarkt.' using errcode = 'P0001', hint = 'elite_stays';
  end if;
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


-- ---------------------------------------------------------------------
-- Vertragsattraktivität (identisch zu packages/shared/src/rules/contracts.ts)
-- ---------------------------------------------------------------------
create or replace function public.fd_contract_reference(p_s0 double precision, p_market double precision, p_dovr integer,
                                                       p_rating double precision, p_share double precision, p_age integer)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select p_s0 * (1 + greatest(-0.2, least(0.6,
      case when p_dovr > 0 then 0.07 * p_dovr else 0.03 * p_dovr end
    + greatest(-0.15, least(0.25, 0.35 * ln(p_market / p_s0)))
    + case when p_age >= 31 then -0.02 * (p_age - 30) else 0 end
    + case when p_rating is not null and p_share is not null and p_share >= 0.3 then 0.12 * (p_rating - 6.5) else 0 end)));
$$;

create or replace function public.fd_contract_utility(p_s0 double precision, p_s1 double precision, p_market double precision, p_ovr integer, p_dovr integer,
                                                     p_rating double precision, p_share double precision, p_age integer, p_years integer,
                                                     p_tier integer, p_place integer, p_teams integer, p_rep double precision)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 10
    + 60 * (case when p_age >= 31 then 1.15 else 1 end) * ln(p_s1 / public.fd_contract_reference(p_s0, p_market, p_dovr, p_rating, p_share, p_age))
    + (case when p_age <= 24 then 14 else 6 end) * (coalesce(p_share, case when p_age <= 24 then 0.5 else 0.4 end) - (case when p_age <= 24 then 0.5 else 0.4 end))
    - 1.5 * abs(p_years - (case when p_age <= 23 then 4 when p_age >= 31 then 2 else 3 end))
    + greatest(0.5, least(1.3, 0.6 + (p_ovr - 65) / 25.0))
      * ((case when p_tier <= 1 then 6 when p_tier = 2 then 0 when p_tier = 3 then -6 else -12 end)
         + (case when p_place is null or p_teams is null then 0 when p_place <= 3 then 3 when p_place >= p_teams - 2 then -3 else 0 end))
    + 0.1 * (p_rep - 50);
$$;

create or replace function public.fd_contract_prob(p_s0 double precision, p_s1 double precision, p_market double precision, p_ovr integer, p_dovr integer,
                                                  p_rating double precision, p_share double precision, p_age integer, p_years integer,
                                                  p_tier integer, p_place integer, p_teams integer, p_rep double precision)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select 1 / (1 + exp(-public.fd_contract_utility(p_s0, p_s1, p_market, p_ovr, p_dovr, p_rating, p_share, p_age, p_years, p_tier, p_place, p_teams, p_rep) / 6));
$$;

-- Feste Zufallszahl des Spielers für diese Saison (deterministisch; Zusage, wenn x < Barometer)
create or replace function public.fd_contract_x(p_player uuid, p_season uuid)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select public.fd_hash01(p_player::text || ':' || p_season::text || ':contract');
$$;

-- Abfindung: Restgehalt (volle verbleibende Saisons) × 0,7, auf 100 € gerundet
create or replace function public.fd_contract_termination_fee(p_salary bigint, p_remaining integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (round(p_salary * greatest(0, p_remaining) * 0.7 / 100) * 100)::bigint;
$$;

-- Eingangsdaten je Spieler (Vertrag, Entwicklung, Einsätze, Verein) für Barometer, Anzeige und KI-Durchlauf.
-- p_club null: alle Vereine der Welt (set-basiert), sonst ein Verein.
create or replace function public.fd_contract_rows(p_world uuid, p_season uuid, p_club uuid default null)
returns table (
  r_player uuid, r_club uuid, r_contract uuid, r_salary bigint, r_start integer, r_end integer,
  r_ovr integer, r_ovr_start integer, r_age integer, r_pos text, r_grp text, r_value bigint,
  r_apps integer, r_minutes integer, r_rating numeric, r_share double precision,
  r_tier integer, r_place integer, r_teams integer, r_rep numeric, r_market bigint)
language sql
stable
set search_path = ''
as $$
  with ctx as (
    select c.id as club_id,
           coalesce(l.tier, case when c.amateur then 4 else 2 end)::int as tier,
           l.pos as place, l.teams, coalesce(c.reputation, 50) as rep,
           (select count(*) from public.fixtures f join public.competitions co on co.id = f.competition_id
             where f.season_id = p_season and f.status = 'released' and co.kind::text <> 'friendly'
               and c.id in (f.home_club_id, f.away_club_id))::int as games
    from public.clubs c
    left join lateral (
      select co.tier::int as tier, tb.pos, (select count(*) from public.competition_entries x where x.competition_id = co.id)::int as teams
      from public.competition_entries e
      join public.competitions co on co.id = e.competition_id and co.season_id = p_season and co.kind = 'league'
      left join lateral public.fd_table(co.id) tb on tb.club_id = e.club_id
      where e.club_id = c.id limit 1) l on true
    where c.world_id = p_world and (p_club is null or c.id = p_club)
  ),
  st as (
    select s.player_id, count(*) filter (where s.minutes > 0)::int as apps, sum(s.minutes)::int as minutes,
           avg(s.rating) filter (where s.minutes > 0 and s.rating is not null) as rating
    from public.match_player_stats s
    join public.fixtures f on f.id = s.fixture_id
    join public.competitions co on co.id = f.competition_id
    where s.world_id = p_world and f.season_id = p_season and f.status = 'released' and co.kind::text <> 'friendly'
      and (p_club is null or s.player_id in (select pp.id from public.players pp where pp.club_id = p_club))
    group by s.player_id
  )
  select p.id, p.club_id, pc.id, pc.annual_salary, pc.start_season_year, pc.end_season_year,
         p.overall::int, coalesce(d.ovr_start, p.overall)::int, p.age::int, p.main_position::text,
         public.fd_pos_group(p.main_position::text), p.market_value,
         coalesce(st.apps, 0), coalesce(st.minutes, 0), round(st.rating, 2),
         case when x.games > 0 then least(1::double precision, coalesce(st.minutes, 0)::double precision / (x.games * 90)) end,
         x.tier, x.place, x.teams, x.rep, public.fd_salary(p.overall, p.age, x.tier, x.rep, 3)
  from public.players p
  join public.player_contracts pc on pc.player_id = p.id and pc.active
  join ctx x on x.club_id = p.club_id
  left join public.player_season_development d on d.player_id = p.id and d.season_id = p_season
  left join st on st.player_id = p.id
  where p.world_id = p_world and not p.retired and not p.temporary and p.club_id is not null;
$$;

-- ---------------------------------------------------------------------
-- Free-Agent-Nutzenmodell: starke Spieler sind für tiefere Ligen deutlich teurer
-- ---------------------------------------------------------------------
-- Zusatzabzug im Basisnutzen: ab 76 OVR (voll ab 82) je Spielklasse unter der ersten Liga 10 Punkte
-- (≈ +30 % Gehalt je Stufe bei durchschnittlicher Geldorientierung)
create or replace function public.fd_fa_elite_penalty(p_overall integer, p_tier integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(10 * greatest(0, coalesce(p_tier, 4) - 1) * least(1, greatest(0, (p_overall - 76) / 6.0))::numeric, 2);
$$;

create or replace function public.fd_fa_base(p_player uuid, p_club uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_c public.clubs;
  v_season uuid;
  v_tier integer;
  v_comp uuid;
  v_pos integer;
  v_n integer;
  v_played integer;
  v_better integer;
  v_form numeric;
  v_amb numeric;
  v_sport numeric;
  v_play numeric;
  v_m numeric;
  v_minrep numeric;
  v_ec text;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_c from public.clubs where id = p_club;
  if v_p.id is null or v_c.id is null or v_c.world_id <> v_p.world_id or v_c.amateur then return null; end if;
  select current_season_id into v_season from public.career_worlds where id = v_p.world_id;
  select co.id, co.tier into v_comp, v_tier from public.competition_entries e join public.competitions co on co.id = e.competition_id
  where e.club_id = p_club and co.season_id = v_season and co.kind = 'league' limit 1;
  v_tier := coalesce(v_tier, 4);
  -- Tabellenplatz (sonst Rang nach Reputation) als Titel-/Aufstiegschance
  if v_comp is not null then
    select t.pos into v_pos from public.fd_table(v_comp) t where t.club_id = p_club;
    select count(*) into v_n from public.competition_entries where competition_id = v_comp;
    select played into v_played from public.standings where competition_id = v_comp and club_id = p_club and group_id is null;
    if coalesce(v_played, 0) = 0 then
      select 1 + count(*) into v_pos from public.competition_entries e join public.clubs c2 on c2.id = e.club_id
      where e.competition_id = v_comp and c2.reputation > v_c.reputation;
    end if;
  end if;
  -- Form: Punkte der letzten fünf Ligaspiele
  select coalesce(sum(case when (f.home_club_id = p_club and r.home_goals > r.away_goals) or (f.away_club_id = p_club and r.away_goals > r.home_goals) then 3
                           when r.home_goals = r.away_goals then 1 else 0 end)::numeric / nullif(count(*) * 3, 0), 0.5)
  into v_form from (
    select f.* from public.fixtures f join public.competitions co on co.id = f.competition_id
    where co.season_id = v_season and co.kind = 'league' and f.status = 'released' and p_club in (f.home_club_id, f.away_club_id)
    order by f.scheduled_date desc limit 5) f
  join public.fixture_results r on r.fixture_id = f.id;
  select case when exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                           where e.club_id = p_club and co.season_id = v_season and co.kind::text = 'champions_league') then 'cl'
              when exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                           where e.club_id = p_club and co.season_id = v_season and co.kind::text = 'europa_league') then 'el' end into v_ec;
  -- Erwartete Einsatzzeit: bessere Spieler derselben Positionsgruppe
  select count(*) into v_better from public.players p
  where p.club_id = p_club and not p.retired and p.overall > v_p.overall
    and public.fd_pos_group(p.main_position::text) = public.fd_pos_group(v_p.main_position::text);

  v_m := public.fd_fa_money_pref(p_player, v_p.age);
  -- Ehrgeiz: stärkere Spieler gewichten Sportliches stärker, geldorientierte schwächer
  v_amb := greatest(0.5, least(1.3, 0.6 + (v_p.overall - 65) / 25.0)) * (1.5 - 0.5 * v_m) * case when v_p.age >= 31 then 0.85 else 1 end;
  v_sport := case v_tier when 1 then 12 when 2 then 0 when 3 then -12 else -30 end
           + case v_ec when 'cl' then 6 when 'el' then 3 else 0 end
           + case when v_pos is null then 0
                  when v_tier = 1 then 6 * greatest(0, (5 - v_pos) / 4.0) - case when v_pos >= coalesce(v_n, 18) - 2 then 3 else 0 end
                  else 5 * greatest(0, (5 - v_pos) / 4.0) - case when v_pos >= coalesce(v_n, 18) - 2 then 3 else 0 end end
           + 4 * (coalesce(v_form, 0.5) - 0.5) * 2;
  v_play := case when v_better = 0 then 10 when v_better = 1 then 5 when v_better = 2 then 0 when v_better = 3 then -6 else -12 end
          * case when v_p.age <= 23 then 1.4 when v_p.age >= 31 then 0.7 else 1 end;
  select min_club_reputation into v_minrep from public.free_agents where player_id = p_player;
  return round(v_sport * v_amb + 0.12 * (coalesce(v_c.reputation, 40) - 50) + v_play
               - case when coalesce(v_c.reputation, 0) < coalesce(v_minrep, 0) then 10 else 0 end
               - public.fd_fa_elite_penalty(v_p.overall::integer, v_tier::integer)
               + (public.fd_hash01(p_player::text || p_club::text || ':fa')::numeric - 0.5) * 6, 2);
end;
$$;


-- ---------------------------------------------------------------------
-- Gemeinsame Hilfen
-- ---------------------------------------------------------------------
-- Spieler ohne Ablöse in den Free-Agent-Pool entlassen (Vertrag beenden, Taktik bereinigen)
create or replace function public.fd_release_to_pool(p_player uuid, p_age_up boolean default false)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
  v_age integer;
begin
  select * into v_p from public.players where id = p_player for update;
  if v_p.id is null or v_p.club_id is null then return; end if;
  update public.player_contracts set active = false where player_id = p_player and active;
  update public.tactical_profile_slots s set player_id = null from public.tactical_profiles t
  where t.id = s.profile_id and t.club_id = v_p.club_id and s.player_id = p_player;
  delete from public.player_instructions pi using public.tactical_profiles t where t.id = pi.profile_id and t.club_id = v_p.club_id and pi.player_id = p_player;
  delete from public.set_piece_assignments where club_id = v_p.club_id and player_id = p_player;
  v_age := case when p_age_up then least(45, v_p.age + 1) else v_p.age end;
  update public.players set club_id = null, shirt_number = null, age = v_age where id = p_player;
  insert into public.free_agents(player_id, world_id, annual_salary)
  values (p_player, v_p.world_id, public.fd_salary(v_p.overall, v_age, public.fd_typical_tier(v_p.overall), 50, 2))
  on conflict (player_id) do nothing;
end;
$$;

-- JSON je Spieler für die App (eigene Daten, keine verdeckten Werte wie die feste Zufallszahl x)
create or replace function public.fd_contract_squad_json(p_world uuid, p_season uuid, p_club uuid, p_player uuid default null)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with y as (select public.fd_season_year(p_season) as year)
  select coalesce(jsonb_agg(jsonb_build_object(
      'player_id', r.r_player,
      'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
      'position', r.r_pos, 'age', r.r_age, 'overall', r.r_ovr, 'overall_change', r.r_ovr - r.r_ovr_start,
      'appearances', r.r_apps, 'minutes', r.r_minutes, 'rating', r.r_rating, 'minutes_share', round(r.r_share::numeric, 3),
      'salary', r.r_salary, 'contract_years', r.r_end - r.r_start + 1, 'remaining', r.r_end - y.year, 'end_year', r.r_end,
      'expiring', r.r_end <= y.year, 'market_value', r.r_value, 'market_salary', r.r_market, 'elite', r.r_ovr > 82,
      'termination_fee', case when r.r_end > y.year then public.fd_contract_termination_fee(r.r_salary, r.r_end - y.year) else 0 end,
      'inputs', jsonb_build_object('currentSalary', r.r_salary, 'marketSalary', r.r_market, 'overall', r.r_ovr, 'overallChange', r.r_ovr - r.r_ovr_start,
        'rating', r.r_rating, 'minutesShare', round(r.r_share::numeric, 3), 'age', r.r_age, 'tier', r.r_tier, 'position', r.r_place,
        'teams', r.r_teams, 'reputation', r.r_rep),
      'plan', case when pl.player_id is null then null else jsonb_build_object('action', pl.action, 'salary', pl.new_salary, 'years', pl.new_years,
        'end_year', pl.new_end_year, 'barometer', pl.barometer) end)
    order by r.r_ovr desc, r.r_player), '[]'::jsonb)
  from y, public.fd_contract_rows(p_world, p_season, p_club) r
  join public.players p on p.id = r.r_player
  left join public.contract_plans pl on pl.player_id = r.r_player and pl.season_id = p_season and pl.applied_at is null
  where r.r_club = p_club and (p_player is null or r.r_player = p_player);
$$;

-- ---------------------------------------------------------------------
-- Manager-RPCs
-- ---------------------------------------------------------------------
create or replace function public.contract_overview(p_world uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_w public.career_worlds;
  v_slot public.season_slots;
  v_year integer;
  v_phase boolean;
  v_squad jsonb;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_slot := public.fd_current_slot(p_world);
  v_year := public.fd_season_year(v_w.current_season_id);
  v_phase := public.fd_season_end_phase(p_world);
  v_squad := public.fd_contract_squad_json(p_world, v_w.current_season_id, v_club);
  return jsonb_build_object(
    'phase', jsonb_build_object('active', v_phase, 'can_edit', v_phase and v_slot.state = 'pending', 'season_year', v_year,
      'slot_state', v_slot.state, 'status', v_w.status),
    'club', public.fd_club_ref(v_club),
    'balance', coalesce((select balance from public.finances where club_id = v_club), 0),
    'squad_size', jsonb_array_length(v_squad), 'min_squad', 16,
    'wage_now', coalesce((select sum((x ->> 'salary')::bigint) from jsonb_array_elements(v_squad) x), 0),
    -- Gehaltssumme der neuen Saison: Pläne, Abgänge, Fallback (ein Jahr zu gleichen Konditionen)
    'wage_next', coalesce((select sum(case when x -> 'plan' ->> 'action' = 'renew' then (x -> 'plan' ->> 'salary')::bigint
                                           when x -> 'plan' ->> 'action' = 'leave' then 0
                                           else (x ->> 'salary')::bigint end) from jsonb_array_elements(v_squad) x), 0),
    'players', v_squad);
end;
$$;

-- Gemeinsame Prüfung der Manager-Aktionen: Spieler, Verein, Phase
drop function if exists public.fd_contract_guard(uuid);
create or replace function public.fd_contract_guard(p_player uuid, out o_world uuid, out o_club uuid, out o_season uuid, out o_year integer, out o_overall integer, out o_last text)
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
  v_w public.career_worlds;
  v_slot public.season_slots;
begin
  select * into v_p from public.players where id = p_player for update;
  if v_p.id is null or v_p.club_id is null or not public.is_club_manager(v_p.club_id) then
    raise exception 'Nicht dein Spieler.' using errcode = '42501', hint = 'forbidden';
  end if;
  o_club := v_p.club_id;
  o_world := v_p.world_id;
  o_overall := v_p.overall;
  o_last := v_p.last_name;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  if not public.fd_season_end_phase(v_p.world_id) then
    raise exception 'Vertragsverhandlungen sind nur im Saisonabschluss möglich.' using errcode = 'P0001', hint = 'not_season_end';
  end if;
  v_slot := public.fd_current_slot(v_p.world_id);
  if v_slot.state <> 'pending' then
    raise exception 'Der Saisonabschluss läuft bereits.' using errcode = 'P0001', hint = 'season_end_running';
  end if;
  o_season := v_w.current_season_id;
  o_year := public.fd_season_year(o_season);
end;
$$;

-- Angebot: neues Jahresgehalt und Laufzeit (ab der nächsten Saison). Der Spieler entscheidet serverseitig nach dem Barometer.
create or replace function public.contract_negotiate(p_player uuid, p_salary bigint, p_years integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  r record;
  v_prob double precision;
  v_pct integer;
  v_ok boolean;
  v_end integer;
  v_old public.contract_plans;
  v_msg text;
begin
  select * into g from public.fd_contract_guard(p_player);
  if p_years is null or p_years not between 1 and 5 then raise exception 'Ungültige Laufzeit (1 bis 5 Jahre).' using errcode = '22023', hint = 'invalid'; end if;
  select * into r from public.fd_contract_rows(g.o_world, g.o_season, g.o_club) x where x.r_player = p_player;
  if r.r_player is null then raise exception 'Der Spieler hat keinen aktiven Vertrag.' using errcode = 'P0001', hint = 'no_contract'; end if;
  if p_salary is null or p_salary < greatest(30000, round(r.r_salary * 0.4)) or p_salary > round(2.5 * greatest(r.r_salary, r.r_market)) then
    raise exception 'Gehalt außerhalb des Verhandlungsrahmens (40 %% des bisherigen Gehalts bis 250 %% des höheren von bisherigem und marktüblichem Gehalt).'
      using errcode = '22023', hint = 'invalid_salary';
  end if;
  v_prob := public.fd_contract_prob(r.r_salary, p_salary, r.r_market, r.r_ovr, r.r_ovr - r.r_ovr_start, r.r_rating::double precision, r.r_share, r.r_age, p_years,
                                    r.r_tier, r.r_place, r.r_teams, r.r_rep::double precision);
  v_pct := round(v_prob * 100)::int;
  v_ok := public.fd_contract_x(p_player, g.o_season) < v_prob;
  v_end := g.o_year + p_years;
  if v_ok then
    insert into public.contract_plans(player_id, season_id, world_id, club_id, action, new_salary, new_years, new_end_year, previous_salary, barometer)
    values (p_player, g.o_season, g.o_world, g.o_club, 'renew', p_salary, p_years, v_end, r.r_salary, v_pct)
    on conflict (player_id, season_id) do update set action = 'renew', new_salary = excluded.new_salary, new_years = excluded.new_years,
      new_end_year = excluded.new_end_year, previous_salary = excluded.previous_salary, barometer = excluded.barometer, updated_at = now(), applied_at = null;
    v_msg := case when p_salary < r.r_salary then 'Einverstanden: ' || g.o_last || ' akzeptiert die Gehaltsreduktion.'
                  else 'Einigung: ' || g.o_last || ' unterschreibt zu diesen Konditionen.' end;
  else
    v_msg := g.o_last || ' lehnt dieses Angebot ab.';
  end if;
  return jsonb_build_object('accepted', v_ok, 'barometer', v_pct, 'message', v_msg,
    'player', (select x from jsonb_array_elements(public.fd_contract_squad_json(g.o_world, g.o_season, g.o_club, p_player)) x limit 1));
end;
$$;

-- Auslaufenden Vertrag nicht verlängern (der Spieler geht zum Saisonwechsel) bzw. diese Entscheidung zurücknehmen
create or replace function public.contract_set_leave(p_player uuid, p_leave boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  v_end integer;
  v_leaving integer;
begin
  select * into g from public.fd_contract_guard(p_player);
  select end_season_year into v_end from public.player_contracts where player_id = p_player and active;
  if v_end is null then raise exception 'Der Spieler hat keinen aktiven Vertrag.' using errcode = 'P0001', hint = 'no_contract'; end if;
  if coalesce(p_leave, false) then
    if g.o_overall > 82 then
      raise exception 'Spieler über 82 OVR verlassen den Verein nie ablösefrei. Verlängere oder verkaufe den Spieler über den Transfermarkt.'
        using errcode = 'P0001', hint = 'elite_stays';
    end if;
    if v_end > g.o_year then
      raise exception 'Der Vertrag läuft noch; nutze die vorzeitige Auflösung.' using errcode = 'P0001', hint = 'not_expiring';
    end if;
    select count(*) into v_leaving from public.contract_plans where club_id = g.o_club and season_id = g.o_season and action = 'leave' and player_id <> p_player and applied_at is null;
    if (select count(*) from public.players where club_id = g.o_club and not retired) - v_leaving - 1 < 16 then
      raise exception 'Der Kader darf nicht unter 16 Spieler fallen.' using errcode = 'P0001', hint = 'squad_min';
    end if;
    insert into public.contract_plans(player_id, season_id, world_id, club_id, action, previous_salary)
    values (p_player, g.o_season, g.o_world, g.o_club, 'leave', (select annual_salary from public.player_contracts where player_id = p_player and active))
    on conflict (player_id, season_id) do update set action = 'leave', new_salary = null, new_years = null, new_end_year = null, barometer = null, updated_at = now(), applied_at = null;
  else
    delete from public.contract_plans where player_id = p_player and season_id = g.o_season and applied_at is null;
  end if;
  return jsonb_build_object('status', case when coalesce(p_leave, false) then 'leaves' else 'cleared' end,
    'player', (select x from jsonb_array_elements(public.fd_contract_squad_json(g.o_world, g.o_season, g.o_club, p_player)) x limit 1));
end;
$$;

-- Vorzeitige Auflösung eines noch laufenden Vertrags gegen Abfindung (genau eine Buchung contract_termination)
create or replace function public.contract_terminate(p_player uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  v_c public.player_contracts;
  v_fee bigint;
  v_leaving integer;
begin
  select * into g from public.fd_contract_guard(p_player);
  select * into v_c from public.player_contracts where player_id = p_player and active for update;
  if v_c.id is null then raise exception 'Der Spieler hat keinen aktiven Vertrag.' using errcode = 'P0001', hint = 'no_contract'; end if;
  if g.o_overall > 82 then
    raise exception 'Spieler über 82 OVR verlassen den Verein nie ablösefrei. Verkaufe den Spieler über den Transfermarkt.' using errcode = 'P0001', hint = 'elite_stays';
  end if;
  if v_c.end_season_year <= g.o_year then
    raise exception 'Der Vertrag läuft ohnehin aus; wähle „Nicht verlängern“.' using errcode = 'P0001', hint = 'expiring';
  end if;
  select count(*) into v_leaving from public.contract_plans where club_id = g.o_club and season_id = g.o_season and action = 'leave' and player_id <> p_player and applied_at is null;
  if (select count(*) from public.players where club_id = g.o_club and not retired) - v_leaving - 1 < 16 then
    raise exception 'Der Kader darf nicht unter 16 Spieler fallen.' using errcode = 'P0001', hint = 'squad_min';
  end if;
  v_fee := public.fd_contract_termination_fee(v_c.annual_salary, v_c.end_season_year - g.o_year);
  perform public.fd_pay(g.o_club, 'contract_termination', -v_fee, 'contract_termination:' || v_c.id, 'Abfindung Vertragsauflösung ' || g.o_last, g.o_season);
  delete from public.contract_plans where player_id = p_player and season_id = g.o_season;
  perform public.fd_release_to_pool(p_player, false);
  return jsonb_build_object('status', 'terminated', 'compensation', v_fee,
    'message', 'Vertrag mit ' || g.o_last || ' aufgelöst. Die Abfindung wurde gebucht.');
end;
$$;

-- ---------------------------------------------------------------------
-- Saisonwechsel: Pläne, Fallback, KI-Verträge, neuer Free-Agent-Markt
-- ---------------------------------------------------------------------
-- Neue Free Agents je Saison: höchstens 1 % der KI-Spieler (8 bis 40); bei einem Pool ab 700 keine weiteren
create or replace function public.fd_fa_market_cap(p_world uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when (select count(*) from public.free_agents where world_id = p_world) >= 700 then 0
              else least(40, greatest(8, round((select count(*) from public.players p join public.clubs c on c.id = p.club_id
                                               where p.world_id = p_world and c.control = 'ai' and not p.temporary) * 0.01)::int)) end;
$$;

-- Zufallsschlüssel der Auswahl neuer Free Agents (kleiner = eher dabei): Gewichtung nach Stärke.
-- 55–72 häufig (1), unter 55 selten (0,35), 73–77 gelegentlich (0,2), 78–80 selten (0,05), 81–82 extrem selten (0,012); über 82 nie (nicht wählbar).
create or replace function public.fd_fa_race_key(p_player uuid, p_season text, p_ovr integer)
returns double precision
language sql
immutable
set search_path = ''
as $$
  select -ln(greatest(public.fd_hash01(p_player::text || ':' || p_season || ':fa-race'), 1e-9))
         / case when p_ovr < 55 then 0.35 when p_ovr <= 72 then 1.0 when p_ovr <= 77 then 0.2 when p_ovr <= 80 then 0.05 else 0.012 end;
$$;

create or replace function public.fd_contracts_season_change(p_world uuid, p_season uuid, p_year integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_plan record;
  v_renew integer := 0;
  v_leave integer := 0;
  v_auto integer := 0;
  v_ai_expiring integer := 0;
  v_ai_renewed integer := 0;
  v_new_fa integer := 0;
  v_pool integer;
  v_cap integer;
  v_buckets jsonb;
begin
  if exists (select 1 from public.fd_fa_market_log where world_id = p_world and season_id = p_season) then
    return jsonb_build_object('status', 'already_done');
  end if;

  -- 1) Entscheidungen der Manager (Verlängerung mit neuem Gehalt/neuer Dauer ab der neuen Saison, Abgänge)
  for v_plan in
    select pl.* from public.contract_plans pl join public.players p on p.id = pl.player_id
    where pl.world_id = p_world and pl.season_id = p_season and pl.applied_at is null and p.club_id = pl.club_id
      and exists (select 1 from public.player_contracts pc where pc.player_id = pl.player_id and pc.active)
      and (pl.action = 'renew' or (p.overall <= 82 and (select end_season_year from public.player_contracts pc where pc.player_id = pl.player_id and pc.active) <= p_year))
    order by pl.player_id
  loop
    if v_plan.action = 'renew' then
      update public.player_contracts set active = false where player_id = v_plan.player_id and active;
      insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
      select p_world, v_plan.player_id, v_plan.club_id, p_year + 1, v_plan.new_end_year, v_plan.new_salary, least(45, p.age + 1)
      from public.players p where p.id = v_plan.player_id;
      v_renew := v_renew + 1;
    else
      perform public.fd_release_to_pool(v_plan.player_id, true);
      v_leave := v_leave + 1;
    end if;
    update public.contract_plans set applied_at = now() where player_id = v_plan.player_id and season_id = p_season;
  end loop;

  -- 2) Menschliche Vereine, keine Entscheidung: ein Jahr zu unveränderten Konditionen (Kaderschutz)
  with f as (
    select pc.id, pc.player_id, pc.club_id, pc.annual_salary, p.age
    from public.player_contracts pc join public.players p on p.id = pc.player_id and p.club_id = pc.club_id
    join public.clubs c on c.id = pc.club_id
    where pc.world_id = p_world and pc.active and pc.end_season_year <= p_year and c.control = 'human'),
  d as (update public.player_contracts x set active = false from f where x.id = f.id returning f.player_id, f.club_id, f.annual_salary, f.age)
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, d.player_id, d.club_id, p_year + 1, p_year + 1, d.annual_salary, least(45, d.age + 1) from d;
  get diagnostics v_auto = row_count;

  -- 3) KI-Vereine (alle Länder): Verträge nach denselben Grundsätzen, set-basiert
  create temporary table if not exists fd_tmp_ct (
    player_id uuid primary key, club_id uuid, contract_id uuid, ovr integer, age integer, grp text, s0 bigint, s1 bigint, years integer,
    p double precision, x double precision, wants_leave boolean, eligible boolean, key double precision, leave_final boolean, new_salary bigint) on commit drop;
  truncate fd_tmp_ct;
  insert into fd_tmp_ct(player_id, club_id, contract_id, ovr, age, grp, s0, s1, years, p, x, wants_leave, eligible, key, leave_final)
  select q.player_id, q.club_id, q.contract_id, q.ovr, q.age, q.grp, q.s0, q.s1, q.years, q.p, q.x,
         q.ovr <= 82 and q.x >= q.p as wants_leave,
         q.ovr <= 82 and q.x >= q.p and q.squad >= 18 and q.grp_n >= case q.grp when 'GK' then 3 else 5 end and q.ovr_rank > 5,
         public.fd_fa_race_key(q.player_id, p_season::text, q.ovr),
         false
  from (
    select z.*, public.fd_contract_x(z.player_id, p_season) as x,
           public.fd_contract_prob(z.s0::double precision, z.s1::double precision, z.market::double precision, z.ovr, z.dovr, z.rating::double precision, z.share,
                                   z.age, z.years, z.tier, z.place, z.teams, z.rep::double precision) as p
    from (
      select y.*, greatest(30000, round(greatest(y.s0 * 0.8, least(y.s0 * 1.4, public.fd_contract_reference(y.s0::double precision, y.market::double precision, y.dovr,
                                  y.rating::double precision, y.share, y.age))) / 5000) * 5000)::bigint as s1
      from (
        select r.r_player as player_id, r.r_club as club_id, r.r_contract as contract_id, r.r_ovr as ovr, r.r_ovr - r.r_ovr_start as dovr, r.r_age as age,
               r.r_grp as grp, r.r_salary as s0, r.r_end as end_year, r.r_market as market, r.r_rating as rating, r.r_share as share, r.r_tier as tier,
               r.r_place as place, r.r_teams as teams, r.r_rep as rep,
               case when r.r_age <= 24 then 4 when r.r_age <= 30 then 3 when r.r_age <= 33 then 2 else 1 end as years,
               count(*) over (partition by r.r_club) as squad,
               count(*) over (partition by r.r_club, r.r_grp) as grp_n,
               row_number() over (partition by r.r_club order by r.r_ovr desc, r.r_player) as ovr_rank
        from public.fd_contract_rows(p_world, p_season, null) r
      ) y
    ) z
  ) q
  join public.clubs c on c.id = q.club_id and c.control = 'ai'
  where q.end_year <= p_year;
  get diagnostics v_ai_expiring = row_count;

  -- Begrenzte Zahl neuer Free Agents: höchstens ein Spieler je Verein; Gewichtung nach Stärke (häufig 55–72, selten 78+)
  select count(*) into v_pool from public.free_agents where world_id = p_world;
  v_cap := public.fd_fa_market_cap(p_world);
  update fd_tmp_ct t set leave_final = true
  from (select s.player_id from (
          select e.player_id, e.key, row_number() over (partition by e.club_id order by e.key) as rn_club from fd_tmp_ct e where e.eligible) s
        where s.rn_club = 1 order by s.key, s.player_id limit v_cap) pick
  where t.player_id = pick.player_id;

  -- Verlängerungen der übrigen (Zusage nach Barometer zum fairen Gehalt, sonst mit 15 % Aufschlag gehalten)
  update fd_tmp_ct set new_salary = case when x < p then s1 else (round(s1 * 1.15 / 5000) * 5000)::bigint end where not leave_final;
  with d as (update public.player_contracts pc set active = false from fd_tmp_ct t where pc.id = t.contract_id and not t.leave_final returning t.player_id, t.club_id, t.new_salary, t.age, t.years)
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, d.player_id, d.club_id, p_year + 1, p_year + d.years, d.new_salary, least(45, d.age + 1) from d;
  get diagnostics v_ai_renewed = row_count;

  -- Abgänge: ablösefrei in den Pool (Verträge beenden, Taktik bereinigen, Alter +1, weil der Altersschritt nur Vereinsspieler erfasst)
  update public.player_contracts pc set active = false from fd_tmp_ct t where pc.id = t.contract_id and t.leave_final;
  update public.tactical_profile_slots s set player_id = null from public.tactical_profiles tp, fd_tmp_ct t
  where tp.id = s.profile_id and tp.club_id = t.club_id and s.player_id = t.player_id and t.leave_final;
  delete from public.player_instructions pi using public.tactical_profiles tp, fd_tmp_ct t where tp.id = pi.profile_id and tp.club_id = t.club_id and pi.player_id = t.player_id and t.leave_final;
  delete from public.set_piece_assignments sp using fd_tmp_ct t where sp.club_id = t.club_id and sp.player_id = t.player_id and t.leave_final;
  update public.players p set club_id = null, shirt_number = null, age = least(45, p.age + 1) from fd_tmp_ct t where p.id = t.player_id and t.leave_final;
  insert into public.free_agents(player_id, world_id, annual_salary)
  select p.id, p_world, public.fd_salary(p.overall, p.age, public.fd_typical_tier(p.overall), 50, 2)
  from public.players p join fd_tmp_ct t on t.player_id = p.id where t.leave_final
  on conflict (player_id) do nothing;
  insert into public.fd_fa_market_players(world_id, season_id, player_id, overall, from_club_id)
  select p_world, p_season, t.player_id, t.ovr, t.club_id from fd_tmp_ct t where t.leave_final
  on conflict do nothing;
  get diagnostics v_new_fa = row_count;
  select jsonb_object_agg(b, n) into v_buckets from (
    select case when ovr < 55 then 'lt55' when ovr <= 72 then '55_72' when ovr <= 77 then '73_77' when ovr <= 80 then '78_80' else '81_82' end as b, count(*) as n
    from fd_tmp_ct where leave_final group by 1) x;

  insert into public.fd_fa_market_log(world_id, season_id, result)
  values (p_world, p_season, jsonb_build_object('plans_renewed', v_renew, 'plans_left', v_leave, 'human_auto_extended', v_auto,
    'ai_expiring', v_ai_expiring, 'ai_renewed', v_ai_renewed, 'ai_wanted_leave', (select count(*) from fd_tmp_ct where wants_leave),
    'new_free_agents', v_new_fa, 'cap', v_cap, 'pool_before', v_pool, 'buckets', coalesce(v_buckets, '{}'::jsonb)))
  on conflict do nothing;
  return jsonb_build_object('status', 'done', 'plans_renewed', v_renew, 'plans_left', v_leave, 'human_auto_extended', v_auto,
    'ai_renewed', v_ai_renewed, 'new_free_agents', v_new_fa);
end;
$$;

-- Saisonabschluss: statt automatischer +2 Jahre läuft das Vertragsmanagement; schlägt es fehl, gilt die alte Regel
CREATE OR REPLACE FUNCTION public.fd_end_season(p_world uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_old public.seasons;
  v_new uuid;
  v_slot public.season_slots;
  v_tiers uuid[] := array[null, null, null]::uuid[];
  v_tier smallint;
  v_comp uuid;
  v_moves jsonb := '[]'::jsonb;
  r record;
  v_newtier jsonb := '{}'::jsonb;
  v_rel_win uuid;
  v_rel_lose uuid;
  v_ama uuid[];
  v_pos integer;
  v_ga integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  select * into v_old from public.seasons where id = v_world.current_season_id;
  v_slot := public.fd_current_slot(p_world);

  -- Neue Spielklasse je Verein bestimmen
  for v_tier in 1..3 loop
    select id into v_comp from public.competitions where season_id = v_old.id and kind = 'league' and tier = v_tier;
    for r in select * from public.fd_table(v_comp) loop
      v_newtier := v_newtier || jsonb_build_object(r.club_id::text,
        case
          when v_tier > 1 and r.pos <= 2 then v_tier - 1
          when v_tier < 3 and r.pos >= 17 then v_tier + 1
          when v_tier = 3 and r.pos >= 17 then 4
          else v_tier end);
      -- I7: Sponsor-Saisonprämien
      select goals_against into v_ga from public.standings where competition_id = v_comp and club_id = r.club_id;
      perform public.fd_pay(r.club_id, 'sponsor', public.fd_scaled(so.amount, v_world.economy_factor), 'season:' || v_old.id || ':sponsorbonus:' || r.club_id, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
      from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
      where sc.club_id = r.club_id and sc.season_id = v_old.id and (
        (so.kind = 'max_goals_against' and v_ga <= so.threshold)
        or (so.kind = 'placement_at_most' and r.pos <= so.threshold)
        or (so.kind = 'champion' and r.pos = 1)
        or (so.kind = 'promotion' and v_tier > 1 and r.pos <= 2));
    end loop;
  end loop;
  -- Relegation (Sieger spielt in der höheren Liga)
  for r in select t.*, c.tier from public.ties t join public.competition_stages st on st.id = t.stage_id join public.competitions c on c.id = st.competition_id
           where c.season_id = v_old.id and c.kind = 'relegation' and t.winner_club_id is not null loop
    v_rel_win := r.winner_club_id;
    v_rel_lose := case when r.winner_club_id = r.club_a_id then r.club_b_id else r.club_a_id end;
    v_newtier := v_newtier || jsonb_build_object(v_rel_win::text, r.tier) || jsonb_build_object(v_rel_lose::text, r.tier + 1);
    perform public.fd_pay(v_rel_win, 'sponsor', public.fd_scaled(so.amount, v_world.economy_factor), 'season:' || v_old.id || ':sponsorbonus:' || v_rel_win, 'Sponsor-Saisonprämie ' || so.name, v_old.id)
    from public.sponsor_contracts sc join public.sponsor_offers so on so.id = sc.sponsor_offer_id
    where sc.club_id = v_rel_win and sc.season_id = v_old.id and so.kind = 'promotion' and r.tier + 1 = (select public.fd_tier_of(v_rel_win, v_old.id));
  end loop;
  -- Vierte Liga: die zwei stärksten Amateurvereine steigen auf, die Absteiger werden Amateure
  select array_agg(id order by avg_ovr desc) into v_ama from (
    select c.id, (select avg(p.overall) from public.players p where p.club_id = c.id) as avg_ovr
    from public.clubs c where c.world_id = p_world and c.amateur) x;
  v_newtier := v_newtier || jsonb_build_object(v_ama[1]::text, 3) || jsonb_build_object(v_ama[2]::text, 3);
  update public.clubs set amateur = false where id in (v_ama[1], v_ama[2]);
  update public.clubs c set amateur = true where c.world_id = p_world and (v_newtier ->> c.id::text) = '4';

  -- Neue Saison
  insert into public.seasons(world_id, year, status) values (p_world, v_old.year + 1, 'planned') returning id into v_new;
  for v_tier in 1..3 loop
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_new, 'league', v_world.country_code, v_tier, public.fd_league_name(v_world.country_code, v_tier))
    returning id into v_comp;
    insert into public.competition_entries(competition_id, club_id, world_id)
    select v_comp, (k)::uuid, p_world from jsonb_each_text(v_newtier) e(k, v) where v::int = v_tier;
  end loop;
  -- Sicherung: jede Liga exakt 18 Vereine
  if exists (select 1 from public.competitions c where c.season_id = v_new and c.kind = 'league'
             and (select count(*) from public.competition_entries e where e.competition_id = c.id) <> 18) then
    raise exception 'Auf-/Abstieg ergibt keine 18er-Ligen' using errcode = 'P0001', hint = 'league_size';
  end if;

  -- Saisonwechsel: Alter +1, Verträge (Verlängerungen folgen in Phase 9 – vorerst automatisch +2 Jahre)
  -- Entwicklungsbericht: Stand am Saisonende festhalten, danach Alterung (nur hier sinken Attribute)
  perform public.fd_dev_season_close(p_world, v_old.id);
  -- Vertragsmanagement (Pläne, KI-Verträge, neuer Free-Agent-Markt); bei einem Fehler gilt die bisherige Regel (+2 Jahre)
  begin
    perform public.fd_contracts_season_change(p_world, v_old.id, v_old.year);
  exception when others then
    raise warning 'Vertragsmanagement: %', sqlerrm;
    update public.player_contracts set end_season_year = end_season_year + 2
    where world_id = p_world and active and end_season_year <= v_old.year;
  end;
  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
  insert into public.dev_aging_jobs(world_id, season_id) values (p_world, v_old.id) on conflict do nothing;
  perform public.fd_dev_season_aging(p_world, v_old.id, 2000); -- große Welten: Rest übernimmt der Server-Sweep
  update public.disciplinary_records set served_matches = suspension_matches where world_id = p_world and season_id = v_old.id;
  update public.players set fitness = 100 where world_id = p_world;

  update public.season_slots set state = 'released', released_at = now() where season_id = v_old.id and slot_key = 'END';
  update public.seasons set status = 'closed' where id = v_old.id;
  update public.career_worlds set current_season_id = v_new, status = 'preseason', current_slot = 0, current_week = 0,
    current_date_in_world = make_date(v_old.year + 1, 7, 1)
  where id = p_world;
  delete from public.multiplayer_readiness where world_id = p_world and context = 'preseason';
  -- Ergänzungsspieler entfernen, Kader kleinerer Länder (nach dem Europapokal) auf elf reduzieren
  perform public.fd_cleanup_temporary_players(p_world);
  begin perform public.fd_reduce_world_players(p_world); exception when others then raise warning 'Kaderreduktion: %', sqlerrm; end;
end;
$function$

;


-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public.fd_season_end_phase(uuid)', 'public.fd_contract_reference(double precision, double precision, integer, double precision, double precision, integer)',
    'public.fd_contract_utility(double precision, double precision, double precision, integer, integer, double precision, double precision, integer, integer, integer, integer, integer, double precision)',
    'public.fd_contract_prob(double precision, double precision, double precision, integer, integer, double precision, double precision, integer, integer, integer, integer, integer, double precision)',
    'public.fd_contract_x(uuid, uuid)', 'public.fd_contract_termination_fee(bigint, integer)', 'public.fd_contract_rows(uuid, uuid, uuid)',
    'public.fd_fa_elite_penalty(integer, integer)', 'public.fd_release_to_pool(uuid, boolean)', 'public.fd_contract_squad_json(uuid, uuid, uuid, uuid)',
    'public.fd_contract_guard(uuid)', 'public.fd_contracts_season_change(uuid, uuid, integer)',
    'public.fd_fa_market_cap(uuid)', 'public.fd_fa_race_key(uuid, text, integer)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.contract_overview(uuid)', 'public.contract_negotiate(uuid, bigint, integer)', 'public.contract_set_leave(uuid, boolean)', 'public.contract_terminate(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
