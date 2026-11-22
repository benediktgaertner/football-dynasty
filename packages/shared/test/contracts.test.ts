import { describe, expect, it } from 'vitest';
import { contractAccepts, contractBarometer, contractProbability, contractReference, terminationCompensation, type ContractInputs } from '../src/index.js';

/** Feste Fälle; dieselben Werte prüft supabase/tests/G2_contracts.sql gegen fd_contract_prob (Parität TS = SQL). */
const base = { years: 2, tier: 2, position: 9, teams: 18, reputation: 50 };
const CASES: Record<string, { i: ContractInputs; p: number; pct: number }> = {
  bench_same: { i: { ...base, currentSalary: 400000, offeredSalary: 400000, marketSalary: 400000, overall: 68, overallChange: 0, rating: 6.4, minutesShare: 0.1, age: 27 }, p: 0.75337, pct: 75 },
  star_same: { i: { ...base, years: 3, position: 5, currentSalary: 900000, offeredSalary: 900000, marketSalary: 1200000, overall: 78, overallChange: 2, rating: 7.3, minutesShare: 0.93, age: 26 }, p: 0.330641, pct: 33 },
  star_raise: { i: { ...base, years: 3, position: 5, currentSalary: 900000, offeredSalary: 1215000, marketSalary: 1200000, overall: 78, overallChange: 2, rating: 7.3, minutesShare: 0.93, age: 26 }, p: 0.908525, pct: 91 },
  old_same: { i: { ...base, years: 1, currentSalary: 800000, offeredSalary: 800000, marketSalary: 700000, overall: 72, overallChange: -2, rating: 6.3, minutesShare: 0.5, age: 34 }, p: 0.98342, pct: 98 },
  old_cut20: { i: { ...base, years: 1, currentSalary: 800000, offeredSalary: 640000, marketSalary: 700000, overall: 72, overallChange: -2, rating: 6.3, minutesShare: 0.5, age: 34 }, p: 0.820047, pct: 82 },
  old_cut40: { i: { ...base, years: 1, currentSalary: 800000, offeredSalary: 480000, marketSalary: 700000, overall: 72, overallChange: -2, rating: 6.3, minutesShare: 0.5, age: 34 }, p: 0.142867, pct: 14 },
  young_bench: { i: { ...base, years: 4, tier: 1, position: 2, reputation: 80, currentSalary: 150000, offeredSalary: 150000, marketSalary: 200000, overall: 64, overallChange: 3, rating: null, minutesShare: 0.05, age: 20 }, p: 0.32107, pct: 32 },
  unknown: { i: { ...base, years: 3, position: null, teams: null, currentSalary: 500000, offeredSalary: 550000, marketSalary: 520000, overall: 74, overallChange: 0, rating: null, minutesShare: null, age: 30 }, p: 0.922972, pct: 92 },
};

describe('Vertragsattraktivität (Spiegel von fd_contract_prob)', () => {
  it('entspricht den festen SQL-Werten', () => {
    for (const [name, c] of Object.entries(CASES)) {
      expect(contractProbability(c.i), name).toBeCloseTo(c.p, 5);
      expect(contractBarometer(c.i), name).toBe(c.pct);
    }
  });
  it('Ersatzspieler ohne Entwicklung ist mit gleichen Konditionen zufrieden', () => {
    expect(contractBarometer(CASES.bench_same!.i)).toBeGreaterThanOrEqual(70);
  });
  it('Leistungsträger (76→78, starke Leistungen) erwartet eine Erhöhung', () => {
    expect(contractBarometer(CASES.star_same!.i)).toBeLessThan(50);
    expect(contractBarometer(CASES.star_raise!.i)).toBeGreaterThan(85);
    expect(contractReference(CASES.star_same!.i)).toBeGreaterThan(CASES.star_same!.i.currentSalary * 1.2);
  });
  it('älterer Spieler mit sinkender Stärke akzeptiert eine moderate Reduktion, aber keine drastische', () => {
    expect(contractBarometer(CASES.old_cut20!.i)).toBeGreaterThan(70);
    expect(contractBarometer(CASES.old_cut40!.i)).toBeLessThan(25);
  });
  it('mehr Gehalt ist nie schlechter; die Entscheidung ist deterministisch über die feste Zahl x', () => {
    const i = CASES.star_same!.i;
    let last = 0;
    for (const f of [0.6, 0.8, 1, 1.2, 1.5, 2]) {
      const p = contractProbability({ ...i, offeredSalary: i.currentSalary * f });
      expect(p).toBeGreaterThan(last);
      last = p;
    }
    const x = 0.5;
    expect(contractAccepts(CASES.star_same!.i, x)).toBe(false);
    expect(contractAccepts(CASES.star_raise!.i, x)).toBe(true);
    expect(contractAccepts(CASES.star_raise!.i, x)).toBe(contractAccepts(CASES.star_raise!.i, x));
  });
  it('Abfindung: Restgehalt × 0,7', () => {
    expect(terminationCompensation(1_000_000, 2)).toBe(1_400_000);
    expect(terminationCompensation(1_000_000, 0)).toBe(0);
  });
});
