-- =====================================================================
-- 0039: Erste Liga massiv stärker (KI-Vereine)
--
-- Ziel (Ø der besten Startelf 1-4-3-3 bei voller Fitness, starke Fußballnation / Deutschland):
--   Platz 1–4: 87–88 · 5–7: 85–87 · 8–10: 83–85 · 11–14: 81–83 · 15–18: 79–81
-- Andere Länder werden mit derselben Abbildung wie die Weltgenerierung skaliert
-- (fd_country_transform mit associations.start_strength; oberhalb von 88 gedämpft, max. 90).
--
-- Grundsätze:
-- * Es werden die ECHTEN Attribute (player_attributes) positionsgerecht angehoben: gewichtete Attribute der
--   Position +Δ, übrige +Δ/2; Gesamtstärke (fd_overall), Marktwert (fd_market_value) und verborgenes
--   Potenzial (+Δ, Luft nach oben bleibt) folgen. Verträge, Gehälter, Transfers, Ergebnisse bleiben unverändert.
-- * Δ je Verein = max(0, Zielwert des Rangs − aktuelle Startelf); Rang = bisherige Stärke in der eigenen Liga
--   (stärkste bleiben oben). Δ wird je Spieler deterministisch gestreut (ganzzahlig, Mittelwert = Δ).
-- * Nur KI-Vereine (control = 'ai', keine Amateure). Menschliche Vereine, 2./3. Liga, Draft-Pool,
--   vereinslose Spieler und Spieler mit Bezug zu einem Menschenverein (Draft, Transfer, offenes Angebot) bleiben unverändert.
-- * Bestehende Welten: einmalig je Welt (Marker public.fd_league1_strength), Originalwerte in
--   fd_backup.league1_0039 (nur betroffene Spieler), Rückgängig: public.fd_league1_strength_rollback()
--   bzw. scripts/rollback_0039_league1_strength.sql.
-- * Neue Welten: admin_start_draft verstärkt die KI-Vereine der 1. Liga direkt nach dem Anlegen,
--   admin_add_europe die neu angelegten ausländischen Erstligen. Aufsteiger werden NICHT verstärkt
--   (nur Generierung bzw. diese einmalige Migration).
-- * Schalter: fd_settings 'league1_strength' = 'on' | 'off'.
-- Idempotent: mehrfaches Ausführen erhöht nichts doppelt.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Marker, Sicherung, Schalter
-- ---------------------------------------------------------------------
create table if not exists public.fd_league1_strength (
  world_id uuid primary key references public.career_worlds(id) on delete cascade,
  version smallint not null default 1,
  source text not null check (source in ('migration', 'generation')),
  applied_at timestamptz not null default now(),
  info jsonb
);
alter table public.fd_league1_strength enable row level security;
do $$ begin
  revoke all on public.fd_league1_strength from anon, authenticated;
exception when undefined_object then null; end $$;

create schema if not exists fd_backup;
revoke all on schema fd_backup from public;
do $$ begin
  revoke all on schema fd_backup from anon, authenticated;
exception when undefined_object then null; end $$;

create table if not exists fd_backup.league1_0039 (
  player_id uuid primary key,
  world_id uuid not null,
  club_id uuid,
  overall smallint not null,
  market_value bigint not null,
  potential smallint,
  attributes jsonb not null,
  delta smallint not null,
  di smallint,
  backed_up_at timestamptz not null default now(),
  restored_at timestamptz
);
alter table fd_backup.league1_0039 add column if not exists di smallint;
create index if not exists league1_0039_world_idx on fd_backup.league1_0039(world_id);
alter table fd_backup.league1_0039 enable row level security;
do $$ begin
  revoke all on fd_backup.league1_0039 from anon, authenticated;
exception when undefined_object then null; end $$;

-- Virtuelle Spielklasse ausländischer Vereine (clubs.level: Gehaltsforderungen, KI-Käufe) folgt der neuen Stärke
create table if not exists fd_backup.league1_0039_clubs (
  club_id uuid primary key,
  world_id uuid not null,
  level smallint,
  backed_up_at timestamptz not null default now(),
  restored_at timestamptz
);
alter table fd_backup.league1_0039_clubs enable row level security;
do $$ begin
  revoke all on fd_backup.league1_0039_clubs from anon, authenticated;
exception when undefined_object then null; end $$;

insert into public.fd_settings(key, value) values ('league1_strength', 'on') on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. Zielverteilung (Spiegel von packages/shared/src/rules/league1.ts)
-- ---------------------------------------------------------------------
create or replace function public.fd_league1_ref(p_rel numeric)
returns numeric language plpgsql immutable set search_path = '' as $$
declare
  t numeric[] := array[87.9, 87.7, 87.5, 87.3, 86.6, 86.0, 85.5, 84.7, 84.0, 83.4, 82.7, 82.2, 81.8, 81.3, 80.7, 80.2, 79.8, 79.4];
  x numeric := greatest(0, least(1, p_rel)) * 17;
  i integer := least(16, floor(x)::integer);
begin
  return t[i + 1] + (t[i + 2] - t[i + 1]) * (x - i);
end;
$$;

create or replace function public.fd_league1_target(p_strength numeric, p_rank integer, p_count integer)
returns numeric language sql immutable set search_path = '' as $$
  select least(90, case when t > 88 then 88 + (t - 88) / 2 else t end)
  from (select public.fd_country_transform(p_strength,
          public.fd_league1_ref(case when p_count <= 1 then 0 else (p_rank - 1)::numeric / (p_count - 1) end)) as t) x;
