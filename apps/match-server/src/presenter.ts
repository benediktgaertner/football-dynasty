import {
  MATCH_REAL_SECONDS,
  PLAYBACK_MS_PER_TICK,
  TICKS_PER_HALF,
  TICK_SECONDS,
  type MatchEngine,
  type MatchEvent,
  type Snapshot,
} from '@fd/engine';

/**
 * Regie: wählt aus der laufend berechneten Partie die sehenswerten Szenen und spielt sie
 * mit 2-facher Geschwindigkeit ab. Ruhige Phasen werden übersprungen (die Uhr springt vor).
 *
 * Grundsätze
 * - Es wird nichts erfunden: jede gezeigte Position ist ein echter Engine-Zustand.
 * - Die Engine rechnet nie weit voraus. Beim Abspielen läuft sie im Gleichschritt mit der Anzeige
 *   (höchstens die Vorlaufzeit einer Szene voraus); übersprungene Phasen werden erst im Moment des
 *   Sprungs berechnet. Taktikänderungen und Wechsel wirken daher auf alles, was noch nicht gezeigt wurde.
 * - Ereignisse (Tore, Karten …) werden erst freigegeben, wenn ihre Spielzeit gezeigt oder übersprungen ist.
 *   Alle Clients erhalten denselben Nachrichtenstrom ⇒ identische Partie für alle.
 */

export type PresenterMessage =
  | { t: 'frame'; s: Snapshot; scene: number }
  | { t: 'ev'; events: MatchEvent[] }
  | { t: 'skip'; from: number; to: number; scene: number }
  | { t: 'status'; status: 'running' | 'halftime' }
  | { t: 'done' };

const FRAME_EVERY = 2; // jeder 2. Tick = 0,2 s Fußballzeit = 100 ms Echtzeit
const sec = (s: number) => Math.round(s / TICK_SECONDS);
const STRONG = new Set(['goal', 'save', 'miss', 'chance', 'woodwork', 'penalty', 'red', 'second_yellow']);
const MEDIUM = new Set(['corner', 'free_kick', 'yellow', 'injury']);
const TRANSITION_MS = 700;
const HALFTIME_MS = 2500;
/** Fußballsekunden je Echtzeitsekunde im Schnitt (90 min in 180 s) */
const RATIO = (TICKS_PER_HALF * 2 * TICK_SECONDS) / (MATCH_REAL_SECONDS - 6);

export interface PresenterOptions {
  /** bereits verstrichene Echtzeit (bei Wiederaufnahme) */
  startRealMs?: number;
  budgetMs?: number;
}

export class Presenter {
  state: 'seek' | 'play' | 'pause' | 'done' = 'seek';
  realMs: number;
  shownTick: number;
  scene = 0;
  lastFrame: Snapshot;
  readonly released: MatchEvent[] = [];
  private budgetMs: number;
  private frames = new Map<number, Snapshot>();
  private cutTicks = new Set<number>();
  private seenEvents: number;
  private pauseMs = 0;
  private acc = 0;
  private sceneStart = 0;
  private lastInterest = 0;
  private goalTick: number | null = null;
  private maxLen = sec(24);
  private prevIntensity = 0;
  private triggerTick: number | null = null;
  private triggerStrength = 0;
  private halftimeShown = false;

  constructor(private engine: MatchEngine, opts: PresenterOptions = {}) {
    this.budgetMs = opts.budgetMs ?? MATCH_REAL_SECONDS * 1000;
    this.realMs = opts.startRealMs ?? 0;
    this.shownTick = engine.tick;
    this.seenEvents = engine.events.length;
    this.released.push(...engine.events);
    this.lastFrame = engine.snapshot();
    this.halftimeShown = engine.tick >= TICKS_PER_HALF;
  }

  /** Vorsprung (+) oder Rückstand (−) der gezeigten Spielzeit gegenüber dem Zeitplan, in Fußballsekunden */
  get delta(): number {
    return this.shownTick * TICK_SECONDS - (this.realMs / 1000) * RATIO;
  }

