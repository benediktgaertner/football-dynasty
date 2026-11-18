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
| `apps/match-server/src/auth.test.ts` | 3 Tests: Token-Auslesen, Konfiguration |
| `netlify/lib/startDraft.test.ts` | 6 Tests: Methode, Token, worldId, nur Host, Idempotenz, Fehlerweitergabe |
| `supabase/tests/10_lobby_and_security.sql` | 73 Prüfungen, siehe unten |
| Paritätstest (generiert aus `scripts/gen-parity-sql.mjs`) | 32 Prüfungen: `normalize_name`, Stadionkosten, Startkapital und Snake-Reihenfolge in TS und SQL identisch |
| `supabase/tests/21_draft.sql` | 44 Prüfungen: Rechte, Vorbedingungen, ungültige Payloads, vollständige Weltinitialisierung, Buchungen, Reihenfolge, Verfügbarkeit, Vertrag, Reserve, Auto-Pick-Regeln |
| Paralleltest (Shell) | 4 gleichzeitige Verbindungen wollen denselben Spieler → genau 1 Pick |
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
