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

> **Ab 0033 gilt das neue Format (unten).** Laufende Saisons mit 4 Gruppen werden nach dem alten Ablauf zu Ende gespielt.

## Land, Startliga und Europapokal (0033)
- **Welterstellung:** Land (alle 55 UEFA-Verbände) → Startliga (1./2./3. Liga) → Vereinsgründung → Stadion → Draft. Der Host kann Land/Liga in der Lobby noch ändern (`set_world_setup`), danach müssen alle erneut bestätigen. Gespeichert in `career_worlds.country_code` / `start_tier`.
- **Spielland:** immer 3 Ligen à 18 Vereine, 34 Spieltage, 27 Ligaspiele je Spieltag, Auf-/Abstieg und Relegation, Pokal mit allen drei Ligen + 10 Amateurvereinen, landestypische Namen (`country_league_names`, Vereins- und Amateurnamen aus `packages/shared/src/world/country.ts`).
- **Übrige Länder:** nur die Erstliga als Stammdaten (auch Deutschland, wenn ein anderes Land gewählt ist). Keine Spielpläne, keine Spieltage, keine Pokalsimulation – nur Transfermarkt und Europapokal-Auswahl.
- **Skalierung (Referenz Deutschland, 2. Liga = Faktor 1, bestehende Welten unverändert):**
  - Mannschaftsstärken: `fd_country_transform` / `countryTransform` (Landesstärke verschiebt und staucht die deutschen Zielwerte).
  - Draft-Pool: Verschiebung `fd_country_shift(Land, Startliga)`, Obergrenze `fd_draft_pool_max` (83, Erstligen starker Länder bis 92).
  - Startkapital und Stadionbau: `fd_capital_factor` (≈ e^(0,2·Verschiebung)).
  - Prämien, Sponsoren, Pokalprämien, Zuschauereinnahmen und Stadionbetrieb: `career_worlds.economy_factor` (`fd_economy_factor_for`). Gehälter folgen automatisch den Marktwerten. Europapokal-Prämien und internationale Tickets bleiben unskaliert.
- **Europapokal erst ab Saison 2.** Saison 1 hat keine Europapokal-Termine; niemand ist automatisch qualifiziert. Grundlage ist immer die abgeschlossene Vorsaison.
- **Länderrangliste** (`fd_ec_assoc_ranking`): Startstärke + Bonus aus den Europapokal-Ergebnissen der Vorsaison (max. +6). Verlauf in `association_strength_history`.
- **Champions League (32):** Rang 1–4 → 4 Plätze, 5–6 → 3, 7–9 → 2, 10–11 → 1, der beste Europapokal-Verband +1 (max. 5). Spielland mindestens 1 (Meister). Restliche Plätze: Meister kleinerer Nationen per gewichteter Länderauswahl. Deutschland (Rang 4): Platz 1–4.
- **Europa League (32):** Rang 1–6 → 2 Ligaplätze, 7–9 → 1, dazu die Pokalsieger der Ränge 1–15 und des Spiellands; Rest: Pokalsieger kleinerer Nationen. Ist der Pokalsieger schon qualifiziert, rückt der nächstbeste Erstligist nach (Tabellenmarkierung „EL*“). Der Pokal ist der einzige Weg für Unterklassige.
- **Ausland:** Rangfolge je Land aus Stärke (beste Elf) + Reputation + begrenztem Zufall (±2); Pokalsieger per gewichteter Zufallsauswahl. Kein Verein in beiden Wettbewerben, genau 32 je Wettbewerb (fehlende Vereine: Nachrücker nach Stärke). Gründe stehen in `ec_qualifications`.
- **Format:** 8 Gruppen à 4, 6 Gruppenspiele, die ersten zwei ins Achtelfinale (A1–B2, B1–A2, …). Achtel-, Viertel- und Halbfinale mit Hin- und Rückspiel, Finale auf neutralem Platz. 13 Termine (dienstags): Gruppe nach Spieltag 2, 4, 6, 9, 11, 13; Achtelfinale 19/21; Viertelfinale 23/25; Halbfinale 28/30; Finale 10 Tage nach dem 34. Spieltag.
- **Tabellenmarkierung:** `europe_places(world)` liefert CL-/EL-Plätze der nationalen 1. Liga und den Pokal-Nachrücker.

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

## Update 0031: MP3-Upload, Ultras, Fahnen, KI-Fankultur, Trikots, Spielvorbereitung
- **Fehlerursache beim Upload:** Die Storage-Policies aus 0030 lösten `name` in der Unterabfrage auf `clubs.name` (Vereinsname) auf statt auf den Dateipfad. Jeder Upload wurde deshalb von RLS abgelehnt.
- **Neue Rechte (Bucket `club-audio`):**
  - `fd_can_manage_audio(pfad)` prüft `<welt>/<verein>/<datei>.mp3` gegen den angemeldeten Manager des Vereins.
  - Darauf bauen die Policies für INSERT, SELECT, UPDATE und DELETE auf.
  - Lesen ist öffentlich, damit die Wiedergabe über den Bucket funktioniert. Es gibt keine öffentlichen Schreibrechte.
  - Die Tabelle `club_audio` ist nur lesbar (für Mitglieder der Welt). Schreiben läuft ausschließlich über geprüfte RPCs.
  - `save_club_audio` akzeptiert nur MP3s im Ordner des eigenen Vereins und prüft, dass die Datei existiert. Schlägt das Speichern fehl, entfernt die App die Datei wieder.
