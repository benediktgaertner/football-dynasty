-- 0036: E-Mail-Login – Umstellung anonymer Accounts ohne Datenverlust, Kontostatus, Löschschutz
\set ON_ERROR_STOP on
\set QUIET on
\set host '00000000-0000-0000-0000-0000000000a1'
\set guest '00000000-0000-0000-0000-0000000000b1'
begin;
-- Ausgangslage: beide Manager anonym (wie die bestehenden Accounts in Produktion)
update auth.users set is_anonymous = true, email = null, email_confirmed_at = null, email_change = '', encrypted_password = '' where id in (:'host', :'guest');
create temp table before_state as
  select (select count(*) from public.clubs where manager_user_id = :'host') clubs,
         (select count(*) from public.world_members where user_id = :'host') members,
         (select count(*) from public.players p join public.clubs c on c.id = p.club_id where c.manager_user_id = :'host') players,
         (select coalesce(sum(f.balance), 0) from public.finances f join public.clubs c on c.id = f.club_id where c.manager_user_id = :'host') balance,
         (select username from public.profiles where id = :'host') username;
grant select on before_state to authenticated;

-- Migration ist wiederholbar (Sicherung ergänzt nur)
\i :mig
select tests.assert((select count(*) from fd_backup.accounts_0036 where user_id = :'host') = 1, 'Sicherung: Account in fd_backup');
select tests.assert((select count(*) from fd_backup.ownership_0036 where user_id = :'host' and kind = 'club_manager') = (select clubs from before_state), 'Sicherung: Vereinszuordnung in fd_backup');

set role authenticated;
select tests.login(:'host');
select public.account_status() as st \gset
select tests.assert((:'st'::jsonb ->> 'is_anonymous')::boolean and not (:'st'::jsonb ->> 'has_password')::boolean and (:'st'::jsonb ->> 'clubs')::int >= 1, 'Status anonym: kein Passwort, Vereine gezählt');
select tests.assert(not (:'st'::jsonb ->> 'prompt_dismissed')::boolean, 'Aufforderung noch offen');
select public.dismiss_account_prompt();
select tests.assert((public.account_status() ->> 'prompt_dismissed')::boolean, 'Aufforderung serverseitig gemerkt (gilt geräteübergreifend)');
-- Sicherungstabellen sind für Nutzer nicht lesbar
select tests.expect_error($$ select * from fd_backup.accounts_0036 $$, 'permission denied');
-- Managername prüfen: eigener frei, fremder vergeben, ungültig
select tests.assert(public.username_available((select username from before_state)), 'eigener Managername gilt als frei');
reset role;
select username as guest_name from public.profiles where id = :'guest' \gset
set role anon;
select tests.assert(not public.username_available(:'guest_name'), 'vergebener Managername (auch ohne Anmeldung prüfbar)');
select tests.assert(not public.username_available('ab'), 'zu kurzer Name ungültig');
select tests.assert(public.username_available('Neuer Trainer 7'), 'freier Name');
select tests.expect_error($$ select public.account_status() $$, 'permission denied');
reset role;

-- Schritt 1 (Supabase Auth: updateUser({email})): Adresse vorgemerkt, noch nicht bestätigt
update auth.users set email_change = 'host@example.org' where id = :'host';
set role authenticated;
select tests.login(:'host');
select tests.assert(public.account_status() ->> 'pending_email' = 'host@example.org' and (public.account_status() ->> 'is_anonymous')::boolean, 'E-Mail vorgemerkt, Account weiter anonym und nutzbar');
select tests.assert((select count(*) from public.my_worlds()) = (select members from before_state), 'Fehlgeschlagene/abgebrochene Bestätigung: Welten weiter erreichbar');
-- fremder Manager sieht keine E-Mail des Hosts
select tests.login(:'guest');
select tests.assert(public.account_status() ->> 'user_id' = :'guest' and public.account_status() ->> 'pending_email' is null, 'Kontostatus nur für den eigenen Account');
select tests.assert(not exists (select 1 from information_schema.columns where table_schema = 'public' and column_name ilike '%email%'), 'keine E-Mail-Spalten in öffentlichen Tabellen');
reset role;

