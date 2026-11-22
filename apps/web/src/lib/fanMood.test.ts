import { describe, expect, it } from 'vitest';
import { EVENTS, FanScheduler, MoodTrend, levelToIntensity, matchSubset, moodRow, moodTargets, phaseOf, seeded, type MoodValues } from './fanMood';
import { MOOD_EVENTS, MOOD_ROWS } from './fanMoodData';
import { pickNext } from './fanAudio';

describe('Fanstimmungs-Matrix (Excel → Code)', () => {
  it('105 Zustände (3 Phasen × 7 Spielstände × 5 Situationen) und 26 Ereignisse, Werte 0–100', () => {
    expect(MOOD_ROWS).toHaveLength(105);
    expect(new Set(MOOD_ROWS.map((r) => `${r.phase}|${r.diff}|${r.sit}`)).size).toBe(105);
    for (const r of MOOD_ROWS) for (const k of ['homeChant', 'awayChant', 'homeLevel', 'awayLevel', 'homeWhistle'] as const) expect(r[k]).toBeGreaterThanOrEqual(0), expect(r[k]).toBeLessThanOrEqual(100);
    expect(MOOD_EVENTS).toHaveLength(26);
    expect(EVENTS.E01).toMatchObject({ name: 'Heimtor', level: 100, duration: 4.5, priority: 1 });
  });

  it('Zuordnung: Minute → Phase, Spielstand (Heimsicht, begrenzt), Situation', () => {
    expect([phaseOf(1), phaseOf(30), phaseOf(31), phaseOf(60), phaseOf(61), phaseOf(95)]).toEqual([0, 0, 1, 1, 2, 2]);
    expect(moodRow(10, 0, 0, 'calm').id).toBe('S016');
    expect(moodRow(10, 0, 0, 'home_box').id).toBe('S018');
    expect(moodRow(10, 5, 0, 'calm').id).toBe('S001');
    expect(moodRow(60, 0, 4, 'away_attack').id).toBe('S070');
    expect(moodRow(85, 0, 7, 'calm').id).toBe('S101');
  });

  it('0:4 in der 60. Minute: Heimgesang ≤ 4 %, starke Pfiffe, Gäste euphorisch (R05)', () => {
    for (const sit of [0, 1, 2, 3, 4]) {
      const t = moodTargets(60, 0, 4, sit);
      expect(t.homeChant).toBeLessThanOrEqual(4);
      expect(t.homeWhistle).toBeGreaterThanOrEqual(60);
      expect(t.awayChant).toBeGreaterThanOrEqual(65);
      expect(t.awayLevel).toBeGreaterThan(t.homeLevel);
      expect(t.row.homeMood).toMatch(/Bedrückt/);
    }
    // ab Minute 60 nie mehr als 4 %, auch wenn die Excel-Werte später geändert würden
    for (const m of [60, 70, 89]) for (const sc of [[0, 3], [1, 5], [0, 4]]) expect(moodTargets(m, sc[0]!, sc[1]!, 2).homeChant).toBeLessThanOrEqual(4);
  });

  it('deutlicher Rückstand: Gesänge stark zurück, Pfiffe zu; Auswärtsführung: Gäste aktiver', () => {
    for (const phase of [10, 45, 75]) for (const sit of [0, 1, 2, 3, 4]) {
      const even = moodTargets(phase, 0, 0, sit), behind = moodTargets(phase, 0, 3, sit), lead1 = moodTargets(phase, 0, 1, sit);
      expect(behind.homeChant).toBeLessThan(even.homeChant * 0.2);
      expect(behind.homeWhistle).toBeGreaterThan(even.homeWhistle + 30);
      expect(lead1.awayChant).toBeGreaterThan(even.awayChant);
      expect(moodTargets(phase, 0, 2, sit).awayChant).toBeGreaterThan(lead1.awayChant);
    }
  });

  it('Ballbesitz und Angriff ändern die Chancen; Pegel → Intensität monoton', () => {
    expect(moodTargets(20, 0, 0, 'home_attack').homeChant).toBeGreaterThan(moodTargets(20, 0, 0, 'away_attack').homeChant);
    expect(moodTargets(20, 0, 0, 'away_attack').awayChant).toBeGreaterThan(moodTargets(20, 0, 0, 'home_attack').awayChant);
    expect(levelToIntensity(61)).toBeGreaterThan(levelToIntensity(36));
    expect(levelToIntensity(12)).toBeLessThan(0.25);
  });
});

