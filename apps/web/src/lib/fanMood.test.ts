import { describe, expect, it } from 'vitest';
import type { Situation } from './crowdModel';
import { CHANT_TUNING, EVENTS, FanScheduler, MoodTrend, PARAMS, RULES, levelToIntensity, matchSubset, moodRow, moodTargets, phaseOf, pickEventReaction, seeded, stateTrigger, subsetRange, type CrowdRule, type MoodValues } from './fanMood';
import { MOOD_EVENTS, MOOD_ROWS } from './fanMoodData';
import { pickNext } from './fanAudio';
import V1 from './__fixtures__/fanMoodV1.json';

describe('Fanstimmungs-Matrix V2 (Excel → Code)', () => {
  it('105 Zustände, 26 Ereignisse, 120 Crowd-Reaktionen, Audio-Parameter vollständig', () => {
    expect(MOOD_ROWS).toHaveLength(105);
    expect(new Set(MOOD_ROWS.map((r) => `${r.phase}|${r.diff}|${r.sit}`)).size).toBe(105);
    for (const r of MOOD_ROWS) for (const k of ['homeChant', 'awayChant', 'homeLevel', 'awayLevel', 'homeWhistle'] as const) { expect(r[k]).toBeGreaterThanOrEqual(0); expect(r[k]).toBeLessThanOrEqual(100); }
    expect(MOOD_EVENTS).toHaveLength(26);
    expect(EVENTS.E01).toMatchObject({ name: 'Heimtor', level: 100, duration: 4.5, priority: 1 });
    expect(RULES).toHaveLength(120);
    expect(new Set(RULES.map((r) => `${r.trigger}|${r.side}|${r.reaction}`)).size).toBe(120);
    expect(new Set(RULES.map((r) => r.reaction))).toEqual(new Set(['clap', 'whistle', 'aah', 'ooh', 'uuh']));
    expect(PARAMS).toMatchObject({ chantCheckMin: 5, chantCheckMax: 8, chantPauseMin: 1, chantPauseMax: 3, fadeIn: 1, fadeOut: 1.7, goalDuck: 0.22, reactionGap: 3, homeChantDeficit3After60: 0, awayCapPercent: 70, peakLimit: 0.9 });
  });

  it('V2 erhöht die Gesangschancen in fast allen Zuständen (Ausnahme: hoher Rückstand)', () => {
    const v1 = new Map(V1.rows.map((r) => [r.id, r]));
    let up = 0, sumV1 = 0, sumV2 = 0;
    for (const r of MOOD_ROWS) {
      const o = v1.get(r.id)!;
      expect(r.homeChant).toBeGreaterThanOrEqual(o.homeChant - 2);
      expect(r.awayChant).toBeGreaterThanOrEqual(o.awayChant - 2);
      if (r.homeChant + r.awayChant > o.homeChant + o.awayChant) up++;
      sumV1 += o.homeChant + o.awayChant; sumV2 += r.homeChant + r.awayChant;
    }
    expect(up).toBeGreaterThan(95);
    expect(sumV2).toBeGreaterThan(sumV1 * 1.15);
  });

  it('Zuordnung: Minute → Phase, Spielstand (Heimsicht), Situation', () => {
    expect([phaseOf(1), phaseOf(30), phaseOf(31), phaseOf(60), phaseOf(61), phaseOf(95)]).toEqual([0, 0, 1, 1, 2, 2]);
    expect(moodRow(10, 0, 0, 'calm').id).toBe('S016');
    expect(moodRow(10, 0, 0, 'home_box').id).toBe('S018');
    expect(moodRow(60, 0, 4, 'away_attack').id).toBe('S070');
  });

  it('0:4 ab Minute 60: Heimgesang 0 %, starke Pfiffe, Gäste aktiv (R05/Parameter)', () => {
    for (const m of [60, 70, 89]) for (const sit of [0, 1, 2, 3, 4]) {
      const t = moodTargets(m, 0, 4, sit);
      expect(t.homeChant).toBe(0);
      expect(t.homeWhistle).toBeGreaterThanOrEqual(60);
      expect(t.awayChant).toBeGreaterThanOrEqual(75);
    }
  });

  it('deutlicher Rückstand dämpft, Auswärtsführung belebt den Gästeblock', () => {
    for (const minute of [10, 45, 75]) for (const sit of [0, 1, 2, 3, 4]) {
      const even = moodTargets(minute, 0, 0, sit), behind = moodTargets(minute, 0, 3, sit), lead1 = moodTargets(minute, 0, 1, sit);
      expect(behind.homeChant).toBeLessThan(even.homeChant * 0.2);
      expect(lead1.awayChant).toBeGreaterThan(even.awayChant);
    }
    expect(levelToIntensity(61)).toBeGreaterThan(levelToIntensity(36));
  });
});

