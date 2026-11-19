-- =====================================================================
-- 0024: Trainingsplan, Free-Agent-Bewerbungen, Transferverhandlungen, aktiver KI-Transfermarkt,
--       Top-Transfers, Saisonkalender, Wetter/Atmosphäre, Wettbewerbs-Theme
--
-- Alles serverseitig, idempotent und für alle Manager identisch. Match Engine und Balancing bleiben
-- unverändert. Tagesverarbeitung (fd_world_daily) läuft bei jedem Kalenderfortschritt (Freigabe eines
-- Termins) und zusätzlich im Server-Sweep – auch wenn mehrere Spieltage schnell hintereinander laufen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Gemeinsame Helfer
-- ---------------------------------------------------------------------
create or replace function public.fd_pos_group(p_pos text)
returns text language sql immutable set search_path = '' as $$
  select case when p_pos = 'GK' then 'GK'
              when p_pos in ('CB', 'LB', 'RB', 'LWB', 'RWB') then 'DEF'
              when p_pos in ('CDM', 'CM', 'CAM', 'LM', 'RM') then 'MID'
              else 'ATT' end;
$$;

-- KI-Transferstrategie je Verein (dauerhaft, aus der Vereins-ID): Talente, Etablierte, Schnäppchen, Gewinn
create or replace function public.fd_ai_strategy(p_club uuid)
returns text language sql immutable set search_path = '' as $$
  select (array['talents', 'established', 'bargain', 'profit'])[1 + floor(public.fd_hash01(p_club::text || ':strategy') * 4)::int];
$$;

create or replace function public.fd_world_date(p_world uuid)
returns date language sql stable set search_path = '' as $$
  select coalesce(current_date_in_world, current_date) from public.career_worlds where id = p_world;
$$;

