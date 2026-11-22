-- Jugendabteilung + Karriereende (Audit-Befund: Ø-Alter stieg über 10 Saisonen von 27 auf 35,7, Ø-OVR fiel von 75,5 auf 66,9)
--  * Karriereende ab ca. 34 Jahren (Wahrscheinlichkeit steigt mit dem Alter, Torhüter und Spieler ab OVR 80 je 2 Jahre später).
--  * Jugendabteilung je Verein (Stufe 1–5, menschliche Manager investieren einmalig in der Vorbereitung; KI-Vereine Stufe 2).
--    Jugendspieler (16–18 Jahre) liegen in eigener Tabelle youth_players und beeinflussen Kader/Aufstellung nicht,
--    bis sie in den Profikader übernommen werden (KI automatisch mit 18, Menschen entscheiden bis 19, danach automatisch).
--  * Ausländische Vereine (nicht simuliert): Karriereende wird 1:1 durch einen jungen Spieler ersetzt (kein Nachwuchs-Datensatz).
-- Idempotent und ohne Datenverlust; keine bestehenden Spieler/Karrieren werden verändert, bis ein Saisonwechsel stattfindet.

alter type public.transaction_kind add value if not exists 'youth_academy';

create table if not exists public.youth_academies (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  level smallint not null default 1 check (level between 1 and 5),
  updated_at timestamptz not null default now()
);
create index if not exists youth_academies_world_idx on public.youth_academies(world_id);

