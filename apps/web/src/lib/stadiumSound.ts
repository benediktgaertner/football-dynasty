/**
 * Stadionsound ohne externe Dienste und ohne Kosten:
 * - Hymnen: im Browser komponiert (Web Audio) – Melodie, Akkorde, Bass, Schlagzeug und ein Chor
 *   (Formant-Synthese „Ooh/Aah“). Der Hymnentext läuft als Mitsingtext synchron zur Melodie mit.
 * - Fangesänge: Trommeln, Klatschen, Chor-Melodien und Sprechchöre (deutsche Sprachausgabe des Geräts).
 * - Hochgeladene MP3 (z. B. mit Suno erstellt) werden unverändert abgespielt.
 * Alles ist deterministisch aus einem Rezept (Seed + Stil) – gespeichert wird nur das Rezept, nicht die Audiodatei.
 */
export type AnthemStyle = 'stadium' | 'rock' | 'march' | 'epic' | 'traditional' | 'modern';
export type ChantStyle = 'chant' | 'melodic' | 'call_response' | 'drums' | 'classic';
export type Mood = 'proud' | 'euphoric' | 'defiant' | 'solemn' | 'cheerful';
export type Voice = 'choir' | 'men' | 'women' | 'mixed' | 'none';
export interface Recipe { seed: number; style: AnthemStyle | ChantStyle; mood: Mood; voice: Voice; tempo: number; key: number; bars: number }

export const ANTHEM_STYLES: Array<{ key: AnthemStyle; label: string }> = [
  { key: 'stadium', label: 'Stadionhymne' }, { key: 'rock', label: 'Fußballrock' }, { key: 'march', label: 'Marsch' },
  { key: 'epic', label: 'Episch' }, { key: 'traditional', label: 'Traditionell' }, { key: 'modern', label: 'Modern' },
];
export const CHANT_STYLES: Array<{ key: ChantStyle; label: string }> = [
  { key: 'chant', label: 'Rhythmischer Sprechchor' }, { key: 'melodic', label: 'Melodischer Gesang' }, { key: 'call_response', label: 'Wechselgesang' },
  { key: 'drums', label: 'Trommelrhythmus' }, { key: 'classic', label: 'Klassischer Stadionchant' },
];
export const MOODS: Array<{ key: Mood; label: string }> = [
  { key: 'proud', label: 'Stolz' }, { key: 'euphoric', label: 'Euphorisch' }, { key: 'defiant', label: 'Trotzig' }, { key: 'solemn', label: 'Feierlich' }, { key: 'cheerful', label: 'Fröhlich' },
];
export const VOICES: Array<{ key: Voice; label: string }> = [
  { key: 'choir', label: 'Fanchor' }, { key: 'men', label: 'Männerstimmen' }, { key: 'women', label: 'Frauenstimmen' }, { key: 'mixed', label: 'Gemischt' }, { key: 'none', label: 'Instrumental' },
];
export const SITUATIONS: Array<{ key: string; label: string }> = [
  { key: '', label: 'Keine (Bibliothek)' }, { key: 'attack', label: 'Angriff' }, { key: 'goal', label: 'Tor' }, { key: 'behind', label: 'Rückstand' },
  { key: 'lead', label: 'Führung' }, { key: 'derby', label: 'Derby/Topspiel' },
];

function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeRecipe(style: Recipe['style'], mood: Mood, voice: Voice, seed = Math.floor(Math.random() * 1e9)): Recipe {
  const r = rng(seed);
  const base: Record<string, number> = { stadium: 92, rock: 128, march: 112, epic: 72, traditional: 100, modern: 118, chant: 116, melodic: 104, call_response: 120, drums: 124, classic: 96 };
  const tempo = Math.round((base[style] ?? 100) * (mood === 'solemn' ? 0.88 : mood === 'euphoric' ? 1.08 : 1) + (r() - 0.5) * 8);
  return { seed, style, mood, voice, tempo, key: Math.floor(r() * 12), bars: ['chant', 'call_response', 'drums', 'classic', 'melodic'].includes(style) ? 8 : 16 };
}

