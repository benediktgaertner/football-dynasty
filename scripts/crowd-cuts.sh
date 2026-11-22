#!/usr/bin/env bash
# Schneidet die Stadionaufnahmen (Freesound-Originale) in die Kategorien unter assets/crowd-raw/ – danach:
#   node scripts/crowd-audio.mjs --allow-nc
# Originale (nicht im Repo, zu groß) in einen Ordner legen und ihn angeben:
#   bash scripts/crowd-cuts.sh <ordner-mit-originalen>
# Erwartete Dateien: 260585__vcantos__ambiente-sonoro_estadio-mestalla.aiff, 368484__georgeradio__fca-supporters.wav,
#   369420__vk__maraca_04.aiff, 654084__dan_audiofile__football-match_chanting-crowd_ambience-stereo.wav (Namen dürfen ein Präfix haben)
set -euo pipefail
SRC="${1:?Ordner mit den Originalen angeben}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; R="$ROOT/assets/crowd-raw"
find1() { ls "$SRC"/*"$1"* 2>/dev/null | head -1; }
M="$(find1 260585)"; F="$(find1 368484)"; X="$(find1 369420)"; W="$(find1 654084)"
lic() { case $1 in M) echo '{"credit":"vcantos (freesound.org) – Mestalla, Valencia vs. FC Barcelona","license":"CC BY-NC 4.0","source":"https://freesound.org/s/260585/"}';; F) echo '{"credit":"georgeradio (freesound.org) – FC Augsburg Fans","license":"CC BY-NC 4.0","source":"https://freesound.org/s/368484/"}';; X) echo '{"credit":"_vk (freesound.org) – Maracanã, Flamengo vs. Botafogo","license":"CC0 1.0","source":"https://freesound.org/s/369420/"}';; W) echo '{"credit":"Dan_AudioFile (freesound.org) – Wimbledon Stadium","license":"CC BY 4.0","source":"https://freesound.org/s/654084/"}';; esac; }
DARK="lowpass=f=1000,asetrate=44100*0.93,aresample=44100"
cut() { # cut <lizenz> <datei> <kategorie> <name> <start> <ende> [filter]
  mkdir -p "$R/$3"; ffmpeg -y -loglevel error -ss "$5" -to "$6" -i "$2" -af "${7:-anull}" -ac 2 -ar 44100 -c:a pcm_s16le "$R/$3/$4.wav"
  if [ -n "${7:-}" ]; then lic "$1" | sed 's/","license"/ (bearbeitet: Tiefpass, um 7 % verlangsamt)","license"/' > "$R/$3/$4.json"; else lic "$1" > "$R/$3/$4.json"; fi; }
cut M "$M" ambience mestalla_gesang 5 50; cut M "$M" ambience mestalla_mittel 60 86.5; cut X "$X" ambience maracana_kulisse 0 26; cut M "$M" ambience mestalla_nach_tor 266 292
for s in 95 103 111 290 298; do cut M "$M" clap mestalla_klatschen_$s $s $((s+7)); done
for s in 1 9 17; do cut F "$F" clap augsburg_klatschen_$s $s $((s+7)); done; cut F "$F" clap augsburg_klatschen_24 24.5 31.5; cut W "$W" clap wimbledon_applaus 0.3 5.9
for s in 151 181 187 193 199 205 212 218 223; do cut M "$M" whistle mestalla_pfiffe_$s $s $((s+4)).5; done
cut M "$M" goal mestalla_jubel_253 253.3 262; cut M "$M" goal mestalla_jubel_172 171.8 179; cut M "$M" goal mestalla_jubel_232 231.9 239
cut M "$M" ooh mestalla_oh_228 228.1 231.2; cut M "$M" ooh mestalla_oh_168 167.9 171.5
cut M "$M" chance mestalla_aufschrei_228 228.1 232.5; cut M "$M" chance mestalla_aufschrei_168 167.9 172; cut M "$M" chance mestalla_aufschrei_140 140.3 143.2
cut M "$M" aah mestalla_ah_140 140.3 142.8; cut M "$M" aah mestalla_ah_150 150.0 151.6
cut M "$M" uuh mestalla_uh_140 140.3 143.0 "$DARK"; cut M "$M" uuh mestalla_uh_228 228.1 231.5 "$DARK"
cut M "$M" concede mestalla_raunen_228 228.6 233 "$DARK"; cut M "$M" concede mestalla_raunen_168 168.4 172.5 "$DARK"
cut M "$M" attack mestalla_anschwellen_165 165.3 168.1; cut M "$M" attack mestalla_anschwellen_231 231.3 234.5; cut M "$M" attack mestalla_anschwellen_252 251.8 254.2
# Applaus (freier Beifall): Wimbledon-Aufnahme, Anfang
cut W "$W" applause wimbledon_beifall 0.3 5.9
echo "Fertig: $(find "$R" -name '*.wav' | wc -l) Ausschnitte → $R"
