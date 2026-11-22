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
import { buildLibrary, loadCrowdLibrary, type CrowdCategory, type CrowdFile, type CrowdLibrary } from './crowdLibrary';
import { HomeDisapproval, type Disapproval } from './homeDisapproval';
import { EVENTS, FanScheduler, MoodTrend, PARAMS, aiMatchSubset, levelToIntensity, matchSubset, pickEventReaction, type CrowdRule, type CrowdTrigger, type MoodRow, type MoodValues, type ReactionKind } from './fanMood';
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

/**
 * Vom Liga-Host verwaltete KI-Audiodatei (Tabelle world_ai_audio, Storage „world-audio“, signierte URL).
 * chant = Fangesang der KI-Vereine, boo = Pfiffe/Buhrufe der Heimfans, goal = Torjubel.
 */
export interface HostAudioFile { id: string; category: 'chant' | 'boo' | 'goal'; name: string; url: string; duration: number }

/** Host-Dateien als Stadionaufnahmen: Pfiffe ⇒ pfiff (kurz geschnitten) und – ab 6 s – pfeifkonzert; Torjubel ⇒ goal */
export function hostCrowdFiles(files: HostAudioFile[]): CrowdFile[] {
  const out: CrowdFile[] = [];
  for (const f of files) {
    if (!(f.duration > 0) || !f.url) continue;
    if (f.category === 'boo') {
      out.push({ id: `${f.id}:kurz`, category: 'pfiff', file: f.url, duration: f.duration, credit: f.name });
      if (f.duration >= 6) out.push({ id: `${f.id}:lang`, category: 'pfeifkonzert', file: f.url, duration: f.duration, credit: f.name });
    } else if (f.category === 'goal') out.push({ id: f.id, category: 'goal', file: f.url, duration: f.duration, credit: f.name });
  }
  return out;
}

/** feste Bibliothek (Stadionrauschen) + Host-Dateien; Kategorien des Hosts ersetzen gleichnamige feste Aufnahmen */
export function mergeHostLibrary(lib: CrowdLibrary, files: HostAudioFile[]): CrowdLibrary {
  const host = hostCrowdFiles(files);
  const cats = new Set(host.map((f) => f.category));
  return buildLibrary(lib.base, [...lib.files.filter((f) => !cats.has(f.category)), ...host]);
}

/** KI-Fangesangpool aus den Host-Dateien (gleiche Reihenfolge auf allen Geräten ⇒ gleiche Auswahl je Partie) */
export function hostChantPool(files: HostAudioFile[]): Song[] {
  return files.filter((f) => f.category === 'chant' && f.url).sort((a, b) => a.id.localeCompare(b.id))
    .map((f) => ({ id: f.id, url: f.url, volume: 0.85, mood: 'support' as const, title: f.name }));
}

