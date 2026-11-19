import {
  MARKET_VALUE_ANCHORS,
  MILLION,
  STADIUM_CAPACITY_STEP,
  STADIUM_EXPANSION_COST_PER_STEP,
  STADIUM_MAX_CAPACITY,
  STADIUM_MIN_CAPACITY,
} from '../constants.js';

/**
 * D4: Nichtlineare Marktwertkurve.
 * Zwischen den Stützpunkten wird im logarithmischen Raum linear interpoliert.
 * Das ergibt eine glatte, streng monotone, exponentiell wirkende Kurve, die alle
 * Stützpunkte exakt trifft. Außerhalb wird mit der Steigung des Randsegments extrapoliert.
 */
export function baseMarketValue(overall: number): number {
  const anchors = MARKET_VALUE_ANCHORS;
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;

  const logInterp = (a: readonly [number, number], b: readonly [number, number], x: number) => {
    const t = (x - a[0]) / (b[0] - a[0]);
    return Math.exp(Math.log(a[1]) + t * (Math.log(b[1]) - Math.log(a[1])));
  };

  let millions: number;
  if (overall <= first[0]) {
    millions = logInterp(first, anchors[1]!, overall);
  } else if (overall >= last[0]) {
    millions = logInterp(anchors[anchors.length - 2]!, last, overall);
  } else {
    let i = 0;
    while (overall > anchors[i + 1]![0]) i++;
    millions = logInterp(anchors[i]!, anchors[i + 1]!, overall);
  }
  return roundTo(millions * MILLION, 10_000);
}

/** D4: Altersfaktor für den Marktwert. */
export function marketValueAgeFactor(age: number): number {
  if (age <= 22) return 1.07;
  if (age <= 27) return 1.0;
  if (age <= 31) return 0.93;
  return 0.85;
}

export function marketValue(overall: number, age: number): number {
  return roundTo(baseMarketValue(overall) * marketValueAgeFactor(age), 10_000);
}

/**
 * H5: Gehaltsfaktor nach Alter bei Vertragsabschluss.
 * Ältere Spieler verdienen bei gleicher Stärke mehr.
 */
export function salaryAgeFactor(age: number): number {
  if (age <= 20) return 0.7;
  if (age <= 23) return 0.85;
  if (age <= 27) return 1.0;
  if (age <= 30) return 1.1;
  if (age <= 33) return 1.2;
  return 1.25;
}

/** Spielklasse des Vereins (1 = Bundesliga … 4 = Amateure/kleine Ligen) */
export function salaryTierFactor(tier: number): number {
  return tier <= 1 ? 1.25 : tier === 2 ? 1.0 : tier === 3 ? 0.8 : 0.55;
}

/** Vereinsgröße/Attraktivität (Reputation 0–100, 50 = neutral) */
export function salaryReputationFactor(reputation: number): number {
  return Math.min(1.15, Math.max(0.85, 0.85 + reputation / 333));
}

/** Vertragslaufzeit: längere Verträge haben ein etwas geringeres Jahresgehalt */
export function salaryYearsFactor(years: number): number {
  return years <= 1 ? 1.08 : years === 2 ? 1.04 : years === 3 ? 1.0 : years === 4 ? 0.97 : 0.95;
}

/** Referenzgehalt bei Stärke 70 in der 2. Liga (Alter 24–27, Reputation 50, 3 Jahre) */
export const SALARY_BASE_AT_70 = 330_000;
/** +16 % je Stärkepunkt */
export const SALARY_GROWTH_PER_POINT = 1.16;
export const MIN_ANNUAL_SALARY = 30_000;

/**
 * Jahresgehalt (nachvollziehbare Formel, identisch zu SQL fd_salary):
 * 330.000 € × 1,16^(Stärke − 70) × Alter × Spielklasse × Vereinsgröße × Laufzeit, auf 5.000 € gerundet.
 * Beispiele: Stärke 70, 25 J., 2. Liga → 330.000 €; Stärke 76 → ≈ 805.000 €; Stärke 64 → ≈ 135.000 €.
 * Ein durchschnittlicher Zweitligakader (22 Spieler) kostet damit ≈ 6–10 Mio. € pro Jahr.
 */
export function contractSalary(overall: number, age: number, tier: number, reputation = 50, years = 3): number {
  const raw = SALARY_BASE_AT_70 * SALARY_GROWTH_PER_POINT ** (overall - 70)
    * salaryAgeFactor(age) * salaryTierFactor(tier) * salaryReputationFactor(reputation) * salaryYearsFactor(years);
  return Math.max(MIN_ANNUAL_SALARY, Math.round(raw / 5_000) * 5_000);
}

/** Spielklasse, in die ein Spieler dieser Stärke typischerweise gehört */
export function typicalTier(overall: number): 1 | 2 | 3 | 4 {
  return overall >= 77 ? 1 : overall >= 71 ? 2 : overall >= 64 ? 3 : 4;
}

/** Gehalt ohne Vereinskontext (Draft-Pool, Free Agents, neu erzeugte Spieler) */
export function annualSalary(overall: number, ageAtSigning: number): number {
  return contractSalary(overall, ageAtSigning, typicalTier(overall), 50, 3);
}

/** I3: Gültige Stadionkapazität? */
export function isValidStadiumCapacity(capacity: number): boolean {
  return (
    Number.isInteger(capacity) &&
    capacity >= STADIUM_MIN_CAPACITY &&
    capacity <= STADIUM_MAX_CAPACITY &&
    (capacity - STADIUM_MIN_CAPACITY) % STADIUM_CAPACITY_STEP === 0
  );
}

/** I3: Kosten = Kapazität × 1.000 € × 0,98^((Kapazität − 10.000) / 5.000), auf ganze Euro gerundet. */
export function stadiumBuildCost(capacity: number): number {
  if (!isValidStadiumCapacity(capacity)) {
    throw new RangeError(`Ungültige Stadionkapazität: ${capacity}`);
  }
  const steps = (capacity - STADIUM_MIN_CAPACITY) / STADIUM_CAPACITY_STEP;
  return Math.round(capacity * 1_000 * Math.pow(0.98, steps));
}

/** I3: Ausbau um ganze 5.000er-Schritte, nur zum Saisonwechsel (Prüfung des Zeitpunkts serverseitig). */
export function stadiumExpansionCost(fromCapacity: number, toCapacity: number): number {
  if (!isValidStadiumCapacity(fromCapacity) || !isValidStadiumCapacity(toCapacity) || toCapacity <= fromCapacity) {
    throw new RangeError(`Ungültiger Ausbau ${fromCapacity} → ${toCapacity}`);
  }
  return ((toCapacity - fromCapacity) / STADIUM_CAPACITY_STEP) * STADIUM_EXPANSION_COST_PER_STEP;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}
