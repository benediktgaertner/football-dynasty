# Login mit E-Mail und Passwort

## Ablauf

**Neue Manager**
1. „Registrieren“ mit Managername, E-Mail und Passwort.
2. Bestätigungsmail öffnen. Danach sind sie angemeldet, und der Managername wird automatisch übernommen.
3. Danach melden sie sich auf jedem Gerät mit E-Mail und Passwort an.
4. Außerdem gibt es „Passwort vergessen“ und einen Anmeldelink per E-Mail.

**Bestehende anonyme Manager** werden nach dem nächsten Öffnen einmal aufgefordert: „Sichere deinen Account …“. Das „Später“ wird serverseitig gespeichert und gilt für alle Geräte. Auf der Startseite bleibt ein Hinweis stehen.
1. E-Mail hinterlegen. Dafür ruft die App `updateUser({ email })` am bestehenden Benutzer auf. Die Sitzung bleibt bestehen, und der Account ist weiter anonym nutzbar.
2. Link bestätigen, gern auch auf einem anderen Gerät. Die Adresse gehört jetzt zum **selben** Benutzer, die `auth.users.id` bleibt unverändert.
3. Passwort festlegen mit `updateUser({ password })`.

Es entsteht kein zweiter Account und keine neue Karriere. Es werden keine Daten umgehängt.

**Fehlerfälle**
- **Adresse gehört bereits einem anderen Account:** Es erscheint eine Meldung, sonst ändert sich nichts. Accounts werden nicht zusammengeführt.
- **Link abgelaufen oder ungültig:** Es erscheint ein Hinweis, die bisherige Sitzung bleibt erhalten.
- **Netzwerkfehler:** Die App zeigt „Erneut versuchen“ statt der Anmeldemaske. So kann eine ungesicherte Sitzung nicht durch eine neue Anmeldung überschrieben werden.
- **Fremde Anmeldung auf diesem Gerät:** Wird ein ungesicherter Account dadurch verdrängt, bietet die App die Rückkehr an („Zu diesem Account wechseln“). Dafür merkt sie sich die Sitzung des ungesicherten Accounts lokal. Nach dem Sichern wird dieser Eintrag gelöscht.
- **Verlorene Browserdaten vor dem Sichern:** Für diesen Notfall gibt es `scripts/admin-link-email.mjs`. Der Betreiber führt es nur lokal und nur nach persönlicher Prüfung aus.

**Synchronisierung:** Welten, Vereine und Mitgliedschaften hängen ausschließlich an `auth.uid()`, also an der serverseitigen Benutzeridentität. Im Browser liegen nur Toneinstellungen und das Farbschema.

**Datenschutz:**
- E-Mail-Adressen stehen nur in `auth.users`.
- Das RPC `account_status()` liefert nur die eigene Adresse.
- Andere Manager sehen nur den Managernamen.
- Passwörter gehen ausschließlich an Supabase Auth.

## Migration 0036 (`football_dynasty_update_0036.sql`)

Die Migration macht Folgendes:
- **Sicherung:** Accounts und Zuordnungen (Mitgliedschaften, Vereinsmanager, Host, Manager) werden in `fd_backup.accounts_0036` und `fd_backup.ownership_0036` kopiert. Diese Tabellen sind nicht über die API erreichbar.
- **Löschschutz:** `profiles_id_fkey` wird auf `on delete restrict` umgestellt. Vorher hätte das Löschen eines auth-Benutzers Profil und Mitgliedschaften mitgelöscht und die Vereine ohne Manager zurückgelassen.
- **Neue Felder und RPCs:** `profiles.account_prompt_dismissed_at`, dazu die RPCs `account_status()`, `dismiss_account_prompt()` und `username_available()`.
- **Neue Karrieren nur mit E-Mail:** `set_username` lehnt anonyme Benutzer *ohne* Profil ab. Bestehende anonyme Manager spielen unverändert weiter.
- **Was unverändert bleibt:** Benutzer und Spieldaten werden nicht verändert. Die Migration ist wiederholbar und zeigt am Ende eine Kontrollzeile.

## Einstellungen in Supabase (Dashboard)

1. **Backup vor der Migration.** Im Free-Plan gibt es kein herunterladbares Backup, deshalb lokal sichern:
   ```bash
   npx supabase db dump --db-url "<Connection string (Session pooler) aus Project Settings → Database>" -f backup_schema.sql
   npx supabase db dump --db-url "<…>" --data-only --schema public,auth -f backup_data.sql
   ```
