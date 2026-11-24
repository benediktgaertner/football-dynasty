import {
  FITNESS_LOSS_PER_MINUTE,
  MAX_FITNESS,
  REST_DAY_FITNESS_GAIN,
  STAMINA_FACTOR_SLOPE,
  STAMINA_REFERENCE,
  TACTIC_LOAD_FACTORS,
  TRAINING_FITNESS_COST,
  type TacticLoad,
} from '../constants.js';

/** F7: Ausdauerfaktor = 1 + (75 − Ausdauer) × 0,008. */
export function staminaFactor(stamina: number): number {
  return 1 + (STAMINA_REFERENCE - stamina) * STAMINA_FACTOR_SLOPE;
}

/** F7: Fitnessverlust = Einsatzminuten × 0,5 × Taktikfaktor × Ausdauerfaktor. */
export function fitnessLoss(minutes: number, load: TacticLoad, stamina: number): number {
  return minutes * FITNESS_LOSS_PER_MINUTE * TACTIC_LOAD_FACTORS[load] * staminaFactor(stamina);
}

/**
 * Variante mit stufenlosem Taktikfaktor. Die Match Engine leitet den Faktor
 * pro Spieler aus den tatsächlich aktiven Anweisungen und seiner Rolle ab (F7).
 */
export function fitnessLossWithFactor(minutes: number, tacticFactor: number, stamina: number): number {
  return minutes * FITNESS_LOSS_PER_MINUTE * tacticFactor * staminaFactor(stamina);
}

export function clampFitness(value: number): number {
  return Math.min(MAX_FITNESS, Math.max(0, value));
}

/**
 * F7: Leistungsmultiplikator abhängig von der aktuellen Fitness.
 * Stützpunkte entsprechen den Orientierungsbändern:
 * 90–100 keine, 80–89 sehr geringe, 70–79 leichte, 60–69 spürbare,
 * 50–59 merkliche, unter 50 zunehmend stärkere Einschränkungen.
 *
 * `kind` = 'physical' für Sprints, Explosivität, Laufarbeit, Zweikampf, Tempo;
 * 'mental' für Spielintelligenz und Mentalität (geringerer Effekt).
 */
const PHYSICAL_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.88],
  [40, 0.90],
  [50, 0.92],
  [60, 0.94],
  [70, 0.96],
  [80, 0.98],
  [90, 1.0],
  [100, 1.0],
];
const MENTAL_EFFECT_SHARE = 0.35;

export function fitnessPerformanceMultiplier(fitness: number, kind: 'physical' | 'mental' = 'physical'): number {
  const f = clampFitness(fitness);
  let m = 1;
  for (let i = 0; i < PHYSICAL_CURVE.length - 1; i++) {
    const [x0, y0] = PHYSICAL_CURVE[i]!;
    const [x1, y1] = PHYSICAL_CURVE[i + 1]!;
    if (f >= x0 && f <= x1) {
      m = y0 + ((f - x0) / (x1 - x0)) * (y1 - y0);
      break;
    }
  }
  if (kind === 'mental') return 1 - (1 - m) * MENTAL_EFFECT_SHARE;
  return m;
}

/** G2: +15 Fitness pro tatsächlich freiem Tag, maximal 100. */
export function applyRestDays(fitness: number, restDays: number): number {
  if (restDays < 0 || !Number.isInteger(restDays)) throw new RangeError('restDays muss eine ganze Zahl ≥ 0 sein');
  return clampFitness(fitness + restDays * REST_DAY_FITNESS_GAIN);
}

/** G1: Ein Training kostet 20 Fitness. */
export function applyTraining(fitness: number): number {
  return clampFitness(fitness - TRAINING_FITNESS_COST);
}

/**
 * Taktische Belastung aus den tatsächlich gewählten Einstellungen (F7: nicht der Profilname zählt).
 * Eingaben auf Skala 1–5. Gegenpressing und hohe Linie erhöhen zusätzlich.
 * Ergebnis ist ein stufenloser Faktor im Bereich 0,70–1,40.
 */
export function tacticLoadFactor(input: {
  pressingIntensity: 1 | 2 | 3 | 4 | 5;
  tempo: 1 | 2 | 3 | 4 | 5;
  defensiveLine: 1 | 2 | 3 | 4 | 5;
  counterPress: boolean;
}): number {
  const centered =
    (input.pressingIntensity - 3) * 0.5 + (input.tempo - 3) * 0.25 + (input.defensiveLine - 3) * 0.15 + (input.counterPress ? 0.35 : 0);
  // centered liegt in [-1.8, 2.15]; auf 0,70–1,40 abbilden, 0 → 1,00
  const factor = centered >= 0 ? 1 + (centered / 2.15) * 0.4 : 1 + (centered / 1.8) * 0.3;
  return Math.round(factor * 1000) / 1000;
}
