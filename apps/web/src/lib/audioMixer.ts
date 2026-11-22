/**
 * Zentraler Stadion-Audiomixer (Web Audio API), vollständig im Browser.
 *
 * Getrennte Spuren (je mit eigenem Lautstärkeregler):
 *   Stadionrauschen · Heimfans · Gästefans · Fanreaktionen (Ereignisse) · Schiedsrichter & Ball · Hymnen
 *   → Summenbus → Kompressor → Begrenzer (kein Übersteuern) → Lautsprecher.
 *
 * KI-Fans klingen ausschließlich über ECHTE Stadionaufnahmen (crowdLibrary, /audio/crowd/manifest.json):
 * - Stadionrauschen: lange Aufnahmen, abwechselnd mit gleichleistungs-Überblendung (keine Schleifennaht).
 * - Heim-/Gästefans: ausschließlich hochgeladene MP3-Gesänge der jeweiligen Vereine (KI-Vereine ohne Upload: keine Gesänge).
 *   Gästeblock: leiser, rechts, dumpfer und hallender (Entfernung).
 * - Ereignisse: Torjubel, Aufschrei, Pfiffe, Enttäuschung, Klatschen, Anfeuerung – Aufnahmen, über die anderen Spuren geschichtet.
 * Fehlt eine Kategorie, bleibt sie stumm und wird als fehlend gemeldet (missing()). Es gibt KEINE künstlichen
 * Chöre, Melodien oder Musikschleifen. Nur wenn gar keine Rauschaufnahme vorliegt, läuft ein leises,
 * gefiltertes Ersatzrauschen (als „Ersatz“ gekennzeichnet). Schiedsrichterpfiff, Netz, Aluminium und
 * Ballkontakt sind kurze synthetische Effekte (keine Zuschauergeräusche).
 */
import { stadiumSound } from './stadiumSound';
import { intensityGain } from './crowdModel';
import { CROWD_CATEGORIES, Picker, REACTION_SOURCES, crowdStatus, emptyLibrary, urlOf, type CrowdCategory, type CrowdFile, type CrowdLibrary } from './crowdLibrary';
import { PARAMS } from './fanMood';

export type Channel = 'ambience' | 'home' | 'away' | 'events' | 'sfx' | 'anthem';
export const CHANNELS: Array<{ key: Channel; label: string }> = [
  { key: 'ambience', label: 'Stadionrauschen' }, { key: 'home', label: 'Heimfans' }, { key: 'away', label: 'Gästefans' },
  { key: 'events', label: 'Fanreaktionen (Tor, Chancen, Pfiffe)' }, { key: 'sfx', label: 'Schiedsrichter & Ball' },
  { key: 'anthem', label: 'Hymnen & Torhymnen' },
];
const VOL_KEY = 'fd-mixer-volumes';
const DEFAULT_VOL: Record<Channel, number> = { ambience: 0.8, home: 0.85, away: 0.8, events: 0.85, sfx: 0.7, anthem: 0.85 };

export function loadVolumes(): Record<Channel, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(VOL_KEY) ?? '{}') as Record<string, number>;
    // frühere Kanäle übernehmen (Kulisse → Rauschen, Fangesänge → Heim/Gäste, Reaktionen → Ereignisse)
    const old: Partial<Record<Channel, number>> = { ambience: raw.crowd, home: raw.chants, away: raw.chants, events: raw.reactions };
    const out = { ...DEFAULT_VOL };
    for (const c of CHANNELS) { const v = raw[c.key] ?? old[c.key]; if (typeof v === 'number' && v >= 0 && v <= 1) out[c.key] = v; }
    return out;
  } catch { return { ...DEFAULT_VOL }; }
}

export interface Track { stop: (fadeSec?: number) => void; ended: Promise<void>; url: string }

/** Ziel-Lautheit (RMS) für Aufnahmen und hochgeladene MP3 */
const TARGET_RMS = 0.12;
type Decoded = { buffer: AudioBuffer; norm: number };
type Side = 'home' | 'away';

