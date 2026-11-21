-- Europapokal ab Saison 2: 32 + 32 Teilnehmer, Startplätze nach Länderrangliste, 8 Gruppen, Achtelfinale bis Finale
\set ON_ERROR_STOP on
\set QUIET on
select current_season_id as season from public.career_worlds where id = :'world' \gset
select id as prev from public.seasons where world_id = :'world' and status::text = 'closed' order by year desc limit 1 \gset
select id as bl from public.competitions where season_id = :'prev' and kind = 'league' and tier = 1 \gset
select id as cl from public.competitions where season_id = :'season' and kind::text = 'champions_league' \gset
select id as el from public.competitions where season_id = :'season' and kind::text = 'europa_league' \gset

select tests.assert((select count(*) from public.competition_entries where competition_id = :'cl') = 32, 'Champions League: exakt 32 Vereine');
select tests.assert((select count(*) from public.competition_entries where competition_id = :'el') = 32, 'Europa League: exakt 32 Vereine');
select tests.assert(not exists (select club_id from public.competition_entries where competition_id in (:'cl', :'el') group by club_id having count(*) > 1), 'kein Verein doppelt oder in beiden Wettbewerben');
select tests.assert((select count(*) from public.competition_groups g join public.competition_stages st on st.id = g.stage_id where st.competition_id in (:'cl', :'el')) = 16, 'je Wettbewerb 8 Gruppen');
select tests.assert(not exists (select 1 from public.competition_groups g join public.competition_stages st on st.id = g.stage_id
  where st.competition_id in (:'cl', :'el') and (select count(*) from public.group_memberships m where m.group_id = g.id) <> 4), 'jede Gruppe 4 Vereine');
select tests.assert((select count(*) from public.fixtures where competition_id in (:'cl', :'el') and group_id is not null) = 2 * 8 * 12, 'je Gruppe 12 Spiele (6 Spieltage)');
select tests.assert((select count(*) from public.ec_qualifications where season_id = :'season') = 64, '64 Qualifikationseinträge');
-- Deutschland (Länderrang 4): Platz 1–4 CL, Platz 5–6 EL, Pokalsieger EL bzw. Platz 7 als Nachrücker
select tests.assert((select array_agg(t.pos order by t.pos) from public.ec_qualifications q join public.fd_table(:'bl') t on t.club_id = q.club_id
  where q.season_id = :'season' and q.competition = 'cl' and q.reason not like 'Nachrücker%') = array[1, 2, 3, 4], 'CL: Bundesliga-Platz 1–4 der Vorsaison');
select tests.assert((select count(*) from public.ec_qualifications q join public.fd_table(:'bl') t on t.club_id = q.club_id
  where q.season_id = :'season' and q.competition = 'el' and t.pos in (5, 6)) = 2, 'EL: Platz 5 und 6');
select t.winner_club_id as cupwin from public.ties t join public.competition_stages st on st.id = t.stage_id join public.competitions c on c.id = st.competition_id
  where c.season_id = :'prev' and c.kind = 'domestic_cup' and st.kind = 'final' \gset
select tests.assert(case when exists (select 1 from public.fd_table(:'bl') t where t.club_id = :'cupwin' and t.pos <= 6)
  then (select q.reason like '%Pokalsieger bereits qualifiziert%' from public.ec_qualifications q join public.fd_table(:'bl') t on t.club_id = q.club_id where q.season_id = :'season' and t.pos = 7)
  else (select reason = 'Pokalsieger' and competition = 'el' from public.ec_qualifications where season_id = :'season' and club_id = :'cupwin') end,
  'Pokalsieger in der EL – oder Platz 7 rückt nach, wenn er schon qualifiziert ist');
select tests.assert((select count(*) from public.ec_qualifications q where q.season_id = :'season' and q.association_code = 'GER' and q.reason not like 'Nachrücker%') = 7, 'Deutschland: 4 CL + 3 EL');
select tests.assert(not exists (select 1 from public.ec_qualifications q join public.clubs c on c.id = q.club_id
  where q.season_id = :'season' and c.association_code = 'GER' and q.reason not like 'Pokalsieger%' and q.reason not like 'Nachrücker%'
    and not exists (select 1 from public.competition_entries e where e.competition_id = :'bl' and e.club_id = c.id)), 'Unterklassige nur über den Pokal');
