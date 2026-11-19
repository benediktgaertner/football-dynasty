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
