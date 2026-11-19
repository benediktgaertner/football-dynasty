# Balancing der Mannschaftsstärken (Match Engine)

Stand: November 2026. Jede Partie wird weiterhin dynamisch aus den Spieleraktionen berechnet –
keine festgelegten Ergebnisse, keine nachträglichen Tabellenkorrekturen.

## Problem

Die Gesamtstärke hatte zu wenig Einfluss. Viele Duelle verglichen Spielerwerte mit einem festen
Bezugswert statt mit dem Gegenspieler. Beispiel: Ein 80er-Torwart senkte die Torwahrscheinlichkeit gegenüber
einem 70er nur um rund 6 %. Folge (alte Engine, N = 200 je Zeile):

| Unterschied | Sieg | Remis | Niederlage |
|---|---|---|---|
| 0 OVR | 29,0 % | 37,5 % | 33,5 % |
| 3 OVR | 44,5 % | 27,0 % | 28,5 % |
| 5 OVR | 47,0 % | 24,5 % | 28,5 % |
| 10 OVR | 65,0 % | 21,0 % | 14,0 % |

## Änderungen (packages/engine/src/engine.ts)

- **Direkte Duelle statt fester Bezugswerte** (ligaunabhängig – das Torniveau bleibt in jeder Liga gleich):
  - Abschluss: Torwahrscheinlichkeit = Lage-xG × e^(0,032 × (Schütze − Widerstand)),
    Widerstand = 45 % Torwart + 55 % Abwehrqualität der gegnerischen Elf (`Q_SHOT`).
  - Passen: Passqualität relativ zur Abwehrqualität der gegnerischen Elf (`Q_PASS`), Gegenspieler beim Empfänger relativ zum Passgeber.
  - Zweikampf und Dribbling: Logit = Unterschied / 7 (vorher / 10 bzw. / 9) (`Q_DUEL`).
  - Ballannahme unter Druck, Schussblocks: Verteidiger gegen Angreifer direkt.
- **Effektive Mannschaftsstärke** der eingesetzten Elf (Position, Fitness, Heimvorteil) wird laufend
  berechnet (`teamQuality`) und fließt in Pässe und Abschlüsse ein.
- **Heimvorteil**: Grundwert 0,02 (vorher 0,035). Der Zuschauerzuschlag aus der Datenbank wird im Match-Server halbiert
  (`apps/match-server/src/setup.ts`), sonst entspräche ein volles Großstadion etwa 3 OVR.
- **Torniveau** nachkalibriert (2,8 Tore pro Spiel).

## Testverfahren (`node packages/engine/scripts/balance.mjs full 10 4`)

Alle Zahlen stammen aus der echten Engine (parallel auf allen Kernen):

1. Siegquoten bei 0/3/5/10 OVR Unterschied (Heim/Auswärts gespiegelt).
2. Liga mit 18 Teams in realistischer Bundesliga-Verteilung (85,5 … 77). Jede Heim/Auswärts-Paarung
   wird 10-mal mit der Engine gespielt (3.060 Spiele).
3. **1.000 Saisons**: Je Spiel wird ein tatsächliches Engine-Ergebnis der Paarung gezogen.
   Grund: 1.000 Saisons direkt sind 306.000 Spiele, auf 2 Kernen etwa 9 Stunden Rechenzeit.
   Zur Kontrolle werden zusätzlich vollständige Saisons komplett mit der Engine durchgespielt.
4. Einflussfaktoren: Heimvorteil, Fitness, Taktik.

## Ergebnisse (finaler Lauf)

