/**
 * Hörbarkeitsprüfung des Stadionmixers: rendert den echten Audiograph offline und misst die Pegel.
 * Benötigt `node-web-audio-api` (lokal: `npm i --no-save node-web-audio-api`); ohne Paket übersprungen.
 */
import { describe, expect, it } from 'vitest';
import { CrowdEnvelope, LEVELS, situationOf, targetsOf, type PlayState } from './crowdModel';
import { Picker, buildLibrary, type CrowdCategory, type CrowdFile } from './crowdLibrary';

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

  it('Stadionrauschen aus Aufnahmen: Überblendung ohne Loch, Ersatzrauschen aus', async () => {
    const { StadiumMixer } = await import('./audioMixer');
    const sec = 44;
    const ctx = new wa!.OfflineAudioContext(2, SR * sec, SR);
    const m = new StadiumMixer();
    m.attach(ctx as unknown as BaseAudioContext, { attendance: 30000, capacity: 35000, importance: 0.5 });
    const files = [lib('ambience', 'a1', 30), lib('ambience', 'a2', 30)];
    useLibrary(m, ctx, files);
    for (let t = 0; t < sec; t += 0.1) m.setCrowd(0.4, 0.12, t);
    const d = m.debug();
    expect(d.ambienceSample).toBe(true);
    const b = await ctx.startRendering() as unknown as AudioBuffer;
    // zwei verschiedene Aufnahmen nacheinander (keine identische Wiederholung)
    const amb = d.history.filter((h) => h.channel === 'ambience').map((h) => h.id);
    expect(amb.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < amb.length; i++) expect(amb[i]).not.toBe(amb[i - 1]);
    // Pegel bleibt über die Überblendung gleichmäßig (kein Loch, kein Buckel)
    const lv: number[] = [];
    for (let t = 4; t < sec - 0.5; t += 0.5) lv.push((rmsDb(b, 0, t, t + 0.5) + rmsDb(b, 1, t, t + 0.5)) / 2);
    const med = [...lv].sort((x, y) => x - y)[Math.floor(lv.length / 2)]!;
    for (const v of lv) expect(Math.abs(v - med)).toBeLessThan(3);
  }, 120_000);

  it('Heimfans dominieren, Gästefans leiser aber hörbar; Auswärtstor: Gästeblock kurz sehr laut', async () => {
    const { StadiumMixer } = await import('./audioMixer');
    const render = async (fn: (m: InstanceType<typeof StadiumMixer>) => Promise<void> | void, home: number, away: number) => {
      const ctx = new wa!.OfflineAudioContext(2, SR * 5, SR);
      const m = new StadiumMixer();
      m.attach(ctx as unknown as BaseAudioContext, { attendance: 30000, capacity: 35000, importance: 0.5, awayShare: 0.08 });
      useLibrary(m, ctx, [lib('chant_sung', 's1', 10), lib('chant_sung', 's2', 10), lib('goal', 'g1', 6), lib('concede', 'c1', 4)]);
      m.setVolume('ambience', 0); // Rauschen aus: nur die Fanspuren messen
      m.setCrowd(home, away, 0);
      await fn(m);
      const b = await ctx.startRendering() as unknown as AudioBuffer;
      return { all: (rmsDb(b, 0, 1, 4) + rmsDb(b, 1, 1, 4)) / 2, left: rmsDb(b, 0, 1, 4), right: rmsDb(b, 1, 1, 4) };
    };
    const chant = (side: 'home' | 'away') => async (m: InstanceType<typeof StadiumMixer>) => {
      const f = m.pick(['chant_sung'], 'x')!;
      await m.play(m.urlOf(f), { channel: side, id: f.id, category: f.category, at: 0, fadeIn: 0.2, volume: 0.85 });
    };
    const home = await render(chant('home'), 0.4, 0.12);
    const away = await render(chant('away'), 0.4, 0.12);
    console.table({ heim: home, gast: away });
    expect(home.all - away.all).toBeGreaterThan(6); // Heimkurve dominiert
    expect(away.all).toBeGreaterThan(-45); // Gäste hörbar
    expect(home.left).toBeGreaterThan(home.right); // Heimkurve links
    expect(away.right - away.left).toBeGreaterThan(3); // Gästeblock rechts
    // Auswärtstor: Jubel des Gästeblocks deutlich lauter als sein normaler Gesang
    const goal = await render(async (m) => { m.goal('away'); await new Promise((r) => setTimeout(r, 20)); }, 0.05, 0.65);
    expect(goal.right - away.right).toBeGreaterThan(6);
  }, 120_000);

  it('Schichten aller Spuren übersteuert nicht', async () => {
    const { StadiumMixer } = await import('./audioMixer');
    const ctx = new wa!.OfflineAudioContext(2, SR * 6, SR);
    const m = new StadiumMixer();
    m.attach(ctx as unknown as BaseAudioContext, { attendance: 80000, capacity: 80000, importance: 1, awayShare: 0.15 });
    useLibrary(m, ctx, [lib('ambience', 'a', 30, 0.9), lib('chant_short', 'c', 6, 0.9), lib('clap', 'k', 8, 0.9), lib('goal', 'g', 6, 0.95), lib('chance', 'o', 3, 0.95)]);
    for (const c of ['ambience', 'home', 'away', 'events'] as const) m.setVolume(c, 1);
    m.setCrowd(1, 1, 0);
    const c = m.pick(['chant_short'], 'x')!, k = m.pick(['clap'], 'y')!;
    await m.play(m.urlOf(c), { channel: 'home', at: 0.1, volume: 2 });
    await m.play(m.urlOf(k), { channel: 'away', at: 0.1, volume: 2 });
    m.goal('home');
    await m.reaction('chance', 'home', { at: 0.3, volume: 2 });
    await new Promise((r) => setTimeout(r, 20));
    const b = await ctx.startRendering() as unknown as AudioBuffer;
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) for (const v of b.getChannelData(ch)) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(0.2);
  }, 60_000);

  it('fehlende Aufnahmen: keine Ersatzklänge, Kategorien werden gemeldet', async () => {
    const { StadiumMixer } = await import('./audioMixer');
    const ctx = new wa!.OfflineAudioContext(2, SR, SR);
    const m = new StadiumMixer();
    m.attach(ctx as unknown as BaseAudioContext, { attendance: 30000, capacity: 35000, importance: 0.5 });
    const before = m.debug().sources;
    expect(await m.reaction('goal', 'home')).toBeNull();
    expect(await m.reaction('chance', 'away')).toBeNull();
    m.goal('away');
    expect(m.debug().sources).toBe(before);
    expect(m.missing()).toEqual(['ambience', 'clap', 'chant_short', 'chant_sung', 'attack', 'chance', 'whistle', 'concede', 'goal']);
    expect(m.roars).toBe(0);
  });
});