describe('Crowd-Reaktionen: Auslöser und Ereignisvarianten', () => {
  const st = (minute: number, h: number, a: number, sit: Situation) => ({ minute, homeScore: h, awayScore: a, sit });
  it('spezifischster Zustand gewinnt', () => {
    expect(stateTrigger('home', st(10, 0, 0, 'calm'))).toBe('calm00');
    expect(stateTrigger('home', st(10, 0, 0, 'home_possession'))).toBe('own_ball');
    expect(stateTrigger('away', st(10, 0, 0, 'home_box'))).toBe('opp_attack');
    expect(stateTrigger('home', st(10, 0, 0, 'home_attack'))).toBe('own_attack');
    expect(stateTrigger('home', st(50, 0, 2, 'calm'))).toBe('minus2_45');
    expect(stateTrigger('home', st(60, 0, 4, 'home_attack'))).toBe('minus3_60'); // Stimmungsgedächtnis vor Angriff
    expect(stateTrigger('away', st(60, 0, 4, 'away_possession'))).toBe('plus2_60');
    expect(stateTrigger('away', st(20, 0, 1, 'away_possession'))).toBe('own_ball');
    expect(stateTrigger('away', st(70, 0, 2, 'calm'))).toBe('plus2_60');
    expect(stateTrigger('home', st(85, 1, 1, 'calm'))).toBe('tight_finale');
    expect(stateTrigger('home', st(10, 1, 0, 'calm'))).toBeNull();
  });
  it('ereignisgebunden: höchstens eine Variante, Verteilung nach Chance (Eigene Großchance → meist Oh)', () => {
    const rnd = seeded('ev');
    const n: Record<string, number> = {};
    for (let i = 0; i < 5000; i++) { const r = pickEventReaction('own_chance', 'home', rnd); n[r?.reaction ?? 'none'] = (n[r?.reaction ?? 'none'] ?? 0) + 1; }
    expect(n.ooh).toBeGreaterThan(n.aah!); expect(n.aah).toBeGreaterThan(n.clap ?? 0);
    expect(n.none ?? 0).toBe(0); // Summe der Chancen > 100 ⇒ immer eine Reaktion
    for (let i = 0; i < 200; i++) expect(pickEventReaction('own_goal', 'home', rnd)?.reaction).not.toBe('whistle'); // nie Pfiffe beim eigenen Tor
  });
});

describe('Trend und Auswahl', () => {
  it('Absturz mit Nachlauf (8 s), Erholung langsam', () => {
    const tr = new MoodTrend();
    let v = tr.update(0.1, 55, 0, 0, 0);
    for (let i = 0; i < 600; i++) v = tr.update(0.1, 55, 0, 0, 0);
    for (let i = 0; i < 10; i++) v = tr.update(0.1, 60, 0, 4, 0);
    expect(v.homeChant).toBe(0); // 0:4 ab 60 sofort 0 %
    for (let i = 0; i < 400; i++) v = tr.update(0.1, 62, 0, 4, 0);
    const target = moodTargets(65, 2, 4, 0).homeChant;
    for (let i = 0; i < 100; i++) v = tr.update(0.1, 65, 2, 4, 0);
    expect(v.homeChant).toBeLessThan(target * 0.4);
  });
  it('Teilmenge je Partie: 3–4 von 5 (nie alle), je Partie fest', () => {
    expect(subsetRange(5)).toEqual([3, 4]);
    expect(subsetRange(3)).toEqual([3, 3]);
    expect(subsetRange(10)).toEqual([3, 6]);
    const pool = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
    const sizes = new Set<number>();
    for (let i = 0; i < 60; i++) { const s = matchSubset(pool, `fx-${i}:home`); sizes.add(s.length); expect(s.length).toBeGreaterThanOrEqual(3); expect(s.length).toBeLessThanOrEqual(4); }
    expect(sizes).toEqual(new Set([3, 4]));
    expect(matchSubset(pool, 'x')).toEqual(matchSubset(pool, 'x'));
    const sub = matchSubset(pool, 'fx-9:away');
    const rnd = seeded('r');
    let last: string | null = null;
    for (let i = 0; i < 500; i++) { const s: { id: string } = pickNext(sub, last, rnd)!; expect(s.id).not.toBe(last); last = s.id; }
  });
});