  /** Eine Engine-Simulationsstufe inkl. Bild-Puffer und Auslöser-Erkennung */
  private stepEngine(): void {
    this.engine.step();
    const tick = this.engine.tick;
    if (this.engine.takeCut()) this.cutTicks.add(tick);
    if (tick % FRAME_EVERY === 0 || this.engine.isFinished) {
      this.frames.set(tick, this.engine.snapshot());
      const old = tick - sec(14);
      for (const k of this.frames.keys()) { if (k < old) this.frames.delete(k); else break; }
      for (const k of this.cutTicks) if (k < old) this.cutTicks.delete(k);
    }
    // Auslöser: neue Ereignisse und Ball im letzten Drittel
    const ev = this.engine.events;
    for (let i = this.seenEvents; i < ev.length; i++) {
      const e = ev[i]!;
      const strength = e.type === 'goal' || e.type === 'penalty' || e.type === 'red' ? 3 : STRONG.has(e.type) ? 2 : MEDIUM.has(e.type) ? 1 : 0;
      if (strength > 0) {
        this.lastInterest = e.tick;
        if (e.type === 'goal') this.goalTick = e.tick;
        if (strength > this.triggerStrength) { this.triggerStrength = strength; this.triggerTick = e.tick; }
      }
    }
    this.seenEvents = ev.length;
    const intensity = this.engine.intensity();
    if (intensity >= 0.6) this.lastInterest = tick;
    if (intensity >= 1 && this.prevIntensity < 1 && this.triggerStrength < 1) { this.triggerStrength = 1; this.triggerTick = tick; }
    this.prevIntensity = intensity;
  }

  private release(upTo: number, out: PresenterMessage[]): void {
    const ev = this.engine.events;
    const fresh: MatchEvent[] = [];
    for (let i = this.released.length; i < ev.length && ev[i]!.tick <= upTo; i++) fresh.push(ev[i]!);
    if (fresh.length) { this.released.push(...fresh); out.push({ t: 'ev', events: fresh }); }
  }

  private finishAll(out: PresenterMessage[]): void {
    const from = this.shownTick;
    while (!this.engine.isFinished) this.engine.step();
    if (this.engine.tick - from > sec(3)) out.push({ t: 'skip', from: from * TICK_SECONDS, to: this.engine.tick * TICK_SECONDS, scene: this.scene + 1 });
    this.shownTick = this.engine.tick;
    this.lastFrame = this.engine.snapshot();
    this.release(Number.MAX_SAFE_INTEGER, out);
    out.push({ t: 'frame', s: this.lastFrame, scene: ++this.scene });
    this.state = 'done';
    out.push({ t: 'done' });
  }

  /** Echtzeit fortschreiben (ms, bereits mit Testgeschwindigkeit skaliert). Liefert die zu sendenden Nachrichten. */
  advance(dtMs: number): PresenterMessage[] {
    const out: PresenterMessage[] = [];
    if (this.state === 'done') return out;
    this.realMs += dtMs;
    // Spätestens am Ende des Zeitbudgets wird die Partie abgeschlossen
    if (this.realMs >= this.budgetMs - 500) { this.finishAll(out); return out; }
    if (this.state === 'pause') {
      this.pauseMs -= dtMs;
      if (this.pauseMs > 0) return out;
      this.state = this.afterPause;
      if (this.state === 'seek') out.push({ t: 'status', status: 'running' });
      this.acc = 0;
      return out;
    }
    if (this.state === 'seek') { this.seek(out); return out; }
    this.play(dtMs, out);
    return out;
  }

  private afterPause: 'seek' | 'play' = 'seek';

  private seek(out: PresenterMessage[]): void {
    const d = this.delta;
    // Weit vor dem Zeitplan: nicht springen, einfach weiterzeigen
    if (d > 45 && this.engine.tick === this.shownTick) { this.startScene(this.shownTick + 1, out, sec(40)); return; }
    const minStrength = d < -400 ? 3 : d < -240 ? 2 : 1;
    this.triggerStrength = 0; this.triggerTick = null; this.goalTick = null;
    let budget = 12000;
    while (budget-- > 0) {
      if (this.engine.isFinished) { this.finishAll(out); return; }
      this.stepEngine();
      if (!this.halftimeShown && this.engine.tick >= TICKS_PER_HALF) {
        // Halbzeit: bis 45:00 springen, kurze Pause
        this.halftimeShown = true;
        out.push({ t: 'skip', from: this.shownTick * TICK_SECONDS, to: this.engine.tick * TICK_SECONDS, scene: ++this.scene });
        this.shownTick = this.engine.tick;
        this.release(this.shownTick, out);
        this.lastFrame = this.engine.snapshot();
        out.push({ t: 'frame', s: this.lastFrame, scene: this.scene });
        out.push({ t: 'status', status: 'halftime' });
        this.state = 'pause'; this.pauseMs = HALFTIME_MS; this.afterPause = 'seek';
        return;
      }
      // Sprünge begrenzen: nie weiter als der Zeitplan erlaubt
      const ahead = this.engine.tick * TICK_SECONDS - (this.realMs / 1000) * RATIO;
      const need = ahead > 20 ? 1 : minStrength;
      if (ahead > 50 && (this.triggerTick === null || this.triggerStrength < need)) {
        this.triggerTick = this.engine.tick; this.triggerStrength = 1;
      }
      if (this.triggerTick !== null && this.triggerStrength >= need) {
        const leadIn = d < -120 ? sec(5) : sec(8);
        let start = Math.max(this.triggerTick - leadIn, this.shownTick + 1, this.engine.tick - sec(13));
        // Szene nicht mitten in einer Unterbrechung beginnen, wenn kurz danach weitergespielt wird
        start = start - (start % FRAME_EVERY);
        const maxLen = d < -60 ? sec(12) : d > 60 ? sec(36) : sec(20);
        this.goalTick = null;
        this.startScene(start, out, maxLen);
        return;
      }
      if (this.triggerTick !== null) { this.triggerTick = null; this.triggerStrength = 0; }
    }
  }

