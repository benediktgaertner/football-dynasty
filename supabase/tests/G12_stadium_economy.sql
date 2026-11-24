-- G12: Stadion bis 80.000, Zuschauermodell, Ausbaukosten und Break-even (Migration 0049). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select c.id as hclub from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset
select count(*) as n_stadiums, coalesce(sum(capacity), 0) as sum_cap from public.stadiums st join public.clubs c on c.id = st.club_id where c.world_id = :'world' \gset
begin;

-- Bausteine
select tests.assert(public.fd_stadium_expansion_step_cost(30000) = 4100000 and public.fd_stadium_expansion_step_cost(75000) = 5450000, 'Ausbaukosten: 3,2 Mio. € + 30 € je vorhandenem Platz');
select tests.assert(public.fd_stadium_expansion_step_cost(70000) > public.fd_stadium_expansion_step_cost(20000), 'größere Arenen kosten absolut mehr');
select tests.assert(public.fd_stadium_running_cost(80000) > public.fd_stadium_running_cost(50000) and public.fd_stadium_running_cost(50000) > public.fd_stadium_running_cost(30000), 'Betriebskosten wachsen mit der Größe');
select tests.assert(public.fd_stadium_running_cost(20000) = 40000, 'kleine Stadien: Betriebskosten wie bisher (2 € je Platz)');
select tests.assert(public.fd_soft_attendance(40000, 20000) = 20000, 'Zuschauer = Nachfrage bei geringer Auslastung');
select tests.assert(public.fd_soft_attendance(40000, 90000) < 40000 and public.fd_soft_attendance(40000, 90000) > 37000, 'Zuschauer nie über Kapazität, bei Überhang fast voll');
select tests.assert(public.fd_soft_attendance(60000, 20000) = public.fd_soft_attendance(40000, 20000), 'ein größeres Stadion bringt bei gleicher Nachfrage nicht mehr Zuschauer');
select tests.assert(public.fd_catering_income(30000, 25) = 210000, 'Gastronomie: 28 % des Ticketpreises je Zuschauer');
select tests.assert(position('fd_catering_income' in pg_get_functiondef('public.fd_release_slot(uuid)'::regprocedure)) > 0 and position('fd_stadium_running_cost' in pg_get_functiondef('public.fd_release_slot(uuid)'::regprocedure)) > 0, 'Terminfreigabe bucht Gastronomie und neue Betriebskosten');
select tests.expect_error($$ update public.stadiums set capacity = 85000 where club_id = (select id from public.clubs limit 1) $$, 'check');
select tests.assert(public.fd_finance_group('catering_income', '', 5) = 'ticket_sales', 'Gastronomie zählt im Dashboard zu Tickets');

-- Prognose: ausgelastete Stadien amortisieren sich im Lauf der zweiten Saison (Standard-Ticketpreis 25 €)
create temp table g12_q(rep numeric, cap int, demand numeric, extra numeric, net numeric, cost bigint, pb numeric, verdict text);
grant all on g12_q to authenticated;
select set_config('fd.w', :'world', false), set_config('fd.u', :'host', false), set_config('fd.h', :'hclub', false);
do $$
declare c integer; r numeric; q jsonb;
begin
  foreach r in array array[55, 75, 100] loop
    foreach c in array array[10000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 70000, 75000] loop
      update public.clubs set reputation = r where id = current_setting('fd.h')::uuid;
      update public.stadiums set capacity = c, ticket_price_league = 25 where club_id = current_setting('fd.h')::uuid;
      perform set_config('request.jwt.claims', json_build_object('sub', current_setting('fd.u'))::text, true);
      set local role authenticated;
      q := public.stadium_expansion_quote(current_setting('fd.w')::uuid);
      reset role;
      insert into g12_q values (r, c, (q ->> 'demand')::numeric, (q ->> 'extra_attendance')::numeric, (q ->> 'annual_net')::numeric, (q ->> 'cost')::bigint, (q ->> 'payback_years')::numeric, q ->> 'verdict');
    end loop;
  end loop;
