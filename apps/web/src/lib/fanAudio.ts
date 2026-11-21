/**
 * Stadionton eines Spiels: verbindet sichtbare Spielereignisse mit dem Mixer.
 * - Auslöser sind ausschließlich Ereignisse/Zustände, die gerade auf dem Spielfeld zu sehen sind
 *   (gleicher Tick wie die Darstellung) – kein Ereignis löst zweimal aus.
 * - Kulisse: Heim- und Gästefans als getrennte Spuren; Intensität aus der Spielsituation (crowdModel),
 *   30-dB-Bereich mit weichen Übergängen (Angriff, Strafraum, Chance vergeben, Tor, Gegentor, Schlussphase).
 * - Fangesänge: zufällige Playlist aller regulären Gesänge (ohne Signatur-Gesang und Torhymne);
 *   ohne Uploads (KI-Vereine) generische Gesänge. Ballbesitz/Angriff machen einen Einsatz wahrscheinlicher,
 *   höchstens ein Gesang gleichzeitig; Gästefans seltener und leiser (rechts), nach Größe des Gästeblocks.
 * - Hymne und Signatur-Fangesang nur beim Einlauf; Torhymne nur beim Tor des eigenen Vereins.
 */
import { mixer, type Track } from './audioMixer';
import { CrowdEnvelope, chantRate, situationOf, targetsOf, type PlayState, type Situation } from './crowdModel';
import { chantSetFor } from './synthChant';
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

/** Gesang einer Seite: hochgeladene MP3 oder generischer Gesang (Muster-Index) */
type Song = { id: string; kind: 'mp3'; ref: ChantRef } | { id: string; kind: 'synth'; pattern: number };

export class MatchSound {
  private home: Song[] = [];
  private away: Song[] = [];
  private homeGoal: ChantRef[] = [];
  private awayGoal: ChantRef[] = [];
  private current: Track | null = null;
  private lastId: string | null = null;
  private wait = 4;
  private goalUntil = 0;
  private finished = false;
  private started = false;
  private sit: Situation = 'calm';
  readonly envelope = new CrowdEnvelope();
  private url: (path: string) => string;

  constructor(url: (path: string) => string) { this.url = url; }

  /**
   * Gesänge des Spiels setzen (aus dem Match-Setup – keine weiteren Datenbankabfragen).
   * Ohne eigene Uploads (z. B. KI-Vereine) singen die Fans generische, vereinsneutrale Gesänge.
   */
  setChants(home: ChantRef[], away: ChantRef[], clubs: { home?: string | null; away?: string | null } = {}) {
    const songs = (list: ChantRef[], club: string | null | undefined): Song[] => {
      const up = regularChants(list).map((ref) => ({ id: ref.id, kind: 'mp3' as const, ref }));
      if (up.length) return up;
      return chantSetFor(club ?? 'neutral').map((pattern) => ({ id: `synth${pattern}`, kind: 'synth' as const, pattern }));
    };
    this.home = songs(home, clubs.home); this.homeGoal = goalHymns(home);
    this.away = songs(away, clubs.away); this.awayGoal = goalHymns(away);
    // Dateien vorab zwischenspeichern (einmal laden/dekodieren)
    for (const c of [...this.home, ...this.away]) if (c.kind === 'mp3') void mixer.load(this.url(c.ref.path!));
    for (const c of [...this.homeGoal, ...this.awayGoal]) void mixer.load(this.url(c.path!));
  }

  begin() { this.started = true; this.finished = false; this.wait = 2 + Math.random() * 3; }

  /** aktuelle Spielsituation (für Anzeige/Tests) */
  get situation(): Situation { return this.sit; }

  /**
   * Je Frame: vergangene Zeit (s) und sichtbarer Spielzustand.
   * Heim- und Gästefans reagieren getrennt (eigene Spuren), Übergänge laufen weich über die Hüllkurve.
   */
  frame(dt: number, play: PlayState | number) {
    if (!this.started || this.finished || !mixer.active) return;
    const ps: PlayState = typeof play === 'number'
      ? { possession: play > 0.1 ? 'home' : play < 0.1 ? 'away' : null, toGoal: (1 - play) * 65, inBox: play >= 1, forward: 0, minute: 0, homeScore: 0, awayScore: 0 }
      : play;
    this.sit = situationOf(ps);
    const lv = this.envelope.update(dt, targetsOf(this.sit, ps));
    mixer.setCrowd(lv.home * (this.current && this.currentSide === 'home' ? 0.85 : 1), lv.away);
    if (this.current || performance.now() < this.goalUntil) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    // Gesangswahrscheinlichkeit steigt bei Ballbesitz und Angriffen der eigenen Mannschaft; Heimfans dominieren
    const rh = chantRate('home', this.sit), ra = chantRate('away', this.sit);
    const roll = Math.random() * (1 + rh + ra);
    this.wait = 1;
    if (roll > rh + ra) return;
    const side: 'home' | 'away' = roll < rh ? 'home' : 'away';
    this.sing(side);
  }

