-- G4: Erste Liga massiv stärker (Migration 0039)
--  A) Testwelt (nach 0039 erzeugt): Verstärkung bei der Generierung, Migration überspringt sie
--  B) Altwelt (ohne Verstärkung erzeugt, wie vor 0039): einmalige Datenmigration, Bänder, Unverändertes,
--     zweiter Lauf, Rollback, Nachrüsten einer ausländischen Erstliga
-- Variablen: world, root. Optional FULL_EUROPE=1: Altwelt mit allen Verbänden (Laufzeitmessung)
\set ON_ERROR_STOP on
\set QUIET on
begin;

-- Hilfsfunktionen (nur in dieser Sitzung)
create function pg_temp.g4_league(p_world uuid, p_tier integer)
returns table(club_id uuid, control text, xi numeric, rnk integer) language sql as $$
  select e.club_id, cl.control::text, public.fd_league1_xi(e.club_id),
         (row_number() over (order by public.fd_league1_xi(e.club_id) desc, e.club_id))::integer
  from public.competitions c join public.competition_entries e on e.competition_id = c.id
  join public.clubs cl on cl.id = e.club_id join public.career_worlds w on w.id = c.world_id
  where c.world_id = p_world and c.season_id = w.current_season_id and c.kind::text = 'league' and c.tier = p_tier
    and c.association_code = w.country_code;
$$;
create function pg_temp.g4_foreign(p_world uuid, p_code text)
returns table(club_id uuid, xi numeric, rnk integer) language sql as $$
  select c.id, public.fd_league1_xi(c.id), (row_number() over (order by public.fd_league1_xi(c.id) desc, c.id))::integer
  from public.clubs c where c.world_id = p_world and c.association_code = p_code and not c.amateur;
$$;
-- Prüfsumme über Spieler, Attribute, Potenzial (Modus: all | human | pool | Ligastufe '1'–'3')
create function pg_temp.g4_sum(p_world uuid, p_mode text)
returns text language sql as $$
  select md5(coalesce(string_agg(concat_ws('|', p.id, p.club_id, p.overall, p.market_value, p.age, p.fitness, p.main_position,
           pa.attributes::text, h.potential, h.development_points), ',' order by p.id), '')
         || case when p_mode = 'all' then coalesce((select string_agg(c.id || ':' || coalesce(c.level, 0), ',' order by c.id) from public.clubs c where c.world_id = p_world), '') else '' end)
  from public.players p left join public.player_attributes pa on pa.player_id = p.id left join public.player_hidden h on h.player_id = p.id
  where p.world_id = p_world and case p_mode
    when 'all' then true
    when 'human' then p.club_id in (select id from public.clubs where world_id = p_world and control = 'human')
    when 'pool' then p.club_id is null
    else p.club_id in (select l.club_id from pg_temp.g4_league(p_world, p_mode::integer) l) end;
$$;

-- ---------------------------------------------------------------------
-- A) Neue Welt: bei der Generierung verstärkt
-- ---------------------------------------------------------------------
select tests.assert(exists (select 1 from public.fd_league1_strength where world_id = :'world' and source = 'generation'),
  'Neue Welt: KI-Vereine der 1. Liga bei der Generierung verstärkt (Marker)');
select pg_temp.g4_sum(:'world', 'all') as a_all \gset
select tests.assert((public.fd_league1_strength_apply(:'world') ->> 'status') = 'skipped', 'Migration überspringt bereits verstärkte Welten');
select tests.assert(pg_temp.g4_sum(:'world', 'all') = :'a_all', 'Generierte Welt bleibt beim Migrationslauf unverändert');
select tests.assert((select avg(xi) from pg_temp.g4_league(:'world', 1) where rnk <= 4) >= 86.5,
  'Generierte Welt (nach einer Saison): Top 4 der 1. Liga Ø ≥ 86,5 (' || (select round(avg(xi), 2) from pg_temp.g4_league(:'world', 1) where rnk <= 4) || ')');
select tests.assert(public.fd_league1_target(92, 1, 18) = 87.9 and public.fd_league1_target(92, 18, 18) = 79.4
  and public.fd_league1_target(100, 1, 20) <= 90 and public.fd_league1_target(100, 1, 20) > public.fd_league1_target(79, 1, 18)
  and public.fd_league1_target(79, 1, 18) > public.fd_league1_target(20, 1, 12), 'Zielwerte nach Landesstärke skaliert (ENG > NED > SMR, max. 90)');

