/**
 * Stadionton eines Spiels: verbindet sichtbare Spielereignisse mit dem Mixer.
 * - Auslöser sind ausschließlich Ereignisse/Zustände, die gerade auf dem Spielfeld zu sehen sind
 *   (gleicher Tick wie die Darstellung) – kein Ereignis löst zweimal aus.
 * - Kulisse: Heim- und Gästefans als getrennte Spuren; Intensität aus der Spielsituation (crowdModel),
 *   30-dB-Bereich mit weichen Übergängen (Angriff, Strafraum, Chance vergeben, Tor, Gegentor, Schlussphase).
 * - Stimmung datengetrieben aus der Fanstimmungs-Matrix (fanMood.ts, 105 Zustände, 26 Ereignisse):
 *   Spielstand × Minute × Ballbesitz/Angriff → Grundpegel und Gesangschancen; Trend statt Sprung.
 * - Fangesänge: hochgeladene MP3 des jeweiligen Vereins (Heim links, Gast rechts); ohne Upload die
 *   bereitgestellten KI-Fangesänge (public/audio/chants/ai). Je Partie nur eine zufällige Teilmenge, Start nur
 *   in Auswahlfenstern (8–12 s) nach Matrix-Chance, keine direkte Wiederholung, Ein-/Ausblenden.
 *   Keine generierten Gesänge, keine Chant-Schleifen.
 * - Ereignisse (Aufnahmen): Anfeuerung bei Angriffen, Aufschrei bei Großchancen, Raunen bei vergebenen Chancen,
 *   Pfiffe gegen den Gegner, Klatschen (Ecke, langer Ballbesitz, Schlussphase), Torjubel bzw. Enttäuschung – geschichtet über Gesang und Rauschen.
 * - Hymne und Signatur-Fangesang nur beim Einlauf; Torhymne nur beim Tor des eigenen Vereins.
 */
import { mixer, type Track } from './audioMixer';
import { CrowdEnvelope, situationOf, type PlayState, type Situation } from './crowdModel';
import { loadCrowdLibrary, type CrowdCategory } from './crowdLibrary';
import { EVENTS, FanScheduler, MoodTrend, levelToIntensity, matchSubset, type MoodRow, type MoodValues } from './fanMood';
import type { AudioRef } from './matchClient';

export interface ChantRef extends AudioRef { signature?: boolean }

/** reguläre Gesänge = alles außer Signatur-Gesang und Torhymne */
export function regularChants(list: ChantRef[]): ChantRef[] {
  return list.filter((c) => !!c.path && !c.signature && c.situation !== 'goal');
}
export function goalHymns(list: ChantRef[]): ChantRef[] {
  return list.filter((c) => !!c.path && c.situation === 'goal');
}
/** nächsten Gesang wählen: zufällig, nicht derselbe wie zuletzt (sofern Alternativen da sind) */
export function pickNext<T extends { id: string }>(list: T[], lastId: string | null, rnd: () => number = Math.random): T | null {
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((c) => c.id !== lastId) : list;
  return pool[Math.floor(rnd() * pool.length)] ?? pool[0]!;
}
/** Pause bis zum nächsten Gesang (Sekunden): 3–8 s, bei Druckphasen kürzer */
export function nextPause(pressure: number, rnd: () => number = Math.random): number {
  const p = Math.max(0, Math.min(1, pressure));
  return (3 + rnd() * 5) * (1 - 0.35 * p);
}

type Ev = { tick: number; type: string; side: 'home' | 'away' | null; xg?: number };
type Side = 'home' | 'away';

/**
 * Rhythmisches Klatschen als situative Reaktion (kein Gesang, keine Dauerschleife):
 * längerer eigener Ballbesitz, knappe Schlussphase.
 */
export function clapTrigger(o: { sit: Situation; side: 'home' | 'away'; ownPossessionSec: number; corner: boolean; sinceLastClap: number }): boolean {
  if (o.sinceLastClap < 25) return false;
  if (o.corner) return true;
  if (o.sit === 'finale') return true;
  return o.side === 'home' && o.ownPossessionSec > 10;
}

/** Gesang einer Partie: hochgeladene MP3 des Vereins oder KI-Fangesang aus dem Pool */
export interface Song { id: string; url: string; volume: number; mood: 'support' | 'taunt' | 'upload'; title?: string }
interface PoolFile { id: string; title: string; file: string; duration: number; mood: 'support' | 'taunt' }

