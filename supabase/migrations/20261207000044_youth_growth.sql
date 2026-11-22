-- Jugendentwicklung verbessert: Talente starten mit 16 (OVR ca. 30–45), wachsen pro Jahr um 60 % der Lücke zum Potenzial und sind mit 18
-- typischerweise bei OVR 65–79 (KI-Standardstufe 2: ca. 72; Stufe 1: ca. 68; Stufe 5: ca. 84). Danach übernimmt die normale Entwicklung/das Training.
-- Potenzial: 71 + 4 × Stufe ± 9 (Stufe 1: 75, Stufe 5: 91). Nur die Funktion wird ersetzt; vorhandene Jugendspieler und alle anderen Daten bleiben unverändert.
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
    select id, public.fd_shift_attrs(attributes, ceil(greatest(0, potential - overall) * 0.6)) as a from public.youth_players where world_id = p_world)
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
      v_pot := least(96, greatest(55, round(71 + 4 * public.fd_youth_level(cr.id) + (public.fd_hash01(cr.id::text || v_i || ':pot') - 0.5) * 18)::integer));
      select pa.kind, public.fd_shift_attrs(pa.attributes, (v_pot - 40 - floor(v_h * 5)) - t.overall) into v_kind, v_attrs
        from public.player_attributes pa where pa.player_id = t.id;
      continue when v_attrs is null;
      v_ovr := public.fd_overall(v_kind, t.main_position::text, v_attrs);
      select n.first_name into v_first from fd_tmp_names n where n.nationality = t.nationality and n.rn = 1 + floor(public.fd_hash01(cr.id::text || v_i || ':fn') * n.cnt)::integer limit 1;
      select n.last_name into v_last from fd_tmp_names n where n.nationality = t.nationality and n.rn = 1 + floor(public.fd_hash01(cr.id::text || v_i || ':ln') * n.cnt)::integer limit 1;
      insert into public.youth_players(world_id, club_id, first_name, last_name, nationality, region, age, main_position, overall, potential, kind, attributes)
      values (p_world, cr.id, coalesce(v_first, t.first_name), coalesce(v_last, t.last_name), t.nationality, t.region,
              16, t.main_position, v_ovr, greatest(v_pot, v_ovr + 3), v_kind, v_attrs);
      v_new := v_new + 1;
    end loop;
  end loop;

  drop table if exists fd_tmp_ret;
  drop table if exists fd_tmp_names;
  return jsonb_build_object('retired', v_retired, 'replaced_abroad', v_replaced, 'promoted', v_promoted, 'dropped', v_dropped, 'new_youth', v_new);
end;
$$;


revoke execute on function public.fd_youth_season_change(uuid, uuid) from public, anon, authenticated;
notify pgrst, 'reload schema';
