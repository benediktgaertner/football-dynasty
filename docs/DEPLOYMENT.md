# Deployment

Drei Bausteine:

1. **Supabase**: Datenbank, Auth, Realtime
2. **Netlify**: Web-App
3. **Fly.io**: Match-Server

Zugangsdaten werden nirgends im Code gespeichert. Alle Werte kommen aus Umgebungsvariablen (siehe `.env.example`).

## 1. Supabase

1. Projekt anlegen (Postgres **15 oder neuer**, weil das Schema `unique nulls not distinct` nutzt; neue Projekte erfüllen das).
2. **Authentication → Sign In / Providers**:
   - **Allow anonymous sign-ins** aktivieren (A2: Einstieg nur mit Benutzernamen).
   - **Email** aktiviert lassen, inklusive „Confirm email“. Darüber sichern Manager ihr Konto und stellen es auf anderen Geräten wieder her.
   - Empfohlen: CAPTCHA (Turnstile oder hCaptcha) gegen massenhaft angelegte anonyme Konten.
3. **Authentication → URL Configuration**: Als *Site URL* die Netlify-Adresse eintragen und `http://localhost:5173` als zusätzliche Redirect-URL.
4. Migrationen einspielen. Am einfachsten geht das mit der Supabase-CLI:
   ```bash
   npx supabase login
   npx supabase link --project-ref <projekt-ref>
   npx supabase db push        # spielt supabase/migrations/* in Reihenfolge ein
   ```
   Alternativ kopierst du die Dateien aus `supabase/migrations` in aufsteigender Reihenfolge in den SQL-Editor.
5. Unter **Project Settings → API** findest du die URL, den Anon- bzw. Publishable-Key (fürs Frontend) und den Service-Role- bzw. Secret-Key (nur für den Match-Server).

> Neue Tabellen in späteren Migrationen müssen RLS einschalten. Supabase vergibt für neue Tabellen und Funktionen standardmäßig Rechte an `anon` und `authenticated`. Der Datenbanktest `10_lobby_and_security.sql` prüft, dass RLS überall aktiv ist und Clients nirgends direkt schreiben können.

## 2. Netlify (Web-App)

1. „Add new site → Import from Git“ wählen und dieses Repository verbinden. `netlify.toml` gibt Build-Befehl und Publish-Ordner vor.
2. **Site configuration → Environment variables** setzen:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` (öffentlicher Schlüssel, **nicht** der Service-Role-Key; die App bricht ab, wenn versehentlich einer eingetragen ist)
   - `VITE_MATCH_SERVER_URL` (ab Phase 5/6)
   - `SUPABASE_SERVICE_ROLE_KEY` (ab Phase 3, **ohne** `VITE_`-Präfix, Scope „Functions“). Ihn braucht nur die serverseitige Function `/api/start-draft`, die beim Draft-Start die Welt erzeugt. Er landet nie im Browser.
3. Deploy auslösen. Ohne die Variablen zeigt die App eine Seite an, die genau die fehlenden Werte nennt.

### Netlify Functions

`netlify/functions/start-draft.mts` läuft unter `/api/start-draft`. Sie prüft das Token des Hosts, erzeugt mit `packages/shared` aus dem Welt-Seed alle KI-Vereine, Kader und den Draft-Pool und speichert das Ergebnis über `admin_start_draft()` in einer Transaktion. Lokal lässt sie sich mit `npx netlify dev` testen.

`netlify/functions/ensure-europe.mts` läuft unter `/api/ensure-europe` (gleicher Schlüssel, keine neue Variable). Sie ergänzt eine Welt Verband für Verband um die Erstligen aller übrigen UEFA-Verbände (Vereine, Wappen, Stadien, vollständige Kader, einige vereinslose Spieler). Die Transferseite ruft sie automatisch auf, solange Verbände fehlen; jeder Aufruf arbeitet höchstens ca. 6,5 s, `admin_add_europe()` ist idempotent. Bestehende Karrieren, Kader, Transfers und Finanzen bleiben unverändert.

## 3. Fly.io (Match-Server)

```bash
fly auth login
fly launch --no-deploy --copy-config      # App-Namen in fly.toml übernehmen bzw. anpassen
fly secrets set SUPABASE_URL=https://<projekt>.supabase.co \
                SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
                ALLOWED_ORIGINS=https://<seite>.netlify.app