- **Hymnen und Fangesänge:** nur noch als MP3 (Synthesizer und Textgenerator entfernt). Mehrere Gesänge pro Verein sind möglich. Die erste Hymne bzw. der erste Gesang wird automatisch offiziell bzw. zum Signatur-Gesang.
- **Ultragruppen:**
  - Frei platzierbarer Bereich (`area` in Stadion-Metern) per Drag-and-drop, Größe über einen Ziehpunkt oder Knöpfe.
  - Gesperrt sind Gästeblock und Spielfeld, und Gruppen dürfen sich nicht überlappen. Beides wird in der Datenbank geprüft.
  - Die Fahnenzahl ist je Gruppe einstellbar.
- **Schwenkfahnen:**
  - Je Fahne lassen sich Anzahl (1–12) und Verteilung (von–bis entlang der Heimkurve) einstellen, insgesamt höchstens 40 Fahnen.
  - Eigene Fahnen erscheinen nur in der Heimkurve. Große Gruppenfahnen gibt es nur in der Kurve, sonst werden sie mittelgroß dargestellt.
- **KI-Vereine und Gäste:**
  - KI-Vereine bekommen eine automatisch erzeugte Fankultur (Gruppenname, Farben, Zaunfahne, Fahnen) aus Vereins-ID, Name und Farben. Das passiert ohne Datenbankzugriff im Spiel.
  - Gästefans schwenken im Gästeblock ihre Fahnen: eigene Fahnen eines menschlichen Gastvereins, sonst automatisch erzeugte.
  - Die Menge hängt von Auslastung, Gästeblock und Spielbedeutung ab.
- **Trikots:**
  - Jeder Verein hat ein Heim-, Auswärts- und Spezialtrikot (`club_branding.kits`), das bisherige Trikot wird zum Heimtrikot. Bearbeitet werden sie im Stadioneditor.
  - Die Wahl je Partie liegt in `fixture_kits`. KI-Vereine wählen automatisch ein Trikot ohne Farbkonflikt (`fd_fixture_kit`, gleicher Farbabstand wie in TypeScript).
  - Im 2D-Spiel tragen die Spieler die gewählten Farben und Muster.
- **Spielvorbereitung:**
  - Melden sich alle Manager bereit, wechselt der Termin in den Status `prep`.
  - Jeder Manager wählt dort sein Trikot, der Heimverein zusätzlich die Choreografie (mit Schnellbearbeitung), dann bestätigen alle.
  - Haben alle bestätigt, startet der Termin, danach folgt der bisherige Einlauf.
  - Spätestens nach 2 Minuten startet der Termin automatisch. Auslöser ist der Match-Server-Sweep oder ein beliebiger Manager per `prep_tick`, der Spieltag blockiert also nie.
  - Termine ohne eigenes Spiel eines Menschen überspringen die Vorbereitung. Der Host kann wie bisher sofort starten.

## Update 0032: Stadionatmosphäre und Ereignisse auf dem Spielfeld
- **Zentraler Mixer** (`apps/web/src/lib/audioMixer.ts`, Web Audio):
  - Kanäle: Kulisse, Reaktionen, Pfiffe & Ball, Fangesänge, Hymnen & Torhymnen. Jeder Kanal hat einen eigenen Regler (🎚 im Spiel), die Einstellungen bleiben im Browser gespeichert.
  - Ein Begrenzer verhindert Übersteuern. Ducking senkt die Kulisse bei Hymnen, Pfiffe bleiben immer hörbar.
  - Räumlich: Heimfans links, Gäste rechts.
- **Kulisse:** Der Pegel richtet sich nach Zuschauerzahl, Auslastung und Spielbedeutung. Er steigt bei Heimangriffen und deutlich im Strafraum sowie in knappen Schlussphasen. Nach Höhepunkten sinkt er langsam auf das Grundniveau zurück.
- **Reaktionen und Effekte:**
  - Torjubel (Heim laut, Gäste klein), „Ooooh“ bei vergebenen Großchancen und Aluminium, Pfiffe und Rufe bei Fouls des Gegners, Raunen nach Gegentoren.
  - Schiedsrichterpfiff bei Anpfiff, Halbzeit, Foul, Abseits, Elfmeter und Spielende. Bei Ecken und Ausbällen pfeift es dezent.
  - Dazu Aluminium, Netz (Tor), Außennetz ohne Jubel und Ballkontakt.
  - Alle Effekte werden im Browser synthetisiert: keine fremden Dateien, keine Lizenzen, keine Kosten.
