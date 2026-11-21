/**
 * Hörbarkeitsprüfung des Stadionmixers: rendert den echten Audiograph offline und misst die Pegel.
 * Benötigt `node-web-audio-api` (lokal: `npm i --no-save node-web-audio-api`); ohne Paket übersprungen.
 */
import { describe, expect, it } from 'vitest';
import { CrowdEnvelope, LEVELS, situationOf, targetsOf, type PlayState } from './crowdModel';

const wa = await import('node-web-audio-api' as string).catch(() => null) as { OfflineAudioContext: typeof OfflineAudioContext } | null;
const SR = 22050;

function rmsDb(b: AudioBuffer, ch: number, from: number, to: number): number {
  const d = b.getChannelData(ch);
  let s = 0, n = 0;
  for (let i = Math.floor(from * SR); i < Math.min(d.length, Math.floor(to * SR)); i++) { s += d[i]! * d[i]!; n++; }
  return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
}

async function renderSteady(home: number, away: number, awayShare = 0.08) {
  const { StadiumMixer } = await import('./audioMixer');
  const ctx = new wa!.OfflineAudioContext(2, SR * 4, SR);
  const m = new StadiumMixer();
  m.attach(ctx as unknown as BaseAudioContext, { attendance: 30000, capacity: 35000, importance: 0.5, awayShare });
  m.setCrowd(home, away, 0);
  const b = await ctx.startRendering();
  // links = Heimkurve, rechts = Gästeblock (getrennte Spuren über die Stereoposition)
  return { left: rmsDb(b as unknown as AudioBuffer, 0, 2, 4), right: rmsDb(b as unknown as AudioBuffer, 1, 2, 4) };
}

