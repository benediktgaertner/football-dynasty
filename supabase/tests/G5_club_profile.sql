-- 0040: Vereinsprofil darf nie formation.slots = null liefern (schwarzer Bildschirm im Frontend)
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
begin;
select tests.login(:'host');

-- Fehlerfall gezielt herstellen: letztes freigegebenes Spiel eines Vereins mit Kompakt-Aufstellung (nur Spieler-IDs)
select f.id as fx, f.home_club_id as hc from public.fixtures f join public.fixture_results r on r.fixture_id = f.id
  join public.seasons s on s.id = f.season_id
  where s.world_id = :'world' and f.status = 'released' and jsonb_typeof(r.summary -> 'lineups' -> 'home' -> 'slots') = 'array'
    and exists (select 1 from public.fixtures f2 join public.fixture_results r2 on r2.fixture_id = f2.id
                where f2.id <> f.id and f2.status = 'released' and (
                  (f2.home_club_id = f.home_club_id and jsonb_typeof(r2.summary -> 'lineups' -> 'home' -> 'slots') = 'array')
                  or (f2.away_club_id = f.home_club_id and jsonb_typeof(r2.summary -> 'lineups' -> 'away' -> 'slots') = 'array')))
  order by f.scheduled_date desc limit 1 \gset
update public.fixture_results r set summary = jsonb_set(r.summary, '{lineups,home}', (select to_jsonb(array_agg(e ->> 'playerId')) from jsonb_array_elements(r.summary -> 'lineups' -> 'home' -> 'slots') e))
  where r.fixture_id = :'fx';
update public.fixtures set scheduled_date = scheduled_date + 400 where id = :'fx';
select tests.assert(jsonb_typeof(public.club_profile(:'hc') -> 'formation' -> 'slots') = 'array', 'Kompakt-Aufstellung als letztes Spiel: frühere vollständige Formation statt slots = null');
select tests.assert(jsonb_array_length(public.club_profile(:'hc') -> 'formation' -> 'slots') between 1 and 11, 'Formation hat 1–11 Spieler');

-- alle Vereine der Welt (1.–3. Liga, Ausland, Amateure): Profil vollständig, nie slots = null
select tests.assert(not exists (
  select 1 from public.clubs c, lateral (select public.club_profile(c.id) p) z
  where c.world_id = :'world' and (
    jsonb_typeof(z.p -> 'squad') <> 'array' or jsonb_typeof(z.p -> 'results') <> 'array'
    or (z.p -> 'formation' <> 'null'::jsonb and jsonb_typeof(z.p -> 'formation' -> 'slots') <> 'array'))),
  'Alle Vereinsprofile: Kader/Ergebnisse als Liste, Formation nie ohne Aufstellung');
rollback;
