import { createRng, league1RaiseAttributes, type GoalkeeperAttributes, type OutfieldAttributes } from '@fd/shared';
import { describe, expect, it } from 'vitest';
import { MatchEngine, buildTestTeam, type TeamInput } from '../src/index.js';

/**
 * Migration 0039: Ein Spitzenverein der 1. Liga (vorher ~84, per Attributanhebung auf ~88 wie in der Migration)
 * gegen einen Zweitligameister (~80). 200 Partien, abwechselnd Heim/Auswärts.
 */
function boosted(seed: string, base: number, delta: number): TeamInput {
  const t = buildTestTeam(seed, base);
  const rng = createRng(`boost:${seed}`);
  return {
    ...t,
    squad: t.squad.map((p) => {
      const di = Math.floor(delta + rng.next());
      const attributes = league1RaiseAttributes(p.kind, p.main_position, p.attributes as unknown as OutfieldAttributes | GoalkeeperAttributes, di) as unknown as Record<string, number>;
      return { ...p, attributes, overall: p.overall + di };
    }),
  };
}

const avgXi = (t: TeamInput) => {
  const ids = new Set(t.profiles.neutral.slots.map((s) => s.playerId));
  const xi = t.squad.filter((p) => ids.has(p.id));
  return xi.reduce((s, p) => s + p.overall, 0) / xi.length;
};

describe('1. Liga stärker (0039): Spitzenverein gegen Zweitligameister', () => {
  it('gewinnt klar häufiger, auch hoch – Überraschungen bleiben möglich', () => {
    const N = 200;
    let wins = 0, draws = 0, losses = 0, bigWins = 0, gd = 0;
    for (let i = 0; i < N; i++) {
      const top = boosted(`top${i % 10}`, 84, 4);
      const champ = buildTestTeam(`champ${i % 10}`, 80);
      if (i === 0) {
        expect(avgXi(top)).toBeGreaterThan(86.5);
        expect(avgXi(champ)).toBeLessThan(81.5);
      }
      const topHome = i % 2 === 0;
      const e = new MatchEngine({ seed: `l1-${i}`, home: topHome ? top : champ, away: topHome ? champ : top, homeAdvantage: 0.005 });
      while (!e.isFinished) e.step();
      const [h, a] = e.result().score;
      const [t, c] = topHome ? [h, a] : [a, h];
      gd += t - c;
      if (t > c) wins++; else if (t === c) draws++; else losses++;
      if (t - c >= 3) bigWins++;
    }
    console.log(`Spitzenverein vs. Zweitligameister (${N}): S ${wins} U ${draws} N ${losses}, Siege mit ≥3 Toren ${bigWins}, Tordifferenz/Spiel ${(gd / N).toFixed(2)}`);
    expect(wins / N).toBeGreaterThan(0.55);
    expect(wins).toBeGreaterThan(3 * losses);
    expect(bigWins).toBeGreaterThan(0);
    expect(losses).toBeGreaterThan(0);
  }, 300_000);
});