create table if not exists public.youth_players (
  id uuid primary key default gen_random_uuid(),
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  nationality char(3) not null,
  region public.region not null,
  age smallint not null check (age between 15 and 20),
  main_position public.player_position not null,
  overall smallint not null check (overall between 1 and 99),
  potential smallint not null check (potential between 1 and 99), -- verdeckt: nur über RPC als Sterne sichtbar
  kind text not null check (kind in ('outfield', 'goalkeeper')),
  attributes jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists youth_players_club_idx on public.youth_players(club_id);
create index if not exists youth_players_world_idx on public.youth_players(world_id);

alter table public.youth_academies enable row level security;
alter table public.youth_players enable row level security;
revoke all on public.youth_academies, public.youth_players from anon, authenticated;

-- ---------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------
create or replace function public.fd_youth_upgrade_cost(p_level integer)
returns bigint language sql immutable set search_path = '' as $$
  select case p_level when 2 then 6000000 when 3 then 15000000 when 4 then 30000000 when 5 then 55000000 else null end::bigint;
$$;

create or replace function public.fd_youth_intake(p_level integer)
returns integer language sql immutable set search_path = '' as $$
  select case p_level when 1 then 2 when 2 then 3 when 3 then 3 when 4 then 4 else 4 end;
$$;

-- Verschiebt alle Attribute um d (auf 20–99 begrenzt); Struktur bleibt gültig
create or replace function public.fd_shift_attrs(p_attrs jsonb, p_delta double precision)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_object_agg(k, to_jsonb(greatest(20, least(99, round(v::numeric + p_delta::numeric))::integer))) from jsonb_each_text(p_attrs) a(k, v);
$$;

-- Stufe eines Vereins (Menschen: gespeicherte Stufe, Standard 1; KI: 2)
create or replace function public.fd_youth_level(p_club uuid)
returns integer language sql stable set search_path = '' as $$
  select case when c.control = 'human' then coalesce((select a.level from public.youth_academies a where a.club_id = c.id), 1) else 2 end
  from public.clubs c where c.id = p_club;
$$;

-- Jugendspieler in den Profikader übernehmen (Vertrag 3 Jahre, Gehalt nach fd_salary); gibt die neue Spieler-ID zurück
create or replace function public.fd_youth_promote_row(p_youth uuid, p_year integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  y public.youth_players;
  v_id uuid;
  v_shirt integer;
begin
  select * into y from public.youth_players where id = p_youth for update;
  if y.id is null then return null; end if;
  select min(n) into v_shirt from generate_series(1, 99) n
    where not exists (select 1 from public.players p where p.club_id = y.club_id and p.shirt_number = n);
  insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                             overall, fitness, market_value, shirt_number, club_id)
  values (y.world_id, y.first_name, y.last_name, y.nationality, y.region, y.age, y.main_position, '{}',
          y.overall, 100, public.fd_market_value(y.overall, y.age), v_shirt, y.club_id)
  returning id into v_id;
  insert into public.player_attributes(player_id, world_id, kind, attributes) values (v_id, y.world_id, y.kind, y.attributes);
  insert into public.player_hidden(player_id, world_id, potential, development_points, injury_proneness)
  values (v_id, y.world_id, greatest(y.potential, y.overall), 0, round((0.3 + public.fd_hash01(v_id::text || ':inj') * 0.4)::numeric, 3));
  insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
  values (y.world_id, v_id, y.club_id, p_year, p_year + 2,
          greatest(1, public.fd_salary(y.overall, y.age, public.fd_typical_tier(y.overall), 50, 3)), y.age);
  delete from public.youth_players where id = y.id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Saisonwechsel: Karriereende, Jugendentwicklung/-übernahme, neuer Jahrgang
-- ---------------------------------------------------------------------
create or replace function public.fd_youth_season_change(p_world uuid, p_season uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_year integer;
  v_retired integer := 0;
  v_replaced integer := 0;
  v_promoted integer := 0;
  v_dropped integer := 0;
  v_new integer := 0;
  y record;
  cr record;
  t public.players;
  v_i integer;
  v_squad integer;
  v_pot integer;
  v_ovr integer;
  v_h double precision;
  v_target integer;
  v_attrs jsonb;
  v_kind text;
  v_group text;
  v_first text;
  v_last text;
  v_nid uuid;
begin
  select * into v_w from public.career_worlds where id = p_world;
  v_year := public.fd_season_year(p_season);
  if v_w.id is null or v_year is null then return null; end if;

  -- Namenspool je Nationalität (für Jahrgang und Ersatzspieler)
  drop table if exists fd_tmp_names;
  create temporary table fd_tmp_names as
    select nationality, first_name, last_name,
           row_number() over (partition by nationality order by md5(id::text || p_season::text)) as rn,
           count(*) over (partition by nationality) as cnt
    from public.players where world_id = p_world and not temporary;
  create index on fd_tmp_names(nationality, rn);

  -- A) Karriereende (nur Vereinsspieler nicht-amateurischer Vereine)
  drop table if exists fd_tmp_ret;
  create temporary table fd_tmp_ret as
  select r.id, r.club_id, r.first_name, r.last_name, r.nationality, r.region, r.main_position, r.overall, r.age, r.shirt_number, r.act
  from (
    select p.id, p.club_id, p.first_name, p.last_name, p.nationality, p.region, p.main_position, p.overall, p.age, p.shirt_number,
           (c.association_code = v_w.country_code) as act,
           row_number() over (partition by p.club_id order by p.age desc, p.overall) as rn,
           count(*) over (partition by p.club_id) as cnt,
           public.fd_hash01(p.id::text || ':retire:' || p_season::text) as h,
           p.age - case when p.main_position = 'GK' then 2 else 0 end - case when p.overall >= 80 then 2 else 0 end as eff
    from public.players p join public.clubs c on c.id = p.club_id
    where p.world_id = p_world and p.club_id is not null and not p.retired and not p.temporary and not c.amateur
  ) r
  where r.eff >= 34
    and r.h < case r.eff when 34 then 0.08 when 35 then 0.2 when 36 then 0.4 when 37 then 0.65 when 38 then 0.85 else 1.0 end
    and (not r.act or r.rn <= r.cnt - 16);   -- aktive Liga: Kader bleibt über 15 Spielern
  get diagnostics v_retired = row_count;

  update public.player_contracts k set active = false from fd_tmp_ret r where k.player_id = r.id and k.active;
  update public.tactical_profile_slots s set player_id = null from fd_tmp_ret r where s.player_id = r.id;
  delete from public.player_instructions pi using fd_tmp_ret r where pi.player_id = r.id;
  delete from public.set_piece_assignments a using fd_tmp_ret r where a.player_id = r.id;
  delete from public.free_agents f using fd_tmp_ret r where f.player_id = r.id;
  update public.players p set club_id = null, shirt_number = null, retired = true from fd_tmp_ret r where p.id = r.id;
  insert into public.transfers(world_id, season_id, player_id, from_club_id, to_club_id, kind, fee)
  select p_world, p_season, r.id, r.club_id, null, 'retirement', 0 from fd_tmp_ret r;

  -- B) Ausländische Vereine: 1:1-Ersatz durch einen 18-Jährigen (Attribute des Rentners, nach unten verschoben)
  for y in select r.*, public.fd_hash01(r.id::text || ':repl') as h from fd_tmp_ret r where not r.act loop
    v_target := greatest(50, least(y.overall - 10, 74)) + floor(y.h * 5)::integer;
    select pa.kind, public.fd_shift_attrs(pa.attributes, v_target - y.overall) into v_kind, v_attrs
      from public.player_attributes pa where pa.player_id = y.id;
    continue when v_attrs is null;
    select n.first_name into v_first from fd_tmp_names n where n.nationality = y.nationality and n.rn = 1 + floor(public.fd_hash01(y.id::text || ':fn') * n.cnt)::integer limit 1;
    select n.last_name into v_last from fd_tmp_names n where n.nationality = y.nationality and n.rn = 1 + floor(public.fd_hash01(y.id::text || ':ln') * n.cnt)::integer limit 1;
    v_ovr := public.fd_overall(v_kind, y.main_position::text, v_attrs);
    insert into public.players(world_id, first_name, last_name, nationality, region, age, main_position, secondary_positions,
                               overall, fitness, market_value, shirt_number, club_id)
    values (p_world, coalesce(v_first, y.first_name), coalesce(v_last, y.last_name), y.nationality, y.region, 18, y.main_position, '{}',
            v_ovr, 100, public.fd_market_value(v_ovr, 18), y.shirt_number, y.club_id)
    returning id into v_nid;
    insert into public.player_attributes(player_id, world_id, kind, attributes) values (v_nid, p_world, v_kind, v_attrs);
    insert into public.player_hidden(player_id, world_id, potential, development_points, injury_proneness)
    values (v_nid, p_world, least(95, v_ovr + 6 + floor(y.h * 12)::integer), 0, round((0.3 + y.h * 0.4)::numeric, 3));
    insert into public.player_contracts(world_id, player_id, club_id, start_season_year, end_season_year, annual_salary, age_at_signing)
    values (p_world, v_nid, y.club_id, v_year, v_year + 2, greatest(1, public.fd_salary(v_ovr, 18, public.fd_typical_tier(v_ovr), 50, 3)), 18);
    v_replaced := v_replaced + 1;
  end loop;

  -- C) Jugend entwickeln (ein Jahr älter, Wachstum Richtung Potenzial)
  with s as (
    select id, public.fd_shift_attrs(attributes, ceil(greatest(0, potential - overall) * 0.4)) as a from public.youth_players where world_id = p_world)
  update public.youth_players yp set age = least(20, yp.age + 1), attributes = s.a,
         overall = greatest(yp.overall, least(99, public.fd_overall(yp.kind, yp.main_position::text, s.a)))
  from s where s.id = yp.id;

  -- D) Übernahme in den Profikader (KI mit 18 bei Platz im Kader, Menschen spätestens mit 19); ältere ohne Platz scheiden aus
  for y in select yp.id, yp.club_id, yp.age, cl.control from public.youth_players yp join public.clubs cl on cl.id = yp.club_id
           where yp.world_id = p_world and yp.age >= 18 order by yp.potential desc, yp.id loop
    select count(*) into v_squad from public.players p where p.club_id = y.club_id and not p.retired and not p.temporary;
    if (y.control = 'ai' or y.age >= 19) then
      if v_squad < 26 then
        perform public.fd_youth_promote_row(y.id, v_year);
        v_promoted := v_promoted + 1;
      elsif y.age >= 19 then
        delete from public.youth_players where id = y.id;
        v_dropped := v_dropped + 1;
      end if;
    end if;
  end loop;

  -- E) Neuer Jahrgang für alle nicht-amateurischen Vereine der aktiven Liga
  for cr in select cl.id, cl.control from public.clubs cl
           where cl.world_id = p_world and not cl.amateur and cl.association_code = v_w.country_code order by cl.id loop
    for v_i in 1..public.fd_youth_intake(public.fd_youth_level(cr.id)) loop
      v_h := public.fd_hash01(cr.id::text || ':' || p_season::text || ':' || v_i);
      v_group := case when v_h * 10 < 1 then 'GK' when v_h * 10 < 5 then 'DEF' when v_h * 10 < 8 then 'MID' else 'ATT' end;
      select p.* into t from public.players p
        where p.club_id = cr.id and not p.temporary and public.fd_pos_group(p.main_position::text) = v_group
        order by md5(p.id::text || p_season::text || v_i) limit 1;
      if t.id is null then
        select p.* into t from public.players p where p.club_id = cr.id and not p.temporary order by md5(p.id::text || p_season::text || v_i) limit 1;
      end if;
      continue when t.id is null;
      v_pot := least(95, greatest(45, round(58 + 5 * public.fd_youth_level(cr.id) + (public.fd_hash01(cr.id::text || v_i || ':pot') - 0.5) * 22)::integer));
      select pa.kind, public.fd_shift_attrs(pa.attributes, (v_pot - 22 - floor(v_h * 5)) - t.overall) into v_kind, v_attrs
        from public.player_attributes pa where pa.player_id = t.id;
      continue when v_attrs is null;
      v_ovr := public.fd_overall(v_kind, t.main_position::text, v_attrs);
      select n.first_name into v_first from fd_tmp_names n where n.nationality = t.nationality and n.rn = 1 + floor(public.fd_hash01(cr.id::text || v_i || ':fn') * n.cnt)::integer limit 1;
      select n.last_name into v_last from fd_tmp_names n where n.nationality = t.nationality and n.rn = 1 + floor(public.fd_hash01(cr.id::text || v_i || ':ln') * n.cnt)::integer limit 1;
      insert into public.youth_players(world_id, club_id, first_name, last_name, nationality, region, age, main_position, overall, potential, kind, attributes)
      values (p_world, cr.id, coalesce(v_first, t.first_name), coalesce(v_last, t.last_name), t.nationality, t.region,
              case when v_h < 0.5 then 16 else 17 end, t.main_position, v_ovr, greatest(v_pot, v_ovr + 3), v_kind, v_attrs);
      v_new := v_new + 1;
    end loop;
  end loop;

  drop table if exists fd_tmp_ret;
  drop table if exists fd_tmp_names;
  return jsonb_build_object('retired', v_retired, 'replaced_abroad', v_replaced, 'promoted', v_promoted, 'dropped', v_dropped, 'new_youth', v_new);