/** Lautstärke je Kategorie (nach Lautheitsangleich) */
const CAT_VOL: Record<CrowdCategory, number> = {
  ambience: 0.75, clap: 0.7, attack: 0.75, chance: 0.85, whistle: 0.6, concede: 0.55, goal: 1, aah: 0.8, ooh: 0.85, uuh: 0.8,
};

export interface PlayOpts {
  channel: Channel; volume?: number; pan?: number; maxSec?: number; fadeIn?: number; fadeOut?: number; offset?: number;
  /** leichte Tonhöhen-/Tempoabweichung für natürliche Abwechslung */
  rate?: number;
  /** Startzeitpunkt im Audiokontext (Offline-Tests) */
  at?: number;
  /** Ereignis endet mit dem Wiederanstoß (endCelebration) */
  celebrate?: boolean;
  /** Ereignisspur: Seite (Heim links/präsent, Gäste rechts/entfernt) */
  side?: Side;
  id?: string;
  category?: CrowdCategory | 'upload' | 'chant';
  /** am natürlichen Dateiende ausblenden (Sekunden) – R09 */
  endFade?: number;
}

export class StadiumMixer {
  private ctx: BaseAudioContext | null = null;
  /** Offline-Kontext (Hörbarkeitsprüfung): immer aktiv */
  private offline = false;
  private awayScale = 1;
  private lastCrowd: [number, number] = [-1, -1];
  private out: GainNode | null = null;
  private bus: Partial<Record<Channel, GainNode>> = {};
  private duck: GainNode | null = null;
  /** Eingänge der Spuren (vor Pegel/Klangfärbung) */
  private input: Partial<Record<'ambience' | 'home' | 'away' | 'eventsHome' | 'eventsAway', AudioNode>> = {};
  /** Intensitätsgesteuerte Pegel je Spur */
  private lvl: Partial<Record<'ambience' | 'home' | 'away', GainNode>> = {};
  /** Ducking der Fangesänge je Seite (Ereignisse haben Vorrang) und leichte Absenkung des Rauschens beim Singen */
  private duckSide: Partial<Record<Side, GainNode>> = {};
  private ambDuck: GainNode | null = null;
  private chantingOn = false;
  private noise: AudioBuffer | null = null;
  private bedMaster: GainNode | null = null;
  private bedHome: { g: GainNode; f: BiquadFilterNode } | null = null;
  private bedAway: { g: GainNode; f: BiquadFilterNode } | null = null;
  private sources = new Set<AudioScheduledSourceNode>();
  private cache = new Map<string, Promise<Decoded | null>>();
  private ready = new Map<string, Decoded>();
  private volumes = loadVolumes();
  private running = false;
  private base = 0.5;
  private lastFx = new Map<string, number>();
  private lib: CrowdLibrary = emptyLibrary();
  private picker = new Picker();
  /** Stadionrauschen: nächster Überblendzeitpunkt, aktuelle Datei, echte Aufnahme aktiv? */
  private ambNext = 0;
  private ambId: string | null = null;
  private ambSample = false;
  private celebration: Array<{ stop: (f?: number) => void }> = [];
  /** laufende Dateien (Diagnose: welche Aufnahme läuft auf welcher Spur) */
  private playing = new Set<{ url: string; channel: Channel; id?: string; category?: string; side?: Side }>();
  /** Verlauf gespielter Aufnahmen (Diagnose/Tests: keine identischen Wiederholungen) */
  history: Array<{ id: string; channel: Channel; category?: string; t: number }> = [];
  /** Anzahl ausgelöster Torjubel (Diagnose/Tests) */
  roars = 0;
  /** zählt Starts; verspätete Abschaltungen eines alten Spiels betreffen kein neues */
  generation = 0;

  get active(): boolean { return this.running && !!this.ctx && (this.offline || this.ctx.state === 'running'); }

