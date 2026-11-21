-- Trainingsplan, Verhandlungen, KI-Transfermarkt, Free-Agent-Limit, Top-Transfers, Kalender, Wetter
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select current_season_id as season, current_week as week from public.career_worlds where id = :'world' \gset

-- Trainingsplan: max. 5, dauerhaft, je Woche genau einmal, Pausieren
select array_to_string(array(select p.id from public.players p where p.club_id = :'host_club' order by p.overall limit 6), ',') as six \gset
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.save_training_plan(%L, true, (select jsonb_agg(jsonb_build_object('player_id', x, 'focus', 'technique')) from unnest(string_to_array(%L, ',')) x)) $$, :'world', :'six'), 'training_limit');
select public.save_training_plan(:'world', true, (select jsonb_agg(jsonb_build_object('player_id', x, 'focus', 'physical', 'paused', i = 4)) from unnest((string_to_array(:'six', ','))[1:4]) with ordinality u(x, i)));
select tests.assert(jsonb_array_length(public.training_plan(:'world') -> 'entries') = 4, 'Plan gespeichert');
reset role;
delete from public.training_plan_runs where club_id = :'host_club';
delete from public.training_sessions where club_id = :'host_club' and season_id = :'season' and week_no = :'week';
select public.fd_run_training_plan(:'host_club') as run \gset
select tests.assert((:'run'::jsonb ->> 'executed')::int = 3, 'drei aktive Spieler trainiert (einer pausiert)');
select tests.assert(public.fd_run_training_plan(:'host_club') is null, 'nie doppelt in derselben Woche');
select tests.assert((select count(*) from public.training_sessions where club_id = :'host_club' and season_id = :'season' and week_no = :'week' and auto) = 3, 'Einheiten automatisch angelegt');
set role authenticated;
select tests.login(:'host');
select tests.assert(jsonb_array_length(public.training_plan(:'world') -> 'last_run' -> 'sessions') = 3, 'letzte Durchführung sichtbar');
select public.save_training_plan(:'world', false, public.training_plan(:'world') -> 'entries');
reset role;
select tests.assert(not (select active from public.training_plans where club_id = :'host_club'), 'Plan deaktivierbar');

-- Verhandlung über drei Runden (Fenster öffnen, falls nötig)
select public.fd_ensure_windows(:'world');
select (public.fd_open_window(:'world')).id is not null as win_open \gset
\if :win_open
\else
update public.transfer_windows set next_matchday_to = 34 where season_id = :'season' and window_no = 1;
\endif
select public.post_transaction(:'host_club', 'adjustment', 150000000, 'test:boost98', 'Testgeld');
select p.id as tgt, p.market_value as mv from public.players p join public.clubs c on c.id = p.club_id
where c.world_id = :'world' and c.control = 'ai' and not c.amateur and (select count(*) from public.players x where x.club_id = c.id) > 22
  and not exists (select 1 from public.transfer_offers o where o.player_id = p.id) order by p.market_value desc offset 5 limit 1 \gset