- **Synchron:** Ton und Symbole lösen über den Tick des gerade dargestellten Bildes aus. Jedes Ereignis wirkt genau einmal, und übersprungene Passagen werden nicht nachgeholt.
- **MP3:**
  - Jede Datei wird einmal geladen und dekodiert und dann zwischengespeichert. Die Lautheit wird automatisch angeglichen (RMS).
  - Ein- und Ausblenden sind weich, es läuft höchstens ein regulärer Fangesang gleichzeitig.
- **Fangesänge** (`apps/web/src/lib/fanAudio.ts`):
  - Alle regulären Gesänge (ohne Signatur-Gesang und Torhymne) bilden eine zufällige Playlist.
  - Zwischen den Gesängen liegen 3–8 Sekunden Pause, ohne direkte Wiederholung. In Druckphasen beginnen Gesänge eher.
  - Die Gästefans singen gelegentlich und leiser im Gästeblock.
  - Hymne und Signatur-Gesang gibt es nur beim Einlauf. Die Torhymne (Gesang mit Situation „Tor“) läuft nur beim Tor des eigenen Vereins, danach geht es mit der Playlist weiter.
- **Außerhalb des Spiels:** Nach dem Abpfiff (Schlusspfiff, dann Ausblenden) oder beim Verlassen der Seite wird alles sanft ausgeblendet und der AudioContext pausiert. Im Menü ist kein Ton zu hören. Beim nächsten Spiel startet der Mixer sauber neu.
- **Einblendungen am Spieler:** Gelb, Gelb-Rot, Rot, Verletzung (Kreuz), Abseits (Fahne), Tor (Torschütze), jeweils etwa 1,7 Sekunden klein neben dem Spieler.
- **Datenbank (0032):** Das Match-Setup liefert jetzt alle Gesänge mit Signatur-Kennzeichen und die Gesänge der Gäste. Das wird einmal je Spiel gelesen, während der Partie gibt es keine Abfragen.

## Update 0034: Free-Agent-Verhandlungen, kleinere Spielwelt, dynamische Fanatmosphäre

### Free Agents: Verhandlung mit kalibriertem Barometer
- **Angebot:** Jahresgehalt (40–250 % der Forderung) und Laufzeit 1–5 Jahre. Innerhalb der 7-Tage-Frist jederzeit verbesserbar (`fa_offer`). Das Gehalt muss ins Budget passen, inklusive weiterer offener Free-Agent-Angebote des Vereins. Die Limits bleiben: zwei Free Agents pro Saison, fünf Neuzugänge pro Fenster, Kader höchstens 30, nur im offenen Fenster.
- **Modell (verdeckt):** Nutzen = Basis(Verein) + Geldgewicht · ln(Gehalt/Forderung) + Laufzeit.
  - Die Basis berücksichtigt: Liga, Champions/Europa League, Titel-/Aufstiegschance (Tabelle), Form der letzten fünf Spiele, Reputation, Einsatzchance (bessere Spieler auf der Position), Alter, persönliche Geld-/Sportorientierung und Mindestreputation.
- **Entscheidung:** Der Spieler zieht eine verdeckte Schwelle R (logistisch um μ).
  - Jedes gültige Angebot mit Nutzen ≥ R ist akzeptabel. Gibt es eines, unterschreibt er garantiert und wählt unter den akzeptablen per Logit.
  - Nur wenn alle Angebote zu schwach oder ungültig sind, bleibt er vereinslos.
- **Barometer 0–100:** genau die daraus folgende Verpflichtungswahrscheinlichkeit (`fd_fa_probs`, Spiegel `faProbabilities` im Client). Kalibrierung im Test geprüft: 5.000 Ziehungen ≈ Barometer ±3 %.
- **KI:** Wöchentlich bieten bis zu zwei passende KI-Vereine je Free Agent. Ihr Gehalt zielt auf ≈ 70 % Alleinchance (50–160 % der Forderung, höchstens 25 % des Kontos). Zwei Tage vor der Entscheidung bessern sie um +20 % nach, wenn ihre Chance unter 40 % liegt (höchstens zweimal).
- **Ansicht:**
  - Profil, Schieberegler für das Gehalt, Laufzeit, Ranking aller Interessenten mit Wappen und Barometer, Restzeit.
  - Das eigene Barometer rechnet der Client live aus dem Modell.
  - Fremde Gehälter liegen nur in `fa_applications` (für Clients gesperrt) und stehen in keiner Antwort.
  - Aktualisierung alle 20 s, solange die Ansicht offen ist.

