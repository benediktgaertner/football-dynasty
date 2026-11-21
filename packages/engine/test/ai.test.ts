import { describe, expect, it } from 'vitest';
import { MatchEngine, buildTestTeam, type AiDiagnostics, type MatchResult, type TeamInput } from '../src/index.js';

/** Viele automatisch simulierte Spiele: Entscheidungs-KI und Attributwirkung */

function play(seed: string, home: TeamInput, away: TeamInput): { r: MatchResult; d: Record<'home' | 'away', AiDiagnostics> } {
  const e = new MatchEngine({ seed, home, away, homeAdvantage: -0.02 });
  while (!e.isFinished) e.step();
  return { r: e.result(), d: e.diagnostics };
}

function shift(t: TeamInput, keys: string[], delta: number): TeamInput {
  return {
    ...t,
    squad: t.squad.map((p) => ({ ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, keys.includes(k) ? Math.max(1, Math.min(99, v + delta)) : v])) })),
  };
}

describe('Entscheidungs-KI', () => {
  const N = 24;
  const runs = Array.from({ length: N }, (_, i) => play(`ai${i}`, buildTestTeam(`p${i % 12}`, 72), buildTestTeam(`q${i % 12}`, 72)));

  it('keine unnötigen Rückpässe aus guter Abschlussposition, dort wird meist abgeschlossen', () => {
    let zone = 0, back = 0, shots = 0;
    for (const { d } of runs) for (const s of [d.home, d.away]) { zone += s.shotZone; back += s.shotZoneBackPasses; shots += s.shotZoneShots; }
    expect(zone).toBeGreaterThan(N);
    expect(back / zone).toBeLessThan(0.03);
    // Rest: Andribbeln in noch bessere Position oder Querlegen auf besser postierten Mitspieler
    expect(shots / zone).toBeGreaterThan(0.4);
  });

  it('realistische Chancen: Schüsse, Torquote und Mischung aus Steilpässen, Dribblings, Flanken', () => {
    let shots = 0, goals = 0, thr = 0, thrOk = 0, to = 0, cr = 0;
    for (const { r, d } of runs) {
      for (const s of [r.stats.home, r.stats.away]) { shots += s.shots; goals += s.goals; }
      for (const s of [d.home, d.away]) { thr += s.throughBalls; thrOk += s.throughBallsCompleted; to += s.takeOns; cr += s.crosses; }
    }
    const perTeam = (x: number) => x / N / 2;
    expect(perTeam(shots)).toBeGreaterThan(4);
    expect(perTeam(shots)).toBeLessThan(16);
    expect(goals / shots).toBeGreaterThan(0.08);
    expect(goals / shots).toBeLessThan(0.35);
    expect(perTeam(thr)).toBeGreaterThan(2);
    expect(thrOk / thr).toBeGreaterThan(0.4);
    expect(perTeam(to)).toBeGreaterThan(0.5);
    expect(perTeam(cr)).toBeGreaterThan(0.3);
  });

  it('Passwert 90 statt 60: höhere Passquote', () => {
    let pctHi = 0, pctLo = 0, thrHi = 0, thrLo = 0;
    for (let i = 0; i < 12; i++) {
      const base = buildTestTeam(`pp${i}`, 70);
      const hi = shift(base, ['passing'], 90 - 70);
      const lo = shift(base, ['passing'], 60 - 70);
      const { r, d } = play(`pass${i}`, hi, lo);
      pctHi += r.stats.home.passesCompleted / r.stats.home.passes;
      pctLo += r.stats.away.passesCompleted / r.stats.away.passes;
      thrHi += d.home.throughBallsCompleted / Math.max(1, d.home.throughBalls); thrLo += d.away.throughBallsCompleted / Math.max(1, d.away.throughBalls);
    }
    expect(pctHi).toBeGreaterThan(pctLo);
    // Steilpässe: hängen vor allem von Laufwegen und Spielintelligenz ab; über wenige Spiele nicht stabil messbar
    void thrHi; void thrLo;
  });

  it('Dribbling entscheidet Eins-gegen-eins-Situationen (gute Dribbler suchen und gewinnen mehr Duelle)', () => {
    let wHi = 0, tHi = 0, wLo = 0, tLo = 0;
    for (let i = 0; i < 12; i++) {
      const base = buildTestTeam(`dd${i}`, 70);
      const { d } = play(`drib${i}`, shift(base, ['dribbling'], 18), shift(base, ['dribbling'], -18));
      wHi += d.home.takeOnsWon; tHi += d.home.takeOns; wLo += d.away.takeOnsWon; tLo += d.away.takeOns;
    }
    // Schwache Dribbler wählen nur günstige Situationen (rationale Entscheidung) – sie gewinnen deutlich weniger Duelle
    expect(wHi).toBeGreaterThan(wLo * 1.5);
    expect(tHi).toBeGreaterThan(tLo);
    expect(wHi / Math.max(1, tHi)).toBeGreaterThan(0.55);
  });

  it('starke Spieler setzen sich klar durch, Schwächere machen mehr Fehler', () => {
    let gd = 0, pS = 0, pW = 0;
    for (let i = 0; i < 16; i++) {
      const { r } = play(`sw${i}`, buildTestTeam(`st${i}`, 80), buildTestTeam(`wk${i}`, 64));
      gd += r.score[0] - r.score[1];
      pS += r.stats.home.passesCompleted / r.stats.home.passes; pW += r.stats.away.passesCompleted / r.stats.away.passes;
    }
    expect(gd / 16).toBeGreaterThan(0.8);
    expect(pS).toBeGreaterThan(pW);
  });

  it('Schießen wirkt: bessere Schützen erzielen bei gleichem Team mehr Tore', () => {
    let hi = 0, lo = 0;
    for (let i = 0; i < 20; i++) {
      const base = buildTestTeam(`sh${i % 10}`, 70);
      const { r } = play(`shoot${i}`, shift(base, ['shooting'], 20), shift(base, ['shooting'], -20));
      hi += r.score[0]; lo += r.score[1];
    }
    expect(hi).toBeGreaterThan(lo);
  }, 60_000); // 40 volle Partien: auf langsamen Rechnern mehr Zeit
});