  private startScene(start: number, out: PresenterMessage[], maxLen: number): void {
    const jump = start - this.shownTick;
    this.sceneStart = start;
    this.maxLen = maxLen;
    this.lastInterest = Math.max(this.lastInterest, start);
    if (jump > sec(3)) {
      out.push({ t: 'skip', from: this.shownTick * TICK_SECONDS, to: start * TICK_SECONDS, scene: ++this.scene });
      this.release(start - 1, out);
      this.shownTick = start - 1;
      this.state = 'pause'; this.pauseMs = TRANSITION_MS; this.afterPause = 'play';
    } else {
      if (start - 1 > this.shownTick) {
        out.push({ t: 'skip', from: this.shownTick * TICK_SECONDS, to: start * TICK_SECONDS, scene: ++this.scene });
        this.release(start - 1, out);
      }
      this.shownTick = Math.max(this.shownTick, start - 1);
      this.state = 'play';
      this.acc = 0;
    }
  }

  private play(dtMs: number, out: PresenterMessage[]): void {
    this.acc += dtMs;
    while (this.acc >= PLAYBACK_MS_PER_TICK) {
      this.acc -= PLAYBACK_MS_PER_TICK;
      const next = this.shownTick + 1;
      while (this.engine.tick < next && !this.engine.isFinished) this.stepEngine();
      if (this.engine.isFinished && next > this.engine.tick) { this.finishAll(out); return; }
      if (!this.halftimeShown && next >= TICKS_PER_HALF) { this.state = 'seek'; return; }
      this.shownTick = next;
      if (this.cutTicks.has(next)) { this.scene++; this.cutTicks.delete(next); }
      if (next % FRAME_EVERY === 0) {
        const f = this.frames.get(next) ?? this.engine.snapshot();
        this.lastFrame = f;
        out.push({ t: 'frame', s: f, scene: this.scene });
      }
      this.release(next, out);
      // Lange Unterbrechung (Foul, Ecke, Abstoß): Wartezeit überspringen
      if (this.engine.tick === next && this.engine.isDeadBall && this.engine.ticksToRestart > sec(4) && (this.goalTick === null || next > this.goalTick + sec(4))) {
        const from = next;
        while (this.engine.isDeadBall && this.engine.ticksToRestart > sec(1.5) && !this.engine.isFinished) {
          this.stepEngine();
          if (!this.halftimeShown && this.engine.tick >= TICKS_PER_HALF) break;
        }
        this.shownTick = this.engine.tick;
        if (this.shownTick > from) out.push({ t: 'skip', from: from * TICK_SECONDS, to: this.shownTick * TICK_SECONDS, scene: ++this.scene });
        this.release(this.shownTick, out);
        this.lastInterest = Math.max(this.lastInterest, this.shownTick);
      }
      // Szenenende
      const d = this.delta;
      const calm = d < -60 ? sec(2.5) : d < 0 ? sec(4) : sec(7);
      if ((this.goalTick !== null && next > this.goalTick + sec(4))
        || next - this.sceneStart > (d < -90 ? Math.min(this.maxLen, sec(12)) : this.maxLen)
        || (next > this.lastInterest + calm && d < 120)) {
        this.goalTick = null;
        this.state = 'seek';
        return;
      }
    }
  }
}
