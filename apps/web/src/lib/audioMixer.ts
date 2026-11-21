/**
 * Zentraler Stadion-Audiomixer (Web Audio API), vollständig im Browser.
 *
 * Kanäle (je mit eigenem Lautstärkeregler): Kulisse · Reaktionen · Effekte · Fangesänge · Hymnen
 * → Summenbus → Begrenzer (Kompressor + Ausgangspegel) → Lautsprecher.
 *
 * - Kulisse: Rauschen der Heimfans (links) und Gästefans (rechts), Pegel nach Auslastung, Spielstand,
 *   Bedeutung und aktueller Spannung; kehrt nach Höhepunkten langsam zum Grundpegel zurück.
 * - Reaktionen/Effekte: im Browser synthetisiert (Jubel, „Ooooh“, Pfiffe, Schiedsrichterpfiff,
 *   Aluminium, Netz, Ballkontakt) – keine fremden Audiodateien, keine Lizenzfragen, keine Kosten.
 * - MP3 (Hymnen, Fangesänge, Torhymnen): einmal geladen und dekodiert zwischengespeichert,
 *   automatisch auf vergleichbare Lautheit gebracht (RMS), weich ein-/ausgeblendet.
 * - Ducking: Während Hymnen/Torhymnen wird die Kulisse abgesenkt; Pfiffe bleiben immer hörbar.
 */
import { stadiumSound } from './stadiumSound';

export type Channel = 'crowd' | 'reactions' | 'sfx' | 'chants' | 'anthem';
export const CHANNELS: Array<{ key: Channel; label: string }> = [
  { key: 'crowd', label: 'Zuschauerkulisse' }, { key: 'reactions', label: 'Fanreaktionen' }, { key: 'sfx', label: 'Pfiffe & Ball' },
  { key: 'chants', label: 'Fangesänge' }, { key: 'anthem', label: 'Hymnen & Torhymnen' },
];
const VOL_KEY = 'fd-mixer-volumes';
const DEFAULT_VOL: Record<Channel, number> = { crowd: 0.8, reactions: 0.85, sfx: 0.75, chants: 0.8, anthem: 0.85 };

export function loadVolumes(): Record<Channel, number> {
  try { return { ...DEFAULT_VOL, ...(JSON.parse(localStorage.getItem(VOL_KEY) ?? '{}') as Partial<Record<Channel, number>>) }; } catch { return { ...DEFAULT_VOL }; }
}

export interface Track { stop: (fadeSec?: number) => void; ended: Promise<void>; url: string }

/** Ziel-Lautheit (RMS) für hochgeladene MP3 */
const TARGET_RMS = 0.12;

