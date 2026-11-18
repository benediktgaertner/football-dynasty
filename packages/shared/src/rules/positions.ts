import type { AttributeKey, GoalkeeperAttributeKey, GoalkeeperAttributes, OutfieldAttributes, Position } from '../domain.js';

/**
 * D5: Positionsfremde Einsätze.
 * Jede Feldposition hat eine Lage auf dem Feld (x: links −1 … rechts +1, y: Tiefe 1 … 5).
 * Die Entfernung bestimmt die Familiarität und damit den abgestuften Malus:
 *   Hauptposition 0 · Nebenposition −1 · verwandt −3…−5 · ungewohnt −6…−10 · völlig unpassend −11…−20
 * Die Werte sind Ausgangswerte für das Balancing mit Engine-Tests.
 */
const FIELD_COORDS: Record<Exclude<Position, 'GK'>, readonly [x: number, y: number]> = {
  CB: [0, 1],
  LB: [-1, 1.2],
  RB: [1, 1.2],
  LWB: [-1, 2],
  RWB: [1, 2],
  CDM: [0, 2],
  CM: [0, 3],
  LM: [-1, 3],
  RM: [1, 3],
  CAM: [0, 4],
  LW: [-1, 4.5],
  RW: [1, 4.5],
  CF: [0, 4.8],
  ST: [0, 5],
};

export type Familiarity = 'natural' | 'secondary' | 'related' | 'unfamiliar' | 'unsuitable';

export function positionDistance(a: Position, b: Position): number {
  if (a === 'GK' || b === 'GK') return a === b ? 0 : Number.POSITIVE_INFINITY;
  const [ax, ay] = FIELD_COORDS[a];
  const [bx, by] = FIELD_COORDS[b];
  return Math.abs(ay - by) + 0.5 * Math.abs(ax - bx);
}

export function familiarity(main: Position, secondary: readonly Position[], played: Position): Familiarity {
  if (played === main) return 'natural';
  if (secondary.includes(played)) return 'secondary';
  const d = positionDistance(main, played);
  if (d <= 1.0) return 'related';
  if (d <= 3.5) return 'unfamiliar';
  return 'unsuitable';
}

/** Malus auf die effektive Gesamtstärke (negativ oder 0). */
export function positionPenalty(main: Position, secondary: readonly Position[], played: Position): number {
  const fam = familiarity(main, secondary, played);
  switch (fam) {
    case 'natural':
      return 0;
    case 'secondary':
      return -1;
    case 'related': {
      const d = positionDistance(main, played); // (0, 1]
      return -Math.round(3 + 2 * d);
    }
    case 'unfamiliar': {
      const d = positionDistance(main, played); // (1, 3.5]
      return -Math.round(6 + ((d - 1) / 2.5) * 4);
    }
    case 'unsuitable': {
      if (played === 'GK') return -20; // Feldspieler im Tor
      if (main === 'GK') return -16; // Torhüter im Feld
      const d = positionDistance(main, played);
      return -Math.min(20, Math.round(11 + (d - 3.5) * 4));
    }
  }
}

/**
 * D5: Positionsabhängige Gewichtung der Attribute für die Gesamtstärke.
 * Gewichte je Position summieren sich auf 1. Nicht genannte Attribute zählen 0.
 */
type Weights<K extends string> = Partial<Record<K, number>>;

