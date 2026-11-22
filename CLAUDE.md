# Football Dynasty – Projektregeln für Claude

Deutscher Browser-Multiplayer-Fußballmanager, iPad-first, UI auf Deutsch.
- **Frontend:** React/TS/Vite in `apps/web`, gehostet auf Netlify; Netlify-Funktionen liegen in `netlify/`.
- **Datenbank:** Supabase Postgres mit RLS und RPCs (`supabase/migrations`).
- **Match-Server:** autoritativer Node-Server in `apps/match-server`, läuft auf Fly.io (App `football-dynasty`).
- **Gemeinsamer Code:** Engine in `packages/engine`, geteilte Regeln in `packages/shared`.
- **Antwortstil:** kurz und direkt auf Deutsch.

## Modelle & Agents (günstigstes Modell, das es zuverlässig kann)
| Agent | Modell | Wofür |
|---|---|---|
| `explorer` | Haiku | Suchen, Verwendungen finden, Logs auswerten, Zusammenfassungen (nur lesen) |
| `documentation` | Haiku | docs/*.md, Deploy-Anleitungen, Changelogs |
| `developer` | Sonnet | Implementierung (React/TS, UI, Stadion, Audio, Transfers, Supabase/SQL, Match-Server), Fixes |
| `tester` | Sonnet | Tests schreiben/ausführen (Vitest, DB, Playwright), Abnahme gegen Kriterien |
| `architect` | Opus | NUR komplexe Architektur, Engine/Multiplayer/DB-Entscheidungen, Eskalation, Review riskanter Änderungen |

**Hauptsitzung:** `opusplan` (Opus im Planmodus, Sonnet bei der Ausführung).
- **Kleinigkeiten:** direkt erledigen, ohne Agent.
- **Agents:** keine parallelen Agents ohne Not. Agents rufen keine weiteren Agents auf.
- **Doppelarbeit vermeiden:** Opus wiederholt keine Arbeit, die schon erledigt und geprüft ist.

## Entwicklungsloop (`/dev <Auftrag>`)
1. Akzeptanzkriterien festlegen und in kleine Schritte zerlegen.
2. Modell wählen: `explorer` → `developer`; bei kritischen Fragen vorher `architect`.
3. Schritt umsetzen.
4. Gezielt prüfen mit `node .claude/hooks/check.mjs <dateien>`. Das Skript führt den Typecheck der betroffenen Workspaces und `vitest related` aus.
5. Fehler gezielt beheben, höchstens 3 Versuche je Fehler. Danach den Befund dokumentieren und an `architect` übergeben.
6. Ende, wenn alle Kriterien ✓ sind oder ein echter Blocker vorliegt. Keine identischen Testläufe ohne Codeänderung.

**Automatisch (Hooks):**
- **Bearbeitungen:** Geänderte Dateien werden vorgemerkt.
- **Am Ende jeder Antwort:** Der Stop-Hook prüft die vorgemerkten Dateien.
  - Bei Fehlern arbeitet Claude weiter, maximal 3 Runden.
  - Danach steht der Befund in `.claude/state/blocked.md`.

## Prüfkommandos
- Typecheck gesamt: `npm run typecheck`
- Unit-Tests: `npm test`
- Web gezielt: `cd apps/web && npx vitest related --run <dateien>`
- DB (lokales Postgres, alle Migrationen und SQL-Tests): `bash scripts/test-db.sh`. Pflicht bei SQL-Änderungen.
- E2E Match/Audio: `npm run e2e -w @fd/web`. Gezielt mit `-g "<Name>"`, das ist teuer, also nur bei UI-, Match- oder Audio-Änderungen.
- E2E Login: `npm run e2e:auth -w @fd/web`
- Offline-Audiotests brauchen `node-web-audio-api`. Installation: `npm i --no-save node-web-audio-api` im Repo-Hauptordner.

## Schutzregeln (immer)
- **Spiellogik:** Match-Balancing, Heimvorteil, KI-Stärke und Engine-Konstanten nicht unbeabsichtigt ändern.
- **Karrieren:**
  - Bestehende Karrieren, Multiplayer-Daten, Vereinsdateien und Audio-Uploads erhalten.
  - Migrationen idempotent schreiben, ohne Datenverlust.
  - RLS nie pauschal deaktivieren, keine öffentlichen Schreibrechte vergeben.
- **Produktion:**
  - Keine Produktivdaten (Supabase-Projekt `hhqdkqmlpsnfexcfgeaf`) ohne ausdrückliche Freigabe ändern oder löschen. Über MCP nur lesen.
  - SQL immer als Datei für den Nutzer bereitstellen.
- **Deploy:** Keine Deployments, kein `git push` und keine Secrets ohne ausdrückliche Freigabe. Der Hook `guard.mjs` fragt nach.
- **Schlüssel:** Den Service-Role-Key nie im Frontend oder in `VITE_*`. Nutzer nicht nach Secrets im Chat fragen.
- **Kosten:**
  - Keine unnötigen Supabase-Abfragen und keine Hintergrundsimulationen.
  - Keine Simulation ausländischer Ligen, die niemand sieht.
  - Keine bezahlten Audio-APIs.
- **Audio:** KI-Fangesänge kommen nur aus `apps/web/public/audio/chants/ai` (Nutzerdateien). Keine synthetischen Gesänge.

## Lieferformat an den Nutzer
- Pro Paket genau **eine SQL-Datei** (falls nötig, sonst ausdrücklich „kein SQL“) und **eine Zip**.
- Deploy beim Nutzer:
  1. SQL im Supabase-SQL-Editor ausführen.
  2. Zip-Inhalt ins Repo kopieren und pushen; Netlify baut automatisch.
  3. Fly nur bei Änderungen am Match-Server: `& "$env:USERPROFILE\.fly\bin\flyctl.exe" deploy -a football-dynasty`.
- Gelöschte Dateien ausdrücklich nennen, weil das Kopieren der Zip nichts entfernt.

## Wichtige Orte
- **Audio:** `apps/web/src/lib/audioMixer.ts` (Mixer), `fanAudio.ts` (Stadionton), `fanMood.ts` + `fanMoodData.ts` (Stimmungs-Matrix).
  - Die Matrix wird aus `docs/*.xlsx` mit `python3 scripts/import-fan-matrix.py` erzeugt.
  - Die Stadionaufnahmen werden mit `scripts/crowd-audio.mjs` aufbereitet.
- **Login:** `apps/web/src/lib/auth.tsx`, `account.ts`, `components/SecureAccount.tsx`, Doku in `docs/LOGIN.md`.
- **Doku:** `docs/` mit DEPLOYMENT, TESTING, SAISONBETRIEB, LOGIN und CROWD_AUDIO.
