-- =============================================================================
-- 0034 Teil 1: Free-Agent-Verhandlungen mit kalibriertem Attraktivitätsbarometer
-- =============================================================================
-- Modell (alles serverseitig, Faktoren werden nicht angezeigt):
--   Nutzen U = Basis(Verein) + Geldgewicht · ln(Gehalt / Forderung) + Laufzeit-Term
--   Der Spieler zieht bei der Entscheidung eine verdeckte Mindestschwelle R ~ Logistisch(μ, s).
--   Akzeptabel sind alle gültigen Angebote mit U ≥ R; gibt es mindestens eines, MUSS er unterschreiben
--   und wählt unter den akzeptablen per Logit (Temperatur T). Das Barometer ist genau die daraus
--   folgende Verpflichtungswahrscheinlichkeit (analytisch) – 75 bedeutet also tatsächlich ≈ 75 %.

alter table public.fa_applications add column if not exists annual_salary bigint;
alter table public.fa_applications add column if not exists utility numeric(8,2);
alter table public.fa_applications add column if not exists updated_at timestamptz not null default now();
alter table public.fa_applications add column if not exists ai_adjustments smallint not null default 0;
update public.fa_applications a set annual_salary = f.annual_salary
from public.free_agents f where f.player_id = a.player_id and a.annual_salary is null;
update public.fa_applications a set annual_salary = coalesce(a.annual_salary, 100000) where a.annual_salary is null;
-- Vertraulich: fremde Angebote sind für Clients nicht lesbar (keine Rechte für anon/authenticated)
revoke all on public.fa_applications from anon, authenticated;
alter table public.fa_applications enable row level security;

-- Persönliche Präferenzen des Spielers (deterministisch, verdeckt)
-- Geldorientierung m ∈ [0,8; 1,2]; ältere Spieler achten stärker aufs Geld
create or replace function public.fd_fa_money_pref(p_player uuid, p_age integer)
returns numeric language sql immutable set search_path = '' as $$
  select round((0.8 + public.fd_hash01(p_player::text || ':fa-money') * 0.4)::numeric * case when p_age >= 31 then 1.15 else 1 end, 3);
$$;

-- Reservationsnutzen (Mitte der Schwelle): starke Spieler sind wählerischer, ältere kompromissbereiter
create or replace function public.fd_fa_mu(p_overall integer, p_age integer)
returns numeric language sql immutable set search_path = '' as $$
  select round(-4 + (p_overall - 70) * 0.3 - case when p_age >= 33 then 6 when p_age >= 31 then 3 else 0 end, 2);
$$;

create or replace function public.fd_fa_years_term(p_age integer, p_years integer)
returns numeric language sql immutable set search_path = '' as $$
  select -2.5 * abs(p_years - case when p_age <= 23 then 4 when p_age >= 31 then 3 else 3 end);
$$;

-- Basis-Nutzen eines Vereins (ohne Gehalt und Laufzeit); null = kein zulässiger Interessent
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
               + (public.fd_hash01(p_player::text || p_club::text || ':fa')::numeric - 0.5) * 6, 2);
end;
$$;

create or replace function public.fd_fa_utility(p_player uuid, p_club uuid, p_salary bigint, p_years integer)
returns numeric
language sql
stable
set search_path = ''
as $$
  select round(public.fd_fa_base(p_player, p_club)
               + 40 * public.fd_fa_money_pref(p_player, p.age) * ln(greatest(p_salary, 1)::numeric / greatest(f.annual_salary, 1))
               + public.fd_fa_years_term(p.age, p_years), 2)
  from public.players p join public.free_agents f on f.player_id = p.id where p.id = p_player;
$$;

