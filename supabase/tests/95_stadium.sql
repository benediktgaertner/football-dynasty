-- Stadiondesign: kostenlos, validiert, im Match-Setup mit realer Zuschauerzahl
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
select id as host_club from public.clubs where world_id = :'world' and manager_user_id = :'host' \gset
select balance as bal from public.finances where club_id = :'host_club' \gset
select count(*) as ntx from public.financial_transactions where club_id = :'host_club' \gset
set role authenticated;
select tests.login(:'host');
select public.save_stadium_design(:'world', '  Arena   am Fluss ', '{"style":"arena","stand":"#334455","seat":"#aa0000","accent":"#ffcc00","club_colors":false,"roof":true}'::jsonb);
select tests.expect_error(format($$ select public.save_stadium_design(%L, 'Ok Name', '{"style":"ufo"}'::jsonb) $$, :'world'), 'invalid_design');
select tests.expect_error(format($$ select public.save_stadium_design(%L, 'Ok Name', '{"stand":"rot"}'::jsonb) $$, :'world'), 'invalid_design');
select tests.expect_error(format($$ select public.save_stadium_design(%L, 'X', '{}'::jsonb) $$, :'world'), 'invalid_name');
reset role;
select tests.assert((select name from public.stadiums where club_id = :'host_club') = 'Arena am Fluss', 'Name gespeichert (bereinigt)');
select tests.assert((select design ->> 'style' from public.stadiums where club_id = :'host_club') = 'arena', 'Design gespeichert');
select tests.assert((select balance from public.finances where club_id = :'host_club') = :bal, 'kostenlos');
select tests.assert((select count(*) from public.financial_transactions where club_id = :'host_club') = :ntx, 'keine Buchung durch das Design');
-- Match-Setup eines Heimspiels: Stadion mit Design und Zuschauerzahl = Nachfrageberechnung
select f.id as hfx from public.fixtures f join public.competitions c on c.id = f.competition_id
where f.home_club_id = :'host_club' and f.status = 'scheduled' and c.kind::text <> 'friendly' and not f.neutral_venue order by f.scheduled_date limit 1 \gset
select tests.assert((public.fd_expected_attendance(:'hfx')) > 0, 'Zuschauernachfrage berechnet');