-- ---------------------------------------------------------------------
-- B) Altwelt wie vor 0039 (Verstärkung abgeschaltet erzeugen)
-- ---------------------------------------------------------------------
update public.fd_settings set value = 'off' where key = 'league1_strength';
\set u1 '00000000-0000-0000-0000-000000000f41'
\set u2 '00000000-0000-0000-0000-000000000f42'
insert into auth.users(id) values (:'u1'), (:'u2') on conflict do nothing;
set role authenticated;
select tests.login(:'u1');
select public.set_username('AltG4a') is not null as ok \gset
select tests.login(:'u2');
select public.set_username('AltG4b') is not null as ok \gset
select tests.login(:'u1');
select (public.create_world('Altwelt G4', 'medium') ->> 'world_id') as w \gset
select (select invite_code from public.career_worlds where id = :'w') as code \gset
select public.upsert_my_club(:'w', tests.club_payload('Alt Heim G4', 'AHG', 20000)) is not null as ok \gset
select public.set_ready(:'w', true) is not null as ok \gset
select tests.login(:'u2');
select public.join_world(:'code') is not null as ok \gset
select public.upsert_my_club(:'w', tests.club_payload('Alt Gast G4', 'AGG', 15000)) is not null as ok \gset
select public.set_ready(:'w', true) is not null as ok \gset
reset role;
select seed from public.career_worlds where id = :'w' \gset
select json_agg(json_build_object('id', id, 'name', name, 'short_name', short_name))::text as humans
from public.clubs where world_id = :'w' and control = 'human' \gset
\set payload `node :root/scripts/build-world-payload.mjs :'seed' :'humans'`
set role service_role;
select (public.admin_start_draft(:'w', :'u1', :'payload'::jsonb) ->> 'players') is not null as ok \gset
reset role;
select tests.assert(not exists (select 1 from public.fd_league1_strength where world_id = :'w'), 'Altwelt ohne Verstärkung erzeugt');

-- Ausländische Erstligen (Standard: ENG, NED, AUT, SMR, MDA; FULL_EUROPE=1: alle Verbände). SUI wird später nachgerüstet.
\set codes 'ENG NED AUT SMR MDA'
\getenv fe FULL_EUROPE
\if :{?fe}
  \set codes `node -e "import(process.argv[1]).then(m => console.log(m.EUROPE_ASSOCIATIONS.map(a => a.code).filter(c => c != 'SUI').join(' ')))" :root/packages/shared/dist/index.js`
\endif
select json_agg(json_build_object('name', name, 'short_name', short_name))::text as existing from public.clubs where world_id = :'w' \gset
\set g4dir /tmp/fd-g4-europe
\set built `node :root/scripts/build-europe-payload.mjs :'seed' :'existing' :g4dir :codes SUI && chmod -R a+rX :g4dir && echo ok`
select set_config('fd.g4dir', :'g4dir', false), set_config('fd.g4codes', :'codes', false), set_config('fd.g4w', :'w', false) \gset
do $$
declare c text;
begin
  foreach c in array string_to_array(current_setting('fd.g4codes'), ' ') loop
    perform public.admin_add_europe(current_setting('fd.g4w')::uuid, pg_read_file(current_setting('fd.g4dir') || '/' || c || '.json')::jsonb);
  end loop;
end $$;
select count(*) as n_players from public.players where world_id = :'w' \gset

-- Vorgeschichte: Spieler A wechselt aus der 1. Liga zu einem Menschenverein, Spieler B kam von einem Menschenverein
select id as h1 from public.clubs where world_id = :'w' and control = 'human' order by name limit 1 \gset
select l.club_id as top_club from pg_temp.g4_league(:'w', 1) l where l.rnk = 1 \gset
select l.club_id as mid_club from pg_temp.g4_league(:'w', 1) l where l.rnk = 9 \gset
select id as pa from public.players where club_id = :'top_club' order by overall desc, id limit 1 \gset
select id as pb from public.players where club_id = :'mid_club' order by overall desc, id limit 1 \gset
insert into public.transfers(world_id, player_id, from_club_id, to_club_id, kind, fee) values (:'w', :'pa', :'top_club', :'h1', 'transfer', 1000000);
update public.players set club_id = :'h1' where id = :'pa';
insert into public.transfers(world_id, player_id, from_club_id, to_club_id, kind, fee) values (:'w', :'pb', :'h1', :'mid_club', 'transfer', 500000);

