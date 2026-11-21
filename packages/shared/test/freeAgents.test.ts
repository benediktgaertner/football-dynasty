import { describe, expect, it } from 'vitest';
import { faBarometers, faProbabilities } from '../src/index.js';

describe('Free-Agent-Barometer (Spiegel von fd_fa_probs)', () => {
  it('entspricht den SQL-Werten', () => {
    const p = faProbabilities([10, 5, -20], -4);
    expect(p[0]).toBeCloseTo(0.75155285, 6);
    expect(p[1]).toBeCloseTo(0.19110614, 6);
    expect(faProbabilities([20], -4)[0]).toBeCloseTo(0.99183743, 6);
    expect(faProbabilities([-4], -4)[0]).toBeCloseTo(0.5, 9);
  });
  it('Summe ≤ 1, Rest = bleibt vereinslos; Monte-Carlo kalibriert', () => {
    const u = [6, 4, 1];
    const p = faProbabilities(u, 0);
    expect(p.reduce((a, b) => a + b, 0)).toBeLessThan(1);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const hits = [0, 0, 0];
    const N = 40000;
    for (let n = 0; n < N; n++) {
      const x = Math.min(1 - 1e-9, Math.max(1e-9, rnd()));
      const r = 5 * Math.log(x / (1 - x));
      const acc = u.map((v, i) => [v, i] as const).filter(([v]) => v >= r);
      if (!acc.length) continue;
      const max = Math.max(...acc.map(([v]) => v));
      const w = acc.map(([v]) => Math.exp((v - max) / 4));
      let y = rnd() * w.reduce((a, b) => a + b, 0);
      for (let k = 0; k < acc.length; k++) { y -= w[k]!; if (y <= 0) { hits[acc[k]![1]]!++; break; } }
    }
    hits.forEach((h, i) => expect(Math.abs(h / N - p[i]!)).toBeLessThan(0.015));
  });
  it('mehr Gehalt ⇒ höheres eigenes Barometer', () => {
    const m = { base: 0, money: 40, years: [-5, -2.5, 0, -2.5, -5], mu: -4, s: 5, t: 4 };
    const low = faBarometers(m, [12], 500_000, 850_000, 3).mine;
    const high = faBarometers(m, [12], 1_600_000, 850_000, 3).mine;
    expect(high).toBeGreaterThan(low);
  });
});