$$;

-- Attribute positionsgerecht um p_di Gesamtstärkepunkte anheben (siehe league1RaiseAttributes)
create or replace function public.fd_league1_raise(p_kind text, p_pos text, p_attrs jsonb, p_di integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_keys text[];
  v jsonb;
  v_prev jsonb;
  v_target integer;
  i integer;
begin
  if p_di is null or p_di <= 0 then return p_attrs; end if;
  select d.keys into v_keys from public.fd_dev_weights(p_kind, p_pos) d;
  v_target := public.fd_overall(p_kind, p_pos, p_attrs) + p_di;
  select p_attrs || jsonb_object_agg(k, least(99, (p_attrs ->> k)::numeric + p_di)) into v from unnest(v_keys) k;
  for i in 1 .. 20 loop
    exit when public.fd_overall(p_kind, p_pos, v) >= v_target;
    v_prev := v;
    select v || jsonb_object_agg(k, least(99, (v ->> k)::numeric + 1)) into v from unnest(v_keys) k;
    exit when v = v_prev;
  end loop;
  if p_di / 2 > 0 then
    select v || coalesce(jsonb_object_agg(e.key, least(99, e.value::numeric + p_di / 2)), '{}'::jsonb) into v
    from jsonb_each_text(p_attrs) e where e.key <> all (v_keys);
  end if;
  return v;
end;
$$;

-- Ø der besten Startelf (1 TW, 4 Abwehr, 3 Mittelfeld, 3 Angriff; wie bestElevenAverage), volle Fitness
create or replace function public.fd_league1_xi(p_club uuid)
returns numeric language sql stable set search_path = '' as $$
  select avg(overall)::numeric from (
    select p.overall, public.fd_pos_group(p.main_position::text) grp,
           row_number() over (partition by public.fd_pos_group(p.main_position::text) order by p.overall desc, p.id) rn
    from public.players p where p.club_id = p_club and not p.retired and not p.temporary) x
  where rn <= case grp when 'GK' then 1 when 'DEF' then 4 else 3 end;
$$;

-- ---------------------------------------------------------------------
-- 3. Mengenbasierte Anhebung für die Vereine in fd_tmp_l1 (club_id, world_id, league_key, strength)
--    Ligen werden je league_key nach aktueller Startelf gerankt (Vereine ohne Spieler zählen nicht).
-- ---------------------------------------------------------------------
create or replace function public.fd_league1_boost(p_backup boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_clubs integer;
  v_players integer;
  v_i integer;
begin
  create temp table if not exists fd_tmp_l1_club (club_id uuid primary key, ai boolean, xi numeric, rnk integer, n integer, target numeric, delta numeric) on commit drop;
  delete from fd_tmp_l1_club where true;
  insert into fd_tmp_l1_club
  with pl as (
    select p.club_id, p.overall, public.fd_pos_group(p.main_position::text) grp,
           row_number() over (partition by p.club_id, public.fd_pos_group(p.main_position::text) order by p.overall desc, p.id) rn
    from public.players p join fd_tmp_l1 t on t.club_id = p.club_id
    where not p.retired and not p.temporary),
  xi as (select club_id, avg(overall)::numeric xi from pl where rn <= case grp when 'GK' then 1 when 'DEF' then 4 else 3 end group by club_id),
  r as (
    select t.club_id, t.strength, (c.control = 'ai' and not c.amateur) ai, xi.xi,
           row_number() over (partition by t.league_key order by xi.xi desc, t.club_id)::integer rnk,
           count(*) over (partition by t.league_key)::integer n
    from fd_tmp_l1 t join public.clubs c on c.id = t.club_id join xi on xi.club_id = t.club_id)
  select r.club_id, r.ai, r.xi, r.rnk, r.n, public.fd_league1_target(r.strength, r.rnk, r.n),
         case when r.ai then greatest(0, public.fd_league1_target(r.strength, r.rnk, r.n) - r.xi) else 0 end
  from r;

  create temp table if not exists fd_tmp_l1_pl (player_id uuid primary key, world_id uuid, club_id uuid, overall smallint, market_value bigint, age smallint,
    potential smallint, kind text, pos text, attrs jsonb, di integer, new_attrs jsonb, new_overall smallint, wpos text, target integer) on commit drop;
  delete from fd_tmp_l1_pl where true;
  insert into fd_tmp_l1_pl(player_id, world_id, club_id, overall, market_value, age, potential, kind, pos, attrs, di)
  select p.id, p.world_id, p.club_id, p.overall, p.market_value, p.age, h.potential, pa.kind, p.main_position::text, pa.attributes,
         floor(c.delta + public.fd_hash01(p.id::text || ':league1'))::integer
  from fd_tmp_l1_club c
  join public.players p on p.club_id = c.club_id
  join public.player_attributes pa on pa.player_id = p.id
  left join public.player_hidden h on h.player_id = p.id
  where c.delta > 0 and not p.retired and not p.temporary and not p.in_draft_pool
    -- Spieler mit Bezug zu einem Menschenverein bleiben unverändert
    and not exists (select 1 from public.draft_picks dp where dp.player_id = p.id)
    and not exists (select 1 from public.transfers tr join public.clubs hc on hc.id in (tr.from_club_id, tr.to_club_id)
                    where tr.player_id = p.id and hc.control = 'human')
    and not exists (select 1 from public.transfer_offers o join public.clubs hc on hc.id in (o.from_club_id, o.to_club_id)
                    where o.player_id = p.id and hc.control = 'human' and o.status::text in ('pending', 'countered'));
  delete from fd_tmp_l1_pl where di <= 0;
  -- Mengenbasiert wie fd_league1_raise (gleiches Ergebnis, Gewichte einmal je Aufruf statt fd_overall je Spieler):
  -- gewichtete Attribute +di (max. 99), übrige +di/2; Gesamtstärke wie fd_overall (gleiche Summationsreihenfolge)
  create temp table if not exists fd_tmp_l1_w (pos text, k text, w float8, i bigint, primary key (pos, k)) on commit drop;
  delete from fd_tmp_l1_w where true;
  insert into fd_tmp_l1_w
  select x.pos, u.k, u.w, u.i
  from unnest(array['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST']) x(pos)
  cross join lateral public.fd_dev_weights(case when x.pos = 'GK' then 'goalkeeper' else 'outfield' end, x.pos) d
  cross join lateral unnest(d.keys, d.ws) with ordinality u(k, w, i);
  update fd_tmp_l1_pl set wpos = case when kind = 'goalkeeper' then 'GK' else pos end;
  update fd_tmp_l1_pl t set target = o.v + t.di
  from (select t2.player_id, floor(sum((t2.attrs ->> w.k)::float8 * w.w order by w.i) / sum(w.w order by w.i) + 0.5)::integer v
        from fd_tmp_l1_pl t2 join fd_tmp_l1_w w on w.pos = t2.wpos group by t2.player_id) o
  where o.player_id = t.player_id;
  update fd_tmp_l1_pl t set new_attrs = n.a
  from (select t2.player_id, jsonb_object_agg(e.key, case when w.k is not null then least(99, e.value::numeric + t2.di)
                                                          else least(99, e.value::numeric + t2.di / 2) end) a
        from fd_tmp_l1_pl t2 cross join lateral jsonb_each_text(t2.attrs) e
        left join fd_tmp_l1_w w on w.pos = t2.wpos and w.k = e.key
        group by t2.player_id) n
  where n.player_id = t.player_id;
  -- Kappung bei 99: weitere +1-Schritte der gewichteten Attribute, bis die Zielstärke erreicht ist
  for v_i in 1 .. 20 loop
    update fd_tmp_l1_pl t set new_overall = o.v
    from (select t2.player_id, floor(sum((t2.new_attrs ->> w.k)::float8 * w.w order by w.i) / sum(w.w order by w.i) + 0.5)::integer v
          from fd_tmp_l1_pl t2 join fd_tmp_l1_w w on w.pos = t2.wpos
          where v_i = 1 or t2.new_overall < t2.target group by t2.player_id) o
    where o.player_id = t.player_id;
    exit when not exists (select 1 from fd_tmp_l1_pl t where t.new_overall < t.target
                            and exists (select 1 from fd_tmp_l1_w w where w.pos = t.wpos and (t.new_attrs ->> w.k)::numeric < 99));
    update fd_tmp_l1_pl t set new_attrs = t.new_attrs || n.a
    from (select t2.player_id, jsonb_object_agg(w.k, least(99, (t2.new_attrs ->> w.k)::numeric + 1)) a
          from fd_tmp_l1_pl t2 join fd_tmp_l1_w w on w.pos = t2.wpos
          where t2.new_overall < t2.target group by t2.player_id) n
    where n.player_id = t.player_id;
  end loop;
  update fd_tmp_l1_pl set new_overall = least(99, greatest(1, overall + new_overall - (target - di)));

  if p_backup then
    insert into fd_backup.league1_0039 as b (player_id, world_id, club_id, overall, market_value, potential, attributes, delta, di)
    select player_id, world_id, club_id, overall, market_value, potential, attrs, new_overall - overall, di from fd_tmp_l1_pl
    on conflict (player_id) do update set world_id = excluded.world_id, club_id = excluded.club_id, overall = excluded.overall,
      market_value = excluded.market_value, potential = excluded.potential, attributes = excluded.attributes, delta = excluded.delta, di = excluded.di,
      backed_up_at = now(), restored_at = null
    where b.restored_at is not null;
  end if;

  update public.player_attributes pa set attributes = t.new_attrs, updated_at = now()
  from fd_tmp_l1_pl t where pa.player_id = t.player_id;
  update public.players p set overall = t.new_overall, market_value = public.fd_market_value(t.new_overall, p.age)
  from fd_tmp_l1_pl t where p.id = t.player_id;
  update public.player_hidden h set potential = least(99, greatest(h.potential + (t.new_overall - t.overall), t.new_overall))
  from fd_tmp_l1_pl t where h.player_id = t.player_id;

  -- Ausländische Erstligen: virtuelle Spielklasse nach neuer Stärke (wie levelFor bei der Generierung; nur aufwärts)
  create temp table if not exists fd_tmp_l1_lvl (club_id uuid primary key, world_id uuid, old_level smallint, new_level smallint) on commit drop;
  delete from fd_tmp_l1_lvl where true;
  insert into fd_tmp_l1_lvl
  select x.club_id, x.world_id, x.level, x.nl from (
    select t.club_id, t.world_id, cl.level,
           least(coalesce(cl.level, 4), case when public.fd_league1_xi(t.club_id) >= 77 then 1 when public.fd_league1_xi(t.club_id) >= 71 then 2
                                             when public.fd_league1_xi(t.club_id) >= 64 then 3 else 4 end)::smallint nl
    from fd_tmp_l1 t join fd_tmp_l1_club c on c.club_id = t.club_id and c.delta > 0 join public.clubs cl on cl.id = t.club_id
    where t.league_key like 'F:%' and cl.level is not null) x
  where x.nl < x.level;
  if p_backup then
    insert into fd_backup.league1_0039_clubs as b (club_id, world_id, level)
    select club_id, world_id, old_level from fd_tmp_l1_lvl
    on conflict (club_id) do update set level = excluded.level, world_id = excluded.world_id, backed_up_at = now(), restored_at = null
    where b.restored_at is not null;
  end if;
  update public.clubs c set level = l.new_level from fd_tmp_l1_lvl l where c.id = l.club_id;

  select count(*) into v_clubs from fd_tmp_l1_club where delta > 0;
  select count(*) into v_players from fd_tmp_l1_pl;
  return jsonb_build_object('clubs', v_clubs, 'players', v_players,
    'avg_delta', (select round(avg(delta), 2) from fd_tmp_l1_club where delta > 0));
end;
$$;

create or replace function public.fd_league1_enabled()
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select value from public.fd_settings where key = 'league1_strength'), 'on') = 'on';
$$;

