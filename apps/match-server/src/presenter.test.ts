import { describe, expect, it } from 'vitest';
import { CLOCK_SECONDS_PER_TICK, MatchEngine, PLAYBACK_SPEED, TICK_SECONDS, TICKS_PER_HALF, buildTestTeam, type Snapshot } from '@fd/engine';
import { GOAL_HOLD_MS, Presenter, type PresenterMessage } from './presenter.js';

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

describe('Torjubel', () => {
  it('Tor → Wiederanstoß ≈ 4–5 s Echtzeit, danach ohne Verzögerung weiter', () => {
    const r = run('p1');
    const evs = r.msgs.filter((m) => m.t === 'ev').flatMap((m) => (m as { events: Array<{ type: string; tick: number }>; at: number }).events.map((e) => ({ ...e, at: m.at })));
    const goals = evs.filter((e) => e.type === 'goal');
    expect(goals.length).toBeGreaterThan(0);
    for (const g of goals) {
      const k = evs.find((e) => e.type === 'kickoff' && e.tick > g.tick);
      if (!k) continue; // Tor kurz vor Schluss
      const sec = (k.at - g.at) / 1000;
      expect(sec).toBeGreaterThanOrEqual(4);
      expect(sec).toBeLessThanOrEqual(5);
    }
  });
});

describe('Wiedergabe (komplette Partie, 2-fache Bewegung, schnelle Uhr)', () => {
  const a = run('p1');
  const frames = a.msgs.filter((m) => m.t === 'frame') as Array<{ s: Snapshot; scene: number; at: number }>;

  it('ganze Partie in ca. 3 Minuten (plus kurzer Torjubel je Tor), ca. 90 s je Halbzeit, ohne Sprünge', () => {
    const goals = a.e.events.filter((e) => e.type === 'goal');
    const holdSec = (n: number) => (n * GOAL_HOLD_MS) / 1000;
    expect(a.p.realMs / 1000 - holdSec(goals.length)).toBeGreaterThan(178);
    expect(a.p.realMs / 1000 - holdSec(goals.length)).toBeLessThan(186);
    expect(a.msgs.some((m) => m.t === 'skip')).toBe(false);
    const half = frames.find((f) => f.s.tick >= TICKS_PER_HALF)!;
    const firstHalfGoals = goals.filter((g) => g.tick < TICKS_PER_HALF).length;
    expect(half.at / 1000 - holdSec(firstHalfGoals)).toBeGreaterThan(88);
    expect(half.at / 1000 - holdSec(firstHalfGoals)).toBeLessThan(92);
    // lückenlos: aufeinanderfolgende Bilder liegen 2 Ticks auseinander
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.s.tick - frames[i - 1]!.s.tick).toBeLessThanOrEqual(2);
  });

  it('Spieluhr: 90 Minuten, schneller als die Bewegung', () => {
    expect(frames.at(-1)!.s.clock).toBeCloseTo(90 * 60, -1);
    expect(CLOCK_SECONDS_PER_TICK / TICK_SECONDS).toBeGreaterThan(10);
  });

  it('gezeigte Bewegung höchstens ca. doppelt so schnell wie echt', () => {
    let maxPlayer = 0, maxBall = 0;
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!, m = frames[i]!;
      if (prev.scene !== m.scene || m.at <= prev.at) continue;
      const realSec = ((m.s.tick - prev.s.tick) * TICK_SECONDS) / PLAYBACK_SPEED;
      const pm = new Map(prev.s.players.map((x) => [x[0], x]));
      for (const [id, x, y] of m.s.players) { const q = pm.get(id); if (q) maxPlayer = Math.max(maxPlayer, Math.hypot(x - q[1], y - q[2]) / realSec); }
      maxBall = Math.max(maxBall, Math.hypot(m.s.ball[0] - prev.s.ball[0], m.s.ball[1] - prev.s.ball[1]) / realSec);
    }
    expect(maxPlayer).toBeLessThan(2 * 10.5);
    expect(maxBall).toBeLessThan(2 * 40); // harte Schüsse bis ca. 35–40 m/s sind real
  });

  it('Ereignisse erscheinen zu ihrer Spielzeit, alle Tore werden freigegeben', () => {
    let shown = 0;
    for (const m of a.msgs) {
      if (m.t === 'frame') shown = Math.max(shown, m.s.tick);
      if (m.t === 'ev') for (const ev of m.events) expect(ev.tick).toBeLessThanOrEqual(shown + 2);
    }
    const released = a.msgs.flatMap((m) => (m.t === 'ev' ? m.events : []));
    expect(released.filter((x) => x.type === 'goal').length).toBe(a.e.score[0] + a.e.score[1]);
  });

  it('Eingriffe wirken sofort (Engine läuft im Gleichschritt mit der Anzeige)', () => {
    let applied = -1;
    const r = run('p4', (p, e, realMs) => {
      if (applied < 0 && realMs > 60_000) {
        expect(e.tick - p.shownTick).toBe(0);
        expect(e.applyCommand('home', { kind: 'profile', name: 'offensive' }).ok).toBe(true);
        applied = e.tick;
      }
    });
    const after = r.msgs.filter((m) => m.t === 'frame' && (m as { s: Snapshot }).s.tick > applied) as Array<{ s: Snapshot }>;
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((m) => m.s.activeProfile[0] === 'offensive')).toBe(true);
  });

  it('gleicher Seed ⇒ identischer Bildstrom für alle Zuschauer', () => {
    const b = run('p1');
    const sig = (msgs: typeof a.msgs) => msgs.filter((m) => m.t === 'frame').map((m) => `${(m as { s: Snapshot }).s.tick}:${(m as { s: Snapshot }).s.ball}`).join('|');
    expect(sig(b.msgs)).toBe(sig(a.msgs));
  });
});
