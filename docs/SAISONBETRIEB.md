# Transfers, Free Agents, Trainingsplan, Darstellung (Migrationen 0024–0025)

## Trainingsplan
`training_plans` / `training_plan_entries`: max. 5 Spieler mit Trainingsart, pausierbar, deaktivierbar.
`fd_run_training_plan` läuft genau einmal je Woche (`training_plan_runs`) bei jedem Kalenderfortschritt
(`fd_release_slot` → `fd_world_daily`) und im Server-Sweep – auch bei schnell aufeinanderfolgenden Spieltagen.
Gleiche Regeln wie manuell (`fd_train_player`): 5 je Woche, 1 je Spieler, −20 Fitness; Verletzte/Abgänge werden übersprungen.
KI-Vereine nutzen ihren automatischen Wochenplan (`fd_ai_training_batch`).

## Free Agents
Bewerbung (`sign_free_agent` = Interessensbekundung) nur im offenen Fenster; die Frist beginnt mit der ersten
Bewerbung und endet exakt 7 Spieltage-Kalendertage später (`free_agents.decision_on`). Weitere Vereine (auch KI,
`fd_ai_fa_interest`, wöchentlich) können sich in dieser Woche bewerben. `fd_fa_process` entscheidet automatisch:
Mindestanforderungen (Reputation, Spielklasse nach Stärke/Alter, Konkurrenz auf der Position), dann Punkte aus
Vorsaison-Platz, Liga, Reputation, Europapokal, Einsatzchance und Karrierezielen (Junge: Spielzeit, Ältere: Erfolg).
Gehalt fest. Max. 2 Free Agents je Verein und Saison, zusätzlich max. 5 Neuzugänge je Fenster.
Fenster zu ⇒ Bewerbungen verfallen (verbrauchen keinen Platz). Ein Vertrag je Spieler (Zeilensperre).

## Transferverhandlungen (KI-Verkäufer)
Sofortige Reaktion: Annahme (≥ 115 % des KI-Werts), Ablehnung (< 60 %) oder Zögern (Antwort frühestens nach
7 Tagen). Danach Gegenforderung (sinkt je Runde), Käufer nimmt an, bietet neu (`renegotiate_offer`) oder steigt aus.
Max. 3 Runden in 4 Wochen; geschlossenes Fenster beendet laufende Verhandlungen. KI-Wert (`fd_ai_valuation`):
Marktwert × Stammspieler × Alter × Vertragslaufzeit × Finanzlage × Kaderbedarf × Strategie.

## KI-Transfermarkt
`fd_ai_transfer_batch` (Sweep, 40 Vereine je Durchgang): je Woche ~20 % der KI-Vereine aktiv, Bedarf = schwächste
Positionsgruppe, Strategie je Verein (Talente, Etablierte, Schnäppchen, Gewinn), Budget ≤ 50 % für die Ablöse,
max. 2 Neuzugänge je Fenster aus eigener Initiative, gleiche Verhandlungen und Limits wie Menschen.

## Anzeigen
Dashboard: Monatskalender (`season_calendar`) und Top-5-Transfers Liga/Welt, Sommer/Winter (`top_transfers`).
Spieltagsübersicht: nur die eigene Liga (`matchday_report`), Pokal/Europapokal weiterhin eigene Übersicht.

## Darstellung (Match Engine unverändert in Wahrscheinlichkeiten)
* Ball: Bodenpunkt + Schatten, Höhe über Größe/Versatz, Spur je Ballart (`Snapshot.ballKind`).
* Standards: Aufstellung während der bestehenden Unterbrechung (`Snapshot.setPiece`), Eckbälle fliegen sichtbar,
  Mauer 3–5 Spieler bei 9,15 m, Elfmeter mit allen außerhalb des Strafraums. Die Mauer zählt wie bisher als ein Blocker.
* Stadion: Ränge nach Kapazität (1/2/3), weiße freie Sitze, dunklere Fans, Bewegung, Banner, Choreo gegen Top-5
  der eigenen Liga bzw. in späten Pokalrunden, Pyrotechnik (rein optisch).
* Wetter (`fd_weather`): nach Monat und Verband, deterministisch, ohne Einfluss auf das Spiel.
* Theme: `lib/theme.ts` – eine Akzentfarbe je Wettbewerb, neutrale Grundflächen.
* Vereinsnamen: `packages/shared/src/world/anchors.ts` (fiktive Orientierungsvereine), Migration 0025 für bestehende Welten.

Balancing nach den Änderungen (N = 400 je Unterschied): 0 OVR 34,5/34,3/31,3 · 3 OVR 45,0/30,8/24,3 ·
5 OVR 60,8/24,5/14,8 · 10 OVR 85,3/11,8/3,0 – im Rahmen der Messunsicherheit wie zuvor.

## Aktive Länder und Simulationsumfang (0030)
- **Zentrale Regel:** Aktive Länder sind Länder mit mindestens einem menschlichen Manager (`fd_active_assocs`). Dort werden alle drei Ligen vollständig simuliert, in Deutschland also 9 + 9 + 9 = **27 Spiele je Ligaspieltag**, plus DFB-Pokal und Relegation.
- **Andere Länder:** Es gibt keine nationalen Ligen, Spieltage oder Spielpläne. Vereine, Kader und Spieler bleiben für den Transfermarkt und den Europapokal erhalten.
- **Vereine mit Spielbetrieb (`fd_active_clubs`):**
  - Dazu gehören alle Vereine aktiver Länder und die Europapokal-Teilnehmer der Saison.
  - Nur sie erhalten wöchentlich KI-Training, KI-Transfers, Free-Agent-Interesse und Regeneration.
  - Aus den übrigen Ländern treten pro Woche nur etwa 3 % der Vereine als Käufer auf, damit die Nachfrage aus Europa erhalten bleibt.
  - Die Alterung am Saisonende gilt weiter für alle Spieler.
