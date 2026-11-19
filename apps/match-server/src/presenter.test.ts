import { describe, expect, it } from 'vitest';
import { MatchEngine, PLAYBACK_SPEED, TICK_SECONDS, buildTestTeam, type Snapshot } from '@fd/engine';
import { Presenter, type PresenterMessage } from './presenter.js';

function run(seed: string, onTick?: (p: Presenter, e: MatchEngine, realMs: number) => void) {
  const e = new MatchEngine({ seed, home: buildTestTeam(`h${seed}`, 70, { control: 'human' }), away: buildTestTeam(`a${seed}`, 70), homeAdvantage: 0 });
  const p = new Presenter(e);
  const msgs: Array<PresenterMessage & { at: number }> = [];
  while (p.state !== 'done') {
    for (const m of p.advance(25)) msgs.push({ ...m, at: p.realMs });
    onTick?.(p, e, p.realMs);
  }
  return { e, p, msgs };
}

describe('Regie (Szenenauswahl und Wiedergabe)', () => {
  const a = run('p1');

  it('ein vollständiges Spiel dauert ungefähr drei Minuten', () => {
    expect(a.p.realMs / 1000).toBeGreaterThan(170);
    expect(a.p.realMs / 1000).toBeLessThan(185);
    expect(a.e.isFinished).toBe(true);
  });

  it('gezeigte Bewegung höchstens ca. doppelt so schnell wie echt', () => {
    let prev: { s: Snapshot; scene: number; at: number } | null = null;
    let maxPlayer = 0, maxBall = 0;
    for (const m of a.msgs) {
      if (m.t !== 'frame') continue;
      if (prev && prev.scene === m.scene && m.at > prev.at) {
        const realSec = (m.at - prev.at) / 1000;
        const pm = new Map(prev.s.players.map((x) => [x[0], x]));
        for (const [id, x, y] of m.s.players) { const q = pm.get(id); if (q) maxPlayer = Math.max(maxPlayer, Math.hypot(x - q[1], y - q[2]) / realSec); }
        maxBall = Math.max(maxBall, Math.hypot(m.s.ball[0] - prev.s.ball[0], m.s.ball[1] - prev.s.ball[1]) / realSec);
        // eine gezeigte Szene läuft nie schneller als 2-fach
        expect(((m.s.tick - prev.s.tick) * TICK_SECONDS) / realSec).toBeLessThanOrEqual(PLAYBACK_SPEED + 0.01);
      }
      prev = { s: m.s, scene: m.scene, at: m.at };
    }
    expect(maxPlayer).toBeLessThan(2 * 10.5); // Sprint ≤ ~9,5 m/s real ⇒ ≤ 2-fach
    expect(maxBall).toBeLessThan(2 * 35); // harter Schuss ≤ ~30 m/s real
  });

  it('übersprungene Phasen: Uhr springt vor, Ereignisse nie vor ihrer Spielzeit', () => {
    const skips = a.msgs.filter((m) => m.t === 'skip');
    expect(skips.length).toBeGreaterThan(5);
    let shown = 0;
    for (const m of a.msgs) {
      if (m.t === 'frame') shown = Math.max(shown, m.s.tick);
      if (m.t === 'skip') shown = Math.max(shown, Math.round(m.to / TICK_SECONDS));
      if (m.t === 'ev') for (const ev of m.events) expect(ev.tick).toBeLessThanOrEqual(shown + 40);
    }
    // alle Ereignisse werden am Ende freigegeben, Spielstand stimmt
    const released = a.msgs.flatMap((m) => (m.t === 'ev' ? m.events : []));
    expect(released.filter((x) => x.type === 'goal').length).toBe(a.e.score[0] + a.e.score[1]);
  });

  it('Tore werden gezeigt (Szene enthält den Torabschluss)', () => {
    for (const seed of ['p2', 'p3']) {
      const r = run(seed);
      const frames = new Set(r.msgs.filter((m) => m.t === 'frame').map((m) => (m as { s: Snapshot }).s.tick));
      const goals = r.e.events.filter((x) => x.type === 'goal' && x.tick < r.e.tick - 600);
      for (const g of goals) {
        const seen = [...frames].some((t) => t <= g.tick && t > g.tick - 60);
        expect(seen).toBe(true);
      }
    }
  });

  it('Eingriffe wirken während der komprimierten Wiedergabe sofort und nur auf Ungezeigtes', () => {
    let applied = -1;
    const r = run('p4', (p, e, realMs) => {
      if (applied < 0 && realMs > 60_000) {
        expect(e.applyCommand('home', { kind: 'profile', name: 'offensive' }).ok).toBe(true);
        applied = e.tick;
        // Die Engine ist der Anzeige höchstens eine Szenen-Vorlaufzeit voraus
        expect(e.tick - p.shownTick).toBeLessThanOrEqual(130);
      }
    });
    expect(applied).toBeGreaterThan(0);
    const after = r.msgs.filter((m) => m.t === 'frame' && (m as { s: Snapshot }).s.tick > applied + 20) as Array<{ s: Snapshot }>;
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((m) => m.s.activeProfile[0] === 'offensive')).toBe(true);
    expect(r.e.commandLog.some((c) => c.cmd.kind === 'profile' && c.tick === applied)).toBe(true);
  });

  it('gleicher Seed + gleiche Eingriffe ⇒ identischer Bildstrom (alle Zuschauer sehen dasselbe)', () => {
    const b = run('p1');
    const sig = (msgs: typeof a.msgs) => msgs.filter((m) => m.t === 'frame').map((m) => `${(m as { s: Snapshot }).s.tick}:${(m as { s: Snapshot }).s.ball}`).join('|');
    expect(sig(b.msgs)).toBe(sig(a.msgs));
  });
});