const OUTFIELD_WEIGHTS: Record<Exclude<Position, 'GK'>, Weights<AttributeKey>> = {
  CB: { defending: 0.3, physical: 0.17, heading: 0.15, gameIntelligence: 0.12, pace: 0.08, passing: 0.08, mentality: 0.06, stamina: 0.04 },
  LB: { defending: 0.22, pace: 0.17, stamina: 0.12, crossing: 0.12, passing: 0.1, physical: 0.08, gameIntelligence: 0.1, dribbling: 0.05, mentality: 0.04 },
  RB: { defending: 0.22, pace: 0.17, stamina: 0.12, crossing: 0.12, passing: 0.1, physical: 0.08, gameIntelligence: 0.1, dribbling: 0.05, mentality: 0.04 },
  LWB: { pace: 0.18, crossing: 0.15, stamina: 0.14, defending: 0.15, dribbling: 0.1, passing: 0.1, gameIntelligence: 0.1, physical: 0.04, mentality: 0.04 },
  RWB: { pace: 0.18, crossing: 0.15, stamina: 0.14, defending: 0.15, dribbling: 0.1, passing: 0.1, gameIntelligence: 0.1, physical: 0.04, mentality: 0.04 },
  CDM: { defending: 0.24, passing: 0.18, gameIntelligence: 0.18, physical: 0.12, stamina: 0.1, mentality: 0.08, heading: 0.05, dribbling: 0.05 },
  CM: { passing: 0.24, gameIntelligence: 0.18, dribbling: 0.12, stamina: 0.12, defending: 0.08, shooting: 0.08, physical: 0.08, mentality: 0.06, pace: 0.04 },
  LM: { pace: 0.16, crossing: 0.16, dribbling: 0.16, passing: 0.15, stamina: 0.1, gameIntelligence: 0.1, shooting: 0.08, defending: 0.05, mentality: 0.04 },
  RM: { pace: 0.16, crossing: 0.16, dribbling: 0.16, passing: 0.15, stamina: 0.1, gameIntelligence: 0.1, shooting: 0.08, defending: 0.05, mentality: 0.04 },
  CAM: { passing: 0.24, dribbling: 0.2, gameIntelligence: 0.18, shooting: 0.16, pace: 0.08, mentality: 0.06, freeKicks: 0.04, stamina: 0.04 },
  LW: { pace: 0.22, dribbling: 0.22, shooting: 0.15, crossing: 0.12, passing: 0.1, gameIntelligence: 0.1, mentality: 0.05, stamina: 0.04 },
  RW: { pace: 0.22, dribbling: 0.22, shooting: 0.15, crossing: 0.12, passing: 0.1, gameIntelligence: 0.1, mentality: 0.05, stamina: 0.04 },
  CF: { shooting: 0.24, dribbling: 0.16, passing: 0.14, gameIntelligence: 0.16, pace: 0.12, heading: 0.06, physical: 0.06, mentality: 0.06 },
  ST: { shooting: 0.3, pace: 0.15, heading: 0.13, physical: 0.12, gameIntelligence: 0.12, dribbling: 0.1, mentality: 0.08 },
};

const GK_WEIGHTS: Weights<GoalkeeperAttributeKey> = {
  reflexes: 0.2,
  handling: 0.15,
  positioning: 0.17,
  oneOnOne: 0.12,
  commandOfArea: 0.1,
  reactionSpeed: 0.1,
  distribution: 0.06,
  kicking: 0.04,
  gameIntelligence: 0.03,
  mentality: 0.03,
};

function weighted<K extends string>(attrs: Record<K, number>, weights: Weights<K>): number {
  let sum = 0;
  let total = 0;
  for (const key of Object.keys(weights) as K[]) {
    const w = weights[key] ?? 0;
    sum += attrs[key] * w;
    total += w;
  }
  return sum / total;
}

export function outfieldOverall(attrs: OutfieldAttributes, position: Exclude<Position, 'GK'>): number {
  return Math.round(weighted(attrs as unknown as Record<AttributeKey, number>, OUTFIELD_WEIGHTS[position]));
}

export function goalkeeperOverall(attrs: GoalkeeperAttributes): number {
  return Math.round(weighted(attrs as unknown as Record<GoalkeeperAttributeKey, number>, GK_WEIGHTS));
}

export function positionWeights(position: Exclude<Position, 'GK'>): Weights<AttributeKey> {
  return OUTFIELD_WEIGHTS[position];
}
