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

## Phase 5 – Match Engine ✅
- `packages/engine`: deterministische Simulation (7.200 Ticks à 0,75 s, 25 ms Echtzeit ⇒ 180 s), ein RNG je Partie
- Positionsspiel aus Aufstellung, Anweisungen und Ballposition; Pressing, Abseitslinie, Restverteidigung, Überladungen
- Entscheidungen des Ballführenden (Pass, Steilpass, Dribbling, Flanke, Schuss) nach Taktik und Attributen; xG-Modell
- Zweikämpfe, Fouls, Gelb/Gelb-Rot/Rot, Verletzungen, Elfmeter, direkte Freistöße, Ecken mit Eckballvariante
- Fitness F7 je Tick, Leistungsabfall, 5 Wechsel in 3 Fenstern (Halbzeit zählt nicht), Torwartersatz
- KI (K2) und Automatik (E4): Profilwechsel, Wechsel bei Müdigkeit; Spielernoten, Spieler des Spiels
- Kalibrierung (`npm run calibrate -w @fd/engine`): ca. 2,6 Tore/Spiel, 11 Schüsse und 1,3 xG je Team, Heimvorteil, Stärke 78 gegen 66 gewinnt ca. 80 %
- Überarbeitung „lebendige Simulation“: träge, flüssige Bewegung (Beschleunigung statt Springen, Bewegung in knapp doppeltem Echttempo (Konstante VIS in engine.ts)), Laufwege ohne Ball (Tiefenlauf, Hinterlaufen, Einrücken in den Halbraum, Entgegenkommen mit Lauf des dritten Mannes, Strafraumbesetzung bei Flanken), Pässe in den Lauf, Doppelpass, Spielverlagerung, Zurücklegen von der Grundlinie, Eins-gegen-eins, Distanzschüsse; Verteidiger nehmen gefährliche Läufe auf
- Regie im Match-Server: gefährliche Szenen laufen langsamer, ruhiger Aufbau schneller; Gesamtdauer bleibt 180 s
- Darstellung: Trikotfarben mit Rand, Ballhöhe mit Schatten, Ballspur, Name des Ballführenden, „TOR!“-Einblendung, Hinweise bei Großchancen
- Kurze Ballstafetten ohne Gegnerdruck werden nicht einzeln gezeigt, aber in der Passstatistik mitgezählt
- Kalibrierung aktuell: ca. 2,6 Tore/Spiel, 11 Schüsse je Team, ca. 26 % Remis, Heim 44 % / Auswärts 30 %, Stärke 78 gegen 66 gewinnt ca. 68 %

## Phase 6 – Echter Multiplayer ✅ (Testspiele)
- WebSocket-Server `/match` (Fly.io): Token-Prüfung, Rolle aus `clubs.manager_user_id`, Zuschauer nur lesend
- Snapshots mit 10 Hz, Befehle mit Bestätigung und Tick, Befehlslimit, Wiederverbinden mit vollständigem Zustand
- Abwesender Manager ⇒ Automatik; Checkpoint alle 10 s (Seed + Befehlsprotokoll) ⇒ exakte Fortsetzung nach Neustart
- Ergebnis idempotent per `admin_finish_match`; Testspiele sofort freigegeben, ohne Fitnessfolgen
- Web: Spiele-Tab im Team, Live-Seite mit Canvas, Spielstand, Liveticker, Profiltasten, Team-Management ohne Pause, Spielbericht
- Gemeinsame Freigabe von Pflichtspielergebnissen und Überspringen gehören zum Spieltagsablauf und folgen mit Phase 7.

### Update: realistische Bewegung und Regie ✅
- Engine in echter Fußballzeit (0,1-s-Ticks), keine Teleports mehr (Ballannahme per Laufweg, sichtbare Schüsse, Schnitte nur bei Neuaufstellung)
- Regie mit Szenenauswahl, 2-facher Wiedergabe, Zeitsprüngen, Halbzeitpause und ca. 180 s Gesamtdauer
- Konter (Sofort-Läufe nach Ballgewinn), Ballbesitzspiel (Passdreiecke), Pressing/Linie wirken auf Laufwege
- Kalibrierung: ca. 2,3 Tore/Spiel, 11 Schüsse und ca. 600 Pässe (78 %) je Team, Stärke 78 gegen 66 gewinnt ca. 75 %

