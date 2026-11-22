#!/usr/bin/env python3
"""KI-Fangesänge auf die Lautheit des bestehenden Pools bringen (2-Pass-loudnorm, -18,4 LUFS, True Peak -1,5 dB),
Metadaten/Cover entfernen, MP3 128 kbit/s 44,1 kHz Stereo.  Aufruf: chant-normalize.py <quelle.mp3> <ziel.mp3>"""
import json, re, subprocess, sys
I, TP, LRA = -18.4, -1.5, 11
src, dst = sys.argv[1], sys.argv[2]
p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-nostdin', '-i', src, '-af', f'loudnorm=I={I}:TP={TP}:LRA={LRA}:print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
m = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', p.stderr).group(0))
af = (f"loudnorm=I={I}:TP={TP}:LRA={LRA}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
      f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,aresample=44100")
subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', src, '-map', '0:a', '-map_metadata', '-1', '-af', af, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', dst], check=True)