// ------------------------------------------------------------------ A/B: V1 gegen V2 in 3-Minuten-Partien
const SONG_SEC = [17.4, 19.41, 16.95, 19.02, 14.76]; // echte Längen der KI-Fangesänge
const SITS: Situation[] = ['calm', 'home_possession', 'home_attack', 'away_possession', 'away_attack'];
type Scenario = { name: string; minute: number; h: number; a: number };
const SCENARIOS: Scenario[] = [
  { name: '0:0 Beginn', minute: 5, h: 0, a: 0 }, { name: '0:1 Minute 20', minute: 20, h: 0, a: 1 }, { name: '0:2 Minute 45', minute: 45, h: 0, a: 2 },
  { name: '0:4 Minute 60', minute: 60, h: 0, a: 4 }, { name: '2:0 Minute 80', minute: 80, h: 2, a: 0 },
];
const v1Row = new Map(V1.rows.map((r) => [`${r.phase}|${r.diff}|${r.sit}`, r]));

/** V1: Fenster 8–12 s, Chance aus V1, nur bei freiem Slot; nach Gesangsende normales Fenster */
function simV1(sc: Scenario, seed: string) {
  const rnd = seeded(seed);
  const next = { home: 4, away: 7 }, busyUntil = { home: 0, away: 0 }, n = { home: 0, away: 0 };
  let sit = 0;
  for (let t = 0; t < 180; t += 0.25) {
    if (Math.floor(t / 3) !== Math.floor((t - 0.25) / 3)) sit = Math.floor(rnd() * 5);
    for (const side of ['home', 'away'] as const) {
      if (t < next[side]) continue;
      next[side] = t + 8 + rnd() * 4;
      if (t < busyUntil[side]) continue;
      const r = v1Row.get(`${phaseOf(sc.minute)}|${Math.max(-3, Math.min(3, sc.h - sc.a))}|${sit}`)!;
      let c = side === 'home' ? r.homeChant : r.awayChant;
      if (side === 'home' && sc.minute >= 60 && sc.h - sc.a <= -3) c = Math.min(c, 4);
      if (rnd() * 100 < c) { n[side]++; busyUntil[side] = t + SONG_SEC[Math.floor(rnd() * SONG_SEC.length)]!; }
    }
  }
  return n;
}

/** V2: FanScheduler mit echten Gesangslängen, Pause 1–3 s, Crowd-Reaktionen */
const UNTUNED = { scale: 1, whileOtherSings: 1, sameSideAgain: 1, otherSideTurn: 1 };
function simV2(sc: Scenario, seed: string, tune: typeof UNTUNED = CHANT_TUNING) {
  const rnd = seeded(seed);
  const sch = new FanScheduler(rnd, 1, undefined, tune);
  const playUntil = { home: 0, away: 0 };
  const chants: Array<{ side: 'home' | 'away'; from: number; to: number }> = [];
  const reactions: Array<{ t: number; rule: CrowdRule }> = [];
  let sit = 0;
  const ended = { home: true, away: true };
  for (let t = 0; t < 180; t += 0.25) {
    if (Math.floor(t / 3) !== Math.floor((t - 0.25) / 3)) sit = Math.floor(rnd() * 5);
    for (const side of ['home', 'away'] as const) if (!ended[side] && t >= playUntil[side]) { ended[side] = true; sch.chantEnded(side, t); }
    const mood: MoodValues = moodTargets(sc.minute, sc.h, sc.a, sit);
    const acts = sch.step(t, {
      busy: false, playing: { home: t < playUntil.home, away: t < playUntil.away }, blocked: { home: false, away: false },
      hasSongs: { home: true, away: true }, mood, state: { minute: sc.minute, homeScore: sc.h, awayScore: sc.a, sit: SITS[sit]! },
    });
    for (const a of acts) {
      if (a.kind === 'chant') {
        const d = SONG_SEC[Math.floor(rnd() * SONG_SEC.length)]!;
        chants.push({ side: a.side, from: t, to: t + d }); playUntil[a.side] = t + d; ended[a.side] = false;
      } else reactions.push({ t, rule: a.rule });
    }
  }
  return { chants, reactions, n: { home: chants.filter((c) => c.side === 'home').length, away: chants.filter((c) => c.side === 'away').length } };
}

