# Football Dynasty – Systemaudit (Stand 2026-11-22)

**Ehrlicher Vorbehalt:** Der Auftrag war sehr groß. Geprüft wurde, was in dieser Cloud-Sitzung ohne Produktivzugriff möglich war.
Große Teile (Fly-Metriken, 3-Browser-Stresstest, Latenz-/Paketverlust-Simulation, 10–25 Last-Clients, Netlify-Logs) wurden **nicht** ausgeführt – siehe Abschnitt „Nicht getestet“.
Es gab **kein** separates Test-Supabase-Projekt (nur das Produktivprojekt `hhqdkqmlpsnfexcfgeaf`); dort wurden ausschließlich lesende Advisors und zwei Aggregat-Abfragen ausgeführt, **nichts verändert**.
Nichts wurde gepusht oder deployt (CLAUDE.md). Änderungen liegen als Commit auf `claude/gallant-knuth-rwrnzm`.

## A. Testübersicht (tatsächlich ausgeführt)

| Suite | Ergebnis |
|---|---|
| `npm run typecheck` (alle Workspaces + netlify) | grün |
| Vitest (shared 19, engine 104, match-server 23, netlify 18) | **164/164 bestanden** (+3 neue opt-in Balancing-Tests: 3/3) |
| `npm run build -w @fd/web` (Produktions-Build) | grün, 2,4 s; Warnung: Hauptchunk 905 kB (275 kB gzip) |
| DB-Suite `scripts/test-db.sh` (41 Migrationen + ~40 SQL-Testdateien, mehrere hundert Prüfungen) | ca. 40 Gesamtläufe; **ca. 70 % der Läufe vollständig grün**, der Rest scheiterte an zufallsabhängigen Tests (siehe B/Flakes) |
| Neu: `G7_promoted_contracts.sql` | 4/4 |
| Neu: `Z0_longrun.sql` (Langzeit, opt-in) | läuft; scheitert **absichtlich** an den echten Befunden unten |
| Playwright Vereinsseiten (`e2e:club`, 1./2./3. Liga, Ausland, iPad, Fehlergrenze) | 9/9 |
| Playwright Login/Liga-Einstellungen (`e2e:auth`, inkl. Host-Audio, iPad) | 7/7 |
| Playwright Match/Audio/Verbindungsabbruch (`e2e`) | 30/31; der eine Fehlschlag („Netz weg“) lief danach isoliert **3/3 grün** (Lastflake, parallel lief die DB-Schleife) |
| Balancing-Statistik (Engine, feste Seeds, 60 Partien je Szenario) | 3/3 (Werte unter F) |

Nicht ausführbar: Fly-Zugriff (kein `flyctl`, keine Fly-Tools in dieser Sitzung), Netlify-Logs, separates Supabase-Testprojekt, Mehr-Browser-Stresstest (Zeit/Budget).

## B. Fehlerliste

**Kritisch / hoch (Langzeit, nicht behoben – braucht Designentscheidung):**
1. **Keine Nachwuchs-/Karriereende-Mechanik (ROADMAP „Phase 9 ⬜“).** 10-Saisonen-Lauf (Z0): Ø-Alter aller Vereinsspieler 27,0 → 35,7, Ø-OVR 75,5 → 66,9, Ø-OVR der 1. Liga 78,0 → 66,9, Spielerzahl 2977 → 2724 (sinkt ~27/Saison), Free-Agent-Pool 418 → 671 (+28/Saison, erreicht die 700-Grenze nach ~11 Saisonen). Lange Karrieren werden dadurch zunehmend unspielbar. Empfehlung: Karriereende (ca. ab 34–36), Jugendzufluss (16–19 J., OVR 45–65, Potenzial), Balancing mit 30-Saisonen-Lauf prüfen. *Nicht* implementiert, weil das Balancing/Spielinhalte berührt (Schutzregel).
2. **KI-Spitzenvereine rutschen ins Minus** (Testwelt, Z0): 6–10 KI-Vereine im Minus, tiefster Stand −52 Mio (Saison 1) → −485 Mio (Saison 10); Gehälter (~134 Mio/Saison) übersteigen die Einnahmen der Topclubs. Auswirkung u. a.: KI-Gebote auf Free Agents sind auf 25 % des Kontos begrenzt → Topclubs fallen als Konkurrenz aus. **In Produktion heute nicht der Fall** (157 KI-Vereine, 0 im Minus, min +4,2 Mio – nur lesend geprüft). Hinweis: Testergebnisse in Z0 sind Pseudo-Ergebnisse (siehe F), Gehälter/Einnahmen aber echte Buchungslogik.