export interface MatchSoundOptions {
  /** gleiche Teilmenge der Gesänge auf allen Geräten (z. B. Partie-ID) */
  seed?: string;
  /** KI-Audiodateien der Liga (vom Host verwaltet); ohne Dateien bleibt nur die Stadion-Grundatmosphäre */
  hostAudio?: Promise<HostAudioFile[]>;
  /** nur Tests: statischer Gesangspool statt Host-Dateien */
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
  private blockUntil: Record<Side, number> = { home: 0, away: 0 };
  private once = new Set<string>();
  private goalUntil = 0;
  /** zuletzt ein Ereignis mit Priorität ≤ 2 (Gesänge starten dann nicht – R20) */
  private eventUntil = 0;
  private finished = false;
  private started = false;
  private sit: Situation = 'calm';
  private t = 0;
  readonly envelope = new CrowdEnvelope();
  readonly trend = new MoodTrend();
  scheduler: FanScheduler;
  /** zuletzt verwendete Stimmungswerte (Anzeige/Tests) */
  mood: (MoodValues & { row: MoodRow }) | null = null;
  /** nur Tests: Spielstand/Minute vorgeben (z. B. 0:4 in der 60. Minute) */
  forceState: Partial<Pick<PlayState, 'minute' | 'homeScore' | 'awayScore'>> | null = null;
  /** Protokoll gespielter Gesänge/Pfiffe (Tests, Diagnose) */
  readonly played: Array<{ t: number; side: Side; kind: 'chant' | 'reaction'; id?: string; mood?: string; reaction?: string; minute: number; score: string }> = [];
  private ps: PlayState | null = null;
  /** Unmut je Fangruppe (0…1): steigt bei Gegentoren und vergebenen Chancen im Rückstand, klingt langsam ab */
  frustration: Record<Side, number> = { home: 0, away: 0 };
  private curSong: Record<Side, string | null> = { home: null, away: null };
  private lastBox: Record<Side, number> = { home: -99, away: -99 };
  /** Unmut der Heimfans (Pfiffe/Pfeifkonzerte, nur die Aufnahmen der Kategorien pfiff/pfeifkonzert) */
  readonly disapproval = new HomeDisapproval();
  private lastPoss: 'home' | 'away' | null = null;
  private homeToGoal = 50;
  private lastOwnLoss = -99;
  private pendingFoul: { tick: number; t: number; hard: boolean; penalty: boolean } | null = null;
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
    const host = (this.opts.hostAudio ?? Promise.resolve([] as HostAudioFile[])).catch(() => [] as HostAudioFile[]);
    const lib = Promise.all([loadCrowdLibrary(this.manifest), host]).then(([l, h]) => { mixer.setLibrary(mergeHostLibrary(l, h)); });
    const aiPool = this.opts.chantPool ? loadChantPool(this.opts.chantPool) : host.then(hostChantPool);
    const pool = aiPool.then((ai) => {
      for (const side of ['home', 'away'] as const) {
        const own: Song[] = this.uploads[side].map((c) => ({ id: c.id, url: this.url(c.path!), volume: c.volume, mood: 'upload', title: c.name }));
        // eigene Uploads: wie bisher; KI-Fanlager: 2–4 Gesänge aus dem ganzen KI-Pool, möglichst ohne die des Gegners
        this.songs[side] = own.length ? matchSubset(own, `${seed}:${side}`)
          : aiMatchSubset(ai, `${seed}:${side}`, side === 'away' ? this.songs.home.map((s) => s.id) : []);
        for (const s of this.songs[side]) void mixer.load(s.url); // nur die ausgewählten Dateien laden/dekodieren
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
  /** Audiozeit in Sekunden (Tests/Diagnose) */
  get time(): number { return this.t; }

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
    this.ps = ps;
    for (const sd of ['home', 'away'] as const) this.frustration[sd] = Math.max(0, this.frustration[sd] - dt / 240);
    this.watchHome(ps, prev, dt);
    // „Ahhh“ bei gefährlichen Angriffen: Ball kommt in den Strafraum – Heimfans reagieren stärker
    for (const sd of ['home', 'away'] as const) {
      const box = this.sit === `${sd}_box`, before = prev === `${sd}_box`;
      if (box && !before && this.t - this.lastBox[sd] > 8 && performance.now() > this.goalUntil && Math.random() < (sd === 'home' ? 0.55 : 0.3)) {
        this.lastBox[sd] = this.t;
        this.shout('aah', sd, sd === 'home' ? 1.0 : 0.8, 1.4);
      }
    }
    // Prüffenster (5–8 s): Gesänge nach Matrix-Chance, Crowd-Reaktionen nach Regel des aktuellen Zustands
    const now = performance.now();
    const busy = now < this.goalUntil || now < this.eventUntil || this.envelope.busy;
    const actions = this.scheduler.step(this.t, {
      busy,
      playing: { home: !!this.cur.home, away: !!this.cur.away },
      blocked: { home: this.t < this.blockUntil.home, away: this.t < this.blockUntil.away },
      hasSongs: { home: this.songs.home.length > 0, away: this.songs.away.length > 0 },
      mood: m,
      state: { minute: ps.minute, homeScore: ps.homeScore, awayScore: ps.awayScore, sit: this.sit },
    });
    for (const a of actions) {
      if (a.kind === 'chant') this.sing(a.side, ps);
      else this.react(a.rule);
    }
    this.phaseEvents(ps);
  }

  /**
   * Situative Reaktion direkt (Applaus, Buhrufe, Ah/Oh/Uh, Aufschrei) – echte Aufnahme der Kategorie,
   * zählt für Mindestabstand/Cooldown der Crowd-Reaktionen. Lautstärke 0…1+ (Reaktionen bewusst gut hörbar).
   */
  private shout(kind: 'clap' | 'whistle' | 'aah' | 'ooh' | 'uuh' | 'applause' | 'boo' | 'scream', side: Side, volume: number, sec: number, o: { celebrate?: boolean } = {}) {
    void mixer.crowdReaction(kind, side, { volume: volume * 1.25, maxSec: sec, celebrate: o.celebrate });
    this.scheduler.noteReaction({ id: `X:${kind}`, trigger: 'event', side, reaction: kind, chance: 100, volume: volume * 100, minSec: sec, maxSec: sec, cooldown: 4, priority: 2, eventBound: true }, this.t);
    const ps = this.ps;
    this.played.push({ t: this.t, side, kind: 'reaction', id: `X:${kind}`, reaction: kind, minute: ps?.minute ?? 0, score: ps ? `${ps.homeScore}:${ps.awayScore}` : '' });
  }

  /** Crowd-Reaktion abspielen: Dauer zufällig zwischen min und max, Lautstärke aus der Regel (gut hörbar über der Kulisse) */
  private react(rule: CrowdRule, o: { celebrate?: boolean } = {}) {
    // Pfiffe der Heimfans laufen ausschließlich über das Unmut-Modell (Cooldowns, Intensität, eigene Aufnahmen)
    if (rule.side === 'home' && (rule.reaction === 'whistle' || (rule.reaction as string) === 'boo')) {
      const c = this.homeCtx();
      if (c) this.boo(this.disapproval.matrix(c, rule.chance / 100));
      return;
    }
    const dur = rule.minSec + Math.random() * (rule.maxSec - rule.minSec);
    // Unmut: frustrierte Fans pfeifen/buhen stattdessen
    const frus = this.frustration[rule.side];
    const kind = rule.reaction === 'whistle' && frus > 0.5 && Math.random() < 0.5 ? 'boo' : rule.reaction;
    void mixer.crowdReaction(kind as ReactionKind | 'boo', rule.side, { volume: rule.volume / 50, maxSec: Math.max(0.6, dur), celebrate: o.celebrate });
    const ps = this.ps;
    this.played.push({ t: this.t, side: rule.side, kind: 'reaction', id: rule.id, reaction: rule.reaction, minute: ps?.minute ?? 0, score: ps ? `${ps.homeScore}:${ps.awayScore}` : '' });
  }

  /** ereignisgebundene Reaktion (genau eine Variante oder keine) – zählt für Mindestabstand/Cooldown */
  private eventReaction(trigger: CrowdTrigger, side: Side | null, o: { celebrate?: boolean } = {}) {
    if (!side) return;
    const r = pickEventReaction(trigger, side);
    if (!r) return;
    this.scheduler.noteReaction(r, this.t);
    this.react(r, o);
  }

  /** Zustandsereignisse der Excel: E21 (Heim ≥ 3 zurück ab Minute 60), E22 (knappe Heimführung ab Minute 80) */
  private phaseEvents(ps: PlayState) {
    const d = ps.homeScore - ps.awayScore;
    if (ps.minute >= 60 && d <= -3 && !this.once.has(`E21:${d}`)) {
      this.once.add(`E21:${d}`);
      this.fx('E21', 'home', null);
      this.silence('home', 1.2);
      const c = this.homeCtx();
      if (c) this.boo(this.disapproval.deficitNow(c));
    }
    if (ps.minute >= 80 && d === 1 && !this.once.has('E22')) { this.once.add('E22'); this.fx('E22', 'home', 'attack'); }
  }

  /** nächsten Gesang einer Seite wählen: zufällig, nicht derselbe wie zuletzt; Spottgesang nur bei eigener Führung */
  private choose(side: Side, ps: PlayState): Song | null {
    const lead = (side === 'home' ? 1 : -1) * (ps.homeScore - ps.awayScore);
    const other = side === 'home' ? 'away' : 'home';
    // nie dieselbe Datei gleichzeitig auf beiden Spuren
    const list = this.songs[side].filter((s) => (s.mood !== 'taunt' || lead >= 1) && s.url !== this.curSong[other]);
    return pickNext(list, this.lastSong[side]);
  }

  /** Gesang starten: 0,7–1,2 s einblenden, am natürlichen Ende 1–2 s ausblenden, Rauschen leicht absenken (R08/R09) */
  private sing(side: Side, ps: PlayState) {
    const song = this.choose(side, ps);
    if (!song) return;
    this.lastSong[side] = song.id;
    this.curSong[side] = song.url;
    const placeholder: Track = { stop: () => undefined, ended: Promise.resolve(), url: '' }; // Platzhalter während des Ladens
    this.cur[side] = placeholder;
    this.played.push({ t: this.t, side, kind: 'chant', id: song.id, mood: song.mood, minute: ps.minute, score: `${ps.homeScore}:${ps.awayScore}` });
    const fadeIn = PARAMS.fadeIn;
    const p = mixer.play(song.url, { channel: side, volume: song.volume, maxSec: song.mood === 'upload' ? 40 : undefined, fadeIn, fadeOut: PARAMS.fadeOut, endFade: PARAMS.fadeOut, id: song.id, category: song.mood === 'upload' ? 'upload' : 'chant' });
    void p.then((t) => {
      if (this.cur[side] !== placeholder) { t?.stop(0.3); return; }
      if (!t) { this.cur[side] = null; return; }
      if (this.finished || performance.now() < this.goalUntil) { t.stop(0.3); this.cur[side] = null; return; }
      this.cur[side] = t;
      mixer.chanting(true);
      void t.ended.then(() => {
        if (this.cur[side] !== t) return;
        this.cur[side] = null;
        this.curSong[side] = null;
        this.scheduler.chantEnded(side, this.t); // 1–3 s Pause, dann neues Prüffenster
        if (!this.cur.home && !this.cur.away) mixer.chanting(false);
      });
    });
  }

  private silence(side: Side, fade: number) {
    this.cur[side]?.stop(fade);
    this.cur[side] = null;
    this.curSong[side] = null;
    if (!this.cur.home && !this.cur.away) mixer.chanting(false);
  }

  /**
   * Ereignis aus der Excel („Ereignis-Sounds“) abspielen: Pegel 0–100, Dauer, Priorität.
   * Priorität 1–2: laufende Gesänge rasch ducken (R10) und neue Gesänge kurz zurückhalten (R20).
   */
  private fx(id: string, side: Side, cat: CrowdCategory | null, o: { celebrate?: boolean; block?: number } = {}) {
    const e = EVENTS[id];
    if (!e) return;
    const dur = e.duration;
    if (cat) void mixer.reaction(cat, side, { volume: e.level / 85, maxSec: Math.max(1.6, dur + 0.8), cooldownMs: 1200, celebrate: o.celebrate });
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
  /** nur Tests: Spielereignisse des laufenden Spiels ignorieren, nur eingespeiste Testereignisse verarbeiten */
  ignoreMatchEvents = false;
  event(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number; ballOutsideNet: boolean }, src: 'match' | 'test' = 'match') {
    if (!mixer.active || (this.ignoreMatchEvents && src === 'match')) return;
    if (['goal', 'miss', 'corner', 'foul', 'offside', 'penalty', 'kickoff'].includes(e.type)) this.lastWhistleEvent = performance.now();
    const side = e.side;
    const H = side === 'home';
    const big = (e.xg ?? 0) > 0.12;
    if (this.pendingFoul && this.pendingFoul.tick !== e.tick) this.flushFoul();
    this.homeView(e, ctx);
    switch (e.type) {
      case 'kickoff':
        mixer.whistle('long');
        // Wiederanstoß nach einem Tor: intensiver Jubel endet vollständig, normale Kulisse kehrt zurück
        if (side) this.endGoal();
        break;
      case 'halftime':
        mixer.whistle('half');
        {
          const d = ctx.awayScore - ctx.homeScore; // Gästefans wie bisher
          if (d <= -2 || (d <= -1 && this.frustration.away > 0.5)) this.shout(d <= -2 ? 'whistle' : 'boo', 'away', 0.7, 4);
          this.boo(this.disapproval.halftime({ t: this.t, minute: 45, diff: ctx.homeScore - ctx.awayScore }));
        }
        break;
      case 'fulltime': this.finish(ctx); break;
      case 'goal': this.goal(side ?? 'home'); break;
      // E05–E08: Aluminium kurz vor der Zuschauerreaktion (Pfosten/Latte unterscheidet die Engine nicht)
      case 'woodwork':
        mixer.woodwork();
        // Aufschrei bei Pfosten/Latte (angreifende Fans), Gegner erschrocken „Uhhh“
        if (side) {
          this.fx(H ? 'E05' : 'E06', side, null);
          this.shout('scream', side, side === 'home' ? 1.1 : 0.9, 2.2);
          this.shout('uuh', side === 'home' ? 'away' : 'home', 0.7, 1.5);
          this.envelope.event(H ? 'home_miss' : 'away_miss');
          this.missedChance(side, ctx);
        }
        break;
      // Dribbling/Durchbruch: erwartungsvolles Anfeuern
      // gelungene Aktion (Dribbling/Durchbruch): Applaus der eigenen Fans, sonst erwartungsvolles Anfeuern
      case 'chance':
        if (side) {
          if (Math.random() < (H ? 0.45 : 0.3)) this.shout('applause', side, H ? 0.8 : 0.6, 2.5);
          else void mixer.reaction('attack', side, { maxSec: 3, cooldownMs: 4000, volume: H ? 0.8 : 0.6 });
        }
        break;
      // E03/E04: Großchance vergeben – kollektives „Ooooh“
      // Großchance pariert: „Ooooh“ der Angreifer (Excel-Varianten), Applaus der eigenen Fans für den Torhüter
      case 'save':
        if (big && side) {
          this.bigChance(side, H ? 'E03' : 'E04');
          this.envelope.event(H ? 'home_miss' : 'away_miss', H ? 2 : undefined);
          if (Math.random() < 0.5) setTimeout(() => this.shout('applause', side === 'home' ? 'away' : 'home', 0.7, 2.2), 900);
          this.missedChance(side, ctx);
        }
        break;
      case 'miss':
        mixer.whistle('soft');
        if (ctx.ballOutsideNet && side) { mixer.net(true); this.bigChance(side, 'E26'); }
        // vergebene Großchance: kollektives „Ooooh“
        else if (big && side) {
          this.fx(H ? 'E03' : 'E04', side, null);
          this.shout('ooh', side, side === 'home' ? 1.1 : 0.9, 1.8);
          this.envelope.event(H ? 'home_miss' : 'away_miss', H ? 2 : undefined);
          this.missedChance(side, ctx);
        }
        break;
      // E09/E10: Foul (side = foulendes Team) – Protest/Pfiffe der Fans des gefoulten Teams
      case 'foul':
        mixer.whistle('short');
        // Foul des Gastes: Heimfans entscheiden über das Unmut-Modell (hart = Karte/Verletzung/Elfmeter in derselben Szene)
        if (side === 'away') this.pendingFoul = { tick: e.tick, t: this.t, hard: false, penalty: false };
        else if (side === 'home') this.fx('E10', 'away', 'whistle'); // Heimfoul: nur die Gästefans protestieren
        break;
      case 'offside': mixer.whistle('short'); break;
      // E15/E16: Ecke – erwartungsvolles Raunen
      case 'corner': mixer.whistle('soft'); if (side) this.fx(H ? 'E15' : 'E16', side, 'attack'); break;
      // E17/E18: gefährlicher Freistoß
      case 'free_kick': if (side) this.fx(H ? 'E17' : 'E18', side, 'attack'); break;
      // E19/E20: Elfmeter – Anspannung; beim Gäste-Elfmeter pfeifen die Heimfans
      case 'penalty':
        mixer.whistle('short');
        this.shout('uuh', side ?? 'home', 0.9, 1.5); // überraschende Situation
        if (H) { this.fx('E19', 'home', 'attack'); mixer.duckChants('both', 0.2, { hold: 4 }); }
        else if (side) this.fx('E20', 'home', null); // Pfiffe der Heimfans: siehe homeView (Unmut-Modell)
        this.eventUntil = Math.max(this.eventUntil, performance.now() + 6000);
        break;
      // E11–E14: Karten (side = Team des Spielers) – Protest der betroffenen Fans
      case 'yellow': case 'second_yellow': if (side && !H) this.fx('E12', side, 'whistle'); break; // Karte gegen Heim: Unmut-Modell
      case 'red':
        if (side) {
          this.shout('uuh', side === 'home' ? 'away' : 'home', 0.8, 1.5); // Überraschung im anderen Block
          this.fx(H ? 'E13' : 'E14', side, H ? null : 'whistle', { block: H ? 90 : 20 }); // kein euphorischer Heimgesang nach Rot; Heimpfiffe: Unmut-Modell
        }
        break;
      // E23: Verletzung – besorgtes Murmeln, kein fröhlicher Gesang während der Behandlung
      case 'injury':
        if (side) { this.silence(side, 1.2); this.fx('E23', side, 'concede', { block: 20 }); }
        break;
      default: break;
    }
  }

  /** vergebene Chance im Rückstand: Unmut steigt; bei großem Frust Buhrufe statt Aufmunterung */
  private missedChance(side: Side, ctx: { homeScore: number; awayScore: number }) {
    const d = side === 'home' ? ctx.homeScore - ctx.awayScore : ctx.awayScore - ctx.homeScore;
    if (d < 0) this.frustration[side] = Math.min(1, this.frustration[side] + 0.12 * -d);
    if (side === 'home') {
      const dec = this.disapproval.missedChance({ t: this.t, minute: this.ps?.minute ?? 0, diff: d });
      if (dec?.play) setTimeout(() => this.boo(dec), 1800);
      return;
    }
    if (this.frustration[side] > 0.7 && Math.random() < 0.35) setTimeout(() => this.shout('boo', side, 0.8, 2.5), 1800);
  }

  /**
   * Großchance knapp vorbei (E03/E04, E05–E08, E26 für Priorität und Ducking):
   * angreifende Fans „Oh/Ah/Uh“ (Crowd-Reaktion „Eigene Großchance“), Gegner erleichtert/raunend.
   */
  private bigChance(side: Side, eventId: string) {
    this.fx(eventId, side, null);
    this.eventReaction('own_chance', side);
    this.eventReaction('opp_chance', side === 'home' ? 'away' : 'home');
  }

  // ------------------------------------------------------------------ Unmut der Heimfans
  private homeCtx() { const ps = this.ps; return ps ? { t: this.t, minute: ps.minute, diff: ps.homeScore - ps.awayScore } : null; }

  /** je Frame: Ballverluste, Gefahr in Serie, anhaltender Rückstand (Heimsicht) */
  private watchHome(ps: PlayState, prev: Situation, dt: number) {
    const c = { t: this.t, minute: ps.minute, diff: ps.homeScore - ps.awayScore };
    if (this.pendingFoul && this.t - this.pendingFoul.t > 0.4) this.flushFoul();
    if (ps.possession === 'home') this.homeToGoal = ps.toGoal;
    if (ps.possession && ps.possession !== this.lastPoss) {
      if (this.lastPoss === 'home' && ps.possession === 'away' && this.t > 1) {
        const own = this.homeToGoal > 58; // Ballverlust in der eigenen Hälfte
        if (own) this.lastOwnLoss = this.t;
        this.boo(this.disapproval.ballLoss(c, own));
      }
      this.lastPoss = ps.possession;
    }
    if (this.sit === 'away_box' && prev !== 'away_box') this.boo(this.disapproval.awayDangerous(c));
    if (this.sit === 'home_box' && prev !== 'home_box') this.disapproval.homeDangerous(c);
    if (performance.now() > this.goalUntil) this.boo(this.disapproval.tick(dt, c));
  }

  /** Spielereignisse aus Sicht der Heimfans (Fouls des Heimteams lösen dort nie Pfiffe aus) */
  private homeView(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number }) {
    const c = { t: this.t, minute: ctx.minute, diff: ctx.homeScore - ctx.awayScore };
    const pf = this.pendingFoul && this.pendingFoul.tick === e.tick ? this.pendingFoul : null;
    switch (e.type) {
      case 'yellow': case 'second_yellow': case 'red':
        if (e.side === 'away' && pf) pf.hard = true; // Karte für den foulenden Gast ⇒ hartes Foul
        if (e.side === 'home') this.boo(this.disapproval.homeCard(c, e.type !== 'yellow'));
        break;
      case 'injury': if (e.side === 'home' && pf) pf.hard = true; break;
      case 'penalty':
        if (e.side === 'away') { if (pf) pf.penalty = true; this.boo(this.disapproval.penaltyAgainst(c)); }
        break;
      case 'offside': if (e.side === 'home') this.boo(this.disapproval.offsideHome(c)); break;
      case 'shot': case 'chance': case 'save': case 'miss': case 'woodwork':
        if (e.side === 'away') this.boo(this.disapproval.awayDangerous(c));
        else if (e.side === 'home') this.disapproval.homeDangerous(c);
        break;
      case 'goal':
        if (e.side === 'home') this.disapproval.homeGoal();
        else if (e.side === 'away') {
          // ctx enthält bereits den Stand nach dem Tor (Snapshot des Tor-Ticks); Fehler = Ballverlust in der eigenen Hälfte in den 10 s davor
          const dec = this.disapproval.conceded(c, this.t - this.lastOwnLoss < 10);
          if (dec?.play) setTimeout(() => this.boo(dec), 1600); // erst Schock/Enttäuschung, dann Pfiffe
        }
        break;
      default: break;
    }
  }

  private flushFoul() {
    const f = this.pendingFoul; this.pendingFoul = null;
    if (!f || f.penalty) return; // Elfmeter: eigene Reaktion
    const ps = this.ps;
    this.boo(this.disapproval.awayFoul({ t: this.t, minute: ps?.minute ?? 0, diff: ps ? ps.homeScore - ps.awayScore : 0 }, f.hard));
  }

  /** Entscheidung des Modells abspielen: Aufnahme pfiff/pfeifkonzert, Gesänge kurz reduzieren, danach normale Kulisse */
  private boo(d: Disapproval | null) {
    if (!d?.play || this.finished || !mixer.active) return;
    const long = d.length === 'long';
    const cat: CrowdCategory = long ? 'pfeifkonzert' : 'pfiff';
    if (!mixer.has(cat)) return;
    const sec = long ? 7 + 7 * Math.min(1, Math.max(0, (d.intensity - 0.5) / 0.8)) : 2.6 + 1.6 * Math.min(1, d.intensity);
    void mixer.reaction(cat, 'home', { volume: d.intensity, maxSec: sec, cooldownMs: 0 });
    // laufende Gesänge während des Pfeifkonzerts reduzieren (Heimkurve deutlich, Gästeblock kaum)
    mixer.duckChants('home', long ? 0.25 : 0.5, { attack: 0.4, hold: sec * 0.8, release: 1.8 });
    mixer.duckChants('away', 0.85, { attack: 0.4, hold: sec * 0.6, release: 1.5 });
    this.blockUntil.home = Math.max(this.blockUntil.home, this.t + sec + (long ? 4 : 1.5));
    const ps = this.ps;
    this.played.push({ t: this.t, side: 'home', kind: 'reaction', id: `D:${d.cause}`, reaction: cat, minute: ps?.minute ?? d.minute, score: ps ? `${ps.homeScore}:${ps.awayScore}` : '' });
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
    this.silence('home', PARAMS.goalDuck);
    this.silence('away', PARAMS.goalDuck);
    this.goalHymn?.stop(0.3);
    this.goalHymn = null;
    this.goalUntil = performance.now() + 7000; // Sicherung, falls kein Wiederanstoß kommt (Schlusspfiff)
    this.envelope.event(side === 'home' ? 'home_goal' : 'away_goal', 7);
    // Aufnahmen: Heimtor = Kurve explodiert; Auswärtstor = Gästeblock kurz sehr laut, Heimfans enttäuscht
    mixer.goal(side, this.goalIntensity(side));
    // Gegentor: Unmut der anderen Fans steigt; bei deutlichem Rückstand Buhrufe/Pfiffe statt Raunen
    const other: Side = side === 'home' ? 'away' : 'home';
    const ps = this.ps;
    const deficit = ps ? (other === 'home' ? ps.awayScore + 1 - ps.homeScore : ps.homeScore + 1 - ps.awayScore) : 0;
    this.frustration[other] = Math.min(1, this.frustration[other] + 0.2 + 0.1 * Math.max(0, deficit - 1));
    this.frustration[side] = Math.max(0, this.frustration[side] - 0.4);
    if (deficit >= 2 && other === 'away') { this.shout(deficit >= 3 ? 'whistle' : 'boo', other, 0.6, 3, { celebrate: true }); }
    // Crowd-Reaktionen „Eigenes Tor“ / „Gegentor“: je eine Variante, endet mit dem Wiederanstoß
    this.eventReaction('own_goal', side, { celebrate: true });
    if (deficit < 2 || other === 'home') this.eventReaction('opp_goal', side === 'home' ? 'away' : 'home', { celebrate: true });
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

  /**
   * Dynamischer Torjubel: Ausgleich/Führungstor/späte Tore lauter, Tore bei klarer Führung verhaltener.
   * Ergebnis 0,7…1,4 (Lautstärkefaktor); die Dauer endet immer beim Wiederanstoß.
   */
  goalIntensity(side: Side): number {
    const ps = this.ps;
    if (!ps) return 1;
    const before = side === 'home' ? ps.homeScore - ps.awayScore : ps.awayScore - ps.homeScore; // Stand vor dem Tor
    let f = 1;
    if (before === -1 || before === 0) f += 0.2; // Ausgleich bzw. Führung
    if (ps.minute >= 80 && Math.abs(before) <= 1) f += 0.2; // späte, wichtige Tore
    if (before >= 3) f -= 0.3; // Schützenfest
    if (side === 'away') f *= 0.9;
    return Math.max(0.7, Math.min(1.4, f));
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
