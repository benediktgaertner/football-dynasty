# Architektur

## Überblick

```
                ┌──────────────────────────────┐
  iPad/Browser  │  Web-App (React, Vite, TS)    │  Netlify (statisch, CDN)
  ───────────▶  │  apps/web                     │
                └──────┬───────────────┬────────┘
       HTTPS + Realtime│               │ WebSocket (ab Phase 5/6)
                       ▼               ▼
        ┌──────────────────────┐   ┌───────────────────────────────┐
        │ Supabase             │   │ Match-Server (Node.js/TS)     │  Fly.io
        │  • Auth (anonym/E-Mail)│◀─│  apps/match-server            │
        │  • Postgres + RLS    │   │  • autoritative Simulation    │
        │  • RPCs (Regeln)     │   │  • WebSocket-Räume /match     │
        │  • Realtime          │   │  • Headless-KI-Partien        │
        └──────────────────────┘   └───────────────────────────────┘
                       ▲                         │ Service-Role-Key
                       └─────────────────────────┘
              packages/shared: Typen, Regeln, Formeln (Client + Server + SQL-Paritätstests)
```

## Architekturentscheidung: Wo läuft die Match Engine? (A1)

**Geprüft am 18.11.2026.**

| Kriterium | Netlify Functions | Netlify Server (Early Access) | Eigener Node-Dienst (Fly.io) |
|---|---|---|---|
| Dauerhafte WebSockets | nein (Request-basiert) | ja | ja |
| Status | GA | Early Access, Funktionen „limited and subject to change“ | GA |
| Maximale Verbindungsdauer | – | 30 min (Pro: 2 h) | unbegrenzt |
| Mehrere Clients sicher auf derselben Instanz | – | nicht zugesichert (bis 3 Instanzen, kein Sticky-Routing dokumentiert) | ja, eine Maschine |
| Zustand im Speicher | – | nur solange die Instanz läuft, Abschaltung nach 5 min Leerlauf | dauerhaft laufend |
| Preis | inklusive | während Early Access kostenlos, Preise für GA noch offen | ab ca. 2–9 $/Monat |

**Entscheidung:** Die autoritative Match Engine läuft als **eigener Node.js-Dienst** (schlanker WebSocket-Server mit `ws`, ein Raum je Partie) auf **Fly.io**. Netlify hostet die Web-App.

Begründung: Bei einem Duell Mensch gegen Mensch müssen beide Clients mit **derselben** Simulation im Speicher verbunden sein (F12). Netlify Server sichert das noch nicht zu und ist noch in Early Access. Ein eigener Dienst mit genau einer dauerhaft laufenden Maschine erfüllt die Anforderung zuverlässig und günstig. Die Anwendung bleibt vollständig über die Netlify-Adresse erreichbar; der Browser verbindet sich zusätzlich per WebSocket mit dem Match-Server. Alle Karriere- und Benutzerdaten liegen in Supabase.

