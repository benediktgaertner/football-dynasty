import type { Position } from '../domain.js';
import { positionWeights } from './positions.js';
import type { TrainingFocus } from '../tactics.js';

/**
 * G3–G6: Dynamische Spielerentwicklung (Referenzmodell).
 * Die verbindliche Umsetzung läuft serverseitig in SQL (Migration 0023, fd_dev_*). Diese Datei
 * enthält dieselben Formeln – für Paritätstests, die Kalibrierung (scripts/dev-calibrate.mjs)
 * und erklärende Texte im Client. Konstanten nur gemeinsam mit der Migration ändern.
 *
 * Ablauf: Training und Spielleistungen erzeugen Entwicklungspunkte (XP) für einzelne Attribute.
 * Erreicht die XP eines Attributs dessen Kosten, steigt es um 1 – sofort, mitten in der Saison.
 * Die Gesamtstärke (OVR) wird danach aus den Attributen neu berechnet.
 * Verschlechterungen gibt es ausschließlich beim Saisonwechsel (Alterung).
 */

export type PlayerKind = 'outfield' | 'goalkeeper';

/** XP einer Zusatzeinheit vor Multiplikatoren */
export const DEV_TRAINING_XP = 1.6;
/** XP für 90 Minuten Einsatz, unabhängig von der Note */
export const DEV_MATCH_BASE_XP = 0.25;
/** XP je Notenpunkt über 6,0 (für 90 Minuten) */
export const DEV_MATCH_RATING_XP = 1.2;
export const DEV_EVENT_XP = { goal: 0.6, assist: 0.5, tackle: 0.08, interception: 0.08, save: 0.15 } as const;

/** Junge Spieler entwickeln sich deutlich schneller als ältere */
export function devAgeFactor(age: number): number {
  if (age <= 19) return 1.6;
  if (age <= 21) return 1.4;
  if (age <= 23) return 1.2;
  if (age <= 26) return 1.0;
  if (age <= 29) return 0.6;
  if (age <= 32) return 0.3;
  return 0.15;
}

/** Individuelles (verborgenes) Potenzial: kurz vor der Grenze wird die Entwicklung zäh, darüber fast null */
export function devHeadroomFactor(overall: number, potential: number): number {
  const h = potential - overall;
  if (h >= 5) return 1;
  if (h >= 1) return 0.4 + 0.12 * h;
  return 0.1;
}

/** Hohe Spielintelligenz: lernt schneller (0,8 … 1,15) */
export function devIntelligenceFactor(gameIntelligence: number): number {
  return Math.max(0.8, Math.min(1.15, 0.9 + (gameIntelligence - 60) * 0.006));
}

export function devMultiplier(age: number, overall: number, potential: number, gameIntelligence: number): number {
  return devAgeFactor(age) * devHeadroomFactor(overall, potential) * devIntelligenceFactor(gameIntelligence);
}

/** XP-Kosten, um ein Attribut von `value` auf `value + 1` zu heben – hohe Werte sind teurer */
export function devAttributeCost(value: number): number {
  return 3 + Math.max(0, value - 50) * 0.1;
}

const FOCUS_OUTFIELD: Record<TrainingFocus, Record<string, number>> = {
  offense: { shooting: 0.35, dribbling: 0.25, crossing: 0.2, heading: 0.2 },
  defense: { defending: 0.45, heading: 0.2, physical: 0.2, gameIntelligence: 0.15 },
  technique: { passing: 0.35, dribbling: 0.3, shooting: 0.2, crossing: 0.15 },
  physical: { pace: 0.35, physical: 0.35, stamina: 0.3 },
  tactics: { gameIntelligence: 0.55, mentality: 0.25, passing: 0.2 },
  set_pieces: { freeKicks: 0.3, corners: 0.25, penalties: 0.25, crossing: 0.2 },
};
const FOCUS_GOALKEEPER: Record<TrainingFocus, Record<string, number>> = {
  offense: { distribution: 0.5, kicking: 0.5 },
  defense: { reflexes: 0.3, positioning: 0.3, oneOnOne: 0.2, handling: 0.2 },
  technique: { handling: 0.4, distribution: 0.3, kicking: 0.3 },
  physical: { reactionSpeed: 0.5, commandOfArea: 0.3, stamina: 0.2 },
  tactics: { positioning: 0.4, gameIntelligence: 0.3, mentality: 0.3 },
  set_pieces: { penalties: 0.4, commandOfArea: 0.6 },
};
const GK_WEIGHTS: Record<string, number> = {
  reflexes: 0.2, handling: 0.15, positioning: 0.17, oneOnOne: 0.12, commandOfArea: 0.1, reactionSpeed: 0.1,
  distribution: 0.06, kicking: 0.04, gameIntelligence: 0.03, mentality: 0.03,
};

export function devPositionWeights(kind: PlayerKind, position: Position): Record<string, number> {
  if (kind === 'goalkeeper' || position === 'GK') return GK_WEIGHTS;
  return positionWeights(position as Exclude<Position, 'GK'>) as Record<string, number>;
}

const normalize = (m: Record<string, number>): Record<string, number> => {
  const total = Object.values(m).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / total]));
};

