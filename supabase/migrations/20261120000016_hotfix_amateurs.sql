-- =====================================================================
-- Migration 0016: Hotfix Saisonstart mit europaweitem Spielerpool
-- fd_ensure_amateurs zog Namen und Attribute für die Amateurvereine mit vielen Sortierungen über
-- ALLE Spieler der Welt. Mit ~18.000 Spielern (Europa) überschritt der erste Saisonstart das
-- Zeitlimit („canceling statement due to statement timeout“). Neu: Quelle nur deutsche Vereine,
-- eine Sortierung je Verein, Namen per Index. Ergebnis und Ablauf bleiben gleich.
-- =====================================================================
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
    insert into public.finances(club_id, world_id, balance) values (v_club, p_world, 2000000);
    perform public.fd_init_club_tactics(p_world, v_club, '4-4-2');
    v_need := v_need - 1;
    v_n := v_n + 1;
  end loop;
end;
$$;

