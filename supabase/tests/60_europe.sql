-- Europaweiter Transfermarkt: Aufbau (idempotent), Suche/Filter, internationale Transfers, Gehälter
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'

select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select count(*) as clubs_before from public.clubs where world_id = :'world' \gset
select count(*) as ger_players_before from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.association_code = 'GER' \gset
select count(*) as fa_before from public.free_agents where world_id = :'world' \gset
select balance as host_balance_before from public.finances where club_id = :'host_club' \gset

\set eng `cat :dir/ENG.json`
\set ita `cat :dir/ITA.json`
\set smr `cat :dir/SMR.json`
set role service_role;
select tests.assert((public.admin_add_europe(:'world', :'eng'::jsonb) ->> 'status') = 'created', 'England angelegt');
select tests.assert((public.admin_add_europe(:'world', :'ita'::jsonb) ->> 'status') = 'created', 'Italien angelegt');
select tests.assert((public.admin_add_europe(:'world', :'smr'::jsonb) ->> 'status') = 'created', 'San Marino angelegt');
select tests.assert((public.admin_add_europe(:'world', :'eng'::jsonb) ->> 'status') = 'exists', 'erneuter Aufruf ändert nichts (idempotent)');
select tests.assert(jsonb_array_length(public.admin_europe_status(:'world') -> 'done') = 3, 'Status kennt drei Verbände');
-- Payload mit veralteter Namensliste (gleichzeitiger Aufruf): Konflikte werden aufgelöst, alles eindeutig
\set por `cat :dir/stale/POR.json`
select tests.assert((public.admin_add_europe(:'world', :'por'::jsonb) ->> 'status') = 'created', 'Portugal trotz veralteter Namensliste angelegt');
select tests.assert(not exists (select 1 from public.clubs where world_id = :'world' group by short_name_normalized having count(*) > 1), 'Kürzel bleiben eindeutig');
reset role;

select tests.assert((select count(*) from public.clubs where world_id = :'world') = :clubs_before + 68, '68 neue Vereine (20 + 20 + 10 + 18)');
select tests.assert((select count(*) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = :'world' and c.association_code = 'GER') = :ger_players_before, 'deutsche Kader unverändert');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code <> 'GER'
  and (select count(*) from public.players p where p.club_id = c.id) <> 22), 'jeder ausländische Verein hat 22 Spieler');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code <> 'GER'
  and not exists (select 1 from public.club_branding b where b.club_id = c.id)), 'Wappen/Farben für alle');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.association_code <> 'GER'
  and exists (select 1 from public.competition_entries e where e.club_id = c.id)), 'ausländische Vereine stören die deutschen Ligen nicht');
select tests.assert((select count(*) from public.free_agents where world_id = :'world') = :fa_before + 14, 'neue vereinslose Spieler (4 + 4 + 2 + 4)');
select tests.assert((select public.fd_tier_of(c.id, w.current_season_id) from public.clubs c join public.career_worlds w on w.id = c.world_id
  where c.world_id = :'world' and c.association_code = 'ENG' order by c.reputation desc limit 1) = 1, 'englischer Spitzenclub = Spielklasse 1');

-- Suche und Filter
set role authenticated;
select tests.login(:'host');
select (public.transfer_market_search(:'world', '{}'::jsonb, 20, 0)) as all_res \gset
select tests.assert((:'all_res'::jsonb ->> 'total')::int > 1000, 'Gesamtpool über alle Länder');
select tests.assert(jsonb_array_length(:'all_res'::jsonb -> 'rows') = 20, 'Seitengröße');
select tests.assert(not exists (select 1 from jsonb_array_elements(:'all_res'::jsonb -> 'rows') r where r -> 'club' ->> 'id' = :'host_club'), 'eigene Spieler ausgeblendet');
select tests.assert((select bool_and(r -> 'club' ->> 'association_code' = 'ENG') from jsonb_array_elements(public.transfer_market_search(:'world', '{"country":"ENG"}'::jsonb, 100, 0) -> 'rows') r), 'Filter Land');
select tests.assert((public.transfer_market_search(:'world', '{"league":"ITA"}'::jsonb, 1, 0) ->> 'total')::int = 440, 'Filter Liga (20 × 22)');
select tests.assert((public.transfer_market_search(:'world', '{"league":"GER1"}'::jsonb, 1, 0) ->> 'total')::int > 300, 'Filter deutsche Liga');
select tests.assert((select bool_and((r ->> 'main_position') = 'GK' and (r ->> 'age')::int between 20 and 30 and (r ->> 'overall')::int >= 60 and (r ->> 'market_value')::bigint <= 30000000)
  from jsonb_array_elements(public.transfer_market_search(:'world', '{"position":"GK","min_age":20,"max_age":30,"min_overall":60,"max_value":30000000}'::jsonb, 100, 0) -> 'rows') r), 'Filter Position/Alter/Stärke/Marktwert');
