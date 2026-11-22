/**
 * Übergänge des Stadionmixers (Offline-Rendering, echter Mixer-Graph): Einblenden, Ausblenden, Ducking.
 * Messgröße: RMS-Pegel in 100-ms-Fenstern des Summensignals (links = Heimseite). Benötigt `node-web-audio-api`.
 */
import { describe, expect, it } from 'vitest';
import { StadiumMixer } from './audioMixer';
import { buildLibrary } from './crowdLibrary';

const wa = await import('node-web-audio-api' as string).catch(() => null) as { OfflineAudioContext: typeof OfflineAudioContext } | null;
const SR = 22050;

function levels(b: AudioBuffer, from: number, to: number, win = 0.1): number[] {
  const d = b.getChannelData(0), n = Math.floor(SR * win), out: number[] = [];
  for (let t = from; t + win <= to; t += win) {
    let s = 0;
    for (let i = Math.floor(t * SR); i < Math.floor(t * SR) + n; i++) s += d[i]! * d[i]!;
    out.push(10 * Math.log10(s / n + 1e-12));
  }
  return out;
}
/** größte Änderung der linearen Amplitude je 100 ms, bezogen auf den Spitzenwert (0…1) – erkennt harte Schnitte; ein weiches Aus-/Einblenden bleibt klein */
const maxStep = (l: number[]) => {
  const a = l.map((v) => 10 ** (v / 20)), peak = Math.max(...a);
  return Math.max(0, ...a.slice(1).map((v, i) => Math.abs(v - a[i]!) / peak));
};

/** gleichmäßiges „Publikumsrauschen“ als Prüfsignal (konstante Lautheit, damit nur die Übergänge messbar sind) */
function steady(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const b = ctx.createBuffer(2, Math.floor(sec * SR), SR);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); let lp = 0, seed = 12345 + ch; for (let i = 0; i < d.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; lp += ((seed / 0x7fffffff) * 2 - 1 - lp) * 0.2; d[i] = lp * 1.2; } }
  return b;
}

async function setup(seconds: number, buf = 10) {
  const ctx = new wa!.OfflineAudioContext(2, SR * seconds, SR) as unknown as OfflineAudioContext;
  const m = new StadiumMixer();
  m.attach(ctx, { attendance: 30000, capacity: 35000, importance: 0.5 });
  // stille „Rauschaufnahme“: schaltet das Ersatzrauschen ab (≈ 3 s), damit nur die Übergänge des Gesangs gemessen werden
  m.preload('mem://amb', ctx.createBuffer(2, SR * 30, SR));
  m.setLibrary(buildLibrary('mem://', [{ id: 'amb', category: 'ambience', file: 'amb', duration: 30 }]));
  m.setCrowd(0.7, 0.1, 0);
  m.preload('mem://t', steady(ctx, buf));
  return { ctx, m };
}
const at = async (ctx: OfflineAudioContext, t: number, fn: () => void) => { void ctx.suspend(t).then(() => { fn(); void ctx.resume(); }); };

