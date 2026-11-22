# Multiplayer-Verbindung: Diagnose und Korrekturen

Betrifft: Web (`apps/web/src/lib/matchClient.ts`, `pages/Match.tsx`, `components/match/*`) ↔ Match-Server (`apps/match-server`, Fly.io) ↔ Supabase.
Zeilenangaben beziehen sich auf den Stand VOR den Korrekturen. Keine SQL-Migration nötig, Match-Engine und Balancing unverändert.

## Festgestellte Ursachen

| # | Ursache | Beleg (alt) | Wirkung |
|---|---|---|---|
| 1 | Playwright-Messung: Eine offline geschaltete Seite behält ihren WebSocket im Zustand „open“ (halboffener Socket). Der Client hatte keinen eigenen Heartbeat und kein Timeout für ausbleibende Nachrichten. | `matchClient.ts` (nur `onclose`/Init-Timer, ~Z. 100–160); Server pingt nur alle 20 s (`wsServer.ts` ~Z. 42) | WLAN-Wechsel, iPad im Ruhezustand/Hintergrund: Anzeige friert ein, Reconnect kommt erst nach TCP-Timeout (Minuten) oder nie. |
| 2 | Unbegrenzte Wiederverbindung ohne Statusinformation; Hinweis nur als winziger Text in der Scoreboard-Zeile. | `matchClient.ts` ~Z. 150–156 (`retry++`, kein Limit), `Match.tsx` Scoreboard | Spieler sieht nicht, ob/ wie lange noch verbunden wird; kein manueller Ausweg nach langem Ausfall. |
| 3 | `retryNow()` öffnete eine zweite Verbindung, ohne die erste/den Retry-Timer zu beenden; alte Sockets hatten weiter aktive Handler. | `matchClient.ts` ~Z. 177 | Zwei Sockets speisen denselben Client: Ereignisse (`ev`) doppelt im Ticker, doppelte Tor-Einblendungen. |
| 4 | `ev`-Nachrichten waren nicht indexiert, `init` ersetzte immer das ganze Protokoll. | `presenter.ts` `release()`, `matchClient.ts` Case `ev` | Keine Möglichkeit, Duplikate/Lücken zu erkennen; jede Wiederverbindung lud alle Ereignisse neu. |
| 5 | Befehle ohne Idempotenz: Bei Abbruch nach dem Senden wurde dem Nutzer „Verbindung unterbrochen“ gemeldet, der Server hatte den Befehl aber evtl. ausgeführt; Nutzer wiederholte ihn. | `matchClient.ts` `command()`/`onclose` (pending sofort verworfen), `room.ts` `handleCommand` | Doppelte Wechsel/Taktikbefehle bzw. irreführende Fehlermeldung „bereits vorgemerkt“. |
| 6 | Automatik übernahm SOFORT beim Trennen. | `room.ts` `updateAutopilot()`, `leave()` | Jeder kurze Abbruch ließ die KI-Automatik Wechsel/Taktik für den Manager vornehmen (und ins Protokoll schreiben). Nach Serverneustart dauerte das, bis sich der Manager wieder verbunden hatte. |
| 7 | Checkpoint nur alle 400 Ticks (≈ 20 s) und nicht nach Befehlen; parallele Speicherungen konnten sich überholen; `fail()` speicherte nie (Status-Prüfung). | `room.ts` `step()`, `saveCheckpoint()` | Serverneustart/Deploy verlor bis zu 20 s Befehle (Wechsel, Taktik); Replay erzeugte einen Spielstand ohne diese Befehle. |
| 8 | Fly: Standard-`kill_timeout` ist 5 s, der SIGTERM-Handler wartet bis 10 s; offene WebSockets wurden nicht aktiv geschlossen. | `fly.toml` (kein `kill_timeout`), `index.ts` SIGTERM | Checkpoint beim Deploy konnte abgeschnitten werden; Clients merkten den Neustart erst über den Heartbeat. |
| 9 | Headless-KI-Spieltagssimulation rechnete 400 Ticks am Stück (gemessen ≈ 180 ms Blockade des Event-Loops, ≈ 0,45 ms/Tick) auf `shared-cpu-1x`. | `worldSim.ts` `simulateOne` | Bildstrom (25-ms-Takt), Pings und neue Verbindungen der Live-Partien stockten zu Beginn jedes Spieltags. |
| 10 | Kein `error`-Listener auf Server-WebSockets; keine Backpressure; alte (halbtote) Verbindung derselben Person blieb bis zum Ping-Timeout (bis 40 s) im Raum. | `wsServer.ts` `wss.on('connection')`, `room.ts` `broadcast()` | Unbehandelte Socketfehler, wachsende Sendepuffer bei langsamen iPads, doppelte Sendungen an Zombie-Verbindungen. |
| 11 | Vorübergehende Ladefehler (`Spiel konnte nicht geladen werden`, z. B. Datenbank/Neustart) wurden als endgültig behandelt (Close-Code 4500, `fatal`). | `wsServer.ts` Hello-Fehlerpfad, `matchClient.ts` `error`-Case | Nach einem Neustart blieb der Client im Fehlerbildschirm statt automatisch erneut zu versuchen. |
| 12 | `connect()` nach `close()` tat nichts (`stopped` blieb true). | `matchClient.ts` `connect()` | Im Dev-Modus (React StrictMode: mount → unmount → mount) verband sich die Match-Seite nie. Produktion nicht betroffen. |
| 13 | Raum-Race: Join in einen Raum, der gerade geschlossen wurde (Abpfiff + 30 s). | `wsServer.ts` `getRoom`/Join | Client erhielt `init`, aber nie wieder Daten. |

