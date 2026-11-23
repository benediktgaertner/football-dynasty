# Choreo-Designer (Migration 0046)

Visueller Designer für Stadionchoreografien: `/w/:id/choreo` (Link in „Fankultur & Musik“ und in der Spielvorbereitung). Kostenlos und rein optisch – keine Stadionkosten, keine sportlichen Boni, Stadionakustik unverändert.

## Elemente
| Art | Beschreibung |
|---|---|
| Pappkarten | Muster aus Karten auf den gewählten Blöcken: einfarbig, Streifen (längs/quer), Schachbrett, Blöcke, Diagonal, Welle, Verlauf, Strahlen, Mosaik; Schriftzug und Symbol/Wappen über mehrere Blöcke; optional Wechselmuster (alle N s) |
| Blockfahne | lückenloses Tuch mit Falten, Text, Symbol; Erscheinen: Einblenden, seitlich Aufdecken, Ausrollen nach unten/oben |
| Spruchband | freies Band (x, y, Breite, Höhe, Drehung, horizontal/vertikal, Text, Farben) |
| Zaunbanner | Band entlang der Spielfeldkante (Nord, Süd, West, Ost bis zum Gästeblock) |
| Schwenkfahnen | klein, groß, Doppelhalter; Form, Muster, Farben; 1–40 Stück, automatisch verteilt oder einzeln platziert |
| Konfetti, Luftschlangen, Farbrauch | animierte Effekte auf gewählten Bereichen (Dichte 1–5) |
| Welle | laufende Zuschauerwelle über die gewählten Tribünen |

## Bereiche
Seiten: Nord (Gegengerade), Süd (Haupttribüne), West (Heimkurve), Ost (mit Gästeblock) und bei geschlossenen Stadien (modern, Arena) die vier Ecken. Ränge: Unterrang (am Spielfeld), Mittelrang, Oberrang – je nach Kapazität 1, 2 oder 3. Jede Seite ist in Blöcke geteilt (Nord/Süd 6, West/Ost 4, Ecken 1). Der Gästeblock (Osttribüne oben) wird nie überschrieben; Banner/Fahnen lassen sich weder dort noch auf dem Spielfeld platzieren. Bereiche, die in einem Stadion nicht existieren (z. B. Oberrang im kleinen Stadion, Ecken bei offenen Stadien), werden dort nicht dargestellt – beim Stadionausbau passen sich gespeicherte Bereiche automatisch an.

## Szenen
1–4 Szenen (je 2–30 s), jedes Element ist in einem Szenenbereich sichtbar. Während des Einlaufs läuft die Szenenfolge synchron zur gemeinsamen Einlaufzeit (kurze Einläufe stauchen, lange halten den Schlusszustand). Danach bleiben Elemente mit „Bleibt im Spiel sichtbar“ (Standard bei Fahnen und Bannern); Karten, Blockfahnen und Effekte des letzten Zustands bleiben bis Minute 5 und kurz zur Halbzeit.
Komplexität nach Stadiongröße: ≤ 20.000 Plätze: 12 Elemente/2 Szenen · ≤ 40.000: 24/3 · größer: 40/4.

## Speichern und Auswahl
Bis zu 12 Choreografien je Verein (`club_choreos.design`, JSON). Ein v2-Design trägt zusätzlich die Felder des alten Designs (ältere Clients zeigen eine einfache Blockchoreo). Auswahl pro Heimspiel in der Spielvorbereitung (ändert das Stadion nicht dauerhaft), optional „🎲 zufällig“ für dieses Spiel; zusätzlich Vereinseinstellung „zufällige gespeicherte Choreografie bei Heimspielen ohne Wahl“ (`set_choreo_random`; die Auswahl erfolgt serverseitig je Partie fest, für alle Spieler gleich). Auswärtsspieler sehen die Choreo des Gastgebers (kommt mit dem Match-Setup, keine Abfragen im Spiel).

## Technik
- `apps/web/src/lib/choreo/`: `model.ts` (Typen, Prüfung, Verlauf, Vorlagen), `geometry.ts` (Tribünen, Blöcke, Platzierungsregeln – gleiche Quelle `stadiumLayout` wie die Matchansicht), `render.ts` (ChoreoPlayer; Editor und Spiel nutzen denselben Code).
- Statische Elemente werden einmal je Größe in zugeschnittene Bitmaps gezeichnet, pro Frame nur kopiert; Partikel sind je Element begrenzt, eine adaptive Qualitätsregelung reduziert bei langen Frames Fahnen/Partikel.
- Datenbank: `fd_valid_choreo` prüft v2 streng (≤ 4 Szenen, ≤ 40 Elemente, Werte-/Textgrenzen, ≤ 24 kB).

## Tests
`npx vitest run src/lib/choreo` · `npm run e2e:club -w @fd/web -- -g Studio` (Editor, gemockte Datenbank) · `npm run e2e -w @fd/web -- -g "Choreografie im Einlauf|Stadiumgeometrie|Multiplayer|Performance"` (Matchansicht) · `bash scripts/test-db.sh` (G9).
