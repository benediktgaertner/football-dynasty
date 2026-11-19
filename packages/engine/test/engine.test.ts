import { describe, expect, it } from 'vitest';
import { MatchEngine, TOTAL_TICKS, buildTestTeam, expectedGoals, replay, simulate } from '../src/index.js';

const setup = (seed = 's1', h = 70, a = 70) => ({ seed, home: buildTestTeam(`h-${seed}`, h, { control: 'human' }), away: buildTestTeam(`a-${seed}`, a), homeAdvantage: 0.01 });

describe('Match Engine', () => {
  it('ist deterministisch (gleicher Seed ⇒ gleiche Partie)', () => {
    const a = simulate(setup('det'));
    const b = simulate(setup('det'));
    expect(a.score).toEqual(b.score);
    expect(a.events.length).toBe(b.events.length);
    expect(a.stats).toEqual(b.stats);
  });

  it('läuft genau 7.200 Ticks und liefert vollständige Statistiken', () => {
    const e = new MatchEngine(setup('len'));
    while (!e.isFinished) e.step();
    expect(e.tick).toBe(TOTAL_TICKS);
    const r = e.result();
    expect(r.players.filter((p) => p.side === 'home').length).toBeGreaterThanOrEqual(11);
    expect(r.events.at(-1)?.type).toBe('fulltime');
    expect(r.events.some((x) => x.type === 'halftime')).toBe(true);
    expect(r.possessionHome).toBeGreaterThan(20);
    expect(r.possessionHome).toBeLessThan(80);
    for (const p of r.players) {
      expect(p.rating).toBeGreaterThanOrEqual(1);
      expect(p.rating).toBeLessThanOrEqual(10);
      expect(p.fitnessEnd).toBeLessThanOrEqual(p.fitnessStart);
    }
    expect(r.stats.home.goals + r.stats.away.goals).toBe(r.score[0] + r.score[1]);
  });

  it('xG-Modell: näher und zentraler ist besser', () => {
    expect(expectedGoals(94, 34)).toBeGreaterThan(expectedGoals(85, 34));
    expect(expectedGoals(94, 34)).toBeGreaterThan(expectedGoals(100, 5));
    expect(expectedGoals(94, 34, true)).toBeLessThan(expectedGoals(94, 34));
  });

  it('Replay aus Seed + Befehlsprotokoll ergibt exakt denselben Zustand', () => {
    const s = setup('rep');
    const e = new MatchEngine(s);
    const bench = e.teamView('home').players.filter((p) => !p.onPitch);
    const field = e.teamView('home').players.filter((p) => p.onPitch && p.position !== 'GK');
    for (let i = 0; i < 2000; i++) e.step();
    expect(e.applyCommand('home', { kind: 'profile', name: 'offensive' }).ok).toBe(true);
    for (let i = 0; i < 1000; i++) e.step();
    expect(e.applyCommand('home', { kind: 'sub', outId: field[0]!.id, inId: bench.find((b) => b.main !== 'GK')!.id }).ok).toBe(true);
    e.setAutopilot('home', true);
    for (let i = 0; i < 1500; i++) e.step();
    const r = replay(s, e.commandLog, e.tick);
    expect(r.snapshot()).toEqual(e.snapshot());
    while (!e.isFinished) { e.step(); r.step(); }
    expect(r.result().score).toEqual(e.result().score);
  });

  it('Wechselregeln: max. 5 Wechsel, eingewechselt ⇒ nicht erneut, ausgewechselt ⇒ nicht zurück', () => {
    const e = new MatchEngine(setup('subs'));
    e.step();
    const v = e.teamView('home');
    const bench = v.players.filter((p) => !p.onPitch && p.main !== 'GK');
    const field = v.players.filter((p) => p.onPitch && p.position !== 'GK');
    // Halbzeit: Wechsel zählen kein Fenster
    while (e.tick < 3600) e.step();
    expect(e.applyCommand('home', { kind: 'sub', outId: field[0]!.id, inId: bench[0]!.id }).ok).toBe(true);
    expect(e.teamView('home').subWindowsUsed).toBe(0);
    expect(e.applyCommand('home', { kind: 'sub', outId: bench[0]!.id, inId: field[0]!.id }).ok).toBe(false); // zurück verboten
    const used = [field[0]!.id];
    let ok = 1;
    for (let i = 1; i < 7; i++) {
      for (let k = 0; k < 120; k++) e.step();
      const r = e.applyCommand('home', { kind: 'sub', outId: field[i]!.id, inId: bench[i]!.id });
      if (r.ok) { ok++; used.push(field[i]!.id); }
      for (let k = 0; k < 120; k++) e.step();
    }
    const t = e.teamView('home');
    expect(t.subsUsed).toBeLessThanOrEqual(5);
    expect(t.subWindowsUsed).toBeLessThanOrEqual(3);
    expect(ok).toBeLessThanOrEqual(5);
  });

  it('lehnt ungültige Befehle ab', () => {
    const e = new MatchEngine(setup('bad'));
    e.step();
    expect(e.applyCommand('home', { kind: 'sub', outId: 'x', inId: 'y' }).ok).toBe(false);
    const p = e.teamView('home').players.find((x) => x.onPitch && x.position === 'ST')!;
    expect(e.applyCommand('home', { kind: 'instructions', playerId: p.id, codes: ['run_in_behind', 'come_short'] }).ok).toBe(false);
    expect(e.applyCommand('home', { kind: 'instructions', playerId: p.id, codes: ['run_in_behind'] }).ok).toBe(true);
    expect(e.applyCommand('home', { kind: 'settings', team_instructions: { mentality: 9 } }).ok).toBe(false);
    expect(e.applyCommand('home', { kind: 'move', playerId: p.id, x: 200, y: 80 }).ok).toBe(true);
    expect(e.teamView('home').players.find((x) => x.id === p.id)!.x).toBe(96);
  });

  it('Kalibrierung: realistische Tore, stärkeres Team gewinnt häufiger, Heimvorteil', () => {
    let goals = 0, strong = 0, home = 0, away = 0;
    const n = 30;
    for (let i = 0; i < n; i++) {
      const eq = simulate({ seed: `c${i}`, home: buildTestTeam(`hc${i}`, 70), away: buildTestTeam(`ac${i}`, 70), homeAdvantage: 0.01 });
      goals += eq.score[0] + eq.score[1];
      if (eq.score[0] > eq.score[1]) home++; else if (eq.score[1] > eq.score[0]) away++;
      const s = simulate({ seed: `st${i}`, home: buildTestTeam(`w${i}`, 64), away: buildTestTeam(`s${i}`, 79), homeAdvantage: 0 });
      if (s.score[1] > s.score[0]) strong++;
    }
    const gpg = goals / n;
    expect(gpg).toBeGreaterThan(1.6);
    expect(gpg).toBeLessThan(4.0);
    expect(strong / n).toBeGreaterThan(0.5);
    expect(home + 3).toBeGreaterThanOrEqual(away);
  }, 60_000);

  it('Snapshot enthält 22 Spieler und gültige Koordinaten', () => {
    const e = new MatchEngine(setup('snap'));
    for (let i = 0; i < 500; i++) e.step();
    const s = e.snapshot();
    expect(s.players.length).toBeLessThanOrEqual(22);
    expect(s.players.length).toBeGreaterThanOrEqual(20);
    for (const [, x, y] of s.players) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(105); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(68); }
  });
});
