import type { WebSocket } from 'ws';
import { MatchEngine, TOTAL_TICKS, MATCH_REAL_SECONDS, replay, type CommandRecord, type MatchCommand, type Side } from '@fd/engine';
import { Presenter } from './presenter.js';
import type { Backend } from './backend.js';
import { toEngineSetup, type DbSetup } from './setup.js';

export interface Client {
  ws: WebSocket;
  userId: string;
  role: Side | 'spectator';
  cmdWindow: number[];
}

const LOOP_MS = 25;
const CHECKPOINT_EVERY = 400; // alle 20 s Echtzeit (Seed + Befehlsprotokoll)
const START_COUNTDOWN_MS = 90_000; // spätestens 90 s nach Öffnen startet das Spiel automatisch

/**
 * Ein Raum = eine Partie. Der Server ist autoritativ: Clients senden nur Befehle,
 * Simulation, Zufall und Ergebnis entstehen ausschließlich hier.
 */
export class MatchRoom {
  readonly fixtureId: string;
  readonly clients = new Set<Client>();
  engine!: MatchEngine;
  db!: DbSetup;
  status: 'loading' | 'waiting' | 'running' | 'finished' | 'failed' = 'loading';
  private timer: NodeJS.Timeout | null = null;
  presenter: Presenter | null = null;
  private lastLoop = 0;
  private lastCheckpointTick = 0;
  private autoStart: NodeJS.Timeout | null = null;
  private onClose: () => void;
  private finishing = false;

  constructor(fixtureId: string, private backend: Backend, onClose: () => void, private speed = 1) {
    this.fixtureId = fixtureId;
    this.onClose = onClose;
  }

  async load(): Promise<void> {
    this.db = await this.backend.setup(this.fixtureId);
    const setup = toEngineSetup(this.db);
    const cp = this.db.checkpoint;
    if (cp && Array.isArray(cp.log) && cp.tick > 0) {
      // Wiederaufnahme nach Neustart: Seed + Befehle deterministisch nachspielen
      this.engine = replay(setup, cp.log as CommandRecord[], cp.tick);
      this.lastCheckpointTick = cp.tick;
      this.begin();
    } else {
      this.engine = new MatchEngine(setup);
      this.status = 'waiting';
      // Pflichtspiele starten sofort (der Termin läuft bereits), Testspiele nach Anpfiff oder Countdown
      if (this.db.kind !== 'friendly') queueMicrotask(() => this.begin());
      else this.autoStart = setTimeout(() => this.begin(), START_COUNTDOWN_MS / this.speed);
    }
  }

  private managerOnline(side: Side): boolean {
    for (const c of this.clients) if (c.role === side && c.ws.readyState === 1) return true;
    return false;
  }

  private updateAutopilot(): void {
    if (!this.engine || this.engine.isFinished) return;
    for (const side of ['home', 'away'] as const) {
      const team = side === 'home' ? this.db.home : this.db.away;
      if (team.control !== 'human') continue;
      // E4: abwesender Manager ⇒ Automatik; zurück ⇒ Manager übernimmt wieder
      this.engine.setAutopilot(side, !this.managerOnline(side));
    }
  }

  begin(): void {
    if (this.status === 'running' || this.status === 'finished') return;
    if (this.autoStart) clearTimeout(this.autoStart);
    this.updateAutopilot();
    this.status = 'running';
    // Bei Wiederaufnahme: Zeitbudget anteilig fortsetzen
    const startRealMs = (this.engine.tick / TOTAL_TICKS) * MATCH_REAL_SECONDS * 1000;
    this.presenter = new Presenter(this.engine, { startRealMs });
    this.lastLoop = Date.now();
    this.broadcast({ t: 'status', status: 'running' });
    this.timer = setInterval(() => this.loop(), LOOP_MS);
  }

  private loop(): void {
    const now = Date.now();
    const dt = Math.min(500, now - this.lastLoop) * this.speed;
    this.lastLoop = now;
    const p = this.presenter!;
    for (const m of p.advance(dt)) {
      if (m.t === 'done') { void this.finish(); continue; }
      this.broadcast(m);
      // Manager sehen ihr Team nach Ereignissen (Wechsel, Karten, Verletzungen) aktualisiert
      if (m.t === 'ev' && m.events.some((e) => ['goal', 'sub', 'yellow', 'second_yellow', 'red', 'injury', 'tactic', 'halftime'].includes(e.type))) this.sendViews();
    }
    // Matchnoten und Fitness laufend aktualisieren (Teamansicht spätestens alle 8 s)
    if (now - this.lastViewAt > 8000) { this.lastViewAt = now; this.sendViews(); }
    if (this.engine.tick - this.lastCheckpointTick >= CHECKPOINT_EVERY && !this.engine.isFinished) {
      this.lastCheckpointTick = this.engine.tick;
      void this.saveCheckpoint();
    }
  }