-- Stand vorher
create temp table g4_before as
  select 'D'::text lg, l.club_id, l.control, l.xi, l.rnk from pg_temp.g4_league(:'w', 1) l
  union all select 'T2', l.club_id, l.control, l.xi, l.rnk from pg_temp.g4_league(:'w', 2) l
  union all select c.association_code::text, c.id, 'ai', public.fd_league1_xi(c.id),
    (row_number() over (partition by c.association_code order by public.fd_league1_xi(c.id) desc, c.id))::integer
    from public.clubs c where c.world_id = :'w' and c.association_code <> 'GER' and not c.amateur;
select pg_temp.g4_sum(:'w', 'all') as b_all, pg_temp.g4_sum(:'w', '2') as b_t2, pg_temp.g4_sum(:'w', '3') as b_t3,
       pg_temp.g4_sum(:'w', 'human') as b_hum, pg_temp.g4_sum(:'w', 'pool') as b_pool \gset
select md5(concat_ws('|', p.overall, p.market_value, pa.attributes::text)) as b_pb from public.players p join public.player_attributes pa on pa.player_id = p.id where p.id = :'pb' \gset
select (select count(*) from public.transfers where world_id = :'w') as b_transfers,
       (select md5(string_agg(concat_ws('|', id, player_id, club_id, annual_salary, end_season_year, active), ',' order by id)) from public.player_contracts where world_id = :'w') as b_contracts \gset

-- Migration (wie im SQL-Editor) mit Laufzeit
update public.fd_settings set value = 'on' where key = 'league1_strength';
select clock_timestamp() as t0 \gset
select public.fd_league1_strength_apply(:'w') as res \gset
select round(extract(epoch from clock_timestamp() - :'t0'::timestamptz) * 1000) as ms \gset
select tests.assert((:'res'::jsonb ->> 'status') = 'applied', 'Migration: ' || :n_players || ' Spieler in der Welt, ' || (:'res'::jsonb ->> 'players') || ' angepasst in ' || :ms || ' ms');

-- Bänder je Rang (Ø beste Startelf, volle Fitness)
create temp table g4_after as select l.club_id, l.control, l.xi, l.rnk from pg_temp.g4_league(:'w', 1) l;
select string_agg(rnk || ':' || round(xi, 1), ' ' order by rnk) as bands from g4_after \gset
select tests.assert((select bool_and(xi between lo and hi) from g4_after a
                     join (values (1, 4, 86.7, 88.4), (5, 7, 84.7, 87.3), (8, 10, 82.7, 85.3), (11, 14, 80.7, 83.3), (15, 18, 78.7, 81.3)) b(r1, r2, lo, hi)
                       on a.rnk between b.r1 and b.r2), 'Bänder je Rang (±0,3 Streuung): ' || :'bands');
select tests.assert((select avg(xi) from g4_after where rnk <= 4) between 87 and 88
  and (select avg(xi) from g4_after where rnk between 5 and 7) between 85 and 87
  and (select avg(xi) from g4_after where rnk between 8 and 10) between 83 and 85
  and (select avg(xi) from g4_after where rnk between 11 and 14) between 81 and 83
  and (select avg(xi) from g4_after where rnk between 15 and 18) between 79 and 81, 'Bänder im Mittel: 87–88 / 85–87 / 83–85 / 81–83 / 79–81');
select tests.assert((select array_agg(club_id order by club_id) from g4_after where rnk <= 4) = (select array_agg(club_id order by club_id) from g4_before where lg = 'D' and rnk <= 4)
  and (select max(abs(a.rnk - b.rnk)) from g4_after a join g4_before b on b.club_id = a.club_id and b.lg = 'D') <= 2,
  'Rangfolge erhalten: dieselben Top 4, kein Verein mehr als 2 Plätze verschoben (Streuung)');
select (select avg(xi) from g4_after where rnk <= 4) - (select max(xi) from pg_temp.g4_league(:'w', 2) where control = 'ai') as gap_top \gset
select tests.assert(:gap_top >= 6, 'Top 4 der 1. Liga ≥ 6 über dem besten KI-Zweitligisten (' || round(:gap_top, 2) || ')');
select (select avg(xi) from g4_after where rnk >= 15) - (select avg(xi) from (select xi from pg_temp.g4_league(:'w', 2) where control = 'ai' order by xi desc limit 5) t) as gap_low \gset
select tests.assert(:gap_low between 0 and 4.5, 'Plätze 15–18 vergleichbar mit guten Zweitligisten (Top 5): Differenz ' || round(:gap_low, 2));