select (select c.id from public.clubs c where c.world_id = :'world' and c.association_code = 'SMR' order by c.name limit 1) as smr_club \gset
select tests.assert((public.transfer_market_search(:'world', jsonb_build_object('club', :'smr_club'), 50, 0) ->> 'total')::int = 22, 'Filter Verein');
select tests.assert((select bool_and(r -> 'club' = 'null'::jsonb) from jsonb_array_elements(public.transfer_market_search(:'world', '{"free_agents":true}'::jsonb, 100, 0) -> 'rows') r), 'nur Vereinslose');
select tests.assert((select (r ->> 'market_value')::bigint from jsonb_array_elements(public.transfer_market_search(:'world', '{"sort":"value"}'::jsonb, 1, 0) -> 'rows') r)
  = (select max(p.market_value) from public.players p left join public.clubs c on c.id = p.club_id where p.world_id = :'world' and c.id is distinct from :'host_club'::uuid and not coalesce(c.amateur, false) and (c.id is not null or exists (select 1 from public.free_agents fa where fa.player_id = p.id))), 'Sortierung Marktwert');
select tests.assert(jsonb_array_length(public.transfer_market_options(:'world') -> 'countries') = 5, 'Optionen: 5 Länder');
select tests.assert(jsonb_array_length(public.transfer_market_options(:'world') -> 'leagues') >= 6, 'Optionen: Ligen');
reset role;
select tests.login(null);
set role authenticated;
select tests.login('00000000-0000-0000-0000-00000000dead');
select tests.expect_error(format($$ select public.transfer_market_search(%L, '{}'::jsonb, 10, 0) $$, :'world'), 'forbidden');
reset role;

-- Internationaler Kauf: Spieler aus England zum deutschen Verein
select p.id as eng_player, p.market_value as eng_value from public.players p join public.clubs c on c.id = p.club_id
where c.world_id = :'world' and c.association_code = 'ENG' and p.overall between 70 and 80 order by p.overall desc limit 1 \gset
select public.post_transaction(:'host_club', 'adjustment', greatest(0, 500000000 - balance), 'test:eu:topup', 'Test: Guthaben', null, true) from public.finances where club_id = :'host_club';
-- sicher über der Annahmeschwelle (≥ 1,15 × KI-Bewertung); 1,5 × Marktwert reicht bei Stammspielern nicht immer
select greatest((:eng_value * 1.5)::bigint, (public.fd_ai_valuation(:'eng_player') * 1.2)::bigint) as eng_fee \gset
set role authenticated;
select tests.login(:'host');
select public.make_transfer_offer(:'eng_player', :eng_fee, 20000000, 3) as eng_deal \gset
reset role;
select tests.assert((:'eng_deal'::jsonb ->> 'status') = 'completed', 'Transfer aus England abgeschlossen: ' || (:'eng_deal'::jsonb ->> 'message'));
select tests.assert((select club_id from public.players where id = :'eng_player') = :'host_club', 'Spieler gehört jetzt dem deutschen Verein');
select tests.assert(exists (select 1 from public.transfers t where t.player_id = :'eng_player' and t.to_club_id = :'host_club'), 'Transfer protokolliert');

-- Internationaler Verkauf: KI-Käufer kann ein ausländischer Verein sein
select p.id as cheap from public.players p where p.club_id = :'host_club' and p.id <> :'eng_player' order by p.overall limit 1 \gset
select count(public.post_transaction(f.club_id, 'adjustment', 1 - f.balance, 'test:eu:drain:' || f.club_id, 'Test: Konto leeren', null, true))
from public.finances f join public.clubs c on c.id = f.club_id where c.world_id = :'world' and c.association_code = 'GER' and c.control = 'ai';
set role authenticated;
select tests.login(:'host');
select public.sell_to_ai(:'cheap') as sale \gset
reset role;
select tests.assert((:'sale'::jsonb ->> 'status') = 'completed', 'Verkauf ins Ausland: ' || (:'sale'::jsonb ->> 'message'));
select tests.assert((select c.association_code from public.players p join public.clubs c on c.id = p.club_id where p.id = :'cheap') <> 'GER', 'Käufer ist ausländisch');

-- Hängende Freigabe nachholen: Mitglieder dürfen, Fremde nicht; ohne offenen Termin passiert nichts
set role authenticated;
select tests.login(:'host');
select tests.assert((public.retry_slot_release(:'world') ->> 'released')::boolean = false, 'retry_slot_release ohne offenen Termin: keine Änderung');
select tests.login('00000000-0000-0000-0000-00000000dead');
select tests.expect_error(format($$ select public.retry_slot_release(%L) $$, :'world'), 'forbidden');
reset role;
