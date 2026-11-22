#!/usr/bin/env python3
"""Pfeifkonzerte der Heimfans aus den hochgeladenen Aufnahmen (Pfeiffen_alle_1..5.mp3) erzeugen.
- Kategorie „pfiff“: kurze Pfiffe/Buhrufe (3–4,5 s) – je Aufnahme zwei Ausschnitte
- Kategorie „pfeifkonzert“: ganze Aufnahme (7–16 s) für anhaltenden Unmut
Lautheit wie die bisherigen Pfiff-Aufnahmen (−21 LUFS, 2-Pass), weiche Ein-/Ausblendung, MP3 128 kbit/s, ohne Metadaten.
Aufruf: whistle-cuts.py <Ordner mit Pfeiffen_alle_*.mp3> <apps/web/public/audio/crowd>"""
import glob, json, os, re, subprocess, sys
src_dir, crowd = sys.argv[1], sys.argv[2]
I = -21.0
def dur(f): return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], capture_output=True, text=True).stdout)
def cut(src, dst, start, length, fin, fout):
    trim = f'atrim={start}:{start + length},asetpts=PTS-STARTPTS'
    p = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-nostdin', '-i', src, '-af', f'{trim},loudnorm=I={I}:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    m = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', p.stderr).group(0))
    ln = (f"loudnorm=I={I}:TP=-2:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    af = f"{trim},{ln},aresample=44100,afade=t=in:d={fin},afade=t=out:st={max(0, length - fout):.2f}:d={fout}"
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-i', src, '-map', '0:a', '-map_metadata', '-1', '-af', af, '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', dst], check=True)
    return round(dur(dst), 2)
out = []
CREDIT = 'Sounddogs.com („Soccer1“) – Nutzungsrecht vom Projektinhaber bestätigt (22.11.2026)'
for cat in ('pfiff', 'pfeifkonzert'): os.makedirs(os.path.join(crowd, cat), exist_ok=True)
for src in sorted(glob.glob(os.path.join(src_dir, '*Pfeiffen_alle_*.mp3')), key=lambda s: int(re.search(r'_(\d+)\.mp3$', s).group(1))):
    n = int(re.search(r'_(\d+)\.mp3$', src).group(1)); D = dur(src)
    for k, (start, length) in enumerate([(0.3, 3.2), (min(D - 4.6, D * 0.45), 4.3)], 1):
        name = f'pfiff/pfiff_{n}_{k}.mp3'
        out.append({'id': f'pfiff_{n}_{k}', 'category': 'pfiff', 'file': name, 'duration': cut(src, os.path.join(crowd, name), round(start, 2), length, 0.12, 0.7), 'gain': 1, 'credit': CREDIT, 'license': 'Nutzung durch Inhaber bestätigt', 'source': f'Pfeiffen_alle_{n}.mp3'})
    name = f'pfeifkonzert/pfeifkonzert_{n}.mp3'
    out.append({'id': f'pfeifkonzert_{n}', 'category': 'pfeifkonzert', 'file': name, 'duration': cut(src, os.path.join(crowd, name), 0.0, round(D - 0.05, 2), 0.5, 1.4), 'gain': 1, 'credit': CREDIT, 'license': 'Nutzung durch Inhaber bestätigt', 'source': f'Pfeiffen_alle_{n}.mp3'})
mf = os.path.join(crowd, 'manifest.json'); m = json.load(open(mf))
m['files'] = [f for f in m['files'] if f['category'] not in ('pfiff', 'pfeifkonzert')] + out
open(mf, 'w').write(json.dumps(m, ensure_ascii=False, indent=2) + '\n')
for f in out: print(f['id'], f['duration'])
