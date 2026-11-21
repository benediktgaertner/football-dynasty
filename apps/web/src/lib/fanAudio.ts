/**
 * Stadionton eines Spiels: verbindet sichtbare Spielereignisse mit dem Mixer.
 * - Auslöser sind ausschließlich Ereignisse/Zustände, die gerade auf dem Spielfeld zu sehen sind
 *   (gleicher Tick wie die Darstellung) – kein Ereignis löst zweimal aus.
 * - Fangesänge: zufällige Playlist aller regulären Gesänge (ohne Signatur-Gesang und Torhymne),
 *   Pausen 3–8 s, keine direkte Wiederholung, Druckphasen machen einen Einsatz wahrscheinlicher,
 *   höchstens ein Gesang gleichzeitig; Gästefans gelegentlich und leiser (rechts).
 * - Hymne und Signatur-Fangesang nur beim Einlauf; Torhymne nur beim Tor des eigenen Vereins.
 */
import { mixer, type Track } from './audioMixer';
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

export class MatchSound {
  private home: ChantRef[] = [];
  private away: ChantRef[] = [];
  private homeGoal: ChantRef[] = [];
  private awayGoal: ChantRef[] = [];
  private current: Track | null = null;
  private lastId: string | null = null;
  private wait = 4;
  private goalUntil = 0;
  private finished = false;
  private started = false;
  private pressure = 0;
  private url: (path: string) => string;

  constructor(url: (path: string) => string) { this.url = url; }

  /** Gesänge des Spiels setzen (aus dem Match-Setup – keine weiteren Datenbankabfragen) */
  setChants(home: ChantRef[], away: ChantRef[]) {
    this.home = regularChants(home); this.homeGoal = goalHymns(home);
    this.away = regularChants(away); this.awayGoal = goalHymns(away);
    // Dateien vorab zwischenspeichern (einmal laden/dekodieren)
    for (const c of [...this.home, ...this.homeGoal, ...this.away, ...this.awayGoal]) void mixer.load(this.url(c.path!));
  }

  begin() { this.started = true; this.finished = false; this.wait = 2 + Math.random() * 3; }

  /** je Frame mit vergangener Zeit (s) und Druck der Heimmannschaft (0…1) */
  frame(dt: number, pressure: number) {
    if (!this.started || this.finished || !mixer.active) return;
    this.pressure = this.pressure * 0.9 + pressure * 0.1;
    // Angriff der Heimmannschaft ⇒ lauter; gefährlich im Strafraum ⇒ deutlicher Anstieg (Ziel wird geglättet)
    mixer.ambient(0.25 + 0.45 * this.pressure + (pressure > 0.85 ? 0.25 : 0));
    mixer.tick(dt);
    if (this.current || performance.now() < this.goalUntil) return;
    this.wait -= dt * (1 + this.pressure * 0.8); // Druckphasen ⇒ Gesang beginnt eher
    if (this.wait > 0) return;
    const awayTurn = this.away.length > 0 && Math.random() < (this.home.length ? 0.2 : 0.6);
    const list = awayTurn ? this.away : this.home;
    const next = pickNext(list, this.lastId);
    if (!next) { this.wait = nextPause(this.pressure); return; }
    this.lastId = next.id;
    this.current = { stop: () => undefined, ended: Promise.resolve(), url: '' }; // Platzhalter: kein zweiter Start während des Ladens
    void mixer.play(this.url(next.path!), { channel: 'chants', volume: next.volume * (awayTurn ? 0.45 : 1), pan: awayTurn ? 0.75 : -0.35, maxSec: 45, fadeIn: 1.5 }).then((t) => {
      if (!t) { this.current = null; this.wait = nextPause(this.pressure); return; }
      if (this.finished || performance.now() < this.goalUntil) { t.stop(0.5); this.current = null; return; }
      this.current = t;
      mixer.ducking(0.8);
      void t.ended.then(() => { if (this.current === t) { this.current = null; mixer.ducking(1); this.wait = nextPause(this.pressure); } });
    });
  }

  /** sichtbares Spielereignis */
  event(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number; ballOutsideNet: boolean }) {
    if (!mixer.active) return;
    if (['goal', 'miss', 'corner', 'foul', 'offside', 'penalty', 'kickoff'].includes(e.type)) this.lastWhistleEvent = performance.now();
    const home = e.side === 'home';
    switch (e.type) {
      case 'kickoff': mixer.whistle('long'); mixer.push(0.55, 3); break;
      case 'halftime': mixer.whistle('half'); break;
      case 'fulltime': this.finish(); break;
      case 'goal': this.goal(e.side ?? 'home'); break;
      case 'woodwork': mixer.woodwork(); if (home) mixer.ooh(); else mixer.push(0.6, 1); break;
      case 'chance': if (home) mixer.ooh(); break;
      case 'save': if (home && (e.xg ?? 0) > 0.2) mixer.ooh(); else if (home) mixer.push(0.6, 1); break;
      case 'miss': if (ctx.ballOutsideNet) mixer.net(true); if (home && (e.xg ?? 0) > 0.12) mixer.ooh(); mixer.whistle('soft'); break;
      case 'foul': mixer.whistle('short'); if (e.side === 'away') mixer.jeer(); break;
      case 'offside': mixer.whistle('short'); if (e.side === 'away') mixer.push(0.4); break;
      case 'corner': mixer.whistle('soft'); if (home) mixer.push(0.65, 2); break;
      case 'free_kick': if (home) mixer.push(0.6, 2); break;
      case 'penalty': mixer.whistle('short'); mixer.push(home ? 0.95 : 0.7, 4); break;
      case 'yellow': case 'second_yellow': case 'red': if (e.side === 'away') mixer.push(0.55, 1); else mixer.jeer(); break;
      default: break;
    }
    // Schlussphase: knappes Spiel nach der 80. Minute ⇒ mehr Spannung
    if (ctx.minute >= 80 && Math.abs(ctx.homeScore - ctx.awayScore) <= 1) mixer.push(0.55 + (ctx.minute - 80) / 40);
  }

  /** Tor: laufenden Gesang ausblenden, Netz, Jubel, Torhymne des Vereins; danach zurück zur Playlist */
  private goal(side: 'home' | 'away') {
    mixer.net(false);
    this.current?.stop(0.8);
    this.current = null;
    this.goalUntil = performance.now() + 9000;
    if (side === 'home') { mixer.roar('home'); } else { mixer.roar('away'); mixer.groan(); }
    const hymn = pickNext(side === 'home' ? this.homeGoal : this.awayGoal, null);
    if (hymn) {
      setTimeout(() => {
        if (this.finished) return;
        mixer.ducking(0.55, 1);
        void mixer.play(this.url(hymn.path!), { channel: 'anthem', volume: hymn.volume * (side === 'home' ? 1 : 0.5), pan: side === 'home' ? -0.2 : 0.75, maxSec: 25, fadeIn: 0.6 }).then((t) => {
          if (!t) { mixer.ducking(1); return; }
          this.goalUntil = performance.now() + 25000;
          void t.ended.then(() => { mixer.ducking(1); this.goalUntil = performance.now() + 2500; this.wait = nextPause(this.pressure); });
        });
      }, 1800);
    } else this.wait = 6;
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
    mixer.push(0.7, 2);
    const gen = mixer.generation;
    setTimeout(() => mixer.shutdown(2.5, gen), 4500);
  }

  stop(fade = 0.6) { this.finished = true; this.current?.stop(fade); this.current = null; mixer.shutdown(fade); }
}
