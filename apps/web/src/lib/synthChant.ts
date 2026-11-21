/**
 * Generische, vereinsneutrale Fangesänge – im Browser synthetisiert (keine Dateien, keine Kosten).
 * Klangbild einer Stadionaufnahme: viele leicht verstimmte Männerstimmen mit Vokal-Formanten,
 * ungenaue Einsätze, Vibrato, Atemrauschen, eine große Trommel und Hall/Entfernung (Tiefpass).
 * Melodien sind einfache, eigene Rufmotive (keine bekannten Lieder).
 */
type Vowel = 'oh' | 'ah' | 'eh' | 'ee';
/** [Halbton relativ zum Grundton, Dauer in Schlägen, Vokal] */
type Note = readonly [number, number, Vowel];
interface Pattern { name: string; bpm: number; root: number; bars: Note[]; repeat: number; drum: number[] }

export const CHANT_PATTERNS: readonly Pattern[] = [
  { name: 'Ruf A', bpm: 118, root: 196, repeat: 3, drum: [0, 1, 2, 2.5, 3], bars: [[0, 1, 'oh'], [0, 0.5, 'eh'], [2, 0.5, 'eh'], [4, 1, 'oh'], [2, 1, 'ah'], [0, 2, 'oh'], [-3, 2, 'ah']] },
  { name: 'Ruf B', bpm: 126, root: 220, repeat: 3, drum: [0, 1, 2, 3], bars: [[0, 0.5, 'ah'], [0, 0.5, 'ah'], [5, 1, 'eh'], [4, 1, 'ah'], [2, 1, 'oh'], [0, 3, 'oh'], [-1, 1, 'ee']] },
  { name: 'Ruf C', bpm: 104, root: 185, repeat: 2, drum: [0, 2], bars: [[0, 2, 'oh'], [7, 2, 'ah'], [5, 1, 'eh'], [4, 1, 'eh'], [2, 2, 'oh'], [0, 4, 'oh']] },
  { name: 'Ruf D', bpm: 132, root: 208, repeat: 4, drum: [0, 0.5, 1, 2, 2.5, 3], bars: [[0, 0.5, 'eh'], [2, 0.5, 'eh'], [4, 0.5, 'eh'], [5, 0.5, 'eh'], [7, 1, 'oh'], [5, 1, 'ah'], [4, 2, 'oh']] },
  { name: 'Ruf E', bpm: 96, root: 175, repeat: 2, drum: [0, 1.5, 2, 3], bars: [[0, 1.5, 'ah'], [3, 0.5, 'ah'], [5, 2, 'oh'], [3, 1, 'eh'], [0, 1, 'eh'], [-2, 2, 'oh']] },
  { name: 'Ruf F', bpm: 140, root: 230, repeat: 4, drum: [0, 1, 2, 3], bars: [[0, 1, 'ee'], [0, 1, 'oh'], [3, 1, 'ee'], [3, 1, 'oh'], [5, 1, 'ah'], [3, 1, 'oh'], [0, 2, 'oh']] },
];

const FORMANTS: Record<Vowel, [number, number, number]> = { oh: [450, 800, 2830], ah: [730, 1090, 2440], eh: [530, 1840, 2480], ee: [300, 2200, 2900] };

/** einfacher, reproduzierbarer Zufall */
function rng(seed: number) {
  let x = seed * 2654435761 >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function noiseBuffer(ctx: BaseAudioContext, sec: number, r: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

/** Hall eines großen, offenen Stadions (abklingendes Rauschen, Stereo) */
function reverbIR(ctx: BaseAudioContext, r: () => number): AudioBuffer {
  const sec = 2.2;
  const b = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * sec), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = (r() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.55)) * (i < ctx.sampleRate * 0.02 ? i / (ctx.sampleRate * 0.02) : 1);
  }
  return b;
}

const cache = new Map<string, Promise<AudioBuffer | null>>();

/** Gesang `index` (Modulo Anzahl) als Stereo-Puffer rendern (einmal je Abtastrate) */
export function renderChant(index: number, sampleRate: number): Promise<AudioBuffer | null> {
  const key = `${index}:${sampleRate}`;
  let p = cache.get(key);
  if (!p) { p = doRender(index, sampleRate); cache.set(key, p); }
  return p;
}

