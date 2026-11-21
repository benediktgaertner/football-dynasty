# Tests

```bash
npm install
npm run build -w @fd/shared
npm test             # Vitest: Regeln (packages/shared) und Match-Server
npm run test:db      # echte PostgreSQL-Instanz: Migrationen, RLS, RPCs, TS/SQL-Parität
npm run typecheck
npm run build
```

`npm run test:db` startet mit `initdb` eine frische, temporäre PostgreSQL-Instanz (ab Version 15, `PG_BIN` = bin-Verzeichnis). Docker oder Supabase-CLI sind dafür nicht nötig. Der Test spielt zuerst eine minimale Nachbildung der Supabase-Umgebung ein (`supabase/tests/00_supabase_stub.sql`: Rollen `anon`, `authenticated`, `service_role`, `auth.uid()`, Realtime-Publikation) und danach alle Migrationen.

## Aktueller Stand

| Suite | Prüfungen |
|---|---|
| `packages/shared/test/rules.test.ts` | 38 Tests: Konstanten, Marktwert, Gehalt, Stadion, Fitness, Snake-Draft, Positionen, Gesamtstärke, Namen, Codes, Farben, Wappen-Sicherheit, RNG, Schemas, Referenzdaten |
| `packages/shared/test/world.test.ts` | 17 Tests: Vereinsverteilung, Namens-Eindeutigkeit, Sperrliste, Branding-Validierung, Farbkonflikte, Mannschaftsstärken C2, KI-Kader, Pool D2 (Stärke, Herkunft, Positionen, Marktwerte), exakte Zielstärke, Determinismus, 1–18 Manager |
| `packages/shared/test/tactics.test.ts` | 12 Tests: 12 Grundeinstellungen, Schemas, Anweisungen und Konflikte, Rolle aus Koordinaten, Auto-Aufstellung für alle 30 Formationen, Lineup-Prüfung, effektive Stärke, Trainingsmultiplikatoren |
| `packages/shared/test/avatar.test.ts` | 4 Tests: Porträts deterministisch, sicher, graue Haare im Alter |
| `apps/match-server/src/auth.test.ts` | 3 Tests: Token-Auslesen, Konfiguration |
| `packages/engine/test/engine.test.ts` | 12 Tests: Höchstgeschwindigkeit in Fußballzeit, Tempo-Unterschiede, Taktik (Abwehrlinie), Fitness nach echten Spielminuten, Determinismus, 7.200 Ticks, Statistiken, xG-Modell, Replay aus Befehlsprotokoll, Wechselregeln, ungültige Befehle, Kalibrierung (Tore, Stärke, Heimvorteil), Snapshot |
| `apps/match-server/src/presenter.test.ts` | 6 Tests: Spieldauer ca. 180 s, gezeigte Bewegung ≤ 2-fach (Spieler, Ball, Wiedergaberate), Sprünge und Ereignisfreigabe, Tore werden gezeigt, Eingriffe während der Wiedergabe, identischer Bildstrom |
| `apps/match-server/src/wsServer.test.ts` | 3 Tests mit echten WebSocket-Clients: fremde Origin/ungültiges Token, zwei Manager + Zuschauer in einer Partie, Zuschauer ohne Rechte, Befehlsbestätigung, Wiederverbinden, Automatik, gespeichertes Ergebnis, Fortsetzung aus Checkpoint |
| `supabase/tests/40_matches.sql` | 31 Prüfungen: Testspiel anlegen/absagen, Rechte, Admin-Funktionen nur für den Server, Setup mit Kader/Taktik, Checkpoint, idempotentes Speichern, fremde Spieler gefiltert, Sichtbarkeit |
| `supabase/tests/50_season.sql` | 63 Prüfungen: Saisonstart, 43 Termine, 918 Ligaspiele ohne Doppelungen, Amateure, Pokal-Heimrecht, B4-Ablauf (Bereitschaft, Start, Überspringen, keine fremden Ergebnisse vor der Freigabe), Tabellen/Punkte, Gehälter/Prämien/Zuschauer, Transfers (Ablehnung, Gegenangebot, Abschluss, Free Agent eindeutig, Verkauf an KI, Mensch↔Mensch), komplette Saison inkl. Relegation, Pokalsieger, Auf-/Abstieg, Prämien genau einmal, Stadionausbau, Saison 2 |
| `apps/match-server/src/worldSim.test.ts` | Headless-Spieltag: alle offenen Spiele, Live-Räume ausgenommen, gleiches Ergebnis wie live |
| Ende-zu-Ende (Shell) | echtes DB-Setup → Match Engine → `admin_finish_match` |
| `netlify/lib/startDraft.test.ts` | 6 Tests: Methode, Token, worldId, nur Host, Idempotenz, Fehlerweitergabe |
| `supabase/tests/10_lobby_and_security.sql` | 73 Prüfungen, siehe unten |
| Paritätstest (generiert aus `scripts/gen-parity-sql.mjs`) | 65 Prüfungen: `normalize_name`, Stadionkosten, Startkapital, Snake-Reihenfolge, Spieleranweisungen je Position, Anweisungskonflikte und Trainingspunkte in TS und SQL identisch |
| `supabase/tests/21_draft.sql` | 44 Prüfungen: Rechte, Vorbedingungen, ungültige Payloads, vollständige Weltinitialisierung, Buchungen, Reihenfolge, Verfügbarkeit, Vertrag, Reserve, Auto-Pick-Regeln |
| Paralleltest (Shell) | 4 gleichzeitige Verbindungen wollen denselben Spieler → genau 1 Pick |
| `supabase/tests/30_team.sql` | 46 Prüfungen: Taktikprofil inkl. ungültiger Aufstellungen, fremder Spieler, null-Werte, unpassender/widersprüchlicher Anweisungen; Privatheit der Taktik; Automatik; Standards; Trainingslimits, Fitness, Entwicklungspunkte; Sponsor nur der eigenen Liga; Bereitschaftsbedingungen; nachgebesserte Wappenprüfung |
| `supabase/tests/22_draft_complete.sql` | 17 Prüfungen: kompletter Draft mit gegnerischem Verhalten; je 22 Spieler, keine Doppelungen, Free Agents = 400 − 44, kein Minus, Kontostand = Summe der Buchungen |

