import { describe, expect, it } from 'vitest';
import { stadiumLayout, stadiumMargin, standDepth, standTiers, visualTiers } from './stadiumArt';

const opts = (capacity: number) => ({ capacity, attendance: capacity * 0.8, design: {}, homeColors: ['#c00', '#fff'] as [string, string], awayColor: '#eee', s: 8, ox: 0, oy: 0, width: 800, height: 600 });

describe('Stadionoptik bis 80.000 Plätze', () => {
  it('Großarenen bekommen einen vierten gezeichneten Rang, logisch bleiben es höchstens drei', () => {
    expect([10000, 20000, 40000, 60000, 65000, 80000].map(visualTiers)).toEqual([1, 1, 2, 3, 4, 4]);
    expect([10000, 40000, 60000, 80000].map(standTiers)).toEqual([1, 2, 3, 3]);
  });
  it('Tribünentiefe und Rand wachsen bis 80.000 weiter (deutlich größer wirkende Arena)', () => {
    expect(standDepth(80000)).toBeGreaterThan(standDepth(50000) + 3);
    expect(stadiumMargin(80000)).toBeGreaterThan(stadiumMargin(50000) + 3);
    expect(standDepth(50000)).toBeCloseTo(10, 5); // Bestandsstadien sehen unverändert aus
  });
  it('Layout: 80.000er-Arena hat vier Ränge je Seite und mehr Sitze als 50.000', () => {
    const big = stadiumLayout(opts(80000));
    const mid = stadiumLayout(opts(50000));
    expect(big.vt).toBe(4);
    expect(big.bands.filter((b) => b.side === 'top').length).toBe(4);
    expect(big.seats.length).toBeGreaterThan(mid.seats.length * 1.3);
    expect(Math.max(...big.seats.map((s) => s.tier))).toBe(2); // Zusatzrang zählt zum Oberrang
  });
});
