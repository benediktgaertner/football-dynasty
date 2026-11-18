import type { GoalkeeperAttributes, OutfieldAttributes, Position, Region } from '../domain.js';
import type { Rng } from '../rng.js';
import { annualSalary, marketValue } from '../rules/economy.js';
import { goalkeeperOverall, outfieldOverall, positionDistance, positionWeights } from '../rules/positions.js';
import { FAMOUS_PLAYER_NAMES, NATIONALITIES, nationalitiesByRegion, type NationalityNames } from './names.js';

/** Ein generierter Spieler im Format, das die Datenbank-Initialisierung erwartet. */
export interface GeneratedPlayer {
  first: string;
  last: string;
  nat: string;
  region: Region;
  age: number;
  pos: Position;
  sec: Position[];
  overall: number;
  potential: number;
  value: number;
  salary: number;
  prefShirt: number;
  kind: 'outfield' | 'goalkeeper';
  attrs: OutfieldAttributes | GoalkeeperAttributes;
}

const OUTFIELD_KEYS = [
  'pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical', 'stamina', 'gameIntelligence', 'heading', 'mentality',
  'freeKicks', 'penalties', 'corners', 'crossing', 'throwIns',
] as const;
const GK_CORE = ['reflexes', 'handling', 'positioning', 'oneOnOne', 'commandOfArea', 'distribution', 'kicking', 'reactionSpeed', 'gameIntelligence', 'mentality'] as const;

const clamp = (v: number) => Math.max(1, Math.min(99, Math.round(v)));

/**
 * Justiert Attribute, bis die gerundete Gesamtstärke exakt dem Ziel entspricht:
 * grob alle relevanten Attribute gemeinsam, fein einzelne Attribute (verhindert
 * ein Pendeln durch die Rundung).
 */
function tune<K extends string>(attrs: Record<K, number>, keys: readonly K[], overall: () => number, target: number, rng: Rng): void {
  for (let i = 0; i < 60; i++) {
    const diff = target - overall();
    if (Math.abs(diff) < 2) break;
    for (const k of keys) attrs[k] = clamp(attrs[k] + Math.sign(diff));
  }
  for (let i = 0; i < 400; i++) {
    const diff = target - overall();
    if (diff === 0) return;
    const k = rng.pick(keys);
    const next = clamp(attrs[k] + Math.sign(diff));
    if (next !== attrs[k]) attrs[k] = next;
  }
}

export function pickWeighted<T extends { weight: number }>(rng: Rng, items: readonly T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng.next() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i;
  }
  return items[items.length - 1]!;
}

export function pickNationality(rng: Rng, region: Region): NationalityNames {
  return pickWeighted(rng, nationalitiesByRegion(region));
}

export function nationalityByCode(code: string): NationalityNames {
  const n = NATIONALITIES.find((x) => x.code === code);
  if (!n) throw new Error(`Unbekannte Nationalität ${code}`);
  return n;
}

/** Fiktiver Name passend zur Nationalität; bekannte reale Profis und Doppelungen werden neu gewürfelt. */
export function generateName(rng: Rng, nat: NationalityNames, used: Set<string>): { first: string; last: string } {
  for (let i = 0; i < 30; i++) {
    const first = rng.pick(nat.first);
    const last = rng.pick(nat.last);
    const full = `${first} ${last}`;
    if (FAMOUS_PLAYER_NAMES.has(full) || used.has(`${nat.code}:${full}`)) continue;
    used.add(`${nat.code}:${full}`);
    return { first, last };
  }
  return { first: rng.pick(nat.first), last: rng.pick(nat.last) };
}

/**
 * D5: Attribute so erzeugen, dass die positionsabhängige Gesamtstärke exakt `target` ergibt.
 * Relevante Attribute streuen um die Zielstärke (individuelle Profile), irrelevante liegen
 * deutlich darunter. Danach werden die relevanten Attribute schrittweise justiert.
 */
