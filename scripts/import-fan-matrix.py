#!/usr/bin/env python3
"""Fanstimmungs-Matrix (Excel) → apps/web/src/lib/fanMoodData.ts

    python3 scripts/import-fan-matrix.py [docs/Football_Dynasty_Fanstimmung_Audio_Matrix.xlsx]

Liest die Blätter „Stimmungs-Matrix“ (105 Zustände) und „Ereignis-Sounds“ (26 Ereignisse).
Gelbe Werte in der Excel anpassen, Skript ausführen, neu bauen – der Code liest nur die erzeugte Datei.
"""
import json, sys, warnings
from pathlib import Path
warnings.filterwarnings('ignore')
import openpyxl

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'docs/Football_Dynasty_Fanstimmung_Audio_Matrix.xlsx'
wb = openpyxl.load_workbook(src, data_only=True)

PHASE = {'Früh': 0, 'Mitte': 1, 'Spät': 2}
DIFF = {'Heim +3 oder mehr': 3, 'Heim +2': 2, 'Heim +1': 1, 'Unentschieden': 0, 'Heim −1': -1, 'Heim −2': -2, 'Heim −3 oder mehr': -3}
SIT = {'Ruhige Phase': 0, 'Heimteam Ballbesitz': 1, 'Heimteam Angriff': 2, 'Gästeteam Ballbesitz': 3, 'Gästeteam Angriff': 4}

def pct(v):
    v = float(v)
    if not 0 <= v <= 100: raise ValueError(f'Wert außerhalb 0–100: {v}')
    return round(v, 2)

rows = []
for r in wb['Stimmungs-Matrix'].iter_rows(min_row=5, values_only=True):
    if not r[0]: continue
    rows.append({'id': r[0], 'phase': PHASE[r[1]], 'diff': DIFF[r[3].replace('-', '−')], 'sit': SIT[r[4]],
                 'homeMood': r[5], 'awayMood': r[6], 'homeChant': pct(r[7]), 'awayChant': pct(r[8]),
                 'homeLevel': pct(r[9]), 'awayLevel': pct(r[10]), 'homeWhistle': pct(r[11]), 'rule': r[12]})
keys = {(x['phase'], x['diff'], x['sit']) for x in rows}
assert len(rows) == 105 and len(keys) == 105, f'erwartet 105 eindeutige Zustände, gefunden {len(rows)}/{len(keys)}'

events = []
for r in wb['Ereignis-Sounds'].iter_rows(min_row=5, values_only=True):
    if not r[0]: continue
    events.append({'id': r[0], 'name': r[1], 'fans': r[2], 'level': pct(r[3]), 'duration': float(r[4]), 'effect': r[5], 'note': r[6], 'priority': int(r[7])})
assert len(events) == 26, f'erwartet 26 Ereignisse, gefunden {len(events)}'

def lines(xs):
    return '[\n' + ',\n'.join('  ' + json.dumps(x, ensure_ascii=False) for x in xs) + ',\n]'

out = root / 'apps/web/src/lib/fanMoodData.ts'
out.write_text(
    '// ERZEUGT von scripts/import-fan-matrix.py aus docs/Football_Dynasty_Fanstimmung_Audio_Matrix.xlsx – nicht von Hand ändern.\n'
    '/* eslint-disable */\n'
    'import type { MoodRow, MoodEvent } from \'./fanMood\';\n\n'
    f'export const MOOD_ROWS: MoodRow[] = {lines(rows)};\n\n'
    f'export const MOOD_EVENTS: MoodEvent[] = {lines(events)};\n', encoding='utf-8')
print(f'{len(rows)} Zustände, {len(events)} Ereignisse → {out.relative_to(root)}')
