import type { Position } from './domain.js';

/**
 * E1: Formationsvorlagen. Jede Vorlage beschreibt die Linien von hinten nach vorn.
 * Koordinaten: x 0 (linke Seitenlinie) … 100 (rechte), y 0 (eigenes Tor) … 100 (gegnerisches Tor).
 * Die Vorlagen sind nur Startpunkte – Manager können jede Position frei per Drag-and-drop verschieben.
 */
export interface FormationSlot {
  index: number; // 0 = Torhüter
  position: Position;
  x: number;
  y: number;
}
export interface Formation {
  code: string;
  name: string;
  slots: FormationSlot[];
}

type Line = Exclude<Position, 'GK'>[];
const DEF4: Line = ['LB', 'CB', 'CB', 'RB'];
const DEF3: Line = ['CB', 'CB', 'CB'];
const DEF5: Line = ['LWB', 'CB', 'CB', 'CB', 'RWB'];

const TEMPLATES: Array<{ code: string; name: string; lines: Line[] }> = [
  { code: '4-4-2', name: '4-4-2 flach', lines: [DEF4, ['LM', 'CM', 'CM', 'RM'], ['ST', 'ST']] },
  { code: '4-4-2-def', name: '4-4-2 defensiv', lines: [DEF4, ['LM', 'CDM', 'CDM', 'RM'], ['ST', 'ST']] },
  { code: '4-4-2-diamond', name: '4-4-2 Raute', lines: [DEF4, ['CDM'], ['CM', 'CM'], ['CAM'], ['ST', 'ST']] },
  { code: '4-3-3', name: '4-3-3', lines: [DEF4, ['CM', 'CM', 'CM'], ['LW', 'ST', 'RW']] },
  { code: '4-3-3-def', name: '4-3-3 defensiv', lines: [DEF4, ['CDM'], ['CM', 'CM'], ['LW', 'ST', 'RW']] },
  { code: '4-3-3-att', name: '4-3-3 offensiv', lines: [DEF4, ['CM', 'CM'], ['CAM'], ['LW', 'ST', 'RW']] },
  { code: '4-3-3-f9', name: '4-3-3 falsche Neun', lines: [DEF4, ['CM', 'CDM', 'CM'], ['LW', 'CF', 'RW']] },
  { code: '4-2-3-1', name: '4-2-3-1', lines: [DEF4, ['CDM', 'CDM'], ['LM', 'CAM', 'RM'], ['ST']] },
  { code: '4-2-3-1-wide', name: '4-2-3-1 breit', lines: [DEF4, ['CDM', 'CDM'], ['LW', 'CAM', 'RW'], ['ST']] },
  { code: '4-1-4-1', name: '4-1-4-1', lines: [DEF4, ['CDM'], ['LM', 'CM', 'CM', 'RM'], ['ST']] },
  { code: '4-5-1', name: '4-5-1', lines: [DEF4, ['LM', 'CM', 'CM', 'CM', 'RM'], ['ST']] },
  { code: '4-4-1-1', name: '4-4-1-1', lines: [DEF4, ['LM', 'CM', 'CM', 'RM'], ['CF'], ['ST']] },
  { code: '4-2-2-2', name: '4-2-2-2', lines: [DEF4, ['CDM', 'CDM'], ['CAM', 'CAM'], ['ST', 'ST']] },
  { code: '4-3-1-2', name: '4-3-1-2', lines: [DEF4, ['CM', 'CM', 'CM'], ['CAM'], ['ST', 'ST']] },
  { code: '4-3-2-1', name: '4-3-2-1 Tannenbaum', lines: [DEF4, ['CM', 'CM', 'CM'], ['CAM', 'CAM'], ['ST']] },
  { code: '4-2-4', name: '4-2-4', lines: [DEF4, ['CM', 'CM'], ['LW', 'ST', 'ST', 'RW']] },
  { code: '4-1-3-2', name: '4-1-3-2', lines: [DEF4, ['CDM'], ['LM', 'CM', 'RM'], ['ST', 'ST']] },
  { code: '4-2-1-3', name: '4-2-1-3', lines: [DEF4, ['CDM', 'CDM'], ['CAM'], ['LW', 'ST', 'RW']] },
  { code: '3-5-2', name: '3-5-2', lines: [DEF3, ['LWB', 'CM', 'CDM', 'CM', 'RWB'], ['ST', 'ST']] },
  { code: '3-4-3', name: '3-4-3', lines: [DEF3, ['LM', 'CM', 'CM', 'RM'], ['LW', 'ST', 'RW']] },
  { code: '3-4-3-diamond', name: '3-4-3 Raute', lines: [DEF3, ['CDM'], ['LM', 'RM'], ['CAM'], ['LW', 'ST', 'RW']] },
  { code: '3-4-1-2', name: '3-4-1-2', lines: [DEF3, ['LWB', 'CM', 'CM', 'RWB'], ['CAM'], ['ST', 'ST']] },
  { code: '3-4-2-1', name: '3-4-2-1', lines: [DEF3, ['LWB', 'CM', 'CM', 'RWB'], ['CAM', 'CAM'], ['ST']] },
  { code: '3-5-1-1', name: '3-5-1-1', lines: [DEF3, ['LWB', 'CM', 'CM', 'CM', 'RWB'], ['CF'], ['ST']] },
  { code: '3-2-4-1', name: '3-2-4-1', lines: [DEF3, ['CDM', 'CDM'], ['LW', 'CAM', 'CAM', 'RW'], ['ST']] },
  { code: '5-3-2', name: '5-3-2', lines: [DEF5, ['CM', 'CM', 'CM'], ['ST', 'ST']] },
  { code: '5-4-1', name: '5-4-1', lines: [DEF5, ['LM', 'CM', 'CM', 'RM'], ['ST']] },
  { code: '5-2-3', name: '5-2-3', lines: [DEF5, ['CM', 'CM'], ['LW', 'ST', 'RW']] },
  { code: '5-2-1-2', name: '5-2-1-2', lines: [DEF5, ['CM', 'CM'], ['CAM'], ['ST', 'ST']] },
  { code: '5-1-2-1-1', name: '5-1-2-1-1', lines: [DEF5, ['CDM'], ['CM', 'CM'], ['CAM'], ['ST']] },
];

const WIDE_LEFT = new Set<Position>(['LB', 'LWB', 'LM', 'LW']);
const WIDE_RIGHT = new Set<Position>(['RB', 'RWB', 'RM', 'RW']);

function buildSlots(lines: Line[]): FormationSlot[] {
  const slots: FormationSlot[] = [{ index: 0, position: 'GK', x: 50, y: 5 }];
  const n = lines.length;
  lines.forEach((line, li) => {
    const y = n === 1 ? 50 : Math.round(20 + (li * 58) / (n - 1));
    const central = line.filter((p) => !WIDE_LEFT.has(p) && !WIDE_RIGHT.has(p));
    let ci = 0;
    for (const position of line) {
      let x: number;
      if (WIDE_LEFT.has(position)) x = 12;
      else if (WIDE_RIGHT.has(position)) x = 88;
      else {
        const spread = central.length === 1 ? [50] : central.map((_, k) => Math.round(30 + (k * 40) / (central.length - 1)));
        x = spread[ci++] ?? 50;
      }
      slots.push({ index: slots.length, position, x, y });
    }
  });
  return slots;
}

export const FORMATIONS: readonly Formation[] = TEMPLATES.map((t) => ({ code: t.code, name: t.name, slots: buildSlots(t.lines) }));

export function getFormation(code: string): Formation | undefined {
  return FORMATIONS.find((f) => f.code === code);
}
