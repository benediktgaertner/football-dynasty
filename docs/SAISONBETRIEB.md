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