end $$;
select tests.assert((select count(*) from g12_q where extra >= 4000) > 5, 'Prognose: mehrere voll genutzte Ausbauten getestet (' || (select count(*) from g12_q where extra >= 4000) || ')');
select tests.assert(not exists (select 1 from g12_q where extra >= 4000 and (pb <= 1.0 or pb > 2.0)), 'voll genutzter Ausbau: Break-even im Lauf der zweiten Saison (1–2 Jahre): '
  || coalesce((select string_agg(rep || '/' || cap || '=' || pb, ', ') from g12_q where extra >= 4000 and (pb <= 1.0 or pb > 2.0)), 'ok'));
select tests.assert(not exists (select 1 from g12_q where extra >= 2000 and pb <= 1.0), 'kein Ausbau amortisiert sich bereits in der ersten Saison');
select tests.assert(not exists (select 1 from g12_q where demand <= cap and verdict <> 'not_profitable'), 'Stadion größer als die Nachfrage: wirtschaftlich nicht sinnvoll');
select tests.assert(exists (select 1 from g12_q where verdict = 'not_profitable') and exists (select 1 from g12_q where verdict = 'second_season'), 'Prognose unterscheidet sinnvolle und sinnlose Ausbauten');
select tests.assert(not exists (select 1 from g12_q where cost > 6000000), 'Einzelausbau bleibt unter 6 Mio. €');

-- Große Arenen (Erstligist mit Spitzenruf): dieselbe Rechnung wie die Prognose, direkt mit den Bausteinen
create temp table g12_big(cap int, extra numeric, net numeric, cost bigint, pb numeric);
do $$
declare c integer; t1 uuid; d numeric; a0 numeric; a1 numeric; net numeric; sid uuid := (select current_season_id from public.career_worlds where id = current_setting('fd.w')::uuid);
begin
  select cl.id into t1 from public.clubs cl where cl.world_id = current_setting('fd.w')::uuid and cl.control = 'ai' and not cl.amateur and public.fd_tier_of(cl.id, sid) = 1 order by cl.id limit 1;
  update public.clubs set reputation = 100 where id = t1;
  d := public.fd_stadium_demand(t1, sid, 'league', 25, 50, 1, 1);
  foreach c in array array[30000, 35000, 40000, 45000, 50000, 55000, 60000, 70000] loop
    a0 := public.fd_soft_attendance(c, d); a1 := public.fd_soft_attendance(c + 5000, d);
    net := (a1 - a0) * (25 * 1.28 + 2.4) * 19 - (public.fd_stadium_running_cost(c + 5000) - public.fd_stadium_running_cost(c)) * 19;
    insert into g12_big values (c, a1 - a0, net, public.fd_stadium_expansion_step_cost(c), case when net > 0 then public.fd_stadium_expansion_step_cost(c) / net end);
  end loop;
end $$;
select tests.assert((select count(*) from g12_big where extra >= 4000) >= 3, 'Großarena-Szenarien mit voller Nutzung vorhanden (' || (select count(*) from g12_big where extra >= 4000) || ')');
select tests.assert(not exists (select 1 from g12_big where extra >= 4000 and (pb <= 1.0 or pb > 2.0)), 'Großarena (30.000–45.000, Nachfrage > Kapazität): Break-even in Saison 2: '
  || coalesce((select string_agg(cap || '=' || round(pb, 2), ', ') from g12_big where extra >= 4000 and (pb <= 1.0 or pb > 2.0)), 'ok'));
select tests.assert((select pb from g12_big where cap = 30000) < (select pb from g12_big where cap = 50000), 'je größer das Stadion, desto länger der Break-even (abnehmender Zusatznutzen)');
select tests.assert((select net from g12_big where cap = 70000) < 0.5 * (select net from g12_big where cap = 30000), 'Ausbau über die Nachfrage hinaus lohnt kaum noch');