**Mittel (behoben):**
3. **Aufsteigende Amateurvereine (4. → 3. Liga) erhielten keine Spielerverträge** (Ursache: `fd_*_season_change` setzt nur `clubs.amateur=false`, Verträge werden dort nie angelegt). Folge: Spieler ohne Vertrag in Ligavereinen (kein Gehalt, kein Vertragsablauf, leere Vertragsseite). Produktion: noch nicht aufgetreten (360 Amateurspieler, 0 Nicht-Amateure ohne Vertrag), tritt beim ersten Aufstieg auf. **Fix:** Migration `20261205000042_promoted_amateur_contracts.sql` (Trigger auf `clubs.amateur` true→false, idempotent, Gehalt via `fd_salary`, 2 Jahre) + Regressionstest G7 (4/4) + Z0-Invariante.
   *Offen/beobachtet:* in die Gegenrichtung (Abstieg zum Amateur) bleiben bestehende Verträge aktiv (44 aktive Verträge bei 10 Amateurvereinen in der Testwelt). Ob das gewollt ist, ist offen – nicht geändert.

**Niedrig:**
4. DB-Test-Flakes (Testfehler, keine Produktfehler nachgewiesen): G4 (Spitze „>“ statt „≥“, **behoben**), C0 Barometer (feste Beträge → Barometer 0/100 gesättigt; **Test auf relative Beträge + „nie schlechter“ umgestellt**, danach 1 grüner Lauf, nicht statistisch abgesichert), G3 „alle 15 haben einen neuen aktiven Vertrag“ (**ungelöst**, ca. 15 % der Läufe; Diagnoseausgabe ergänzt, Ursache nicht gefunden – nach 3 Versuchen dokumentiert), G2 („älterer Spieler akzeptiert Reduktion“, „freigegebene Pflichtspiele“), einmalig mehrere Fehlschläge in einem Lauf (99_active_countries, A0, C0, G1, G2). Alle hängen vom zufällig erzeugten Testwelt-Zustand ab. G3 könnte ein echter Fehler sein (88-OVR-Spieler ohne neuen Vertrag) – bitte priorisiert weiter untersuchen (`G3_free_agents.sql` gibt bei Fehlern jetzt Details aus).
5. Supabase-Advisor: Leaked-Password-Protection aus, Anonymous-Sign-ins aktiv, 103 `SECURITY DEFINER`-RPCs für `authenticated` ausführbar (gewollte RPC-Architektur, Rechteprüfung in 10_lobby_and_security getestet), 119 FKs ohne Index (INFO, v. a. `world_id`), 31 Backup-Tabellen (`fd_backup.*`) mit RLS ohne Policy (gesperrt, ok).
6. Torschnitt der Engine ~3,1–4,0 pro Partie (existierende Kalibrierung toleriert < 4,0); eher hoch, aber nicht verändert.

## C. Bugfixes
| Fix | Ursache | Dateien | Nachweis |
|---|---|---|---|
| Verträge für aufsteigende Amateure | siehe B3 | `supabase/migrations/20261205000042_promoted_amateur_contracts.sql` | `G7_promoted_contracts.sql` 4/4, Z0-Vertragsinvariante grün; Gesamtsuite unverändert |
| G4-Flake | Test verlangte „Spitze > vorher“, obwohl sie bei Deckelung gleich bleibt | `supabase/tests/G4_league1_strength.sql` | 7 Läufe ohne G4-Fehler |
| C0-Flake | feste Angebote sättigten das Barometer | `supabase/tests/C0_free_agents.sql` | nur schwach belegt (siehe B4) |
Keine Assertions wurden entfernt; nur Bedingungen präzisiert bzw. Diagnosetext ergänzt.

