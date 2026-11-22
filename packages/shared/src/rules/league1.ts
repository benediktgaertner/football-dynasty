import type { GoalkeeperAttributes, OutfieldAttributes, Position } from '../domain.js';
import { countryTransform } from '../world/country.js';
import { goalkeeperOverall, outfieldOverall, positionWeights } from './positions.js';

/**
 * Migration 0039: stärkere 1. Ligen (KI-Vereine). Spiegel der SQL-Funktionen
 * fd_league1_ref / fd_league1_target / fd_league1_raise (Paritätstest in scripts/gen-parity-sql.mjs).
 *
 * Zielwerte = Ø der besten Startelf (1 TW, 4 Abwehr, 3 Mittelfeld, 3 Angriff) je Tabellenrang einer
 * 18er-Liga eines starken Fußballlands (Referenz Deutschland, Verbandsstärke 92):
 * Platz 1–4: 87–88, 5–7: 85–87, 8–10: 83–85, 11–14: 81–83, 15–18: 79–81.
 * Andere Länder: dieselbe Abbildung wie die Weltgenerierung (countryTransform), oberhalb von 88 gedämpft.
 */
export const LEAGUE1_REFERENCE_TARGETS: readonly number[] = [
  87.9, 87.7, 87.5, 87.3,
  86.6, 86.0, 85.5,
  84.7, 84.0, 83.4,
  82.7, 82.2, 81.8, 81.3,
  80.7, 80.2, 79.8, 79.4,
];

/** Referenzziel für die relative Tabellenposition rel ∈ [0, 1] (0 = stärkster Verein), linear interpoliert */
export function league1ReferenceTarget(rel: number): number {
  const t = LEAGUE1_REFERENCE_TARGETS;
  const x = Math.max(0, Math.min(1, rel)) * (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor(x));
  return t[i]! + (t[i + 1]! - t[i]!) * (x - i);
}

/** Zielstärke für Rang `rank` (1 = stärkster) von `count` Vereinen eines Landes mit Verbandsstärke `strength` */
export function league1Target(strength: number, rank: number, count: number): number {
  const rel = count <= 1 ? 0 : (rank - 1) / (count - 1);
  const t = countryTransform(strength, league1ReferenceTarget(rel));
  return Math.min(90, t > 88 ? 88 + (t - 88) / 2 : t);
}

const GK_WEIGHT_KEYS = ['reflexes', 'handling', 'positioning', 'oneOnOne', 'commandOfArea', 'reactionSpeed', 'distribution', 'kicking', 'gameIntelligence', 'mentality'] as const;

/**
 * Attribute positionsgerecht um `di` Gesamtstärkepunkte anheben: alle für die Position gewichteten Attribute
 * +di (max. 99; bei Kappung weitere +1-Schritte, bis die Gesamtstärke um di gestiegen ist),
 * alle übrigen Attribute um die Hälfte (abgerundet).
 */
export function league1RaiseAttributes<T extends OutfieldAttributes | GoalkeeperAttributes>(kind: 'outfield' | 'goalkeeper', pos: Position, attrs: T, di: number): T {
  if (!(di > 0)) return attrs;
  const out = { ...attrs } as unknown as Record<string, number>;
  const keys: readonly string[] = kind === 'goalkeeper' ? GK_WEIGHT_KEYS : Object.keys(positionWeights(pos as Exclude<Position, 'GK'>));
  const overall = (a: Record<string, number>) =>
    kind === 'goalkeeper' ? goalkeeperOverall(a as unknown as GoalkeeperAttributes) : outfieldOverall(a as unknown as OutfieldAttributes, pos as Exclude<Position, 'GK'>);
  const target = overall(attrs as unknown as Record<string, number>) + di;
  for (const k of keys) out[k] = Math.min(99, out[k]! + di);
  for (let i = 0; i < 20 && overall(out) < target; i++) {
    let changed = false;
    for (const k of keys) if (out[k]! < 99) { out[k] = out[k]! + 1; changed = true; }
    if (!changed) break;
  }
  const half = Math.floor(di / 2);
  if (half > 0) for (const k of Object.keys(attrs)) if (!keys.includes(k)) out[k] = Math.min(99, (attrs as unknown as Record<string, number>)[k]! + half);
  return out as unknown as T;
}