async function doRender(index: number, sampleRate: number): Promise<AudioBuffer | null> {
  const Ctor = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctor) return null;
  const pat = CHANT_PATTERNS[((index % CHANT_PATTERNS.length) + CHANT_PATTERNS.length) % CHANT_PATTERNS.length]!;
  const beat = 60 / pat.bpm;
  const barBeats = pat.bars.reduce((a, n) => a + n[1], 0);
  const total = barBeats * beat * pat.repeat + 2.5;
  const ctx = new Ctor(2, Math.ceil(total * sampleRate), sampleRate);
  const r = rng(index + 11);

  // Signalweg: Stimmen/Trommel → Entfernung (Tiefpass) → trocken + Hall → Ausgang
  const dist = ctx.createBiquadFilter(); dist.type = 'lowpass'; dist.frequency.value = 3600; dist.Q.value = 0.5;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
  const dry = ctx.createGain(); dry.gain.value = 0.55;
  const wet = ctx.createGain(); wet.gain.value = 0.6;
  const conv = ctx.createConvolver(); conv.buffer = reverbIR(ctx, r);
  dist.connect(hp); hp.connect(dry).connect(ctx.destination); hp.connect(conv).connect(wet).connect(ctx.destination);

  const VOICES = 26;
  let t = 0.3;
  for (let rep = 0; rep < pat.repeat; rep++) {
    // Einsatz der Trommel je Takt
    for (let b = 0; b < barBeats; b += 4) {
      for (const d of pat.drum) {
        const at = t + (b + d) * beat;
        if (at > t + barBeats * beat) continue;
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(95, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.22);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.55, at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
        o.connect(g).connect(dist); o.start(at); o.stop(at + 0.5);
        const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 0.08, r);
        const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.8;
        const ng = ctx.createGain(); ng.gain.setValueAtTime(0.12, at); ng.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
        n.connect(nf).connect(ng).connect(dist); n.start(at); n.stop(at + 0.08);
      }
    }
    // Stimmen: jede Note mit vielen Sängern (verstimmt, ungenau, Vibrato), Vokal über Formanten
    let pos = 0;
    for (const [semi, len, vowel] of pat.bars) {
      const at = t + pos * beat;
      const dur = len * beat;
      const [f1, f2, f3] = FORMANTS[vowel];
      const sum = ctx.createGain(); sum.gain.value = 1 / VOICES;
      const env = ctx.createGain();
      const peak = 0.9 * (rep === pat.repeat - 1 ? 1.1 : 1);
      env.gain.setValueAtTime(0.0001, at); env.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.09, dur * 0.3));
      env.gain.setValueAtTime(peak * 0.85, at + dur * 0.75); env.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.12);
      for (const [f, q, g0] of [[f1, 5, 1], [f2, 7, 0.6], [f3, 9, 0.25]] as const) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        const fg = ctx.createGain(); fg.gain.value = g0 * 2.2;
        sum.connect(bp).connect(fg).connect(env);
      }
      env.connect(dist);
      const freq = pat.root * 2 ** (semi / 12);
      for (let v = 0; v < VOICES; v++) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        const oct = v % 9 === 0 ? 0.5 : v % 13 === 0 ? 2 : 1; // ein paar tiefe/hohe Stimmen
        const detune = (r() - 0.5) * 60; // ±30 Cent
        o.frequency.value = freq * oct; o.detune.value = detune;
        const vib = ctx.createOscillator(); vib.frequency.value = 4.5 + r() * 2;
        const vg = ctx.createGain(); vg.gain.value = 6 + r() * 8; vib.connect(vg).connect(o.detune);
        const pan = ctx.createStereoPanner(); pan.pan.value = (r() - 0.5) * 1.6;
        const og = ctx.createGain(); og.gain.value = 0.6 + r() * 0.8;
        o.connect(og).connect(pan).connect(sum);
        const st = at + (r() - 0.3) * 0.07; // ungenaue Einsätze
        o.start(Math.max(0, st)); o.stop(at + dur + 0.15); vib.start(Math.max(0, st)); vib.stop(at + dur + 0.15);
      }
      // Atem/Rauschen der Menge
      const br = ctx.createBufferSource(); br.buffer = noiseBuffer(ctx, dur + 0.2, r);
      const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = f2; bf.Q.value = 1.2;
      const bg = ctx.createGain(); bg.gain.setValueAtTime(0.0001, at); bg.gain.exponentialRampToValueAtTime(0.05, at + 0.08); bg.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.1);
      br.connect(bf).connect(bg).connect(dist); br.start(at); br.stop(at + dur + 0.2);
      pos += len;
    }
    t += barBeats * beat;
  }
  return ctx.startRendering();
}

/** 3 Gesänge je Verein (vereinsneutral, aber je Verein unterschiedlich) */
export function chantSetFor(clubId: string): number[] {
  let h = 0;
  for (const ch of clubId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = CHANT_PATTERNS.length;
  const a = h % n;
  return [a, (a + 1 + (h >> 8) % (n - 1)) % n, (a + 3) % n].filter((x, i, arr) => arr.indexOf(x) === i);
}