select public.fd_ai_valuation(:'tgt') as val \gset
set role authenticated;
select tests.login(:'host');
select public.make_transfer_offer(:'tgt', (:val * 0.85)::bigint, 5000000, 3) as o1 \gset
reset role;
select tests.assert(:'o1'::jsonb ->> 'status' = 'pending', 'Zögern bei unattraktivem Angebot');
select (:'o1'::jsonb ->> 'offer') as oid \gset
select tests.assert((select next_response_on - public.fd_world_date(:'world') from public.transfer_offers where id = :'oid') = 7, 'Antwort frühestens nach einer Woche');
select tests.assert(public.fd_offers_process(:'world') = 0, 'keine Antwort vor dem Termin');
update public.transfer_offers set next_response_on = public.fd_world_date(:'world') where id = :'oid';
select public.fd_offers_process(:'world');
select tests.assert((select status::text from public.transfer_offers where id = :'oid') = 'countered', 'Gegenangebot nach einer Woche');
select counter_fee as c1 from public.transfer_offers where id = :'oid' \gset
set role authenticated;
select tests.login(:'host');
select tests.assert(public.renegotiate_offer(:'oid', (:val * 0.9)::bigint) ->> 'status' = 'pending', 'Runde 2: neues Angebot');
reset role;
update public.transfer_offers set next_response_on = public.fd_world_date(:'world') where id = :'oid';
select public.fd_offers_process(:'world');
select tests.assert((select status::text = 'countered' and round = 2 and counter_fee <= :c1 from public.transfer_offers where id = :'oid'), 'Forderung sinkt');
set role authenticated;
select tests.login(:'host');
select public.renegotiate_offer(:'oid', (:val * 0.9)::bigint + 50000);
reset role;
update public.transfer_offers set next_response_on = public.fd_world_date(:'world') where id = :'oid';
select public.fd_offers_process(:'world');
select tests.assert((select status::text in ('completed', 'rejected', 'countered') and round = 3 from public.transfer_offers where id = :'oid'), 'Runde 3: Einigung oder Abbruch');
select tests.assert((select status::text <> 'pending' from public.transfer_offers where id = :'oid'), 'nach der letzten Runde entschieden');
set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.renegotiate_offer(%L, 1) $$, :'oid'), case when (select status::text from public.transfer_offers where id = :'oid') = 'countered' then 'negotiation_over' else 'not_countered' end);
select tests.assert(jsonb_array_length(public.my_negotiations(:'world')) >= 1, 'Verhandlungen sichtbar');
-- Sehr attraktives Angebot: sofort angenommen, Ablöse genau einmal gebucht
select p.id as tgt2 from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.control = 'ai' and not c.amateur
  and (select count(*) from public.players x where x.club_id = c.id) > 22 and not exists (select 1 from public.transfer_offers o where o.player_id = p.id) order by p.overall desc offset 30 limit 1 \gset
reset role;
select public.fd_ai_valuation(:'tgt2') as val2, (select balance from public.finances where club_id = :'host_club') as bal0 \gset
set role authenticated;
select tests.login(:'host');
select public.make_transfer_offer(:'tgt2', (:val2 * 1.3)::bigint, 9000000, 3) as o2 \gset
reset role;
select tests.assert(:'o2'::jsonb ->> 'status' in ('completed', 'rejected'), 'sofortige Annahme (oder Limit)');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'host_club' and kind = 'transfer_fee_paid' and description like '%' || (select first_name || ' ' || last_name from public.players where id = :'tgt2')) <= 1, 'Ablöse höchstens einmal gebucht');

-- KI-Transfermarkt: Angebote zwischen KI-Vereinen, gleiche Limits
select set_config('fd.world', :'world', false);
delete from public.ai_transfer_log where world_id = :'world';
select public.fd_ai_transfer_batch(:'world', 1000) as left_ \gset
select tests.assert(:left_ = 0, 'alle KI-Vereine geprüft');
-- Seit 0030 handeln nur Vereine mit Spielbetrieb (aktive Länder + Europapokal) aktiv: mehrere Wochen prüfen
select current_week as week_now from public.career_worlds where id = :'world' \gset
do $$
declare i integer;
begin
  for i in 1..30 loop
    exit when exists (select 1 from public.transfer_offers o join public.clubs b on b.id = o.to_club_id join public.clubs s on s.id = o.from_club_id
                      where o.world_id = current_setting('fd.world')::uuid and b.control = 'ai' and s.control = 'ai');
    update public.career_worlds set current_week = current_week + 1 where id = current_setting('fd.world')::uuid;
    perform public.fd_ai_transfer_batch(current_setting('fd.world')::uuid, 1000);
  end loop;