describe('A/B-Test: V1 → V2 (Excel) → Major-Update (−25 %, abwechselnd)', () => {
  const RUNS = 200;
  const avg = (f: (seed: string) => { home: number; away: number }) => {
    const s = { home: 0, away: 0 };
    for (let i = 0; i < RUNS; i++) { const n = f(`seed-${i}`); s.home += n.home; s.away += n.away; }
    return { home: s.home / RUNS, away: s.away / RUNS };
  };
  /** Anteil der Zeit, in der beide Blöcke gleichzeitig singen, und Anteil der Seitenwechsel aufeinanderfolgender Gesänge */
  const overlap = (sc: Scenario, tune: typeof UNTUNED) => {
    let both = 0, any = 0, switches = 0, pairs = 0;
    for (let i = 0; i < RUNS; i++) {
      const { chants } = simV2(sc, `ov-${i}`, tune);
      for (let t = 0; t < 180; t += 0.5) {
        const h = chants.some((c) => c.side === 'home' && c.from <= t && t < c.to), a = chants.some((c) => c.side === 'away' && c.from <= t && t < c.to);
        if (h || a) any++; if (h && a) both++;
      }
      const seq = chants.slice().sort((x, y) => x.from - y.from);
      for (let k = 1; k < seq.length; k++) { pairs++; if (seq[k]!.side !== seq[k - 1]!.side) switches++; }
    }
    return { both: both / Math.max(1, any), switch: switches / Math.max(1, pairs) };
  };
  const table: Record<string, unknown> = {};
  for (const sc of SCENARIOS) {
    it(`${sc.name}: ≈ 25 % weniger als V2, Stimmungslogik bleibt`, () => {
      const v1 = avg((s) => simV1(sc, s)), v2 = avg((s) => simV2(sc, s, UNTUNED).n), now = avg((s) => simV2(sc, s).n);
      table[sc.name] = { V1: (v1.home + v1.away).toFixed(1), V2: (v2.home + v2.away).toFixed(1), neu: (now.home + now.away).toFixed(1), neu_heim: now.home.toFixed(1), neu_gast: now.away.toFixed(1) };
      if (sc.minute >= 60 && sc.h - sc.a <= -3) { expect(now.home).toBe(0); expect(now.away).toBeGreaterThan(3); return; }
      const ratio = (now.home + now.away) / (v2.home + v2.away);
      expect(ratio).toBeGreaterThan(0.6); expect(ratio).toBeLessThan(0.85);
      if (sc.h - sc.a >= 2) expect(now.home).toBeGreaterThan(now.away);
      if (sc.a - sc.h >= 2) expect(now.away).toBeGreaterThan(now.home);
    });
  }
  it('Heim- und Gästegesang überlagern sich deutlich seltener, Wechsel überwiegt', () => {
    const sc = SCENARIOS[0]!;
    const a = overlap(sc, UNTUNED), b = overlap(sc, CHANT_TUNING);
    table['Überlagerung/Wechsel 0:0'] = { vorher: `${(a.both * 100).toFixed(0)} % / ${(a.switch * 100).toFixed(0)} %`, neu: `${(b.both * 100).toFixed(0)} % / ${(b.switch * 100).toFixed(0)} %` };
    expect(b.both).toBeLessThan(a.both * 0.5);
    expect(b.both).toBeLessThan(0.15);
    expect(b.switch).toBeGreaterThan(0.55);
    expect(b.both).toBeGreaterThan(0); // gelegentlich erlaubt
  });
  it('Tabelle', () => { console.table(table); });
});

