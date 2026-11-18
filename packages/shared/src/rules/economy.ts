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
  if (age <= 20) return 0.75;
  if (age <= 24) return 0.85;
  if (age <= 28) return 1.0;
  if (age <= 32) return 1.1;
  if (age <= 35) return 1.2;
  return 1.25;
}

/**
 * Jahresgehalt als Anteil des altersneutralen Marktwerts.
 * Ausgangswert für das Balancing (I8): 12 % des Basismarktwerts pro Jahr.
 * Beispiel: Stärke 76, Alter 26 → 8,4 Mio. × 0,12 ≈ 1,0 Mio. € pro Jahr.
 */
export const SALARY_TO_VALUE_RATIO = 0.12;
export const MIN_ANNUAL_SALARY = 60_000;

export function annualSalary(overall: number, ageAtSigning: number): number {
  const raw = baseMarketValue(overall) * SALARY_TO_VALUE_RATIO * salaryAgeFactor(ageAtSigning);
  return Math.max(MIN_ANNUAL_SALARY, roundTo(raw, 1_000));
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
