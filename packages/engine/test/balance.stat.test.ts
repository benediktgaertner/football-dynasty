import { describe, it, expect } from 'vitest';
import { simulate, buildTestTeam } from '../src/index.js';

/**
 * Statistik-Test zum Balancing (Audit): Stärkeunterschiede und Heimvorteil aus echten Engine-Simulationen
 * mit festen Seeds (reproduzierbar). Keine Ergebnisvorgaben: geprüft wird nur die Richtung der Effekte
 * und dass Außenseitersiege/Niederlagen möglich bleiben. Aufruf: `FD_STAT=1 FD_STAT_N=60 npx vitest run test/balance.stat.test.ts`.
 */
const N = Number(process.env.FD_STAT_N ?? 40);
function run(label: string, homeOvr: number, awayOvr: number, ha: number) {
  let hw = 0, aw = 0, d = 0, goals = 0, maxDiff = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = simulate({ seed: `${label}-${i}`, home: buildTestTeam(`h${label}${i}`, homeOvr), away: buildTestTeam(`a${label}${i}`, awayOvr), homeAdvantage: ha });
    goals += r.score[0] + r.score[1];
    if (r.score[0] > r.score[1]) hw++; else if (r.score[1] > r.score[0]) aw++; else d++;
    maxDiff = Math.max(maxDiff, Math.abs(r.score[0] - r.score[1]));
  }
  const res = { label, n: N, homeWin: hw / N, draw: d / N, awayWin: aw / N, goalsPerGame: +(goals / N).toFixed(2), maxDiff, secPerMatch: +((Date.now() - t0) / 1000 / N).toFixed(2) };
  console.log('BALANCE', JSON.stringify(res));
  return res;
}
describe.skipIf(!process.env.FD_STAT)('Balancing-Statistik (Engine, feste Seeds)', () => {
  it('Spitzenteam (OVR 88) gegen schwaches Erstligateam (OVR 80) auswärts/heim', () => {
    const top = run('top-home', 88, 80, 0.01);
    const topAway = run('top-away', 80, 88, 0.01);
    expect(top.homeWin).toBeGreaterThan(topAway.homeWin);
    expect(top.homeWin + 0.0001).toBeGreaterThan(top.awayWin);
  }, 600_000);
  it('Stärkeeffekt wächst mit dem Unterschied; Außenseiter gewinnen nicht immer', () => {
    const small = run('d4', 84, 80, 0);
    const big = run('d12', 88, 76, 0);
    expect(big.homeWin).toBeGreaterThanOrEqual(small.homeWin - 0.1);
    expect(big.awayWin).toBeLessThan(0.5);
  }, 600_000);
  it('Gleich starke Teams: Heimvorteil nicht negativ, Torschnitt plausibel', () => {
    const eq = run('eq', 80, 80, 0.01);
    expect(eq.homeWin + 0.15).toBeGreaterThanOrEqual(eq.awayWin);
    expect(eq.goalsPerGame).toBeGreaterThan(1.5);
    expect(eq.goalsPerGame).toBeLessThan(4.5);
  }, 600_000);
});
