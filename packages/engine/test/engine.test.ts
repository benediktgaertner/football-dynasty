import { describe, expect, it } from 'vitest';
import { fitnessLossWithFactor } from '@fd/shared';
import { MatchEngine, TICKS_PER_HALF, TICK_SECONDS, TOTAL_TICKS, buildTestTeam, expectedGoals, replay, simulate } from '../src/index.js';

const setup = (seed = 's1', h = 70, a = 70) => ({ seed, home: buildTestTeam(`h-${seed}`, h, { control: 'human' }), away: buildTestTeam(`a-${seed}`, a), homeAdvantage: 0.01 });

describe('Match Engine', () => {
  it('ist deterministisch (gleicher Seed ⇒ gleiche Partie)', () => {
    const a = simulate(setup('det'));
    const b = simulate(setup('det'));
    expect(a.score).toEqual(b.score);
    expect(a.events.length).toBe(b.events.length);
    expect(a.stats).toEqual(b.stats);
  });

  it('simuliert 90 Spielminuten in 3.600 Ticks und liefert vollständige Statistiken', () => {
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
    for (let i = 0; i < 1000; i++) e.step();
    expect(e.applyCommand('home', { kind: 'profile', name: 'offensive' }).ok).toBe(true);
    for (let i = 0; i < 600; i++) e.step();
    expect(e.applyCommand('home', { kind: 'sub', outId: field[0]!.id, inId: bench.find((b) => b.main !== 'GK')!.id }).ok).toBe(true);
    e.setAutopilot('home', true);
    for (let i = 0; i < 800; i++) e.step();
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
    while (e.tick < TICKS_PER_HALF) e.step();
    expect(e.applyCommand('home', { kind: 'sub', outId: field[0]!.id, inId: bench[0]!.id }).ok).toBe(true);
    expect(e.teamView('home').subWindowsUsed).toBe(0);
    expect(e.applyCommand('home', { kind: 'sub', outId: bench[0]!.id, inId: field[0]!.id }).ok).toBe(false); // zurück verboten
    const used = [field[0]!.id];
    let ok = 1;
    for (let i = 1; i < 7; i++) {
      for (let k = 0; k < 150; k++) e.step();
      const r = e.applyCommand('home', { kind: 'sub', outId: field[i]!.id, inId: bench[i]!.id });
      if (r.ok) { ok++; used.push(field[i]!.id); }
      for (let k = 0; k < 150; k++) e.step();
    }
    const t = e.teamView('home');
    expect(t.subsUsed).toBeLessThanOrEqual(5);
    expect(t.subWindowsUsed).toBeLessThanOrEqual(5);
    expect(ok).toBeLessThanOrEqual(5);
  });

  it('erlaubt fünf einzelne Wechsel in fünf getrennten Wechselfenstern', () => {
    const e = new MatchEngine(setup('five-windows'));
    e.step();
    const view = e.teamView('home');
    const bench = view.players.filter((p) => !p.onPitch && p.main !== 'GK');
    const field = view.players.filter((p) => p.onPitch && p.position !== 'GK');
    for (let i = 0; i < 5; i++) {
      const result = e.applyCommand('home', { kind: 'sub', outId: field[i]!.id, inId: bench[i]!.id });
      expect(result).toEqual({ ok: true });
      const deadline = e.tick + 3000;
      while (e.teamView('home').subsUsed <= i && !e.isFinished && e.tick < deadline) e.step();
      expect(e.teamView('home').subsUsed).toBe(i + 1);
      expect(e.teamView('home').subWindowsUsed).toBe(i + 1);
    }
    const result = e.applyCommand('home', { kind: 'sub', outId: field[5]!.id, inId: bench[5]!.id });
    expect(result.ok).toBe(false);
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
    expect(strong / n).toBeGreaterThanOrEqual(0.5);
    expect(home + 3).toBeGreaterThanOrEqual(away);
  }, 120_000);

  it('Snapshot enthält 22 Spieler und gültige Koordinaten', () => {
    const e = new MatchEngine(setup('snap'));
    for (let i = 0; i < 500; i++) e.step();
    const s = e.snapshot();
    expect(s.players.length).toBeLessThanOrEqual(22);
    expect(s.players.length).toBeGreaterThanOrEqual(20);
    for (const [, x, y] of s.players) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(105); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(68); }
  });

  it('Bewegung in echter Fußballzeit: kein Spieler schneller als ca. 9,5 m/s (außer bei Schnitten)', () => {
    const e = new MatchEngine(setup('speed'));
    let prev = new Map<string, [number, number]>();
    let max = 0;
    for (let i = 0; i < 3500; i++) {
      e.step();
      const cut = e.takeCut();
      const s = e.snapshot();
      if (!cut) for (const [id, x, y] of s.players) { const p = prev.get(id); if (p) max = Math.max(max, Math.hypot(x - p[0], y - p[1]) / TICK_SECONDS); }
      prev = new Map(s.players.map(([id, x, y]) => [id, [x, y]]));
    }
    expect(max).toBeLessThan(10.5); // Rundung der Snapshots (0,1 m) eingerechnet
    expect(max).toBeGreaterThan(6); // es wird auch gesprintet
  });

  it('Tempo-Attribut bleibt erkennbar: schnelle Spieler sind schneller', () => {
    const fast = buildTestTeam('fast', 70); const slow = buildTestTeam('slow', 70);
    for (const p of fast.squad) p.attributes.pace = 95;
    for (const p of slow.squad) p.attributes.pace = 40;
    const e = new MatchEngine({ seed: 'pace', home: fast, away: slow, homeAdvantage: 0 });
    const top: Record<'home' | 'away', number> = { home: 0, away: 0 };
    let prev = new Map<string, [number, number]>();
    const sideOf = new Map([...fast.squad.map((p) => [p.id, 'home'] as const), ...slow.squad.map((p) => [p.id, 'away'] as const)]);
    for (let i = 0; i < 3500; i++) {
      e.step();
      const cut = e.takeCut();
      const s = e.snapshot();
      if (!cut) for (const [id, x, y] of s.players) { const p = prev.get(id); if (p) { const sd = sideOf.get(id)!; top[sd] = Math.max(top[sd], Math.hypot(x - p[0], y - p[1]) / TICK_SECONDS); } }
      prev = new Map(s.players.map(([id, x, y]) => [id, [x, y]]));
    }
    expect(top.home).toBeGreaterThan(top.away + 1);
  });

  it('Taktik wirkt: hohe Abwehrlinie + Pressing steht im Schnitt höher als tiefe Linie', () => {
    const avgLine = (line: number) => {
      const home = buildTestTeam('line', 70);
      for (const prof of Object.values(home.profiles)) prof.team_instructions = { ...prof.team_instructions, defensiveLine: line, pressingIntensity: line };
      const e = new MatchEngine({ seed: 'line', home, away: buildTestTeam('opp', 70), homeAdvantage: 0 });
      const ids = new Set(home.squad.filter((p) => ['CB', 'LB', 'RB'].includes(p.main_position)).map((p) => p.id));
      let sum = 0, n = 0;
      for (let i = 0; i < 3500; i++) {
        e.step();
        if (i % 5) continue;
        for (const [id, x] of e.snapshot().players) if (ids.has(id)) { sum += x; n++; }
      }
      return sum / n;
    };
    expect(avgLine(5)).toBeGreaterThan(avgLine(1) + 4);
  });

  it('Fitness folgt den echten Spielminuten und der taktischen Belastung', () => {
    const r = simulate(setup('fit'));
    const full = r.players.filter((p) => p.minutes >= 89 && p.side === 'home' && !p.injured);
    expect(full.length).toBeGreaterThan(5);
    for (const p of full) {
      expect(p.minutes).toBeLessThanOrEqual(91);
      const loss = p.fitnessStart - p.fitnessEnd;
      // Feldspieler: Verlust aus 90 Minuten (Halbzeit +2 Erholung), Faktor ca. 0,4 (Torwart) … 1,3 (Pressing)
      expect(loss).toBeGreaterThan(fitnessLossWithFactor(90, 0.35, 99) - 3);
      expect(loss).toBeLessThan(fitnessLossWithFactor(90, 1.4, 1) + 1);
    }
  });
});
