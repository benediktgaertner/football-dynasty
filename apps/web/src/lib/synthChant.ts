/**
 * Generische, vereinsneutrale Fanreaktionen einer Kurve – im Browser erzeugt (keine Dateien, keine Kosten).
 *
 * Bewusst KEINE Musik: keine Melodie, keine Instrumente, keine Loops. Jeder „Sänger“ ruft mit eigener
 * Sprechstimme (zufällige Tonhöhe 90–210 Hz, Gleiten wie beim Rufen), dazu viel Atem-/Stimmrauschen,
 * Silben über Vokal-Formanten, ungenaue Einsätze, synchrones Klatschen aus vielen einzelnen Klatschern,
 * höchstens eine dezente große Trommel im Hintergrund und Stadionhall mit Entfernung (Tiefpass).
 * Ergebnis: Sprechchöre, rhythmisches Anfeuern und Klatschen – wie eine echte Fankurve.
 */
type Vowel = 'oh' | 'ah' | 'eh' | 'ee' | 'oo';
/** Silbe eines Sprechchors: Vokal, Dauer (Schläge), Betonung 0–1 */
type Syl = readonly [Vowel, number, number];
interface Pattern {
  name: string;
  bpm: number;
  /** Rufsilben (leer = nur Klatschen/Anfeuern) */
  call: Syl[];
  /** Klatscher je Takt (Schlagpositionen) */
  claps: number[];
  repeat: number;
  /** dezente Trommel (Schlagpositionen; leer = keine) */
  drum: number[];
  /** Anschwellendes Rufen (z. B. „Uuuuh … HEY!“) statt Silbenfolge */
  swell?: boolean;
}

export const CHANT_PATTERNS: readonly Pattern[] = [
  // Klatschen „klatsch – klatsch – klatsch-klatsch-klatsch“ + „HEY!“
  { name: 'Klatschrhythmus', bpm: 112, repeat: 3, call: [['eh', 3.5, 0], ['eh', 0.5, 1]], claps: [0, 1, 2, 2.5, 3], drum: [] },
  // Zweisilbiger Sprechchor („Ho-Hey“), dazwischen Klatschen
  { name: 'Sprechchor kurz', bpm: 120, repeat: 4, call: [['oh', 1, 0.8], ['eh', 1, 1], ['ah', 2, 0]], claps: [2, 3], drum: [0] },
  // Dreisilbiger Ruf mit Pause („Auf geht's – los!“)
  { name: 'Anfeuerung', bpm: 128, repeat: 3, call: [['ah', 0.5, 0.9], ['oo', 0.5, 0.7], ['eh', 1, 1], ['oh', 1, 0.9], ['ah', 1, 0]], claps: [3], drum: [0, 2] },
  // Anschwellendes „Uuuuh … HEY!“
  { name: 'Uuuh-Hey', bpm: 96, repeat: 2, call: [['oo', 3, 0.6], ['eh', 1, 1]], claps: [], drum: [], swell: true },
  // Dauerklatschen mit Anfeuerungsrufen
  { name: 'Dauerklatschen', bpm: 138, repeat: 4, call: [['ah', 2, 0.5], ['eh', 2, 0.4]], claps: [0, 1, 2, 3], drum: [] },
  // Wechselruf mit Klatschen („Ei-ne Kur-ve“-Rhythmus, ohne Melodie)
  { name: 'Silbenchor', bpm: 116, repeat: 3, call: [['ee', 0.5, 0.8], ['eh', 0.5, 0.7], ['oo', 0.5, 0.8], ['eh', 0.5, 0.7], ['ah', 1, 1], ['ah', 1, 0]], claps: [3], drum: [0] },
];

const FORMANTS: Record<Vowel, [number, number, number]> = {
  oh: [450, 800, 2830], ah: [730, 1090, 2440], eh: [530, 1840, 2480], ee: [300, 2200, 2900], oo: [330, 870, 2240],
};

/** einfacher, reproduzierbarer Zufall */
function rng(seed: number) {
  let x = (seed * 2654435761) >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function noiseBuffer(ctx: BaseAudioContext, sec: number, r: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * sec)), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  return b;
}