/** KI-Fangesänge (statische Dateien, einmal geladen und vom Browser zwischengespeichert – R16) */
const poolCache = new Map<string, Promise<Song[]>>();
export function loadChantPool(manifestUrl: string): Promise<Song[]> {
  let p = poolCache.get(manifestUrl);
  if (!p) {
    const base = manifestUrl.replace(/[^/]*$/, '');
    p = fetch(manifestUrl, { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((m: { files?: PoolFile[] }) => (m.files ?? []).map((f) => ({ id: f.id, url: base + f.file, volume: 0.85, mood: f.mood, title: f.title })))
      .catch(() => []);
    poolCache.set(manifestUrl, p);
  }
  return p;
}

const DEFAULT_MANIFEST = '/audio/crowd/manifest.json';
const DEFAULT_POOL = '/audio/chants/ai/manifest.json';

export interface MatchSoundOptions {
  /** gleiche Teilmenge der Gesänge auf allen Geräten (z. B. Partie-ID) */
  seed?: string;
  chantPool?: string;
  /** nur Tests: Auswahlfenster verkürzen (1 = 8–12 s) */
  timeScale?: number;
}

export class MatchSound {
  private uploads: Record<Side, ChantRef[]> = { home: [], away: [] };
  private homeGoal: ChantRef[] = [];
  private awayGoal: ChantRef[] = [];
  /** aktive Gesänge dieser Partie je Seite (Teilmenge, R02) */
  songs: Record<Side, Song[]> = { home: [], away: [] };
  private cur: Record<Side, Track | null> = { home: null, away: null };
  private lastSong: Record<Side, string | null> = { home: null, away: null };
  private lastClap: Record<Side, number> = { home: -99, away: -99 };
  private possSince: { side: Side | null; t: number } = { side: null, t: 0 };
  private blockUntil: Record<Side, number> = { home: 0, away: 0 };
  private once = new Set<string>();
  private goalUntil = 0;
  /** zuletzt ein Ereignis mit Priorität ≤ 2 (Gesänge starten dann nicht – R20) */
  private eventUntil = 0;
  private finished = false;
  private started = false;
  private sit: Situation = 'calm';
  private lastAttack: Record<Side, number> = { home: 0, away: 0 };
  private t = 0;
  readonly envelope = new CrowdEnvelope();
  readonly trend = new MoodTrend();
  scheduler: FanScheduler;
  /** zuletzt verwendete Stimmungswerte (Anzeige/Tests) */
  mood: (MoodValues & { row: MoodRow }) | null = null;
  /** nur Tests: Spielstand/Minute vorgeben (z. B. 0:4 in der 60. Minute) */
  forceState: Partial<Pick<PlayState, 'minute' | 'homeScore' | 'awayScore'>> | null = null;
  /** Protokoll gespielter Gesänge/Pfiffe (Tests, Diagnose) */
  readonly played: Array<{ t: number; side: Side; kind: 'chant' | 'whistle'; id?: string; mood?: string; minute: number; score: string }> = [];
  private url: (path: string) => string;
  private manifest: string;
  private opts: MatchSoundOptions;
  /** Bibliothek und Gesänge geladen (Promise für Tests) */
  ready: Promise<void> = Promise.resolve();

  constructor(url: (path: string) => string, manifest = DEFAULT_MANIFEST, opts: MatchSoundOptions = {}) {
    this.url = url; this.manifest = manifest; this.opts = opts;
    this.scheduler = new FanScheduler(Math.random, opts.timeScale ?? 1);
  }

  /**
   * Gesänge des Spiels setzen (aus dem Match-Setup – keine weiteren Datenbankabfragen).
   * Je Seite: hochgeladene MP3 des Vereins (auch auswärts); hat der Verein keine, die KI-Fangesänge.
   * Pro Partie wird davon nur eine zufällige Teilmenge aktiv (auf allen Geräten gleich).
   */
  setChants(home: ChantRef[], away: ChantRef[], _clubs: { home?: string | null; away?: string | null } = {}) {
    this.uploads = { home: regularChants(home), away: regularChants(away) };
    this.homeGoal = goalHymns(home); this.awayGoal = goalHymns(away);
    for (const c of [...this.homeGoal, ...this.awayGoal]) void mixer.load(this.url(c.path!));
    const seed = this.opts.seed ?? String(Math.random());
    const lib = loadCrowdLibrary(this.manifest).then((l) => { mixer.setLibrary(l); });
    const pool = loadChantPool(this.opts.chantPool ?? DEFAULT_POOL).then((ai) => {
      for (const side of ['home', 'away'] as const) {
        const own: Song[] = this.uploads[side].map((c) => ({ id: c.id, url: this.url(c.path!), volume: c.volume, mood: 'upload', title: c.name }));
        this.songs[side] = matchSubset(own.length ? own : ai, `${seed}:${side}`);
        for (const s of this.songs[side]) void mixer.load(s.url); // einmal laden/dekodieren
      }
    });
    this.ready = Promise.all([lib, pool]).then(() => undefined);
  }

  private warm: ReturnType<typeof setInterval> | null = null;
  /** vor dem Anpfiff (Einlauf): Stadionrauschen läuft bereits, Vorfreude-Pegel */
  warmup() {
    if (this.warm || this.started) return;
    mixer.setCrowd(0.55, 0.2);
    this.warm = setInterval(() => {
      if (this.started || this.finished || !mixer.active) { if (this.warm) clearInterval(this.warm); this.warm = null; return; }
      mixer.setCrowd(0.55, 0.2);
    }, 1000);
  }

  begin() { if (this.warm) { clearInterval(this.warm); this.warm = null; } this.started = true; this.finished = false; }

  /** aktuelle Spielsituation (für Anzeige/Tests) */
  get situation(): Situation { return this.sit; }

  /**
   * Je Frame: vergangene Zeit (s) und sichtbarer Spielzustand.
   * Matrix (Spielstand × Minute × Situation) → Grundpegel und Gesangschancen; Ereignisse über die Hüllkurve.
   */
  frame(dt: number, play: PlayState | number) {
    if (!this.started || this.finished || !mixer.active) return;
    this.t += dt;
    let ps: PlayState = typeof play === 'number'
      ? { possession: play > 0.1 ? 'home' : play < 0.1 ? 'away' : null, toGoal: (1 - play) * 65, inBox: play >= 1, forward: 0, minute: 0, homeScore: 0, awayScore: 0 }
      : play;
    if (this.forceState) ps = { ...ps, ...this.forceState };
    const prev = this.sit;
    this.sit = situationOf(ps);
    const m = this.trend.update(dt, ps.minute, ps.homeScore, ps.awayScore, this.sit);
    this.mood = m;
    // Grundpegel aus der Matrix; Strafraumszenen zusätzlich etwas lauter (Ereignisse übersteuern über die Hüllkurve)
    const box: [number, number] = [this.sit === 'home_box' ? 0.12 : 0, this.sit === 'away_box' ? 0.1 : 0];
    const lv = this.envelope.update(dt, [Math.min(1, levelToIntensity(m.homeLevel) + box[0]), Math.min(1, levelToIntensity(m.awayLevel) + box[1])]);
    mixer.setCrowd(lv.home, lv.away);
    this.situational(ps, prev);
    // Auswahlfenster (8–12 s): Gesang/Pfiffe nach Matrix-Chance
    const now = performance.now();
    const busy = now < this.goalUntil || now < this.eventUntil || this.envelope.busy;
    const actions = this.scheduler.step(this.t, {
      busy,
      playing: { home: !!this.cur.home, away: !!this.cur.away },
      blocked: { home: this.t < this.blockUntil.home, away: this.t < this.blockUntil.away },
      hasSongs: { home: this.songs.home.length > 0, away: this.songs.away.length > 0 },
      mood: m,
    });
    for (const a of actions) {
      if (a.kind === 'chant') this.sing(a.side, ps);
      else {
        // Pfiffe statt Gesang (z. B. 0:4 in der 60. Minute)
        void mixer.reaction('whistle', 'home', { maxSec: 4 + Math.random() * 2, cooldownMs: 3000, volume: 0.6 + m.homeWhistle / 250 });
        this.played.push({ t: this.t, side: 'home', kind: 'whistle', minute: ps.minute, score: `${ps.homeScore}:${ps.awayScore}` });
      }
    }
    this.phaseEvents(ps);
  }

  /** Anfeuerung beim Übergang in einen Angriff, Klatschen bei langem Ballbesitz bzw. in der Schlussphase */
  private situational(ps: PlayState, prev: Situation) {
    if (performance.now() < this.goalUntil || this.envelope.busy) return;
    for (const side of ['home', 'away'] as const) {
      const now = this.sit.startsWith(side) && (this.sit.endsWith('attack') || this.sit.endsWith('box'));
      const before = prev.startsWith(side) && (prev.endsWith('attack') || prev.endsWith('box'));
      if (now && !before && this.t - this.lastAttack[side] > 9 && Math.random() < (side === 'home' ? 0.6 : 0.35)) {
        this.lastAttack[side] = this.t;
        void mixer.reaction('attack', side, { maxSec: 6, cooldownMs: 6000, volume: side === 'home' ? 0.9 : 0.8 });
      }
    }
    if (ps.possession && ps.possession !== this.possSince.side) this.possSince = { side: ps.possession, t: this.t };
    for (const side of ['home', 'away'] as const) {
      if (this.cur[side]) continue; // Klatschen nicht über einen laufenden Gesang
      const ownPossessionSec = this.possSince.side === side ? this.t - this.possSince.t : 0;
      const since = (this.t - this.lastClap[side]) * (side === 'away' ? 0.5 : 1);
      if (clapTrigger({ sit: this.sit, side, ownPossessionSec, corner: false, sinceLastClap: since })) this.clap(side);
    }
  }

  /** Zustandsereignisse der Excel: E21 (Heim ≥ 3 zurück ab Minute 60), E22 (knappe Heimführung ab Minute 80) */
  private phaseEvents(ps: PlayState) {
    const d = ps.homeScore - ps.awayScore;
    if (ps.minute >= 60 && d <= -3 && !this.once.has(`E21:${d}`)) {
      this.once.add(`E21:${d}`);
      this.fx('E21', 'home', 'whistle');
      this.silence('home', 1.2);
    }
    if (ps.minute >= 80 && d === 1 && !this.once.has('E22')) { this.once.add('E22'); this.fx('E22', 'home', 'attack'); }
  }

  /** nächsten Gesang einer Seite wählen: zufällig, nicht derselbe wie zuletzt; Spottgesang nur bei eigener Führung */
  private choose(side: Side, ps: PlayState): Song | null {
    const lead = (side === 'home' ? 1 : -1) * (ps.homeScore - ps.awayScore);
    const list = this.songs[side].filter((s) => s.mood !== 'taunt' || lead >= 1);
    return pickNext(list, this.lastSong[side]);
  }

  /** Gesang starten: 0,7–1,2 s einblenden, am natürlichen Ende 1–2 s ausblenden, Rauschen leicht absenken (R08/R09) */
  private sing(side: Side, ps: PlayState) {
    const song = this.choose(side, ps);
    if (!song) return;
    this.lastSong[side] = song.id;
    const placeholder: Track = { stop: () => undefined, ended: Promise.resolve(), url: '' }; // Platzhalter während des Ladens
    this.cur[side] = placeholder;
    this.played.push({ t: this.t, side, kind: 'chant', id: song.id, mood: song.mood, minute: ps.minute, score: `${ps.homeScore}:${ps.awayScore}` });
    const fadeIn = 0.7 + Math.random() * 0.5;
    const p = mixer.play(song.url, { channel: side, volume: song.volume, maxSec: song.mood === 'upload' ? 40 : undefined, fadeIn, fadeOut: 1.5, endFade: 1.5, id: song.id, category: song.mood === 'upload' ? 'upload' : 'chant' });
    void p.then((t) => {
      if (this.cur[side] !== placeholder) { t?.stop(0.3); return; }
      if (!t) { this.cur[side] = null; return; }
      if (this.finished || performance.now() < this.goalUntil) { t.stop(0.3); this.cur[side] = null; return; }
      this.cur[side] = t;
      mixer.chanting(true);
      void t.ended.then(() => {
        if (this.cur[side] !== t) return;
        this.cur[side] = null;
        if (!this.cur.home && !this.cur.away) mixer.chanting(false);
      });
    });
  }

  /** Klatschen (Aufnahme) auf der Ereignisspur */
  private clap(side: Side) {
    this.lastClap[side] = this.t;
    void mixer.reaction('clap', side, { maxSec: 9, cooldownMs: 20000, volume: side === 'home' ? 0.9 : 0.7 });
  }

  private silence(side: Side, fade: number) {
    this.cur[side]?.stop(fade);
    this.cur[side] = null;
    if (!this.cur.home && !this.cur.away) mixer.chanting(false);
  }

  /**
   * Ereignis aus der Excel („Ereignis-Sounds“) abspielen: Pegel 0–100, Dauer, Priorität.
   * Priorität 1–2: laufende Gesänge rasch ducken (R10) und neue Gesänge kurz zurückhalten (R20).
   */
  private fx(id: string, side: Side, cat: CrowdCategory, o: { celebrate?: boolean; block?: number } = {}) {
    const e = EVENTS[id];
    if (!e) return;
    const dur = e.duration;
    void mixer.reaction(cat, side, { volume: e.level / 85, maxSec: Math.max(1.6, dur + 0.8), cooldownMs: 1200, celebrate: o.celebrate });
    if (e.priority <= 2) {
      mixer.duckChants(side, 0.3, { attack: 0.2, hold: dur, release: 1.4 });
      mixer.duckChants(side === 'home' ? 'away' : 'home', 0.6, { attack: 0.25, hold: dur, release: 1.4 });
      this.eventUntil = Math.max(this.eventUntil, performance.now() + (dur + 1.5) * 1000);
    } else if (e.priority === 3) {
      mixer.duckChants(side, 0.6, { attack: 0.3, hold: dur, release: 1.2 });
    }
    if (o.block) this.blockUntil[side] = Math.max(this.blockUntil[side], this.t + o.block);
  }

  /** sichtbares Spielereignis */
  event(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number; ballOutsideNet: boolean }) {
    if (!mixer.active) return;
    if (['goal', 'miss', 'corner', 'foul', 'offside', 'penalty', 'kickoff'].includes(e.type)) this.lastWhistleEvent = performance.now();
    const side = e.side;
    const H = side === 'home';
    const big = (e.xg ?? 0) > 0.12;
    switch (e.type) {
      case 'kickoff':
        mixer.whistle('long');
        // Wiederanstoß nach einem Tor: intensiver Jubel endet vollständig, normale Kulisse kehrt zurück
        if (side) this.endGoal();
        break;
      case 'halftime': mixer.whistle('half'); break;
      case 'fulltime': this.finish(ctx); break;
      case 'goal': this.goal(side ?? 'home'); break;
      // E05–E08: Aluminium kurz vor der Zuschauerreaktion (Pfosten/Latte unterscheidet die Engine nicht)
      case 'woodwork':
        mixer.woodwork();
        if (side) { this.fx(H ? 'E05' : 'E06', side, 'chance'); this.envelope.event(H ? 'home_miss' : 'away_miss'); }
        break;
      // Dribbling/Durchbruch: erwartungsvolles Anfeuern
      case 'chance': if (side) void mixer.reaction('attack', side, { maxSec: 3, cooldownMs: 4000, volume: H ? 0.8 : 0.6 }); break;
      // E03/E04: Großchance vergeben – kollektives „Ooooh“
      case 'save': if (big && side) { this.fx(H ? 'E03' : 'E04', side, 'chance'); this.envelope.event(H ? 'home_miss' : 'away_miss', H ? 2 : undefined); } break;
      case 'miss':
        mixer.whistle('soft');
        if (ctx.ballOutsideNet && side) { mixer.net(true); this.fx('E26', side, 'chance'); }
        else if (big && side) { this.fx(H ? 'E03' : 'E04', side, 'concede'); this.envelope.event(H ? 'home_miss' : 'away_miss', H ? 2 : undefined); }
        break;
      // E09/E10: Foul (side = foulendes Team) – Protest/Pfiffe der Fans des gefoulten Teams
      case 'foul':
        mixer.whistle('short');
        if (side === 'away') this.fx('E09', 'home', 'whistle');
        else if (side === 'home') this.fx('E10', 'away', 'whistle');
        break;
      case 'offside': mixer.whistle('short'); break;
      // E15/E16: Ecke – erwartungsvolles Raunen
      case 'corner': mixer.whistle('soft'); if (side) this.fx(H ? 'E15' : 'E16', side, 'attack'); break;
      // E17/E18: gefährlicher Freistoß
      case 'free_kick': if (side) this.fx(H ? 'E17' : 'E18', side, 'attack'); break;
      // E19/E20: Elfmeter – Anspannung; beim Gäste-Elfmeter pfeifen die Heimfans
      case 'penalty':
        mixer.whistle('short');
        if (H) { this.fx('E19', 'home', 'attack'); mixer.duckChants('both', 0.2, { hold: 4 }); }
        else if (side) this.fx('E20', 'home', 'whistle');
        this.eventUntil = Math.max(this.eventUntil, performance.now() + 6000);
        break;
      // E11–E14: Karten (side = Team des Spielers) – Protest der betroffenen Fans
      case 'yellow': case 'second_yellow': if (side) this.fx(H ? 'E11' : 'E12', side, 'whistle'); break;
      case 'red': if (side) this.fx(H ? 'E13' : 'E14', side, 'whistle', { block: H ? 90 : 20 }); break; // kein euphorischer Heimgesang nach Rot
      // E23: Verletzung – besorgtes Murmeln, kein fröhlicher Gesang während der Behandlung
      case 'injury':
        if (side) { this.silence(side, 1.2); this.fx('E23', side, 'concede', { block: 20 }); }
        break;
      default: break;
    }
  }

  /** Tor: laufenden Gesang ausblenden, Netz, Jubel, Torhymne des Vereins; danach zurück zur Playlist */
  private goalHymn: Track | null = null;

  /**
   * Tor: sofort intensiver Jubel (Heimtor) bzw. Verstummen der Heimfans und Jubel im Gästeblock (Auswärtstor).
   * Die Torhymne des Vereins setzt direkt ein. Alles endet mit dem Wiederanstoß (≈ 4–5 s später).
   */
  private goal(side: 'home' | 'away') {
    mixer.net(false);
    // R10/E01/E02: Tore unterbrechen laufende Gesänge sofort (≈ 0,25 s)
    this.silence('home', 0.25);
    this.silence('away', 0.25);
    this.goalHymn?.stop(0.3);
    this.goalHymn = null;
    this.goalUntil = performance.now() + 7000; // Sicherung, falls kein Wiederanstoß kommt (Schlusspfiff)
    this.envelope.event(side === 'home' ? 'home_goal' : 'away_goal', 7);
    // Aufnahmen: Heimtor = Kurve explodiert; Auswärtstor = Gästeblock kurz sehr laut, Heimfans enttäuscht
    mixer.goal(side);
    const hymn = pickNext(side === 'home' ? this.homeGoal : this.awayGoal, null);
    if (!hymn) return;
    const gen = mixer.generation;
    void mixer.play(this.url(hymn.path!), { channel: 'anthem', volume: hymn.volume * (side === 'home' ? 1 : 0.4 * mixer.awayLevel), pan: side === 'home' ? -0.2 : 0.75, maxSec: 7, fadeIn: 0.3 }).then((t) => {
      if (!t) return;
      // Wiederanstoß bereits erfolgt oder Seite verlassen: nicht nachträglich starten
      if (this.finished || gen !== mixer.generation || performance.now() > this.goalUntil) { t.stop(0.2); return; }
      this.goalHymn = t;
    });
  }

  /** Wiederanstoß: Jubel, Torhymne und Ereignis-Hüllkurve sofort weich beenden */
  private endGoal() {
    mixer.endCelebration(0.6);
    this.goalHymn?.stop(0.6);
    this.goalHymn = null;
    this.envelope.release();
    this.goalUntil = performance.now() + 1500;
  }

  private lastWhistleEvent = 0;
  /** Ballkontakt (Pass/Schuss) – aus der sichtbaren Ballart */
  kick(kind: 'pass' | 'shot') { if (this.started && !this.finished) mixer.kick(kind); }
  /** Ball verlässt das Spielfeld: dezenter Pfiff, aber nicht direkt nach Tor/Fehlschuss (dort pfeift es bereits) */
  outOfPlay() {
    if (!this.started || this.finished) return;
    const now = performance.now();
    if (now < this.goalUntil || now - this.lastWhistleEvent < 2500) return;
    this.lastWhistleEvent = now;
    mixer.whistle('soft');
  }

  /** Abpfiff: Schlusspfiff, E24 Abschlussjubel bzw. E25 Enttäuschung/Pfiffe, danach alles sanft ausblenden */
  finish(ctx?: { homeScore: number; awayScore: number }) {
    if (this.finished) return;
    mixer.whistle('final');
    this.silence('home', 1.5);
    this.silence('away', 1.5);
    if (ctx) {
      const d = ctx.homeScore - ctx.awayScore;
      if (d > 0) this.fx('E24', 'home', 'goal');
      else if (d < 0) this.fx('E25', 'home', d <= -2 ? 'whistle' : 'concede');
    }
    this.finished = true;
    this.envelope.event('home_miss', 3);
    const gen = mixer.generation;
    setTimeout(() => mixer.shutdown(2.5, gen), 4500);
  }

  stop(fade = 0.6) { this.finished = true; this.silence('home', fade); this.silence('away', fade); mixer.shutdown(fade); }
}