end $$;
update public.career_worlds set current_week = :week_now where id = :'world';
select tests.assert((select count(*) from public.transfer_offers o join public.clubs b on b.id = o.to_club_id join public.clubs s on s.id = o.from_club_id
                     where o.world_id = :'world' and b.control = 'ai' and s.control = 'ai') > 0, 'KI-Vereine verhandeln untereinander');
update public.transfer_offers set next_response_on = public.fd_world_date(:'world') where world_id = :'world' and status = 'pending' and next_response_on is not null;
select public.fd_offers_process(:'world');
select public.fd_offers_process(:'world');
select tests.assert((select max(n) from (select count(*) n from public.transfers t join public.transfer_windows w on w.id = t.window_id
                     where w.season_id = :'season' and t.kind in ('transfer', 'free_agent') group by t.window_id, t.to_club_id) x) <= 5, 'max. 5 Neuzugänge je Fenster');
select tests.assert(not exists (select 1 from public.transfers group by player_id, window_id, from_club_id having count(*) > 1), 'keine doppelten Transfers');

-- Free Agents: KI bewirbt sich, Limit 2 je Saison
delete from public.world_week_log where world_id = :'world';
select public.fd_ai_fa_interest(:'world') as fai \gset
select tests.assert((select count(*) from public.fa_applications a join public.clubs c on c.id = a.club_id where a.world_id = :'world' and c.control = 'ai' and a.status = 'pending') = :fai, 'KI-Bewerbungen');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and public.fd_fa_signings(c.id, :'season') > 2), 'höchstens zwei Free Agents je Saison');
update public.free_agents set decision_on = public.fd_world_date(:'world') where world_id = :'world' and decision_on is not null;
select public.fd_fa_process(:'world');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and public.fd_fa_signings(c.id, :'season') > 2), 'Limit auch nach Entscheidungen');
select tests.assert(not exists (select 1 from public.fa_applications where status = 'signed' group by player_id having count(*) > 1), 'ein Vertrag je Spieler');

-- Anzeigen
set role authenticated;
select tests.login(:'host');
select tests.assert(public.fa_overview(:'world') -> 'limit' ->> 'max' = '2', 'Free-Agent-Limit angezeigt');
select tests.assert(jsonb_typeof(public.top_transfers(:'world', 'world', 1) -> 'rows') = 'array', 'Top-Transfers Welt');
select tests.assert((select bool_and((r ->> 'fee')::bigint > 0) from jsonb_array_elements(public.top_transfers(:'world', 'world', 1) -> 'rows') r) is not false, 'nur Ablösetransfers');
select tests.assert(jsonb_array_length(public.season_calendar(:'world') -> 'fixtures') > 30, 'Saisonkalender');
select tests.assert(public.world_theme(:'world') ->> 'kind' = 'league', 'Theme aus eigener Liga');
reset role;
select f.id as wfx from public.fixtures f where f.world_id = :'world' order by f.scheduled_date desc limit 1 \gset
select tests.assert(public.fd_weather(:'wfx') in ('sunny', 'cloudy', 'rain', 'heavy_rain', 'snow', 'fog'), 'Wetter bestimmt');
select tests.assert(public.fd_weather(:'wfx') = public.fd_weather(:'wfx'), 'Wetter deterministisch');
select tests.assert(position('fd_weather' in pg_get_functiondef('public.admin_match_setup(uuid)'::regprocedure)) > 0, 'Wetter und Atmosphäre im Match-Setup');
select tests.assert(public.fd_atmosphere(:'wfx') ? 'choreo', 'Atmosphäre bestimmt');

-- Fenster zu: laufende Verhandlungen verfallen
update public.transfer_windows set next_matchday_from = 99, next_matchday_to = 99 where season_id = :'season';
select public.fd_offers_process(:'world');
select tests.assert(not exists (select 1 from public.transfer_offers where world_id = :'world' and status in ('pending', 'countered')), 'geschlossenes Fenster beendet Verhandlungen');
\echo '>>> 98_transfers_training: Trainingsplan, Verhandlungen, KI-Markt und Free Agents funktionieren'