/** Hall eines großen, offenen Stadions (abklingendes Rauschen, Stereo) */
function reverbIR(ctx: BaseAudioContext, r: () => number): AudioBuffer {
  const sec = 2.4;
  const b = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * sec), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = (r() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.6)) * (i < ctx.sampleRate * 0.03 ? i / (ctx.sampleRate * 0.03) : 1);
  }
  return b;
}

const cache = new Map<string, Promise<AudioBuffer | null>>();

/** Reaktion `index` (Modulo Anzahl) als Stereo-Puffer rendern (einmal je Abtastrate) */
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
  const barBeats = 4;
  const total = barBeats * beat * pat.repeat + 2.8;
  const ctx = new Ctor(2, Math.ceil(total * sampleRate), sampleRate);
  const r = rng(index * 7 + 3);

  // Entfernung (Tiefpass) → trocken + Hall
  const dist = ctx.createBiquadFilter(); dist.type = 'lowpass'; dist.frequency.value = 3200; dist.Q.value = 0.4;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  const dry = ctx.createGain(); dry.gain.value = 0.5;
  const wet = ctx.createGain(); wet.gain.value = 0.75;
  const conv = ctx.createConvolver(); conv.buffer = reverbIR(ctx, r);
  dist.connect(hp); hp.connect(dry).connect(ctx.destination); hp.connect(conv).connect(wet).connect(ctx.destination);

  // Grundrauschen der Kurve (Gemurmel) über die ganze Dauer
  const bed = ctx.createBufferSource(); bed.buffer = noiseBuffer(ctx, total, r);
  const bedF = ctx.createBiquadFilter(); bedF.type = 'bandpass'; bedF.frequency.value = 700; bedF.Q.value = 0.6;
  const bedG = ctx.createGain(); bedG.gain.setValueAtTime(0.0001, 0); bedG.gain.linearRampToValueAtTime(0.05, 0.6); bedG.gain.setValueAtTime(0.05, total - 1.5); bedG.gain.linearRampToValueAtTime(0.0001, total - 0.2);
  bed.connect(bedF).connect(bedG).connect(dist); bed.start(0);

  const SHOUTERS = 34;
  // Jeder Rufer hat eine eigene Sprechstimme (keine gemeinsame Tonhöhe ⇒ keine Melodie)
  const voices = Array.from({ length: SHOUTERS }, () => ({ f0: 90 + r() * 120, pan: (r() - 0.5) * 1.8, gain: 0.5 + r(), late: r() * 0.09 }));

  let t0 = 0.35;
  for (let rep = 0; rep < pat.repeat; rep++) {
    // --- Klatschen: jeder Klatscher ein kurzer, gefilterter Rauschimpuls, leicht ungleichzeitig
    for (const c of pat.claps) {
      const at = t0 + c * beat;
      const sum = ctx.createGain(); sum.gain.value = 0.9;
      const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 1500 + r() * 400; cf.Q.value = 0.9;
      sum.connect(cf).connect(dist);
      for (let k = 0; k < 36; k++) {
        const n = ctx.createBufferSource(); n.buffer = noiseBuffer(ctx, 0.06, r);
        const g = ctx.createGain();
        const st = at + (r() - 0.5) * 0.05;
        g.gain.setValueAtTime(0.0001, Math.max(0, st)); g.gain.exponentialRampToValueAtTime(0.06 + r() * 0.05, Math.max(0, st) + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, Math.max(0, st) + 0.05);
        const pn = ctx.createStereoPanner(); pn.pan.value = (r() - 0.5) * 1.8;
        n.connect(g).connect(pn).connect(sum); n.start(Math.max(0, st)); n.stop(Math.max(0, st) + 0.06);
      }
    }
    // --- dezente große Trommel im Hintergrund
    for (const d of pat.drum) {
      const at = t0 + d * beat;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(80, at); o.frequency.exponentialRampToValueAtTime(45, at + 0.2);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.18, at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(dist); o.start(at); o.stop(at + 0.4);
    }
    // --- Rufen: Silben mit Formanten, Stimme = eigene Grundfrequenz + viel Rauschen (Schreien statt Singen)
    let pos = 0;
    for (const [vowel, len, accent] of pat.call) {
      const at = t0 + pos * beat;
      pos += len;
      if (accent <= 0) continue; // Pause
      const dur = pat.swell ? len * beat : Math.min(len * beat * 0.8, 0.55);
      const [f1, f2, f3] = FORMANTS[vowel];
      const sum = ctx.createGain(); sum.gain.value = 1 / SHOUTERS;
      const env = ctx.createGain();
      const peak = 0.55 + accent * 0.75;
      if (pat.swell) {
        env.gain.setValueAtTime(0.0001, at); env.gain.exponentialRampToValueAtTime(peak * 0.9, at + dur * 0.92); env.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.05);
      } else {
        env.gain.setValueAtTime(0.0001, at); env.gain.exponentialRampToValueAtTime(peak, at + 0.04); env.gain.exponentialRampToValueAtTime(peak * 0.5, at + dur * 0.6); env.gain.exponentialRampToValueAtTime(0.0001, at + dur + 0.08);
      }
      for (const [f, q, g0] of [[f1, 3.5, 1], [f2, 4.5, 0.7], [f3, 6, 0.3]] as const) {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * (0.95 + r() * 0.1); bp.Q.value = q;
        const fg = ctx.createGain(); fg.gain.value = g0 * 2.4;
        sum.connect(bp).connect(fg).connect(env);
      }
      env.connect(dist);
      // Stimmrauschen (Atem, Heiserkeit) – trägt den Großteil des Klangs
      const br = ctx.createBufferSource(); br.buffer = noiseBuffer(ctx, dur + 0.2, r);
      const bg = ctx.createGain(); bg.gain.value = SHOUTERS * 0.55;
      br.connect(bg).connect(sum); br.start(at); br.stop(at + dur + 0.15);
      for (const v of voices) {
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        // Rufen: Tonhöhe steigt beim Ansatz, fällt am Ende (Sprechmelodie jeder Person, nicht gemeinsam)
        const f0 = v.f0 * (pat.swell ? 1 : 1 + accent * 0.25);
        const st = at + v.late;
        o.frequency.setValueAtTime(f0 * 0.9, st); o.frequency.linearRampToValueAtTime(f0 * (pat.swell ? 1.35 : 1.08), st + dur * 0.4); o.frequency.linearRampToValueAtTime(f0 * 0.85, st + dur);
        const jit = ctx.createOscillator(); jit.frequency.value = 6 + r() * 5;
        const jg = ctx.createGain(); jg.gain.value = 25 + r() * 35; jit.connect(jg).connect(o.detune);
        const og = ctx.createGain(); og.gain.value = 0.35 * v.gain;
        const pn = ctx.createStereoPanner(); pn.pan.value = v.pan;
        o.connect(og).connect(pn).connect(sum);
        o.start(st); o.stop(st + dur + 0.1); jit.start(st); jit.stop(st + dur + 0.1);
      }
    }
    t0 += barBeats * beat;
  }
  return ctx.startRendering();
}