-- Schritt 2 (Bestätigungslink): gleiche auth.users.id, Adresse bestätigt, nicht mehr anonym
update auth.users set email = email_change, email_change = '', email_confirmed_at = now(), is_anonymous = false where id = :'host';
-- Schritt 3 (updateUser({password})): Passwort-Hash liegt nur in auth.users
update auth.users set encrypted_password = '$2a$10$abcdefghijklmnopqrstuv' where id = :'host';
set role authenticated;
select tests.login(:'host');
select public.account_status() as st \gset
select tests.assert(not (:'st'::jsonb ->> 'is_anonymous')::boolean and (:'st'::jsonb ->> 'has_password')::boolean and :'st'::jsonb ->> 'email' = 'host@example.org', 'umgestellt: E-Mail bestätigt, Passwort gesetzt');
select tests.assert(not (:'st'::jsonb ? 'encrypted_password'), 'Passwort-Hash wird nie ausgeliefert');
select tests.assert(:'st'::jsonb ->> 'user_id' = :'host', 'Benutzer-ID unverändert');
select tests.assert((select count(*) from public.my_worlds()) = (select members from before_state), 'nach Umstellung: alle Welten da');
reset role;
select tests.assert(
  (select clubs from before_state) = (select count(*) from public.clubs where manager_user_id = :'host')
  and (select players from before_state) = (select count(*) from public.players p join public.clubs c on c.id = p.club_id where c.manager_user_id = :'host')
  and (select balance from before_state) = (select coalesce(sum(f.balance), 0) from public.finances f join public.clubs c on c.id = f.club_id where c.manager_user_id = :'host')
  and (select username from before_state) = (select username from public.profiles where id = :'host'),
  'Vereine, Spieler, Finanzen und Managername vollständig erhalten');
-- zweiter Manager derselben Welt unverändert anonym und getrennt
select tests.assert((select is_anonymous from auth.users where id = :'guest') and exists (select 1 from public.world_members m join public.world_members h on h.world_id = m.world_id where m.user_id = :'guest' and h.user_id = :'host'), 'Mitspieler: eigener Account, gemeinsame Welt');

-- Neue anonyme Benutzer können keine Karriere mehr anlegen; bestehende anonyme Manager schon weiter umbenennen
insert into auth.users(id, is_anonymous) values ('00000000-0000-0000-0000-0000000000e9', true);
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000e9');
select tests.expect_error($$ select public.set_username('Anonym Neu') $$, 'email_required');
select tests.login(:'guest');
select tests.assert((public.set_username(:'guest_name')).username = :'guest_name', 'bestehender anonymer Manager behält vollen Zugriff');
reset role;
update auth.users set is_anonymous = false, email = 'neu@example.org', email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000e9';
set role authenticated;
select tests.login('00000000-0000-0000-0000-0000000000e9');
select tests.assert((public.set_username('Neu Mit Mail')).username = 'Neu Mit Mail', 'E-Mail-Account legt Profil an');
reset role;

-- Löschschutz: Benutzer mit Karriere kann nicht versehentlich gelöscht werden
select tests.expect_error(format($$ delete from auth.users where id = %L $$, :'guest'), 'profiles_id_fkey');
select tests.assert(exists (select 1 from public.profiles where id = :'guest') and (select count(*) from public.world_members where user_id = :'guest') > 0, 'nach Löschversuch: Profil und Mitgliedschaft erhalten');
-- Konflikt: gleiche E-Mail kann keinem zweiten Account gehören
select tests.expect_error(format($$ update auth.users set email = 'HOST@example.org' where id = %L $$, :'guest'), 'users_email_key');
rollback;
\echo 'OK E0_accounts'