-- ---------------------------------------------------------------------
-- 1) Automatischer wöchentlicher Trainingsplan
-- ---------------------------------------------------------------------
create table if not exists public.training_plans (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.training_plan_entries (
  club_id uuid not null references public.training_plans(club_id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  focus text not null check (focus in ('offense', 'defense', 'technique', 'physical', 'tactics', 'set_pieces')),
  paused boolean not null default false,
  sort smallint not null default 0,
  primary key (club_id, player_id)
);
create table if not exists public.training_plan_runs (
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  week_no smallint not null,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  executed integer not null default 0,
  skipped jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  primary key (club_id, season_id, week_no)
);
alter table public.training_plans enable row level security;
alter table public.training_plan_entries enable row level security;
alter table public.training_plan_runs enable row level security;
alter table public.training_sessions add column if not exists auto boolean not null default false;
alter table public.training_sessions add column if not exists dev_gains jsonb;

-- Verbesserungen je Einheit merken (für „erzielte Attributverbesserungen“ im Trainingsmenü)
do $patch$
declare v_def text;
begin
  select pg_get_functiondef('public.fd_dev_train(bigint)'::regprocedure) into v_def;
  if position('dev_gains' in v_def) = 0 then
    v_def := replace(v_def, $a$update public.training_sessions set dev_xp = coalesce((v_res ->> 'xp')::numeric, 0) where id = p_session;$a$,
      $b$update public.training_sessions set dev_xp = coalesce((v_res ->> 'xp')::numeric, 0), dev_gains = coalesce(v_res -> 'gains', '{}'::jsonb) where id = p_session;$b$);
    if position('dev_gains' in v_def) = 0 then raise exception 'Patch fd_dev_train fehlgeschlagen'; end if;
    execute v_def;
  end if;
end
$patch$;

-- Eine Einheit nach den bestehenden Regeln ausführen (max. 5 je Woche, 1 je Spieler, −20 Fitness, nicht verletzt/gesperrt)
create or replace function public.fd_train_player(p_world uuid, p_club uuid, p_player uuid, p_focus text, p_auto boolean)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_p public.players;
  v_sid bigint;
  v_date date;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  select * into v_p from public.players where id = p_player for update;
  if not found or v_p.club_id is distinct from p_club or v_p.retired then return 'not_in_club'; end if;
  if exists (select 1 from public.injuries i where i.player_id = p_player and v_date between i.starts_on and i.ends_on) then return 'injured'; end if;
  if exists (select 1 from public.training_sessions t where t.player_id = p_player and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week) then return 'already_trained'; end if;
  if (select count(*) from public.training_sessions t where t.club_id = p_club and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week) >= 5 then return 'training_limit'; end if;
  insert into public.training_sessions(world_id, club_id, season_id, week_no, player_id, focus, training_date, auto)
  values (p_world, p_club, v_w.current_season_id, v_w.current_week, p_player, p_focus, v_date, p_auto)
  on conflict do nothing returning id into v_sid;
  if v_sid is null then return 'already_trained'; end if;
  perform public.fd_dev_train(v_sid);
  update public.players set fitness = greatest(0, fitness - 20) where id = p_player;
  update public.player_hidden set development_points = development_points + coalesce((select dev_xp from public.training_sessions where id = v_sid), 0) where player_id = p_player;
  return 'ok';
end;
$$;

-- Plan eines Vereins für die laufende Woche ausführen (genau einmal je Woche)
create or replace function public.fd_run_training_plan(p_club uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_plan public.training_plans;
  v_w public.career_worlds;
  e record;
  v_res text;
  v_n integer := 0;
  v_skip jsonb := '[]'::jsonb;
begin
  select * into v_plan from public.training_plans where club_id = p_club for update;
  if not found or not v_plan.active then return null; end if;
  select * into v_w from public.career_worlds where id = v_plan.world_id;
  if v_w.current_season_id is null or v_w.status::text not in ('preseason', 'season') then return null; end if;
  insert into public.training_plan_runs(club_id, season_id, week_no, world_id) values (p_club, v_w.current_season_id, v_w.current_week, v_w.id)
  on conflict do nothing;
  if not found then return null; end if; -- diese Woche schon ausgeführt
  for e in select * from public.training_plan_entries where club_id = p_club and not paused order by sort, player_id loop
    v_res := public.fd_train_player(v_w.id, p_club, e.player_id, e.focus, true);
    if v_res = 'ok' then v_n := v_n + 1;
    elsif v_res <> 'already_trained' then v_skip := v_skip || jsonb_build_object('player_id', e.player_id, 'reason', v_res);
    end if;
  end loop;
  update public.training_plan_runs set executed = v_n, skipped = v_skip where club_id = p_club and season_id = v_w.current_season_id and week_no = v_w.current_week;
  return jsonb_build_object('executed', v_n, 'skipped', v_skip);
end;
$$;

create or replace function public.save_training_plan(p_world uuid, p_active boolean, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  e jsonb;
  i integer := 0;
begin
  v_club := public.fd_require_team(p_world);
  if jsonb_typeof(coalesce(p_entries, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_entries, '[]'::jsonb)) > 5 then
    raise exception 'Der Trainingsplan umfasst höchstens fünf Spieler.' using errcode = 'P0001', hint = 'training_limit';
  end if;
  insert into public.training_plans(club_id, world_id, active) values (v_club, p_world, coalesce(p_active, true))
  on conflict (club_id) do update set active = excluded.active, updated_at = now();
  delete from public.training_plan_entries where club_id = v_club;
  for e in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if not exists (select 1 from public.players where id = (e ->> 'player_id')::uuid and club_id = v_club) then
      raise exception 'Dieser Spieler gehört nicht zu deinem Kader.' using errcode = '42501', hint = 'foreign_player';
    end if;
    if coalesce(e ->> 'focus', '') not in ('offense', 'defense', 'technique', 'physical', 'tactics', 'set_pieces') then
      raise exception 'Ungültiger Trainingsschwerpunkt.' using errcode = '22023', hint = 'invalid_focus';
    end if;
    insert into public.training_plan_entries(club_id, player_id, focus, paused, sort)
    values (v_club, (e ->> 'player_id')::uuid, e ->> 'focus', coalesce((e ->> 'paused')::boolean, false), i)
    on conflict do nothing;
    i := i + 1;
  end loop;
  return public.training_plan(p_world);
end;
$$;

create or replace function public.training_plan(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  v_w public.career_worlds;
  v_last public.training_plan_runs;
begin
  v_club := public.fd_require_team(p_world);
  select * into v_w from public.career_worlds where id = p_world;
  select * into v_last from public.training_plan_runs where club_id = v_club order by created_at desc limit 1;
  return jsonb_build_object(
    'active', coalesce((select active from public.training_plans where club_id = v_club), false),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('player_id', e.player_id, 'focus', e.focus, 'paused', e.paused,
        'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name)) order by e.sort)
      from public.training_plan_entries e join public.players p on p.id = e.player_id where e.club_id = v_club), '[]'::jsonb),
    'last_run', case when v_last.club_id is null then null else jsonb_build_object('week', v_last.week_no, 'executed', v_last.executed, 'skipped', v_last.skipped,
      'at', v_last.created_at,
      'sessions', coalesce((select jsonb_agg(jsonb_build_object('player_id', t.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
          'focus', t.focus, 'xp', t.dev_xp, 'gains', coalesce(t.dev_gains, '{}'::jsonb)) order by p.last_name)
        from public.training_sessions t join public.players p on p.id = t.player_id
        where t.club_id = v_club and t.season_id = v_last.season_id and t.week_no = v_last.week_no and t.auto), '[]'::jsonb)) end,
    'this_week_done', exists (select 1 from public.training_plan_runs r where r.club_id = v_club and r.season_id = v_w.current_season_id and r.week_no = v_w.current_week));
end;
$$;

-- ---------------------------------------------------------------------
-- 2) Free Agents: Bewerbung, 7 Tage Frist, Entscheidung zwischen mehreren Vereinen
-- ---------------------------------------------------------------------
alter table public.free_agents add column if not exists first_interest_on date;
alter table public.free_agents add column if not exists decision_on date;

create table if not exists public.fa_applications (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  contract_years smallint not null check (contract_years between 1 and 5),
  status text not null default 'pending' check (status in ('pending', 'signed', 'lost', 'declined', 'expired', 'withdrawn')),
  created_on date not null,
  decided_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists fa_applications_one_pending on public.fa_applications(player_id, club_id) where status = 'pending';
create index if not exists fa_applications_world on public.fa_applications(world_id, status);
alter table public.fa_applications enable row level security;

create table if not exists public.world_week_log (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  week_no smallint not null,
  job text not null,
  created_at timestamptz not null default now(),
  primary key (world_id, season_id, week_no, job)
);
alter table public.world_week_log enable row level security;

-- Free-Agent-Verpflichtungen eines Vereins in der Saison (max. 2)
create or replace function public.fd_fa_signings(p_club uuid, p_season uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.transfers where to_club_id = p_club and season_id = p_season and kind = 'free_agent';
$$;

-- Sportliche Mindestanforderung des Spielers: Spielklasse passend zur Stärke (ältere sind genügsamer)
create or replace function public.fd_fa_min_tier(p_overall integer, p_age integer)
returns integer language sql immutable set search_path = '' as $$
  select least(4, case when p_overall >= 74 then 1 when p_overall >= 68 then 2 else 3 end + case when p_age >= 32 then 1 else 0 end);
$$;

create or replace function public.fd_fa_apply(p_player uuid, p_club uuid, p_years integer)
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
begin
  select * into v_fa from public.free_agents where player_id = p_player for update;
  if not found then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  select * into v_p from public.players where id = p_player;
  if v_p.club_id is not null then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  if p_years not between 1 and 5 then raise exception 'Ungültige Laufzeit.' using errcode = '22023', hint = 'invalid'; end if;
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
  v_date := coalesce(v_w.current_date_in_world, current_date);
  insert into public.fa_applications(world_id, season_id, player_id, club_id, contract_years, created_on)
  values (v_p.world_id, v_w.current_season_id, p_player, p_club, p_years, v_date);
  -- Die Frist beginnt mit der ersten Interessensbekundung: exakt 7 Kalendertage im Spielkalender
  if v_fa.decision_on is null then
    update public.free_agents set first_interest_on = v_date, decision_on = v_date + 7 where player_id = p_player;
    v_fa.decision_on := v_date + 7;
  end if;
  return jsonb_build_object('status', 'applied', 'decision_on', v_fa.decision_on,
    'message', 'Bewerbung abgegeben. ' || v_p.first_name || ' ' || v_p.last_name || ' entscheidet sich am ' || to_char(v_fa.decision_on, 'DD.MM.YYYY') || '.');
end;
$$;

-- Ehemals Sofort-Verpflichtung, jetzt Bewerbung (gleiche Signatur für bestehende Clients)
create or replace function public.sign_free_agent(p_player uuid, p_years integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_world uuid;
begin
  select world_id into v_world from public.players where id = p_player;
  if v_world is null then raise exception 'Dieser Spieler ist nicht mehr verfügbar.' using errcode = 'P0001', hint = 'gone'; end if;
  return public.fd_fa_apply(p_player, public.fd_require_team(v_world), p_years);
end;
$$;

create or replace function public.withdraw_fa_application(p_application uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.fa_applications;
begin
  select * into v_a from public.fa_applications where id = p_application for update;
  if not found or not public.is_club_manager(v_a.club_id) then raise exception 'Bewerbung nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_a.status <> 'pending' then raise exception 'Die Bewerbung ist bereits entschieden.' using errcode = 'P0001', hint = 'decided'; end if;
  update public.fa_applications set status = 'withdrawn', decided_at = now() where id = p_application;
  -- Ohne verbleibende Interessenten beginnt die Frist bei der nächsten Bewerbung neu
  if not exists (select 1 from public.fa_applications where player_id = v_a.player_id and status = 'pending') then
    update public.free_agents set decision_on = null, first_interest_on = null where player_id = v_a.player_id;
  end if;
end;
$$;

-- Attraktivität eines Vereins aus Sicht des Spielers (null = Mindestanforderungen nicht erfüllt)
create or replace function public.fd_fa_score(p_player uuid, p_club uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_c public.clubs;
  v_w public.career_worlds;
  v_fa public.free_agents;
  v_tier integer;
  v_better integer;
  v_rank integer;
  v_prev numeric := 0;
  v_euro boolean;
  v_score numeric;
  v_play numeric;
  v_success numeric;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_c from public.clubs where id = p_club;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  select * into v_fa from public.free_agents where player_id = p_player;
  if v_c.reputation < coalesce(v_fa.min_club_reputation, 0) then return null; end if;
  v_tier := coalesce(public.fd_tier_of(p_club, v_w.current_season_id), 4);
  if v_tier > public.fd_fa_min_tier(v_p.overall, v_p.age) then return null; end if;
  -- Erwartete Einsatzzeit: Konkurrenz auf der Position
  select count(*) filter (where p.overall >= v_p.overall + 4), count(*) filter (where p.overall > v_p.overall)
  into v_better, v_rank
  from public.players p where p.club_id = p_club and not p.retired and public.fd_pos_group(p.main_position::text) = public.fd_pos_group(v_p.main_position::text);
  if v_better >= 3 and v_p.age < 33 then return null; end if;
  v_play := case when v_rank = 0 then 25 when v_rank = 1 then 15 when v_rank = 2 then 6 else -8 end;
  -- Sportlicher Erfolg der Vorsaison (Tabellenplatz der letzten abgeschlossenen Liga)
  select coalesce(max(1 - (t.pos - 1)::numeric / greatest(1, n.cnt - 1)), 0.4) * 20 into v_prev
  from public.seasons s
  join public.competitions co on co.season_id = s.id and co.kind = 'league'
  join lateral public.fd_table(co.id) t on t.club_id = p_club
  cross join lateral (select count(*) cnt from public.competition_entries e where e.competition_id = co.id) n
  where s.world_id = v_p.world_id and s.status::text = 'closed' and s.id = (select id from public.seasons where world_id = v_p.world_id and status::text = 'closed' order by year desc limit 1);
  v_euro := exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                    where e.club_id = p_club and co.season_id = v_w.current_season_id and co.kind::text in ('champions_league', 'europa_league', 'continental'));
  v_success := (5 - v_tier) * 12 + coalesce(v_prev, 8) + case when v_euro then 15 else 0 end + v_c.reputation * 0.3;
  -- Karriereziele: Junge wollen spielen, Ältere Erfolg
  v_score := v_success * case when v_p.age >= 30 then 1.3 else 1 end + v_play * case when v_p.age <= 23 then 1.5 else 1 end
           + public.fd_hash01(p_player::text || p_club::text || ':fa') * 6;
  return round(v_score, 2);
end;
$$;

-- Fällige Entscheidungen verarbeiten (automatisch, für alle identisch, ein Vertrag je Spieler)
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
            order by f.decision_on, f.player_id for update skip locked loop
    select * into v_p from public.players where id = fa.player_id;
    if v_win.id is null or v_p.club_id is not null then
      -- Fenster zu: Bewerbungen verfallen (verbrauchen keinen Platz), neue Frist beim nächsten Interesse
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
      update public.free_agents set decision_on = null, first_interest_on = null where player_id = fa.player_id;
    else
      perform public.fd_complete_transfer(fa.player_id, null, v_best, 0, fa.annual_salary, v_best_years, null, 'free_agent', v_win.id);
      update public.fa_applications set status = case when club_id = v_best then 'signed' else 'lost' end, decided_at = now(),
        note = case when club_id = v_best then null else 'Entscheidung für ' || (select name from public.clubs where id = v_best) end
      where player_id = fa.player_id and status = 'pending';
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- KI-Vereine bewerben sich einmal je Woche um interessante Free Agents (gleiche Regeln)
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
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_win := public.fd_open_window(p_world);
  if v_win.id is null then return 0; end if;
  insert into public.world_week_log(world_id, season_id, week_no, job) values (p_world, v_w.current_season_id, v_w.current_week, 'ai_fa')
  on conflict do nothing;
  if not found then return 0; end if;
  -- Kandidaten einmal je Lauf bestimmen (große Welten: hunderte Vereine)
  create temporary table if not exists fd_tmp_fa_clubs (club_id uuid primary key, tier integer, rep numeric) on commit drop;
  create temporary table if not exists fd_tmp_fa_second (club_id uuid, grp text, second integer, primary key (club_id, grp)) on commit drop;
  truncate fd_tmp_fa_clubs; truncate fd_tmp_fa_second;
  insert into fd_tmp_fa_clubs
  select cl.id, coalesce(public.fd_tier_of(cl.id, v_w.current_season_id), 4), cl.reputation
  from public.clubs cl
  where cl.world_id = p_world and cl.control = 'ai' and not cl.amateur
    and public.fd_fa_signings(cl.id, v_w.current_season_id) < 2
    and (select count(*) from public.players where club_id = cl.id) < 27
    and not exists (select 1 from public.fa_applications a where a.club_id = cl.id and a.status = 'pending');
  insert into fd_tmp_fa_second
  select club_id, grp, overall from (
    select p.club_id, public.fd_pos_group(p.main_position::text) grp, p.overall,
           row_number() over (partition by p.club_id, public.fd_pos_group(p.main_position::text) order by p.overall desc) rn
    from public.players p join fd_tmp_fa_clubs fc on fc.club_id = p.club_id) x where rn = 2;
  for fa in select f.player_id, p.overall, p.age, p.main_position::text pos, f.min_club_reputation
            from public.free_agents f join public.players p on p.id = f.player_id
            where f.world_id = p_world and p.club_id is null order by p.overall desc limit 40 loop
    v_k := 0;
    for c in
      select k.club_id as id from fd_tmp_fa_clubs k
      left join fd_tmp_fa_second sc on sc.club_id = k.club_id and sc.grp = public.fd_pos_group(fa.pos)
      where k.rep >= fa.min_club_reputation and k.tier <= public.fd_fa_min_tier(fa.overall, fa.age)
        -- echte Verstärkung: besser als der zweitbeste Spieler dieser Positionsgruppe
        and fa.overall >= coalesce(sc.second, 0)
        and not exists (select 1 from public.fa_applications a where a.club_id = k.club_id and a.status = 'pending')
      order by md5(k.club_id::text || fa.player_id::text || v_w.current_week::text) limit 2
    loop
      begin
        perform public.fd_fa_apply(fa.player_id, c.id, case when fa.age < 26 then 3 when fa.age < 30 then 2 else 1 end);
        v_n := v_n + 1; v_k := v_k + 1;
      exception when others then null;
      end;
    end loop;
  end loop;
  return v_n;
end;
$$;

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
        'application_id', (select a.id from public.fa_applications a where a.player_id = f.player_id and a.status = 'pending' and a.club_id = v_club))
        order by f.decision_on, p.overall desc)
      from public.free_agents f join public.players p on p.id = f.player_id where f.world_id = p_world and f.decision_on is not null), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'player_id', a.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
        'status', a.status, 'note', a.note, 'created_on', a.created_on) order by a.created_at desc)
      from public.fa_applications a join public.players p on p.id = a.player_id where a.club_id = v_club and a.season_id = v_w.current_season_id), '[]'::jsonb),
    'decisions', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('player_id', a.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name), 'club', public.fd_club_ref(a.club_id),
          'applicants', (select count(*) from public.fa_applications b where b.player_id = a.player_id and b.decided_at = a.decided_at), 'at', a.decided_at) x
        from public.fa_applications a join public.players p on p.id = a.player_id
        where a.world_id = p_world and a.status = 'signed' order by a.decided_at desc limit 10) q), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------