end;
$$;

-- Aufruf beim Saisonwechsel (Wechsel der aktuellen Saison in die Vorbereitung); Fehler dürfen den Saisonwechsel nie blockieren
create or replace function public.fd_trg_youth_season_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform public.fd_youth_season_change(new.id, new.current_season_id);
  exception when others then
    raise warning 'Jugend/Karriereende: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists career_worlds_youth_season on public.career_worlds;
create trigger career_worlds_youth_season after update of current_season_id on public.career_worlds
  for each row when (old.current_season_id is not null and new.current_season_id is distinct from old.current_season_id and new.status = 'preseason')
  execute function public.fd_trg_youth_season_change();

-- ---------------------------------------------------------------------
-- Oberfläche (RPCs für menschliche Manager)
-- ---------------------------------------------------------------------
create or replace function public.youth_overview(p_world uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_level integer := public.fd_youth_level(v_club);
  v_status public.world_status;
begin
  select status into v_status from public.career_worlds where id = p_world;
  return jsonb_build_object(
    'level', v_level, 'max_level', 5, 'intake', public.fd_youth_intake(v_level),
    'upgrade_cost', public.fd_youth_upgrade_cost(v_level + 1),
    'balance', (select balance from public.finances where club_id = v_club),
    'status', v_status,
    'squad_size', (select count(*) from public.players p where p.club_id = v_club and not p.retired and not p.temporary),
    'levels', (select jsonb_agg(jsonb_build_object('level', l, 'intake', public.fd_youth_intake(l), 'cost', public.fd_youth_upgrade_cost(l))
                               order by l) from generate_series(1, 5) l),
    'players', coalesce((select jsonb_agg(jsonb_build_object(
        'id', y.id, 'name', trim(y.first_name || ' ' || y.last_name), 'age', y.age, 'position', y.main_position, 'overall', y.overall,
        'nationality', y.nationality,
        'stars', least(5, greatest(1, round((y.potential - 50) / 8.0)::integer)),
        'must_decide', y.age >= 19) order by y.potential desc, y.id)
      from public.youth_players y where y.club_id = v_club), '[]'::jsonb));
end;
$$;

create or replace function public.youth_upgrade(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_world public.career_worlds;
  v_level integer;
  v_cost bigint;
begin
  select * into v_world from public.career_worlds where id = p_world;
  if v_world.status <> 'preseason' then
    raise exception 'Die Jugendabteilung kann nur in der Vorbereitung ausgebaut werden.' using errcode = 'P0001', hint = 'not_preseason';
  end if;
  perform 1 from public.clubs where id = v_club for update;
  v_level := public.fd_youth_level(v_club);
  if v_level >= 5 then raise exception 'Die Jugendabteilung hat bereits die höchste Stufe.' using errcode = 'P0001', hint = 'max'; end if;
  v_cost := public.fd_youth_upgrade_cost(v_level + 1);
  perform public.post_transaction(v_club, 'youth_academy', -v_cost, 'youth:' || v_club || ':' || (v_level + 1),
    'Ausbau Jugendabteilung auf Stufe ' || (v_level + 1), v_world.current_season_id);
  insert into public.youth_academies(club_id, world_id, level) values (v_club, p_world, v_level + 1)
  on conflict (club_id) do update set level = excluded.level, updated_at = now();
  return jsonb_build_object('level', v_level + 1, 'cost', v_cost);
end;
$$;

create or replace function public.fd_youth_guard(p_youth uuid)
returns public.youth_players
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  y public.youth_players;
  v_club uuid;
begin
  select * into y from public.youth_players where id = p_youth;
  if y.id is null then raise exception 'Jugendspieler nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  v_club := public.fd_require_team(y.world_id);
  if v_club <> y.club_id then raise exception 'Das ist nicht dein Jugendspieler.' using errcode = 'P0001', hint = 'forbidden'; end if;
  return y;
end;
$$;

create or replace function public.youth_promote(p_youth uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  y public.youth_players := public.fd_youth_guard(p_youth);
  v_world public.career_worlds;
  v_id uuid;
begin
  select * into v_world from public.career_worlds where id = y.world_id;
  if y.age < 17 then raise exception 'Jugendspieler unter 17 Jahren sind noch nicht reif für den Profikader.' using errcode = 'P0001', hint = 'too_young'; end if;
  if (select count(*) from public.players p where p.club_id = y.club_id and not p.retired and not p.temporary) >= 28 then
    raise exception 'Der Profikader ist voll (28 Spieler).' using errcode = 'P0001', hint = 'squad_full';
  end if;
  v_id := public.fd_youth_promote_row(y.id, public.fd_season_year(v_world.current_season_id));
  return jsonb_build_object('player_id', v_id);
end;
$$;

create or replace function public.youth_release(p_youth uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  y public.youth_players := public.fd_youth_guard(p_youth);
begin
  delete from public.youth_players where id = y.id;
  return jsonb_build_object('released', true);
end;
$$;

do $$ declare f text; begin
  foreach f in array array['public.fd_youth_upgrade_cost(integer)', 'public.fd_youth_intake(integer)', 'public.fd_shift_attrs(jsonb, double precision)',
    'public.fd_youth_level(uuid)', 'public.fd_youth_promote_row(uuid, integer)', 'public.fd_youth_season_change(uuid, uuid)',
    'public.fd_trg_youth_season_change()', 'public.fd_youth_guard(uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.youth_overview(uuid)', 'public.youth_upgrade(uuid)', 'public.youth_promote(uuid)', 'public.youth_release(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
