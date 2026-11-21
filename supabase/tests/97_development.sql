-- Spielerentwicklung: XP aus Training und Spielen, sofortige Attributsteigerung, gleiche Regeln für KI, Alterung nur zum Saisonwechsel
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select current_season_id as season, current_week as week from public.career_worlds where id = :'world' \gset

-- Gesamtstärke aus Attributen: SQL rechnet wie TypeScript (generierte Spieler)
select tests.assert((select count(*) filter (where public.fd_overall(pa.kind, p.main_position::text, pa.attributes) = p.overall)::numeric / count(*) >= 0.99
  from public.players p join public.player_attributes pa on pa.player_id = p.id join public.clubs c on c.id = p.club_id where not c.amateur), 'OVR aus Attributen = gespeicherte OVR');

-- Pflichtspiele: XP genau einmal (auch bei erneutem Speichern / erneutem Auswerten)
select ms.fixture_id as dfx from public.match_player_stats ms join public.fixtures f on f.id = ms.fixture_id join public.competitions c on c.id = f.competition_id
where ms.world_id = :'world' and c.kind::text <> 'friendly' and ms.minutes > 0 order by ms.fixture_id limit 1 \gset
select tests.assert((select count(*) from public.match_player_stats where fixture_id = :'dfx' and minutes > 0 and dev_xp is null) = 0, 'alle Einsatzspieler haben XP erhalten');
select md5(string_agg(x.xp::text, ',' order by x.player_id)) as xp_before from public.player_xp x where x.player_id in (select player_id from public.match_player_stats where fixture_id = :'dfx') \gset
select tests.assert(public.fd_dev_after_match(:'dfx') = 0, 'erneute Auswertung vergibt keine XP');
set role service_role;
select tests.assert(public.admin_finish_match(:'dfx', '{"score":[1,0],"events":[],"players":[],"stats":{}}'::jsonb) ->> 'status' = 'already_saved', 'erneutes Speichern abgewiesen');
reset role;
select tests.assert((select md5(string_agg(x.xp::text, ',' order by x.player_id)) from public.player_xp x where x.player_id in (select player_id from public.match_player_stats where fixture_id = :'dfx')) = :'xp_before', 'XP unverändert');
select tests.assert((select count(*) from public.player_season_development where season_id = :'season' and matches > 0) > 100, 'Spielleistungen in der Saisonbilanz');

-- Testspiele zählen nicht
select f.id as ffx from public.fixtures f join public.competitions c on c.id = f.competition_id where f.world_id = :'world' and c.kind::text = 'friendly' limit 1 \gset
select tests.assert(public.fd_dev_after_match(:'ffx') = 0, 'Testspiele bringen keine XP');

-- Zusatztraining: XP sofort, −20 Fitness, max. eine Einheit je Woche
select p.id as tp, p.fitness as tfit from public.players p join public.player_attributes pa0 on pa0.player_id = p.id and pa0.kind = 'outfield' where p.club_id = :'host_club' and p.fitness >= 20
  and p.main_position::text in ('ST', 'CF', 'CAM', 'CM', 'LW', 'RW', 'LM', 'RM') -- Technik-Training wirkt bei Offensivspielern deutlich auf die Gesamtstärke
  and not exists (select 1 from public.training_sessions t where t.player_id = p.id and t.season_id = :'season' and t.week_no = :'week') order by p.age, p.id limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.schedule_training(:'world', :'tp', 'technique') as tr \gset
select tests.expect_error(format($$ select public.schedule_training(%L, %L, 'physical') $$, :'world', :'tp'), 'already_trained');
reset role;
select tests.assert((:'tr'::jsonb ->> 'points')::numeric > 0, 'Training erzeugt XP');
select tests.assert((select fitness from public.players where id = :'tp') = greatest(0, :tfit - 20), '−20 Fitness');
select tests.assert((select count(*) from public.player_xp x, jsonb_object_keys(x.xp) k where x.player_id = :'tp' and k in ('passing', 'dribbling', 'shooting', 'crossing')) > 0, 'XP bei den Technik-Attributen');
select tests.assert((select training_sessions >= 1 and training_xp > 0 from public.player_season_development where player_id = :'tp' and season_id = :'season'), 'Training in der Saisonbilanz');

-- Viele XP: Attribute steigen sofort, OVR und Marktwert folgen, die Engine liest dieselben Attribute
select p.overall as ovr0, (pa.attributes ->> 'passing')::int as pass0 from public.players p join public.player_attributes pa on pa.player_id = p.id where p.id = :'tp' \gset
select public.fd_dev_grant(:'tp', public.fd_jsonb_scale(public.fd_dev_training_shares(pa.kind, p.main_position::text, 'technique'), 60), 'training') as big
from public.players p join public.player_attributes pa on pa.player_id = p.id where p.id = :'tp' \gset
select tests.assert((select (attributes ->> 'passing')::int from public.player_attributes where player_id = :'tp') > :pass0, 'Attribut gestiegen');
select tests.assert((select overall from public.players where id = :'tp') > :ovr0, 'OVR in der Saison gestiegen');
select tests.assert((select market_value = public.fd_market_value(overall, age) from public.players where id = :'tp'), 'Marktwert neu berechnet');
select tests.assert(exists (select 1 from public.player_development where player_id = :'tp' and kind = 'in_season_improvement' and overall_after > overall_before), 'Verbesserung protokolliert');
select tests.assert((select (s -> 'attributes' ->> 'passing')::int from jsonb_array_elements(public.fd_match_team(:'host_club', current_date, null, :'season') -> 'squad') s where s ->> 'id' = :'tp')
  = (select (attributes ->> 'passing')::int from public.player_attributes where player_id = :'tp'), 'Match Engine erhält die neuen Attribute');