export function generateOutfieldAttributes(rng: Rng, position: Exclude<Position, 'GK'>, target: number): OutfieldAttributes {
  const weights = positionWeights(position);
  const attrs = {} as Record<(typeof OUTFIELD_KEYS)[number], number>;
  for (const key of OUTFIELD_KEYS) {
    const w = weights[key] ?? 0;
    if (w > 0) attrs[key] = clamp(target + rng.normal(w >= 0.15 ? 1 : 0, 4.5));
    else if (key === 'stamina' || key === 'mentality' || key === 'physical') attrs[key] = clamp(rng.normal(target - 6, 7));
    else attrs[key] = clamp(rng.normal(target - 16, 9));
  }
  const relevant = OUTFIELD_KEYS.filter((k) => (weights[k] ?? 0) > 0);
  tune(attrs, relevant, () => outfieldOverall(attrs, position), target, rng);
  return attrs;
}

export function generateGoalkeeperAttributes(rng: Rng, target: number): GoalkeeperAttributes {
  const attrs = {} as Record<keyof GoalkeeperAttributes, number>;
  for (const k of GK_CORE) attrs[k] = clamp(target + rng.normal(0, 4));
  attrs.stamina = clamp(rng.normal(target - 8, 6));
  attrs.penalties = clamp(rng.normal(42, 10));
  tune(attrs, GK_CORE, () => goalkeeperOverall(attrs), target, rng);
  return attrs;
}

const ALL_OUTFIELD: Exclude<Position, 'GK'>[] = ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

export function generateSecondaryPositions(rng: Rng, main: Position): Position[] {
  if (main === 'GK') return [];
  const near = ALL_OUTFIELD.filter((p) => p !== main && positionDistance(main, p) <= 1.0);
  const roll = rng.next();
  const count = roll < 0.35 ? 0 : roll < 0.8 ? 1 : 2;
  return rng.shuffle(near).slice(0, Math.min(count, near.length));
}

/** G4: verborgenes Potenzial. Junge Spieler haben mehr Luft nach oben, aber nicht jeder wird Weltklasse. */
export function generatePotential(rng: Rng, overall: number, age: number): number {
  let bonus = 0;
  if (age <= 20) bonus = Math.round(Math.abs(rng.normal(0, 6))) + rng.int(0, 4);
  else if (age <= 23) bonus = Math.round(Math.abs(rng.normal(0, 4))) + rng.int(0, 2);
  else if (age <= 26) bonus = rng.int(0, 3);
  return Math.min(94, overall + bonus);
}

const SHIRT_PREFS: Record<Position, number[]> = {
  GK: [1, 12, 22, 30, 13, 33],
  CB: [4, 5, 3, 15, 23, 24, 26, 32],
  LB: [3, 2, 13, 18, 28],
  RB: [2, 3, 16, 22, 27],
  LWB: [3, 18, 28, 13],
  RWB: [2, 16, 27, 22],
  CDM: [6, 8, 16, 14, 20],
  CM: [8, 10, 14, 16, 18, 20, 21],
  CAM: [10, 7, 20, 17, 11],
  LM: [11, 7, 17, 21, 19],
  RM: [7, 11, 17, 19, 21],
  LW: [11, 7, 17, 19, 21, 27],
  RW: [7, 11, 17, 19, 21, 27],
  CF: [10, 9, 19, 29],
  ST: [9, 19, 11, 18, 29, 33, 39],
};

export function preferredShirt(rng: Rng, pos: Position): number {
  return rng.pick(SHIRT_PREFS[pos]);
}

export function generatePlayer(
  rng: Rng,
  opts: { nat: NationalityNames; position: Position; overall: number; age: number; usedNames: Set<string> },
): GeneratedPlayer {
  const { first, last } = generateName(rng, opts.nat, opts.usedNames);
  const attrs = opts.position === 'GK' ? generateGoalkeeperAttributes(rng, opts.overall) : generateOutfieldAttributes(rng, opts.position, opts.overall);
  const overall = opts.position === 'GK' ? goalkeeperOverall(attrs as GoalkeeperAttributes) : outfieldOverall(attrs as OutfieldAttributes, opts.position);
  return {
    first,
    last,
    nat: opts.nat.code,
    region: opts.nat.region,
    age: opts.age,
    pos: opts.position,
    sec: generateSecondaryPositions(rng, opts.position),
    overall,
    potential: generatePotential(rng, overall, opts.age),
    value: marketValue(overall, opts.age),
    salary: annualSalary(overall, opts.age),
    prefShirt: preferredShirt(rng, opts.position),
    kind: opts.position === 'GK' ? 'goalkeeper' : 'outfield',
    attrs,
  };
}

export function randomAge(rng: Rng, mean: number, sd: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(rng.normal(mean, sd))));
}