### Spielerdaten nach UEFA-Länderranking
- **Volle Kader:** Spielland (drei Ligen) und UEFA-Top-20 (`uefa_ranking`, Fünfjahreswertung 2025/26: ENG, ITA, ESP, GER, FRA, POR, BEL, NED, TUR, CZE, POL, GRE, NOR, DEN, CYP, SUI, AUT, HUN, SCO, CRO).
- **Übrige 35 Länder:** je Verein die besten elf in Grundordnung (1 TW, 4 Abwehr, 3 Mittelfeld, 3 Angriff). Neue Welten erzeugen nur diese (`buildEuropeAssociation(..., { reduced })`).
- **Bestehende Welten:** `fd_reduce_world_players` läuft in der Migration und zu jedem Saisonende.
  - Geschützt bleiben Spieler mit Transfers, Angeboten, Spielstatistiken oder -ereignissen, Auszeichnungen, Karrierehistorie, Rekorden, Free-Agent-Verfahren, Draft oder Taktikplatz.
  - Menschliche Kader, Spielland, Top 20 und laufende Europapokal-Teilnehmer bleiben unberührt.
  - Die Mannschaftsstärke bleibt im Test praktisch unverändert (Ø Abweichung < 0,6).
- **Europapokal:** Reduzierte Teilnehmer bekommen eine temporäre Bank auf 16 Spieler (`players.temporary`).
  - Diese Spieler sind nicht auf dem Transfermarkt, nicht transferierbar und zählen nicht zur Stärke.
  - Zum Saisonende werden sie gelöscht oder, falls sie in Spielereignissen vorkommen, ohne Verein archiviert.
- **Transfermarkt:** serverseitige Filter/Suche/Sortierung mit 50er-Seiten wie bisher. Attribute erst im Spielerprofil. Filteroptionen werden 5 Minuten im Client zwischengespeichert.

**Messung (vor/nach)**

| | vorher | nachher |
|---|---|---|
| Produktion gesamt (2 große + 1 kleine Welt) | 37.355 Spieler, DB 178 MB, Spielertabellen 69 MB | erwartet ≈ 28.000 Spieler (−9.300); die Migration zeigt die genauen Zahlen je Welt an |
| Testwelt mit allen 55 Ländern | 17.815 Spieler, Spielertabellen 32 MB, DB 76 MB | 13.194 Spieler (−26 %), 23 MB, DB 67 MB |
| Transfermarkt-Suche ohne Filter | 46 ms | 33 ms |
| Suche mit Filtern | 12–19 ms | 11–17 ms |
| Filteroptionen (109 KB) | jede Öffnung 1 Abfrage | 1 Abfrage je 5 Minuten |

Speicher geben Postgres-Tabellen erst nach `VACUUM FULL` an das Dateisystem zurück; ohne diesen Schritt wird der frei gewordene Platz wiederverwendet (optional, sperrt kurz die Tabellen).

### Dynamische Fanatmosphäre
- **Modell `crowdModel.ts`:** Situation aus Ballbesitz, Abstand zum Tor, Strafraum, Tempo nach vorn (Rückpass beruhigt), Minute und Spielstand. Jede Situation liefert eine Ziel-Intensität für Heim- und Gästefans; eine Hüllkurve glättet (Anstieg ≈ 0,6 s, Abklingen ≈ 2,2 s, Verstummen nach Gegentor ≈ 0,35 s).
- **Pegel:** Abbildung auf 30 dB, Heim- und Gästespur getrennt (links/rechts). Der Gästeblock skaliert mit seinem Anteil an der Zuschauerzahl, die Auslastung bestimmt den Gesamtpegel.
- **Fangesänge:**
  - Uploads werden auch auswärts gespielt, dann seltener und leiser (≈ 38 % × Gästeblock).
  - Ohne Uploads (KI) singen die Fans generische, vereinsneutrale Gesänge: sechs eigene Rufmotive mit vielen verstimmten Stimmen, Formanten, großer Trommel und Stadionhall, im Browser gerendert und zwischengespeichert.
  - Ballbesitz und Angriffe erhöhen die Gesangswahrscheinlichkeit.
  - Es läuft höchstens ein Gesang gleichzeitig, ohne direkte Wiederholung. Torhymnen gibt es nur beim Tor des eigenen Vereins.
- **Hörbarkeit geprüft** (`crowdAudio.test.ts`, echtes Offline-Rendering des Audiographen, RMS in dBFS):

| Situation | Heim (Ziel) | Heim dB | Gäste (Ziel) | Gäste dB |
|---|---|---|---|---|
| normales Spiel | 40 % | −32,3 | 12 % | −38,9 |
| Angriff Heim | 65 % | −25,5 | 10 % | −39,1 |
| Heim vor dem Tor | 85 % | −20,0 | 8 % | −39,6 |
| Heimtor | 100 % | −16,1 (+ Jubel) | 5 % | −40,4 |
| Angriff Gäste | 25 % | −36,1 | 30 % | −34,4 |
| Auswärtstor | 5 % | −41,0 | 65 % | −25,0 |
| Schlussphase knapp | 80 % | −21,5 | 25 % | −35,7 |

  Ablauf im Test: ruhig −31,6 → Angriff −25,4 → Strafraum −20,3 → vergeben −33,2 → Rückpässe −34,3 → Heimtor −16,1 → nach Gegentor −33,8 (Gäste −24,9 statt −35,2). Kein Sprung über 6 dB zwischen zwei 100-ms-Fenstern.