-- 3) Transferverhandlungen mit KI-Vereinen (max. 3 Runden in 4 Wochen)
-- ---------------------------------------------------------------------
alter table public.transfer_offers add column if not exists round smallint not null default 1;
alter table public.transfer_offers add column if not exists history jsonb not null default '[]'::jsonb;
alter table public.transfer_offers add column if not exists next_response_on date;
alter table public.transfer_offers add column if not exists deadline_on date;
alter table public.transfer_offers add column if not exists ai_max bigint;
alter table public.transfer_offers add column if not exists note text;
create index if not exists transfer_offers_due on public.transfer_offers(world_id, status, next_response_on);
create index if not exists players_world_pos_ovr on public.players(world_id, main_position, overall);

-- Wert des Spielers für den abgebenden KI-Verein
create or replace function public.fd_ai_valuation(p_player uuid)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  v_p public.players;
  v_w public.career_worlds;
  v_rank integer;
  v_cnt integer;
  v_squad integer;
  v_years integer;
  v_bal bigint;
  v_strat text;
  v_need integer;
  v_v numeric;
begin
  select * into v_p from public.players where id = p_player;
  select * into v_w from public.career_worlds where id = v_p.world_id;
  select count(*) filter (where p.overall > v_p.overall), count(*) into v_rank, v_cnt
  from public.players p where p.club_id = v_p.club_id and public.fd_pos_group(p.main_position::text) = public.fd_pos_group(v_p.main_position::text);
  select count(*) into v_squad from public.players where club_id = v_p.club_id;
  select greatest(0, c.end_season_year - public.fd_season_year(v_w.current_season_id)) + 1 into v_years
  from public.player_contracts c where c.player_id = p_player and c.active;
  select balance into v_bal from public.finances where club_id = v_p.club_id;
  v_strat := public.fd_ai_strategy(v_p.club_id);
  v_need := case public.fd_pos_group(v_p.main_position::text) when 'GK' then 2 when 'ATT' then 4 else 6 end;
  v_v := greatest(v_p.market_value, 100000)
    * case when v_rank < case public.fd_pos_group(v_p.main_position::text) when 'GK' then 1 when 'ATT' then 2 else 4 end then 1.25 else 1 end  -- Stammspieler
    * case when v_p.age <= 23 then 1.12 when v_p.age >= 31 then 0.85 else 1 end
    * case coalesce(v_years, 3) when 1 then 0.75 when 2 then 0.9 else 1 end                -- auslaufender Vertrag
    * case when coalesce(v_bal, 0) < 0 then 0.85 when coalesce(v_bal, 0) < 2000000 then 0.93 else 1 end  -- Finanzlage
    * case when v_cnt <= v_need then 1.25 else 1 end                                         -- Kaderbedarf
    * case when v_strat = 'profit' then 0.9 when v_strat = 'talents' and v_p.age <= 22 then 1.2 else 1 end
    * case when v_squad <= 19 then 3 else 1 end;                                              -- zu kleiner Kader: praktisch unverkäuflich
  return (round(v_v / 50000) * 50000)::bigint;
