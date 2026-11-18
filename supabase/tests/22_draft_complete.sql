-- Phase 3: kompletter Draft-Durchlauf (nach dem Paralleltest)
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set stranger '00000000-0000-0000-0000-0000000000c1'
select set_config('fd.world', :'world', false);

-- ------------------------------------------------------------------
-- Kompletten Draft über Auto-Pick durchlaufen lassen (abwesende Manager)
-- ------------------------------------------------------------------
do $$
declare
  v_world uuid := current_setting('fd.world')::uuid;
  v_guard integer := 0;
begin
  -- Gegnerisches Verhalten: Der Gast kauft immer den billigsten Spieler weg,
  -- der Host-Verein wählt per Auto-Pick gierig die stärksten bezahlbaren Spieler.
  while (select status from public.draft_sessions where world_id = v_world) = 'running' loop
    if (select c.manager_user_id from public.draft_sessions d join public.clubs c
          on c.id = d.club_order[public.fd_snake_index(cardinality(d.club_order), d.current_pick) + 1]
        where d.world_id = v_world) = '00000000-0000-0000-0000-0000000000b1' then
      perform tests.login('00000000-0000-0000-0000-0000000000b1');
      perform public.make_draft_pick(v_world, (select id from public.players where world_id = v_world and in_draft_pool order by market_value, id limit 1));
    else
      perform tests.login('00000000-0000-0000-0000-0000000000a1');
      update public.world_members set last_seen_at = now() - interval '20 minutes' where world_id = v_world;
      perform public.auto_pick_current(v_world);
    end if;
    v_guard := v_guard + 1;
    if v_guard > 100 then raise exception 'Draft endet nicht'; end if;
  end loop;
end $$;

select tests.assert((select status from public.draft_sessions where world_id = :'world') = 'finished', 'Draft beendet');
select tests.assert((select status from public.career_worlds where id = :'world') = 'preseason', 'Welt in der Vorbereitung');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.control = 'human'
  and (select count(*) from public.players p where p.club_id = c.id) <> 22), 'D3: jeder Mensch hat exakt 22 Spieler');
select tests.assert((select count(*) from public.draft_picks d join public.draft_sessions s on s.id = d.draft_id where s.world_id = :'world') = 44, '44 Picks');
select tests.assert((select count(distinct player_id) from public.draft_picks d join public.draft_sessions s on s.id = d.draft_id where s.world_id = :'world') = 44, 'kein Spieler doppelt');
select tests.assert((select count(*) from public.free_agents where world_id = :'world') = 400 - 44, 'D3: verbleibende Free Agents aus Teilnehmerzahl');
select tests.assert(not exists (select 1 from public.finances f join public.clubs c on c.id = f.club_id where c.world_id = :'world' and f.balance < 0), 'kein negatives Konto');
select tests.assert(not exists (
  select 1 from public.finances f join public.clubs c on c.id = f.club_id where c.world_id = :'world'
  and f.balance <> (select coalesce(sum(amount), 0) from public.financial_transactions t where t.club_id = f.club_id)), 'Kontostand = Summe aller Buchungen');
select tests.assert((select count(*) from public.players p join public.clubs c on c.id = p.club_id
  where c.world_id = :'world' and c.manager_user_id = :'host' and p.main_position = 'GK') >= 2, 'Auto-Pick deckt Torhüterbedarf');
select tests.assert((select balance from public.finances f join public.clubs c on c.id = f.club_id
  where c.world_id = :'world' and c.manager_user_id = :'host') < (public.starting_capital('medium') - public.stadium_build_cost(30000)) / 2, 'Auto-Pick nutzt sein Budget sinnvoll aus');
select tests.assert(not exists (select 1 from public.clubs c where c.world_id = :'world' and c.control = 'human'
  and (select count(distinct shirt_number) from public.players p where p.club_id = c.id) <> 22), 'eindeutige Trikotnummern');
select tests.assert((select count(*) from public.transfers where world_id = :'world' and kind = 'draft') = 44, 'Draft-Transfers protokolliert');

set role authenticated;
select tests.login(:'host');
select tests.expect_error(format($$ select public.make_draft_pick(%L, %L) $$, :'world',
  (select id from public.players where world_id = :'world' and in_draft_pool limit 1)), 'draft_not_running');
select tests.assert((public.draft_state(:'world') ->> 'status') = 'finished', 'Zustand: beendet');
-- RLS: Pool und Kader sind für Mitglieder lesbar, Potenzial nicht
select tests.assert((select count(*) from public.players where world_id = :'world') = 1700, 'Mitglied sieht alle Spieler der Welt');
select tests.expect_error($$ select potential from public.player_hidden limit 1 $$, 'permission denied');
select tests.login(:'stranger');
select tests.assert((select count(*) from public.players where world_id = :'world') = 0, 'Fremder sieht keine Spieler');
reset role;

\echo '>>> 22_draft_complete: alle Prüfungen bestanden'