## Update 0035: Vereinshymne in voller Länge
- **Einlaufdauer:** Der Einlauf dauert so lange wie die hochgeladene Heimhymne plus 2,5 s Ausklang, mindestens 20 s und höchstens 6 Minuten. Danach pfeift der Match-Server für alle gleichzeitig an.
- **Länge der Hymne:** wird beim Hochladen aus den MP3-Metadaten gespeichert (`club_audio.duration_sec`). Bei älteren Uploads misst der Browser des Heim-Managers sie beim ersten Spiel, meldet sie dem Server (der den Einlauf verlängert) und speichert sie.
- **Synchron:** Alle Clients starten die Hymne ab dem gemeinsamen Einlaufbeginn. Wer später beitritt, steigt an der laufenden Stelle ein.
- **Hymne überspringen:**
  - KI-Partie: sofortiger Anpfiff.
  - Multiplayer: Anpfiff erst, wenn alle verbundenen Manager zugestimmt haben. Die Anzeige zeigt, auf wen noch gewartet wird.
  - „Einlauf immer überspringen“ gibt die eigene Stimme automatisch ab.
- **Bild:** Einlauf (≈ 14 s), dann Aufstellung vor der Haupttribüne mit leichtem Wiegen, solange die Hymne läuft. Fahnen und Choreografie bleiben sichtbar, nichts wiederholt sich. In den letzten 5,6 s geht es in die Anfangsformation.
- **Ton:**
  - Während der Hymne sind Kulisse und Gesänge abgesenkt (Ducking 40 %).
  - Nach dem Ende der Hymne steigt die normale Kulisse über 3 s wieder an; beim Anpfiff wird die Hymne weich ausgeblendet.
  - Beim Verlassen der Partie stoppt alles.
  - Dynamische Kulisse, Fanreaktionen und Gesänge sind unverändert.

## Update (ohne SQL): kurzer Torjubel, KI-Fankurve, Einlauf überspringen
- **Torjubel:** Nach einem Tor hält die Übertragung 1,5 s an (`GOAL_HOLD_MS`, Presenter). Zusammen mit der Unterbrechung der Engine bis zum Wiederanstoß (3 s) ergibt das ≈ 4,5 s.
  - Die Engine protokolliert den Wiederanstoß als Ereignis `kickoff` mit Seite. Zufall, Spieluhr und Physik sind unverändert.
  - Der Client zeigt den Jubel: Torschütze zur Eckfahne, Mitspieler springen. Heimtor: Pegel 100 %. Auswärtstor: Heimfans verstummen, Gästeblock jubelt.
  - Der Wiederanstoß beendet Jubelsound (`endCelebration`), Torhymne und Ereignis-Hüllkurve sofort. Es gibt keine überlappenden Jubel.
  - Die Partie dauert ≈ 1,5 s länger je Tor; die Simulation selbst bleibt 3 Minuten.
- **KI-Fankurve (`synthChant.ts`):** keine Musik mehr, stattdessen Sprechchöre, Rufe und synchrones Klatschen.
  - Jeder Rufer hat eine eigene Sprechstimme, also keine gemeinsame Melodie. Dazu viel Stimmrauschen, Klatscher aus vielen einzelnen Impulsen, höchstens eine leise Trommel und Stadionhall.
  - Prüfmaß „Harmonizität“: Kurve ≈ 0,2, gesungener Chor ≈ 0,95.
- **Einlauf & Hymne überspringen:** beendet Hymne, Einlauf und Aufstellung vollständig.
  - Die Spieler stehen sofort auf den Startpositionen, die Einlaufmusik stoppt in 80 ms.
  - KI-Partie sofort; Multiplayer erst, wenn alle Manager zugestimmt haben (serverseitig).
  - Ohne Hymne nur eine kurze Einlaufsequenz (12 s). Mit Hymne läuft sie in voller Länge, wenn niemand überspringt.
- **Ablauf:** Spielvorbereitung → Einlauf/Hymne (`waiting` + Einlaufzeit) → Anpfiff (`running`) → laufendes Spiel.

## Update (ohne SQL): KI-Fans aus echten Stadionaufnahmen

Ersetzt die Abschnitte zu `synthChant.ts`, generischen Gesängen und synthetischen Fanreaktionen oben.