-- Unverändert: 2./3. Liga, Menschen, Draft-Pool/vereinslose Spieler, Verträge, Transfers, Spieler mit Menschenbezug
select tests.assert(pg_temp.g4_sum(:'w', '2') = :'b_t2', '2. Liga bitgenau unverändert');
select tests.assert(pg_temp.g4_sum(:'w', '3') = :'b_t3', '3. Liga bitgenau unverändert');
select tests.assert(pg_temp.g4_sum(:'w', 'human') = :'b_hum', 'Menschenvereine unverändert (inkl. per Transfer gewechseltem Spieler)');
select tests.assert(pg_temp.g4_sum(:'w', 'pool') = :'b_pool', 'Draft-Pool und vereinslose Spieler unverändert');
select tests.assert((select md5(concat_ws('|', p.overall, p.market_value, pa.attributes::text)) from public.players p join public.player_attributes pa on pa.player_id = p.id where p.id = :'pb') = :'b_pb',
  'Spieler, der von einem Menschenverein kam, unverändert');
select tests.assert((select count(*) from public.transfers where world_id = :'w') = :b_transfers
  and (select md5(string_agg(concat_ws('|', id, player_id, club_id, annual_salary, end_season_year, active), ',' order by id)) from public.player_contracts where world_id = :'w') = :'b_contracts',
  'Verträge und Transfers unverändert');

-- Echte Attribute: Gesamtstärke, Marktwert, Potenzial konsistent; positionsgerecht angehoben
select tests.assert((select bool_and(p.overall = public.fd_overall(pa.kind, p.main_position::text, pa.attributes)
                                     and p.market_value = public.fd_market_value(p.overall, p.age) and h.potential >= p.overall)
                     from fd_backup.league1_0039 b join public.players p on p.id = b.player_id
                     join public.player_attributes pa on pa.player_id = p.id join public.player_hidden h on h.player_id = p.id
                     where b.world_id = :'w' and b.restored_at is null), 'Gesamtstärke = fd_overall(Attribute), Marktwert neu, Potenzial ≥ Stärke');
select tests.assert((select bool_and(pa.attributes = public.fd_league1_raise(pa.kind, p.main_position::text, b.attributes, b.di))
                     from fd_backup.league1_0039 b join public.players p on p.id = b.player_id join public.player_attributes pa on pa.player_id = p.id
                     where b.world_id = :'w' and b.restored_at is null), 'Mengenbasierte Anhebung = fd_league1_raise (TS-Spiegel league1RaiseAttributes)');
select tests.assert((select bool_and(h.potential - b.potential >= p.overall - b.overall or h.potential = 99)
                     from fd_backup.league1_0039 b join public.players p on p.id = b.player_id join public.player_hidden h on h.player_id = p.id
                     where b.world_id = :'w'), 'Luft zum Potenzial bleibt erhalten');
select avg((pa.attributes ->> 'shooting')::numeric - (b.attributes ->> 'shooting')::numeric) as st_shoot,
       avg((pa.attributes ->> 'defending')::numeric - (b.attributes ->> 'defending')::numeric) as st_def,
       avg(p.overall - b.overall) as st_ovr
from fd_backup.league1_0039 b join public.players p on p.id = b.player_id join public.player_attributes pa on pa.player_id = p.id
where b.world_id = :'w' and p.main_position = 'ST' \gset
select tests.assert(:st_shoot > :st_def and abs(:st_shoot - :st_ovr) < 0.6,
  'Positionsgerecht: Stürmer Schuss +' || round(:st_shoot, 2) || ', Verteidigen +' || round(:st_def, 2) || ' (OVR +' || round(:st_ovr, 2) || ')');
select tests.assert((select bool_and(s ->> 'overall' = p.overall::text and s -> 'attributes' = pa.attributes)
                     from jsonb_array_elements(public.fd_match_team(:'top_club', current_date, null, null) -> 'squad') s
                     join public.players p on p.id = (s ->> 'id')::uuid join public.player_attributes pa on pa.player_id = p.id),
  'Engine-Setup liefert die neuen Attribute');
select tests.assert(not exists (select 1 from fd_backup.league1_0039 b join public.clubs c on c.id = b.club_id where b.world_id = :'w' and (c.control = 'human' or c.amateur)),
  'Sicherung nur für betroffene KI-Spieler');

-- Ausländische Erstligen skaliert nach Landesstärke
create temp table g4_ftop as
  select b.lg code, (select max(f.xi) from pg_temp.g4_foreign(:'w', b.lg) f) top, max(b.xi) before
  from g4_before b where b.lg in ('ENG', 'NED', 'AUT', 'SMR', 'MDA') group by b.lg;