fly deploy
curl https://<app>.fly.dev/health
```

Danach in **Netlify** die Variable `VITE_MATCH_SERVER_URL=https://<app>.fly.dev` setzen und neu deployen („Clear cache and deploy site“). Die Web-App verbindet sich per WebSocket mit `wss://<app>.fly.dev/match`; `ALLOWED_ORIGINS` muss die Netlify-Adresse exakt enthalten (ohne Schrägstrich am Ende).

Die Partien leben im Speicher genau einer Maschine. Deshalb sind in `fly.toml` `min_machines_running = 1` und `auto_stop_machines = "off"` gesetzt. Für die geplante Größe (eine Freundesrunde, mehrere Welten) reicht `shared-cpu-1x` mit 512 MB.

### Spieltagssteuerung
Der Match-Server prüft alle 10 s selbst alle Welten mit laufendem Spieltag (optional `SWEEP_INTERVAL_MS`).
Dafür muss mindestens eine Maschine laufen (`min_machines_running = 1`, bereits gesetzt).

## Kosten

Stand 18.11.2026, bitte vor dem Start aktuelle Preise prüfen.

| Dienst | Tarif | ca. Kosten/Monat |
|---|---|---|
| Netlify | Free | 0 € |
| Supabase | Free für den Start; Pro, wenn das Projekt nie pausieren soll und mehr Kontingent braucht | 0 € bzw. ca. 25 $ |
| Fly.io | 1 × shared-cpu-1x, 512 MB, dauerhaft an | ca. 3,70 $ (256 MB ab ca. 2,19 $) |

**Zusätzliche Hostingkosten durch den separaten Echtzeitserver** (gegenüber reinem Netlify): ca. 2–4 $ pro Monat. Hinzu kommt gegebenenfalls Supabase Pro, das aber unabhängig von der Architekturentscheidung ist.

Zur Einordnung: Netlify Server, das neue WebSocket-fähige Angebot, ist während der Early Access kostenlos. Die Preise für die allgemeine Verfügbarkeit stehen noch nicht fest (siehe [ARCHITECTURE.md](ARCHITECTURE.md)).

## Lokale Entwicklung

```bash
cp .env.example .env        # Werte eines Supabase-Entwicklungsprojekts eintragen
npm install
npm run build -w @fd/shared
npm run dev:web             # http://localhost:5173
npm run dev:server          # http://localhost:2567/health
```

## Update 0030 (aktive Länder, Europapokal, Fankultur, Stadionsound)
1. **Supabase:**
   - SQL-Editor → New query → Inhalt von `football_dynasty_update_0030.sql` einfügen → Run.
   - Die Datei ist wiederholbar, enthält Migration `20261125000030` und legt den Speicher-Bucket `club-audio` an.
2. **GitHub/Netlify:** Zip-Inhalt ins Repository kopieren und pushen. Netlify baut die Web-App, neue Umgebungsvariablen sind nicht nötig.
3. **Fly.io (Match-Server):** neu deployen, wegen Einlaufzeremonie und Fehlerbehandlung:
   `& "$env:USERPROFILE\.fly\bin\flyctl.exe" deploy -a football-dynasty`
4. **Kontrolle nach dem nächsten Spieltag (SQL-Editor):**
   `select * from public.admin_sim_report((select id from public.career_worlds where name = 'Das Clan Haus'));`
Keine Schlüssel nötig, keine laufenden Kosten: Musik entsteht im Browser oder kommt als hochgeladene MP3.

## Update 0031 (MP3-Upload-Fix, Ultras, Fahnen, Trikots, Spielvorbereitung)
1. **Supabase:** SQL Editor → New query → `football_dynasty_update_0031.sql` → Run. Die Datei ist wiederholbar und repariert die Storage-Policies.
2. **GitHub/Netlify:** Zip-Inhalt ins Repository kopieren und pushen.
3. **Fly.io:** Ein Deploy ist nicht nötig, der Match-Server liest die Trikots aus der Datenbank.