// ---------------------------------------------------------------------------------------------
// Textgenerator (Vorlagen, frei kombiniert – keine fremden Liedtexte)
// ---------------------------------------------------------------------------------------------
export function generateLyrics(o: { club: string; short?: string; city?: string | null; kind: 'anthem' | 'chant'; style: string; mood: Mood; situation?: string; seed?: number }): string {
  const r = rng(o.seed ?? Math.floor(Math.random() * 1e9));
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const club = o.club;
  const short = (o.short ?? club.split(' ').slice(-1)[0] ?? club).toUpperCase();
  const city = o.city ?? 'unsrer Stadt';
  if (o.kind === 'chant') {
    const bySituation: Record<string, string[][]> = {
      goal: [[`TOR! TOR! ${short}!`, `Heute schießen wir euch ab!`], [`Hier regiert der ${short}!`, `Und das ganze Stadion singt!`], [`Eins für uns, und keins für euch!`, `${short}, ${short}!`]],
      attack: [[`Vorwärts ${short}, kämpfen und siegen!`], [`Auf geht's ${short}, schießt ein Tor!`], [`Lauft, ${short}, lauft!`, `Wir sind bei euch!`]],
      behind: [[`Steht auf, wenn ihr ${short} seid!`], [`Niemals aufgeben, ${short}!`, `Wir glauben an euch!`], [`Kämpfen, ${short}, kämpfen!`]],
      lead: [[`Heute ist ein schöner Tag!`, `${short} vorn – und so bleibt's!`], [`Die Nummer eins in ${city}!`], [`${short} führt – das ganze Stadion tanzt!`]],
      derby: [[`Diese Stadt gehört nur uns!`, `${short}!`], [`Wer nicht hüpft, ist kein echter ${short}!`], [`Nur der ${short}!`, `Ewig und für immer!`]],
    };
    const generic = [[`${short}! ${short}! ${short}!`], [`Wir sind ${short}, wir sind laut!`], [`Ole, ole, ${short} ole!`], [`Allez ${short}, allez!`, `Wir stehen hinter dir!`]];
    const lines = pick(bySituation[o.situation ?? ''] ?? generic);
    return o.style === 'call_response' ? `Vorsänger: Wer sind wir?\nAlle: ${short}!\nVorsänger: Wer ist da?\nAlle: ${lines[0]}` : lines.join('\n');
  }
  const openers = [`In ${city}, da schlägt ein Herz`, `Wo die Fahnen ${o.mood === 'solemn' ? 'leise wehen' : 'hoch im Winde wehen'}`, `Seit Generationen stehen wir hier`, `Wenn das Flutlicht über ${city} scheint`];
  const middles = [`für ${club}, durch Freud und Schmerz`, `da singen wir und lassen dich nie allein`, `in deinen Farben, Seite an Seite`, `wir tragen dich durch jedes Spiel`];
  const refrains = o.mood === 'defiant'
    ? [`${short} – wir weichen nicht, wir halten stand!`, `Gegen alle, für das eine Band!`]
    : o.mood === 'solemn'
      ? [`${club}, du bist unsre Heimat`, `in Ewigkeit vereint`]
      : [`${short}, ${short}, du bist unser Stolz!`, `Wir singen laut, wir singen nur für dich!`];
  const o1 = pick(openers), o2 = pick(openers.filter((x) => x !== o1));
  const m1 = pick(middles), m2 = pick(middles.filter((x) => x !== m1));
  return [o1, m1, o2, m2, '', ...refrains, ...refrains].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------------------------
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSIONS = [[0, 4, 5, 3], [0, 3, 4, 0], [0, 5, 3, 4], [0, 3, 0, 4]];

interface Note { t: number; d: number; midi: number }
interface Score { melody: Note[]; chords: Array<{ t: number; d: number; notes: number[] }>; bass: Note[]; beats: number; spb: number; lines: Array<{ t: number; text: string }> }

function compose(rc: Recipe, lyrics: string | null): Score {
  const r = rng(rc.seed);
  const minor = rc.mood === 'defiant' || rc.mood === 'solemn';
  const scale = minor ? MINOR : MAJOR;
  const root = 48 + rc.key; // C3 + Tonart
  const spb = 60 / rc.tempo;
  const prog = PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)]!;
  const bars = rc.bars;
  const deg = (d: number, oct = 0) => root + 12 * (oct + Math.floor(d / 7)) + scale[((d % 7) + 7) % 7]!;
  const chords: Score['chords'] = [];
  const bass: Note[] = [];
  for (let b = 0; b < bars; b++) {
    const d = prog[b % 4]!;
    chords.push({ t: b * 4, d: 4, notes: [deg(d, 1), deg(d + 2, 1), deg(d + 4, 1)] });
    const pattern = rc.style === 'march' ? [0, 2] : rc.style === 'rock' || rc.style === 'modern' ? [0, 1, 2, 3] : [0, 2.5];
    for (const p of pattern) bass.push({ t: b * 4 + p, d: rc.style === 'rock' ? 0.9 : 1.4, midi: deg(d, -1) });
  }
  // Melodie: zwei Phrasen (A, A', B, A) mit Kadenz auf den Grundton
  const phrase = (): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    let cur = 7 + Math.floor(r() * 3);
    for (let beat = 0; beat < 16;) {
      const dur = r() < 0.55 ? 1 : r() < 0.6 ? 0.5 : 2;
      cur = Math.max(4, Math.min(13, cur + Math.round((r() - 0.5) * 4)));
      out.push([cur, dur]);
      beat += dur;
    }
    out[out.length - 1] = [7, out[out.length - 1]![1]];
    return out;
  };
  const A = phrase(), B = phrase();
  const form = bars >= 16 ? [A, A, B, A] : [A, B];
  const melody: Note[] = [];
  let t = 0;
  for (const ph of form) for (const [d, dur] of ph) { melody.push({ t, d: dur, midi: deg(d) }); t += dur; }
  const beats = bars * 4;
  const textLines = (lyrics ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = textLines.map((text, i) => ({ t: (beats / Math.max(1, textLines.length)) * i * spb, text }));
  return { melody, chords, bass, beats, spb, lines };
}

