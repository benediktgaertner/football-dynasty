#!/usr/bin/env python3
"""Fanstimmungs-Matrix V2 (Excel) → apps/web/src/lib/fanMoodData.ts

    python3 scripts/import-fan-matrix.py [docs/Football_Dynasty_Fanstimmung_Audio_Matrix_V2.xlsx]

Liest „Stimmungs-Matrix“ (105 Zustände), „Ereignis-Sounds“ (26), „Crowd-Reaktionen“ (120) und „Audio-Parameter“.
Gelbe Werte in der Excel anpassen, Skript ausführen, neu bauen – der Code liest nur die erzeugte Datei.
"""
import json, sys, warnings
from pathlib import Path
warnings.filterwarnings('ignore')
import openpyxl

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'docs/Football_Dynasty_Fanstimmung_Audio_Matrix_V2.xlsx'
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

TRIGGER = {
    'Ruhiges 0:0': 'calm00', 'Eigene Mannschaft mit Ball': 'own_ball', 'Eigener Angriff': 'own_attack', 'Gegnerischer Angriff': 'opp_attack',
    'Eigene Großchance knapp vorbei': 'own_chance', 'Gegnerische Großchance knapp vorbei': 'opp_chance', 'Eigenes Tor (unterbricht Gesang)': 'own_goal',
    'Gegentor (unterbricht Gesang)': 'opp_goal', 'Eigene Mannschaft -2 Tore ab 45.': 'minus2_45', 'Eigene Mannschaft -3+ Tore ab 60.': 'minus3_60',
    'Eigene Mannschaft +2 Tore ab 60.': 'plus2_60', 'Spannende Schlussphase ±1 Tor': 'tight_finale',
}
REACTION = {'Klatschen': 'clap', 'Pfeifen': 'whistle', 'Ah': 'aah', 'Oh': 'ooh', 'Uh': 'uuh'}
reactions = []
for r in wb['Crowd-Reaktionen'].iter_rows(min_row=4, values_only=True):
    if not r[0] or not str(r[0]).startswith('C'): continue
    reactions.append({'id': r[0], 'trigger': TRIGGER[r[1]], 'side': 'home' if r[2] == 'Heim' else 'away', 'reaction': REACTION[r[3]],
                      'chance': pct(r[4]), 'volume': pct(r[5]), 'minSec': float(r[6]), 'maxSec': float(r[7]), 'cooldown': float(r[8]),
                      'priority': int(r[9]), 'eventBound': str(r[11]).startswith('Ereignisgebunden') or TRIGGER[r[1]] in ('own_goal', 'opp_goal')})
assert len(reactions) == 120, f'erwartet 120 Crowd-Reaktionen, gefunden {len(reactions)}'

PARAM = {
    'Prüfintervall Gesang min': 'chantCheckMin', 'Prüfintervall Gesang max': 'chantCheckMax', 'Gesang-Pause min': 'chantPauseMin',
    'Gesang-Pause max': 'chantPauseMax', 'Max. Heim-MP3 gleichzeitig': 'maxHomeChants', 'Max. Gast-MP3 gleichzeitig': 'maxAwayChants',
    'Crossfade Gesang ein': 'fadeIn', 'Crossfade Gesang aus': 'fadeOut', 'Not-Ducking bei Tor': 'goalDuck', 'Torjubel maximal': 'goalMax',
    'Reaktions-Check-Intervall min': 'reactionCheckMin', 'Reaktions-Check-Intervall max': 'reactionCheckMax', 'Reaktions-Mindestabstand': 'reactionGap',
    'Fangruppen-Stimmungsnachlauf': 'moodLag', 'Heimfans -3+ Tore nach 60. min Gesangschance': 'homeChantDeficit3After60',
    'Auswärtspegel relative Obergrenze': 'awayCapPercent', 'Audio-Peak-Limiter': 'peakLimit', 'Zufällige MP3-Teilmenge pro Match min': 'subsetMin',
    'Zufällige MP3-Teilmenge pro Match max': 'subsetMax', 'Keine identische MP3 direkt wiederholen': 'noRepeat',
}
params = {}
for r in wb['Audio-Parameter'].iter_rows(min_row=4, values_only=True):
    if r[0] in PARAM: params[PARAM[r[0]]] = float(r[1])
missing = set(PARAM.values()) - set(params)
assert not missing, f'Parameter fehlen: {missing}'

def lines(xs):
    return '[\n' + ',\n'.join('  ' + json.dumps(x, ensure_ascii=False) for x in xs) + ',\n]'

out = root / 'apps/web/src/lib/fanMoodData.ts'
out.write_text(
    '// ERZEUGT von scripts/import-fan-matrix.py aus docs/Football_Dynasty_Fanstimmung_Audio_Matrix.xlsx – nicht von Hand ändern.\n'
    '/* eslint-disable */\n'
    'import type { MoodRow, MoodEvent, CrowdRule, AudioParams } from \'./fanMood\';\n\n'
    f'export const MOOD_ROWS: MoodRow[] = {lines(rows)};\n\n'
    f'export const MOOD_EVENTS: MoodEvent[] = {lines(events)};\n\n'
    f'export const CROWD_RULES: CrowdRule[] = {lines(reactions)};\n\n'
    f'export const AUDIO_PARAMS: AudioParams = {json.dumps(params, ensure_ascii=False, indent=2)};\n', encoding='utf-8')
print(f'{len(rows)} Zustände, {len(events)} Ereignisse, {len(reactions)} Crowd-Reaktionen, {len(params)} Parameter → {out.relative_to(root)}')