-- Verpflichtungswahrscheinlichkeiten aus Nutzwerten (analytisch, siehe Kopf):
-- P(i) = Σ_{k ≥ rang(i)} [F(U_k) − F(U_{k+1})] · softmax_T(i | Top k),  F = logistische Verteilung der Schwelle
create or replace function public.fd_fa_probs(p_utils numeric[], p_mu numeric, p_s numeric default 5, p_t numeric default 4)
returns numeric[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n integer := coalesce(array_length(p_utils, 1), 0);
  v_ord integer[];
  v_out numeric[] := array[]::numeric[];
  v_k integer;
  v_j integer;
  v_band numeric;
  v_sum numeric;
  v_max numeric;
  v_fk numeric;
  v_fk1 numeric;
begin
  if v_n = 0 then return v_out; end if;
  for v_j in 1..v_n loop v_out := v_out || 0::numeric; end loop;
  select array_agg(i order by p_utils[i] desc nulls last, i) into v_ord from generate_series(1, v_n) i where p_utils[i] is not null;
  if v_ord is null then return v_out; end if;
  for v_k in 1..array_length(v_ord, 1) loop
    v_fk := 1 / (1 + exp(least(700, greatest(-700, -(p_utils[v_ord[v_k]] - p_mu) / p_s))));
    v_fk1 := case when v_k < array_length(v_ord, 1) then 1 / (1 + exp(least(700, greatest(-700, -(p_utils[v_ord[v_k + 1]] - p_mu) / p_s)))) else 0 end;
    v_band := v_fk - v_fk1;
    if v_band <= 0 then continue; end if;
    v_max := p_utils[v_ord[1]];
    v_sum := 0;
    for v_j in 1..v_k loop v_sum := v_sum + exp((p_utils[v_ord[v_j]] - v_max) / p_t); end loop;
    for v_j in 1..v_k loop
      v_out[v_ord[v_j]] := v_out[v_ord[v_j]] + v_band * exp((p_utils[v_ord[v_j]] - v_max) / p_t) / v_sum;
    end loop;
  end loop;
  return v_out;
end;
$$;

-- Zufallsentscheidung genau nach dem Modell des Barometers: Index des gewählten Angebots oder null (bleibt vereinslos)
create or replace function public.fd_fa_draw(p_utils numeric[], p_mu numeric, p_s numeric default 5, p_t numeric default 4)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_x numeric;
  v_r numeric;
  v_acc integer[] := array[]::integer[];
  v_max numeric;
  v_sum numeric;
  v_pick integer;
  i integer;
begin
  if coalesce(array_length(p_utils, 1), 0) = 0 then return null; end if;
  -- verdeckte Schwelle R ~ Logistisch(μ, s); akzeptabel: U ≥ R
  v_x := greatest(1e-9, least(1 - 1e-9, random()));
  v_r := p_mu + p_s * ln(v_x / (1 - v_x));
  for i in 1..array_length(p_utils, 1) loop
    if p_utils[i] is not null and p_utils[i] >= v_r then v_acc := v_acc || i; end if;
  end loop;
  if coalesce(array_length(v_acc, 1), 0) = 0 then return null; end if;
  -- mindestens ein akzeptables Angebot ⇒ Unterschrift; Logit-Auswahl unter den akzeptablen
  select max(p_utils[j]) into v_max from unnest(v_acc) j;
  select sum(exp((p_utils[j] - v_max) / p_t)) into v_sum from unnest(v_acc) j;
  v_x := random() * v_sum;
  foreach i in array v_acc loop
    v_x := v_x - exp((p_utils[i] - v_max) / p_t);
    v_pick := i;
    exit when v_x <= 0;
  end loop;
  return v_pick;
end;
$$;

-- Gültigkeit eines Angebots (Fenster, Limits, Kader, Budget); null = gültig, sonst Grund
create or replace function public.fd_fa_offer_problem(p_world uuid, p_club uuid, p_salary bigint, p_ignore uuid default null)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_win public.transfer_windows := public.fd_open_window(p_world);
  v_season uuid := (select current_season_id from public.career_worlds where id = p_world);
  v_bal bigint := coalesce((select balance from public.finances where club_id = p_club), 0);
  v_pending bigint;
begin
  if v_win.id is null then return 'Transferfenster geschlossen'; end if;
  if public.fd_fa_signings(p_club, v_season) >= 2 then return 'Limit von zwei Free Agents pro Saison erreicht'; end if;
  if (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = p_club and t.kind in ('transfer', 'free_agent')) >= 5 then return 'fünf Neuzugänge in diesem Fenster'; end if;
  if (select count(*) from public.players where club_id = p_club) >= 30 then return 'Kader voll'; end if;
  select coalesce(sum(annual_salary), 0) into v_pending from public.fa_applications
  where club_id = p_club and status = 'pending' and id is distinct from p_ignore;
  if p_salary + v_pending > v_bal then return 'Budget reicht nicht für das Jahresgehalt'; end if;
  return null;
end;
$$;

-- Aktueller Verhandlungsstand eines Free Agents (für Anzeige, KI und Entscheidung)
create or replace function public.fd_fa_board(p_player uuid)
returns table(application_id uuid, club_id uuid, utility numeric, prob numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_clubs uuid[];
  v_u numeric[];
  v_pr numeric[];
  v_p public.players;
begin
  select * into v_p from public.players where id = p_player;
  select array_agg(a.id order by a.created_at), array_agg(a.club_id order by a.created_at), array_agg(a.utility order by a.created_at)
  into v_ids, v_clubs, v_u from public.fa_applications a where a.player_id = p_player and a.status = 'pending';
  if v_ids is null then return; end if;
  v_pr := public.fd_fa_probs(v_u, public.fd_fa_mu(v_p.overall, v_p.age));
  for i in 1..array_length(v_ids, 1) loop
    application_id := v_ids[i]; club_id := v_clubs[i]; utility := v_u[i]; prob := round(v_pr[i], 4);
    return next;
  end loop;
end;
$$;

-- Nutzwert eines Angebots neu berechnen (beim Abgeben/Ändern und täglich vor Entscheidungen)
create or replace function public.fd_fa_refresh(p_player uuid)
returns void language sql set search_path = '' as $$
  update public.fa_applications a set utility = public.fd_fa_utility(a.player_id, a.club_id, a.annual_salary, a.contract_years)
  where a.player_id = p_player and a.status = 'pending';
$$;

-- Bewerbung/Angebot abgeben (Mensch und KI). Ohne Gehalt: Forderung des Spielers.
drop function if exists public.fd_fa_apply(uuid, uuid, integer);
create or replace function public.fd_fa_apply(p_player uuid, p_club uuid, p_years integer, p_salary bigint default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_fa public.free_agents;
  v_p public.players;
  v_w public.career_worlds;
  v_win public.transfer_windows;
  v_date date;
  v_salary bigint;
  v_problem text;
begin
  select * into v_fa from public.free_agents where player_id = p_player for update;
  if not found then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  select * into v_p from public.players where id = p_player;
  if v_p.club_id is not null then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  if p_years is null or p_years not between 1 and 5 then raise exception 'Ungültige Laufzeit.' using errcode = '22023', hint = 'invalid'; end if;
  v_salary := coalesce(p_salary, v_fa.annual_salary);
  if v_salary < round(v_fa.annual_salary * 0.4) or v_salary > round(v_fa.annual_salary * 2.5) then
    raise exception 'Gehalt außerhalb des Verhandlungsrahmens (40–250 %% der Forderung).' using errcode = '22023', hint = 'invalid_salary';
  end if;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  if v_win.id is null then raise exception 'Bewerbungen sind nur im geöffneten Transferfenster möglich.' using errcode = 'P0001', hint = 'window_closed'; end if;
  if public.fd_fa_signings(p_club, v_w.current_season_id) >= 2 then
    raise exception 'Dein Verein hat in dieser Saison bereits zwei Free Agents verpflichtet.' using errcode = 'P0001', hint = 'fa_limit';
  end if;
  if (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = p_club and t.kind in ('transfer', 'free_agent')) >= 5 then
    raise exception 'In diesem Fenster sind bereits fünf Neuzugänge erfolgt.' using errcode = 'P0001', hint = 'limit_signings';
  end if;
  if exists (select 1 from public.fa_applications where player_id = p_player and club_id = p_club and status = 'pending') then
    raise exception 'Ihr habt euch bereits um diesen Spieler beworben.' using errcode = 'P0001', hint = 'already_applied';
  end if;
  v_problem := public.fd_fa_offer_problem(v_p.world_id, p_club, v_salary);
  if v_problem is not null then
    raise exception 'Angebot nicht möglich: %.', v_problem using errcode = 'P0001', hint = 'insufficient_funds';
  end if;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  insert into public.fa_applications(world_id, season_id, player_id, club_id, contract_years, created_on, annual_salary, utility)
  values (v_p.world_id, v_w.current_season_id, p_player, p_club, p_years, v_date, v_salary,
          public.fd_fa_utility(p_player, p_club, v_salary, p_years));
  -- Die Frist beginnt mit der ersten Interessensbekundung: exakt 7 Kalendertage im Spielkalender
  if v_fa.decision_on is null then
    update public.free_agents set first_interest_on = v_date, decision_on = v_date + 7 where player_id = p_player;
    v_fa.decision_on := v_date + 7;
  end if;
  return jsonb_build_object('status', 'applied', 'decision_on', v_fa.decision_on,
    'message', 'Angebot abgegeben. ' || v_p.first_name || ' ' || v_p.last_name || ' entscheidet sich am ' || to_char(v_fa.decision_on, 'DD.MM.YYYY') || '.');
end;
$$;

-- KI: Gehalt so wählen, dass das Angebot allein ≈ 70 % Zusagechance hat (im Budgetrahmen); null = kein Angebot
create or replace function public.fd_fa_ai_salary(p_player uuid, p_club uuid, p_years integer, p_target numeric default 0.7)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_ask bigint;
  v_base numeric;
  v_need numeric;
  v_sal numeric;
  v_bal bigint;
begin
  select * into v_p from public.players where id = p_player;
  select annual_salary into v_ask from public.free_agents where player_id = p_player;
  v_base := public.fd_fa_base(p_player, p_club);
  if v_base is null or v_ask is null then return null; end if;
  v_need := public.fd_fa_mu(v_p.overall, v_p.age) + 5 * ln(p_target / (1 - p_target)) - v_base - public.fd_fa_years_term(v_p.age, p_years);
  v_sal := v_ask * exp(v_need / (40 * public.fd_fa_money_pref(p_player, v_p.age)));
  v_sal := greatest(v_ask * 0.5, v_sal);
  if v_sal > v_ask * 1.6 then return null; end if; -- zu teuer für diesen Verein
  v_bal := coalesce((select balance from public.finances where club_id = p_club), 0);
  if v_sal > v_bal * 0.25 then return null; end if;   -- KI bleibt sparsam
  return least(round(v_ask * 1.6), greatest(round(v_ask * 0.5), round(v_sal / 1000) * 1000))::bigint;
end;
$$;

-- Täglich: KI-Vereine bessern kurz vor der Entscheidung nach, wenn ihre Chance gering ist
create or replace function public.fd_fa_ai_adjust(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_date date := coalesce((select current_date_in_world from public.career_worlds where id = p_world), current_date);
  r record;
  v_new bigint;
  v_n integer := 0;
begin
  for r in
    select a.id, a.player_id, a.club_id, a.annual_salary, f.annual_salary ask, b.prob
    from public.fa_applications a
    join public.free_agents f on f.player_id = a.player_id
    join public.clubs c on c.id = a.club_id and c.control = 'ai'
    cross join lateral public.fd_fa_board(a.player_id) b
    where a.world_id = p_world and a.status = 'pending' and b.application_id = a.id
      and f.decision_on is not null and f.decision_on - v_date <= 2 and a.ai_adjustments < 2 and b.prob < 0.4
  loop
    v_new := least(round(r.ask * 1.6), round(r.annual_salary * 1.2 / 10000) * 10000)::bigint;
    if v_new <= r.annual_salary or v_new > coalesce((select balance from public.finances where club_id = r.club_id), 0) * 0.25
       or public.fd_fa_offer_problem(p_world, r.club_id, v_new, r.id) is not null then continue; end if;
    update public.fa_applications set annual_salary = v_new, ai_adjustments = ai_adjustments + 1, updated_at = now() where id = r.id;
    perform public.fd_fa_refresh(r.player_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Entscheidung nach Ablauf der Frist
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
  v_p public.players;
  v_ids uuid[];
  v_clubs uuid[];
  v_u numeric[];
  v_sal bigint[];
  v_years integer[];
  v_pick integer;
  v_problem text;
  v_n integer := 0;
  i integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  v_win := public.fd_open_window(p_world);
  begin perform public.fd_fa_ai_adjust(p_world); exception when others then raise warning 'KI-Nachbesserung: %', sqlerrm; end;
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
      -- Ungültige Angebote (Budget, Limits, Kader) scheiden aus
      for a in select * from public.fa_applications where player_id = fa.player_id and status = 'pending' loop
        v_problem := public.fd_fa_offer_problem(p_world, a.club_id, a.annual_salary, a.id);
        if v_problem is not null then
          update public.fa_applications set status = 'declined', decided_at = now(), note = 'Angebot ungültig: ' || v_problem where id = a.id;
        end if;
      end loop;
      perform public.fd_fa_refresh(fa.player_id);
      select array_agg(id order by created_at), array_agg(club_id order by created_at), array_agg(utility order by created_at),
             array_agg(annual_salary order by created_at), array_agg(contract_years::int order by created_at)
      into v_ids, v_clubs, v_u, v_sal, v_years
      from public.fa_applications where player_id = fa.player_id and status = 'pending' and utility is not null;
      v_pick := public.fd_fa_draw(v_u, public.fd_fa_mu(v_p.overall, v_p.age));
      if v_pick is null then
        update public.fa_applications set status = 'declined', decided_at = now(),
          note = case when v_ids is null then 'Kein gültiges Angebot' else 'Kein Angebot war für den Spieler ausreichend' end
        where player_id = fa.player_id and status = 'pending';
        update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id;
      else
        perform public.fd_complete_transfer(fa.player_id, null, v_clubs[v_pick], 0, v_sal[v_pick], v_years[v_pick], null, 'free_agent', v_win.id);
        update public.fa_applications set status = case when id = v_ids[v_pick] then 'signed' else 'lost' end, decided_at = now(),
          note = case when id = v_ids[v_pick] then null else 'Entscheidung für ' || (select name from public.clubs where id = v_clubs[v_pick]) end
        where player_id = fa.player_id and status = 'pending';
        v_n := v_n + 1;
      end if;
    exception when others then
      update public.fa_applications set status = 'declined', decided_at = now(), note = left('Nicht möglich: ' || sqlerrm, 200)
      where player_id = fa.player_id and status = 'pending';
      update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id;
    end;
  end loop;
  return v_n;
end;
$$;

-- KI-Interesse (wöchentlich, wie bisher): jetzt mit Gehaltsangebot nach Attraktivität
create or replace function public.fd_ai_fa_interest(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_win public.transfer_windows;
  fa record;
  c record;
  v_n integer := 0;
  v_k integer;
  v_years integer;
  v_sal bigint;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_win := public.fd_open_window(p_world);
  if v_win.id is null then return 0; end if;
  insert into public.world_week_log(world_id, season_id, week_no, job) values (p_world, v_w.current_season_id, v_w.current_week, 'ai_fa')
  on conflict do nothing;
  if not found then return 0; end if;
  create temporary table if not exists fd_tmp_fa_clubs (club_id uuid primary key, tier integer, rep numeric) on commit drop;
  create temporary table if not exists fd_tmp_fa_second (club_id uuid, grp text, second integer, primary key (club_id, grp)) on commit drop;
  truncate fd_tmp_fa_clubs; truncate fd_tmp_fa_second;
  insert into fd_tmp_fa_clubs
  select cl.id, coalesce(public.fd_tier_of(cl.id, v_w.current_season_id), 4), cl.reputation
  from public.clubs cl
  where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
    and cl.id in (select public.fd_active_club_ids(p_world))
    and public.fd_fa_signings(cl.id, v_w.current_season_id) < 2
    and (select count(*) from public.players where club_id = cl.id) < 27
    and not exists (select 1 from public.fa_applications a where a.club_id = cl.id and a.status = 'pending');
  insert into fd_tmp_fa_second
  select club_id, grp, overall from (
    select p.club_id, public.fd_pos_group(p.main_position::text) grp, p.overall,
           row_number() over (partition by p.club_id, public.fd_pos_group(p.main_position::text) order by p.overall desc) rn
    from public.players p join fd_tmp_fa_clubs fc on fc.club_id = p.club_id) x where rn = 2;
  for fa in select f.player_id, p.overall, p.age, p.main_position::text pos
            from public.free_agents f join public.players p on p.id = f.player_id
            where f.world_id = p_world and p.club_id is null order by p.overall desc limit 40 loop
    v_k := 0;
    v_years := case when fa.age < 26 then 3 when fa.age < 30 then 2 else 1 end;
    for c in
      select k.club_id as id from fd_tmp_fa_clubs k
      left join fd_tmp_fa_second sc on sc.club_id = k.club_id and sc.grp = public.fd_pos_group(fa.pos)
      -- echte Verstärkung: besser als der zweitbeste Spieler dieser Positionsgruppe, Liga passend zur Stärke
      where fa.overall >= coalesce(sc.second, 0) and k.tier <= least(3, public.fd_fa_min_tier(fa.overall, fa.age) + 1)
        and not exists (select 1 from public.fa_applications a where a.club_id = k.club_id and a.status = 'pending')
      order by md5(k.club_id::text || fa.player_id::text || v_w.current_week::text) limit 3
    loop
      exit when v_k >= 2;
      v_sal := public.fd_fa_ai_salary(fa.player_id, c.id, v_years);
      continue when v_sal is null;
      begin
        perform public.fd_fa_apply(fa.player_id, c.id, v_years, v_sal);
        v_n := v_n + 1; v_k := v_k + 1;
      exception when others then null;
      end;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- Manager: Angebot abgeben oder verbessern (innerhalb der Frist), Barometer aktualisiert sich sofort
create or replace function public.fa_offer(p_player uuid, p_salary bigint, p_years integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
  v_club uuid;
  v_a public.fa_applications;
  v_fa public.free_agents;
  v_problem text;
begin
  select world_id into v_world from public.players where id = p_player;
  if v_world is null then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  v_club := public.fd_require_team(v_world);
  select * into v_a from public.fa_applications where player_id = p_player and club_id = v_club and status = 'pending' for update;
  if v_a.id is null then
    perform public.fd_fa_apply(p_player, v_club, p_years, p_salary);
  else
    select * into v_fa from public.free_agents where player_id = p_player for update;
    if p_years is null or p_years not between 1 and 5 then raise exception 'Ungültige Laufzeit.' using errcode = '22023', hint = 'invalid'; end if;
    if p_salary < round(v_fa.annual_salary * 0.4) or p_salary > round(v_fa.annual_salary * 2.5) then
      raise exception 'Gehalt außerhalb des Verhandlungsrahmens (40–250 %% der Forderung).' using errcode = '22023', hint = 'invalid_salary';
    end if;
    v_problem := public.fd_fa_offer_problem(v_world, v_club, p_salary, v_a.id);
    if v_problem is not null then raise exception 'Angebot nicht möglich: %.', v_problem using errcode = 'P0001', hint = 'insufficient_funds'; end if;
    update public.fa_applications set annual_salary = p_salary, contract_years = p_years, updated_at = now() where id = v_a.id;
  end if;
  perform public.fd_fa_refresh(p_player);
  return public.fa_negotiation(p_player);
end;
$$;

-- Verhandlungsansicht: Profil, eigenes Angebot, Barometer aller Interessenten (ohne fremde Gehälter)
create or replace function public.fa_negotiation(p_player uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.players;
  v_fa public.free_agents;
  v_w public.career_worlds;
  v_club uuid;
  v_mine public.fa_applications;
  v_date date;
  v_base numeric;
  v_bal bigint;
  v_pending bigint;
begin
  select * into v_p from public.players where id = p_player;
  if v_p.id is null or not public.is_world_member(v_p.world_id) then
    raise exception 'Spieler nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  select * into v_fa from public.free_agents where player_id = p_player;
  if v_fa.player_id is null then return jsonb_build_object('available', false, 'player_id', p_player); end if;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  select id into v_club from public.clubs where world_id = v_p.world_id and manager_user_id = auth.uid();
  select * into v_mine from public.fa_applications where player_id = p_player and club_id = v_club and status = 'pending';
  if v_club is not null then
    v_base := public.fd_fa_base(p_player, v_club);
    v_bal := coalesce((select balance from public.finances where club_id = v_club), 0);
    select coalesce(sum(annual_salary), 0) into v_pending from public.fa_applications where club_id = v_club and status = 'pending' and id is distinct from v_mine.id;
  end if;
  return jsonb_build_object(
    'available', true,
    'player', jsonb_build_object('id', v_p.id, 'name', trim(coalesce(v_p.first_name, '') || ' ' || v_p.last_name), 'age', v_p.age,
      'position', v_p.main_position, 'overall', v_p.overall, 'nationality', v_p.nationality),
    'ask', v_fa.annual_salary,
    'min_salary', round(v_fa.annual_salary * 0.4),
    'max_salary', round(v_fa.annual_salary * 2.5),
    'budget', greatest(0, coalesce(v_bal, 0) - coalesce(v_pending, 0)),
    'decision_on', v_fa.decision_on,
    'days_left', case when v_fa.decision_on is null then null else greatest(0, v_fa.decision_on - v_date) end,
    'window_open', (public.fd_open_window(v_p.world_id)).id is not null,
    'limit', jsonb_build_object('used', case when v_club is null then 0 else public.fd_fa_signings(v_club, v_w.current_season_id) end, 'max', 2),
    'my_club', case when v_club is null then null else public.fd_club_ref(v_club) end,
    'mine', case when v_mine.id is null then null else jsonb_build_object('id', v_mine.id, 'salary', v_mine.annual_salary, 'years', v_mine.contract_years) end,
    -- Modell für die Live-Vorschau des eigenen Barometers (nur die Summe der verdeckten Faktoren)
    'model', case when v_base is null then null else jsonb_build_object(
      'base', v_base, 'money', round(40 * public.fd_fa_money_pref(p_player, v_p.age), 3),
      'years', (select jsonb_agg(public.fd_fa_years_term(v_p.age, y) order by y) from generate_series(1, 5) y),
      'mu', public.fd_fa_mu(v_p.overall, v_p.age), 's', 5, 't', 4) end,
    'board', coalesce((select jsonb_agg(jsonb_build_object('club', public.fd_club_ref(b.club_id), 'mine', b.club_id = v_club,
        'barometer', round(b.prob * 100)::int,
        -- Nutzwert der Konkurrenz nur für die Live-Vorschau (keine Gehälter)
        'u', case when b.club_id = v_club then null else round(b.utility, 1) end)
        order by b.prob desc, b.club_id)
      from public.fd_fa_board(p_player) b), '[]'::jsonb)
  );
end;
$$;

-- Übersicht: Barometer statt fremder Details
create or replace function public.fa_overview(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  v_w public.career_worlds;
  v_date date;
begin
  perform public.fd_require_member(p_world);
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = auth.uid();
  select * into v_w from public.career_worlds where id = p_world;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  return jsonb_build_object(
    'today', v_date,
    'limit', jsonb_build_object('used', case when v_club is null then 0 else public.fd_fa_signings(v_club, v_w.current_season_id) end, 'max', 2),
    'window_open', (public.fd_open_window(p_world)).id is not null,
    'open', coalesce((select jsonb_agg(jsonb_build_object('player_id', f.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
        'overall', p.overall, 'age', p.age, 'position', p.main_position, 'salary', f.annual_salary, 'decision_on', f.decision_on, 'days_left', greatest(0, f.decision_on - v_date),
        'clubs', (select jsonb_agg(public.fd_club_ref(a.club_id) order by a.created_at) from public.fa_applications a where a.player_id = f.player_id and a.status = 'pending'),
        'mine', exists (select 1 from public.fa_applications a where a.player_id = f.player_id and a.status = 'pending' and a.club_id = v_club),
        'my_barometer', (select round(b.prob * 100)::int from public.fd_fa_board(f.player_id) b where b.club_id = v_club),
        'application_id', (select a.id from public.fa_applications a where a.player_id = f.player_id and a.status = 'pending' and a.club_id = v_club))
        order by f.decision_on, p.overall desc)
      from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = p_world and f.decision_on is not null), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'player_id', a.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
        'status', a.status, 'note', a.note, 'created_on', a.created_on, 'salary', a.annual_salary) order by a.created_at desc)
      from public.fa_applications a join public.players p on p.id = a.player_id where a.club_id = v_club and a.season_id = v_w.current_season_id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('player_id', a.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name), 'club', public.fd_club_ref(a.club_id),
          'applicants', (select count(*) from public.fa_applications b where b.player_id = a.player_id and b.decided_at = a.decided_at), 'at', a.decided_at) x
        from public.fa_applications a join public.players p on p.id = a.player_id
        where a.world_id = p_world and a.status = 'signed' order by a.decided_at desc limit 10) q), '[]'::jsonb));
end;
$$;

update public.fa_applications a set utility = public.fd_fa_utility(a.player_id, a.club_id, a.annual_salary, a.contract_years) where a.status = 'pending';

do $$ declare f text; begin
  foreach f in array array['public.fd_fa_money_pref(uuid, integer)', 'public.fd_fa_mu(integer, integer)', 'public.fd_fa_years_term(integer, integer)',
    'public.fd_fa_base(uuid, uuid)', 'public.fd_fa_utility(uuid, uuid, bigint, integer)', 'public.fd_fa_probs(numeric[], numeric, numeric, numeric)', 'public.fd_fa_draw(numeric[], numeric, numeric, numeric)',
    'public.fd_fa_offer_problem(uuid, uuid, bigint, uuid)', 'public.fd_fa_board(uuid)', 'public.fd_fa_refresh(uuid)',
    'public.fd_fa_apply(uuid, uuid, integer, bigint)', 'public.fd_fa_ai_salary(uuid, uuid, integer, numeric)', 'public.fd_fa_ai_adjust(uuid)',
    'public.fd_fa_process(uuid)', 'public.fd_ai_fa_interest(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.fa_offer(uuid, bigint, integer)', 'public.fa_negotiation(uuid)', 'public.fa_overview(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
-- =============================================================================
-- 0034 Teil 2: Internationale Spielerdaten nach UEFA-Länderranking reduzieren
-- =============================================================================
-- Spielland: drei Ligen mit vollen Kadern. UEFA-Top-20 (Fünfjahreswertung): volle Kader.
-- Übrige Länder: je Verein die besten elf in Grundordnung (1 TW, 4 Abwehr, 3 Mittelfeld, 3 Angriff).
-- Für Europapokal-Teilnehmer mit kleinem Kader entstehen temporäre Ergänzungsspieler (Bank),
-- die nicht auf dem Transfermarkt erscheinen und zum Saisonende wieder entfernt werden.

create table if not exists public.uefa_ranking (
  code char(3) primary key references public.associations(code),
  rank smallint not null
);
alter table public.uefa_ranking enable row level security;
drop policy if exists read_uefa_ranking on public.uefa_ranking;
create policy read_uefa_ranking on public.uefa_ranking for select to authenticated using (true);
grant select on public.uefa_ranking to authenticated;
-- UEFA-Fünfjahreswertung der Verbände (Stand Saison 2025/26), Plätze 1–25
insert into public.uefa_ranking(code, rank) values
  ('ENG', 1), ('ITA', 2), ('ESP', 3), ('GER', 4), ('FRA', 5), ('POR', 6), ('BEL', 7), ('NED', 8), ('TUR', 9), ('CZE', 10),
  ('POL', 11), ('GRE', 12), ('NOR', 13), ('DEN', 14), ('CYP', 15), ('SUI', 16), ('AUT', 17), ('HUN', 18), ('SCO', 19), ('CRO', 20),
  ('SWE', 21), ('ROU', 22), ('UKR', 23), ('ISR', 24), ('AZE', 25)
on conflict (code) do update set rank = excluded.rank;

alter table public.players add column if not exists temporary boolean not null default false;
comment on column public.players.temporary is 'Temporärer Ergänzungsspieler (Europapokal-Bank kleiner Kader), nicht transferierbar, wird zum Saisonende entfernt';
create index if not exists players_temporary_idx on public.players(world_id) where temporary;

-- Voller Kader? Spielland immer, sonst UEFA-Top-20
create or replace function public.fd_full_squad_assoc(p_world uuid, p_code text)
returns boolean language sql stable set search_path = '' as $$
  select p_code = public.fd_world_country(p_world)
      or exists (select 1 from public.uefa_ranking r where r.code = p_code and r.rank <= 20);
$$;

-- Mannschaftsstärke ohne temporäre Ergänzungsspieler (KI-Balancing unverändert)
create or replace function public.fd_club_strength(p_club uuid)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(avg(o), 50) from (select p.overall o from public.players p where p.club_id = p_club and not p.retired and not p.temporary order by p.overall desc limit 11) x;
$$;

-- Bestehende Welten bereinigen: nur Spieler ohne Historie (keine Transfers, Angebote, Spiele, Auszeichnungen …)
create or replace function public.fd_reduce_world_players(p_world uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_season uuid := (select current_season_id from public.career_worlds where id = p_world);
  v_before integer;
  v_del integer := 0;
begin
  select count(*) into v_before from public.players where world_id = p_world;
  create temporary table if not exists fd_tmp_reduce (player_id uuid primary key) on commit drop;
  delete from fd_tmp_reduce where true;
  insert into fd_tmp_reduce(player_id)
  select x.id from (
    select p.id, p.club_id, public.fd_pos_group(p.main_position::text) grp,
           row_number() over (partition by p.club_id, public.fd_pos_group(p.main_position::text) order by p.overall desc, p.id) rn_grp,
           row_number() over (partition by p.club_id order by p.overall desc, p.id) rn_all
    from public.players p join public.clubs c on c.id = p.club_id
    where p.world_id = p_world and c.control = 'ai' and not c.amateur and not p.temporary
      and not public.fd_full_squad_assoc(p_world, c.association_code::text)
      -- Europapokal-Teilnehmer der laufenden Saison erst zum Saisonende verkleinern
      and not exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                      where e.club_id = c.id and co.season_id = v_season and co.kind::text in ('champions_league', 'europa_league'))
  ) x
  where not (x.rn_grp <= case x.grp when 'GK' then 1 when 'DEF' then 4 else 3 end);
  -- Fehlt einer Gruppe ein Spieler, rückt der Beste der übrigen nach (immer elf Spieler)
  delete from fd_tmp_reduce t using (
    select r.player_id, p.club_id, row_number() over (partition by p.club_id order by p.overall desc, p.id) rn,
           11 - (select count(*) from public.players q where q.club_id = p.club_id and not q.temporary
                 and not exists (select 1 from fd_tmp_reduce z where z.player_id = q.id)) missing
    from fd_tmp_reduce r join public.players p on p.id = r.player_id) m
  where t.player_id = m.player_id and m.rn <= m.missing;
  -- Schutz: Spieler mit Historie oder laufenden Vorgängen bleiben erhalten
  delete from fd_tmp_reduce t where
       exists (select 1 from public.transfers x where x.player_id = t.player_id)
    or exists (select 1 from public.transfer_offers x where x.player_id = t.player_id)
    or exists (select 1 from public.match_player_stats x where x.player_id = t.player_id)
    or exists (select 1 from public.match_events x where x.player_id = t.player_id or x.secondary_player_id = t.player_id)
    or exists (select 1 from public.season_awards x where x.player_id = t.player_id)
    or exists (select 1 from public.career_history x where x.player_id = t.player_id)
    or exists (select 1 from public.competition_records x where x.player_id = t.player_id)
    or exists (select 1 from public.fa_applications x where x.player_id = t.player_id)
    or exists (select 1 from public.draft_picks x where x.player_id = t.player_id)
    or exists (select 1 from public.tactical_profile_slots x where x.player_id = t.player_id);
  if not p_dry_run then
    delete from public.players p using fd_tmp_reduce t where p.id = t.player_id;
    get diagnostics v_del = row_count;
  else
    select count(*) into v_del from fd_tmp_reduce;
  end if;
  return jsonb_build_object('world', p_world, 'before', v_before, 'removed', v_del, 'after', v_before - case when p_dry_run then 0 else v_del end, 'dry_run', p_dry_run);
end;
$$;

-- Temporäre Ergänzungsspieler: Europapokal-Teilnehmer mit weniger als 16 Spielern auffüllen
create or replace function public.fd_ensure_ec_bench(p_world uuid, p_season uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  c record;
  v_pos text[] := array['GK', 'CB', 'LB', 'CM', 'CDM', 'ST', 'RW'];
  v_i integer;
  v_need integer;
  v_src uuid;
  v_new uuid;
  v_n integer := 0;
  v_shirt integer;
begin
  for c in select e.club_id from public.competition_entries e join public.competitions co on co.id = e.competition_id
           join public.clubs cl on cl.id = e.club_id
           where co.season_id = p_season and co.kind::text in ('champions_league', 'europa_league') and cl.control = 'ai'
             and (select count(*) from public.players p where p.club_id = e.club_id and not p.retired) < 16 loop
    v_need := 16 - (select count(*) from public.players p where p.club_id = c.club_id and not p.retired);
    for v_i in 1..least(v_need, 7) loop
      -- Vorlage: schwächster Stammspieler derselben Positionsgruppe (Attribute skaliert)
      select p.id into v_src from public.players p where p.club_id = c.club_id and not p.temporary
        and public.fd_pos_group(p.main_position::text) = public.fd_pos_group(v_pos[v_i]) order by p.overall limit 1;
      if v_src is null then select p.id into v_src from public.players p where p.club_id = c.club_id and not p.temporary order by p.overall limit 1; end if;
      continue when v_src is null;
      select coalesce(max(shirt_number), 0) + 1 into v_shirt from public.players where club_id = c.club_id;
      insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                                 overall, fitness, market_value, shirt_number, club_id, temporary)
      select p_world, p.first_name, (select q.last_name from public.players q where q.world_id = p_world and q.nationality = p.nationality
                                      order by md5(c.club_id::text || v_i || q.id::text) limit 1),
             p.nationality, p.region, least(34, greatest(18, p.age - 2 + v_i % 5)), v_pos[v_i]::public.player_position, '{}',
             greatest(35, p.overall - 4), 100, 0, least(99, v_shirt), c.club_id, true
      from public.players p where p.id = v_src returning id into v_new;
      insert into public.player_attributes(player_id, world_id, kind, attributes)
      select v_new, p_world, pa.kind, (select jsonb_object_agg(k, greatest(20, least(99, (v::numeric) - 4))) from jsonb_each_text(pa.attributes) a(k, v))
      from public.player_attributes pa where pa.player_id = v_src;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end;
$$;

-- Saisonende: temporäre Spieler entfernen (mit Spielereignissen: ohne Verein archivieren), Kader verkleinern
create or replace function public.fd_cleanup_temporary_players(p_world uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare v_n integer;
begin
  update public.players p set club_id = null, retired = true
  where p.world_id = p_world and p.temporary
    and exists (select 1 from public.match_events x where x.player_id = p.id or x.secondary_player_id = p.id);
  delete from public.players p where p.world_id = p_world and p.temporary and p.club_id is not null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

do $$ declare f text; begin
  foreach f in array array['public.fd_full_squad_assoc(uuid, text)', 'public.fd_reduce_world_players(uuid, boolean)',
    'public.fd_ensure_ec_bench(uuid, uuid)', 'public.fd_cleanup_temporary_players(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
CREATE OR REPLACE FUNCTION public.transfer_market_search(p_world uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_season uuid;
  v_cc text := public.fd_world_country(p_world);
  v_my uuid;
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_result jsonb;
  v_sort text := coalesce(f ->> 'sort', 'overall');
  v_desc boolean := coalesce(f ->> 'dir', case when coalesce(f ->> 'sort', 'overall') in ('age', 'name') then 'asc' else 'desc' end) = 'desc';
begin
  if not public.is_world_member(p_world) then raise exception 'Kein Zugriff.' using errcode = '42501', hint = 'forbidden'; end if;
  select current_season_id into v_season from public.career_worlds where id = p_world;
  select id into v_my from public.clubs where world_id = p_world and manager_user_id = auth.uid();
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  with tiers as (
    select ce.club_id, co.tier from public.competition_entries ce join public.competitions co on co.id = ce.competition_id
    where co.season_id = v_season and co.kind = 'league'
  ),
  base as (
    select p.id, p.first_name, p.last_name, p.age, p.main_position, p.secondary_positions, p.overall, p.market_value, p.nationality,
           c.id as club_id, c.name as club_name, c.short_name, c.control, c.association_code,
           case when c.id is null then null when c.association_code = v_cc then v_cc || coalesce(t.tier::text, '4') else c.association_code end as league_key,
           case when c.id is null then null when c.association_code = v_cc then coalesce((select co.name from public.competitions co where co.season_id = v_season and co.kind = 'league' and co.tier = t.tier limit 1), 'Amateurliga') else c.league_name end as league_name,
           fa.annual_salary as fa_salary, b.primary_color
    from public.players p
    left join public.clubs c on c.id = p.club_id
    left join tiers t on t.club_id = c.id
    left join public.free_agents fa on fa.player_id = p.id
    left join public.club_branding b on b.club_id = c.id
    where p.world_id = p_world and not p.retired and not p.temporary
      and ((c.id is not null and not c.amateur and c.id is distinct from v_my) or (c.id is null and fa.player_id is not null))
      and (not coalesce((f ->> 'free_agents')::boolean, false) or c.id is null)
      and (f ->> 'country' is null or (c.id is not null and c.association_code = f ->> 'country') or (c.id is null and p.nationality = f ->> 'country'))
      and (f ->> 'club' is null or c.id = (f ->> 'club')::uuid)
      and (f ->> 'position' is null or p.main_position::text = f ->> 'position')
      and (f ->> 'nationality' is null or p.nationality = f ->> 'nationality')
      and (f ->> 'min_age' is null or p.age >= (f ->> 'min_age')::int)
      and (f ->> 'max_age' is null or p.age <= (f ->> 'max_age')::int)
      and (f ->> 'min_overall' is null or p.overall >= (f ->> 'min_overall')::int)
      and (f ->> 'max_overall' is null or p.overall <= (f ->> 'max_overall')::int)
      and (f ->> 'min_value' is null or p.market_value >= (f ->> 'min_value')::bigint)
      and (f ->> 'max_value' is null or p.market_value <= (f ->> 'max_value')::bigint)
      and (f ->> 'search' is null or (p.first_name || ' ' || p.last_name) ilike '%' || replace(replace(f ->> 'search', '%', ''), '_', '') || '%')
  ),
  filtered as (
    select * from base where f ->> 'league' is null or league_key = f ->> 'league'
  ),
  page as (
    select *, count(*) over () as total from filtered
    order by
      case when v_desc and v_sort = 'overall' then overall end desc nulls last,
      case when not v_desc and v_sort = 'overall' then overall end asc nulls last,
      case when v_desc and v_sort = 'value' then market_value end desc nulls last,
      case when not v_desc and v_sort = 'value' then market_value end asc nulls last,
      case when v_desc and v_sort = 'age' then age end desc nulls last,
      case when not v_desc and v_sort = 'age' then age end asc nulls last,
      case when v_desc and v_sort = 'name' then last_name end desc nulls last,
      case when not v_desc and v_sort = 'name' then last_name end asc nulls last,
      overall desc, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'total', coalesce((select total from page limit 1), 0),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'first_name', first_name, 'last_name', last_name, 'age', age, 'main_position', main_position,
      'secondary_positions', secondary_positions, 'overall', overall, 'market_value', market_value, 'nationality', nationality,
      'salary', fa_salary, 'league_key', league_key, 'league_name', league_name,
      'club', case when club_id is null then null else jsonb_build_object('id', club_id, 'name', club_name, 'short_name', short_name, 'control', control, 'association_code', association_code, 'color', primary_color) end
    )), '[]'::jsonb))
  into v_result from page;
  return v_result;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.fd_ai_transfer_batch(p_world uuid, p_limit integer DEFAULT 40)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_w public.career_worlds;
  v_win public.transfer_windows;
  c record;
  g record;
  v_need text;
  v_need_avg numeric;
  v_top numeric;
  v_target record;
  v_strat text;
  v_bal bigint;
  v_fee bigint;
  v_max bigint;
  v_left integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_win := public.fd_open_window(p_world);
  if v_win.id is null then return 0; end if;
  for c in
    select cl.id from public.clubs cl
    where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
      -- Vereine mit Spielbetrieb jede Woche; aus den übrigen Ländern nur gelegentliche Käufer (~3 % je Woche),
      -- damit der Markt für Vereine aktiver Länder weiter Nachfrage aus Europa hat
      and (cl.id in (select public.fd_active_club_ids(p_world)) or public.fd_hash01(cl.id::text || ':fx:' || v_w.current_season_id || ':' || v_w.current_week) < 0.03)
      and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week)
    order by exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                     where e.club_id = cl.id and co.season_id = v_w.current_season_id) desc, cl.id
    limit p_limit
  loop
    insert into public.ai_transfer_log(club_id, season_id, week_no, world_id) values (c.id, v_w.current_season_id, v_w.current_week, p_world) on conflict do nothing;
    -- nicht jeder Verein ist jede Woche aktiv; volle Kader, ausgeschöpfte Limits und laufende Verhandlungen bremsen
    continue when public.fd_hash01(c.id::text || ':' || v_w.current_week || ':' || v_w.current_season_id) > 0.2;
    continue when (select count(*) from public.players where club_id = c.id) >= 27;
    continue when (select count(*) from public.transfers t where t.window_id = v_win.id and t.to_club_id = c.id and t.kind in ('transfer', 'free_agent')) >= 2;
    continue when (select count(*) from public.transfer_offers o where o.to_club_id = c.id and o.status in ('pending', 'countered')) >= 2;
    select balance into v_bal from public.finances where club_id = c.id;
    continue when coalesce(v_bal, 0) < 500000;
    v_strat := public.fd_ai_strategy(c.id);
    -- Bedarf: schwächste Positionsgruppe relativ zur eigenen Stammelf
    select avg(o) into v_top from (select overall o from public.players where club_id = c.id order by overall desc limit 11) x;
    v_need := null; v_need_avg := null;
    for g in
      select grp, avg(overall) av from (
        select public.fd_pos_group(main_position::text) grp, overall, row_number() over (partition by public.fd_pos_group(main_position::text) order by overall desc) rn
        from public.players where club_id = c.id) x
      where rn <= case grp when 'GK' then 1 when 'ATT' then 2 else 4 end group by grp
    loop
      if v_need_avg is null or g.av - v_top < v_need_avg - v_top then v_need := g.grp; v_need_avg := g.av; end if;
    end loop;
    continue when v_need is null;
    select p.id, p.market_value, p.age, p.overall into v_target
    from public.players p join public.clubs s on s.id = p.club_id
    where p.world_id = p_world and s.control = 'ai' and s.id <> c.id and not p.retired and not p.temporary
      and public.fd_pos_group(p.main_position::text) = v_need
      and p.overall between v_need_avg + 2 and least(v_need_avg + 7, v_top + 6)
      and p.market_value <= v_bal * 0.5
      and case v_strat when 'talents' then p.age <= 22 when 'established' then p.age between 24 and 30
                       when 'bargain' then p.age >= 28 or p.market_value < 2000000 else true end
      and not exists (select 1 from public.transfer_offers o where o.player_id = p.id and o.to_club_id = c.id)
    order by p.overall - p.market_value / 1e6 * 0.3 desc, md5(p.id::text || c.id::text) limit 1;
    continue when v_target.id is null;
    v_fee := (round(v_target.market_value * case v_strat when 'bargain' then 0.75 when 'profit' then 0.8 when 'talents' then 0.95 else 1.0 end / 50000) * 50000)::bigint;
    v_max := least((v_bal * 0.6)::bigint, (v_target.market_value * case v_strat when 'established' then 1.25 when 'talents' then 1.3 when 'bargain' then 1.0 else 0.95 end * 1.1)::bigint);
    begin
      perform public.fd_offer_open(v_target.id, c.id, greatest(v_fee, 50000), public.fd_player_demand(v_target.id, c.id),
        case when v_target.age < 25 then 4 when v_target.age < 29 then 3 else 2 end, greatest(v_max, v_fee));
    exception when others then null;
    end;
  end loop;
  select count(*) into v_left from public.clubs cl where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
    and (cl.id in (select public.fd_active_club_ids(p_world)) or public.fd_hash01(cl.id::text || ':fx:' || v_w.current_season_id || ':' || v_w.current_week) < 0.03)
    and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week);
  return v_left;
end;
$function$
;


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


CREATE OR REPLACE FUNCTION public.fd_setup_europe(p_world uuid, p_season uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_w public.career_worlds;
  v_cc text;
  v_prev uuid;
  v_prev_year integer;
  v_t1 uuid;
  v_cupwin uuid;
  v_ncl integer;
  v_nel integer;
  v_kind text;
  v_comp uuid;
  v_stage uuid;
  v_groups uuid[];
  v_grp_assoc text[];
  v_list uuid[];
  v_pot integer;
  v_club uuid;
  v_assoc text;
  v_g integer;
  v_try integer;
  v_mem uuid[];
  v_round integer;
  v_pairs integer[] := array[1,2, 3,4,  4,1, 2,3,  1,3, 4,2,  2,1, 4,3,  1,4, 3,2,  3,1, 2,4];
  v_slot public.season_slots;
  v_k integer;
  v_seed text;
  v_code text;
  v_pos integer;
  v_a record;
  v_guard integer;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_cc := v_w.country_code::text;
  if exists (select 1 from public.competitions where season_id = p_season and kind::text in ('champions_league', 'europa_league')) then
    return jsonb_build_object('status', 'exists');
  end if;
  if not exists (select 1 from public.season_slots where season_id = p_season and kind = 'europe') then
    return jsonb_build_object('status', 'no_slots');
  end if;
  -- Qualifikation ausschließlich über die abgeschlossene Vorsaison (Saison 1: kein Europapokal)
  select id, year into v_prev, v_prev_year from public.seasons
  where world_id = p_world and status::text = 'closed' and id <> p_season order by year desc limit 1;
  if v_prev is null then return jsonb_build_object('status', 'first_season'); end if;
  delete from public.ec_qualifications where season_id = p_season; -- Neuaufbau (nur ohne Wettbewerbe möglich)
  v_seed := v_w.seed || ':' || p_season::text;

  create temporary table if not exists fd_tmp_ec (club_id uuid primary key, comp text, score numeric, assoc text, reason text, prio integer, strength numeric) on commit drop;
  delete from fd_tmp_ec where true;
  create temporary table if not exists fd_tmp_alloc (code text primary key, score numeric, bonus numeric, rk integer, cl integer, el integer, cup boolean) on commit drop;
  delete from fd_tmp_alloc where true;
  insert into fd_tmp_alloc select * from public.fd_ec_allocation(p_world, v_prev);
  -- Rangliste festhalten (Verlauf je Welt)
  insert into public.association_strength_history(world_id, association_code, season_year, strength)
  select p_world, code, v_prev_year, least(100, greatest(0, score)) from fd_tmp_alloc
  on conflict (world_id, association_code, season_year) do update set strength = excluded.strength;

  -- a) Spielland: Abschlusstabelle der 1. Liga der Vorsaison + Pokalsieger
  select id into v_t1 from public.competitions where season_id = v_prev and kind = 'league' and tier = 1;
  select cl, el into v_ncl, v_nel from fd_tmp_alloc where code = v_cc;
  if v_t1 is not null then
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select t.club_id, case when t.pos <= v_ncl then 'cl' else 'el' end, 1000 - t.pos, v_cc,
           case when t.pos = 1 then 'Meister' else 'Platz ' || t.pos || ' ' || public.fd_league_name(v_cc, 1) end, 1, public.fd_club_strength(t.club_id)
    from public.fd_table(v_t1) t where t.pos <= v_ncl + v_nel;
    select t.winner_club_id into v_cupwin from public.ties t join public.competition_stages st on st.id = t.stage_id
    join public.competitions c on c.id = st.competition_id where c.season_id = v_prev and c.kind = 'domestic_cup' and st.kind = 'final';
    if v_cupwin is not null and not exists (select 1 from fd_tmp_ec where club_id = v_cupwin) then
      -- Pokalsieger (auch aus 2./3. Liga): einziger Weg für Unterklassige
      insert into fd_tmp_ec values (v_cupwin, 'el', 900, v_cc, 'Pokalsieger', 1, public.fd_club_strength(v_cupwin));
    else
      -- Pokalsieger bereits über die Liga qualifiziert (oder kein Sieger): Platz geht an den nächstbesten Erstligisten
      select t.club_id, t.pos into v_club, v_pos from public.fd_table(v_t1) t
      where not exists (select 1 from fd_tmp_ec x where x.club_id = t.club_id) order by t.pos limit 1;
      if v_club is not null then
        insert into fd_tmp_ec values (v_club, 'el', 1000 - v_pos, v_cc,
          'Platz ' || v_pos || ' ' || public.fd_league_name(v_cc, 1) || case when v_cupwin is not null then ' (Pokalsieger bereits qualifiziert)' else ' (Pokalplatz)' end,
          1, public.fd_club_strength(v_club));
      end if;
    end if;
  end if;

  -- b) Übrige Länder (keine Simulation): Rangfolge je Land aus Stärke, Reputation und begrenztem Zufall
  create temporary table if not exists fd_tmp_ec_cand (club_id uuid primary key, assoc text, score numeric, strength numeric, rn integer) on commit drop;
  delete from fd_tmp_ec_cand where true;
  insert into fd_tmp_ec_cand(club_id, assoc, score, strength)
  select c.id, c.association_code::text,
         public.fd_club_strength(c.id) + coalesce(c.reputation, 0) * 0.05 + (public.fd_hash01(v_seed || ':ec:' || c.id::text) - 0.5) * 4,
         public.fd_club_strength(c.id)
  from public.clubs c
  where c.world_id = p_world and not c.amateur and c.control = 'ai' and c.association_code::text <> v_cc;
  update fd_tmp_ec_cand k set rn = x.rn from (
    select club_id, row_number() over (partition by assoc order by score desc, club_id) rn from fd_tmp_ec_cand) x
  where x.club_id = k.club_id;
  -- Champions League: Meister und Ligaplätze nach Länderrangliste
  insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
  select k.club_id, 'cl', k.score, k.assoc, case when k.rn = 1 then 'Meister' else 'Platz ' || k.rn end, 1, k.strength
  from fd_tmp_ec_cand k join fd_tmp_alloc a on a.code = k.assoc where k.rn <= a.cl;
  -- Europa League: nächstbeste Ligaplätze
  insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
  select k.club_id, 'el', k.score, k.assoc, 'Platz ' || k.rn, 1, k.strength
  from fd_tmp_ec_cand k join fd_tmp_alloc a on a.code = k.assoc where k.rn > a.cl and k.rn <= a.cl + a.el;
  -- Pokalsieger: gewichtete Zufallsauswahl unter den noch nicht qualifizierten Vereinen eines Landes
  for v_a in select * from fd_tmp_alloc where cup and code <> v_cc order by rk loop
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'el', k.score, k.assoc, 'Pokalsieger', 1, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_a.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by public.fd_wkey(v_seed || ':cup:' || k.club_id::text, exp(least(0, k.strength - (select max(strength) from fd_tmp_ec_cand m where m.assoc = v_a.code)) / 3.0)) desc
    limit 1;
  end loop;

  -- c) Kleinere Nationen: weitere Meister (CL) und Pokalsieger (EL) per gewichteter Länderauswahl
  v_guard := 0;
  while (select count(*) from fd_tmp_ec where comp = 'cl') < 32 and v_guard < 60 loop
    v_guard := v_guard + 1;
    select al.code into v_code from fd_tmp_alloc al
    where al.code <> v_cc and not exists (select 1 from fd_tmp_ec x where x.assoc = al.code and x.comp = 'cl')
      and exists (select 1 from fd_tmp_ec_cand k where k.assoc = al.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id))
    order by public.fd_wkey(v_seed || ':clsmall:' || al.code, power(al.score, 2)) desc limit 1;
    exit when v_code is null;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'cl', k.score, k.assoc, 'Meister (kleinere Nation)', 2, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id) order by k.rn limit 1;
  end loop;
  v_guard := 0;
  while (select count(*) from fd_tmp_ec where comp = 'el') < 32 and v_guard < 60 loop
    v_guard := v_guard + 1;
    select al.code into v_code from fd_tmp_alloc al
    where al.code <> v_cc and not exists (select 1 from fd_tmp_ec x where x.assoc = al.code and x.comp = 'el' and x.reason like 'Pokalsieger%')
      and exists (select 1 from fd_tmp_ec_cand k where k.assoc = al.code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id))
    order by public.fd_wkey(v_seed || ':elsmall:' || al.code, power(al.score, 2)) desc limit 1;
    exit when v_code is null;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, 'el', k.score, k.assoc, 'Pokalsieger (kleinere Nation)', 2, k.strength from fd_tmp_ec_cand k
    where k.assoc = v_code and not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by public.fd_wkey(v_seed || ':cupsmall:' || k.club_id::text, exp(least(0, k.strength - (select max(strength) from fd_tmp_ec_cand m where m.assoc = v_code)) / 3.0)) desc
    limit 1;
  end loop;

  -- d) Sicherung: exakt 32 je Wettbewerb (fehlende Länder/Vereine → Nachrücker nach Stärke)
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select k.club_id, v_kind, k.score, k.assoc, 'Nachrücker', 3, k.strength from fd_tmp_ec_cand k
    left join public.associations s on s.code = k.assoc
    where not exists (select 1 from fd_tmp_ec x where x.club_id = k.club_id)
    order by k.score + coalesce(s.start_strength, 0) * 0.1 desc, k.club_id
    limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    if v_t1 is not null then
      insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
      select t.club_id, v_kind, 1000 - t.pos, v_cc, 'Nachrücker (Platz ' || t.pos || ')', 3, public.fd_club_strength(t.club_id)
      from public.fd_table(v_t1) t where not exists (select 1 from fd_tmp_ec x where x.club_id = t.club_id)
      order by t.pos limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    end if;
    insert into fd_tmp_ec(club_id, comp, score, assoc, reason, prio, strength)
    select c.id, v_kind, 0, c.association_code, 'Nachrücker', 4, public.fd_club_strength(c.id) from public.clubs c
    where c.world_id = p_world and not c.amateur and not exists (select 1 from fd_tmp_ec x where x.club_id = c.id)
    order by public.fd_club_strength(c.id) desc, c.id
    limit greatest(0, 32 - (select count(*) from fd_tmp_ec where comp = v_kind));
    -- zu viele (nur theoretisch): schwächste Zusatzplätze streichen
    delete from fd_tmp_ec x where x.club_id in (
      select club_id from fd_tmp_ec where comp = v_kind order by prio asc, score desc offset 32);
  end loop;

  insert into public.ec_qualifications(world_id, season_id, club_id, competition, reason, association_code, association_rank)
  select p_world, p_season, x.club_id, x.comp, x.reason, x.assoc, a.rk from fd_tmp_ec x left join fd_tmp_alloc a on a.code = x.assoc
  on conflict do nothing;

  -- e) Wettbewerbe: 8 Gruppen à 4 (Lostöpfe nach Stärke, möglichst kein Land doppelt in einer Gruppe)
  for v_kind in select unnest(array['cl', 'el']) loop
    insert into public.competitions(world_id, season_id, kind, association_code, name, neutral_final_venue)
    values (p_world, p_season, case v_kind when 'cl' then 'champions_league' else 'europa_league' end::public.competition_kind, null,
            case v_kind when 'cl' then 'Champions League' else 'Europa League' end, 'Neutraler Finalort')
    on conflict do nothing returning id into v_comp;
    if v_comp is null then
      select id into v_comp from public.competitions where season_id = p_season and kind::text = case v_kind when 'cl' then 'champions_league' else 'europa_league' end;
    end if;
    insert into public.competition_entries(competition_id, club_id, world_id, seed_rank)
    select v_comp, t.club_id, p_world, row_number() over (order by t.strength desc, t.club_id)
    from fd_tmp_ec t where t.comp = v_kind on conflict do nothing;
    insert into public.competition_stages(competition_id, world_id, kind, ordinal) values (v_comp, p_world, 'group', 1)
    on conflict (competition_id, kind) do update set ordinal = 1 returning id into v_stage;
    v_groups := array[]::uuid[];
    for v_g in 1..8 loop
      insert into public.competition_groups(stage_id, world_id, label) values (v_stage, p_world, chr(64 + v_g))
      on conflict (stage_id, label) do update set label = excluded.label returning id into v_club;
      v_groups := v_groups || v_club;
    end loop;
    v_grp_assoc := array['', '', '', '', '', '', '', ''];
    select array_agg(e.club_id order by e.seed_rank) into v_list from public.competition_entries e where e.competition_id = v_comp;
    for v_pot in 1..4 loop
      for v_club in select c from unnest(v_list[(v_pot - 1) * 8 + 1 : v_pot * 8]) c order by md5(v_seed || v_kind || v_pot || c::text) loop
        v_assoc := (select association_code from public.clubs where id = v_club);
        v_g := null;
        for v_try in select g from generate_series(1, 8) g order by md5(v_seed || v_club::text || g) loop
          if not exists (select 1 from public.group_memberships gm where gm.group_id = v_groups[v_try] and gm.pot = v_pot)
             and position('|' || v_assoc || '|' in v_grp_assoc[v_try]) = 0 then v_g := v_try; exit; end if;
        end loop;
        if v_g is null then
          select g into v_g from generate_series(1, 8) g
          where not exists (select 1 from public.group_memberships gm where gm.group_id = v_groups[g] and gm.pot = v_pot)
          order by g limit 1;
        end if;
        insert into public.group_memberships(group_id, club_id, world_id, pot) values (v_groups[v_g], v_club, p_world, v_pot) on conflict do nothing;
        v_grp_assoc[v_g] := v_grp_assoc[v_g] || '|' || v_assoc || '|';
        insert into public.standings(world_id, competition_id, group_id, club_id) values (p_world, v_comp, v_groups[v_g], v_club) on conflict do nothing;
        perform public.fd_ec_prize(v_comp, v_club, 'group_start', 'start', 'Startprämie Gruppenphase');
      end loop;
    end loop;
    -- Gruppenspiele: 6 Spieltage (jeder gegen jeden mit Hin- und Rückspiel)
    for v_g in 1..8 loop
      select array_agg(gm.club_id order by gm.pot) into v_mem from public.group_memberships gm where gm.group_id = v_groups[v_g];
      continue when coalesce(array_length(v_mem, 1), 0) < 4;
      for v_round in 1..6 loop
        select * into v_slot from public.season_slots where season_id = p_season and slot_key = 'E' || v_round;
        for v_k in 0..1 loop
          insert into public.fixtures(world_id, season_id, competition_id, stage_id, group_id, slot_key, scheduled_date, home_club_id, away_club_id, matchday)
          values (p_world, p_season, v_comp, v_stage, v_groups[v_g], v_slot.slot_key, v_slot.slot_date,
                  v_mem[v_pairs[(v_round - 1) * 4 + v_k * 2 + 1]], v_mem[v_pairs[(v_round - 1) * 4 + v_k * 2 + 2]], v_round);
        end loop;
      end loop;
    end loop;
    insert into public.draws(world_id, stage_id, seed, result)
    values (p_world, v_stage, v_w.seed, (select jsonb_agg(jsonb_build_object('group', g.label, 'clubs', (select jsonb_agg(gm.club_id order by gm.pot) from public.group_memberships gm where gm.group_id = g.id)) order by g.label)
                                         from public.competition_groups g where g.stage_id = v_stage))
    on conflict (stage_id) do nothing;
    v_comp := null;
  end loop;
  -- kleine Kader (reduzierte Länder) bekommen eine temporäre Ersatzbank
  perform public.fd_ensure_ec_bench(p_world, p_season);
  perform public.fd_refresh_active_clubs(p_world);
  return jsonb_build_object('status', 'created', 'cl', (select count(*) from fd_tmp_ec where comp = 'cl'), 'el', (select count(*) from fd_tmp_ec where comp = 'el'));