  private currentSide: 'home' | 'away' | null = null;

  private sing(side: 'home' | 'away') {
    const list = side === 'home' ? this.home : this.away;
    const next = pickNext(list, this.lastId);
    if (!next) { this.wait = nextPause(0.3); return; }
    this.lastId = next.id;
    this.current = { stop: () => undefined, ended: Promise.resolve(), url: '' }; // Platzhalter während des Ladens
    this.currentSide = side;
    // Gäste: deutlich leiser (nach Größe des Gästeblocks), rechts; Heim: volle Kurve
    const vol = side === 'home' ? 1 : 0.38 * mixer.awayLevel;
    const opts = { volume: vol * (next.kind === 'mp3' ? next.ref.volume : 0.85), pan: side === 'home' ? -0.3 : 0.75, maxSec: 40, fadeIn: 1.4 };
    const p = next.kind === 'mp3'
      ? mixer.play(this.url(next.ref.path!), { channel: 'chants', ...opts })
      : mixer.chant(next.pattern, { ...opts, side });
    void p.then((t) => {
      if (!t) { this.current = null; this.currentSide = null; this.wait = nextPause(0.3); return; }
      if (this.finished || performance.now() < this.goalUntil) { t.stop(0.5); this.current = null; this.currentSide = null; return; }
      this.current = t;
      void t.ended.then(() => { if (this.current === t) { this.current = null; this.currentSide = null; this.wait = nextPause(0.3); } });
    });
  }

  /** sichtbares Spielereignis */
  event(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number; ballOutsideNet: boolean }) {
    if (!mixer.active) return;
    if (['goal', 'miss', 'corner', 'foul', 'offside', 'penalty', 'kickoff'].includes(e.type)) this.lastWhistleEvent = performance.now();
    const home = e.side === 'home';
    const big = (e.xg ?? 0) > 0.12;
    switch (e.type) {
      case 'kickoff':
        mixer.whistle('long');
        // Wiederanstoß nach einem Tor: intensiver Jubel endet vollständig, normale Kulisse kehrt zurück
        if (e.side) this.endGoal();
        break;
      case 'halftime': mixer.whistle('half'); break;
      case 'fulltime': this.finish(); break;
      case 'goal': this.goal(e.side ?? 'home'); break;
      case 'woodwork': mixer.woodwork(); if (home) { mixer.ooh(); this.envelope.event('home_miss'); } else this.envelope.event('away_miss'); break;
      case 'chance': if (home) { mixer.ooh(); this.envelope.event('home_miss', 2); } break;
      case 'save': if (home && big) { mixer.ooh(); this.envelope.event('home_miss'); } else if (!home && big) this.envelope.event('away_miss'); break;
      case 'miss': if (ctx.ballOutsideNet) mixer.net(true); if (home && big) { mixer.ooh(); this.envelope.event('home_miss'); } else if (!home && big) this.envelope.event('away_miss'); mixer.whistle('soft'); break;
      case 'foul': mixer.whistle('short'); if (e.side === 'away') mixer.jeer(); break;
      case 'offside': mixer.whistle('short'); break;
      case 'corner': mixer.whistle('soft'); break;
      case 'penalty': mixer.whistle('short'); this.envelope.event(home ? 'home_miss' : 'away_miss', 0.01); break;
      case 'yellow': case 'second_yellow': case 'red': if (e.side !== 'away') mixer.jeer(); break;
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
    this.current?.stop(0.5);
    this.current = null;
    this.currentSide = null;
    this.goalHymn?.stop(0.3);
    this.goalHymn = null;
    this.goalUntil = performance.now() + 7000; // Sicherung, falls kein Wiederanstoß kommt (Schlusspfiff)
    this.envelope.event(side === 'home' ? 'home_goal' : 'away_goal', 7);
    if (side === 'home') { mixer.roar('home'); } else { mixer.roar('away'); mixer.groan(); }
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
    mixer.endCelebration(0.5);
    this.goalHymn?.stop(0.6);
    this.goalHymn = null;
    this.envelope.release();
    this.goalUntil = performance.now() + 1500;
    this.wait = 2 + Math.random() * 2;
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

  /** Abpfiff: Schlusspfiff, Applaus, danach alles sanft ausblenden */
  finish() {
    if (this.finished) return;
    this.finished = true;
    mixer.whistle('final');
    this.current?.stop(1.5);
    this.current = null;
    this.envelope.event('home_miss', 3);
    const gen = mixer.generation;
    setTimeout(() => mixer.shutdown(2.5, gen), 4500);
  }

  stop(fade = 0.6) { this.finished = true; this.current?.stop(fade); this.current = null; mixer.shutdown(fade); }
}