### Datenbanktest: Abdeckung (Auszug, Bezug auf Teil N)

* Anmeldung erforderlich; ohne Profil keine Welt
* Benutzernamen validiert und normalisiert eindeutig
* Einladungscode-Format; Beitritt tolerant gegenüber Kleinschreibung und Bindestrich; idempotent
* Fehlversuche werden trotz Fehlerantwort protokolliert; Begrenzung greift nach 20 Versuchen
* Nichtmitglieder sehen keine Welt, keine Vereine und keine fremden Profile
* Vereinsvalidierung: Kapazität, Kurzname, Name, Farben, Trikot, Wappen (fremde Schlüssel, eingeschleuste Zeichen)
* Eindeutigkeit von Vereinsname und Kurzname unabhängig von Schreibweise und Akzenten
* Sperrliste realer Vereine greift für KI-Vereine, nicht für menschliche
* Nur der Host ändert die Schwierigkeit; ein Wechsel setzt die Bereitschaft zurück
* Private Daten (Konto, Taktik) sind nur für den Eigentümer sichtbar
* **N3 „keine fremden Vereinsänderungen durch manipulierte Requests“**: direkte `INSERT`/`UPDATE` auf Vereine, Konten und Welten sowie der Aufruf interner Funktionen werden abgewiesen; `anon` hat keinerlei Zugriff
* RLS ist auf allen Tabellen aktiv; `authenticated` darf nirgends direkt schreiben
* Genau drei Taktikprofile mit festen Namen und 11 Positionen
* Finanzbuchungen idempotent; keine unerlaubt negativen Konten; Pflichtkosten nur ausdrücklich
* **B4/F14**: Ein Ergebnis sehen vor der Freigabe nur die Beteiligten, danach alle
* Host kann die Lobby nicht verlassen; beim Verlassen wird der Verein entfernt
* Welt voll bei 18 Managern