  async saveCheckpoint(): Promise<void> {
    if (this.status !== "running") return;
    try {
      await this.backend.checkpoint(this.fixtureId, this.engine.tick, { tick: this.engine.tick, log: this.engine.commandLog });
    } catch (e) {
      console.error('Checkpoint fehlgeschlagen', this.fixtureId, e);
    }
  }

  private async finish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const result = this.engine.result();
    let saved = false;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      try {
        await this.backend.finish(this.fixtureId, result); // idempotent
        saved = true;
      } catch (e) {
        console.error('Ergebnis speichern fehlgeschlagen, neuer Versuch', e);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    this.status = 'finished';
    this.broadcast({ t: 'end', saved, result: { score: result.score, stats: result.stats, players: result.players, playerOfTheMatch: result.playerOfTheMatch, possessionHome: result.possessionHome } });
    setTimeout(() => this.close(), 30_000 / this.speed).unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.autoStart) clearTimeout(this.autoStart);
    for (const c of this.clients) c.ws.close(1000, 'match_closed');
    this.clients.clear();
    this.onClose();
  }

  roster() {
    const team = (t: DbSetup['home']) => ({
      clubId: t.clubId, name: t.name, shortName: t.shortName, color: t.color, colorAlt: t.colorAlt, kit: t.kit ?? null, control: t.control,
      players: t.squad.map((p) => ({ id: p.id, shirt: p.shirt, name: p.name, first_name: p.first_name, position: p.main_position, overall: p.overall, region: p.region, age: p.age })),
    });
    return { home: team(this.db.home), away: team(this.db.away) };
  }

  join(c: Client): void {
    this.clients.add(c);
    this.send(c, {
      t: 'init',
      role: c.role,
      status: this.status,
      fixtureId: this.fixtureId,
      kind: this.db.kind,
      stadium: this.db.stadium ?? null,
      teams: this.roster(),
      snapshot: this.presenter?.lastFrame ?? this.engine.snapshot(),
      scene: this.presenter?.scene ?? 0,
      events: this.presenter ? this.presenter.released : this.engine.events,
      view: c.role === 'spectator' ? null : this.engine.teamView(c.role),
    });
    if (this.status === 'running') this.updateAutopilot();
  }

  leave(c: Client): void {
    this.clients.delete(c);
    if (this.status === 'running') this.updateAutopilot();
  }

  handleStart(c: Client): void {
    if (c.role === 'spectator') return this.send(c, { t: 'error', message: 'Zuschauer können das Spiel nicht starten.' });
    if (this.status === 'waiting') this.begin();
  }

  handleCommand(c: Client, id: number, cmd: MatchCommand): void {
    if (c.role === 'spectator') return this.send(c, { t: 'ack', id, ok: false, error: 'Zuschauer können nichts ändern.' });
    // Schutz vor Befehlsfluten: höchstens 10 Befehle pro Sekunde
    const now = Date.now();
    c.cmdWindow = c.cmdWindow.filter((t) => now - t < 1000);
    if (c.cmdWindow.length >= 10) return this.send(c, { t: 'ack', id, ok: false, error: 'Zu viele Befehle.' });
    c.cmdWindow.push(now);
    if (this.status === 'finished') return this.send(c, { t: 'ack', id, ok: false, error: 'Die Partie ist beendet.' });
    const res = this.engine.applyCommand(c.role, cmd);
    this.send(c, { t: 'ack', id, ok: res.ok, error: res.ok ? undefined : res.error, tick: this.engine.tick });
    if (res.ok) this.sendView(c.role);
  }

  private lastViewAt = 0;
  private sendViews(): void {
    this.lastViewAt = Date.now();
    for (const side of ['home', 'away'] as const) this.sendView(side);
  }
  private sendView(side: Side): void {
    const view = this.engine.teamView(side);
    for (const c of this.clients) if (c.role === side) this.send(c, { t: 'view', view });
  }

  private send(c: Client, msg: unknown): void {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }
  broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(data);
  }
}
