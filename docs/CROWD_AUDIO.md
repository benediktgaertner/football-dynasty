# Stadionaufnahmen für die KI-Fans

Die KI-Fans klingen nur über echte, lizenzierte Aufnahmen. **Fangesänge gehören nicht in diese Bibliothek:** Gesänge kommen ausschließlich aus den MP3-Uploads der Vereine (Stadioneditor). KI-Vereine ohne Upload singen nicht. Fehlt eine Kategorie, bleibt sie stumm. Im Spiel nennt das Tonmenü (🎚) die fehlenden Kategorien.

## Benötigte Dateien

Mindestens die genannte Anzahl, besser mehr (mehr Abwechslung). Zielformat der Rohdatei: WAV oder FLAC (oder MP3 ≥ 192 kbit/s), 44,1 oder 48 kHz, Stereo, ohne Musik, Durchsagen oder Stadionsprecher.

| Ordner (`assets/crowd-raw/…`) | Inhalt | Anzahl | Länge |
|---|---|---|---|
| `ambience/` | volles Stadion im laufenden Spiel: Gemurmel, vereinzelte Rufe, entferntes Singen | 3 | 1–4 min |
| `clap/` | rhythmisches Klatschen der Kurve (gern mit „Hey“-Rufen) | 3 | 6–30 s |
| `attack/` | anschwellendes Antreiben bei einem Angriff | 3 | 2–8 s |
| `chance/` | Aufschrei / „Ooooh“ nach Großchance oder Parade | 3 | 2–5 s |
| `whistle/` | Pfeifkonzert und Buhrufe gegen den Gegner | 3 | 2–8 s |
| `concede/` | Stöhnen/Raunen nach Gegentor oder knapp vergebener Chance | 2 | 2–6 s |
| `goal/` | Torjubel ab dem Moment des Tores | 3 | 4–10 s |
| `clap/` → z. B. `claps_short.mp3` | kurzes synchrones Klatschen (auch als Crowd-Reaktion) | 3 | 1–3 s reichen, längere werden gekürzt |
| `whistle/` → z. B. `boo_whistle_crowd.mp3` | Pfeifkonzert/Unmut der Fans (kein Schiedsrichterpfiff!) | 3 | 1–4 s |
| `aah/` → z. B. `crowd_aah.mp3` | kurzes gespanntes „Ah“ | 2 | 0,6–2 s |
| `ooh/` → z. B. `crowd_ooh.mp3` | kollektives „Oh“ (knapp vorbei) | 2 | 0,6–2 s |
| `uuh/` → z. B. `crowd_uuh.mp3` | tiefes „Uh“/Raunen | 2 | 0,6–2 s |

Die fünf Reaktionsarten der Matrix V2 (Klatschen, Pfeifen, Ah, Oh, Uh) nutzen diese Ordner. Fehlt „Ah/Oh/Uh“, wird ersatzweise die
nächstverwandte echte Aufnahme genommen (Ah → `attack`, Oh → `chance`, Uh → `concede`); fehlt auch die, bleibt es stumm.

Zu jeder Datei gehört eine Lizenzangabe, gleichnamig als `.json`:

```json
{ "credit": "paulw2k (freesound.org)", "license": "CC BY 4.0", "source": "https://freesound.org/s/196461/" }
```

Alternativ kann man alle Angaben in `assets/crowd-raw/sources.json` sammeln, mit `"<ordner>/<datei>"` als Schlüssel.

## Aufbereiten

```bash
node scripts/crowd-audio.mjs          # erzeugt apps/web/public/audio/crowd/{kategorie}/*.mp3, manifest.json, CREDITS.md
node scripts/crowd-audio.mjs --check  # prüft Manifest, Dateien, Dauer, Spitzenpegel, Lizenzen
```

Das Skript benötigt ffmpeg. Es arbeitet in dieser Reihenfolge:

1. Trittschall-Hochpass
2. Stille am Anfang entfernen (bei Ereignissen)
3. Länge begrenzen
4. Lautheit nach EBU R128 je Kategorie angleichen
5. Ein- und Ausblendung
6. Spitzen begrenzen
7. Als MP3 kodieren

Abgelehnt werden:
- Dateien ohne Lizenz
- CC-ND-Lizenzen (Bearbeitung ist nicht erlaubt)
- CC-NC-Lizenzen (nur mit `--allow-nc`)
- KI-generierte Quellen

Die Ordner `apps/web/public/audio/crowd/` und `CREDITS.md` werden committet. CREDITS.md ist die Namensnennung, die CC BY verlangt. Die Rohdateien sind per .gitignore ausgeschlossen.

## Geeignete Quellen (Lizenz vor Verwendung jeweils prüfen)

- **Freesound, Nutzer paulw2k:** Aufnahmen aus Brentford, CC BY 4.0. Beispiele: 196461 „Football-crowd-GOAL“ (goal), 196284 Gesang/Freistoß (ambience), 196462 Gesang nach Foul (whistle), 196463 Jubel/Buhrufe/Pfiffe (whistle, chance).
- **Gregor Quendel, „Free Crowd Cheering Sounds“ (itch.io):** CC BY 4.0, enthält rhythmischen Jubel und Ambience (clap, ambience).
- **Freesound allgemein:** Suche nach „football crowd“, „stadium chant“ oder „ultras“, Filter auf CC0 oder CC BY. Bei Feldaufnahmen aus Bundesliga-Stadien (z. B. 189821/189823) muss die Lizenz einzeln geprüft werden.
- **Kostenpflichtige Pakete** (einmal kaufen, keine laufenden Kosten): rawambience (itch.io) „Stadium Ambience“, Artlist/Soundbat „Soccer Stadium Ambiance“, Motion Array.
- **Eigene Aufnahmen** im Stadion, z. B. mit dem Handy in Stereo, sind ebenfalls möglich. Angabe dann: `"license": "Eigene Aufnahme"`.

Nicht verwenden: KI-Audiogeneratoren (z. B. ElevenLabs), Ausschnitte aus TV-Übertragungen oder YouTube und Aufnahmen mit Stadionmusik.