Geprüft und unauffällig: Die Match-Seite nutzt keine Supabase-Realtime-Kanäle (nur `Lobby.tsx` und `Draft.tsx`, beide mit `removeChannel` im Cleanup). Navigation weg/zurück (Team-Management): `close()` schließt den Socket mit 1000, beim Zurückkehren liefert `init` den vollständigen Zustand; durch Korrektur 10 wird eine alte Verbindung derselben Person sauber abgelöst. Tore/Ergebnis entstehen ausschließlich serverseitig; `admin_finish_match` ist idempotent. `fly.toml` hat bereits `auto_stop_machines = "off"`, `min_machines_running = 1` und genau eine Maschine.
Hinweis: Im Repo heißt die App in `fly.toml` `football-dynasty-match`, in CLAUDE.md `football-dynasty` – beim Deploy den tatsächlichen Namen verwenden (`-a`).

## Durchgeführte Korrekturen

Client (`matchClient.ts`, neu `components/match/ConnectionBanner.tsx`, kleine Edits in `Match.tsx`/`MatchPitch.tsx`)
- Eigener Heartbeat (Ping alle 8 s) und Watchdog: 20 s ohne Nachricht ⇒ Verbindung gilt als tot und wird neu aufgebaut. Beim Zurückkehren in den Tab (`visibilitychange`, `pageshow`) und bei `online` sofortige Prüfung bzw. sofortiger Versuch.
- Wiederverbindung: exponentielles Backoff (max. 5 s) mit Streuung, höchstens 15 Versuche (≈ 1 Minute), danach Fehlermeldung mit Schaltfläche „Neu verbinden“. Token wird vor jedem Versuch erneuert; bei 4401 ein Versuch mit erneuertem Token.
- Genau ein Socket: Generationsprüfung, alte Sockets werden vollständig gelöst (`detach`), `retryNow()` setzt sauber zurück.
- Ereignisse indexiert: `ev.from` ⇒ Duplikate werden verworfen, bei Lücke Neusynchronisierung; `hello.since` ⇒ Server liefert nur Verpasstes (`init.eventsFrom`); nach Server-Rückschritt (Neustart) wird komplett ersetzt.
- Befehle idempotent: stabile Sitzungs-ID (`sid`), unbestätigte Befehle werden nach der Wiederverbindung mit derselben id erneut gesendet (höchstens 20 s alt). Während des Abbruchs werden neue Befehle sofort mit verständlicher Meldung abgelehnt (nicht still gequeued).
- Statusanzeige (Deutsch): „Verbindung unterbrochen – verbinde neu (Versuch n von 15) …“, danach 4 s „Verbindung wiederhergestellt“, dann weg; bei Abbruch „Neu verbinden“; bei zweitem Fenster „Hier fortsetzen“.

