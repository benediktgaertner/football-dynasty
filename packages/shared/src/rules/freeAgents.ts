/**
 * Free-Agent-Verhandlungen: Verpflichtungswahrscheinlichkeiten aus Nutzwerten.
 * Spiegel von SQL fd_fa_probs (Server entscheidet; der Client nutzt das nur für die Live-Vorschau).
 *
 * Der Spieler zieht eine verdeckte Mindestschwelle R ~ Logistisch(mu, s). Akzeptabel sind Angebote mit U ≥ R;
 * gibt es mindestens eines, unterschreibt er und wählt per Logit (Temperatur t) unter den akzeptablen.
 */
export interface FaModel {
  base: number;
  money: number;
  years: number[];
  mu: number;
  s: number;
  t: number;
}

export function faProbabilities(utils: ReadonlyArray<number | null>, mu: number, s = 5, t = 4): number[] {
  const out = utils.map(() => 0);
  const order = utils.map((u, i) => [u, i] as const).filter((x): x is readonly [number, number] => x[0] !== null)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1]);
  const F = (u: number) => 1 / (1 + Math.exp(Math.max(-700, Math.min(700, -(u - mu) / s))));
  for (let k = 0; k < order.length; k++) {
    const band = F(utils[order[k]!]!) - (k + 1 < order.length ? F(utils[order[k + 1]!]!) : 0);
    if (band <= 0) continue;
    const max = utils[order[0]!]!;
    let sum = 0;
    for (let j = 0; j <= k; j++) sum += Math.exp((utils[order[j]!]! - max) / t);
    for (let j = 0; j <= k; j++) out[order[j]!]! += (band * Math.exp((utils[order[j]!]! - max) / t)) / sum;
  }
  return out;
}

/** Eigener Nutzwert für ein hypothetisches Angebot (Gehalt, Laufzeit) */
export function faOwnUtility(m: FaModel, salary: number, ask: number, years: number): number {
  return m.base + m.money * Math.log(Math.max(1, salary) / Math.max(1, ask)) + (m.years[years - 1] ?? 0);
}

/** Barometer 0–100 je Interessent (eigener Eintrag an Position `mine`) */
export function faBarometers(m: FaModel, others: number[], salary: number, ask: number, years: number): { mine: number; others: number[] } {
  const p = faProbabilities([faOwnUtility(m, salary, ask, years), ...others], m.mu, m.s, m.t);
  return { mine: Math.round(p[0]! * 100), others: p.slice(1).map((x) => Math.round(x * 100)) };
}