/** 3 Reaktionen je Verein (vereinsneutral, aber je Verein unterschiedlich) */
export function chantSetFor(clubId: string): number[] {
  let h = 0;
  for (const ch of clubId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = CHANT_PATTERNS.length;
  const a = h % n;
  return [a, (a + 1 + ((h >> 8) % (n - 1))) % n, (a + 3) % n].filter((x, i, arr) => arr.indexOf(x) === i);
}

/**
 * Musikalität eines Klangs (0 = Geräusch/Rufen, 1 = klare Tonhöhe/Musik): normierte Autokorrelation im
 * Stimmbereich 80–400 Hz, gemittelt über 50-ms-Fenster. Für Tests (echte Kurve statt Musik).
 */
export function harmonicity(data: Float32Array, sampleRate: number): number {
  const win = Math.round(sampleRate * 0.05);
  const lo = Math.round(sampleRate / 400), hi = Math.round(sampleRate / 80);
  let sum = 0, n = 0;
  for (let start = 0; start + win + hi < data.length; start += win * 2) {
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += data[start + i]! * data[start + i]!;
    if (e0 < 1e-6) continue;
    let best = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < win; i++) { c += data[start + i]! * data[start + i + lag]!; e1 += data[start + i + lag]! * data[start + i + lag]!; }
      best = Math.max(best, c / Math.sqrt(e0 * e1 + 1e-12));
    }
    sum += best; n++;
  }
  return n ? sum / n : 0;
}