Server (`room.ts`, `wsServer.ts`, `protocol.ts`, `presenter.ts`, `index.ts`, `worldSim.ts`, `fly.toml`)
- Befehls-Cache je Seite + Sitzung (64 Antworten): gleiche id ⇒ gespeicherte Antwort (`dup: true`), kein zweites Ausführen.
- Karenzzeit 20 s (`AUTOPILOT_GRACE_MS`) vor der Automatik eines abwesenden Managers; nach Neustart ebenfalls (Manager muss sich erst wieder verbinden). Rückkehr schaltet die Automatik sofort ab.
- Checkpoint 1 s nach jedem angenommenen Befehl; Speicherungen laufen seriell und werden zusammengefasst; auch bei `failed`.
- Alte Verbindung derselben Person wird beim Join abgelöst (Code 4409, Client zeigt Hinweis, keine Reconnect-Schleife). Raum-Close-Race behoben.
- Socket-`error`-Listener; Backpressure (Bilder werden ab 512 KB Sendepuffer ausgelassen, ab 8 MB wird getrennt).
- Vorübergehende Ladefehler: Close-Code 4502 + `transient` ⇒ Client verbindet automatisch neu.
- SIGTERM: Checkpoints aller Räume, dann alle Sockets mit 1012 („Neustart“) schließen ⇒ Clients verbinden sofort neu und laden nach. `/health` zeigt zusätzlich `clients` und `uptimeSeconds`.
- Headless-Simulation in 40-Tick-Häppchen (≈ 18 ms) statt 400 (≈ 180 ms).
- `fly.toml`: `kill_signal = "SIGTERM"`, `kill_timeout = "20s"`.

## Tests
- `apps/match-server`: `npx vitest run` ⇒ 23/23 (neu: Wiederverbindung mit `since`, Idempotenz, 4409-Ablösung, kurzer Abbruch ohne Automatik, Checkpoint nach Befehl, Resume aus Checkpoint bestehend).
- Playwright (`-g "Verbindungsabbruch"`, Fixture `mp-anthem`, zwei aktive Manager): 3/3 – Netz weg (Anzeige erscheint/verschwindet, Protokolle beider Manager identisch, Präfix unverändert, Befehl offline abgelehnt), Wechsel gleichzeitig mit dem Abbruch genau einmal, dreifaches Kappen. Bestehende Einlauf-/Torjubel-Tests stichprobenartig grün.
- Nicht automatisiert: echter Serverprozess-Neustart (abgedeckt über den Resume-Test aus Checkpoint + manuell zu prüfen) und halboffener Socket über 20 s (Watchdog, nur manuell: Flugmodus am iPad).

## Fly-Empfehlungen
- Deploy ist nötig (Match-Server und `fly.toml` geändert): `& "$env:USERPROFILE\.fly\bin\flyctl.exe" deploy -a <App-Name>`. Netlify-Frontend ebenfalls neu bauen; alt/neu sind kompatibel (neue Felder optional), aber die Korrekturen wirken erst mit beiden Teilen.
- Genau eine Maschine beibehalten (Partien liegen im Speicher). `auto_stop_machines = "off"`, `min_machines_running = 1` belassen.
- Wegen Korrektur 9 genügt `shared-cpu-1x`/512 MB für Freundesrunden; bei Spieltagen mit sehr vielen KI-Partien in mehreren Welten `shared-cpu-2x` oder `performance-1x` erwägen (geteilte CPU wird gedrosselt).
- Fly-Proxy-Leerlauf ist unkritisch: Server-Ping alle 20 s, Client-Ping alle 8 s, im Spiel zusätzlich 10 Bilder/s.
- Deploy während einer laufenden Partie vermeiden; falls nötig, nach Checkpoint ≤ 1 s Verlust nur der letzten Ticks (Replay ist deterministisch), Clients verbinden automatisch neu.
- Einen weiteren Match-Server nie parallel betreiben (Raum liegt im Speicher; `admin_claim_fixture` schützt nur vor doppelter Headless-Simulation).