Zusätzliche Kosten: siehe [DEPLOYMENT.md](DEPLOYMENT.md#kosten).

Sobald Netlify Server allgemein verfügbar ist und Sticky-Routing pro Raum anbietet, kann die Entscheidung neu bewertet werden. Die Engine ist deshalb so geschnitten, dass sie nicht von Fly.io abhängt (reiner Node-Prozess, Konfiguration nur über Umgebungsvariablen).

## Monorepo

| Pfad | Inhalt |
|---|---|
| `packages/shared` | Domänentypen, Spielregeln als reine Funktionen (Marktwert, Gehalt, Stadion, Fitness, Snake-Draft, Positionsmalus, Gesamtstärke), Seed-RNG, Wappen-Renderer, Formationen, Verbände, Eingabeschemas (zod) |
| `apps/web` | React-Frontend (Login, Welten, Lobby, Vereinsgründung) |
| `apps/match-server` | autoritativer Simulationsdienst |
| `supabase/migrations` | SQL-Migrationen: Schema, RLS, RPCs, Realtime, Referenzdaten |
| `supabase/tests` | Datenbank-Integrationstests |
| `scripts` | Testläufer, Generatoren für Referenzdaten und Paritätstests |

Modulbereiche aus A4 und wo sie liegen bzw. liegen werden:

| Bereich | Ort |
|---|---|
| Frontend/UI | `apps/web/src/pages`, `components` |
| Gemeinsame Typen | `packages/shared/src/domain.ts`, `schemas.ts` |
| Datenbankmodelle | `supabase/migrations/*` |
| Authentifizierung | Supabase Auth + `apps/web/src/lib/auth.tsx`, `apps/match-server/src/auth.ts` |
| Lobby und Karriereverwaltung | RPCs in `…_rpc_lobby.sql`, `Lobby.tsx` |
| Fußballwelt und Wettbewerbe | Schema `…_competitions_matches.sql`; Generatoren ab Phase 3/7 in `packages/world` (geplant) |
| Draft | Schema `draft_sessions/draft_picks`; Regeln `rules/draft.ts`; RPC `make_draft_pick` (Phase 3) |
| Spieler und Kader | Schema `players…`; Regeln `rules/positions.ts`, `rules/economy.ts` |
| Taktik | Schema `…_tactics.sql`; `formations.ts` |
| Match Engine | `packages/engine` (Phase 5, geplant) – läuft im Match-Server |
| KI-Manager | `packages/ai` (Phase 5–8, geplant) |
| Finanzen und Transfers | `post_transaction()`, Tabellen `transfers…` |
| Kalender, Saisonwechsel | Phase 7/9 |
| Multiplayer-Synchronisierung | Supabase Realtime (Lobby, Draft, Kalender) + Match-Server (Partien) |
| Tests | `packages/*/test`, `apps/*/src/*.test.ts`, `supabase/tests` |

## Sicherheitsmodell (A2, A3)

1. **Identität:** Supabase Auth. Einstieg anonym (`signInAnonymously`), danach optional E-Mail-Verknüpfung über `auth.updateUser` → derselbe Benutzer kann sich auf anderen Geräten per Anmeldelink wiederherstellen. Kein Wiederherstellungscode im Klartext.
2. **Lesen:** Clients haben nur `SELECT` – und RLS beschränkt jede Zeile auf Mitglieder der eigenen Welt. Private Daten (Konto, Buchungen, Taktik, Training, Angebote) sieht nur der Manager des Vereins. Verborgenes Potenzial (`player_hidden`) ist für Clients gar nicht lesbar.
3. **Schreiben:** Ausschließlich über `SECURITY DEFINER`-RPCs, die `auth.uid()` prüfen, oder über den Match-Server mit Service-Role-Schlüssel. Kein `INSERT/UPDATE/DELETE` für `anon` oder `authenticated` (automatisch getestet).
4. **Geld:** Nur über `post_transaction()` mit Zeilensperre, Idempotenzschlüssel (`unique (world_id, idempotency_key)`) und Saldo-Prüfung.
5. **Parallelität:** `SELECT … FOR UPDATE` auf Welt-, Konto- und (ab Phase 3) Draft-Zeilen; Eindeutigkeit über Constraints (`draft_picks unique(draft_id, player_id)`, `free_agents` je Spieler einmal, ein aktiver Vertrag je Spieler, ein Status je Verein und Saison).
6. **Ergebnisgeheimnis (B4/F14):** Ergebnisse, Ereignisse und Spielerstatistiken liegen in eigenen Tabellen und sind erst nach `status = 'released'` für alle lesbar – vorher nur für die Beteiligten einer beendeten Partie.
7. **Wappen:** Gespeichert wird nur eine streng validierte Konfiguration (keine fremden Schlüssel, nur erlaubte Werte), nie freies SVG. Gerendert wird clientseitig aus dieser Konfiguration mit Escaping.
8. **Einladungscodes:** 6 Zeichen aus 31 Zeichen (≈ 887 Mio. Kombinationen), kryptografisch zufällig mit Ablehnungsstichprobe; Fehlversuche werden protokolliert und auf 20 je 10 Minuten begrenzt.

## Match Engine – technischer Plan (F1–F14)

### Simulationsmodell
* **Feste Zeitschritte:** 20 Ticks pro Echtsekunde. Bei 30-facher Beschleunigung entspricht ein Tick 1,5 virtuellen Sekunden. 90 Minuten = 3.600 Ticks ≈ 180 s.
* **Deterministisch:** Jede Partie startet mit `fixtures.rng_seed`; aller Zufall läuft über `createRng()` aus `packages/shared`. Gleicher Seed + gleiche Eingaben (mit Tick-Stempel) ⇒ gleicher Verlauf. Das ermöglicht Replays, Prüfung und Wiederaufnahme.
* **Kein vorab bestimmtes Ergebnis:** Tore entstehen nur aus Schüssen, deren Erfolgswahrscheinlichkeit aus der Situation berechnet wird (Distanz, Winkel, Druck, Attribute, Fitness, Torwartposition, Schussart → xG).
* **Positionsmodell (F4):** Für jeden Spieler wird pro Tick eine Zielposition aus drei Shapes gemischt: Formation-Shape (Grundordnung), Ballbesitz-Shape (Breite, Tiefe, Passdreiecke) und Pressing-/Defensiv-Shape (Linienhöhe, Kompaktheit, Pressingauslöser). Gewichte hängen von Ballposition, Ballbesitz, Taktik, Rolle, Anweisungen, Fitness, Tempo und Spielintelligenz ab. Bewegung mit Beschleunigungs- und Höchstgeschwindigkeitsgrenzen aus Tempo × Fitnessmultiplikator.
* **Entscheidungen (F5):** Utility-AI. Der ballführende Spieler bewertet Optionen (Pass zu jedem Mitspieler, Dribbling, Schuss, Flanke, Halten, Abschirmen) mit Nutzenfunktionen; Spielintelligenz senkt das Bewertungsrauschen. Spieler ohne Ball wählen zwischen Pressen, Passweg zustellen, Zurücklaufen, Position halten, in den Raum starten.
* **Aktionen (F6):** Jede Aktion wird über die Zeit ausgeführt (Ball fliegt, Gegner können abfangen). Erfolgswahrscheinlichkeiten sind logistische Funktionen aus Attributdifferenzen, damit Stärke langfristig zählt, aber nichts garantiert.
* **Fitness (F7):** Pro Tick `fitnessLossWithFactor()` mit dem aus den aktiven Einstellungen abgeleiteten Taktikfaktor `tacticLoadFactor()` und Rollenzuschlägen; Leistung über `fitnessPerformanceMultiplier()` (mental schwächer betroffen).
* **Regeln:** 5 Wechsel in 3 Unterbrechungen (Halbzeit zählt nicht), Fouls/Karten/Verletzungen, Abseits, Standards mit festgelegten Schützen und Varianten.

### Autorität und Netzwerk (F12)
* Der Match-Server ist die einzige Instanz, die simuliert. Clients senden nur **Befehle** (Profil wechseln, Formation, Positionen, Anweisungen, Wechselwunsch, Standardschützen).
* Jeder Befehl wird vom Server geprüft (darf dieser Benutzer diesen Verein steuern? – aus `clubs.manager_user_id`), mit dem **verbindlichen Tick** gestempelt, quittiert und ab dem nächsten Tick angewendet. Wechsel werden in die Warteschlange gestellt und bei der nächsten regelkonformen Unterbrechung ausgeführt.
* **Latenzregel:** Befehle gelten ab Ankunft am Server; es gibt keine rückwirkende Anwendung. Beide Manager sind damit gleich gestellt, unabhängig von ihrer Verbindung.
* **Zustandsübertragung:** 10 Snapshots pro Sekunde (Positionen quantisiert), Ereignisse (Tor, Karte, Wechsel) sofort und zuverlässig. Der Client interpoliert mit ~150 ms Puffer zwischen Snapshots und rechnet nie selbst Ergebnisse.
* **Verbindungsabbruch:** Die Partie läuft weiter. Beim Wiederverbinden erhält der Client den vollständigen aktuellen Zustand und die Ereignisliste. Ein getrennter Manager behält seine Automatik (E4) bzw. die KI-Wechselhilfe, damit sein Team nicht unbetreut ist.
* **Persistenz:** Ereignisse werden laufend in `match_events` geschrieben, alle 15 virtuellen Minuten ein Checkpoint (RNG-Zustand + Spielzustand) in `match_sessions.checkpoint`. Nach einem Serverneustart wird ab dem letzten Checkpoint mit identischem Seed weitergerechnet.
* **Abschluss:** In einer Transaktion: `fixture_results`, `match_player_stats`, Karten/Sperren, Verletzungen, Fitness, Zuschauer und Einnahmen; Status `finished`. Die gemeinsame Freigabe setzt danach alle Partien eines Termins auf `released` und schreibt die Tabellen fort.

### Headless-Modus (F13, C8.5)
KI-gegen-KI-Partien laufen mit **derselben Engine** ohne Echtzeittakt (so schnell die CPU erlaubt) in Worker-Threads. Erwartung: eine Partie in deutlich unter einer Sekunde, ein Spieltag mit 27 deutschen Partien plus Auslandsligen in Sekunden. Ausländische Ligen ohne Detailtiefe nutzen ebenfalls die Engine.

### Gemeinsamer Spieltag (B4)
1. Alle beteiligten Manager melden „bereit“ (`multiplayer_readiness`, Kontext `slot:<slot_key>`).
2. Der Server startet alle Partien des Termins gleichzeitig: menschliche Partien live, alle anderen headless.
3. Jeder Manager schaut zu, überspringt (Partie läuft serverseitig in voller Geschwindigkeit weiter, kein sportlicher Nachteil) oder verfolgt als Zuschauer eine andere Partie (nur lesend).
4. Sind alle menschlichen Partien beendet bzw. übersprungen, erfolgt die Freigabe.
5. **Timeout:** Wer 15 Minuten keine Anwesenheit (`touch_presence`) zeigt, gilt als abwesend; seine Bereitschaft wird automatisch gesetzt, seine Partie läuft mit seiner gespeicherten Taktik und Automatik. Der Host kann zusätzlich sofort fortsetzen.
