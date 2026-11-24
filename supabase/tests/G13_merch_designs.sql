-- G13: Fanartikel-Designs (Migration 0050). Variablen: world
\set ON_ERROR_STOP on
\set QUIET on
begin;
select m.user_id as host from public.world_members m where m.world_id = :'world' and m.role = 'host' limit 1 \gset
select c.id as hclub from public.clubs c where c.world_id = :'world' and c.manager_user_id = :'host' \gset
select current_season_id as season from public.career_worlds where id = :'world' \gset

-- Validierung (Allowlist je Produktfamilie)
select tests.assert(public.fd_valid_merch_design('jersey', '{"pattern":"hoops","c1":"#c8102e","c2":"#ffffff","c3":"#f2c14e","crest":true,"text":"Ultras 1904"}'), 'gültiges Trikotdesign');
select tests.assert(public.fd_valid_merch_design('scarf', '{"pattern":"checker"}') and public.fd_valid_merch_design('cap', '{"pattern":"panels"}') and public.fd_valid_merch_design('flag', '{"pattern":"cross"}'), 'Muster je Familie gültig');
select tests.assert(not public.fd_valid_merch_design('scarf', '{"pattern":"hoops"}'), 'Trikotmuster beim Schal abgelehnt');
select tests.assert(not public.fd_valid_merch_design('jersey', '{"c1":"rot"}'), 'ungültige Farbe abgelehnt');
select tests.assert(not public.fd_valid_merch_design('jersey', '{"text":"<script>alert(1)</script>"}'), 'Aufdruck mit Sonderzeichen abgelehnt');
select tests.assert(not public.fd_valid_merch_design('jersey', '{"text":"12345678901234567"}'), 'Aufdruck über 16 Zeichen abgelehnt');
select tests.assert(not public.fd_valid_merch_design('jersey', '{"pattern":"stripes","evil":1}'), 'unbekannte Felder abgelehnt');
select tests.assert(not public.fd_valid_merch_design('jersey', '{"crest":"ja"}'), 'Logo-Flag muss boolean sein');
select tests.assert(public.fd_valid_merch_design('flag', '{}'), 'leeres Design = Vereinsfarben-Standard');

-- Speichern über die RPC
set role authenticated;
select tests.login(:'host');
select public.merch_overview(:'world') as ov0 \gset
select public.merch_set_design(:'world', 'home_jersey', '{"pattern":"chevron","c1":"#003b95","c2":"#ffffff","c3":"#f2c14e","crest":true,"text":"FCD 1904"}');
select public.merch_set_design(:'world', 'scarf', '{"pattern":"bands","c1":"#111111"}');
select tests.expect_error(format($$ select public.merch_set_design(%L, 'scarf', '{"pattern":"hoops"}') $$, :'world'), 'merch_design');
select tests.expect_error(format($$ select public.merch_set_design(%L, 'laser', '{}') $$, :'world'), 'merch_product');
select tests.expect_error(format($$ select public.merch_set_design(%L, 'cap', '{"c1":"#12"}') $$, :'world'), 'merch_design');
select public.merch_overview(:'world') as ov1 \gset
select tests.assert((select p -> 'design' ->> 'pattern' from jsonb_array_elements((:'ov1'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey') = 'chevron', 'Design wird mit dem Fanshop geladen');
select tests.assert((select p ->> 'family' from jsonb_array_elements((:'ov1'::jsonb) -> 'products') p where p ->> 'key' = 'scarf') = 'scarf', 'Produktfamilie wird geliefert');
select tests.assert((select p -> 'design' ->> 'text' from jsonb_array_elements((:'ov1'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey') = 'FCD 1904', 'Aufdruck gespeichert');
select tests.assert((select (p ->> 'price')::int from jsonb_array_elements((:'ov1'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey') = (select (p ->> 'price')::int from jsonb_array_elements((:'ov0'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey'), 'Design ändert den Preis nicht');
select tests.assert((select (p ->> 'stock')::int from jsonb_array_elements((:'ov1'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey') = (select (p ->> 'stock')::int from jsonb_array_elements((:'ov0'::jsonb) -> 'products') p where p ->> 'key' = 'home_jersey'), 'Design ändert den Lagerbestand nicht');
reset role;
-- fremder Verein kann nicht
select m2.user_id as guest from public.world_members m2 where m2.world_id = :'world' and m2.role <> 'host' order by m2.user_id limit 1 \gset
select count(*) as guest_n from public.clubs c where c.manager_user_id = :'guest' and c.world_id = :'world' \gset
select tests.assert((select design from public.club_merch where club_id = :'hclub' and product_key = 'scarf') ->> 'pattern' = 'bands', 'Design liegt beim eigenen Verein');
select tests.assert(not exists (select 1 from public.club_merch where club_id <> :'hclub' and design <> '{}'::jsonb), 'andere Vereine unverändert');

-- Keine wirtschaftliche Wirkung: gleiche Abrechnung bei völlig anderem Design
select s.id as slot from public.season_slots s join public.fixtures f on f.season_id = s.season_id and f.slot_key = s.slot_key
  where s.season_id = :'season' and s.kind = 'league' and :'hclub' in (f.home_club_id, f.away_club_id)
    and not exists (select 1 from public.merch_history h where h.club_id = :'hclub' and h.slot_id = s.id) order by s.ordinal desc limit 1 \gset
update public.fixtures set status = 'finished' where season_id = :'season' and slot_key = (select slot_key from public.season_slots where id = :'slot');
update public.club_merch set stock = 600 where club_id = :'hclub';
savepoint a;
update public.club_merch set design = '{"pattern":"solid","c1":"#ffffff","c2":"#ffffff","c3":"#ffffff","crest":false,"text":""}' where club_id = :'hclub';
select public.fd_slot_economy(:'slot');
select sum(revenue) as rev_a, sum(units) as units_a from public.merch_history where club_id = :'hclub' and slot_id = :'slot' \gset
select balance as bal_a from public.finances where club_id = :'hclub' \gset
rollback to savepoint a;
savepoint b;
update public.club_merch set design = '{"pattern":"chevron","c1":"#c8102e","c2":"#f2c14e","c3":"#003b95","crest":true,"text":"SUPERFANS"}' where club_id = :'hclub';
select public.fd_slot_economy(:'slot');
select sum(revenue) as rev_b, sum(units) as units_b from public.merch_history where club_id = :'hclub' and slot_id = :'slot' \gset
select balance as bal_b from public.finances where club_id = :'hclub' \gset
rollback to savepoint b;
select tests.assert(:rev_a > 0 and :rev_a = :rev_b and :units_a = :units_b and :bal_a = :bal_b, 'Designwechsel verändert Absatz, Erlös und Kontostand nicht (' || :rev_a || ' = ' || :rev_b || ')');
select tests.assert(position('design' in pg_get_functiondef('public.fd_slot_economy(uuid)'::regprocedure)) = 0, 'Abrechnung liest das Design nie');
rollback;
\echo 'OK G13'
