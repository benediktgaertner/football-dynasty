import {
  PLAYBACK_MS_PER_TICK,
  TICKS_PER_HALF,
  type MatchEngine,
  type MatchEvent,
  type Snapshot,
} from '@fd/engine';

/**
 * Wiedergabe: Die komplette Partie wird durchgehend gezeigt – ohne Szenensprünge.
 * Je Tick 0,1 s Bewegungszeit, abgespielt mit 2-facher Geschwindigkeit (50 ms Echtzeit je Tick).
 * Die Spieluhr läuft unabhängig davon schneller (1,5 s je Tick ⇒ ca. 90 s Echtzeit je Halbzeit).
 *
 * Die Engine rechnet im Gleichschritt mit der Anzeige: Was gezeigt wird, ist der aktuelle Zustand,
 * und jeder Eingriff (Taktik, Wechsel) wirkt ab dem nächsten Tick. Alle Clients bekommen denselben
 * Nachrichtenstrom ⇒ identische Partie für alle.
 */

export type PresenterMessage =
  | { t: 'frame'; s: Snapshot; scene: number }
  | { t: 'ev'; events: MatchEvent[] }
  | { t: 'skip'; from: number; to: number; scene: number }
  | { t: 'status'; status: 'running' | 'halftime' }
  | { t: 'done' };

const FRAME_EVERY = 2; // jeder 2. Tick ⇒ 10 Bilder je Sekunde
const HALFTIME_MS = 3000;

export interface PresenterOptions {
  /** bereits verstrichene Echtzeit (bei Wiederaufnahme) – nur für die Anzeige */
  startRealMs?: number;
}

export class Presenter {
  state: 'play' | 'pause' | 'done' = 'play';
  realMs: number;
  shownTick: number;
  /** wechselt bei Schnitten (Anstoß, Standard-Neuaufstellung, Wechsel), damit nicht über Neuaufstellungen interpoliert wird */
  scene = 0;
  lastFrame: Snapshot;
  readonly released: MatchEvent[] = [];
  private pauseMs = 0;
  private acc = 0;
  private halftimeShown: boolean;

  constructor(private engine: MatchEngine, opts: PresenterOptions = {}) {
    this.realMs = opts.startRealMs ?? 0;
    this.shownTick = engine.tick;
    this.released.push(...engine.events);
    this.lastFrame = engine.snapshot();
    this.halftimeShown = engine.tick >= TICKS_PER_HALF;
  }

  private release(out: PresenterMessage[]): void {
    const ev = this.engine.events;
    if (ev.length > this.released.length) {
      const fresh = ev.slice(this.released.length);
      this.released.push(...fresh);
      out.push({ t: 'ev', events: fresh });
    }
  }

  /** Echtzeit fortschreiben (ms, ggf. mit Testgeschwindigkeit skaliert). Liefert die zu sendenden Nachrichten. */
  advance(dtMs: number): PresenterMessage[] {
    const out: PresenterMessage[] = [];
    if (this.state === 'done') return out;
    this.realMs += dtMs;
    if (this.state === 'pause') {
      this.pauseMs -= dtMs;
      if (this.pauseMs > 0) return out;
      this.state = 'play';
      this.acc = 0;
      out.push({ t: 'status', status: 'running' });
      return out;
    }
    this.acc += dtMs;
    while (this.acc >= PLAYBACK_MS_PER_TICK) {
      this.acc -= PLAYBACK_MS_PER_TICK;
      this.engine.step();
      this.shownTick = this.engine.tick;
      if (this.engine.takeCut()) this.scene++;
      if (this.shownTick % FRAME_EVERY === 0 || this.engine.isFinished) {
        this.lastFrame = this.engine.snapshot();
        out.push({ t: 'frame', s: this.lastFrame, scene: this.scene });
      }
      this.release(out);
      if (this.engine.isFinished) {
        this.state = 'done';
        out.push({ t: 'done' });
        return out;
      }
      if (!this.halftimeShown && this.shownTick >= TICKS_PER_HALF) {
        this.halftimeShown = true;
        this.scene++;
        this.lastFrame = this.engine.snapshot();
        out.push({ t: 'frame', s: this.lastFrame, scene: this.scene });
        out.push({ t: 'status', status: 'halftime' });
        this.state = 'pause';
        this.pauseMs = HALFTIME_MS;
        return out;
      }
    }
    return out;
  }
}