export class StadiumMixer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private bus: Partial<Record<Channel, GainNode>> = {};
  private duck: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private bedHome: { g: GainNode; f: BiquadFilterNode } | null = null;
  private bedAway: { g: GainNode; f: BiquadFilterNode } | null = null;
  private sources = new Set<AudioScheduledSourceNode>();
  private cache = new Map<string, Promise<{ buffer: AudioBuffer; norm: number } | null>>();
  private volumes = loadVolumes();
  private running = false;
  /** Spannung 0…1 (Ziel) und aktueller, geglätteter Wert */
  private excitement = 0.2;
  private target = 0.2;
  private base = 0.5;
  private hold = 0;
  private lastFx = new Map<string, number>();
  /** zählt Starts; verspätete Abschaltungen eines alten Spiels betreffen kein neues */
  generation = 0;

  get active(): boolean { return this.running && !!this.ctx && this.ctx.state === 'running'; }

  /** Start für ein Spiel (nach Nutzeraktion bzw. wenn der Browser es erlaubt). Mehrfachaufrufe sind harmlos. */
  async start(opts: { attendance: number; capacity: number; importance: number }): Promise<boolean> {
    const ok = await stadiumSound.unlock();
    if (!ok || !stadiumSound.ctx) return false;
    const ctx = stadiumSound.ctx;
    if (this.running && this.ctx === ctx) { this.configure(opts); return true; }
    this.ctx = ctx;
    this.generation++;
    // Summenbus mit Begrenzer
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.25;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    this.out.connect(comp).connect(ctx.destination);
    this.out.gain.setTargetAtTime(0.9, ctx.currentTime, 0.4);
    this.duck = ctx.createGain(); this.duck.connect(this.out);
    for (const c of CHANNELS) {
      const g = ctx.createGain(); g.gain.value = this.volumes[c.key];
      g.connect(c.key === 'crowd' || c.key === 'chants' ? this.duck : this.out);
      this.bus[c.key] = g;
    }
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = this.noise.getChannelData(ch); let b = 0; for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.25; } }
    this.bedHome = this.makeBed(-0.55, 650);
    this.bedAway = this.makeBed(0.7, 800);
    this.running = true;
    this.configure(opts);
    return true;
  }

  private makeBed(pan: number, freq: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.bus.crowd!);
    src.start(ctx.currentTime, Math.random() * 2);
    this.sources.add(src);
    return { g, f };
  }

  private configure(o: { attendance: number; capacity: number; importance: number }) {
    const fill = Math.max(0, Math.min(1, o.attendance / Math.max(1, o.capacity)));
    const size = Math.min(1, Math.log10(Math.max(1000, o.attendance)) / 4.9);
    this.base = (0.25 + 0.5 * fill * size) * (0.85 + 0.3 * o.importance);
  }

  setVolume(c: Channel, v: number) {
    this.volumes[c] = v;
    try { localStorage.setItem(VOL_KEY, JSON.stringify(this.volumes)); } catch { /* privat */ }
    const g = this.bus[c];
    if (g && this.ctx) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  getVolumes() { return { ...this.volumes }; }

  /** Spannung setzen (0…1); hold = Sekunden, in denen der Wert nicht unterschritten wird */
  push(level: number, hold = 0) {
    this.target = Math.max(this.target, Math.min(1, level));
    if (hold > 0 && this.ctx) this.hold = Math.max(this.hold, this.ctx.currentTime + hold);
  }
  /** Grundstimmung je Frame aus dem Spielgeschehen (wird langsam angenähert) */
  ambient(level: number) {
    if (!this.ctx || (this.hold > this.ctx.currentTime)) return;
    this.target = level;
  }

  /** etwa 10× pro Sekunde aufrufen: Kulisse dem Spielgeschehen nachführen */
  tick(dt: number, homeMood = 1) {
    if (!this.active || !this.bedHome || !this.bedAway || !this.ctx) return;
    const k = this.target > this.excitement ? Math.min(1, dt * 2.5) : Math.min(1, dt * 0.35); // schnell rauf, langsam runter
    this.excitement += (this.target - this.excitement) * k;
    if (this.hold < this.ctx.currentTime) this.target += (0.25 - this.target) * Math.min(1, dt * 0.15);
    const now = this.ctx.currentTime;
    const lvl = this.base * (0.35 + 0.9 * this.excitement);
    this.bedHome.g.gain.setTargetAtTime(lvl * 0.55 * homeMood, now, 0.25);
    this.bedHome.f.frequency.setTargetAtTime(550 + 700 * this.excitement, now, 0.3);
    this.bedAway.g.gain.setTargetAtTime(this.base * 0.12 * (0.6 + 0.6 * this.excitement), now, 0.3);
  }

  /** Kulisse während Hymnen/Torhymnen absenken (1 = normal) */
  ducking(level: number, sec = 0.6) {
    if (this.duck && this.ctx) this.duck.gain.setTargetAtTime(level, this.ctx.currentTime, sec / 3);
  }

  /** gleiche Effekte nicht doppelt innerhalb von ms auslösen */
  private once(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.lastFx.get(key) ?? 0) > now - ms) return false;
    this.lastFx.set(key, now);
    return true;
  }

  // ------------------------------------------------------------------ Effekte (synthetisiert)
  private node<T extends AudioScheduledSourceNode>(n: T, at: number, dur: number): T {
    n.start(at); n.stop(at + dur); this.sources.add(n);
    n.onended = () => this.sources.delete(n);
    return n;
  }
  private noiseBurst(at: number, dur: number, peak: number, freq: number, q: number, dest: AudioNode, type: BiquadFilterType = 'bandpass', attack = 0.005) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f).connect(g).connect(dest);
    this.node(s, at, dur + 0.05);
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    return f;
  }
  private panned(pan: number, ch: Channel): AudioNode {
    const p = this.ctx!.createStereoPanner(); p.pan.value = pan; p.connect(this.bus[ch]!); return p;
  }

  /** Schiedsrichterpfiff: kurz (Foul/Abseits), dezent (Aus/Ecke), lang (Anpfiff), dreifach (Spielende) */
  whistle(kind: 'short' | 'soft' | 'long' | 'final' | 'half') {
    if (!this.active || !this.once('wh' + kind, 600)) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + 0.01;
    const blasts: Array<[number, number]> = kind === 'final' ? [[0, 0.35], [0.5, 0.35], [1.0, 1.1]] : kind === 'half' ? [[0, 0.35], [0.5, 0.9]] : kind === 'long' ? [[0, 0.9]] : [[0, kind === 'soft' ? 0.18 : 0.28]];
    const peak = kind === 'soft' ? 0.07 : 0.16;
    const dest = this.bus.sfx!;
    for (const [off, dur] of blasts) {
      const at = t0 + off;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2950 + Math.random() * 120;
      const trem = ctx.createOscillator(); trem.frequency.value = 28 + Math.random() * 6;
      const tg = ctx.createGain(); tg.gain.value = 120; trem.connect(tg).connect(o.frequency); // „Triller“ der Pfeifenkugel
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.02);
      g.gain.setValueAtTime(peak, at + dur - 0.05); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g).connect(dest);
      this.node(o, at, dur + 0.02); this.node(trem, at, dur + 0.02);
      this.noiseBurst(at, dur, peak * 0.25, 3000, 3, dest);
    }
  }

  /** Aluminium: unharmonische, abklingende Teiltöne (Pfosten/Latte) + Raunen */
  woodwork() {
    if (!this.active || !this.once('wood', 800)) return;
    const ctx = this.ctx!;
    const at = ctx.currentTime + 0.005;
    for (const [f, a, d] of [[523, 0.12, 0.9], [1347, 0.08, 0.6], [2087, 0.05, 0.45], [3311, 0.03, 0.3], [4790, 0.02, 0.2]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (0.98 + Math.random() * 0.04);
      const g = ctx.createGain(); g.gain.setValueAtTime(a, at); g.gain.exponentialRampToValueAtTime(0.0001, at + d);
      o.connect(g).connect(this.bus.sfx!); this.node(o, at, d + 0.02);
    }
    this.noiseBurst(at, 0.05, 0.2, 2500, 1, this.bus.sfx!);
  }

  /** Ball im Netz (Tor) bzw. leiser im Außennetz */
  net(outside = false) {
    if (!this.active || !this.once('net', 700)) return;
    const at = this.ctx!.currentTime + 0.005;
    const f = this.noiseBurst(at, outside ? 0.35 : 0.6, outside ? 0.08 : 0.16, 4200, 0.7, this.bus.sfx!, 'highpass', 0.02);
    f.frequency.setValueAtTime(5500, at); f.frequency.exponentialRampToValueAtTime(1800, at + 0.4);
    this.noiseBurst(at, 0.08, outside ? 0.05 : 0.1, 180, 1, this.bus.sfx!, 'lowpass');
  }

  /** Ballkontakt: dumpfer Schlag (Pass leise, Schuss kräftiger) */
  kick(power: 'pass' | 'shot') {
    if (!this.active || !this.once('kick', 120)) return;
    const ctx = this.ctx!;
    const at = ctx.currentTime + 0.003;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(power === 'shot' ? 170 : 140, at); o.frequency.exponentialRampToValueAtTime(55, at + 0.08);
    const g = ctx.createGain(); const p = power === 'shot' ? 0.22 : 0.06;
    g.gain.setValueAtTime(p, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    o.connect(g).connect(this.bus.sfx!); this.node(o, at, 0.14);
    this.noiseBurst(at, 0.03, p * 0.6, 1500, 0.8, this.bus.sfx!);
  }

  /** Torjubel (Heim: laut, links; Gäste: kleiner, rechts) */
  roar(side: 'home' | 'away', strength = 1) {
    if (!this.active || !this.once('roar' + side, 2000)) return;
    const ctx = this.ctx!;
    const home = side === 'home';
    const dest = this.panned(home ? -0.4 : 0.75, 'reactions');
    const at = ctx.currentTime + 0.02;
    const peak = (home ? 0.55 : 0.14) * this.base * 1.6 * strength;
    const dur = home ? 6.5 : 3.5;
    const s = ctx.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(600, at); f.frequency.linearRampToValueAtTime(1500, at + 0.4); f.frequency.linearRampToValueAtTime(900, at + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.25);
    g.gain.setTargetAtTime(peak * 0.55, at + 1.5, 1.2); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f).connect(g).connect(dest); this.node(s, at, dur + 0.1);
    // Stimmen: viele leicht verstimmte Sägezähne durch „ah“-Formanten
    this.voices(at, dur * 0.7, home ? 14 : 6, peak * 0.22, 'ah', dest, 1.0);
    this.push(1, home ? 7 : 2);
  }

  /** Kollektives „Ooooh“ nach vergebener Großchance / Aluminium */
  ooh() {
    if (!this.active || !this.once('ooh', 2500)) return;
    const at = this.ctx!.currentTime + 0.05;
    this.voices(at, 1.8, 16, 0.16 * this.base * 1.6, 'oo', this.panned(-0.3, 'reactions'), -1);
    this.push(0.75, 1.5);
  }

  /** Pfiffe und empörte Rufe der Heimfans (Foul des Gegners) */
  jeer() {
    if (!this.active || !this.once('jeer', 3500)) return;
    const ctx = this.ctx!;
    const at = ctx.currentTime + 0.05;
    const dest = this.panned(-0.45, 'reactions');
    const n = 9;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(); o.type = 'sine'; const st = at + Math.random() * 0.4; const d = 0.5 + Math.random() * 0.9;
      o.frequency.setValueAtTime(2200 + Math.random() * 1400, st); o.frequency.linearRampToValueAtTime(1800 + Math.random() * 1200, st + d);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.025 * this.base * 1.6, st + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, st + d);
      o.connect(g).connect(dest); this.node(o, st, d + 0.02);
    }
    this.voices(at, 1.2, 8, 0.09 * this.base * 1.6, 'eh', dest, 0.3);
    this.push(0.6, 1);
  }

  /** enttäuschtes Raunen (Gegentor) */
  groan() {
    if (!this.active || !this.once('groan', 3000)) return;
    this.voices(this.ctx!.currentTime + 0.05, 2.2, 10, 0.08 * this.base * 1.6, 'oo', this.panned(-0.4, 'reactions'), -1.5);
  }

  /** Stimmengruppe mit Formanten (Vokal) und Tonhöhenverlauf (glide in Halbtönen) */
  private voices(at: number, dur: number, n: number, peak: number, vowel: 'ah' | 'oo' | 'eh', dest: AudioNode, glide: number) {
    const ctx = this.ctx!;
    const F: Record<string, [number, number]> = { ah: [750, 1150], oo: [380, 850], eh: [550, 1750] };
    const [f1, f2] = F[vowel]!;
    const mix = ctx.createGain(); mix.gain.value = 1;
    const a = ctx.createBiquadFilter(); a.type = 'bandpass'; a.frequency.value = f1; a.Q.value = 4;
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f2; b.Q.value = 5;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.18); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    mix.connect(a).connect(g); mix.connect(b).connect(g); g.connect(dest);
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const base = 110 + Math.random() * 120;
      o.frequency.setValueAtTime(base, at); o.frequency.linearRampToValueAtTime(base * 2 ** (glide / 12) * (0.97 + Math.random() * 0.06), at + dur);
      const og = ctx.createGain(); og.gain.value = 1 / n;
      o.connect(og).connect(mix); this.node(o, at + Math.random() * 0.12, dur);
    }
  }

  // ------------------------------------------------------------------ MP3
  /** MP3 laden, dekodieren, Lautheit bestimmen – je URL nur einmal */
  load(url: string): Promise<{ buffer: AudioBuffer; norm: number } | null> {
    let p = this.cache.get(url);
    if (!p) {
      p = (async () => {
        try {
          const ctx = this.ctx ?? stadiumSound.ctx;
          if (!ctx) return null;
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) return null;
          const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          return { buffer, norm: loudnessGain(buffer) };
        } catch { return null; }
      })();
      this.cache.set(url, p);
      void p.then((r) => { if (!r) this.cache.delete(url); });
    }
    return p;
  }

  /** MP3 weich abspielen (Lautheit angeglichen), optional räumlich; maxSec begrenzt die Länge */
  async play(url: string, o: { channel: Channel; volume?: number; pan?: number; maxSec?: number; fadeIn?: number }): Promise<Track | null> {
    if (!this.active) return null;
    const data = await this.load(url);
    if (!data || !this.active) return null;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = data.buffer;
    const g = ctx.createGain();
    const lvl = Math.min(2.5, data.norm * (o.volume ?? 0.85));
    const at = ctx.currentTime + 0.02;
    const fi = o.fadeIn ?? 0.8;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(Math.max(0.001, lvl), at + fi);
    const p = ctx.createStereoPanner(); p.pan.value = o.pan ?? 0;
    src.connect(g).connect(p).connect(this.bus[o.channel]!);
    src.start(at);
    this.sources.add(src);
    let done = false;
    let resolve!: () => void;
    const ended = new Promise<void>((r) => { resolve = r; });
    const stop = (fade = 1) => {
      if (done) return; done = true;
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, fade));
      try { src.stop(t + Math.max(0.05, fade) + 0.05); } catch { /* bereits beendet */ }
    };
    src.onended = () => { this.sources.delete(src); done = true; resolve(); };
    const len = Math.min(data.buffer.duration, o.maxSec ?? data.buffer.duration);
    if (len < data.buffer.duration) setTimeout(() => stop(1.5), Math.max(0, (len - 1.5) * 1000));
    return { stop, ended, url };
  }

  /** alles sanft ausblenden und anhalten (Abpfiff, Seite verlassen) */
  shutdown(fade = 0.8, generation?: number) {
    if (generation !== undefined && generation !== this.generation) return;
    if (!this.ctx || !this.out) { this.running = false; return; }
    const ctx = this.ctx, out = this.out;
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(Math.max(0.0001, out.gain.value), t); out.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    const srcs = [...this.sources];
    this.sources.clear();
    this.running = false;
    this.bedHome = this.bedAway = null;
    setTimeout(() => {
      for (const s of srcs) { try { s.stop(); } catch { /* bereits beendet */ } }
      try { out.disconnect(); } catch { /* */ }
      // Kontext ruhen lassen, solange kein Spiel läuft (kein Ton im Menü, spart Akku)
      if (!this.running) void ctx.suspend().catch(() => undefined);
    }, fade * 1000 + 100);
    this.out = null; this.duck = null; this.bus = {};
    this.excitement = this.target = 0.2;
  }
}

/** Verstärkung, die eine Aufnahme auf die Ziel-Lautheit bringt (RMS über Stichproben, Spitzen begrenzt) */
export function loudnessGain(buffer: AudioBuffer): number {
  let sum = 0, n = 0, peak = 0;
  const step = Math.max(1, Math.floor(buffer.length / 200_000));
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i += step) { const v = d[i]!; sum += v * v; n++; if (Math.abs(v) > peak) peak = Math.abs(v); }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  if (rms < 1e-4) return 1;
  return Math.max(0.25, Math.min(4, TARGET_RMS / rms, 0.98 / Math.max(peak, 1e-3) * 1.6));
}

export const mixer = new StadiumMixer();