select string_agg(code || ' ' || round(top, 1) || ' (vorher ' || round(before, 1) || ')', ', ' order by top desc) as ftops from g4_ftop \gset
select tests.assert((select max(xi) from pg_temp.g4_foreign(:'w', 'ENG')) > (select max(xi) from pg_temp.g4_league(:'w', 1))
  and (select max(xi) from pg_temp.g4_league(:'w', 1)) > (select max(xi) from pg_temp.g4_foreign(:'w', 'NED'))
  and (select max(xi) from pg_temp.g4_foreign(:'w', 'NED')) > (select max(xi) from pg_temp.g4_foreign(:'w', 'AUT'))
  and (select max(xi) from pg_temp.g4_foreign(:'w', 'AUT')) > (select max(xi) from pg_temp.g4_foreign(:'w', 'SMR')),
  'Erstligen skaliert: ENG > GER > NED > AUT > SMR – ' || :'ftops');
select string_agg(lg || ' +' || round(d, 2), ', ' order by lg) as fgain, bool_and(d >= 2) as fok from (
  select b.lg, avg(public.fd_league1_xi(b.club_id) - b.xi) d from g4_before b where b.lg in ('ENG', 'NED', 'AUT', 'SMR', 'MDA') group by b.lg) x \gset
select tests.assert(:'fok'::boolean and (select bool_and(top > before) from g4_ftop), 'Ausländische Erstligen im Mittel ≥ 2 stärker: ' || :'fgain');

select tests.assert((select count(*) from public.clubs where world_id = :'w' and association_code = 'NED' and level = 1)
  > (select count(*) from fd_backup.league1_0039_clubs b join public.clubs c on c.id = b.club_id where b.world_id = :'w' and c.association_code = 'NED' and b.level = 1)
  and not exists (select 1 from fd_backup.league1_0039_clubs b join public.clubs c on c.id = b.club_id where c.level > b.level),
  'Virtuelle Spielklasse ausländischer Vereine folgt der neuen Stärke (nur aufwärts, gesichert)');

-- Zweiter Lauf ändert nichts
select pg_temp.g4_sum(:'w', 'all') as m_all \gset
select tests.assert((public.fd_league1_strength_apply(:'w') ->> 'status') = 'skipped', 'Zweiter Lauf: übersprungen');
select (public.fd_league1_strength_apply_all(40) ->> 'worlds') is not null as ok \gset
select tests.assert(pg_temp.g4_sum(:'w', 'all') = :'m_all', 'Zweiter Lauf (auch apply_all) ändert nichts');

-- Rollback stellt exakt her
select (public.fd_league1_strength_rollback(:'w') ->> 'restored_players')::int as restored \gset
select tests.assert(pg_temp.g4_sum(:'w', 'all') = :'b_all', 'Rollback stellt exakt her (' || :restored || ' Spieler)');
select tests.assert(not exists (select 1 from public.fd_league1_strength where world_id = :'w'), 'Rollback entfernt den Marker');
-- erneutes Anwenden nach Rollback (Sicherung wird aufgefrischt) und nochmaliger Rollback
select (public.fd_league1_strength_apply(:'w') ->> 'status') as again \gset
select tests.assert(:'again' = 'applied' and pg_temp.g4_sum(:'w', 'all') = :'m_all', 'Erneut anwenden ergibt denselben Stand');
select (public.fd_league1_strength_rollback(:'w') ->> 'restored_players') is not null as ok \gset
select tests.assert(pg_temp.g4_sum(:'w', 'all') = :'b_all', 'Zweiter Rollback ebenfalls exakt');

-- Nachgerüstete Erstliga (admin_add_europe nach 0039) wird beim Anlegen verstärkt
select pg_read_file(:'g4dir' || '/SUI.json') as sui_payload \gset
select ((:'sui_payload'::jsonb -> 'clubs' -> 0 ->> 'target_strength'))::numeric as sui_old \gset
set role service_role;
select (public.admin_add_europe(:'w', :'sui_payload'::jsonb) ->> 'status') as sui \gset
reset role;
select tests.assert(:'sui' = 'created' and (select max(xi) from pg_temp.g4_foreign(:'w', 'SUI')) > :sui_old
  and (select max(xi) from pg_temp.g4_foreign(:'w', 'SUI')) >= (select public.fd_league1_target(a.start_strength, 1, a.league_size) from public.associations a where a.code = 'SUI') - 0.5,
  'Neu angelegte Erstliga (SUI) beim Anlegen verstärkt: ' || (select round(max(xi), 1) from pg_temp.g4_foreign(:'w', 'SUI')) || ' statt ' || :sui_old);

rollback;
\echo '>>> G4_league1_strength: alle Prüfungen bestanden'