describe('V2 überlädt nicht', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: max. 1 Gesang je Seite, Pausen ≥ 1 s, Reaktionen mit Abstand, Cooldown, nicht über eigenem Gesang`, () => {
      for (let i = 0; i < 40; i++) {
        const { chants, reactions } = simV2(sc, `ol-${i}`);
        for (const side of ['home', 'away'] as const) {
          const c = chants.filter((x) => x.side === side);
          let busy = 0;
          for (let k = 1; k < c.length; k++) expect(c[k]!.from - c[k - 1]!.to).toBeGreaterThanOrEqual(0.99); // nie überlappend, ≥ 1 s Pause
          for (const x of c) busy += Math.min(180, x.to) - x.from;
          expect(busy / 180).toBeLessThan(0.93); // kein Dauergesang
        }
        for (let k = 1; k < reactions.length; k++) expect(reactions[k]!.t - reactions[k - 1]!.t).toBeGreaterThanOrEqual(PARAMS.reactionGap - 1e-9);
        for (const r of reactions) {
          expect(chants.some((c) => c.side === r.rule.side && c.from <= r.t && r.t < c.to)).toBe(false);
          const same = reactions.filter((x) => x.rule.side === r.rule.side && x.rule.reaction === r.rule.reaction && x.t > r.t && x.t < r.t + r.rule.cooldown);
          expect(same).toEqual([]);
        }
        expect(reactions.length).toBeLessThanOrEqual(36); // ≤ 12 Reaktionen je Minute im ganzen Stadion
      }
    });
  }
  it('0:4 ab Minute 60: Heim-Unmut (Pfeifen) überwiegt, keine Heimgesänge', () => {
    let whistle = 0, other = 0;
    for (let i = 0; i < 100; i++) for (const r of simV2(SCENARIOS[3]!, `w-${i}`).reactions.filter((x) => x.rule.side === 'home')) r.rule.reaction === 'whistle' ? whistle++ : other++;
    expect(whistle).toBeGreaterThan(other * 1.5); // Pfeifen hat 10 s Cooldown, dominiert trotzdem
  });
});

describe('KI-Fangesangpool: Auswahl je Partie (aiMatchSubset)', async () => {
  const { aiMatchSubset } = await import('./fanMood');
  const { readFileSync } = await import('node:fs');
  const pool = (JSON.parse(readFileSync(new URL('../../public/audio/chants/ai/manifest.json', import.meta.url), 'utf8')).files as Array<{ id: string; mood: string; file: string }>);
  it('Pool: 14 Gesänge, alle Dateien vorhanden, keine doppelten IDs/Dateien', () => {
    expect(pool.length).toBe(14);
    expect(new Set(pool.map((p) => p.id)).size).toBe(14);
    expect(new Set(pool.map((p) => p.file)).size).toBe(14);
    for (const p of pool) expect(readFileSync(new URL(`../../public/audio/chants/ai/${p.file}`, import.meta.url)).length).toBeGreaterThan(50_000);
  });
  it('2–4 verschiedene Gesänge, mindestens 2 ohne Spott, gleiche Partie ⇒ gleiche Auswahl (Reconnect)', () => {
    const sizes = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const s = aiMatchSubset(pool, `fx-${i}:home`);
      sizes.add(s.length);
      expect(s.length).toBeGreaterThanOrEqual(2); expect(s.length).toBeLessThanOrEqual(4);
      expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
      expect(s.filter((x) => x.mood !== 'taunt').length).toBeGreaterThanOrEqual(2);
      expect(aiMatchSubset(pool, `fx-${i}:home`)).toEqual(s);
    }
    expect([...sizes].sort()).toEqual([2, 3, 4]);
  });
  it('KI gegen KI: Heim- und Gästeblock ohne gemeinsame Gesänge', () => {
    for (let i = 0; i < 300; i++) {
      const h = aiMatchSubset(pool, `fx-${i}:home`);
      const a = aiMatchSubset(pool, `fx-${i}:away`, h.map((x) => x.id));
      expect(a.filter((x) => h.some((y) => y.id === x.id))).toEqual([]);
    }
  });
  it('ganzer Pool wird genutzt, aufeinanderfolgende Partien abwechslungsreich', () => {
    const used = new Map<string, number>();
    let same = 0, prev: string[] = [];
    for (let i = 0; i < 400; i++) {
      const s = aiMatchSubset(pool, `fixture-${i * 7919}:home`).map((x) => x.id);
      for (const id of s) used.set(id, (used.get(id) ?? 0) + 1);
      same += s.filter((x) => prev.includes(x)).length / s.length; prev = s;
    }
    expect(used.size).toBe(14);
    for (const n of used.values()) expect(n).toBeGreaterThan(30); // jeder Gesang regelmäßig dabei
    expect(same / 399).toBeLessThan(0.35); // im Schnitt < 35 % Überschneidung mit der vorherigen Partie
  });
  it('kleiner Pool / nur Spott: keine Endlosschleife, nie mehr als vorhanden', () => {
    expect(aiMatchSubset([], 'x')).toEqual([]);
    expect(aiMatchSubset([{ id: 'a', mood: 'taunt' }], 'x').length).toBe(1);
    expect(aiMatchSubset([{ id: 'a', mood: 'support' }, { id: 'b', mood: 'taunt' }, { id: 'c', mood: 'support' }], 'y').filter((x) => x.mood === 'support').length).toBe(2);
  });
});
