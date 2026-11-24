import { describe, expect, it } from 'vitest';
import { MatchEngine, buildTestTeam } from '../src/index.js';
import type { TeamInput } from '../src/index.js';

/**
 * Stichprobentests (feste Seeds, reproduzierbar) für
 *  - Kartenverteilung: Gelb-Rot trifft Stürmer deutlich seltener als Verteidiger/Mittelfeld, Saisonhäufigkeiten realistisch,
 *  - Torwart-Spieleröffnung: deutlich weniger direkte Ballverluste als zuvor, schwächere Torhüter machen weiterhin mehr Fehler.
 * Standard: 36 Partien (ca. 8 s). Größere Stichprobe: `FD_STAT_N=300 npx vitest run test/cards_keeper.stat.test.ts`.
 */
const N = Number(process.env.FD_STAT_N ?? 36);
const grp = (pos: string) => (pos === 'GK' ? 'GK' : ['CB', 'LB', 'RB', 'LWB', 'RWB'].includes(pos) ? 'DEF' : ['CDM', 'CM'].includes(pos) ? 'MID' : ['CAM', 'LM', 'RM', 'LW', 'RW'].includes(pos) ? 'OM' : 'ST');

describe('Kartenverteilung (Stichprobe)', () => {
  const yel: Record<string, number> = { GK: 0, DEF: 0, MID: 0, OM: 0, ST: 0 };
  let secondYellow = 0; let red = 0; let fouls = 0; let yellow = 0; let secondYellowST = 0;
  for (let i = 0; i < N; i++) {
    const home = buildTestTeam(`h${i % 20}`, 72), away = buildTestTeam(`a${i % 20}`, 72);
    const pos = new Map([...home.squad, ...away.squad].map((p) => [p.id, grp(p.main_position)]));
    const e = new MatchEngine({ seed: `cd${i}`, home, away, homeAdvantage: 0.01 });
    while (!e.isFinished) e.step();
    const r = e.result();
    fouls += r.stats.home.fouls + r.stats.away.fouls;
    for (const ev of r.events) {
      const g = pos.get(ev.playerId ?? '');
      if (ev.type === 'yellow' && g) { yel[g]!++; yellow++; }
      if (ev.type === 'second_yellow') { secondYellow++; if (pos.get(ev.playerId ?? '') === 'ST') secondYellowST++; }
      if (ev.type === 'red') red++;
    }
  }
  const total = Object.values(yel).reduce((a, b) => a + b, 0);
  console.log('KARTEN', JSON.stringify({ n: N, fouls: +(fouls / N).toFixed(1), yellow: +((total + secondYellow) / N).toFixed(2), secondYellow: +(secondYellow / N).toFixed(3), red: +(red / N).toFixed(3), share: Object.fromEntries(Object.entries(yel).map(([k, v]) => [k, +(v / Math.max(1, total)).toFixed(2)])) }));
  it('Gelbe Karten je Spiel und Gelb-Rot/Rot liegen im realistischen Bereich', () => {
    expect((total + secondYellow) / N).toBeGreaterThan(1.8);
    expect((total + secondYellow) / N).toBeLessThan(5.5);
    expect(secondYellow / N).toBeLessThan(0.2);
    expect(red / N).toBeLessThan(0.25);
  });
  it('Stürmer werden seltener verwarnt als Mittelfeld, Verteidiger und defensives Mittelfeld stehen vorn', () => {
    expect(yel.ST!).toBeLessThan(yel.MID!);
    expect(yel.DEF! + yel.MID!).toBeGreaterThan(yel.ST! * 2.2);
    expect(yel.GK! / Math.max(1, total)).toBeLessThan(0.05);
  });
  it('Gelb-Rot trifft Stürmer nicht überproportional', () => {
    expect(secondYellowST).toBeLessThanOrEqual(Math.max(1, Math.ceil(secondYellow * 0.4)));
  });
});

describe('Torwart-Spieleröffnung (Stichprobe)', () => {
  const rows: Record<number, { n: number; d: number; w: number; sh: number; th: number; lo: number }> = {};
  for (let i = 0; i < N; i++) {
    const ovr = [58, 70, 82][i % 3]!;
    const e = new MatchEngine({ seed: `gk${i}`, home: buildTestTeam(`h${i % 20}`, ovr), away: buildTestTeam(`a${i % 20}`, ovr), homeAdvantage: 0.01 });
    while (!e.isFinished) e.step();
    const a = (rows[ovr] ??= { n: 0, d: 0, w: 0, sh: 0, th: 0, lo: 0 });
    a.n++;
    for (const side of ['home', 'away'] as const) { const d = e.diagnostics[side]; a.d += d.gkDist; a.w += d.gkDistWon; a.sh += d.gkShort; a.th += d.gkThrow; a.lo += d.gkLong; }
  }
  const all = Object.values(rows).reduce((s, r) => ({ n: s.n + r.n, d: s.d + r.d, w: s.w + r.w, sh: s.sh + r.sh, th: s.th + r.th, lo: s.lo + r.lo }), { n: 0, d: 0, w: 0, sh: 0, th: 0, lo: 0 });
  console.log('TORWART', JSON.stringify({ n: N, proTeam: +(all.d / all.n / 2).toFixed(1), erfolg: +(all.w / all.d).toFixed(3), verlustProTeam: +((all.d - all.w) / all.n / 2).toFixed(2), kurz: all.sh, abwurf: all.th, lang: all.lo }));
  it('direkte Ballverluste bei der Eröffnung sind selten (Erfolg ≥ 80 %, vorher ≈ 75 %)', () => {
    expect(all.d / all.n / 2).toBeGreaterThan(3);
    expect(all.w / all.d).toBeGreaterThan(0.8);
  });
  it('alle drei Arten kommen vor: kurzer Pass, Abwurf, langer Abschlag', () => {
    expect(all.sh).toBeGreaterThan(0);
    expect(all.th).toBeGreaterThan(0);
    expect(all.lo).toBeGreaterThan(0);
  });
});

describe('Torwart-Qualität bleibt entscheidend (Stichprobe)', () => {
  const withKeeper = (t: TeamInput, level: number): TeamInput => ({
    ...t, squad: t.squad.map((p) => (p.kind === 'goalkeeper' ? { ...p, attributes: { ...p.attributes, distribution: level, kicking: level, gameIntelligence: level } } : p)),
  });
  const rate = (level: number) => {
    let d = 0, w = 0;
    for (let i = 0; i < N; i++) {
      const e = new MatchEngine({ seed: `gq${i}`, home: withKeeper(buildTestTeam(`h${i % 20}`, 70), level), away: withKeeper(buildTestTeam(`a${i % 20}`, 70), level), homeAdvantage: 0 });
      while (!e.isFinished) e.step();
      for (const side of ['home', 'away'] as const) { d += e.diagnostics[side].gkDist; w += e.diagnostics[side].gkDistWon; }
    }
    return w / d;
  };
  const weak = rate(25), strong = rate(90);
  console.log('TORWART-QUALITAET', JSON.stringify({ schwach: +weak.toFixed(3), stark: +strong.toFixed(3) }));
  it('schwache Torhüter verlieren den Ball öfter als starke, bleiben aber spielfähig', () => {
    expect(strong).toBeGreaterThan(weak + 0.03);
    expect(weak).toBeGreaterThan(0.5);
  });
});