## Geplant (je Phase)

* **Phase 5:** mehrere tausend Headless-Partien: Tore/Spiel, Remis-Anteil, Stärke-Effekt, Taktik-Effekt, Fitness, Karten, Verletzungen, Heimvorteil, Standards, xG-Kalibrierung (N1)
* **Phase 6:** zwei echte WebSocket-Clients gegen einen Server-Prozess, gleichzeitige Taktikwechsel, Verbindungsabbruch und Wiederverbinden, Überspringen, Ergebnisgeheimnis (N2)
* **Phase 7–9:** 10 bzw. 30 simulierte Saisonen (N4) inklusive europäischer Teilnehmerzahlen und Namenskollisionen


## Match Engine: Entscheidungs-KI und Kalibrierung

- `packages/engine/test/ai.test.ts`: viele automatisch simulierte Spiele – keine Rückpässe aus guter Abschlussposition, Chancenqualität, Passwert 90 vs. 60, Dribbling, stark vs. schwach, Schießen.
- `npx tsx packages/engine/src/calibrate.ts 200`: Tore, Schüsse, xG, Remis/Heim/Auswärts, stark vs. schwach, KI-Kennzahlen (Abschlusspositionen, Rückpässe, Steilpässe, Dribblings, Flanken, Abschirmen, Blocks) und Wirkung einzelner Attribute (+15).

## Europaweiter Transfermarkt

- `supabase/tests/60_europe.sql` (läuft in `npm run test:db`): Aufbau je Verband (idempotent, konfliktsicher), alle Filter, internationaler Kauf und Verkauf.
- `FULL_EUROPE=1 npm run test:db`: legt alle 54 Verbände an und misst die Suchzeiten (Referenz: 782 Vereine, ~17.800 Spieler, Suche 14–64 ms).

## Finanzen, Verfügbarkeit, Dashboard, Stadion (Migrationen 0018–0021)

- `supabase/tests/70_finance.sql`: Gehaltsformel (identisch zu `contractSalary`), Gehälter je Saison exakt = Jahresgehalt (vorher 38/34 = 112 %), keine Doppelbuchung, Ticketbuchung „Ticketverkauf – N Zuschauer“, nie mehr Zuschauer als Plätze, Kontostand = Summe der Buchungen für jeden Verein, Neuberechnung bestehender Gehälter ohne Kontoänderung.
- `supabase/tests/80_availability.sql`: Verletzung/Sperre je Wettbewerb, Startelf-Prüfung blockiert die Bereitmeldung, Trainingsfortschritt.
- `supabase/tests/90_dashboard.sql`: Dashboard, Pflicht-Spieltagsübersicht, keine vorzeitige Freigabe verborgener Ergebnisse, keine geheimen Taktikdaten in Profilen.
- `supabase/tests/95_stadium.sql`: Stadiondesign kostenlos und validiert.

## Spieltagssteuerung & Spielerentwicklung (Migrationen 0022–0023)
* `96_matchday_control.sql` (19): Sperre gegen Doppelsimulation, Neuversuch nach Fehler/Absturz, Ersatzergebnis, nie überschreiben, Ergebnis bis Freigabe verborgen.
* Ende-zu-Ende Spieltag in `scripts/test-db.sh`: alle offenen Partien eines Termins mit der echten Engine → automatische Freigabe, XP für alle Einsatzspieler.
* `97_development.sql` (37): XP genau einmal, Testspiele ohne XP, Training (−20 Fitness, 1×/Woche), sofortige Attribut-/OVR-/Marktwertsteigerung, Engine liest neue Attribute, KI-Training (≤ 5, nie doppelt, gleiche Formel), Bericht ohne Potenzial, Alterung nur zum Saisonwechsel, in Häppchen genau einmal.
* Parität TS = SQL (`gen-parity-sql.mjs`): OVR für 120 Zufallsspieler, Marktwert, Multiplikatoren, Spiel-XP.
* `apps/match-server/src/worldSim.test.ts`: Sweep ohne Client, Neuversuch + Ersatzergebnis nach 3 Fehlversuchen, keine Doppelsimulation.
* Kalibrierung: `node scripts/dev-calibrate.mjs` (Ergebnisse in docs/DEVELOPMENT.md).