  /** Start für ein Spiel (nach Nutzeraktion bzw. wenn der Browser es erlaubt). Mehrfachaufrufe sind harmlos. */
  async start(opts: { attendance: number; capacity: number; importance: number; awayShare?: number }): Promise<boolean> {
    const ok = await stadiumSound.unlock();
    if (!ok || !stadiumSound.ctx) return false;
    const ctx = stadiumSound.ctx;
    if (this.running && this.ctx === ctx) { this.configure(opts); return true; }
    this.setup(ctx, opts);
    return true;
  }

  /** Für Tests: Mixer an einen (Offline-)Kontext hängen */
  attach(ctx: BaseAudioContext, opts: { attendance: number; capacity: number; importance: number; awayShare?: number }) {
    this.offline = true;
    this.setup(ctx, opts);
  }

  private setup(ctx: BaseAudioContext, opts: { attendance: number; capacity: number; importance: number; awayShare?: number }) {
    this.ctx = ctx;
    this.generation++;
    // Summenbus: Kompressor (Dichte) + Begrenzer (verhindert Übersteuern beim Schichten mehrerer Aufnahmen)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.006; comp.release.value = 0.3;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    this.out = ctx.createGain(); this.out.gain.value = 0;
    // Sicherheits-Sättigung: unterhalb ±0,7 linear, darüber weich bis höchstens ±0,98 (kein digitales Clipping)
    const safe = ctx.createWaveShaper(); safe.curve = softClip(); safe.oversample = '2x';
    this.out.connect(comp).connect(lim).connect(safe).connect(ctx.destination);
    this.out.gain.setTargetAtTime(0.85, ctx.currentTime, 0.4);
    this.duck = ctx.createGain(); this.duck.connect(this.out);
    for (const c of CHANNELS) {
      const g = ctx.createGain(); g.gain.value = this.volumes[c.key];
      g.connect(c.key === 'ambience' || c.key === 'home' || c.key === 'away' ? this.duck : this.out);
      this.bus[c.key] = g;
    }
    // Stadionakustik: kurzer, diffuser Raumhall (Impulsantwort einmal berechnet) – Gästeblock hallt stärker
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 1.7);
    const verbRet = ctx.createGain(); verbRet.gain.value = 0.5;
    verb.connect(verbRet).connect(this.duck);
    const send = (from: AudioNode, amount: number) => { const s = ctx.createGain(); s.gain.value = amount; from.connect(s).connect(verb); };

    // Stadionrauschen
    this.lvl.ambience = ctx.createGain(); this.lvl.ambience.gain.value = 0;
    this.ambDuck = ctx.createGain(); this.ambDuck.gain.value = 1;
    this.lvl.ambience.connect(this.ambDuck).connect(this.bus.ambience!);
    this.chantingOn = false;
    this.input.ambience = this.lvl.ambience;
    // Heimfans: präsent, links/mittig
    this.lvl.home = ctx.createGain(); this.lvl.home.gain.value = 0.6;
    const hp = ctx.createStereoPanner(); hp.pan.value = -0.25;
    this.duckSide.home = ctx.createGain();
    this.lvl.home.connect(this.duckSide.home).connect(hp).connect(this.bus.home!);
    send(this.lvl.home, 0.12);
    this.input.home = this.lvl.home;
    // Gästefans: rechts, entfernt (Höhen gedämpft, mehr Hall)
    this.lvl.away = ctx.createGain(); this.lvl.away.gain.value = 0.3;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600; lp.Q.value = 0.5;
    const ap = ctx.createStereoPanner(); ap.pan.value = 0.7;
    this.duckSide.away = ctx.createGain();
    this.lvl.away.connect(this.duckSide.away).connect(lp).connect(ap).connect(this.bus.away!);
    send(lp, 0.35);
    this.input.away = this.lvl.away;
    // Ereignisse je Seite
    const eh = ctx.createStereoPanner(); eh.pan.value = -0.3; eh.connect(this.bus.events!); send(eh, 0.12);
    const elp = ctx.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 5000;
    const ea = ctx.createStereoPanner(); ea.pan.value = 0.7; elp.connect(ea).connect(this.bus.events!); send(elp, 0.3);
    this.input.eventsHome = eh; this.input.eventsAway = elp;