2. **Authentication → Sign In / Providers → Email:**
   - Email aktiviert
   - **Confirm email: AN**
   - **Secure email change: AN**
   - **Secure password change: AUS lassen** (Standard). Die Kontosicherung käme mit Code-Abfrage zurecht, die Seite „Passwort ändern“ fragt aber keinen Code ab.
   - **Minimum password length: 8**
   - **Password requirements: „Letters and digits“**
3. **Allow anonymous sign-ins: vorerst AN lassen.** Die App legt keine anonymen Accounts mehr an, und neue anonyme Benutzer können seit 0036 keine Karriere starten. Bestehende anonyme Manager behalten so ihre Sitzung, bis alle gesichert sind. Erst danach ausschalten.
4. **Authentication → URL Configuration:**
   - **Site URL:** `https://<deine-seite>.netlify.app` (bzw. eigene Domain)
   - **Redirect URLs:**
     - `https://<deine-seite>.netlify.app/**`
     - optional für Vorschauen: `https://*--<deine-seite>.netlify.app/**`
     - für lokal: `http://localhost:5173/**`
5. **Eigener SMTP-Server (Pflicht für echte Nutzer).**
   - Wo: Authentication → Emails → SMTP Settings.
   - Grund: Der eingebaute Mailversand von Supabase schickt nur an Mitglieder des Projektteams und ist stark begrenzt.
   - Kostenlose Anbieter sind z. B. Brevo oder Resend.
   - Absender: z. B. `noreply@deine-domain`.
   - Danach unter Authentication → Rate Limits „Emails per hour“ passend erhöhen, z. B. auf 30.
6. **E-Mail-Vorlagen (Authentication → Emails → Templates), auf Deutsch:**
   - *Confirm signup:* Betreff „Bestätige deine Anmeldung bei Football Dynasty“, Link `{{ .ConfirmationURL }}`
   - *Change email address:* „Bestätige deine E-Mail-Adresse für Football Dynasty“, Link `{{ .ConfirmationURL }}`
   - *Reset password:* „Neues Passwort für Football Dynasty“, Link `{{ .ConfirmationURL }}`
   - *Magic link:* „Dein Anmeldelink für Football Dynasty“, Link `{{ .ConfirmationURL }}`
   - *Reauthentication* (nur bei „Secure password change“): Code `{{ .Token }}`
7. **Sessions:** Standard lassen, also keine Zeitbegrenzung und kein Inaktivitäts-Timeout. Sonst würden anonyme Sitzungen ablaufen, bevor sie gesichert sind.
8. Optional: **Bot-Schutz** (Authentication → Attack Protection → CAPTCHA). Das braucht zusätzlichen Frontend-Code und ist nicht enthalten.

## Deployment

1. Backup (siehe oben).
2. SQL-Editor: Inhalt von `football_dynasty_update_0036.sql` einfügen und ausführen. Die Kontrollzeile muss `loeschschutz_aktiv = true` zeigen.
3. Supabase-Einstellungen 2–6 setzen.
4. Netlify: Inhalt der Zip ins Repo, pushen. Es gibt keine neuen Umgebungsvariablen; `VITE_SUPABASE_URL` und `VITE_SUPABASE_ANON_KEY` bleiben.
5. Fly.io: kein Deploy nötig. Der Match-Server prüft Tokens über Supabase und akzeptiert E-Mail-Accounts genauso.
6. Test in Produktion: Mit einem anonymen Altaccount anmelden → Aufforderung → E-Mail → Link → Passwort. Danach in einem privaten Fenster mit E-Mail und Passwort anmelden; derselbe Verein ist zu sehen.

## Tests

- `bash scripts/test-db.sh` enthält `E0_accounts.sql`:
  - Umstellung ohne Datenverlust (gleiche ID, Vereine, Spieler und Finanzen erhalten)
  - abgebrochene Bestätigung
  - Kontostatus nur für den eigenen Account
  - Löschschutz, E-Mail-Konflikt
  - keine neuen anonymen Karrieren
- `npm run e2e:auth -w @fd/web` (Playwright, `apps/web/e2e/auth/`) deckt alle sechs Pflichtfälle ab:
  1. Registrierung
  2. Umstellung des Altaccounts
  3. neues Gerät
  4. zwei Manager einer Welt
  5. Fehlerfälle (belegte Adresse, abgelaufener Link, fremde Anmeldung)
  6. Passwort vergessen

  Die Tests laufen gegen eine lokale PostgreSQL mit allen Migrationen und RLS. Supabase Auth und REST werden dabei durch `mockSupabase.ts` ersetzt, der das Verhalten von GoTrue nachbildet. Es wird nichts in Produktion angelegt und keine Mail verschickt. Gegen das echte Supabase Auth hilft deshalb nach dem Deploy der Produktionstest aus Schritt 6.