-- Generierung: 1. Liga des Spiellands (p_comp) bzw. eine neu angelegte ausländische Erstliga (p_assoc)
create or replace function public.fd_league1_generation(p_world uuid, p_comp uuid, p_assoc text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_res jsonb;
begin
  if not public.fd_league1_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  create temp table if not exists fd_tmp_l1 (club_id uuid primary key, world_id uuid, league_key text, strength numeric) on commit drop;
  delete from fd_tmp_l1 where true;
  if p_comp is not null then
    insert into fd_tmp_l1
    select e.club_id, p_world, 'D', a.start_strength
    from public.competition_entries e join public.competitions c on c.id = e.competition_id
    join public.associations a on a.code = c.association_code
    where e.competition_id = p_comp;
  else
    insert into fd_tmp_l1
    select c.id, p_world, 'F:' || c.association_code, a.start_strength
    from public.clubs c join public.associations a on a.code = c.association_code
    where c.world_id = p_world and c.association_code = p_assoc and c.control = 'ai' and not c.amateur
      and c.association_code <> public.fd_world_country(p_world);
  end if;
  v_res := public.fd_league1_boost(false);
  if p_comp is not null then
    insert into public.fd_league1_strength(world_id, version, source, info) values (p_world, 1, 'generation', v_res)
    on conflict (world_id) do nothing;
  end if;
  return v_res;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Einmalige Datenmigration bestehender Welten
-- ---------------------------------------------------------------------
create or replace function public.fd_league1_strength_apply(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_res jsonb;
  v_t0 timestamptz := clock_timestamp();
begin
  if not public.fd_league1_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  select * into v_w from public.career_worlds where id = p_world for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.fd_league1_strength where world_id = p_world) then
    return jsonb_build_object('status', 'skipped');
  end if;
  create temp table if not exists fd_tmp_l1 (club_id uuid primary key, world_id uuid, league_key text, strength numeric) on commit drop;
  delete from fd_tmp_l1 where true;
  -- 1. Liga des Spiellands in der laufenden Saison (Menschen zählen für den Rang mit, werden aber nie verändert)
  insert into fd_tmp_l1
  select e.club_id, p_world, 'D', a.start_strength
  from public.competitions c
  join public.competition_entries e on e.competition_id = c.id
  join public.associations a on a.code = c.association_code
  where c.world_id = p_world and c.season_id = v_w.current_season_id and c.kind::text = 'league' and c.tier = 1
    and c.association_code = v_w.country_code
  on conflict (club_id) do nothing;
  -- übrige vorhandene Erstligen (ausländische Verbände der Welt)
  insert into fd_tmp_l1
  select c.id, p_world, 'F:' || c.association_code, a.start_strength
  from public.clubs c join public.associations a on a.code = c.association_code
  where c.world_id = p_world and c.association_code <> v_w.country_code and c.control = 'ai' and not c.amateur
  on conflict (club_id) do nothing;
  v_res := public.fd_league1_boost(true);
  v_res := v_res || jsonb_build_object('ms', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
  insert into public.fd_league1_strength(world_id, version, source, info) values (p_world, 1, 'migration', v_res);
  return v_res || jsonb_build_object('status', 'applied');
end;
$$;

-- Alle noch nicht bearbeiteten Welten; bricht nach p_budget_seconds ab (Supabase-SQL-Editor: 60 s).
-- Rest: Migration erneut ausführen oder select public.fd_league1_strength_apply_all();
create or replace function public.fd_league1_strength_apply_all(p_budget_seconds integer default 40)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t0 timestamptz := clock_timestamp();
  w record;
  v_done integer := 0;
  v_players integer := 0;
  v_res jsonb;
  v_left integer;
begin
  if not public.fd_league1_enabled() then return jsonb_build_object('status', 'disabled'); end if;
  for w in select cw.id from public.career_worlds cw
           where not exists (select 1 from public.fd_league1_strength m where m.world_id = cw.id)
           order by cw.created_at, cw.id loop
    exit when extract(epoch from clock_timestamp() - v_t0) > p_budget_seconds;
    v_res := public.fd_league1_strength_apply(w.id);
    v_done := v_done + 1;
    v_players := v_players + coalesce((v_res ->> 'players')::integer, 0);
  end loop;
  select count(*) into v_left from public.career_worlds cw where not exists (select 1 from public.fd_league1_strength m where m.world_id = cw.id);
  return jsonb_build_object('worlds', v_done, 'players', v_players, 'remaining', v_left,
    'ms', round(extract(epoch from clock_timestamp() - v_t0) * 1000));
end;
$$;

-- Rückgängig: Originalwerte exakt zurückschreiben (eine Welt oder alle). Ohne Welt-Angabe wird zusätzlich
-- die Verstärkung bei der Generierung abgeschaltet (fd_settings league1_strength = off).
create or replace function public.fd_league1_strength_rollback(p_world uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.player_attributes pa set attributes = b.attributes, updated_at = now()
  from fd_backup.league1_0039 b where pa.player_id = b.player_id and b.restored_at is null and (p_world is null or b.world_id = p_world);
  update public.players p set overall = b.overall, market_value = b.market_value
  from fd_backup.league1_0039 b where p.id = b.player_id and b.restored_at is null and (p_world is null or b.world_id = p_world);
  update public.player_hidden h set potential = b.potential
  from fd_backup.league1_0039 b where h.player_id = b.player_id and b.potential is not null and b.restored_at is null and (p_world is null or b.world_id = p_world);
  update public.clubs c set level = b.level
  from fd_backup.league1_0039_clubs b where c.id = b.club_id and b.restored_at is null and (p_world is null or b.world_id = p_world);
  update fd_backup.league1_0039_clubs b set restored_at = now() where b.restored_at is null and (p_world is null or b.world_id = p_world);
  update fd_backup.league1_0039 b set restored_at = now() where b.restored_at is null and (p_world is null or b.world_id = p_world);
  get diagnostics v_n = row_count;
  delete from public.fd_league1_strength where source = 'migration' and (p_world is null or world_id = p_world);
  if p_world is null then
    insert into public.fd_settings(key, value) values ('league1_strength', 'off') on conflict (key) do update set value = 'off';
  end if;
  return jsonb_build_object('restored_players', v_n);
end;
$$;

revoke execute on function public.fd_league1_ref(numeric) from public, anon;
revoke execute on function public.fd_league1_target(numeric, integer, integer) from public, anon;
revoke execute on function public.fd_league1_raise(text, text, jsonb, integer) from public, anon;
revoke execute on function public.fd_league1_xi(uuid) from public, anon, authenticated;
revoke execute on function public.fd_league1_enabled() from public, anon;
revoke execute on function public.fd_league1_boost(boolean) from public, anon, authenticated;
revoke execute on function public.fd_league1_generation(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.fd_league1_strength_apply(uuid) from public, anon, authenticated;
revoke execute on function public.fd_league1_strength_apply_all(integer) from public, anon, authenticated;
revoke execute on function public.fd_league1_strength_rollback(uuid) from public, anon, authenticated;
grant execute on function public.fd_league1_boost(boolean) to service_role;
grant execute on function public.fd_league1_generation(uuid, uuid, text) to service_role;
grant execute on function public.fd_league1_strength_apply(uuid) to service_role;
grant execute on function public.fd_league1_strength_apply_all(integer) to service_role;
grant execute on function public.fd_league1_strength_rollback(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 5. Generierung neuer Welten (Definitionen aus 0033, je eine Zeile ergänzt: fd_league1_generation)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_add_europe(p_world uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_code text := p_payload ->> 'association_code';
  v_year integer;
  r record;
  v_clubs integer;
  v_players integer;
  v_name text;
  v_short text;
  v_try integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if not found then raise exception 'Welt nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  if v_code is null or v_code = v_world.country_code::text or not exists (select 1 from public.associations where code = v_code) then
    raise exception 'Ungültiger Verband.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  -- idempotent: ein Verband wird nur einmal angelegt
  if exists (select 1 from public.clubs where world_id = p_world and association_code = v_code) then
    return jsonb_build_object('status', 'exists', 'association', v_code);
  end if;
  v_year := coalesce(public.fd_season_year(v_world.current_season_id), extract(year from now())::int);

  create temp table if not exists fd_tmp_eu_clubs (key text primary key, id uuid not null) on commit drop;
  delete from fd_tmp_eu_clubs where true;
  insert into fd_tmp_eu_clubs(key, id) select c ->> 'key', gen_random_uuid() from jsonb_array_elements(p_payload -> 'clubs') c;

  -- Vereine einzeln anlegen: bei gleichzeitigen Aufrufen (zwei Manager) Konflikte bei Name/Kürzel auflösen
  for r in select m.id, c from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key' loop
    v_name := r.c ->> 'name';
    v_short := r.c ->> 'short_name';
    if exists (select 1 from public.clubs where world_id = p_world and name_normalized = public.normalize_name(v_name)) then
      v_name := left(v_name, 27) || ' ' || v_code;
    end if;
    v_try := 0;
    while exists (select 1 from public.clubs where world_id = p_world and short_name_normalized = public.normalize_name(v_short)) and v_try < 200 loop
      v_try := v_try + 1;
      v_short := left(regexp_replace(upper(r.c ->> 'short_name'), '[^A-ZÄÖÜ]', '', 'g') || 'XX', 2) || lpad(((v_try * 37 + length(v_code)) % 90 + 10)::text, 2, '0');
    end loop;
    insert into public.clubs(id, world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, founded_year, reputation, level, league_name)
    values (r.id, p_world, v_code, v_name, '', v_short, '', 'ai', (r.c ->> 'founded_year')::smallint,
            least(100, greatest(0, (r.c ->> 'reputation')::numeric)), (r.c ->> 'level')::smallint, r.c ->> 'league_name');
  end loop;

  insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
  select m.id, p_world, c ->> 'primary', c ->> 'secondary', c ->> 'accent', c -> 'crest', c -> 'kit'
  from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key';

  insert into public.stadiums(club_id, world_id, name, capacity)
  select m.id, p_world, c ->> 'stadium_name', (c ->> 'capacity')::integer
  from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key';

  insert into public.finances(club_id, world_id, balance) select id, p_world, 0 from fd_tmp_eu_clubs;
  for r in select m.id, (c ->> 'balance')::bigint as balance
           from jsonb_array_elements(p_payload -> 'clubs') c join fd_tmp_eu_clubs m on m.key = c ->> 'key' loop
    perform public.post_transaction(r.id, 'starting_capital', r.balance, 'start:' || r.id, 'Startkapital', v_world.current_season_id);
  end loop;

  create temp table if not exists fd_tmp_eu_players (
    id uuid primary key, club_id uuid, first text, last text, nat text, region text, age smallint, pos text,
    sec jsonb, overall smallint, potential smallint, value bigint, salary bigint, pref_shirt smallint,
    kind text, attrs jsonb, contract_years smallint, shirt smallint
  ) on commit drop;
  delete from fd_tmp_eu_players where true;
  insert into fd_tmp_eu_players
  select gen_random_uuid(), m.id, p ->> 'first', p ->> 'last', p ->> 'nat', p ->> 'region', (p ->> 'age')::smallint, p ->> 'pos',
         p -> 'sec', (p ->> 'overall')::smallint, (p ->> 'potential')::smallint, (p ->> 'value')::bigint, (p ->> 'salary')::bigint,
         (p ->> 'prefShirt')::smallint, p ->> 'kind', p -> 'attrs', nullif(p ->> 'contract_years', '')::smallint, nullif(p ->> 'shirt', '')::smallint
  from jsonb_array_elements(p_payload -> 'players') p
  left join fd_tmp_eu_clubs m on m.key = p ->> 'club_key';
  if exists (select 1 from fd_tmp_eu_players where club_id is not null and (contract_years is null or contract_years not between 1 and 5))
     or exists (select 1 from fd_tmp_eu_players t where t.club_id is null and (t.contract_years is not null or t.shirt is not null)) then
    raise exception 'Ungültige Spielerdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  insert into public.players(id, world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                             overall, fitness, market_value, shirt_number, preferred_shirt_number, club_id, in_draft_pool)
  select t.id, p_world, t.first, t.last, t.nat, t.region::public.region, t.age, t.pos::public.player_position,
         coalesce(array(select jsonb_array_elements_text(t.sec))::public.player_position[], '{}'),
         t.overall, 100, t.value, t.shirt, t.pref_shirt, t.club_id, false
  from fd_tmp_eu_players t;
  insert into public.player_attributes(player_id, world_id, kind, attributes) select id, p_world, kind, attrs from fd_tmp_eu_players;
  insert into public.player_hidden(player_id, world_id, potential) select id, p_world, greatest(potential, overall) from fd_tmp_eu_players;
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, id, club_id, v_year, v_year + contract_years - 1, salary, age from fd_tmp_eu_players where club_id is not null;
  insert into public.free_agents(player_id, world_id, annual_salary) select id, p_world, salary from fd_tmp_eu_players where club_id is null;

  -- 0039: neu angelegte ausländische Erstliga verstärken (KI-Vereine; Schalter fd_settings league1_strength)
  perform public.fd_league1_generation(p_world, null, v_code);

  select count(*) into v_clubs from fd_tmp_eu_clubs;
  select count(*) into v_players from fd_tmp_eu_players;
  return jsonb_build_object('status', 'created', 'association', v_code, 'clubs', v_clubs, 'players', v_players);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_start_draft(p_world uuid, p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_world public.career_worlds;
  v_humans integer;
  v_season uuid;
  v_year integer := extract(year from now())::integer;
  v_comp uuid[] := array[]::uuid[];
  v_comp_id uuid;
  v_tier integer;
  v_capital bigint;
  v_order uuid[];
  v_draft uuid;
  r record;
  v_count integer;
  v_cc text;
  v_st integer;
  v_k numeric;
  v_pool_max integer;
begin
  select * into v_world from public.career_worlds where id = p_world for update;
  if not found then
    raise exception 'Karrierewelt nicht gefunden.' using errcode = 'P0002', hint = 'world_not_found';
  end if;
  if v_world.status <> 'lobby' then
    -- idempotent: ein zweiter Klick startet nichts neu
    return jsonb_build_object('already_started', true, 'status', v_world.status);
  end if;
  if v_world.host_user_id <> p_user then
    raise exception 'Nur der Host darf den Draft starten.' using errcode = '42501', hint = 'host_only';
  end if;
  if exists (
    select 1 from public.world_members m
    left join public.clubs c on c.world_id = m.world_id and c.manager_user_id = m.user_id
    left join public.multiplayer_readiness rd on rd.world_id = m.world_id and rd.user_id = m.user_id and rd.context = 'lobby'
    where m.world_id = p_world and (c.id is null or not coalesce(rd.ready, false))
  ) then
    raise exception 'Noch nicht alle Manager haben ihren Verein gegründet und Bereitschaft bestätigt.' using errcode = 'P0001', hint = 'not_all_ready';
  end if;

  select count(*) into v_humans from public.clubs where world_id = p_world and control = 'human';
  v_cc := v_world.country_code::text;
  v_st := v_world.start_tier;
  v_k := public.fd_capital_factor(v_cc, v_st);
  v_pool_max := public.fd_draft_pool_max(v_cc, v_st) + (case when v_cc = 'GER' and v_st = 2 then 0 else 1 end); -- +1: Rundungstoleranz TS/SQL
  -- Payload muss zum Spielland und zur Startliga der Welt passen (ältere Payloads: Deutschland, 2. Liga)
  if coalesce(p_payload ->> 'country', 'GER') <> v_cc or coalesce((p_payload ->> 'start_tier')::int, 2) <> v_st then
    raise exception 'Initialisierungsdaten passen nicht zu Land/Startliga der Welt.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  -- Payload prüfen (der Server vertraut auch der eigenen Function nicht blind)
  if p_payload is null or (p_payload ->> 'version') is distinct from '1' then
    raise exception 'Ungültige Initialisierungsdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if jsonb_array_length(p_payload -> 'ai_clubs') <> 54 - v_humans
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 1) <> 18 - (case when v_st = 1 then v_humans else 0 end)
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 2) <> 18 - (case when v_st = 2 then v_humans else 0 end)
     or (select count(*) from jsonb_array_elements(p_payload -> 'ai_clubs') c where (c ->> 'tier')::int = 3) <> 18 - (case when v_st = 3 then v_humans else 0 end) then
    raise exception 'Ungültige Vereinsverteilung im Payload.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload -> 'players') p where p -> 'club_key' = 'null'::jsonb) <> 400
     or exists (select 1 from jsonb_array_elements(p_payload -> 'players') p
                where p -> 'club_key' = 'null'::jsonb and (p ->> 'overall')::int > v_pool_max) then
    raise exception 'Der Draft-Pool muss aus genau 400 Spielern mit zulässiger Startstärke bestehen.' using errcode = '22023', hint = 'invalid_payload';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload -> 'ai_clubs') c
             where not public.fd_valid_crest(c -> 'crest') or not public.fd_valid_kit(c -> 'kit')
                or not public.is_hex_color(c ->> 'primary') or not public.is_hex_color(c ->> 'secondary') or not public.is_hex_color(c ->> 'accent')) then
    raise exception 'Ungültiges Branding im Payload.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  -- Saison und die drei Ligen (C1)
  insert into public.seasons(world_id, year, status) values (p_world, v_year, 'planned') returning id into v_season;
  for v_tier in 1..3 loop
    insert into public.competitions(world_id, season_id, kind, association_code, tier, name)
    values (p_world, v_season, 'league', v_cc, v_tier, public.fd_league_name(v_cc, v_tier))
    returning id into v_comp_id;
    v_comp := v_comp || v_comp_id;
  end loop;

  -- KI-Vereine (IDs vorab, damit Spieler über club_key zugeordnet werden können)
  create temp table if not exists fd_tmp_club_map (key text primary key, id uuid not null, tier smallint not null) on commit drop;
  truncate fd_tmp_club_map;
  insert into fd_tmp_club_map(key, id, tier)
  select c ->> 'key', gen_random_uuid(), (c ->> 'tier')::smallint from jsonb_array_elements(p_payload -> 'ai_clubs') c;

  insert into public.clubs(id, world_id, association_code, name, name_normalized, short_name, short_name_normalized, control, founded_year, reputation)
  select m.id, p_world, v_cc, c ->> 'name', '', c ->> 'short_name', '', 'ai', (c ->> 'founded_year')::smallint,
         least(100, greatest(0, (c ->> 'reputation')::numeric))
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.club_branding(club_id, world_id, primary_color, secondary_color, accent_color, crest, kit)
  select m.id, p_world, c ->> 'primary', c ->> 'secondary', c ->> 'accent', c -> 'crest', c -> 'kit'
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.stadiums(club_id, world_id, name, capacity)
  select m.id, p_world, c ->> 'stadium_name', (c ->> 'capacity')::integer
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.managers(world_id, club_id, display_name, ai_profile)
  select p_world, m.id, c ->> 'manager_name', c -> 'ai_profile'
  from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key';

  insert into public.finances(club_id, world_id, balance) select id, p_world, 0 from fd_tmp_club_map;

  for r in select m.id, (c ->> 'balance')::bigint as balance, c -> 'ai_profile' ->> 'preferred_formation' as formation
           from jsonb_array_elements(p_payload -> 'ai_clubs') c join fd_tmp_club_map m on m.key = c ->> 'key' loop
    perform public.post_transaction(r.id, 'starting_capital', r.balance, 'start:' || r.id, 'Startkapital', v_season);
    perform public.fd_init_club_tactics(p_world, r.id, r.formation);
  end loop;

  -- Ligazugehörigkeit: KI nach Payload, Menschen in die gewählte Startliga
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[m.tier], m.id, p_world from fd_tmp_club_map m;
  insert into public.competition_entries(competition_id, club_id, world_id)
  select v_comp[v_st], c.id, p_world from public.clubs c where c.world_id = p_world and c.control = 'human';
  update public.clubs set association_code = v_cc where world_id = p_world and control = 'human' and association_code <> v_cc;

  -- Spieler (KI-Kader und Draft-Pool)
  create temp table if not exists fd_tmp_players (
    id uuid primary key, club_id uuid, first text, last text, nat text, region text, age smallint, pos text,
    sec jsonb, overall smallint, potential smallint, value bigint, salary bigint, pref_shirt smallint,
    kind text, attrs jsonb, contract_years smallint, shirt smallint
  ) on commit drop;
  truncate fd_tmp_players;
  insert into fd_tmp_players
  select gen_random_uuid(), m.id, p ->> 'first', p ->> 'last', p ->> 'nat', p ->> 'region', (p ->> 'age')::smallint, p ->> 'pos',
         p -> 'sec', (p ->> 'overall')::smallint, (p ->> 'potential')::smallint, (p ->> 'value')::bigint, (p ->> 'salary')::bigint,
         (p ->> 'prefShirt')::smallint, p ->> 'kind', p -> 'attrs', nullif(p ->> 'contract_years', '')::smallint, nullif(p ->> 'shirt', '')::smallint
  from jsonb_array_elements(p_payload -> 'players') p
  left join fd_tmp_club_map m on m.key = p ->> 'club_key';

  if exists (select 1 from fd_tmp_players where club_id is null and (contract_years is not null or shirt is not null))
     or exists (select 1 from fd_tmp_players where club_id is not null and (contract_years is null or contract_years not between 1 and 5)) then
    raise exception 'Ungültige Spielerdaten.' using errcode = '22023', hint = 'invalid_payload';
  end if;

  insert into public.players(id, world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                             overall, fitness, market_value, shirt_number, preferred_shirt_number, club_id, in_draft_pool)
  select t.id, p_world, t.first, t.last, t.nat, t.region::public.region, t.age, t.pos::public.player_position,
         coalesce(array(select jsonb_array_elements_text(t.sec))::public.player_position[], '{}'),
         t.overall, 100, t.value, t.shirt, t.pref_shirt, t.club_id, t.club_id is null
  from fd_tmp_players t;

  insert into public.player_attributes(player_id, world_id, kind, attributes)
  select id, p_world, kind, attrs from fd_tmp_players;

  insert into public.player_hidden(player_id, world_id, potential)
  select id, p_world, greatest(potential, overall) from fd_tmp_players;

  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  select p_world, id, club_id, v_year, v_year + contract_years - 1, salary, age from fd_tmp_players where club_id is not null;

  -- D1/H4: Der Pool steht zugleich als Free-Agent-Markt bereit; Gehalt nach H5 (Alter bei Vertragsabschluss)
  insert into public.free_agents(player_id, world_id, annual_salary)
  select id, p_world, salary from fd_tmp_players where club_id is null;

  -- 0039: KI-Vereine der 1. Liga verstärken (Rang nach Stärke, Ziel 87–88 … 79–81, skaliert nach Landesstärke)
  perform public.fd_league1_generation(p_world, v_comp[1], null);

  -- I1/I3: Startkapital und Stadionkosten der menschlichen Vereine vor dem Draft buchen
  -- Startkapital und Stadionbau nach Startliga und Landesstärke (Deutschland, 2. Liga: Faktor 1)
  v_capital := public.fd_scaled(public.starting_capital(v_world.difficulty), v_k);
  for r in select c.id, s.capacity from public.clubs c join public.stadiums s on s.club_id = c.id
           where c.world_id = p_world and c.control = 'human' loop
    perform public.post_transaction(r.id, 'starting_capital', v_capital, 'start:' || r.id,
      'Startkapital (' || v_world.difficulty || ')', v_season);
    perform public.post_transaction(r.id, 'stadium_build', -public.fd_scaled(public.stadium_build_cost(r.capacity), least(1, v_k)), 'stadium_build:' || r.id,
      'Stadionbau (' || r.capacity || ' Plätze)', v_season);
  end loop;

  -- D3: zufällige Draftreihenfolge der menschlichen Vereine
  select array_agg(id order by gen_random_uuid()) into v_order
  from public.clubs where world_id = p_world and control = 'human';
  insert into public.draft_sessions(world_id, status, club_order, picks_per_club, current_pick, started_at)
  values (p_world, 'running', v_order, 22, 0, now())
  returning id into v_draft;

  update public.career_worlds set status = 'draft', current_season_id = v_season,
    economy_factor = public.fd_economy_factor_for(v_cc),
    amateur_names = case when jsonb_typeof(p_payload -> 'amateur_names') = 'array'
                         then (select array_agg(left(x, 32)) from jsonb_array_elements_text(p_payload -> 'amateur_names') x) end
  where id = p_world;

  select count(*) into v_count from fd_tmp_players;
  return jsonb_build_object('draft_id', v_draft, 'season_id', v_season, 'ai_clubs', 54 - v_humans, 'players', v_count);
end;
$function$
;


-- ---------------------------------------------------------------------
-- 6. Bestehende Welten einmalig anpassen (Zeitbudget 40 s; Rest bei erneutem Ausführen)
-- ---------------------------------------------------------------------
do $$
declare v jsonb;
begin
  v := public.fd_league1_strength_apply_all(40);
  insert into public.fd_data_migrations(key, info) values ('0039_league1_strength', v)
  on conflict (key) do update set info = public.fd_data_migrations.info || jsonb_build_object('rerun_' || to_char(now(), 'YYYYMMDDHH24MISS'), v);
  raise notice '0039 1. Liga: %', v;
  if coalesce((v ->> 'remaining')::integer, 0) > 0 then
    raise notice '0039: % Welten offen – Migration erneut ausführen oder: select public.fd_league1_strength_apply_all();', v ->> 'remaining';
  end if;
end $$;
