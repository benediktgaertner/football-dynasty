# Football Dynasty

Browserbasierter Multiplayer-Fußballmanager für Freunde: eigener Verein, gemeinsamer Snake-Draft, Taktik und eine zentral simulierte 2D-Partie, die alle Beteiligten gleichzeitig sehen.

**Stand: Phasen 1–3 implementiert** (Grundgerüst; Benutzer, Welt, Lobby, Vereinsgründung; Spielergenerierung und Snake-Draft). Taktik, Match Engine, Wettbewerbe und Wirtschaft folgen in den Phasen 4–10, siehe [docs/ROADMAP.md](docs/ROADMAP.md). Was hier steht, funktioniert wirklich. Es gibt keine Schaltflächen, die Funktionen nur vortäuschen.

## Was schon läuft

* Anmeldung nur mit Benutzernamen (anonyme Supabase-Sitzung), später per E-Mail sicherbar und auf anderen Geräten wiederherstellbar
* Karrierewelt erstellen oder per sechsstelligem Code beitreten
* Lobby mit Live-Aktualisierung, Bereitschaft und Schwierigkeitsgrad (Host)
* Vereinsgründung: Name, Kurzname, drei Vereinsfarben, SVG-Wappen-Editor mit Zufallsgenerator, Trikotdesign mit Vorschau des Spielerkreises, Stadionname und -größe mit Baukosten und Draft-Budget
* Vollständiges Datenmodell mit Row Level Security; alle Schreibvorgänge serverseitig geprüft
* Spielregeln (Marktwert, Gehalt, Stadion, Fitness, Snake-Draft, Positionsmalus, Gesamtstärke, Formationen) als getestete gemeinsame Bibliothek
* Draft-Start durch den Host: 54 KI- und menschliche Vereine in drei Ligen mit landestypischen, fiktiven Namen, Wappen und Stadien, vollständige KI-Kader und ein Pool mit 400 Spielern exakt nach Vorgabe
* Synchronisierter Snake-Draft mit gezeichneten Spielerporträts: Live-Aktualisierung, Filter, Sortierung, Spielerdetails, Restbudget, Kaderbedarf; serverseitige Reihenfolge, Budget- und Reserveprüfung; Auto-Pick für abwesende Manager
* Match-Server-Grundgerüst mit Health-Check und Token-Prüfung

## Schnellstart

```bash
cp .env.example .env          # Supabase-Werte eintragen (siehe docs/DEPLOYMENT.md)
npm install
npm run build -w @fd/shared
npm run dev:web               # http://localhost:5173
```

Die Datenbank richtest du mit `npx supabase db push` ein (Migrationen in `supabase/migrations`).

## Befehle

| Befehl | Zweck |
|---|---|
| `npm test` | Unit-Tests (Vitest) |
| `npm run test:db` | Migrationen und Sicherheitsregeln gegen eine echte, temporäre PostgreSQL-Instanz |
| `npm run typecheck` | TypeScript-Prüfung aller Pakete |
| `npm run build` | Build von `shared`, `web` und `match-server` |
| `node scripts/generate-reference-sql.mjs` | Referenzdaten-Migration aus `packages/shared` neu erzeugen |

## Dokumentation

* [ARCHITECTURE.md](docs/ARCHITECTURE.md): Systemaufbau, Hosting-Entscheidung, Sicherheitsmodell, Plan für Match Engine und Multiplayer
* [GAME_DESIGN.md](docs/GAME_DESIGN.md): umgesetzte Regeln und eigene Festlegungen
* [DATABASE.md](docs/DATABASE.md): Schema, Integritätsregeln, RPCs
* [DEPLOYMENT.md](docs/DEPLOYMENT.md): Supabase, Netlify, Fly.io, Kosten
* [TESTING.md](docs/TESTING.md): Teststrategie und Abdeckung
* [ROADMAP.md](docs/ROADMAP.md): Phasen und Meilensteine