```
Siegquoten des stärkeren Teams (Basis 72, N=300 je Unterschied, Heim/Auswärts gespiegelt, normaler Heimvorteil)
Unterschied | Sieg | Remis | Niederlage | Tore stark:schwach
    0 OVR   | 34.3 % | 29.7 % |   36.0 % | 1.34:1.37
    3 OVR   | 48.3 % | 30.7 % |   21.0 % | 1.64:1.14
    5 OVR   | 62.7 % | 23.3 % |   14.0 % | 1.90:1.05
   10 OVR   | 83.3 % | 12.0 % |    4.7 % | 2.64:0.73

Liga mit 18 Teams, Stärken: 85.5, 83.5, 81, 80.5, 80, 79.8, 79.5, 79.2, 79, 78.8, 78.5, 78.2, 78, 77.8, 77.6, 77.4, 77.2, 77
Engine-Spiele für die Pools: 3060 (10 je Heim/Auswärts-Paarung)
Heimsieg 43.0 % · Remis 27.1 % · Auswärtssieg 30.0 %
Überraschungssiege (schwächeres Team gewinnt bei ≥ 5 OVR Unterschied): 7.8 % von 460 Spielen

1.000 Saisons (aus Engine-Ergebnissen zusammengesetzt):
Rangkorrelation Stärke ↔ Tabellenplatz (Spearman, Ø): Kader-Zielstärke 0.759 · effektive Startelf 0.769
Stärke | Startelf Ø | Ø Punkte | Ø Platz | Meister
  85.5 |       85.5 |     84.9 |     1.0 | 99.5 %
  83.5 |       83.5 |     61.5 |     3.3 | 0.2 %
  81.0 |       80.4 |     51.9 |     6.2 | 0.0 %
  80.5 |       80.6 |     63.3 |     2.9 | 0.3 %
  80.0 |       80.9 |     46.1 |     8.9 | 0.0 %
  79.8 |       80.2 |     49.3 |     7.4 | 0.0 %
  79.5 |       79.1 |     46.1 |     8.8 | 0.0 %
  79.2 |       79.9 |     50.4 |     6.9 | 0.0 %
  79.0 |       79.3 |     49.5 |     7.4 | 0.0 %
  78.8 |       79.5 |     43.1 |    10.3 | 0.0 %
  78.5 |       78.8 |     43.3 |    10.1 | 0.0 %
  78.2 |       77.7 |     38.3 |    12.7 | 0.0 %
  78.0 |       77.9 |     31.2 |    15.6 | 0.0 %
  77.8 |       77.5 |     33.6 |    14.7 | 0.0 %
  77.6 |       78.0 |     41.2 |    11.3 | 0.0 %
  77.4 |       76.4 |     33.5 |    14.8 | 0.0 %
  77.2 |       76.6 |     29.0 |    16.4 | 0.0 %
  77.0 |       76.9 |     38.9 |    12.3 | 0.0 %
Ø Punkte: Top-6 59.5 · Mitte 45.1 · Unten-6 34.6
Meister aus den 3 schwächsten Teams: 0.0 % · aus den 6 schwächsten: 0.0 % · Top-3-Team steigt ab: 0.1 % je Team

4 komplett mit der Engine gespielte Saisons (1224 Spiele): Spearman Ø 0.787 · Meister-Stärken 85.5, 85.5, 85.5, 85.5
Ø Punkte stärkstes/schwächstes Team: 83.8 / 42.3

Einflussfaktoren (N=300 je Test, gleich stark = 75):
Heimteam (75) gegen Gast (75), normaler Heimvorteil        Sieg 42.3 % · Remis 30.0 % · Niederlage 27.7 %
Heimteam (75) gegen Gast (75), volles 50.000er-Stadion     Sieg 51.7 % · Remis 29.3 % · Niederlage 19.0 %
Heimteam (72) gegen stärkeren Gast (75), normaler Heimvorteil Sieg 28.0 % · Remis 32.3 % · Niederlage 39.7 %
Team mit 100 % Fitness gegen 70 % Fitness (gleich stark)   Sieg 70.0 % · Remis 17.7 % · Niederlage 12.3 %
Offensives Profil gegen neutrales Profil (gleich stark)    Sieg 47.3 % · Remis 28.0 % · Niederlage 24.7 %
Schwächeres Team (70) offensiv gegen 75 neutral            Sieg 19.3 % · Remis 28.7 % · Niederlage 52.0 %
Schwächeres Team (70) defensiv gegen 75 neutral            Sieg 11.0 % · Remis 23.7 % · Niederlage 65.3 %

Laufzeit 650 s auf 2 Kernen
```

## Bewertung

- **Stärke entscheidet langfristig:** Rangkorrelation Stärke ↔ Tabellenplatz 0,76–0,79. Das liegt im Bereich
  realer Ligen (Marktwert ↔ Tabelle). Ø Punkte: Top-6 59,5 · Mitte 45,1 · Unten-6 34,6.
- **Überraschungen bleiben möglich:** Bei ≥ 5 OVR Unterschied gewinnt das schwächere Team 7,8 %
  der Spiele, bei 3 OVR 21 %. Keines der sechs schwächsten Teams wurde in 1.000 Saisons Meister.
- **Untergeordnete Faktoren:**
  - Heimvorteil: gleich starke Teams 42 % / 30 % / 28 %.
  - Ein schwächerer Gastgeber (−3) bleibt Außenseiter.
  - Fitness 70 % statt 100 % ist ein großer Nachteil – Rotation lohnt sich.
  - Taktik bringt bei gleicher Stärke spürbar etwas (offensiv gegen neutral 47 % : 25 %), gleicht aber 5 OVR nicht aus:
    Das 70er-Team gewinnt offensiv 19 % gegen ein 75er-Team.
- **Kaderzusammensetzung zählt:** Teams mit gleichem Durchschnitt unterscheiden sich je nach Torwart, Abwehr
  und Abschlussstärke. Gewollt, denn Einzelattribute sollen wirken. Nach der Neugewichtung des Torwarts
  (45 % statt 100 % des Widerstands) ist dieser Effekt deutlich kleiner.