-- Grenzen: 99 ist das Maximum, Verbesserungen senken die OVR nie
select public.fd_dev_grant(:'tp', '{"passing": 100000}'::jsonb, 'training');
select tests.assert((select (attributes ->> 'passing')::int from public.player_attributes where player_id = :'tp') = 99, 'Attribut höchstens 99');

-- KI-Vereine: gleiche Regeln, bis zu 5 Spieler je Woche, nie doppelt
select public.fd_ai_training_batch(:'world', 1000);
select tests.assert(public.fd_ai_training_batch(:'world', 1000) = 0, 'alle KI-Vereine haben diese Woche trainiert');
select tests.assert((select max(n) from (select count(*) n from public.training_sessions where world_id = :'world' and season_id = :'season' and week_no = :'week' group by club_id) x) <= 5, 'höchstens 5 Spieler je Verein und Woche');
select tests.assert((select count(*) from public.training_sessions t join public.clubs c on c.id = t.club_id where t.world_id = :'world' and c.control = 'ai' and t.week_no = :'week' and t.season_id = :'season') > 0, 'KI trainiert selbstständig');
select tests.assert((select count(*) from public.training_sessions t join public.clubs c on c.id = t.club_id where c.control = 'ai' and t.season_id = :'season' and t.dev_xp is null) = 0, 'KI-Training mit derselben XP-Formel ausgewertet');
select count(*) as nsess from public.training_sessions where world_id = :'world' \gset
select public.fd_ai_training_batch(:'world', 1000);
select tests.assert((select count(*) from public.training_sessions where world_id = :'world') = :nsess, 'kein doppeltes KI-Training');

-- Bericht (laufende Saison) für eigenen und fremden Verein, ohne Potenzial
select id as ai_club from public.clubs where world_id = :'world' and control = 'ai' and not amateur and association_code = 'GER' order by name limit 1 \gset
set role authenticated;
select tests.login(:'host');
select public.development_report(:'world', :'host_club') as rep \gset
select public.development_report(:'world', :'ai_club') as rep_ai \gset
reset role;
select tests.assert(jsonb_array_length(:'rep'::jsonb -> 'players') > 15, 'Bericht enthält den Kader');
select tests.assert((select (r ->> 'delta')::int > 0 from jsonb_array_elements(:'rep'::jsonb -> 'players') r where r ->> 'player_id' = :'tp'), 'Gewinner im Bericht');
select tests.assert(jsonb_array_length(:'rep_ai'::jsonb -> 'players') > 15, 'KI-Verein einsehbar');
select tests.assert(position('potential' in :'rep_ai') = 0, 'Potenzial bleibt verborgen');

-- Alterung nur beim Saisonwechsel (Probelauf, wird zurückgerollt)
begin;
select public.fd_dev_season_close(:'world', :'season');
update public.players set age = least(45, age + 1) where world_id = :'world' and club_id is not null;
insert into public.dev_aging_jobs(world_id, season_id) values (:'world', :'season');
select tests.assert(public.fd_dev_season_aging(:'world', :'season', 500) > 0, 'Alterung in Häppchen: erster Teil');
select tests.assert(:'world' in (select public.admin_due_worlds()::text), 'offene Alterung wird vom Server fortgesetzt');
select tests.assert(public.fd_dev_aging_batch(:'world', 100000) = 0, 'Alterung vollständig');
select tests.assert(public.fd_dev_season_aging(:'world', :'season', 500) = 0 and (select count(*) from public.player_development where season_id = :'season' and kind = 'season_change_age')
  = (select count(*) from public.player_season_development where season_id = :'season' and declines <> '{}'::jsonb), 'jeder Spieler genau einmal gealtert');
select tests.assert((select done_at is not null from public.dev_aging_jobs where world_id = :'world' and season_id = :'season'), 'Alterungsauftrag abgeschlossen');
select tests.assert((select count(*) from public.player_season_development where season_id = :'season' and age < 28 and ovr_after_aging < ovr_end) = 0, 'junge Spieler verlieren nichts');
select tests.assert((select avg(ovr_after_aging - ovr_end) from public.player_season_development where season_id = :'season' and age >= 33)
                  < (select avg(ovr_after_aging - ovr_end) from public.player_season_development where season_id = :'season' and age between 28 and 30), 'ältere verlieren mehr');
select tests.assert((select avg(ovr_after_aging - ovr_end) from public.player_season_development where season_id = :'season' and age >= 33) > -4, 'Verlust moderat');
select tests.assert(exists (select 1 from public.player_development where season_id = :'season' and kind = 'season_change_age'), 'Alterung getrennt protokolliert');
select tests.assert((select count(*) from public.player_season_development where season_id = :'season' and declines <> '{}'::jsonb) > 0, 'Verschlechterte Attribute im Bericht');
rollback;
\echo '>>> 97_development: Entwicklung, KI-Training und Alterung funktionieren'