end;
$$;

create or replace function public.fd_offer_log(p_offer uuid, p_by text, p_action text, p_fee bigint)
returns void language sql set search_path = '' as $$
  update public.transfer_offers set history = history || jsonb_build_array(jsonb_build_object('by', p_by, 'action', p_action, 'fee', p_fee,
    'on', (select public.fd_world_date(o.world_id) from public.transfer_offers o where o.id = p_offer)))
  where id = p_offer;
$$;

-- Abschluss: Fenster, Limits, Gehaltsforderung des Spielers; sonst Gegenangebot zum Gehalt bzw. Scheitern
create or replace function public.fd_offer_close(p_offer uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o public.transfer_offers;
  v_p public.players;
  v_win public.transfer_windows;
  v_demand bigint;
begin
  select * into v_o from public.transfer_offers where id = p_offer for update;
  if v_o.status in ('completed', 'rejected', 'withdrawn', 'expired') then return jsonb_build_object('status', v_o.status::text); end if;
  select * into v_p from public.players where id = v_o.player_id for update;
  if v_p.club_id is distinct from v_o.from_club_id then
    update public.transfer_offers set status = 'expired', responded_at = now(), note = 'Spieler nicht mehr verfügbar' where id = p_offer;
    return jsonb_build_object('status', 'expired', 'message', 'Der Spieler ist nicht mehr verfügbar.');
  end if;
  v_win := public.fd_open_window(v_o.world_id);
  begin
    perform public.fd_check_buy(v_o.world_id, v_o.to_club_id, v_o.fee, v_win);
    perform public.fd_check_sell(v_o.from_club_id, v_win);
  exception when others then
    update public.transfer_offers set status = 'rejected', responded_at = now(), note = sqlerrm where id = p_offer;
    perform public.fd_offer_log(p_offer, 'system', 'failed', v_o.fee);
    return jsonb_build_object('status', 'rejected', 'message', 'Transfer nicht möglich: ' || sqlerrm);
  end;
  v_demand := public.fd_player_demand(v_o.player_id, v_o.to_club_id);
  if v_o.annual_salary < v_demand then
    if (select control from public.clubs where id = v_o.to_club_id) = 'ai' then
      update public.transfer_offers set annual_salary = v_demand where id = p_offer;
    else
      update public.transfer_offers set status = 'countered', counter_fee = v_o.fee, counter_salary = v_demand, responded_at = now(),
        note = 'Ablöse akzeptiert – der Spieler verlangt mehr Gehalt' where id = p_offer;
      perform public.fd_offer_log(p_offer, 'player', 'salary', v_o.fee);
      return jsonb_build_object('status', 'countered', 'counter_salary', v_demand,
        'message', 'Der Verein ist einverstanden, aber ' || v_p.last_name || ' verlangt ' || to_char(v_demand / 1e6, 'FM999990D00') || ' Mio. € Jahresgehalt.');
    end if;
  end if;
  select * into v_o from public.transfer_offers where id = p_offer;
  update public.transfer_offers set status = 'completed', responded_at = now() where id = p_offer;
  perform public.fd_offer_log(p_offer, 'seller', 'accept', v_o.fee);
  perform public.fd_complete_transfer(v_o.player_id, v_o.from_club_id, v_o.to_club_id, v_o.fee, v_o.annual_salary, v_o.contract_years, p_offer, 'transfer', v_win.id);
  return jsonb_build_object('status', 'completed', 'message', v_p.first_name || ' ' || v_p.last_name || ' wechselt für ' || to_char(v_o.fee / 1e6, 'FM999990D0') || ' Mio. €.');
end;
$$;

-- Antwort des abgebenden KI-Vereins (sofort bei Eingang, sonst am Antworttermin)
create or replace function public.fd_seller_respond(p_offer uuid, p_initial boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o public.transfer_offers;
  v_val bigint;
  v_ratio numeric;
  v_demand bigint;
  v_date date;
  v_name text;
begin
  select * into v_o from public.transfer_offers where id = p_offer for update;
  v_date := public.fd_world_date(v_o.world_id);
  v_val := public.fd_ai_valuation(v_o.player_id);
  v_ratio := v_o.fee::numeric / greatest(v_val, 1);
  select name into v_name from public.clubs where id = v_o.from_club_id;
  -- Besonders attraktiv: sofort annehmen; Gegenforderung erreicht: annehmen
  if v_ratio >= 1.15 or (not p_initial and v_ratio >= 1.0) or (v_o.counter_fee is not null and v_o.fee >= v_o.counter_fee) then
    return public.fd_offer_close(p_offer);
  end if;
  if v_ratio < 0.6 or (v_o.round >= 3 and not p_initial) then
    update public.transfer_offers set status = 'rejected', responded_at = now(),
      note = case when v_o.round >= 3 then 'Keine Einigung nach drei Runden' else 'Angebot deutlich unter Wert' end where id = p_offer;
    perform public.fd_offer_log(p_offer, 'seller', 'reject', v_o.fee);
    return jsonb_build_object('status', 'rejected', 'message', v_name || ' lehnt das Angebot ab.');
  end if;
  if p_initial then
    -- Zögern: frühestens nach einer virtuellen Woche geht es weiter
    update public.transfer_offers set status = 'pending', next_response_on = v_date + 7, deadline_on = coalesce(deadline_on, v_date + 28),
      responded_at = now(), note = 'Der Verein überlegt' where id = p_offer;
    perform public.fd_offer_log(p_offer, 'seller', 'hesitate', v_o.fee);
    return jsonb_build_object('status', 'pending', 'next_response_on', v_date + 7, 'message', v_name || ' zögert und meldet sich bis zum ' || to_char(v_date + 7, 'DD.MM.') || '.');
  end if;
  -- Gegenangebot: Forderung sinkt je Runde und nähert sich dem Gebot
  v_demand := greatest(v_o.fee + 50000, round(v_val * (1.10 - 0.04 * (v_o.round - 1)) / 50000) * 50000)::bigint;
  if v_o.counter_fee is not null then v_demand := least(v_demand, greatest(v_o.fee + 50000, (v_o.counter_fee - (v_o.counter_fee - v_o.fee) * 0.3)::bigint)); end if;
  v_demand := (round(v_demand / 50000.0) * 50000)::bigint;
  update public.transfer_offers set status = 'countered', counter_fee = v_demand, next_response_on = null, responded_at = now(), note = 'Gegenangebot' where id = p_offer;
  perform public.fd_offer_log(p_offer, 'seller', 'counter', v_demand);
  return jsonb_build_object('status', 'countered', 'counter_fee', v_demand, 'message', v_name || ' fordert ' || to_char(v_demand / 1e6, 'FM999990D0') || ' Mio. €.');
end;
$$;

-- Neues Angebot (menschlich oder KI) an einen KI-Verein
create or replace function public.fd_offer_open(p_player uuid, p_buyer uuid, p_fee bigint, p_salary bigint, p_years integer, p_ai_max bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
  v_win public.transfer_windows;
  v_offer uuid;
  v_date date;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or v_p.club_id is null then raise exception 'Spieler nicht gefunden oder vereinslos.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_p.club_id = p_buyer then raise exception 'Der Spieler gehört bereits zu deinem Verein.' using errcode = 'P0001', hint = 'own_player'; end if;
  if exists (select 1 from public.transfer_offers o where o.player_id = p_player and o.to_club_id = p_buyer and o.status in ('pending', 'countered')) then
    raise exception 'Es läuft bereits eine Verhandlung um diesen Spieler.' using errcode = 'P0001', hint = 'already_negotiating';
  end if;
  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_buy(v_p.world_id, p_buyer, p_fee, v_win);
  v_date := public.fd_world_date(v_p.world_id);
  insert into public.transfer_offers(world_id, window_id, player_id, from_club_id, to_club_id, fee, annual_salary, contract_years, deadline_on, ai_max)
  values (v_p.world_id, v_win.id, p_player, v_p.club_id, p_buyer, p_fee, p_salary, p_years, v_date + 28, p_ai_max) returning id into v_offer;
  perform public.fd_offer_log(v_offer, 'buyer', 'offer', p_fee);
  return public.fd_seller_respond(v_offer, true) || jsonb_build_object('offer', v_offer);
end;
$$;

-- make_transfer_offer: KI-Verkäufer verhandeln jetzt; menschliche Verkäufer wie bisher
do $patch$
declare v_def text; v_old text;
begin
  select pg_get_functiondef('public.make_transfer_offer(uuid, bigint, bigint, integer)'::regprocedure) into v_def;
  if position('fd_offer_open' in v_def) = 0 then
    v_old := $a$  perform public.fd_ensure_windows(v_p.world_id);
  v_win := public.fd_open_window(v_p.world_id);
  perform public.fd_check_buy(v_p.world_id, v_club, p_fee, v_win);
  select * into v_from from public.clubs where id = v_p.club_id;$a$;
    if position(v_old in v_def) = 0 then raise exception 'Patch make_transfer_offer fehlgeschlagen'; end if;
    v_def := replace(v_def, v_old, v_old || $b$
  -- KI-Verein: Verhandlung (Annehmen, Ablehnen oder Zögern; max. 3 Runden in 4 Wochen)
  if v_from.control = 'ai' then
    return public.fd_offer_open(p_player, v_club, p_fee, p_salary, p_years, null);
  end if;$b$);
    execute v_def;
  end if;
end
$patch$;

-- Käufer bietet nach einem Gegenangebot neu (nächste Runde)
create or replace function public.fd_offer_rebid(p_offer uuid, p_fee bigint, p_by text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_o public.transfer_offers;
  v_date date;
begin
  select * into v_o from public.transfer_offers where id = p_offer for update;
  if v_o.status <> 'countered' then raise exception 'Kein offenes Gegenangebot.' using errcode = 'P0001', hint = 'not_countered'; end if;
  v_date := public.fd_world_date(v_o.world_id);
  if v_o.round >= 3 or v_date >= coalesce(v_o.deadline_on, v_date + 1) then
    raise exception 'Die Verhandlung ist ausgeschöpft (drei Runden bzw. vier Wochen).' using errcode = 'P0001', hint = 'negotiation_over';
  end if;
  if p_fee is null or p_fee <= 0 then raise exception 'Ungültiges Angebot.' using errcode = '22023', hint = 'invalid_offer'; end if;
  if (select balance from public.finances where club_id = v_o.to_club_id) < p_fee then
    raise exception 'Nicht genügend Geld auf dem Vereinskonto.' using errcode = 'P0001', hint = 'insufficient_funds';
  end if;
  update public.transfer_offers set fee = p_fee, round = round + 1, status = 'pending', next_response_on = least(v_date + 7, coalesce(deadline_on, v_date + 7)),
    responded_at = now(), note = 'Neues Angebot – der Verein prüft' where id = p_offer;
  perform public.fd_offer_log(p_offer, p_by, 'rebid', p_fee);
  -- Gegenforderung erfüllt: sofortige Annahme, sonst nächste Runde nach einer Woche
  if p_fee >= v_o.counter_fee then return public.fd_offer_close(p_offer); end if;
  return jsonb_build_object('status', 'pending', 'next_response_on', least(v_date + 7, coalesce(v_o.deadline_on, v_date + 7)),
    'message', 'Neues Angebot abgegeben. Antwort bis ' || to_char(least(v_date + 7, coalesce(v_o.deadline_on, v_date + 7)), 'DD.MM.') || '.');
end;
$$;

create or replace function public.renegotiate_offer(p_offer uuid, p_fee bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_club_manager((select to_club_id from public.transfer_offers where id = p_offer)) then
    raise exception 'Angebot nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  return public.fd_offer_rebid(p_offer, p_fee, 'buyer');
end;
$$;

-- Fällige Antworten, KI-Käufer-Reaktionen, Fristen und geschlossene Fenster verarbeiten
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
    -- Laufende Verhandlungen dürfen ein geschlossenes Fenster nicht umgehen
    update public.transfer_offers set status = 'expired', responded_at = now(), note = 'Transferfenster geschlossen'
    where world_id = p_world and status in ('pending', 'countered');
    return 0;
  end if;
  -- Verkäufer antwortet am Termin
  for o in select id from public.transfer_offers where world_id = p_world and status = 'pending' and next_response_on is not null and next_response_on <= v_date
           order by next_response_on, id for update skip locked loop
    perform public.fd_seller_respond(o.id, false); v_n := v_n + 1;
  end loop;
  -- KI-Käufer reagieren sofort auf Gegenangebote
  for o in select t.* from public.transfer_offers t join public.clubs c on c.id = t.to_club_id
           where t.world_id = p_world and t.status = 'countered' and c.control = 'ai' order by t.id for update of t skip locked loop
    if o.counter_salary is not null and o.counter_fee = o.fee then
      update public.transfer_offers set annual_salary = greatest(annual_salary, o.counter_salary), status = 'pending', counter_fee = null where id = o.id;
      perform public.fd_offer_close(o.id);
    elsif o.counter_fee <= coalesce(o.ai_max, o.fee) and (select balance from public.finances where club_id = o.to_club_id) >= o.counter_fee then
      update public.transfer_offers set fee = o.counter_fee where id = o.id;
      perform public.fd_offer_log(o.id, 'buyer', 'accept', o.counter_fee);
      perform public.fd_offer_close(o.id);
    elsif o.round < 3 and v_date < coalesce(o.deadline_on, v_date + 1) and coalesce(o.ai_max, 0) > o.fee then
      begin
        perform public.fd_offer_rebid(o.id, least(o.ai_max, ((o.fee + o.counter_fee) / 2 / 50000) * 50000), 'buyer');
      exception when others then
        update public.transfer_offers set status = 'withdrawn', responded_at = now(), note = 'Käufer steigt aus' where id = o.id;
      end;
    else
      update public.transfer_offers set status = 'withdrawn', responded_at = now(), note = 'Käufer steigt aus' where id = o.id;
      perform public.fd_offer_log(o.id, 'buyer', 'withdraw', o.fee);
    end if;
    v_n := v_n + 1;
  end loop;
  -- Fristende (4 Wochen): unbeantwortete Gegenangebote verfallen
  update public.transfer_offers set status = 'expired', responded_at = now(), note = 'Frist abgelaufen'
  where world_id = p_world and status = 'countered' and deadline_on is not null and deadline_on < v_date;
  return v_n;
end;
$$;

-- Aktiver KI-Transfermarkt: Kaderbedarf, Budget, Strategie; gleiche Verhandlungen, Fenster und Limits
create or replace function public.fd_ai_transfer_batch(p_world uuid, p_limit integer default 40)
returns integer
language plpgsql
set search_path = ''
as $$
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
    where p.world_id = p_world and s.control = 'ai' and s.id <> c.id and not p.retired
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
    and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week);
  return v_left;
end;
$$;

create table if not exists public.ai_transfer_log (
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  week_no smallint not null,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (club_id, season_id, week_no)
);
alter table public.ai_transfer_log enable row level security;

-- Verhandlungen des eigenen Vereins (Status, Forderung, Verlauf, nächster Termin)
create or replace function public.my_negotiations(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid;
begin
  v_club := public.fd_require_team(p_world);
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'player_id', o.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name),
      'overall', p.overall, 'age', p.age, 'position', p.main_position, 'market_value', p.market_value,
      'seller', public.fd_club_ref(o.from_club_id), 'buyer', public.fd_club_ref(o.to_club_id), 'incoming', o.from_club_id = v_club,
      'status', o.status, 'fee', o.fee, 'counter_fee', o.counter_fee, 'salary', o.annual_salary, 'counter_salary', o.counter_salary,
      'round', o.round, 'next_response_on', o.next_response_on, 'deadline_on', o.deadline_on, 'history', o.history, 'note', o.note, 'created_at', o.created_at)
      order by (o.status in ('pending', 'countered')) desc, o.created_at desc)
    from public.transfer_offers o join public.players p on p.id = o.player_id
    where (o.to_club_id = v_club or o.from_club_id = v_club) and o.created_at > now() - interval '120 days'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- 4) Top-Transfers (Liga/Welt, Sommer/Winter)
-- ---------------------------------------------------------------------
create or replace function public.top_transfers(p_world uuid, p_scope text default 'league', p_window integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_club uuid;
  v_league uuid;
  v_win smallint;
begin
  perform public.fd_require_member(p_world);
  select * into v_w from public.career_worlds where id = p_world;
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = auth.uid();
  v_league := public.fd_league_of(v_club, v_w.current_season_id);
  v_win := coalesce(p_window, (select w.window_no from public.transfer_windows w where w.id = (public.fd_open_window(p_world)).id),
    (select max(w.window_no) from public.transfer_windows w join public.transfers t on t.window_id = w.id where w.season_id = v_w.current_season_id), 1);
  return jsonb_build_object('scope', p_scope, 'window', v_win, 'league', (select name from public.competitions where id = v_league),
    'rows', coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('player_id', t.player_id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name), 'overall', p.overall, 'age', p.age,
        'position', p.main_position, 'from', public.fd_club_ref(t.from_club_id), 'to', public.fd_club_ref(t.to_club_id), 'fee', t.fee) x
      from public.transfers t join public.transfer_windows w on w.id = t.window_id join public.players p on p.id = t.player_id
      where t.world_id = p_world and w.season_id = v_w.current_season_id and w.window_no = v_win and t.kind = 'transfer' and t.fee > 0
        and (p_scope <> 'league' or exists (select 1 from public.competition_entries e where e.competition_id = v_league and e.club_id in (t.from_club_id, t.to_club_id)))
      order by t.fee desc, t.created_at limit 5) q), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------