/**
 * Verteilung einer Trainingseinheit auf Attribute: Schwerpunkt × Relevanz für die Position.
 * Wer positionsgerecht trainiert, steigert seine Gesamtstärke schneller.
 */
export function trainingShares(kind: PlayerKind, position: Position, focus: TrainingFocus): Record<string, number> {
  const base = (kind === 'goalkeeper' ? FOCUS_GOALKEEPER : FOCUS_OUTFIELD)[focus];
  const w = devPositionWeights(kind, position);
  return normalize(Object.fromEntries(Object.entries(base).map(([k, s]) => [k, s * (0.4 + 4 * (w[k] ?? 0))])));
}

export interface MatchLine {
  minutes: number;
  rating: number;
  goals: number;
  assists: number;
  tacklesWon: number;
  interceptions: number;
  saves: number;
}

/**
 * XP aus einem Pflichtspiel je Attribut (vor Multiplikatoren):
 * Einsatz und Note fördern die positionsrelevanten Attribute, Tore den Abschluss,
 * Vorlagen das Passspiel, Zweikämpfe die Verteidigung, Paraden die Torwartwerte.
 */
export function matchXp(kind: PlayerKind, position: Position, s: MatchLine): Record<string, number> {
  const out: Record<string, number> = {};
  if (s.minutes <= 0) return out;
  const share = Math.min(1, s.minutes / 90);
  const perf = share * (DEV_MATCH_BASE_XP + DEV_MATCH_RATING_XP * Math.max(0, s.rating - 6));
  const add = (k: string, v: number) => { if (v > 0) out[k] = (out[k] ?? 0) + v; };
  for (const [k, w] of Object.entries(devPositionWeights(kind, position))) add(k, perf * w);
  if (kind === 'goalkeeper') {
    add('reflexes', s.saves * DEV_EVENT_XP.save * 0.5);
    add('positioning', s.saves * DEV_EVENT_XP.save * 0.3);
    add('handling', s.saves * DEV_EVENT_XP.save * 0.2);
  } else {
    add('shooting', s.goals * DEV_EVENT_XP.goal);
    add('passing', s.assists * DEV_EVENT_XP.assist);
    add('defending', s.tacklesWon * DEV_EVENT_XP.tackle);
    add('gameIntelligence', s.interceptions * DEV_EVENT_XP.interception);
  }
  return out;
}

/** XP gutschreiben und umwandeln; gibt die neuen Attribute und den Rest-XP-Stand zurück */
export function applyXp(attrs: Record<string, number>, xp: Record<string, number>, gained: Record<string, number>): { attrs: Record<string, number>; xp: Record<string, number>; gains: Record<string, number> } {
  const a = { ...attrs };
  const x = { ...xp };
  const gains: Record<string, number> = {};
  for (const [k, v] of Object.entries(gained)) {
    if (!(k in a)) continue;
    x[k] = (x[k] ?? 0) + v;
    while (a[k]! < 99 && x[k]! >= devAttributeCost(a[k]!)) {
      x[k] = x[k]! - devAttributeCost(a[k]!);
      a[k] = a[k]! + 1;
      gains[k] = (gains[k] ?? 0) + 1;
    }
    if (a[k]! >= 99) x[k] = 0;
  }
  return { attrs: a, xp: x, gains };
}

/** Basisverlust je Attribut beim Saisonwechsel nach (neuem) Alter */
export function declineBase(age: number): number {
  if (age <= 28) return 0;
  if (age === 29) return 0.3;
  if (age === 30) return 0.6;
  if (age === 31) return 1.0;
  if (age === 32) return 1.4;
  if (age === 33) return 1.9;
  if (age === 34) return 2.4;
  return 3 + 0.5 * (age - 35);
}

/** Körperliche Werte lassen zuerst nach, Spielverständnis kaum */
export const DECLINE_WEIGHT: Record<string, number> = {
  pace: 1.7, stamina: 1.5, physical: 1.3, reactionSpeed: 1.3, reflexes: 1.2,
  dribbling: 0.8, shooting: 0.7, heading: 0.8, defending: 0.7, crossing: 0.6, passing: 0.5, oneOnOne: 0.8, handling: 0.7,
  commandOfArea: 0.6, kicking: 0.5, distribution: 0.4, positioning: 0.4, freeKicks: 0.3, corners: 0.3, penalties: 0.3, throwIns: 0.4,
  gameIntelligence: 0.15, mentality: 0.15,
};

/**
 * Alterung: Verlust = Basis × Attributgewicht × individueller Faktor (0,5 … 1,5, aus dem Hash des Spielers),
 * Nachkommastellen werden über einen zweiten Hash je Attribut gerundet. `u` und `ua` liefern Werte in [0, 1).
 */
export function declineAttrs(attrs: Record<string, number>, age: number, u: number, ua: (key: string) => number): Record<string, number> {
  const base = declineBase(age) * (0.5 + u);
  const out: Record<string, number> = {};
  if (base <= 0) return out;
  for (const [k, v] of Object.entries(attrs)) {
    const raw = base * (DECLINE_WEIGHT[k] ?? 0.5);
    const loss = Math.min(v - 1, Math.floor(raw) + (ua(k) < raw - Math.floor(raw) ? 1 : 0));
    if (loss > 0) out[k] = -loss;
  }
  return out;
}