- **Prüfung vorher:** Im Projekt gab es keine einzige echte Zuschaueraufnahme. Alle KI-Fan-Klänge waren im Browser erzeugt: `synthChant.ts` (Rufmotive, Klatschen, Trommel), Rauschbetten sowie Jubel, „Ooooh“, Pfiffe und Raunen aus Oszillatoren mit Formanten. Das ist alles entfernt. `synthChant.ts`, `roar`, `ooh`, `jeer`, `groan` und `voices` gibt es nicht mehr.
- **Neu: Bibliothek** (`apps/web/src/lib/crowdLibrary.ts`). Sie liest statische Dateien aus `/audio/crowd/manifest.json`, ohne Supabase-Verkehr. Es gibt neun Kategorien: ambience, clap, chant_short, chant_sung, attack, chance, whistle, concede, goal. Die Auswahl erfolgt zufällig ohne direkte Wiederholung: Die letzten bis zu drei Dateien sind gesperrt, und eine Datei, die gerade auf der anderen Spur läuft, wird gemieden.
- **Mixer** (`audioMixer.ts`) mit getrennten Spuren und eigenen Reglern: Stadionrauschen · Heimfans · Gästefans · Fanreaktionen · Schiedsrichter & Ball · Hymnen.
  - **Rauschen:** lange Aufnahmen in Abschnitten von 35–80 s, abwechselnd mit Überblendung gleicher Leistung (sin/cos, 4 s). Es entsteht keine Schleifennaht.
  - **Gästeblock:** leiser, rechts, Höhen gedämpft (Tiefpass 3,6 kHz) und mit mehr Raumhall. Die Lautstärke richtet sich nach der Größe des Gästeblocks.
  - **Akustik und Pegel:** kurzer Stadionhall (Faltung). Kompressor, Begrenzer und eine weiche Sicherheits-Sättigung verhindern Übersteuern, auch wenn viele Aufnahmen übereinanderliegen.
  - **Natürliche Abwechslung:** Tempo ±3 % (Wiedergaberate), zufällige Einstiegsstellen bei langen Gesängen, und jeder Clip wird ein- und ausgeblendet.
- **Fanlogik** (`fanAudio.ts`):
  - Heim- und Gästefans singen unabhängig voneinander, je höchstens ein Gesang gleichzeitig. Danach folgt eine natürliche Pause, die in ruhigen Phasen länger ist.
  - **Hochgeladene MP3-Gesänge** werden weiter verwendet, auch für die Gäste beim Auswärtsspiel. Sie haben Vorrang (75 %); dazwischen kommen Aufnahmen aus der Bibliothek.
  - **Ereignisse:**
    - Anfeuerung beim Übergang in einen Angriff
    - Aufschrei bei Großchancen
    - Pfiffe gegen den Gegner (Foul, Karten)
    - Heimtor: Jubelaufnahme der ganzen Kurve
    - Auswärtstor: Gästeblock kurz sehr laut (≈ 4,5 s), dazu Enttäuschung der Heimfans
    - Mit dem Wiederanstoß endet der Jubel.
  - **Lautstärke** folgt Ballbesitz, Angriffen, Strafraum, Spielstand (führende Fans etwas lauter) und Zuschauerzahl.
- **Fehlende Aufnahmen** bleiben stumm und werden im Tonmenü (🎚) unter „Fehlende Stadionaufnahmen“ genannt. Es gibt keinen Ersatzklang. Einzige Ausnahme ist das Stadionrauschen: Fehlt es, läuft ein leises, gefiltertes Ersatzrauschen ohne Töne, das als „Ersatz“ gekennzeichnet ist.
- **Synthetisch bleiben** nur Schiedsrichterpfiff, Netz, Aluminium und Ballkontakt. Das sind keine Zuschauergeräusche.
- **Aufnahmen hinzufügen:** siehe [CROWD_AUDIO.md](CROWD_AUDIO.md). Die Rohdateien kommen nach `assets/crowd-raw/<kategorie>/`, mit Lizenzangabe. Danach `node scripts/crowd-audio.mjs` ausführen und `apps/web/public/audio/crowd/` committen.
- **Tests:**
  - Offline-Rendering (`crowdAudio.test.ts`): Überblendung ohne Pegelloch, Heim dominiert, Gäste hörbar und rechts, Auswärtstor im Gästeblock deutlich lauter, kein Übersteuern, keine Ersatzklänge ohne Dateien, Auswahl ohne Wiederholung.
  - Playwright (`match.spec.ts`, „KI-Fankurve“): Heimspiel, ruhige Phasen gegen Angriffe, Auswärtsspiel mit hochgeladenem Gästegesang, Heimtor, Auswärtstor, leere Bibliothek.
  - Die Tests nutzen eindeutig gekennzeichnete **Testsignale** (gefiltertes Rauschen) unter `apps/web/e2e/crowd-test/`. Diese werden nicht ausgeliefert.

## Update (ohne SQL): keine KI-Fangesänge mehr, Gesänge nur als MP3-Upload

- **Entfernt:** Sprechchöre und Kurvengesang aus der Bibliothek (Kategorien `chant_short` und `chant_sung`), die zugehörige Auswahl `chantWeights` und die Gesangsschleife für Vereine ohne Upload. Es gibt keine generierten oder künstlichen Gesänge mehr.
- **Gesänge:** Es werden ausschließlich hochgeladene MP3 des jeweiligen Vereins abgespielt.
  - Heimverein auf der Heimspur, Gastverein auf der Gästespur.
  - Die Auswahl ist zufällig, ohne direkte Wiederholung und mit Pausen.
  - KI-Vereine ohne Upload singen nicht.
- **Erhalten:**
  - dynamisches Stadionrauschen
  - kurzer Torjubel
  - Aufschrei bei Großchancen
  - Raunen bei vergebenen Chancen und Gegentoren (`concede`)
  - Pfiffe bei Fouls und Karten
  - Anfeuerung bei Angriffen
  - Netz, Aluminium und Ball