/** Testaufnahme (gefiltertes Rauschen – nur Prüfsignal, keine Auslieferung) */
type Ctx = InstanceType<NonNullable<typeof wa>['OfflineAudioContext']>;
function lib(category: CrowdCategory, id: string, duration: number, amp = 0.3): CrowdFile {
  return { id, category, file: `${category}/${id}.mp3`, duration, gain: amp };
}
function useLibrary(m: { setLibrary: (l: ReturnType<typeof buildLibrary>) => void; preload: (u: string, b: AudioBuffer) => void }, ctx: Ctx, files: CrowdFile[]) {
  const l = buildLibrary('/t/', files);
  for (const f of files) {
    const b = ctx.createBuffer(2, Math.floor(SR * f.duration), SR) as unknown as AudioBuffer;
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); let x = 0; for (let i = 0; i < d.length; i++) { x = 0.9 * x + 0.1 * (Math.random() * 2 - 1); d[i] = x * 3 * (f.gain ?? 0.3); } }
    m.preload(`/t/${f.file}`, b);
    f.gain = 1;
  }
  m.setLibrary(l);
}

describe('Auswahl ohne Wiederholung', () => {
  it('keine direkte Wiederholung, alle Aufnahmen kommen vor', () => {
    const files = ['a', 'b', 'c', 'd'].map((id) => lib('chant_short', id, 5));
    const l = buildLibrary('/', files);
    const p = new Picker();
    const seq: string[] = [];
    for (let i = 0; i < 200; i++) seq.push(p.pick(l, ['chant_short'], 'k')!.id);
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
    // drei zuletzt gespielte gesperrt ⇒ bei vier Dateien feste Abwechslung ohne Häufung
    for (let i = 3; i < seq.length; i++) expect(new Set(seq.slice(i - 3, i + 1)).size).toBe(4);
    expect(new Set(seq).size).toBe(4);
    // Gesperrte Datei der anderen Spur wird gemieden
    for (let i = 0; i < 50; i++) expect(p.pick(l, ['chant_short'], 'z', ['a'])!.id).not.toBe('a');
    expect(p.pick(buildLibrary('/', []), ['goal'], 'x')).toBeNull();
  });

  it('Kurvengesang je Situation: Angriff ⇒ Sprechchöre/Klatschen, ruhig ⇒ Dauergesang', async () => {
    const { chantWeights } = await import('./fanAudio');
    const w = (s: Parameters<typeof chantWeights>[0], own: boolean) => Object.fromEntries(chantWeights(s, own));
    expect(w('home_attack', true).chant_short).toBeGreaterThan(w('home_attack', true).chant_sung!);
    expect(w('calm', true).chant_sung).toBeGreaterThan(w('calm', true).chant_short!);
    expect(w('finale', true).clap).toBeGreaterThan(w('finale', true).chant_sung!);
  });
});
