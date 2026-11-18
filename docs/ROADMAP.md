# Entwicklungsplan mit testbaren Meilensteinen

Legende: ✅ fertig und getestet · 🟡 teilweise · ⬜ offen

## Phase 1 – Architektur und Projektstruktur ✅

| Ergebnis | Status |
|---|---|
| Technologiestack geprüft, Hosting-Entscheidung dokumentiert (Netlify Server vs. eigener Dienst) | ✅ `ARCHITECTURE.md` |
| Monorepo (npm workspaces): `shared`, `web`, `match-server` | ✅ |
| TypeScript-Typen und Spielregeln als reine Funktionen | ✅ 38 Tests |
| Vollständiges Supabase-Schema (alle Entitäten aus Teil M + C7–C9) mit Migrationen | ✅ 9 Migrationen |
| RLS und Rechtekonzept | ✅ automatisch geprüft |
| Entwicklungs- und Produktionsumgebung (`.env.example`, `netlify.toml`, `fly.toml`, Dockerfile) | ✅ |

**Abnahme Phase 1:** `npm test`, `npm run test:db`, `npm run typecheck` und `npm run build` laufen grün.

## Phase 2 – Benutzer und Karrierewelt 🟡

| Ergebnis | Status |
|---|---|
| Anonyme Anmeldung mit Benutzernamen | ✅ |
| Konto sichern per E-Mail-Verknüpfung, Wiederherstellung per Anmeldelink | ✅ (nutzt Supabase Auth) |
| Welt erstellen (Einladungscode), beitreten, verlassen | ✅ |
| Verein gründen: Name, Kurzname, 3 Farben, Wappen-Editor, Trikot, Stadionname und -größe mit Kosten | ✅ |
| Lobby mit Realtime-Aktualisierung, Bereitschaft, Schwierigkeit (Host) | ✅ |
| Ende-zu-Ende-Test mit zwei Browsern gegen ein echtes Supabase-Projekt | ⬜ braucht Zugangsdaten |

**Abnahme:** Akzeptanzkriterien P1–P3 und P26 gegen ein echtes Supabase-Projekt prüfen: zwei Benutzer, gleiche Welt, eigene Vereine, Neuladen behält den Stand.

## Phase 3 – Spieler und Draft ⬜
* Paket `packages/world`: Namensgenerator je Nationalität (D2) und je Verband (C7, datengetrieben, Sperrliste, Eindeutigkeit), Spielergenerator mit exakter Stärkeverteilung, KI-Kader für 54 deutsche und alle ausländischen Vereine, fiktive Vorsaison (C8.1).
* RPC `start_draft`: Host, alle bereit; Startkapital und Stadionkosten buchen; zufällige Reihenfolge.
* RPC `make_draft_pick`: Zeilensperre auf `draft_sessions`, nur der aktive Manager, Budgetprüfung, Vertrag (3 Jahre, Gehalt nach H5), Buchung, Realtime.
* Draft-Oberfläche mit Filtern und Sortierung (L4).
* **Abnahme:** P4, P5; Paralleltest „zwei Picks gleichzeitig“.

## Phase 4 – Mannschaftsmanagement ⬜
Aufstellung per Drag-and-drop (Touch), drei Profile, 12 Grundeinstellungen + Spezialoptionen, individuelle Anweisungen, Standardschützen, Training und Fitness nach Kalender, Automatik (E4).

## Phase 5 – Match Engine ⬜
`packages/engine` nach dem Plan in `ARCHITECTURE.md`; Headless-Läufer; Canvas-Darstellung. **Abnahme:** P7–P11, N1-Statistiken über mehrere tausend Partien.

## Phase 6 – Echter Multiplayer ⬜
Colyseus-MatchRoom, Befehle mit Tick-Stempel, Snapshots, Wiederverbinden, Überspringen, Zuschauer, gemeinsame Freigabe, Timeouts. **Abnahme:** P12–P19, N2.

## Phase 7 – Wettbewerbe und Kalender ⬜
Spielpläne (inkl. Wochentagsregeln C8.5), Tabellen, Pokal, Relegation, vierte Liga, Fünfjahreswertung, Champions League, Europa League mit Qualifikation und Auslosungen, Prämien. **Abnahme:** P24, P29–P35.

## Phase 8 – Wirtschaft und Transfers ⬜
Verhandlungen, KI-Gegenangebote, Free Agents mit eindeutiger Vergabe, Limits, Stadionausbau, Sponsoren, Ticketnachfrage, Heimvorteil. **Abnahme:** P21.

## Phase 9 – Langfristige Karriere ⬜
Entwicklung in der Saison, Alterung nur zum Saisonwechsel, Karriereenden, Talente, Jahresbericht, Historie. **Abnahme:** P22, P23, P25; N4 mit 10 und 30 Saisonen.

## Phase 10 – Testing und Deployment ⬜
Balancing, Sicherheitsprüfung, produktives Deployment, End-to-End-Multiplayer-Test. **Abnahme:** P27, P28.