- **Rhythmisches Klatschen** ist jetzt eine situative Reaktion statt eines Gesangs: Es setzt bei einer Ecke der eigenen Mannschaft, nach mehr als 10 s eigenem Ballbesitz (Heim) und in der knappen Schlussphase ein. Danach gilt eine Sperrzeit von 25 s, für die Gäste von 50 s.
- **Gästeblock** mit Upload singt etwas häufiger als bisher (Grundrate 0,10 statt 0,07 je Sekunde).
- **Tests:** Playwright prüft KI ohne Uploads (keine Gesangsspur), Heimspiel mit Heim-Upload (nur Heimverein), Auswärtsspiel mit Gäste-Upload (nur Gastverein), ruhige Phasen, Tore und eine leere Bibliothek. Alle 18 Tests sind grün.

## Update (ohne SQL): Fanstimmung V2 (Excel „Fan- & Audio-Matrix V2“)

Grundlage ist `docs/Football_Dynasty_Fanstimmung_Audio_Matrix_V2.xlsx`. Sie wird mit `python3 scripts/import-fan-matrix.py` nach `apps/web/src/lib/fanMoodData.ts` eingelesen: 105 Zustände, 26 Ereignisse, 120 Crowd-Reaktionen, 20 Audio-Parameter.

**Gesänge**
- Es werden ausschließlich die bereitgestellten KI-Fangesänge (`public/audio/chants/ai`) bzw. die Vereins-Uploads verwendet.
- Je Partie ist eine Teilmenge von 3–6 Gesängen aktiv (bei 5 vorhandenen: 3–4), auf allen Geräten gleich.
- Prüffenster alle 5–8 s, nach dem Ende eines Gesangs 1–3 s Pause. Je Seite läuft höchstens 1 Gesang.
- Einblenden 1 s, Ausblenden 1,7 s. Ein Tor duckt laufende Gesänge in 0,22 s weg.
- Bei 0:4 ab Minute 60 liegt die Heim-Gesangschance bei 0 % (Parameter).
- Stimmungsnachlauf 8 s; die zurückliegende Fangruppe erholt sich nur langsam.
- Der Gästeblock erreicht höchstens 70 % des Heimpegels. Der Begrenzer kappt Spitzen bei 0,9.

**Crowd-Reaktionen (Klatschen, Pfeifen, Ah, Oh, Uh)**
- Eigenes Prüffenster je Seite alle 5–8 s. Die Regel richtet sich nach dem spezifischsten Zustand: −3 ab 60′ > Schlussphase ±1 > Angriff > −2 ab 45′ > +2 ab 60′ > Ballbesitz > ruhiges 0:0.
- Abspielregeln:
  - Cooldown je Reaktionsart
  - mindestens 3 s Abstand zwischen zwei Reaktionen
  - höchstens eine Reaktion je Fenster
  - nicht über den eigenen Gesang
- Großchance, Tor und Gegentor lösen je genau eine gewichtete Variante aus (ereignisgebunden).
- Die Ereignisse E01–E26 steuern weiterhin Priorität und Ducking.
- Das bisherige feste Klatsch-/Anfeuerungsverhalten ist ersetzt.

**Audiodateien**
- **Wichtig:** Für die Reaktionen braucht es echte Aufnahmen in den Ordnern `clap`, `whistle`, `aah`, `ooh` und `uuh` (siehe CROWD_AUDIO.md). Die Excel nennt dafür `claps_short.mp3`, `boo_whistle_crowd.mp3`, `crowd_aah.mp3`, `crowd_ooh.mp3` und `crowd_uuh.mp3`.
- Ohne diese Dateien bleiben die Reaktionen in Produktion stumm. Das Tonmenü (🎚) meldet sie dann als fehlend.

**Tests**
- `fanMood.test.ts`:
  - Datenimport
  - A/B-Vergleich V1/V2 über 200 deterministische 3-Minuten-Partien je Szenario
  - Prüfung auf Überladung (Pausen, Abstände, Cooldowns)
- `crowdAudio.test.ts`: Übergänge und Spitzenpegel.
- Playwright „KI-Fankurve“: u. a. 0:4 in der 60. Minute.

## Major-Update: Stadionakustik

**Gesänge**
- Etwa 25–30 % seltener. Die Excel-Logik bleibt, alle Chancen werden skaliert (`CHANT_TUNING` in `fanMood.ts`).
- Heim und Gäste singen überwiegend abwechselnd. Gleichzeitig singen sie nur selten (Faktor 0,12 während die andere Seite singt). Nach einem Gesang wechselt die Seite bevorzugt.
- Dieselbe MP3 läuft nie gleichzeitig auf beiden Spuren.
- Simulation 0:0: früher 43 % Überlagerung, jetzt etwa 8 %; Seitenwechsel bei etwa 70 %.