-- Ausland: England (Rang 1) 4 CL + 2 EL + Pokalsieger; kleinere Nation (San Marino) über Zusatzplatz
select tests.assert((select count(*) from public.ec_qualifications where season_id = :'season' and association_code = 'ENG' and competition = 'cl' and reason not like 'Nachrücker%') = 4, 'England: 4 CL-Plätze');
select tests.assert((select count(*) from public.ec_qualifications where season_id = :'season' and association_code = 'ENG' and competition = 'el' and reason not like 'Nachrücker%') = 3, 'England: 2 EL-Ligaplätze + Pokalsieger');
select tests.assert((select count(*) from public.ec_qualifications where season_id = :'season' and association_code = 'POR' and competition = 'cl' and reason not like 'Nachrücker%') = 3, 'Portugal (Rang 6): 3 CL-Plätze');
select tests.assert(exists (select 1 from public.ec_qualifications where season_id = :'season' and association_code = 'SMR' and reason like '%kleinere Nation%'), 'kleinere Nation dabei');
select tests.assert(not exists (select 1 from public.clubs c join public.ec_qualifications q on q.club_id = c.id where q.season_id = :'season' and c.amateur and q.reason <> 'Pokalsieger'), 'Amateurvereine höchstens als Pokalsieger');
-- Englands CL-Vertreter sind die stärksten englischen Vereine (begrenzter Zufall)
select tests.assert((select min(public.fd_club_strength(q.club_id)) from public.ec_qualifications q where q.season_id = :'season' and q.association_code = 'ENG' and q.competition = 'cl' and q.reason not like 'Nachrücker%')
  >= (select percentile_cont(0.5) within group (order by public.fd_club_strength(c.id)) from public.clubs c where c.world_id = :'world' and c.association_code = 'ENG'), 'Auswahl nach Stärke');

-- Tabellenmarkierung der 1. Liga
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.assert((public.europe_places(:'world') ->> 'cl')::int between 4 and 5, 'Tabellenmarkierung: 4–5 CL-Plätze');
select tests.assert((public.europe_places(:'world') ->> 'el')::int = 2, 'Tabellenmarkierung: 2 EL-Plätze');
select tests.assert(jsonb_array_length(public.europe_overview(:'world') -> 'competitions' -> 0 -> 'groups') = 8, 'Übersicht: 8 Gruppen');
select tests.assert((public.europe_overview(:'world') -> 'competitions' -> 0 -> 'groups' -> 0 -> 'table' -> 0 ->> 'reason') is not null, 'Übersicht: Qualifikationsgrund');
select tests.login('00000000-0000-0000-0000-0000000000c1');
select tests.expect_error(format($$ select public.europe_places(%L) $$, :'world'), 'forbidden');
reset role;

-- Echter Spielbetrieb (vorherige Tests haben Saison 2 weitergespielt): Gruppenphase → Achtelfinale → Viertelfinale
select tests.assert(not exists (select 1 from public.standings s where s.competition_id in (:'cl', :'el') and s.group_id is not null and s.played <> 6)
  or not exists (select 1 from public.season_slots where season_id = :'season' and slot_key = 'E6' and state = 'released'), 'nach E6: jeder Gruppenteilnehmer 6 Spiele');
select tests.assert(not exists (select 1 from public.season_slots where season_id = :'season' and slot_key = 'E8' and state = 'released')
  or (select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'quarter_final') = 8,
  'nach dem Achtelfinale: je 4 Viertelfinal-Duelle');

