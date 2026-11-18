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

## Phase 2 – Benutzer und Karrierewelt ✅

| Ergebnis | Status |
|---|---|
| Anonyme Anmeldung mit Benutzernamen | ✅ |
| Konto sichern per E-Mail-Verknüpfung, Wiederherstellung per Anmeldelink | ✅ (nutzt Supabase Auth) |
| Welt erstellen (Einladungscode), beitreten, verlassen | ✅ |
| Verein gründen: Name, Kurzname, 3 Farben, Wappen-Editor, Trikot, Stadionname und -größe mit Kosten | ✅ |
| Lobby mit Realtime-Aktualisierung, Bereitschaft, Schwierigkeit (Host) | ✅ |
| Ende-zu-Ende-Test mit zwei Browsern gegen ein echtes Supabase-Projekt | ✅ (live bei dir: zwei Manager, eine Welt) |

**Abnahme:** Akzeptanzkriterien P1–P3 und P26 gegen ein echtes Supabase-Projekt prüfen: zwei Benutzer, gleiche Welt, eigene Vereine, Neuladen behält den Stand.

## Phase 3 – Spieler und Draft ✅

| Ergebnis | Status |
|---|---|
| Namensdaten für 54 Nationalitäten, passende Namen je Herkunft, Schutz vor realen Profinamen | ✅ |
| Draft-Pool: exakt 400 Spieler, Stärkeverteilung D2, max. 83, Herkunft nach Kontinenten, 40 Torhüter | ✅ getestet |
| Attribute treffen die positionsabhängige Gesamtstärke exakt; verborgenes Potenzial | ✅ getestet |
| 54 deutsche Vereine (KI + Menschen) in drei Ligen, Stärken nach C2 (ca. 5 Aufstiegskandidaten in Liga 2) | ✅ getestet |
| C7: landestypische fiktive Vereinsnamen, Kurznamen, Farben, Wappen, Stadien; Sperrliste; Eindeutigkeit | ✅ (deutsches Profil; weitere Länder in Phase 7) |
| KI-Kader (25 Spieler) mit Verträgen und Gehältern, KI-Manager, Taktikprofile, Startkapital | ✅ |
| `start_draft`: Startkapital und Stadionkosten buchen, zufällige Reihenfolge, alles in einer Transaktion | ✅ |
| `make_draft_pick`: nur der Manager am Zug, Zeilensperre, kein Spieler doppelt, Marktwert vom Konto, 3-Jahres-Vertrag | ✅ Paralleltest |
| Reserve-Regel: Kader kann garantiert auf 22 Spieler aufgefüllt werden, auch bei gegnerischem Verhalten | ✅ getestet |
| Auto-Pick durch den Host für Manager, die 15 Minuten abwesend sind | ✅ |
| Draft-Oberfläche (L4): Reihenfolge, Filter, Sortierung, Attribute, Restbudget, Kaderbedarf, Live-Aktualisierung | ✅ |
| Live-Test mit zwei Browsern gegen dein Supabase-Projekt | ⬜ nach dem Einspielen |

**Abnahme:** P4 und P5 (gemeinsamer Draft, alle sehen dieselben Entscheidungen) live prüfen.

## Phase 4 – Mannschaftsmanagement ✅

| Ergebnis | Status |
|---|---|
| Team-Bereich mit Kader, Spielerprofilen (Porträt, Attribute, Stärke je Position, Vertrag) | ✅ |
| Drei Taktikprofile mit festen Namen, je eigene Formation, Startelf und Positionen | ✅ |
| 30 Formationen, freies Verschieben per Drag-and-drop (Maus und Touch), Rolle folgt der Feldposition | ✅ |
| Aufstellungshilfe: Leistungsfähigkeit je Position (Positionsmalus D5 + Fitness F7), automatische Aufstellung | ✅ getestet |
| Zwölf Grundeinstellungen (E2), zwölf Spezialoptionen, individuelle Anweisungen je Rolle (E3) mit Konfliktprüfung | ✅ getestet |
| Anzeige der taktischen Fitnessbelastung aus den tatsächlichen Einstellungen (F7) | ✅ |
| Startprofil, automatische Auswechslungen und automatischer Taktikwechsel ab Minute X (E4) | ✅ |
| Standardschützen mit Ersatzschützen, Eckballvarianten, defensive Standardorganisation (F9) | ✅ |
| Zusatztraining: max. 5 Spieler/Woche, 1 Einheit je Spieler, −20 Fitness, Entwicklungspunkte nach Alter (G1/G4) | ✅ getestet |
| Sponsorwahl (10 Angebote je Liga, I7) und Bereitschaft für den Saisonstart (B2.12) | ✅ getestet |
| Alle Eingaben serverseitig validiert, Taktik für Gegner unsichtbar | ✅ getestet |

Noch nicht enthalten, weil es den Saisonkalender braucht (Phase 7): Regeneration über freie Tage, Wochenwechsel, Saisonstart. Gegnerbezogene Optionen (Pressing auf bestimmte Gegenspieler, Manndeckung) werden vor der jeweiligen Partie gesetzt (Phase 5/6). Die Umrechnung von Entwicklungspunkten in Attribute folgt mit der Spielerentwicklung (Phase 9).

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
