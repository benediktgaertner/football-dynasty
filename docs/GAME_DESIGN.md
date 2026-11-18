# Game Design – umgesetzte Regeln und eigene Festlegungen

Verbindliche Regeln stehen im Master-Prompt. Sie sind als Konstanten in `packages/shared/src/constants.ts` und als reine Funktionen in `packages/shared/src/rules/` umgesetzt und getestet. Dieses Dokument hält fest, wo der Master-Prompt Spielraum ließ und welche Festlegung getroffen wurde. Alle Werte sind Ausgangswerte für das Balancing.

## Bereits implementierte Regeln

| Regel | Umsetzung | Test |
|---|---|---|
| D4 Marktwert | Log-lineare Interpolation zwischen den Stützpunkten, trifft alle exakt, streng monoton; Altersfaktoren +7 % / 0 / −7 % / −15 % | `rules.test.ts` |
| H5 Gehalt | Altersfaktoren 0,75 … 1,25 | ✓ |
| I1 Startkapital | 320 / 260 / 210 Mio. €, Standard Mittel | ✓ (TS und SQL) |
| I3 Stadion | Kapazität × 1.000 € × 0,98^Schritte; 10.000–50.000 in 5.000er-Schritten; Ausbau 25 Mio. € je Schritt | ✓ (TS und SQL) |
| F7 Fitness | 0,5/min × Taktikfaktor × (1 + (75 − Ausdauer) × 0,008); abgestufte Leistungskurve, mental schwächer betroffen | ✓ |
| G1/G2 | −20 je Training, +15 je freiem Tag, Deckel 100 | ✓ |
| D3 Snake-Draft | A–B–C, C–B–A, …; 22 Picks je Manager; Free Agents = Pool − Teilnehmer × 22 | ✓ |
| D5 Positionen | abgestufter Malus 0 / −1 / −3…−5 / −6…−10 / −11…−20; positionsabhängige Gewichte für die Gesamtstärke | ✓ |
| E1 | 30 Formationsvorlagen; genau drei Profile mit festen Namen je Verein (DB-Constraint) | ✓ |
| C5 | 55 UEFA-Verbände mit Start-Stärke und Ligagröße | ✓ |
| F2 | lesbare Trikotnummer, Ausweichfarbe bei ähnlichen Vereinsfarben | ✓ |
| B3 | SVG-Wappen: 6 Formen, 7 Muster, 7 Symbole, Rahmen, Initialen, Gründungsjahr, Zufallsgenerator | ✓ |

## Eigene Festlegungen (nicht spezifizierte Details)

| Thema | Festlegung | Begründung |
|---|---|---|
| Einladungscode | 6 Zeichen aus `ABCDEFGHJKMNPQRSTUVWXYZ23456789` | keine verwechselbaren Zeichen (0/O, 1/I/L), eintippbar am iPad |
| Benutzername | 3–20 Zeichen, global eindeutig (normalisiert) | Spieler erkennen einander weltenübergreifend |
| Max. Manager je Welt | 18 | Größe der 2. Bundesliga; 400 Draft-Spieler / 22 Picks = 18 |
| Beitritt | nur in der Lobby | späterer Beitritt bräuchte eigene Regeln für Kader und Finanzen |
| Lobby verlassen | jeder außer dem Host, nur vor dem Draft | Host-Wechsel folgt bei Bedarf |
| Schwierigkeitswechsel | setzt die Bereitschaft aller zurück | geänderte Bedingungen müssen alle neu bestätigen |
| Buchung von Startkapital und Stadion | beim Draft-Start, nicht bei der Vereinsgründung | Schwierigkeit kann sich bis dahin ändern; I3: „vor dem Draft“ |
| Reale Vereinsnamen | für menschliche Vereine erlaubt, für KI-Vereine gesperrt | C7.1 gilt laut Geltungsbereich für nicht menschlich geführte Vereine |
| Kurzname | 3–4 Großbuchstaben/Ziffern, je Welt eindeutig | C7.1 |
| Transferfenster | offen, solange der **nächste** Ligaspieltag 1–5 bzw. 18–22 ist | beide Fenster umfassen genau fünf Spielwochen |
| Gehalt | 12 % des altersneutralen Marktwerts × Altersfaktor (Stärke 76, 26 J. ≈ 1,0 Mio. €/Jahr) | Kader mit 22 × Ø 76 ≈ 22 Mio. €/Jahr, passt zu Prämien von 5–25 Mio. € und Sponsoren |
| Taktikfaktor (F7) | stufenlos 0,70–1,40 aus Pressing (stark), Tempo, Linienhöhe, Gegenpressing | „nicht nur der Profilname zählt“ |
| Fitness-Leistungskurve | 100–90: 1,00 · 80: 0,975 · 70: 0,94 · 60: 0,89 · 50: 0,82 · 40: 0,74 · 0: 0,55; mental nur 35 % des Effekts | Bänder aus F7 |
| Positionsmalus | aus Feldkoordinaten der Positionen abgeleitet; Feldspieler im Tor −20, Torhüter im Feld −16 | nachvollziehbar statt Einzeltabelle |
| Sponsoren 1. und 3. Liga | Beträge × 1,6 bzw. × 0,5; in der 1. Liga ersetzt „Top 4“ den Aufstiegsvertrag | „entsprechend angepasst“ (I7) |
| Liga-Prämien 1. und 3. Liga | Prämien der 2. Liga × 2 bzw. × 0,4 | Ausgangswert, Prüfung im Langzeittest (I8) |
| Anwesenheits-Timeout | 15 Minuten ohne Lebenszeichen | B4: Abwesende dürfen nicht blockieren |
| Lobby-Missbrauchsschutz | max. 5 offene Lobbys je Host; max. 20 fehlgeschlagene Beitritte je 10 Minuten | Schutz der Einladungscodes |

## Bewusste Vereinfachungen aus dem Master-Prompt

* 3. Liga mit 18 Vereinen; abstrakte vierte Liga hält die Zahl stabil.
* Historisches 32er-Format für Champions League und Europa League, keine Absteiger aus der Champions League.