**Reaktionen** (lauter abgemischt, Excel-Lautstärke ÷ 50 statt ÷ 70)
- „Ahhh“ beim Eindringen in den Strafraum (Heim 55 %, Gäste 30 %).
- „Ooooh“ bei vergebener Großchance.
- Aufschrei bei Pfosten oder Latte (angreifende Fans) und „Uhhh“ beim Gegner.
- „Uhhh“ bei Elfmeterpfiff und Roter Karte.
- Applaus nach gelungenem Dribbling und für eine Parade des eigenen Torhüters.
- Pfeifkonzert bzw. Buhrufe zur Halbzeit im Rückstand und nach Gegentoren bei ≥ 2 Toren Rückstand.
- Unmutszähler je Fanlager: Er steigt bei Gegentoren und bei vergebenen Chancen im Rückstand und lässt Pfiffe in Buhrufe übergehen.
- Dynamischer Torjubel: Ausgleich, Führungstor und späte Tore sind lauter, Tore bei klarer Führung verhaltener. Der Jubel endet immer beim Wiederanstoß.
- Neue Kategorien `applause` und `boo`. Für `boo` gibt es noch keine Aufnahme; bis dahin wird ersatzweise das echte Pfeifkonzert verwendet.

**Hymne**
- Der Titel steht jetzt am oberen Rand der Stadionansicht, mit Fortschrittsbalken.
- Die Spieler stehen unten vor der Haupttribüne und werden nicht mehr verdeckt.
- Playwright-Test „Hymnentitel oben“.

## KI-Fangesangpool (Erweiterung November 2026)
- Pool `apps/web/public/audio/chants/ai/manifest.json`: 17 Gesänge (5 bisherige + 12 neue), alle auf ca. −18,5 LUFS angeglichen
  (`scripts/chant-normalize.py <quelle> <ziel>`), damit die Lautstärkeverhältnisse gleich bleiben.
- Nicht übernommen: Fangesang_KI_4–7 (identisch mit bestehenden Gesängen). Fangesang_KI_8–10 sind als „Stadiongesang 1–3“ enthalten (Sounddogs.com, Nutzungsrecht vom Inhaber bestätigt).
- Auswahl: `aiMatchSubset` (fanMood.ts) – je Partie und KI-Fanlager 2–4 Gesänge, mindestens 2 ohne Spott, Seed = Partie-ID + Seite
  (gleich auf allen Geräten und nach Reconnect). KI gegen KI: Gästeblock ohne die Gesänge des Heimblocks.
- Vereine mit eigenen Uploads: unverändert (eigene Gesänge, bisherige Teilmenge). Häufigkeit, Pausen, Übergänge, Lautstärke: unverändert.
- Neue Datei hinzufügen: normalisieren, ins Verzeichnis legen, Eintrag im Manifest (id `ai_…`, mood `support` oder `taunt`).

## Pfeifkonzerte der Heimfans (November 2026)
- Aufnahmen: `apps/web/public/audio/crowd/pfiff/` (10 kurze, 3–4 s) und `pfeifkonzert/` (5 lange, 7–16 s), erzeugt mit
  `python3 scripts/whistle-cuts.py <Ordner mit Pfeiffen_alle_*.mp3> apps/web/public/audio/crowd` (−21 LUFS wie die übrigen Pfiffe).
  Nach einem Neuaufbau mit `crowd-audio.mjs` dieses Skript erneut ausführen. Quelle: Sounddogs.com, Nutzung vom Inhaber bestätigt.
- Logik: `apps/web/src/lib/homeDisapproval.ts` (reine Logik, Tests in `homeDisapproval.test.ts`), angebunden in `fanAudio.ts`.
  - Schiedsrichter/Gegner (unabhängig vom Spielstand): hartes Foul des Gastes (Karte/Verletzung/Elfmeter in derselben Szene) 85 %,
    Foulserie (≥ 3 Gästefouls in 5 min) 50 %, einzelnes Foul 6 %, Gelb gegen Heim 55 %, Rot gegen Heim 92 %, Elfmeter gegen Heim 90 %, Abseits gegen Heim 10 %.
  - Schwache Heimleistung (abhängig von Spielstand, Minute, aufgestauter Unzufriedenheit D 0…1): Gefahr in Serie, Gegentor nach Ballverlust
    in der eigenen Hälfte, Gegentor zum 0:2/0:3…, Ballverluste nur bei Rückstand und D > 0,45, anhaltender Rückstand (Prüfung alle 20 s), lange schwache Phase.
  - Fouls des Heimteams lösen bei den Heimfans nie Pfiffe aus. Gästefans: unverändert.
  - Cooldowns: 14 s zwischen Pfeifreaktionen (schwere Entscheidungen 6 s), 45 s je Ursache, 50 s zwischen langen Konzerten, höchstens 5 je 10 Minuten.
  - Während eines Pfiffs werden Heimgesänge auf 50 % (Konzert 25 %) geduckt, Gästegesänge kaum; neue Heimgesänge erst danach.
- Tests im Browser: Harness-Parameter `dis=always` (jede erlaubte Reaktion wird gespielt) und `events=off` (nur eingespeiste Testereignisse).