-- K.-o.-Phase vollständig (in einer Transaktion, danach zurückgerollt): Gruppen → Achtelfinale → … → Finale
begin;
delete from public.competition_stages where competition_id in (:'cl', :'el') and kind <> 'group';
update public.standings s set won = x.w, drawn = x.d, lost = 6 - x.w - x.d, played = 6, points = 3 * x.w + x.d
from (select club_id, floor(public.fd_hash01(club_id::text || 'w') * 5)::int as w, floor(public.fd_hash01(club_id::text || 'd') * 2)::int as d from public.standings) x
where x.club_id = s.club_id and s.competition_id in (:'cl', :'el') and s.group_id is not null;
update public.standings s set played = played
where s.competition_id in (:'cl', :'el') and s.group_id is not null;
select public.fd_europe_progress(:'world', s) from public.season_slots s where s.season_id = :'season' and s.slot_key = 'E6';
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'round_of_16') = 16, 'Achtelfinale: je Wettbewerb 8 Duelle');
select tests.assert((select count(*) from public.fixtures f join public.competition_stages st on st.id = f.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'round_of_16' and f.slot_key in ('E7', 'E8')) = 32, 'Achtelfinale mit Hin- und Rückspiel');
select tests.assert(not exists (select 1 from public.ties t join public.competition_stages st on st.id = t.stage_id
  join public.group_memberships ma on ma.club_id = t.club_a_id join public.group_memberships mb on mb.club_id = t.club_b_id
  join public.competition_groups ga on ga.id = ma.group_id join public.competition_groups gb on gb.id = mb.group_id
  where st.competition_id in (:'cl', :'el') and st.kind = 'round_of_16' and (ga.id = gb.id or ga.stage_id <> gb.stage_id)), 'Achtelfinale: Gruppensieger gegen Zweiten einer anderen Gruppe');
select tests.assert(not exists (select 1 from public.ties t join public.competition_stages st on st.id = t.stage_id
  join public.group_memberships m on m.club_id = t.club_a_id where st.competition_id in (:'cl', :'el') and st.kind = 'round_of_16'
  and (select pos from public.fd_group_table(m.group_id) x where x.club_id = t.club_a_id) <> 1), 'Gruppensieger mit Heimrecht im Rückspiel');
update public.ties t set winner_club_id = t.club_a_id from public.competition_stages st where st.id = t.stage_id and st.competition_id in (:'cl', :'el') and st.kind = 'round_of_16';
select public.fd_europe_progress(:'world', s) from public.season_slots s where s.season_id = :'season' and s.slot_key = 'E8';
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'quarter_final') = 8, 'Viertelfinale: je 4 Duelle');
update public.ties t set winner_club_id = t.club_b_id from public.competition_stages st where st.id = t.stage_id and st.competition_id in (:'cl', :'el') and st.kind = 'quarter_final';
select public.fd_europe_progress(:'world', s) from public.season_slots s where s.season_id = :'season' and s.slot_key = 'E10';
select tests.assert((select count(*) from public.ties t join public.competition_stages st on st.id = t.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'semi_final') = 4, 'Halbfinale: je 2 Duelle');
select tests.assert((select count(*) from public.fixtures f join public.competition_stages st on st.id = f.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'semi_final' and f.slot_key in ('E11', 'E12')) = 8, 'Halbfinale mit Hin- und Rückspiel');
update public.ties t set winner_club_id = t.club_a_id from public.competition_stages st where st.id = t.stage_id and st.competition_id in (:'cl', :'el') and st.kind = 'semi_final';
select public.fd_europe_progress(:'world', s) from public.season_slots s where s.season_id = :'season' and s.slot_key = 'E12';
select tests.assert((select count(*) from public.fixtures f join public.competition_stages st on st.id = f.stage_id where st.competition_id in (:'cl', :'el') and st.kind = 'final' and f.slot_key = 'E13' and f.neutral_venue) = 2, 'Finale auf neutralem Platz');
update public.ties t set winner_club_id = t.club_a_id from public.competition_stages st where st.id = t.stage_id and st.competition_id in (:'cl', :'el') and st.kind = 'final';
select public.fd_europe_progress(:'world', s) from public.season_slots s where s.season_id = :'season' and s.slot_key = 'E13';
select tests.assert((select count(*) from public.season_awards where season_id = :'season' and kind in ('cl_winner', 'el_winner')) = 2, 'Titelträger beider Wettbewerbe');
select tests.assert(exists (select 1 from public.financial_transactions where description like 'Champions League · Achtelfinale erreicht%'), 'Prämie Achtelfinale');
rollback;
\echo 'OK B0_europe32'