describe.skipIf(!wa)('Audioübergänge (Offline-Rendering)', () => {
  it('Fangesang beginnt: Einblenden über 1,5 s ohne Sprung', async () => {
    const { ctx, m } = await setup(12);
    await m.play('mem://t', { channel: 'home', at: 5, fadeIn: 1.5, volume: 0.6 });
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 4.5, 10);
    const steady = l.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const rise = l.findIndex((v) => v > steady - 3) / 10 + 4.5; // Zeitpunkt, ab dem der Gesang nahe am Endpegel liegt
    expect(rise - 5).toBeGreaterThan(0.8); expect(rise - 5).toBeLessThan(2.6);
    expect(maxStep(l.slice(5, 26))).toBeLessThan(0.2); // höchstens 20 % des Pegels je 100 ms
  }, 60_000);

  it('natürliches Ende: Ausblenden über ≈ 2 s, vorher kein Eingriff', async () => {
    const { ctx, m } = await setup(16, 6);
    await m.play('mem://t', { channel: 'home', at: 5, fadeIn: 1.5, endFade: 2, volume: 0.6 }); // Datei 6 s ⇒ Ende bei 11 s
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 4.5, 14);
    const mid = l.slice(30, 50).reduce((a, b) => a + b, 0) / 20; // 7,5–9,5 s: voller Pegel
    const fallStart = l.findIndex((v, i) => i > 50 && v < mid - 3);
    const endIdx = l.findIndex((v, i) => i > 50 && v < mid - 20); // Abfall um 20 dB
    expect(fallStart).toBeGreaterThan(0); expect(endIdx).toBeGreaterThan(0);
    expect((fallStart + 4.5 * 10) / 10).toBeGreaterThan(9); // Ausblenden beginnt erst kurz vor dem natürlichen Ende (≈ 9 s)
    expect((endIdx - fallStart) / 10).toBeGreaterThan(0.6); // mehr als 0,6 s von −3 dB bis −20 dB
    expect(maxStep(l.slice(40, 90))).toBeLessThan(0.2);
  }, 60_000);

  it('Tor während eines Gesangs: stop(2,2 s) blendet weich aus, kein harter Schnitt', async () => {
    const { ctx, m } = await setup(16);
    const tr = await m.play('mem://t', { channel: 'home', at: 4.5, fadeIn: 1.5, volume: 0.6 });
    await at(ctx, 9, () => tr!.stop(2.2, 'goal'));
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 8, 13);
    const before = l.slice(2, 8).reduce((a, b) => a + b, 0) / 6;
    const after = l.slice(-5).reduce((a, b) => a + b, 0) / 5;
    expect(before - after).toBeGreaterThan(40); // am Ende still
    expect(maxStep(l)).toBeLessThan(0.2); // ein harter Schnitt (0,2 s) läge bei ≈ 0,45 je 100 ms
    const log = m.log.filter((e) => e.ev === 'stop');
    expect(log[0]).toMatchObject({ reason: 'goal', fade: 2.2 });
  }, 60_000);

  it('Kontrolle: ein harter Stopp (0,2 s, altes Verhalten bei Toren) wird von der Messung erkannt', async () => {
    const { ctx, m } = await setup(16);
    const tr = await m.play('mem://t', { channel: 'home', at: 4.5, fadeIn: 1.5, volume: 0.6 });
    await at(ctx, 9, () => tr!.stop(0.2, 'goal'));
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 8, 13);
    expect(maxStep(l)).toBeGreaterThan(0.3);
  }, 60_000);

  it('Ereignis (Torjubel): Gesang wird innerhalb 0,4–0,8 s deutlich leiser (Ducking) und kehrt weich zurück', async () => {
    const { ctx, m } = await setup(24, 20);
    await m.play('mem://t', { channel: 'home', at: 4, fadeIn: 0.5, volume: 0.6 });
    await at(ctx, 10, () => m.duckChants('both', 0.15, { attack: 0.6, hold: 3.5, release: 2.5 }));
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 8, 22);
    const base = l.slice(5, 15).reduce((a, b) => a + b, 0) / 10; // 8,5–9,5 s
    const t = (thr: number) => l.findIndex((v, i) => i > 20 && v < base - thr) / 10 + 8 - 10; // Sekunden nach dem Ereignis
    expect(t(10)).toBeGreaterThan(0.2); expect(t(10)).toBeLessThan(0.9); // −10 dB nach 0,2–0,9 s
    const low = l.slice(26, 34).reduce((a, b) => a + b, 0) / 8; // 10,6–11,4 s
    expect(base - low).toBeGreaterThan(13);
    const back = l.slice(-10).reduce((a, b) => a + b, 0) / 10;
    expect(Math.abs(back - base)).toBeLessThan(3); // kehrt auf den Ausgangspegel zurück
    expect(maxStep(l)).toBeLessThan(0.2); // weiche Rückkehr
  }, 60_000);

  it('Ducking und Gesang werden nicht über AudioParam.value gelesen: zwei Ducks hintereinander bleiben stetig', async () => {
    const { ctx, m } = await setup(20, 16);
    await m.play('mem://t', { channel: 'home', at: 4, fadeIn: 0.5, volume: 0.6 });
    await at(ctx, 8, () => m.duckChants('home', 0.3, { attack: 0.5, hold: 1.5, release: 2 }));
    await at(ctx, 9.2, () => m.duckChants('home', 0.5, { attack: 0.4, hold: 1, release: 1.5 })); // mitten im ersten Duck
    const l = levels(await ctx.startRendering() as unknown as AudioBuffer, 7, 16);
    expect(maxStep(l)).toBeLessThan(0.2);
  }, 60_000);
});