## Transfers, Free Agents, Trainingsplan (Migrationen 0024–0025)
* `98_transfers_training.sql` (37): Trainingsplan (Limit, Pause, einmal je Woche), Verhandlung über drei Runden mit
  Antwortterminen, sofortige Annahme, KI-Transfermarkt (Limits, keine Doppeltransfers), KI-Free-Agent-Bewerbungen
  und Limit 2, Top-Transfers, Kalender, Theme, Wetter, Verfall bei geschlossenem Fenster.
* `50_season.sql`: Free-Agent-Frist (7 Tage), mehrere Interessenten, automatische Entscheidung.
* `90_dashboard.sql`: Spieltagsübersicht nur eigene Liga.
* Lasttest (782 Vereine): KI-Transfers 40–90 ms je 40 Vereine, KI-Free-Agent-Interesse 0,18 s, Sweep 0,6 s.

- `99_active_countries.sql` (0030):
  - Aktive Länder (27 Spiele je Ligaspieltag, keine fremden Ligen) und Hintergrundarbeit nur für Vereine mit Spielbetrieb.
  - Europapokal: Auswahl nach Stärke, höchstens 2 je Land, kompakte Berechnung (nur Tore, Karten, Verletzungen; 22 Einsatzspieler; nie doppelt), Freigabe und Torschützen-Cache.
  - Reine KI-Spiele ohne Ablaufereignisse.
  - Fankultur und Stadionsound (Prüfungen, Rechte, Anzeige beim Heimspiel).
- `A0_kits_prep_audio.sql` (0031): Upload-Rechte im Storage (eigener/fremder Ordner, Löschen), Verknüpfung Datei ↔ Eintrag, Ultras-Bereiche (Gästeblock/Überlappung gesperrt), Fahnenlimits, drei Trikots mit automatischer Konfliktvermeidung, Spielvorbereitung (Bestätigung, Choreo nur Heimverein, Frist).
- `B0_europe32.sql` (0033): Europapokal in Saison 2 – je 32 Teilnehmer, keiner doppelt, 8 Gruppen à 4, Startplätze nach Länderrangliste (Deutschland 4 CL + 2 EL + Pokalsieger bzw. Nachrücker), kleinere Nationen, Tabellenmarkierung, kompletter K.-o.-Ablauf bis zum Finale (neutraler Platz).
- `C0_free_agents.sql` (0034): Erstligist mit 70 % Gehalt schlägt Zweitligist mit 100 %; Zweitligist braucht mehr als +25 % und gewinnt mit 250 %; Kalibrierung (5.000 Ziehungen); garantierte Unterschrift bei akzeptablem Angebot; vereinslos nur bei unzureichenden Angeboten; Budget, Limit, Vertraulichkeit, KI-Angebote.
- `C1_reduce_players.sql` (0034): Reduktion auf elf Spieler je Verein kleinerer Länder, Schutz von Spielern mit Historie, Stärke unverändert, idempotent, temporäre Europapokal-Bank.
- `apps/web/src/lib/crowdAudio.test.ts` (0034): Hörbarkeit per Offline-Rendering (benötigt lokal `npm i --no-save node-web-audio-api`, sonst übersprungen).
- `B1_country_setup.sql` + `B2_country_world.sql` (0033): Welterstellung für Italien (1. Liga), San Marino (2. Liga), Niederlande (3. Liga) und Deutschland (3. Liga): Host-Rechte, Ligen/Namen, Menschen in der Startliga, Skalierung von Pool und Startkapital, Draft, Saisonstart ohne Europapokal, 27 Ligaspiele je Spieltag, Amateurvereine des Landes.
- `50_season.sql` prüft zusätzlich den Übergang Saison 1 → 2: Saison 1 ohne Europapokal, Saison 2 mit 13 Europapokal-Terminen und Qualifikation aus der Abschlusstabelle.
