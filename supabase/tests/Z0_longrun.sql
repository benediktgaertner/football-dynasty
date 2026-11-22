-- Z0: Langzeittest über mehrere Saisonen (Variablen: world, seasons; Standard 10)
-- Nutzt die normale Spiellogik der Datenbank; Spielergebnisse kommen wie in 50_season.sql aus tests.finish_slot
-- (deterministische Pseudo-Ergebnisse, NICHT aus der Match Engine) – geprüft werden Saisonübergänge, Verträge, Finanzen,
-- Free-Agent-Pool, Alterung/Entwicklung, Auf-/Abstieg und Europapokal, nicht das sportliche Balancing.
\set ON_ERROR_STOP on
\set QUIET on
\if :{?seasons}
\else
\set seasons 10
\endif
select set_config('fd.world', :'world', false);
select set_config('fd.seasons', :'seasons', false);
drop table if exists tests.longrun;
create table tests.longrun(n int, season_year int, players int, free_agents int, avg_ovr_l1 numeric, avg_ovr_all numeric, avg_age numeric,
  avg_salary numeric, payroll_total bigint, neg_balance_clubs int, min_balance bigint, max_balance bigint, min_squad int, ec_winners int, slots int, secs numeric);

do $$
declare
  w uuid := current_setting('fd.world')::uuid;
  n integer := 0; i integer; t0 timestamptz; st text; yr integer;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  while n < current_setting('fd.seasons')::int loop
    st := (select status from public.career_worlds where id = w);
    if st = 'preseason' then
      set local role authenticated;
      perform public.force_start_season(w);
      reset role;
      st := (select status from public.career_worlds where id = w);
    end if;
    if st <> 'season' then raise exception 'TEST FEHLGESCHLAGEN: Welt in unerwartetem Status % (Saison %)', st, n + 1; end if;
    t0 := clock_timestamp(); i := 0;
    yr := (select s.year from public.seasons s join public.career_worlds cw on cw.current_season_id = s.id where cw.id = w);
    while (select status from public.career_worlds where id = w) = 'season' and i < 80 loop
      perform public.fd_begin_slot(w);
      perform tests.finish_slot(w);
      begin perform public.admin_sweep_world(w); exception when others then raise warning 'Sweep: %', sqlerrm; end; -- Server-Sweep (KI-Training, Entwicklung) wie im Betrieb
      i := i + 1;
    end loop;
    if (select status from public.career_worlds where id = w) <> 'preseason' then
      raise exception 'TEST FEHLGESCHLAGEN: Saison % nicht beendet nach % Terminen (blockiert)', n + 1, i;
    end if;
    n := n + 1;
    insert into tests.longrun
    select n, yr,
      (select count(*) from public.players where world_id = w and not retired and club_id is not null),
      (select count(*) from public.free_agents where world_id = w),
      (select avg(p.overall) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = w and not c.amateur and exists (select 1 from public.competition_entries e join public.competitions k on k.id = e.competition_id where e.club_id = c.id and k.season_id = (select current_season_id from public.career_worlds where id = w) and k.kind = 'league' and k.tier = 1)),
      (select avg(p.overall) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = w and not c.amateur),
      (select avg(p.age) from public.players p join public.clubs c on c.id = p.club_id where c.world_id = w and not c.amateur),
      (select avg(annual_salary) from public.player_contracts where world_id = w and active),
      (select coalesce(sum(annual_salary), 0) from public.player_contracts where world_id = w and active),
      (select count(*) from public.finances where world_id = w and balance < 0),
      (select min(balance) from public.finances where world_id = w),
      (select max(balance) from public.finances where world_id = w),
      (select min(cnt) from (select count(*) cnt from public.players p join public.clubs c on c.id = p.club_id where c.world_id = w and not c.amateur and not p.retired and c.association_code = (select country_code from public.career_worlds where id = w) group by c.id) q),
      (select count(*) from public.season_awards where world_id = w and kind in ('cl_winner', 'el_winner')),
      i, round(extract(epoch from clock_timestamp() - t0)::numeric, 1);
  end loop;
end $$;

select * from tests.longrun order by n;

-- Invarianten nach dem Langzeitlauf
select tests.assert((select count(*) from tests.longrun) = :seasons, :seasons || ' Saisonen komplett durchgespielt, keine blockierte Saison');
select tests.assert(not exists (select 1 from public.players p where p.club_id is not null and p.retired), 'keine pensionierten Spieler in Vereinen');
select tests.assert(not exists (select 1 from public.player_contracts where world_id = :'world' and active group by player_id having count(*) > 1), 'höchstens ein aktiver Vertrag je Spieler');
select tests.assert(not exists (select 1 from public.players p where p.world_id = :'world' and p.club_id is not null and not p.retired and not exists (select 1 from public.player_contracts c where c.player_id = p.id and c.active) and not p.temporary and not exists (select 1 from public.clubs cc where cc.id = p.club_id and cc.amateur)), 'jeder Vereinsspieler (außer Amateure) hat einen aktiven Vertrag');
select tests.assert(not exists (select 1 from public.player_contracts c join public.players p on p.id = c.player_id where c.active and c.world_id = :'world' and p.club_id is distinct from c.club_id), 'Vertragsverein = Spielerverein');
select tests.assert(not exists (select 1 from public.financial_transactions where world_id = :'world' group by idempotency_key having count(*) > 1), 'keine doppelten Buchungsschlüssel');
select tests.assert(not exists (
  select 1 from public.finances f join lateral (select t.balance_after from public.financial_transactions t where t.club_id = f.club_id order by t.id desc limit 1) l on true
  where f.world_id = :'world' and f.balance <> l.balance_after), 'Kontostand = letzte Buchung (alle Vereine)');
select tests.assert((select min(min_squad) from tests.longrun) >= 16, 'kein Verein unter 16 Spielern (min ' || (select min(min_squad) from tests.longrun) || ')');
select tests.assert((select max(free_agents) from tests.longrun) <= 900, 'Free-Agent-Pool begrenzt (max ' || (select max(free_agents) from tests.longrun) || ')');
select tests.assert((select max(players) from tests.longrun) <= 1.15 * (select min(players) from tests.longrun), 'Spielerzahl wächst nicht unkontrolliert (' || (select min(players) from tests.longrun) || '–' || (select max(players) from tests.longrun) || ')');
select tests.assert((select max(avg_ovr_all) - min(avg_ovr_all) from tests.longrun) <= 4, 'keine OVR-Inflation/-Deflation (Ø alle ' || (select round(min(avg_ovr_all), 2) || '–' || round(max(avg_ovr_all), 2) from tests.longrun) || ')');
select tests.assert((select max(avg_salary) from tests.longrun) <= 2.5 * (select min(avg_salary) from tests.longrun), 'Gehälter steigen nicht unbegrenzt (Ø ' || (select round(min(avg_salary)) || '–' || round(max(avg_salary)) from tests.longrun) || ')');
select tests.assert((select max(neg_balance_clubs) from tests.longrun) = 0, 'keine KI-Vereine im Minus (max ' || (select max(neg_balance_clubs) from tests.longrun) || ' Vereine, tiefster Stand ' || (select min(min_balance) from tests.longrun) || ')');
select tests.assert((select count(*) from public.clubs where world_id = :'world' and amateur) = 10, 'weiterhin 10 Amateurvereine');
\echo 'OK Z0 Langzeittest'