    // Ersatzrauschen (nur ohne Rauschaufnahme; gefiltertes Rauschen, keine Töne)
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = this.noise.getChannelData(ch); let b = 0; for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.25; } }
    this.bedMaster = ctx.createGain(); this.bedMaster.gain.value = 1; this.bedMaster.connect(this.bus.ambience!);
    this.bedHome = this.makeBed(-0.55, 650);
    this.bedAway = this.makeBed(0.7, 800);
    this.running = true;
    this.lastCrowd = [-1, -1];
    this.ambNext = 0; this.ambId = null; this.ambSample = false;
    this.history = [];
    this.configure(opts);
  }

  private makeBed(pan: number, freq: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.bedMaster!);
    src.start(ctx.currentTime, Math.random() * 2);
    this.sources.add(src);
    return { g, f };
  }

  private configure(o: { attendance: number; capacity: number; importance: number; awayShare?: number }) {
    const fill = Math.max(0, Math.min(1, o.attendance / Math.max(1, o.capacity)));
    const size = Math.min(1, Math.log10(Math.max(1000, o.attendance)) / 4.9);
    this.base = (0.25 + 0.5 * fill * size) * (0.85 + 0.3 * o.importance);
    // Gästeblock: Anteil der Zuschauer (Standard 8 %) bestimmt, wie laut die Gäste werden können
    this.awayScale = Math.max(0.5, Math.min(1.6, Math.sqrt((o.awayShare ?? 0.08) / 0.08)));
  }

  // ------------------------------------------------------------------ Bibliothek
  setLibrary(lib: CrowdLibrary) {
    this.lib = lib;
    // Rauschaufnahmen sofort laden (lang, werden zuerst gebraucht)
    for (const f of lib.byCategory.get('ambience') ?? []) void this.load(urlOf(lib, f));
  }
  get library(): CrowdLibrary { return this.lib; }
  /** Kategorien ohne Aufnahme (bleiben stumm – werden in der Tonanzeige genannt) */
  missing(): CrowdCategory[] { return crowdStatus(this.lib).filter((c) => c.missing).map((c) => c.key); }
  has(cat: CrowdCategory): boolean { return (this.lib.byCategory.get(cat)?.length ?? 0) > 0; }
  pick(cats: CrowdCategory[] | Array<[CrowdCategory, number]>, key: string, avoid: string[] = []): CrowdFile | null {
    return this.picker.pick(this.lib, cats, key, avoid);
  }
  urlOf(f: CrowdFile) { return urlOf(this.lib, f); }

  /** Für Tests: dekodierte Aufnahme direkt hinterlegen */
  preload(url: string, buffer: AudioBuffer) {
    const d = { buffer, norm: loudnessGain(buffer) };
    this.cache.set(url, Promise.resolve(d)); this.ready.set(url, d);
  }

  /**
   * Heim- und Gästefans getrennt steuern (Intensität 0…1 aus crowdModel, je Frame).
   * - Stadionrauschen trägt die große Dynamik (30-dB-Bereich): ruhige Phase deutlich leiser als Strafraumszene.
   * - Heim-/Gästespur (Gesänge, Klatschen) folgen enger (12 dB): Gesänge bleiben verständlich,
   *   verstummen aber nach einem Gegentor; der Gästeblock skaliert mit seiner Größe.
   */
  setCrowd(home: number, away: number, at?: number) {
    if (!this.active || !this.ctx) return;
    const now = at ?? this.ctx.currentTime;
    this.pumpAmbience(now);
    if (Math.abs(home - this.lastCrowd[0]) < 0.004 && Math.abs(away - this.lastCrowd[1]) < 0.004) return;
    this.lastCrowd = [home, away];
    const ramp = (p: AudioParam, v: number) => { p.linearRampToValueAtTime(v, now + 0.12); };
    const mix = Math.max(home, Math.min(1, away * 0.9 * this.awayScale));
    if (this.lvl.ambience) ramp(this.lvl.ambience.gain, this.base * 1.3 * intensityGain(0.15 + 0.85 * mix));
    if (this.lvl.home) ramp(this.lvl.home.gain, Math.min(1.4, this.base * 1.6) * 10 ** ((-12 + 12 * Math.min(1, home / 0.65)) / 20));
    // Gästeblock: höchstens 70 % des Heimpegels (Audio-Parameter), auch bei großem Gästeanteil
    if (this.lvl.away) ramp(this.lvl.away.gain, Math.min(1.4, this.base * 1.6) * Math.min(PARAMS.awayCapPercent / 100, 0.5 * this.awayScale) * 10 ** ((-12 + 12 * Math.min(1, away / 0.5)) / 20));
    if (this.bedHome && this.bedAway) {
      ramp(this.bedHome.g.gain, this.base * 0.95 * intensityGain(home));
      ramp(this.bedHome.f.frequency, 480 + 1000 * home);
      ramp(this.bedAway.g.gain, this.base * 0.95 * this.awayScale * intensityGain(away));
      ramp(this.bedAway.f.frequency, 520 + 900 * away);
    }
  }

  /** Stadionrauschen: verschiedene Aufnahmen bzw. Abschnitte, gleichleistungs-Überblendung (4 s), keine Naht */
  private pumpAmbience(now: number) {
    const files = this.lib.byCategory.get('ambience');
    if (!files?.length || !this.ctx || !this.input.ambience) return;
    if (this.ambSample && now + 3 < this.ambNext) return;
    const f = this.pick(['ambience'], 'ambience', this.ambId ? [this.ambId] : []);
    if (!f) return;
    const url = this.urlOf(f);
    const data = this.ready.get(url);
    if (!data) { void this.load(url); return; }
    const ctx = this.ctx;
    const first = !this.ambSample;
    const at = first ? now + 0.05 : Math.max(now, this.ambNext);
    const XF = 4; // Überblenddauer zwischen zwei Aufnahmen
    const xfIn = first ? 2 : XF;
    const dur = data.buffer.duration;
    const seg = Math.min(dur, 35 + Math.random() * 45);
    const offset = dur > seg + 1 ? Math.random() * (dur - seg) : 0;
    const src = ctx.createBufferSource(); src.buffer = data.buffer;
    src.playbackRate.value = 0.98 + Math.random() * 0.04;
    const g = ctx.createGain(); g.gain.value = 0;
    const v = Math.min(2.5, data.norm * CAT_VOL.ambience * (f.gain ?? 1));
    const len = seg / src.playbackRate.value;
    g.gain.setValueCurveAtTime(curve(v, true), at, xfIn);
    g.gain.setValueCurveAtTime(curve(v, false), at + len - XF, XF);
    src.connect(g).connect(this.input.ambience);
    src.start(at, offset, seg);
    this.track(src, { url, channel: 'ambience', id: f.id, category: 'ambience' }, at);
    this.ambNext = at + len - XF;
    this.ambId = f.id;
    if (first) {
      this.ambSample = true;
      // Ersatzrauschen weich aus
      if (this.bedMaster) { this.bedMaster.gain.setValueAtTime(1, at); this.bedMaster.gain.linearRampToValueAtTime(0, at + 3); }
    }
  }

  /**
   * Laufenden Gesang einer Seite rasch ducken (R10: 0,15–0,35 s), kurz halten, dann weich zurück.
   * depth 0…1 (Restpegel); für Tore wird der Gesang stattdessen gestoppt.
   */
  duckChants(side: Side | 'both', depth: number, o: { attack?: number; hold?: number; release?: number } = {}) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const a = o.attack ?? 0.25, h = o.hold ?? 1.5, r = o.release ?? 1.2;
    for (const sd of side === 'both' ? (['home', 'away'] as const) : [side]) {
      const g = this.duckSide[sd]?.gain;
      if (!g) continue;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(Math.max(0.05, Math.min(1, depth)), now + a);
      g.setValueAtTime(Math.max(0.05, Math.min(1, depth)), now + a + h);
      g.linearRampToValueAtTime(1, now + a + h + r);
    }
  }

  /** R08/R09: Während Fangesängen das Stadionrauschen leicht absenken (≈ −1,7 dB), danach sanft zurück */
  chanting(on: boolean) {
    if (!this.ctx || !this.ambDuck || on === this.chantingOn) return;
    this.chantingOn = on;
    const g = this.ambDuck.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(on ? 0.82 : 1, now + (on ? 1 : 1.8));
  }

  /** Lautstärkefaktor der Gästefans (Gästeblock) – für Gesänge */
  get awayLevel(): number { return this.awayScale; }

  setVolume(c: Channel, v: number) {
    this.volumes[c] = v;
    try { localStorage.setItem(VOL_KEY, JSON.stringify(this.volumes)); } catch { /* privat */ }
    const g = this.bus[c];
    if (g && this.ctx) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }
  getVolumes() { return { ...this.volumes }; }

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

  // ------------------------------------------------------------------ Fanreaktionen (Aufnahmen)
  /**
   * Aufnahme einer Kategorie auf der Ereignisspur einer Seite abspielen (geschichtet über Gesänge/Rauschen).
   * Ohne passende Aufnahme: nichts (kein Ersatzklang).
   */
  reaction(cat: CrowdCategory, side: Side, o: { volume?: number; maxSec?: number; celebrate?: boolean; cooldownMs?: number; at?: number } = {}): Promise<Track | null> {
    if (!this.active || !this.once(`r:${cat}:${side}`, o.cooldownMs ?? 1500)) return Promise.resolve(null);
    const f = this.pick([cat], `ev:${cat}`);
    if (!f) return Promise.resolve(null);
    if (cat === 'goal') this.roars++;
    const away = side === 'away';
    return this.play(this.urlOf(f), {
      channel: 'events', side, id: f.id, category: cat, at: o.at,
      volume: (o.volume ?? 1) * CAT_VOL[cat] * (f.gain ?? 1) * (away ? Math.min(PARAMS.awayCapPercent / 100, 0.75 * this.awayScale) : 1) * Math.min(1.3, this.base * 1.6),
      maxSec: o.maxSec, celebrate: o.celebrate, fadeIn: cat === 'goal' || cat === 'chance' || cat === 'ooh' || cat === 'aah' || cat === 'uuh' ? 0.04 : 0.2,
      fadeOut: Math.min(0.8, (o.maxSec ?? 3) * 0.35),
      rate: 0.97 + Math.random() * 0.06,
    });
  }

  /** Crowd-Reaktion der Matrix V2 (Klatschen, Pfeifen, Ah, Oh, Uh) – echte Aufnahme der Kategorie bzw. nächstverwandte */
  crowdReaction(kind: keyof typeof REACTION_SOURCES, side: Side, o: { volume?: number; maxSec?: number; celebrate?: boolean; at?: number } = {}): Promise<Track | null> {
    const cat = REACTION_SOURCES[kind]?.find((c) => this.has(c));
    if (!cat) return Promise.resolve(null);
    return this.reaction(cat, side, { ...o, cooldownMs: 0 });
  }

  /** Torjubel (höchstens 4,5 s laut Parametern, endet spätestens beim Wiederanstoß); Gästeblock kurz sehr laut */
  goal(side: Side) {
    if (!this.active) return;
    if (side === 'home') void this.reaction('goal', 'home', { celebrate: true, maxSec: PARAMS.goalMax + 1 });
    else void this.reaction('goal', 'away', { celebrate: true, maxSec: PARAMS.goalMax, volume: 1.25 });
  }

  /** Wiederanstoß: laufenden Torjubel sofort weich beenden (keine überlappenden Jubel) */
  endCelebration(fade = 0.4) {
    const list = this.celebration; this.celebration = [];
    for (const t of list) t.stop(fade);
  }

  /** Diagnose für Tests (keine Wirkung auf den Klang) */
  debug() {
    const by = (c: Channel) => [...this.playing].filter((p) => p.channel === c).map((p) => p.url);
    const ids = (c: Channel) => [...this.playing].filter((p) => p.channel === c).map((p) => `${p.category ?? ''}:${p.id ?? p.url}`);
    return {
      sources: this.sources.size, celebrating: this.celebration.length, roars: this.roars, active: this.active,
      crowd: this.lastCrowd.slice() as [number, number], anthem: by('anthem'),
      chants: [...by('home'), ...by('away')],
      tracks: { ambience: ids('ambience'), home: ids('home'), away: ids('away'), events: ids('events') },
      ambienceSample: this.ambSample, missing: this.missing(),
      duck: { home: this.duckSide.home?.gain.value ?? 1, away: this.duckSide.away?.gain.value ?? 1, ambience: this.ambDuck?.gain.value ?? 1 },
      history: this.history.slice(-300),
      library: Object.fromEntries(CROWD_CATEGORIES.map((c) => [c.key, this.lib.byCategory.get(c.key)?.length ?? 0])),
    };
  }

  // ------------------------------------------------------------------ Schiedsrichter & Ball (synthetisch)
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

  /** Aluminium: unharmonische, abklingende Teiltöne (Pfosten/Latte) */
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

  // ------------------------------------------------------------------ Dateien
  /** MP3 laden, dekodieren, Lautheit bestimmen – je URL nur einmal */
  load(url: string): Promise<Decoded | null> {
    let p = this.cache.get(url);
    if (!p) {
      p = (async () => {
        try {
          const ctx = this.ctx ?? stadiumSound.ctx;
          if (!ctx) return null;
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) return null;
          const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          const d = { buffer, norm: loudnessGain(buffer) };
          this.ready.set(url, d);
          return d;
        } catch { return null; }
      })();
      this.cache.set(url, p);
      void p.then((r) => { if (!r) this.cache.delete(url); });
    }
    return p;
  }

  private destOf(o: PlayOpts): AudioNode {
    if (o.channel === 'home' || o.channel === 'away' || o.channel === 'ambience') return this.input[o.channel]!;
    if (o.channel === 'events') return o.side === 'away' ? this.input.eventsAway! : this.input.eventsHome!;
    return this.bus[o.channel]!;
  }

  private track(src: AudioBufferSourceNode, entry: { url: string; channel: Channel; id?: string; category?: string; side?: Side }, at: number) {
    this.sources.add(src);
    this.playing.add(entry);
    if (entry.id) this.history.push({ id: entry.id, channel: entry.channel, category: entry.category, t: at });
    if (this.history.length > 600) this.history.splice(0, 300);
    src.onended = () => { this.sources.delete(src); this.playing.delete(entry); };
    return entry;
  }

  /** Datei weich abspielen (Lautheit angeglichen), auf einer Spur; maxSec begrenzt die Länge */
  async play(url: string, o: PlayOpts): Promise<Track | null> {
    if (!this.active) return null;
    const gen = this.generation;
    const data = this.ready.get(url) ?? await this.load(url);
    if (!data || !this.active || gen !== this.generation) return null;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = data.buffer;
    const rate = Math.max(0.9, Math.min(1.1, o.rate ?? 1));
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const lvl = Math.max(0.001, Math.min(2.5, data.norm * (o.volume ?? 0.85)));
    const at = o.at ?? ctx.currentTime + 0.02;
    const fi = Math.max(0.02, o.fadeIn ?? 0.8);
    // längere Blenden linear (gleichmäßig hörbar), kurze Einsätze exponentiell (knackfrei, direkt)
    if (fi >= 0.3) { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(lvl, at + fi); }
    else { g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(lvl, at + fi); }
    let dest = this.destOf(o);
    if (o.pan) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; p.connect(dest); dest = p; }
    src.connect(g).connect(dest);
    // Einstieg mitten in der Datei (z. B. später beigetretener Manager: Hymne synchron zu allen)
    const offset = Math.max(0, o.offset ?? 0);
    if (offset >= data.buffer.duration - 0.2) return null;
    src.start(at, offset);
    const entry = this.track(src, { url, channel: o.channel, id: o.id, category: o.category, side: o.side }, at);
    let done = false;
    let resolve!: () => void;
    const ended = new Promise<void>((r) => { resolve = r; });
    const stop = (fade = 1) => {
      if (done) return; done = true;
      this.playing.delete(entry);
      this.celebration = this.celebration.filter((x) => x !== handle);
      const t = Math.max(ctx.currentTime, at);
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t); g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, fade));
      try { src.stop(t + Math.max(0.05, fade) + 0.05); } catch { /* bereits beendet */ }
    };
    const handle = { stop };
    src.onended = () => {
      this.sources.delete(src); this.playing.delete(entry); done = true;
      this.celebration = this.celebration.filter((x) => x !== handle);
      resolve();
    };
    if (o.celebrate) this.celebration.push(handle);
    const rest = (data.buffer.duration - offset) / rate;
    const len = Math.min(rest, o.maxSec ?? rest);
    const fo = len < rest ? o.fadeOut ?? 1.5 : Math.min(o.endFade ?? 0, len / 3);
    if (len < rest || fo > 0) {
      // Ende geplant ausblenden (kein harter Schnitt)
      const endAt = at + len;
      g.gain.setValueAtTime(lvl, Math.max(at + fi, endAt - fo));
      if (fo >= 0.5) g.gain.linearRampToValueAtTime(0, endAt);
      else g.gain.exponentialRampToValueAtTime(0.0001, endAt);
      try { src.stop(endAt + 0.05); } catch { /* */ }
    }
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
    this.playing.clear();
    this.celebration = [];
    this.running = false;
    this.bedHome = this.bedAway = null;
    this.generation++;
    setTimeout(() => {
      for (const s of srcs) { try { s.stop(); } catch { /* bereits beendet */ } }
      try { out.disconnect(); } catch { /* */ }
      // Kontext ruhen lassen, solange kein Spiel läuft (kein Ton im Menü, spart Akku)
      if (!this.running && !this.offline && 'suspend' in ctx) void (ctx as AudioContext).suspend().catch(() => undefined);
    }, fade * 1000 + 100);
    this.out = null; this.duck = null; this.bus = {}; this.input = {}; this.lvl = {}; this.bedMaster = null;
    this.duckSide = {}; this.ambDuck = null; this.chantingOn = false;
    this.ambSample = false; this.ambId = null; this.ambNext = 0;
  }
}

/** gleichleistungs-Blendkurve (sin/cos), damit sich überlappende Aufnahmen nicht zu einem Loch/Buckel addieren */
function curve(v: number, up: boolean): Float32Array {
  const n = 48, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1); c[i] = Math.max(0.0001, v * (up ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2))); }
  return c;
}

let clipCurve: Float32Array<ArrayBuffer> | null = null;
function softClip(): Float32Array<ArrayBuffer> {
  if (clipCurve) return clipCurve;
  // Obergrenze = Audio-Peak-Limiter aus den Parametern (0,9)
  const lim = Math.min(0.99, PARAMS.peakLimit), n = 4096, c = new Float32Array(n), k = lim * 0.7, h = lim - k;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= k ? a : k + h * Math.tanh((a - k) / h));
  }
  return (clipCurve = c);
}

/** diffuse Raum-Impulsantwort (Stadion: früher Abfall, kurzer Nachhall) */
function impulse(ctx: BaseAudioContext, sec: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * sec);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) { const t = i / ctx.sampleRate; d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 4.2) * (t < 0.012 ? t / 0.012 : 1) * 0.35; }
  }
  return b;
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