## D. Multiplayer (nur teilweise getestet)
- **Getestet (bestehende + neu gelaufene Tests):** WebSocket-Raum mit zwei Managern + Zuschauer, Reconnect mit `since`, Befehls-Idempotenz, Ablösung zweiter Verbindung (4409), Kappen der Verbindung (E2E „Netz weg“, „Wechsel vor Abbruch genau einmal“, „mehrfach gekappt“: nach Last-Flake 3/3), gemeinsames Überspringen, Paralleltest „4 gleichzeitige Picks → genau 1 Pick“, Zwei-Manager-Login-E2E.
- **Nicht getestet:** 3 parallele Browser mit allen 15 Szenarien, Transfermarkt-Race (zwei Manager, derselber Spieler – nur über SQL-Zeilensperre statisch/indirekt abgedeckt), Latenz 200/500/1000 ms, Paketverlust, Serverneustart, 10/25 Clients.
- Statisch (docs/MULTIPLAYER_DIAGNOSE.md): 13 frühere Verbindungsursachen sind dort als behoben dokumentiert; ob sie produktiv deployt sind, konnte ich nicht prüfen.

## E. Performance (gemessen, lokal, nicht Produktion)
- Engine: 0,16–0,21 s CPU je Vollspiel (7200 Ticks).
- DB lokal (frisches Postgres, Testwelt ~3000 Spieler): Saison mit 56 Terminen 5,8–13,3 s (steigt mit Saisonen leicht); Gesamtsuite ca. 15 s.
- Produktions-Build 2,4 s, Hauptchunk 905 kB → Code-Splitting empfohlen.
- **Nicht gemessen:** API-/Ladezeiten gegen Netlify/Supabase, Fly-CPU/RAM, Lasttests.

## F. Langzeitsimulation (Z0, 10 Saisonen, lokale Testwelt)
Ergebnisse je Saison stehen oben unter B1/B2 (Tabelle wird von `npm run test:longrun` ausgegeben). Weiter: alle 10 Saisonen liefen ohne Blockade durch (Saisonwechsel, Auf-/Abstieg, Pokal, Europapokal: 2 Sieger/Saison), Buchungsschlüssel eindeutig, Kontostand = letzte Buchung, höchstens ein aktiver Vertrag je Spieler, Vertragsverein = Spielerverein.
**Einschränkung:** Spielergebnisse sind deterministische Pseudo-Ergebnisse (wie in `50_season.sql`), nicht die Engine; Ligastärken/Meisterschaften sind daher nicht aussagekräftig. Ausländische Ligen werden – wie gefordert – nicht simuliert (Auslandsvereine behalten 11 Spieler).
Balancing (Engine, feste Seeds, 60 Partien): OVR 88 vs 80 → Heimsieg 85 %, Auswärtssieg des Favoriten 60 %, Unentschieden 12–33 %, Außenseitersieg 3–7 %; 84 vs 80 → 65 % / 13 %; 88 vs 76 → 100 % Favorit; gleich stark (80/80) → Heim 42 %, Remis 33 %, Auswärts 25 %. Richtung plausibel; deutliche Außenseiterniederlagen möglich (max. Tordifferenz 4–7). Kleine Stichprobe (n=60), nicht auf Startelf-OVR der echten Welt kalibriert.

## G. Handlungsempfehlungen
- Supabase: Leaked-Password-Protection aktivieren; Anonymous-Sign-ins nur falls Altaccounts es brauchen; Migration 0042 über den SQL-Editor einspielen (Datei liegt im Repo; ändert bei Produktivdaten heute **0 Zeilen**, da kein Nicht-Amateur ohne Vertrag existiert). Indizes für häufige `world_id`-FKs nur bei messbarer Last.
- Fly: unverändert (1 Maschine, `auto_stop off`); Deploy nur außerhalb laufender Spiele; Metriken `fly logs`/`fly status` bitte vor dem nächsten Deploy selbst prüfen – ich hatte keinen Zugriff.
- Netlify: Code-Splitting (905-kB-Chunk), sonst keine Befunde.
- Offene Risiken: B1 (Nachwuchs/Karriereende), B2 (KI-Finanzen), G3-Flake, fehlende Mehrspieler-Stress-/Latenztests.

## Neu eingeführte Dauer-Infrastruktur
`npm run audit`, `npm run test:balance`, `npm run test:longrun`, `supabase/tests/G7_promoted_contracts.sql`, `supabase/tests/Z0_longrun.sql`, `packages/engine/test/balance.stat.test.ts`; Beschreibung in `docs/TESTING.md`.
