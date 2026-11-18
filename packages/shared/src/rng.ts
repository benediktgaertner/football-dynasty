/**
 * Deterministischer, seedbarer Zufallsgenerator.
 * Alle spielrelevanten Zufallsentscheidungen (Spielergenerierung, Auslosungen,
 * Match Engine) laufen über diesen Generator, damit Ergebnisse reproduzierbar
 * und serverseitig nachvollziehbar sind (C7.1, C8.2).
 */

/** cyrb128: hasht einen String auf vier 32-Bit-Werte als Seed. */
function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export interface Rng {
  /** Gleichverteilt in [0, 1). */
  next(): number;
  /** Ganzzahl in [min, max] (inklusive). */
  int(min: number, max: number): number;
  /** Normalverteilt (Box-Muller). */
  normal(mean?: number, sd?: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Interner Zustand, um eine Simulation exakt fortsetzen zu können. */
  state(): [number, number, number, number];
}

/** sfc32 – schneller, gut verteilter 128-Bit-Generator. */
export function createRng(seed: string | [number, number, number, number]): Rng {
  let [a, b, c, d] = typeof seed === 'string' ? cyrb128(seed) : seed;

  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`Ungültiger Bereich [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    normal(mean = 0, sd = 1) {
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    pick(items) {
      if (items.length === 0) throw new RangeError('pick() auf leerer Liste');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as (typeof copy)[number], copy[i] as (typeof copy)[number]];
      }
      return copy;
    },
    state() {
      return [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    },
  };
  return rng;
}