const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

export interface PlayHandle { stop: () => void; duration: number; lines: Array<{ t: number; text: string }>; startedAt: number }

export class StadiumSound {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private active = new Set<() => void>();
  enabled = false;

  /** Muss aus einer Nutzeraktion heraus aufgerufen werden (Autoplay-Regeln der Browser) */
  async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp).connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const ch = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.enabled = this.ctx.state === 'running';
      return this.enabled;
    } catch { this.enabled = false; return false; }
  }

  stopAll(): void { for (const s of [...this.active]) s(); this.active.clear(); try { window.speechSynthesis?.cancel(); } catch { /* nicht verfügbar */ } }

  /** Grundrauschen der Zuschauer (Lautstärke 0…1, steigt bei Toren) */
  crowdLevel(level: number): void {
    if (!this.ctx || !this.master || !this.noise || !this.enabled) return;
    if (!this.crowd) {
      const src = this.ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const filter = this.ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 700; filter.Q.value = 0.6;
      const gain = this.ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master); src.start();
      this.crowd = { src, gain, filter };
    }
    const now = this.ctx.currentTime;
    this.crowd.gain.gain.cancelScheduledValues(now);
    this.crowd.gain.gain.setTargetAtTime(0.05 + 0.22 * Math.max(0, Math.min(1, level)), now, 0.4);
    this.crowd.filter.frequency.setTargetAtTime(600 + 900 * level, now, 0.4);
  }

  /** Datei abspielen (hochgeladene MP3) */
  playUrl(url: string, volume = 0.8, maxSec = 30): PlayHandle {
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.volume = Math.max(0, Math.min(1, volume));
    void audio.play().catch(() => undefined);
    let done = false;
    const stop = () => { if (done) return; done = true; audio.pause(); this.active.delete(stop); };
    this.active.add(stop);
    const timer = setTimeout(() => {
      // sanft ausblenden
      const v0 = audio.volume; let k = 0;
      const fade = setInterval(() => { k++; audio.volume = Math.max(0, v0 * (1 - k / 10)); if (k >= 10) { clearInterval(fade); stop(); } }, 80);
    }, maxSec * 1000);
    audio.addEventListener('ended', () => { clearTimeout(timer); stop(); });
    return { stop: () => { clearTimeout(timer); stop(); }, duration: maxSec, lines: [], startedAt: performance.now() };
  }

  /** Rezept im Browser abspielen */
  playRecipe(rc: Recipe, opts: { volume?: number; maxSec?: number; lyrics?: string | null; speak?: boolean } = {}): PlayHandle | null {
    if (!this.ctx || !this.master || !this.noise) return null;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = Math.max(0, Math.min(1, opts.volume ?? 0.8));
    out.connect(this.master);
    const isChant = ['chant', 'melodic', 'call_response', 'drums', 'classic'].includes(rc.style);
    const sc = compose(rc, opts.lyrics ?? null);
    const maxSec = opts.maxSec ?? 30;
    const repeats = isChant ? Math.max(1, Math.floor(maxSec / (sc.beats * sc.spb))) : 1;
    const total = Math.min(maxSec, sc.beats * sc.spb * repeats);
    const t0 = ctx.currentTime + 0.08;
    const nodes: AudioScheduledSourceNode[] = [];
    const end = t0 + total;
    const env = (g: GainNode, at: number, dur: number, peak: number, attack = 0.02, release = 0.12) => {
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + attack);
      g.gain.setValueAtTime(peak, Math.max(at + attack, at + dur - release)); g.gain.linearRampToValueAtTime(0, at + dur);
    };
    const osc = (type: OscillatorType, freq: number, at: number, dur: number, peak: number, dest: AudioNode, detune = 0) => {
      if (at >= end) return;
      dur = Math.min(dur, end - at);
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detune;
      const g = ctx.createGain(); env(g, at, dur, peak);
      o.connect(g).connect(dest); o.start(at); o.stop(at + dur + 0.05); nodes.push(o);
    };
    const noiseHit = (at: number, dur: number, peak: number, freq: number, q: number, type: BiquadFilterType = 'bandpass') => {
      if (at >= end) return;
      const s = ctx.createBufferSource(); s.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.setValueAtTime(peak, at); g.gain.exponentialRampToValueAtTime(0.001, at + dur);
      s.connect(f).connect(g).connect(out); s.start(at, Math.random()); s.stop(at + dur + 0.05); nodes.push(s);
    };
    const kick = (at: number, peak = 0.9) => {
      if (at >= end) return;
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.setValueAtTime(140, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.18);
      g.gain.setValueAtTime(peak, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
      o.connect(g).connect(out); o.start(at); o.stop(at + 0.32); nodes.push(o);
    };
    // Raumklang: kurzes Echo
    const room = ctx.createDelay(); room.delayTime.value = 0.11;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.35;
    room.connect(fb).connect(room); room.connect(wet).connect(out);
    const bus = ctx.createGain(); bus.connect(out); bus.connect(room);

    // Chor: Sägezahn durch zwei Formantfilter (A/O), mehrere verstimmte Stimmen
    const voiceShift = rc.voice === 'men' ? -12 : rc.voice === 'women' ? 12 : 0;
    const choirNote = (midi: number, at: number, dur: number, peak: number) => {
      if (rc.voice === 'none' || at >= end) return;
      const parts = rc.voice === 'mixed' ? [0, 12] : [0];
      for (const p of parts) for (const det of [-14, 0, 13]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(midi + voiceShift + p); o.detune.value = det;
        const vib = ctx.createOscillator(); vib.frequency.value = 5.2; const vg = ctx.createGain(); vg.gain.value = 9; vib.connect(vg).connect(o.detune);
        const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 650; f1.Q.value = 5;
        const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1100; f2.Q.value = 6;
        const g = ctx.createGain(); env(g, at, Math.min(dur, end - at), peak / 3, 0.05, 0.15);
        o.connect(f1).connect(g); o.connect(f2).connect(g); g.connect(bus);
        o.start(at); vib.start(at); o.stop(at + dur + 0.1); vib.stop(at + dur + 0.1); nodes.push(o, vib);
      }
    };

    for (let rep = 0; rep < repeats; rep++) {
      const base = t0 + rep * sc.beats * sc.spb;
      const T = (beat: number) => base + beat * sc.spb;
      // Schlagzeug / Trommeln
      for (let b = 0; b < sc.beats; b++) {
        const at = T(b);
        if (rc.style === 'march') { if (b % 2 === 0) kick(at, 0.7); noiseHit(at + sc.spb * 0.5, 0.12, 0.35, 2500, 0.8); if (b % 4 === 3) for (let k = 0; k < 4; k++) noiseHit(at + (k * sc.spb) / 4, 0.06, 0.25, 3000, 0.8); }
        else if (rc.style === 'modern') { kick(at, 0.85); if (b % 2 === 1) noiseHit(at, 0.14, 0.4, 1800, 0.9); noiseHit(at + sc.spb / 2, 0.04, 0.12, 8000, 1, 'highpass'); }
        else if (rc.style === 'rock') { if (b % 2 === 0) kick(at); else noiseHit(at, 0.2, 0.5, 1900, 0.7); noiseHit(at + sc.spb / 2, 0.05, 0.15, 7000, 1, 'highpass'); }
        else if (rc.style === 'epic') { if (b % 4 === 0) { kick(at, 1); kick(at + sc.spb * 0.5, 0.6); } }
        else if (isChant) {
          // Fankurve: große Trommel „bum – bum – bum bum bum“ + Klatschen
          if ([0, 1, 2].includes(b % 4) || (b % 4 === 3 && rc.style !== 'melodic')) kick(at, 0.95);
          if (b % 4 === 3) { kick(at + sc.spb / 3, 0.8); kick(at + (2 * sc.spb) / 3, 0.8); }
          if (rc.style !== 'drums' && b % 2 === 1) noiseHit(at, 0.09, 0.45, 1500, 0.6);
        } else if (b % 2 === 0) kick(at, 0.7);
      }
      if (rc.style === 'drums' || rc.style === 'chant') continue;
      // Begleitung
      const lead: OscillatorType = rc.style === 'traditional' ? 'square' : rc.style === 'modern' ? 'triangle' : 'sawtooth';
      if (!isChant) {
        for (const c of sc.chords) for (const n of c.notes) osc(rc.style === 'rock' ? 'sawtooth' : 'triangle', mtof(n), T(c.t), c.d * sc.spb, rc.style === 'rock' ? 0.05 : 0.04, bus, (n % 3) * 4);
        for (const n of sc.bass) osc(rc.style === 'march' ? 'square' : 'triangle', mtof(n.midi), T(n.t), n.d * sc.spb, 0.16, out);
      }
      // Melodie: Chor singt, Blechbläser/Leadsynth verdoppeln
      for (const n of sc.melody) {
        if (rc.voice !== 'none') choirNote(n.midi + 12, T(n.t), n.d * sc.spb, 0.5);
        if (!isChant || rc.voice === 'none') osc(lead, mtof(n.midi + 12), T(n.t), n.d * sc.spb * 0.95, rc.voice === 'none' ? 0.09 : 0.04, bus);
      }
    }
    // Sprechchor über die deutsche Sprachausgabe des Geräts (Zeile je Takt-Gruppe)
    const timers: number[] = [];
    const speakLines = (opts.speak ?? (rc.style === 'chant' || rc.style === 'call_response')) && opts.lyrics && 'speechSynthesis' in window;
    if (speakLines) {
      const lines = opts.lyrics!.split('\n').map((l) => l.replace(/^(Vorsänger|Alle):\s*/i, '').trim()).filter(Boolean);
      const voice = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith('de'));
      const every = Math.max(2, (sc.beats * sc.spb) / Math.max(1, lines.length));
      let k = 0;
      for (let at = 0.05; at < total - 1; at += every) {
        const text = lines[k++ % lines.length]!;
        timers.push(window.setTimeout(() => {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = 'de-DE'; if (voice) u.voice = voice;
          u.rate = 1.05; u.pitch = rc.voice === 'women' ? 1.25 : 0.75; u.volume = Math.min(1, (opts.volume ?? 0.8) + 0.1);
          window.speechSynthesis.speak(u);
        }, at * 1000));
      }
    }
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      for (const t of timers) clearTimeout(t);
      try { window.speechSynthesis?.cancel(); } catch { /* */ }
      const now = ctx.currentTime;
      out.gain.cancelScheduledValues(now); out.gain.setTargetAtTime(0, now, 0.15);
      setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch { /* bereits beendet */ } } out.disconnect(); }, 600);
      this.active.delete(stop);
    };
    this.active.add(stop);
    setTimeout(stop, (total + 0.6) * 1000);
    return { stop, duration: total, lines: sc.lines, startedAt: performance.now() };
  }
}

/** Gemeinsame Instanz (ein AudioContext je Seite) */
export const stadiumSound = new StadiumSound();

const SKIP_KEY = 'fd-walkout-skip';
const SOUND_KEY = 'fd-sound';
export const prefs = {
  get alwaysSkip(): boolean { try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } },
  set alwaysSkip(v: boolean) { try { localStorage.setItem(SKIP_KEY, v ? '1' : '0'); } catch { /* privat */ } },
  get sound(): boolean { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; } },
  set sound(v: boolean) { try { localStorage.setItem(SOUND_KEY, v ? '1' : '0'); } catch { /* privat */ } },
};