-- Echte Zuschauerfunktion über die Heimspiele einer Saison: Break-even nach Saisons (Ticket + Gastronomie + Fanshop − Betrieb)
-- Ausgangsgröße je nach Spielklasse des Hostvereins so gewählt, dass die Nachfrage das erweiterte Stadion füllt
create temp table g12_sim(cap int, per_season numeric);
do $$
declare c0 integer; c integer; f record; tot numeric; d numeric; sid uuid := (select current_season_id from public.career_worlds where id = current_setting('fd.w')::uuid);
begin
  update public.clubs set reputation = 100 where id = current_setting('fd.h')::uuid;
  update public.stadiums set ticket_price_league = 25 where club_id = current_setting('fd.h')::uuid;
  d := public.fd_stadium_demand(current_setting('fd.h')::uuid, sid, 'league', 25, 50, 1, 1);
  c0 := greatest(10000, least(70000, (floor((d / 1.3 - 5000) / 5000) * 5000)::int));
  foreach c in array array[c0, c0 + 5000] loop
    update public.stadiums set capacity = c where club_id = current_setting('fd.h')::uuid;
    tot := 0;
    for f in select fx.id from public.fixtures fx join public.competitions co on co.id = fx.competition_id
             where fx.home_club_id = current_setting('fd.h')::uuid and fx.season_id = sid and co.kind::text = 'league' loop
      tot := tot + public.fd_expected_attendance(f.id) * (25 * 1.28 + 2.4) - public.fd_stadium_running_cost(c);
    end loop;
    insert into g12_sim values (c, tot);
  end loop;
end $$;
select min(cap) as c0 from g12_sim \gset
select (select per_season from g12_sim where cap = :c0 + 5000) - (select per_season from g12_sim where cap = :c0) as dnet \gset
select tests.assert(:dnet > 0 and public.fd_stadium_expansion_step_cost(:c0) / :dnet between 1.0 and 2.4, 'echte Heimspiele: Mehrertrag deckt Ausbau (' || :c0 || ' → ' || (:c0 + 5000) || ') in ' || round(public.fd_stadium_expansion_step_cost(:c0) / :dnet, 2) || ' Saisons');
select tests.assert(public.fd_stadium_expansion_step_cost(:c0) / :dnet > 1.0, 'nach Saison 1 noch nicht amortisiert');

-- Heimvorteil bleibt im Rahmen
select fx.id as fxid from public.fixtures fx where fx.home_club_id = :'hclub' and fx.season_id = :'season' order by fx.scheduled_date limit 1 \gset
update public.stadiums set capacity = 80000 where club_id = :'hclub';
select tests.assert(public.fd_home_advantage(:'fxid') between 0 and 0.04, 'Heimvorteil im 80.000er-Stadion begrenzt (' || public.fd_home_advantage(:'fxid') || ')');
select tests.assert(public.fd_expected_attendance(:'fxid') <= 80000, 'Zuschauer nie über 80.000');

-- Ausbau: Kosten, Maximum, Zeitpunkt
update public.career_worlds set status = 'preseason' where id = :'world';
update public.stadiums set capacity = 75000 where club_id = :'hclub';
update public.finances set balance = 50000000 where club_id = :'hclub';
select balance as bal0 from public.finances where club_id = :'hclub' \gset
select economy_factor as eco from public.career_worlds where id = :'world' \gset
set role authenticated;
select tests.login(:'host');
select (public.expand_stadium(:'world') ->> 'capacity')::int as newcap \gset
reset role;
select tests.assert(:newcap = 80000 and (select capacity from public.stadiums where club_id = :'hclub') = 80000, 'Ausbau auf 80.000 möglich');
select tests.assert((select balance from public.finances where club_id = :'hclub') = :bal0 - public.fd_scaled(5450000, :eco), 'Ausbaukosten abgebucht (5,45 Mio. €, mit Wirtschaftsfaktor)');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.expand_stadium(%L) $$, :'world'), 'max');
select tests.assert(public.stadium_expansion_quote(:'world') ->> 'max' = 'true', 'Prognose bei 80.000: Maximum erreicht');
reset role;
update public.career_worlds set status = 'season' where id = :'world';
update public.stadiums set capacity = 30000 where club_id = :'hclub';
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.expand_stadium(%L) $$, :'world'), 'not_preseason');
reset role;
rollback;

-- Bestand unverändert (Migration ändert keine vorhandenen Stadien)
select tests.assert((select count(*) from public.stadiums st join public.clubs c on c.id = st.club_id where c.world_id = :'world') = :n_stadiums and
  (select coalesce(sum(capacity), 0) from public.stadiums st join public.clubs c on c.id = st.club_id where c.world_id = :'world') = :sum_cap, 'bestehende Stadien und Kapazitäten unverändert');
\echo 'OK G12'