describe('Trend (R19): keine Sofort-Erholung, schneller Absturz', () => {
  it('Gegentor zum 0:4 ⇒ Heimchance in Sekunden unten; Anschlusstreffer ⇒ nur langsame Erholung', () => {
    const tr = new MoodTrend();
    let v = tr.update(0.1, 55, 0, 0, 0);
    for (let i = 0; i < 600; i++) v = tr.update(0.1, 55, 0, 0, 0);
    expect(v.homeChant).toBeCloseTo(moodTargets(55, 0, 0, 0).homeChant, 0);
    for (let i = 0; i < 150; i++) v = tr.update(0.1, 60, 0, 4, 0); // 15 s nach dem 0:4
    expect(v.homeChant).toBeLessThanOrEqual(4);
    expect(v.homeWhistle).toBeGreaterThan(60);
    for (let i = 0; i < 600; i++) v = tr.update(0.1, 62, 0, 4, 0);
    // 2:4 – Heimfans schöpfen langsam Hoffnung
    const target = moodTargets(65, 2, 4, 0).homeChant;
    for (let i = 0; i < 100; i++) v = tr.update(0.1, 65, 2, 4, 0); // 10 s
    expect(v.homeChant).toBeLessThan(target * 0.4);
    for (let i = 0; i < 2000; i++) v = tr.update(0.1, 65, 2, 4, 0); // 200 s
    expect(v.homeChant).toBeGreaterThan(target * 0.9);
  });
});

describe('Auswahl: Teilmenge je Partie, Shuffle ohne Wiederholung, Fenster 8–12 s', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  it('Teilmenge: 3 von 5, je Partie fest (alle Geräte gleich), zwischen Partien verschieden', () => {
    const s1 = matchSubset(pool, 'fx-1:home');
    expect(s1).toHaveLength(3);
    expect(matchSubset(pool, 'fx-1:home')).toEqual(s1);
    const variants = new Set(Array.from({ length: 40 }, (_, i) => matchSubset(pool, `fx-${i}:home`).map((x) => x.id).sort().join('')));
    expect(variants.size).toBeGreaterThan(4);
    expect(matchSubset(pool.slice(0, 2), 'x')).toHaveLength(2);
  });
  it('keine unmittelbare Wiederholung, alle Gesänge der Teilmenge kommen vor', () => {
    const sub = matchSubset(pool, 'fx-9:away');
    const rnd = seeded('r');
    let last: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) { const s: { id: string } = pickNext(sub, last, rnd)!; expect(s.id).not.toBe(last); last = s.id; seen.add(s.id); }
    expect(seen.size).toBe(3);
  });

  const mood = (m: Partial<MoodValues>): MoodValues => ({ homeChant: 0, awayChant: 0, homeLevel: 30, awayLevel: 20, homeWhistle: 0, ...m });
  const run = (sec: number, m: MoodValues, extra: Partial<{ busy: boolean; playing: boolean }> = {}) => {
    const sch = new FanScheduler(seeded('s'));
    const counts = { home: 0, away: 0, whistle: 0 };
    for (let t = 0; t < sec; t += 0.25) {
      for (const a of sch.step(t, { busy: !!extra.busy, playing: { home: !!extra.playing, away: false }, blocked: { home: false, away: false }, hasSongs: { home: true, away: true }, mood: m })) {
        if (a.kind === 'whistle') counts.whistle++; else counts[a.side]++;
      }
    }
    return { counts, log: sch.log, stats: sch.stats };
  };
  it('Chancenverteilung entspricht der Matrix (Fenster alle 8–12 s)', () => {
    const { counts, log, stats } = run(7200, mood({ homeChant: 63, awayChant: 18, homeWhistle: 1 }));
    expect(stats.windows.home).toBeGreaterThan(560); expect(stats.windows.home).toBeLessThan(800); // 7200 s / 8–12 s
    const wins = log.filter((d) => d.kind === 'chant' && d.side === 'home');
    const gaps = wins.slice(1).map((d, i) => d.t - wins[i]!.t);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7.9); expect(Math.max(...gaps)).toBeLessThanOrEqual(12.3);
    expect(counts.home / stats.windows.home).toBeGreaterThan(0.57); expect(counts.home / stats.windows.home).toBeLessThan(0.69);
    expect(counts.away / stats.windows.away).toBeGreaterThan(0.13); expect(counts.away / stats.windows.away).toBeLessThan(0.23);
    expect(counts.whistle / stats.windows.whistle).toBeLessThan(0.03);
  });
  it('0:4 in der 60. Minute über 10 Minuten: fast keine Heimgesänge, viele Pfiffe, aktive Gäste', () => {
    const m = moodTargets(60, 0, 4, 0);
    const { counts } = run(600, m);
    expect(counts.home).toBeLessThanOrEqual(5);
    expect(counts.whistle).toBeGreaterThan(30);
    expect(counts.away).toBeGreaterThan(30);
    const even = run(600, moodTargets(60, 0, 0, 0)).counts;
    expect(even.home).toBeGreaterThan(25);
    expect(even.whistle).toBeLessThan(3);
  });
  it('läuft schon ein Gesang oder dominiert ein Ereignis: keine neue Auswahl (R04, R20)', () => {
    expect(run(300, mood({ homeChant: 100 }), { playing: true }).counts.home).toBe(0);
    expect(run(300, mood({ homeChant: 100, awayChant: 100, homeWhistle: 100 }), { busy: true }).counts).toEqual({ home: 0, away: 0, whistle: 0 });
  });
});