-- 5) Saisonkalender für das Dashboard (vorhandene Spielplandaten)
-- ---------------------------------------------------------------------
create or replace function public.season_calendar(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  v_w public.career_worlds;
begin
  v_club := public.fd_require_team(p_world);
  select * into v_w from public.career_worlds where id = p_world;
  return jsonb_build_object('today', coalesce(v_w.current_date_in_world, current_date),
    'fixtures', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'date', f.scheduled_date, 'home', f.home_club_id = v_club, 'status', f.status,
        'kind', c.kind, 'competition', c.name, 'opponent', public.fd_club_ref(case when f.home_club_id = v_club then f.away_club_id else f.home_club_id end),
        'gf', case when f.status = 'released' then case when f.home_club_id = v_club then r.home_goals else r.away_goals end end,
        'ga', case when f.status = 'released' then case when f.home_club_id = v_club then r.away_goals else r.home_goals end end) order by f.scheduled_date)
      from public.fixtures f join public.competitions c on c.id = f.competition_id left join public.fixture_results r on r.fixture_id = f.id
      where f.season_id = v_w.current_season_id and (f.home_club_id = v_club or f.away_club_id = v_club)), '[]'::jsonb));
end;
$$;

-- Farbwelt der App: eigener Wettbewerb (Liga, Stufe, Verband)
create or replace function public.world_theme(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid;
  v_comp uuid;
begin
  perform public.fd_require_member(p_world);
  select id into v_club from public.clubs where world_id = p_world and manager_user_id = auth.uid();
  v_comp := public.fd_league_of(v_club, (select current_season_id from public.career_worlds where id = p_world));
  return (select jsonb_build_object('kind', c.kind, 'tier', c.tier, 'association', c.association_code, 'name', c.name) from public.competitions c where c.id = v_comp);
end;
$$;

-- ---------------------------------------------------------------------
-- 6) Wetter und Atmosphäre (rein optisch, im Match-Setup für alle identisch)
-- ---------------------------------------------------------------------
create or replace function public.fd_weather(p_fixture uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_assoc text;
  v_m integer;
  u numeric;
  v_south boolean;
  v_north boolean;
  w record;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  select association_code into v_assoc from public.clubs where id = v_f.home_club_id;
  v_m := extract(month from v_f.scheduled_date)::int;
  u := public.fd_hash01(coalesce(v_f.rng_seed, p_fixture::text) || ':weather')::numeric;
  v_south := v_assoc in ('ESP', 'ITA', 'POR', 'GRE', 'TUR', 'CYP', 'MLT', 'ISR', 'GIB', 'AND', 'SMR');
  v_north := v_assoc in ('NOR', 'SWE', 'FIN', 'ISL', 'FRO', 'RUS', 'UKR', 'BLR', 'POL', 'EST', 'LVA', 'LTU', 'KAZ', 'SCO');
  -- Anteile: sonnig, bewölkt, Regen, Starkregen, Schnee, Nebel (je Jahreszeit)
  select * into w from (values
    (case when v_m in (6, 7, 8) then 0.55 when v_m in (9, 4, 5) then 0.35 when v_m in (10, 3) then 0.25 else 0.15 end,
     0.30, case when v_m in (6, 7, 8) then 0.12 else 0.2 end, case when v_m in (6, 7, 8) then 0.03 else 0.06 end,
     case when v_m in (12, 1, 2) then 0.14 when v_m in (11, 3) then 0.04 else 0 end,
     case when v_m in (10, 11, 12, 1, 2) then 0.07 else 0.01 end)) t(sun, cloud, rain, heavy, snow, fog);
  if v_south then w.sun := w.sun + 0.2; w.snow := 0; w.fog := w.fog * 0.5; end if;
  if v_north then w.snow := w.snow * 2; w.sun := greatest(0.08, w.sun - 0.05); end if;
  u := u * (w.sun + w.cloud + w.rain + w.heavy + w.snow + w.fog);
  if u < w.sun then return 'sunny'; end if; u := u - w.sun;
  if u < w.cloud then return 'cloudy'; end if; u := u - w.cloud;
  if u < w.rain then return 'rain'; end if; u := u - w.rain;
  if u < w.heavy then return 'heavy_rain'; end if; u := u - w.heavy;
  if u < w.snow then return 'snow'; end if;
  return 'fog';
end;
$$;

-- Wichtige Spiele: Choreografie gegen Top-5-Teams der eigenen Liga, im Pokal ab dem Viertelfinale/Finale
create or replace function public.fd_atmosphere(p_fixture uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_f public.fixtures;
  v_kind text;
  v_pos integer;
  v_cnt integer;
  v_choreo boolean := false;
begin
  select * into v_f from public.fixtures where id = p_fixture;
  select c.kind::text into v_kind from public.competitions c where c.id = v_f.competition_id;
  if v_kind = 'league' then
    select t.pos into v_pos from public.fd_table(v_f.competition_id) t where t.club_id = v_f.away_club_id;
    select count(*) into v_cnt from public.fixtures x where x.competition_id = v_f.competition_id and x.status = 'released';
    -- vor dem ersten Spieltag: Reputation als Maßstab
    if v_cnt = 0 then
      select r into v_pos from (select e.club_id, rank() over (order by cl.reputation desc) r from public.competition_entries e join public.clubs cl on cl.id = e.club_id
                                where e.competition_id = v_f.competition_id) x where x.club_id = v_f.away_club_id;
    end if;
    v_choreo := coalesce(v_pos, 99) <= 5;
  elsif v_kind <> 'friendly' then
    v_choreo := v_f.neutral_venue or (select count(*) from public.fixtures x where x.competition_id = v_f.competition_id and x.slot_key = v_f.slot_key) <= 4;
  end if;
  return jsonb_build_object('choreo', v_choreo, 'banners', v_choreo or v_kind <> 'friendly',
    'pyro_seed', public.fd_hash01(coalesce(v_f.rng_seed, p_fixture::text) || ':pyro'));
end;
$$;

do $patch$
declare v_def text;
begin
  select pg_get_functiondef('public.admin_match_setup(uuid)'::regprocedure) into v_def;
  if position('fd_weather' in v_def) = 0 then
    v_def := replace(v_def, $a$'stadium', (select jsonb_build_object('name', st.name, 'capacity', st.capacity, 'design', st.design,$a$,
      $b$'stadium', (select jsonb_build_object('name', st.name, 'capacity', st.capacity, 'design', st.design,
                  'weather', public.fd_weather(v_f.id), 'atmosphere', public.fd_atmosphere(v_f.id),
                  'competition', (select jsonb_build_object('kind', c.kind, 'tier', c.tier, 'association', c.association_code, 'name', c.name)
                                  from public.competitions c where c.id = v_f.competition_id),$b$);
    if position('fd_weather' in v_def) = 0 then raise exception 'Patch admin_match_setup fehlgeschlagen'; end if;
    execute v_def;
  end if;
end
$patch$;

-- ---------------------------------------------------------------------
-- 7) Tagesverarbeitung bei Kalenderfortschritt und im Server-Sweep
-- ---------------------------------------------------------------------
create or replace function public.fd_world_daily(p_world uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c record;
  v_plans integer := 0;
  v_fa integer;
  v_offers integer;
begin
  -- Trainingspläne der menschlichen Vereine für die laufende Woche (genau einmal je Woche)
  for c in select p.club_id from public.training_plans p join public.clubs cl on cl.id = p.club_id
           where p.world_id = p_world and p.active and cl.control = 'human' loop
    if public.fd_run_training_plan(c.club_id) is not null then v_plans := v_plans + 1; end if;
  end loop;
  v_offers := public.fd_offers_process(p_world);
  v_fa := public.fd_fa_process(p_world);
  return jsonb_build_object('plans', v_plans, 'offers', v_offers, 'free_agents', v_fa);
end;
$$;

do $patch$
declare v_def text; v_old text;
begin
  select pg_get_functiondef('public.fd_release_slot(uuid)'::regprocedure) into v_def;
  if position('fd_world_daily' in v_def) = 0 then
    v_old := $a$    current_date_in_world = coalesce(v_next.slot_date, v_slot.slot_date) - 1
  where id = p_world;
end;$a$;
    if position(v_old in v_def) = 0 then raise exception 'Patch fd_release_slot fehlgeschlagen'; end if;
    v_def := replace(v_def, v_old, $b$    current_date_in_world = coalesce(v_next.slot_date, v_slot.slot_date) - 1
  where id = p_world;
  -- Neuer Kalendertag/neue Woche: Trainingspläne, Verhandlungen, Free-Agent-Entscheidungen
  perform public.fd_world_daily(p_world);
end;$b$);
    execute v_def;
  end if;
end
$patch$;

create or replace function public.admin_due_worlds()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  select w.id from public.career_worlds w
  where w.status::text in ('preseason', 'season') and w.current_season_id is not null
    and exists (select 1 from public.clubs cl where cl.world_id = w.id and cl.control = 'ai'
                and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = w.current_season_id and l.week_no = w.current_week))
  union
  select j.world_id from public.dev_aging_jobs j where j.done_at is null
  union
  -- offene KI-Transferwoche im geöffneten Fenster
  select w.id from public.career_worlds w
  where w.status::text in ('preseason', 'season') and (public.fd_open_window(w.id)).id is not null
    and exists (select 1 from public.clubs cl where cl.world_id = w.id and cl.control = 'ai' and not cl.amateur
                and not exists (select 1 from public.ai_transfer_log l where l.club_id = cl.id and l.season_id = w.current_season_id and l.week_no = w.current_week));
$$;

create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending uuid[];
  v_left integer;
  v_aging integer;
  v_market integer;
begin
  if (public.fd_current_slot(p_world)).state = 'live' then
    perform public.fd_try_release(p_world);
  end if;
  -- Hintergrundarbeit in Häppchen: Alterung, KI-Training, KI-Transfers, Tagesverarbeitung
  v_aging := public.fd_dev_aging_batch(p_world, 4000);
  v_left := public.fd_ai_training_batch(p_world, 40);
  v_market := public.fd_ai_transfer_batch(p_world, 40);
  perform public.fd_ai_fa_interest(p_world);
  perform public.fd_world_daily(p_world);
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state,
    'training_left', v_left + v_market, 'aging_left', v_aging);
end;
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $grants$
declare f text;
begin
  foreach f in array array[
    'public.fd_pos_group(text)', 'public.fd_ai_strategy(uuid)', 'public.fd_world_date(uuid)',
    'public.fd_train_player(uuid, uuid, uuid, text, boolean)', 'public.fd_run_training_plan(uuid)',
    'public.fd_fa_signings(uuid, uuid)', 'public.fd_fa_min_tier(integer, integer)', 'public.fd_fa_apply(uuid, uuid, integer)',
    'public.fd_fa_score(uuid, uuid)', 'public.fd_fa_process(uuid)', 'public.fd_ai_fa_interest(uuid)',
    'public.fd_ai_valuation(uuid)', 'public.fd_offer_log(uuid, text, text, bigint)', 'public.fd_offer_close(uuid)',
    'public.fd_seller_respond(uuid, boolean)', 'public.fd_offer_open(uuid, uuid, bigint, bigint, integer, bigint)',
    'public.fd_offer_rebid(uuid, bigint, text)', 'public.fd_offers_process(uuid)', 'public.fd_ai_transfer_batch(uuid, integer)',
    'public.fd_weather(uuid)', 'public.fd_atmosphere(uuid)', 'public.fd_world_daily(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array[
    'public.save_training_plan(uuid, boolean, jsonb)', 'public.training_plan(uuid)', 'public.withdraw_fa_application(uuid)',
    'public.fa_overview(uuid)', 'public.renegotiate_offer(uuid, bigint)', 'public.my_negotiations(uuid)',
    'public.top_transfers(uuid, text, integer)', 'public.season_calendar(uuid)', 'public.world_theme(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$grants$;
revoke execute on function public.admin_due_worlds() from public, anon, authenticated;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_due_worlds() to service_role;
grant execute on function public.admin_sweep_world(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 8) Spieltagsübersicht: nur die eigene Liga (Pokal/Europapokal weiter mit eigener Übersicht);
--    alle anderen Ligen werden unverändert im Hintergrund simuliert.
-- ---------------------------------------------------------------------
do $patch$
declare v_def text; v_old text;
begin
  select pg_get_functiondef('public.matchday_report(uuid, uuid)'::regprocedure) into v_def;
  if position('nur eigene Liga' in v_def) = 0 then
    v_old := $a$and f.status = 'released' and c.kind::text <> 'friendly'$a$;
    if position(v_old in v_def) = 0 then raise exception 'Patch matchday_report fehlgeschlagen'; end if;
    v_def := replace(v_def, v_old, $b$and f.status = 'released' and c.kind::text <> 'friendly'
      and (c.kind::text <> 'league' or c.id = v_comp or v_comp is null) -- nur eigene Liga$b$);
    execute v_def;
  end if;
end
$patch$;