- **Reine KI-Spiele:** Gespeichert werden nur Tore, Karten und Verletzungen. Ergebnis und Spielerstatistik (Tore, Vorlagen, Noten, Fitness, XP) bleiben vollständig. Spiele mit Manager behalten alle Ereignisse.
- **Inaktive Welten:** Ist seit 2 Tagen niemand online, gibt es keine Hintergrundarbeit. Ein laufender Termin wird trotzdem fertig berechnet.
- **Nachweis:** `fd_sim_log` protokolliert jedes berechnete Spiel (engine/compact/fallback, Ereignisse, Spielerzeilen). Die Auswertung je Termin liefert `select * from public.admin_sim_report('<welt-id>');`.

## Europapokal (0030)
- **Wettbewerbe:** Champions League und Europa League mit je 16 Teams in 4 Gruppen. Danach folgen Viertel- und Halbfinale mit Hin- und Rückspiel und ein Finale auf neutralem Platz. Bei Gleichstand nach dem Rückspiel entscheidet das Elfmeterschießen.
- **Termine:** 11 Europapokal-Termine, immer dienstags. Die Gruppenphase liegt nach den Spieltagen 2, 4, 6, 9, 11 und 13, das Viertelfinale nach 19 und 21, das Halbfinale nach 24 und 26. Das Finale folgt 10 Tage nach dem 34. Spieltag. Der Europapokal beginnt mit der nächsten Saison, für laufende Saisons gibt es keinen nachträglichen Einbau.
- **Qualifikation aktiver Länder:** Platz 1–4 der Bundesliga der Vorsaison spielen Champions League, Platz 5–6 und der Pokalsieger (sonst Platz 7) Europa League. In der ersten Saison zählen die sieben stärksten Erstligisten.
- **Übrige Länder:** Ausgewählt wird nach Mannschaftsstärke (Schnitt der besten Elf) plus begrenztem Zufall (±3 OVR), mit höchstens 2 Vereinen je Land und Wettbewerb. Starke Vereine sind dadurch deutlich häufiger dabei. Es werden keine nationalen Spiele simuliert.
- **Berechnung:**
  - Spiele ohne menschlichen Manager werden kompakt in der Datenbank berechnet (`fd_compact_result`). Grundlage ist dieselbe Stärkeformel wie bei der Ersatzberechnung, dazu kommen Torschützen, Vorlagen, Karten und Verletzungen. Es gibt keinen Match-Server und keine 2D-Ereignisliste.
  - Spiele mit Manager laufen live bzw. über die Engine.
- **Termine ohne Menschen:** Termine ohne eigenes Spiel eines Menschen (Europapokal, Pokal nach dem Ausscheiden, Relegation) starten automatisch ohne Bereit-Meldung.
- **Prämien:** Start, Sieg/Remis, Gruppenplatz, Rundeneinzug und Titel laut `prize_templates`. Der Ticketpreis ist der internationale Preis.

## Fankultur & Stadionsound (0030)
- **Editor:** Seite „Fankultur“ (`/w/<welt>/fankultur`), verlinkt im Stadioneditor. Alles ist kostenlos und rein optisch bzw. akustisch, ohne Kosten oder sportliche Boni.
- **Schwenkfahnen:** bis zu 8 Fahnen (Form, Größe, Muster, bis zu 3 Farben, Aufschrift).
- **Choreografien:** bis zu 12 gespeicherte, mit Muster, bis zu 4 Farben, Text, Motiv und Bereich. Für das nächste Heimspiel lässt sich eine auswählen. Sonst greift der Standard bzw. die automatische Choreo in Vereinsfarben.
- **Ultragruppen:** bis zu 4 Gruppen mit Name, Farben, Zaunfahne, eigener Fahne und Block.
- **Hymnen und Fangesänge:**
  - Der Stadion-Synthesizer komponiert im Browser (Web Audio). Gespeichert wird nur das Rezept.
  - Sprechchöre kommen über die deutsche Sprachausgabe des Geräts.
  - Alternativ lässt sich eine MP3 hochladen (Supabase Storage, Bucket `club-audio`, höchstens 10 MB).
  - Es gibt eine offizielle Hymne und einen Signatur-Fangesang. Weitere Gesänge lassen sich Spielsituationen zuordnen: Tor, Angriff, Führung, Rückstand, Derby/Topspiel.
- **Einlauf:**
  - Vor jedem Pflichtspiel hält der Match-Server 20 Sekunden für alle Teilnehmer gleich: Tunnel, zwei Reihen, Aufstellung vor der Haupttribüne, dann die Startpositionen.
  - Dazu laufen Hymne und Signatur-Fangesang im Browser.
  - „Einlauf überspringen“ wirkt nur lokal, der Anpfiff bleibt gemeinsam. Optional „Einlauf immer überspringen“.
- **Fünf Wechsel:** Das war bereits umgesetzt: 5 Wechsel in 3 Unterbrechungen, die Halbzeit zählt nicht. Ausgewechselte Spieler kommen nicht zurück, und die KI nutzt dieselben Regeln. Eine Verlängerung gibt es im Spiel nicht, bei Gleichstand in K.-o.-Spielen folgt direkt das Elfmeterschießen.