describe.skipIf(!wa)('Stadionatmosphäre – hörbare Pegelunterschiede (Offline-Rendering)', () => {
  it('Situationen unterscheiden sich deutlich in dB', async () => {
    const rows: Record<string, { left: number; right: number; home: number; away: number }> = {};
    for (const k of ['calm', 'home_attack', 'home_box', 'home_goal', 'away_attack', 'away_goal', 'finale'] as const) {
      const [h, a] = LEVELS[k];
      // Heimspur allein und Gästespur allein messen
      const homeOnly = await renderSteady(h, 0);
      const awayOnly = await renderSteady(0, a);
      rows[k] = { left: homeOnly.left, right: awayOnly.right, home: h, away: a };
    }
    // Protokoll (dBFS) – siehe docs/SAISONBETRIEB.md
    console.table(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, { heim: `${Math.round(v.home * 100)} %`, 'Heim dB': v.left.toFixed(1), gast: `${Math.round(v.away * 100)} %`, 'Gast dB': v.right.toFixed(1) }])));
    expect(rows.home_box!.left - rows.calm!.left).toBeGreaterThan(10);
    expect(rows.home_goal!.left - rows.calm!.left).toBeGreaterThan(14);
    expect(rows.home_attack!.left - rows.calm!.left).toBeGreaterThan(5);
    expect(rows.calm!.left - rows.away_goal!.left).toBeGreaterThan(8); // Verstummen nach Gegentor
    expect(rows.away_goal!.right - rows.calm!.right).toBeGreaterThan(12); // Gästeblock jubelt
    expect(rows.finale!.left - rows.calm!.left).toBeGreaterThan(8);
    // Heimfans dominieren im normalen Spiel klar
    expect(rows.calm!.left - rows.calm!.right).toBeGreaterThan(6);
  }, 60_000);

  it('Größe des Gästeblocks verändert die Lautstärke der Gästefans', async () => {
    const small = await renderSteady(0, 0.65, 0.04);
    const big = await renderSteady(0, 0.65, 0.15);
    expect(big.right - small.right).toBeGreaterThan(4);
  }, 30_000);

  it('Spielverlauf: weiche Übergänge, deutlich hörbare Ausschläge', async () => {
    const { StadiumMixer } = await import('./audioMixer');
    const sec = 40;
    const ctx = new wa!.OfflineAudioContext(2, SR * sec, SR);
    const m = new StadiumMixer();
    m.attach(ctx as unknown as BaseAudioContext, { attendance: 30000, capacity: 35000, importance: 0.5, awayShare: 0.08 });
    const env = new CrowdEnvelope();
    const base: PlayState = { possession: null, toGoal: 52, inBox: false, forward: 0, minute: 30, homeScore: 0, awayScore: 0 };
    // Drehbuch: ruhig → Heimangriff → Strafraum → Chance vergeben → Rückpässe → Heimtor → Gästeangriff → Gegentor
    const script: Array<[number, Partial<PlayState>, ('home_goal' | 'away_goal' | 'home_miss')?]> = [
      [0, {}], [5, { possession: 'home', toGoal: 30, forward: 7 }], [9, { possession: 'home', toGoal: 12, inBox: true }],
      [12, { possession: 'away', toGoal: 80 }, 'home_miss'], [15, { possession: 'home', toGoal: 70, forward: -5 }],
      [19, { possession: 'home', toGoal: 8, inBox: true }], [21, { possession: null }, 'home_goal'],
      [30, { possession: 'away', toGoal: 25, forward: 6 }], [34, { possession: null }, 'away_goal'],
    ];
    let si = 0;
    const marks: Record<string, number> = {};
    for (let t = 0; t < sec; t += 0.1) {
      while (si < script.length && script[si]![0] <= t + 1e-9) { const ev = script[si]![2]; if (ev) env.event(ev); si++; }
      const ps = { ...base, ...script[si - 1]![1] };
      const lv = env.update(0.1, targetsOf(situationOf(ps), ps));
      m.setCrowd(lv.home, lv.away, t);
    }
    const b = await ctx.startRendering() as unknown as AudioBuffer;
    const win = (t: number, ch = 0) => rmsDb(b, ch, t, t + 0.5);
    marks.ruhig = win(3.5); marks.angriff = win(8); marks.strafraum = win(11); marks.vergeben = win(14.3); marks.rueckpass = win(18.3);
    marks.heimtor = win(23); marks.gegentor_heim = win(37); marks.gegentor_gast = win(37, 1); marks.ruhig_gast = win(3.5, 1);
    console.table(Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v.toFixed(1) + ' dB'])));
    expect(marks.angriff - marks.ruhig).toBeGreaterThan(4);
    expect(marks.strafraum - marks.ruhig).toBeGreaterThan(8);
    expect(marks.strafraum - marks.vergeben).toBeGreaterThan(5);
    expect(marks.heimtor - marks.ruhig).toBeGreaterThan(12);
    expect(marks.heimtor - marks.gegentor_heim).toBeGreaterThan(15);
    expect(marks.gegentor_gast - marks.ruhig_gast).toBeGreaterThan(8);
    // weich: zwischen zwei 100-ms-Fenstern höchstens wenige dB Sprung
    let maxJump = 0;
    for (let t = 1; t < sec - 0.2; t += 0.1) maxJump = Math.max(maxJump, Math.abs(rmsDb(b, 0, t + 0.1, t + 0.2) - rmsDb(b, 0, t, t + 0.1)));
    expect(maxJump).toBeLessThan(6);
  }, 120_000);

  it('generische Fangesänge: hörbarer Gesang mit Trommel', async () => {
    (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = wa!.OfflineAudioContext;
    const { renderChant, CHANT_PATTERNS } = await import('./synthChant');
    for (let i = 0; i < CHANT_PATTERNS.length; i++) {
      const b = await renderChant(i, SR);
      expect(b).not.toBeNull();
      expect(b!.duration).toBeGreaterThan(5);
      const db = rmsDb(b!, 0, 0.3, b!.duration - 2);
      expect(db).toBeGreaterThan(-35);
    }
  }, 120_000);
});