end;
$function$
;


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
  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
  insert into public.dev_aging_jobs(world_id, season_id) values (p_world, v_old.id) on conflict do nothing;
  perform public.fd_dev_season_aging(p_world, v_old.id, 2000); -- große Welten: Rest übernimmt der Server-Sweep
  update public.player_contracts set end_season_year = end_season_year + 2
  where world_id = p_world and active and end_season_year <= v_old.year;
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


-- 0034 Abschluss: bestehende Welten bereinigen (nur Spieler ohne Historie) und Ergebnis anzeigen
create table if not exists public.fd_maintenance_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  job text not null,
  result jsonb not null
);
alter table public.fd_maintenance_log enable row level security;
revoke all on public.fd_maintenance_log from anon, authenticated;

do $$
declare w record; v_r jsonb;
begin
  for w in select id from public.career_worlds where status::text <> 'lobby' loop
    v_r := public.fd_reduce_world_players(w.id);
    insert into public.fd_maintenance_log(job, result) values ('0034_reduce_players', v_r);
  end loop;
end $$;

notify pgrst, 'reload schema';

-- Ergebnis (Spieler vorher/nachher je Welt)
select (l.result ->> 'world')::uuid as welt, w.name, (l.result ->> 'before')::int as spieler_vorher, (l.result ->> 'removed')::int as entfernt,
       (l.result ->> 'after')::int as spieler_nachher, pg_size_pretty(pg_database_size(current_database())) as datenbank
from public.fd_maintenance_log l join public.career_worlds w on w.id = (l.result ->> 'world')::uuid
where l.job = '0034_reduce_players' and l.created_at > now() - interval '10 minutes' order by w.name;