## Phase 7 – Wettbewerbe und Kalender ✅ (national)
- Saisonkalender (43 Termine): 34 Ligaspieltage samstags mit Winterpause, Pokal mittwochs, Relegation (Hin/Rück), Pokalfinale, Saisonabschluss
- Drei Ligen à 18 Vereine, Doppelrunde (918 Spiele), Tabellen gesamt/heim/auswärts, Torschützen, Vorlagen, Noten
- DFB-Pokal mit 64 Teilnehmern (54 Profis + 10 Amateure der abstrakten 4. Liga), Heimrecht für Unterklassige bis zum Viertelfinale (+ kleiner Bonus), Halbfinale zufällig, Finale neutral, Elfmeterschießen bei Remis
- Relegation BL/2. BL und 2. BL/3. Liga mit Hin- und Rückspiel; 3. Liga ↔ 4. Liga (zwei stärkste Amateure steigen auf) – Ligen bleiben immer 18
- B4-Ablauf je Termin: Bereitschaft → Start (Host kann bei Zeitüberschreitung starten) → Live ansehen oder Überspringen → KI-Spiele headless auf dem Match-Server → gemeinsame Freigabe, sobald alle Spiele berechnet sind; nicht entschiedene Spiele werden nach 10 Minuten automatisch berechnet
- Verletzungen (1–5 Wochen), Sperren (Rot 2, Gelb-Rot 1, 5. Gelbe 1 – je Wettbewerb), Regeneration +15 je freiem Tag
- Saisonwechsel: Auf-/Abstieg, neue Saison, Alter +1, neue Vorbereitung (Sponsor, Ausbau, Transfers)
- **Noch offen:** Champions League, Europa League und Fünfjahreswertung (erste Teilnahme frühestens zur dritten Saison – folgen vorher). Verlängerung im Pokal wird bis dahin direkt durch Elfmeterschießen ersetzt.

## Phase 8 – Wirtschaft und Transfers ✅
- Transferfenster (Vorbereitung bis 5. Spieltag, 18.–22. Spieltag), je Fenster max. 5 Neuzugänge und 5 Verkäufe, Kader 16–30
- Angebote an KI-Vereine (Annahme, Gegenangebot, Ablehnung; Stammspieler teurer), Spielerzustimmung nach Gehalt, Liga, Ruf und Einsatzchance
- Angebote zwischen Managern mit Annehmen/Ablehnen/Gegenangebot, Zurückziehen
- Free Agents mit eindeutiger Vergabe (Zeilensperre), Verkauf an KI-Vereine, Freistellen mit Abfindung
- Finanzen: Zuschauereinnahmen nach Nachfragemodell, Stadionbetrieb, Gehälter je Spieltag, Spielprämien, Pokalprämien, Sponsorzahlungen und -saisonprämien, Platzierungsprämien
- Stadion: Ticketpreise (Liga/Pokal/International), Ausbau zum Saisonwechsel (+5.000 für 25 Mio. €), Heimvorteil aus Auslastung × Stadiongröße
- **Vereinfachung:** Vertragsverlängerungen kommen mit Phase 9; bis dahin werden auslaufende Verträge zum Saisonwechsel automatisch um zwei Jahre verlängert.

## Phase 9 – Langfristige Karriere ⬜
Entwicklung in der Saison, Alterung nur zum Saisonwechsel, Karriereenden, Talente, Jahresbericht, Historie. **Abnahme:** P22, P23, P25; N4 mit 10 und 30 Saisonen.

## Phase 10 – Testing und Deployment ⬜
Balancing, Sicherheitsprüfung, produktives Deployment, End-to-End-Multiplayer-Test. **Abnahme:** P27, P28.
