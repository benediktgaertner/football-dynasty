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
  /** Sitzungskennung des Browsers (über Wiederverbindungen stabil) – Grundlage der Idempotenz */
  sid?: string;
}

/** Ein Manager, der kürzer als diese Zeit weg ist, behält die Kontrolle (kurze Verbindungsabbrüche ändern nichts am Spiel) */
export const AUTOPILOT_GRACE_MS = 20_000;
/** Backpressure: langsame Clients bekommen keine weiteren Bilder, extrem langsame werden getrennt */
const DROP_FRAMES_ABOVE = 512 * 1024;
const TERMINATE_ABOVE = 8 * 1024 * 1024;
const ACK_CACHE = 64;

const LOOP_MS = 25;
const CHECKPOINT_EVERY = 400; // alle 20 s Echtzeit (Seed + Befehlsprotokoll)
const START_COUNTDOWN_MS = 90_000; // spätestens 90 s nach Öffnen startet das Spiel automatisch
/** Einlaufzeremonie vor Pflichtspielen: für alle Teilnehmer gleich lang, der Anpfiff folgt serverseitig */
/** Ohne Hymne nur eine kurze Einlaufsequenz */
export const WALKOUT_MS = 12_000;
/** Mit hochgeladener Heimhymne: Einlauf = volle Hymnenlänge + kurzer Ausklang (höchstens 6 Minuten) */
export const ANTHEM_TAIL_MS = 2_500;
export const WALKOUT_MAX_MS = 360_000;
export function walkoutMsFor(anthemMs: number | null | undefined): number {
  if (!anthemMs || !Number.isFinite(anthemMs) || anthemMs <= 0) return WALKOUT_MS;
  return Math.min(WALKOUT_MAX_MS, Math.max(WALKOUT_MS, Math.round(anthemMs) + ANTHEM_TAIL_MS));
}

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
  /** Zeitpunkt des Anpfiffs nach der Einlaufzeremonie (Server-Uhr) */
  private walkoutUntil = 0;
  private walkoutStart = 0;
  private walkoutTimer: NodeJS.Timeout | null = null;
  /** Hymnenlänge noch unbekannt (ältere Uploads): der Heim-Manager meldet sie einmal */
  private anthemPending = false;
  /** Zustimmungen zum gemeinsamen Überspringen (Seiten mit Manager) */
  private skipVotes = new Set<Side>();
  /** Seit wann ist die Seite ohne verbundenen Manager (für die Karenzzeit vor der Automatik) */
  private offlineSince: Partial<Record<Side, number>> = {};
  private lastAutopilotCheck = 0;
  /** bereits beantwortete Befehle je Seite+Sitzung: gleicher Befehl (gleiche id) wird nicht erneut ausgeführt */
  private acks = new Map<string, Map<number, Record<string, unknown>>>();
  private ckptChain: Promise<void> = Promise.resolve();
  private ckptQueued = false;
  private ckptTimer: NodeJS.Timeout | null = null;
  /** Raum geschlossen: neue Verbindungen müssen einen frischen Raum laden */
  closed = false;

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
      // Die Manager müssen sich nach dem Neustart erst wieder verbinden: Karenzzeit statt sofortiger Automatik
      for (const side of ['home', 'away'] as const) this.offlineSince[side] = Date.now();
      this.begin();
    } else {
      this.engine = new MatchEngine(setup);
      this.status = 'waiting';
      // Pflichtspiele starten sofort (der Termin läuft bereits), Testspiele nach Anpfiff oder Countdown
      if (this.db.kind !== 'friendly') {
        // Einlauf: Teams, Hymne, Fangesang – der Anpfiff erfolgt für alle gleichzeitig. Überspringen ist
        // nur eine Anzeige beim Client und verändert den gemeinsamen Spielzustand nicht.
        const walkout = (this.db.stadium as { fans?: { walkout?: boolean } } | null | undefined)?.fans?.walkout !== false;
        if (walkout) {
          const anthem = this.anthem();
          this.anthemPending = !!anthem?.path && !(Number(anthem.duration) > 0);
          this.walkoutStart = Date.now();
          this.scheduleWalkout(walkoutMsFor(Number(anthem?.duration) > 0 ? Number(anthem!.duration) * 1000 : null));
        } else queueMicrotask(() => this.begin());
      } else this.autoStart = setTimeout(() => this.begin(), START_COUNTDOWN_MS / this.speed);
    }
  }

  private anthem(): { path?: string | null; duration?: number | null } | null {
    const fans = (this.db.stadium as { fans?: { audio?: { anthem?: { path?: string | null; duration?: number | null } | null } } } | null | undefined)?.fans;
    return fans?.audio?.anthem ?? null;
  }

  /** Anpfiff nach totalMs ab Einlaufbeginn (Server-Uhr), Zeitgeber neu setzen */
  private scheduleWalkout(totalMs: number): void {
    if (this.walkoutTimer) clearTimeout(this.walkoutTimer);
    this.walkoutTotal = totalMs;
    this.walkoutUntil = this.walkoutStart + totalMs / this.speed;
    this.walkoutTimer = setTimeout(() => this.begin(), Math.max(0, this.walkoutUntil - Date.now()));
  }
  private walkoutTotal = 0;

  /** Seiten, deren Manager zustimmen müssen: alle menschlichen Teams mit verbundenem Manager */
  private skipNeeded(): Side[] {
    return (['home', 'away'] as const).filter((s) => (s === 'home' ? this.db.home : this.db.away).control === 'human' && this.managerOnline(s));
  }

  private walkoutInfo() {
    return {
      t: 'walkout', ms: Math.max(0, this.walkoutUntil - Date.now()), totalMs: this.walkoutTotal / this.speed,
      skipVotes: [...this.skipVotes], skipNeeded: this.skipNeeded(),
    };
  }

  /** Hymne überspringen: KI-Partie sofort, Multiplayer erst wenn alle anwesenden Manager zugestimmt haben */
  handleSkipWalkout(c: Client): void {
    if (c.role === 'spectator') return this.send(c, { t: 'error', message: 'Zuschauer können den Einlauf nicht überspringen.' });
    if (this.status !== 'waiting' || this.walkoutUntil === 0) return;
    this.skipVotes.add(c.role);
    const needed = this.skipNeeded();
    if (needed.every((s) => this.skipVotes.has(s))) { this.begin(); return; }
    this.broadcast(this.walkoutInfo());
  }

  /** Länge der Heimhymne (vom Heim-Manager gemessen), einmalig, verlängert den Einlauf auf volle Länge */
  handleAnthemDuration(c: Client, durationMs: number): void {
    if (c.role !== 'home' || !this.anthemPending || this.status !== 'waiting' || this.walkoutUntil === 0) return;
    this.anthemPending = false;
    this.scheduleWalkout(walkoutMsFor(durationMs));
    this.broadcast(this.walkoutInfo());
  }

  private managerOnline(side: Side): boolean {
    for (const c of this.clients) if (c.role === side && c.ws.readyState === 1) return true;
    return false;
  }

  private updateAutopilot(): void {
    if (!this.engine || this.engine.isFinished) return;
    const now = Date.now();
    for (const side of ['home', 'away'] as const) {
      const team = side === 'home' ? this.db.home : this.db.away;
      if (team.control !== 'human') continue;
      // E4: abwesender Manager ⇒ Automatik (erst nach kurzer Karenzzeit); zurück ⇒ Manager übernimmt wieder
      if (this.managerOnline(side)) { delete this.offlineSince[side]; this.engine.setAutopilot(side, false); continue; }
      const since = (this.offlineSince[side] ??= now);
      if (now - since >= AUTOPILOT_GRACE_MS / this.speed) this.engine.setAutopilot(side, true);
    }
  }

  begin(): void {
    if (this.status === 'running' || this.status === 'finished') return;
    if (this.autoStart) clearTimeout(this.autoStart);
    if (this.walkoutTimer) clearTimeout(this.walkoutTimer);
    this.walkoutTimer = null;
    this.walkoutUntil = 0;
    this.skipVotes.clear();
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
    try {
      this.step();
    } catch (e) {
      // Fehler in einer Partie dürfen den Server (andere Räume, Spieltags-Sweep) nicht beenden
      console.error('Spielschleife abgebrochen', this.fixtureId, e);
      this.fail('Die Live-Übertragung wurde unterbrochen. Das Spiel wird automatisch zu Ende berechnet.');
    }
  }

  /** Raum aufgeben: Clients informieren, Raum schließen – die Partie berechnet danach der Spieltags-Sweep */
  private fail(message: string): void {
    if (this.status === 'finished' || this.status === 'failed') return;
    this.status = 'failed';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.broadcast({ t: 'status', status: 'failed' });
    this.broadcast({ t: 'error', message });
    void this.saveCheckpoint();
    setTimeout(() => this.close(), 2_000).unref();
  }

  private step(): void {
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
    if (now - this.lastAutopilotCheck > 500) { this.lastAutopilotCheck = now; this.updateAutopilot(); }
    // Matchnoten und Fitness laufend aktualisieren (Teamansicht spätestens alle 8 s)
    if (now - this.lastViewAt > 8000) { this.lastViewAt = now; this.sendViews(); }
    if (this.engine.tick - this.lastCheckpointTick >= CHECKPOINT_EVERY && !this.engine.isFinished) {
      this.lastCheckpointTick = this.engine.tick;
      void this.saveCheckpoint();
    }
  }

  /**
   * Seed + Befehlsprotokoll sichern. Speicherungen laufen nacheinander (nie ein älterer Stand nach einem neueren);
   * mehrere Anforderungen während einer laufenden Speicherung werden zu einer zusammengefasst.
   */
  saveCheckpoint(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'failed') return this.ckptChain;
    if (this.ckptQueued) return this.ckptChain;
    this.ckptQueued = true;
    this.ckptChain = this.ckptChain.then(async () => {
      this.ckptQueued = false;
      try {
        await this.backend.checkpoint(this.fixtureId, this.engine.tick, { tick: this.engine.tick, log: this.engine.commandLog });
      } catch (e) {
        console.error('Checkpoint fehlgeschlagen', this.fixtureId, e);
      }
    });
    return this.ckptChain;
  }

  /** Nach jedem angenommenen Befehl bald sichern: ein Neustart verliert dann keinen Wechsel und keine Taktik */
  private scheduleCheckpoint(): void {
    if (this.ckptTimer) return;
    this.ckptTimer = setTimeout(() => { this.ckptTimer = null; void this.saveCheckpoint(); }, 1000 / this.speed);
    this.ckptTimer.unref();
  }

  private async finish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const result = this.engine.result();
    let saved = false;
    let already = false;
    // Ergebnis nie verwerfen: erst 5 schnelle Versuche, danach bis zu 10 Minuten alle 30 s
    for (let attempt = 0; attempt < 25 && !saved; attempt++) {
      try {
        const r = await this.backend.finish(this.fixtureId, result); // idempotent
        already = (r as { status?: string } | void)?.status === 'already_saved';
        saved = true;
      } catch (e) {
        console.error('Ergebnis speichern fehlgeschlagen, neuer Versuch', e);
        if (attempt === 4) this.broadcast({ t: 'error', message: 'Ergebnis wird gespeichert – die Datenbank ist gerade ausgelastet.' });
        await new Promise((r) => setTimeout(r, (attempt < 5 ? 1000 * (attempt + 1) : 30_000) / this.speed));
      }
    }
    this.status = 'finished';
    // Wurde die Partie bereits anderweitig gespeichert, zählt das gespeicherte Ergebnis (Hinweis an die Clients)
    this.broadcast({ t: 'end', saved, alreadySaved: already, result: { score: result.score, stats: result.stats, players: result.players, playerOfTheMatch: result.playerOfTheMatch, possessionHome: result.possessionHome } });
    setTimeout(() => this.close(), 30_000 / this.speed).unref();
  }

  close(): void {
    this.closed = true;
    if (this.ckptTimer) clearTimeout(this.ckptTimer);
    if (this.timer) clearInterval(this.timer);
    if (this.autoStart) clearTimeout(this.autoStart);
    if (this.walkoutTimer) clearTimeout(this.walkoutTimer);
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

  join(c: Client, since = 0): void {
    // Dieselbe Person nur einmal je Raum: eine alte (ggf. halb tote) Verbindung wird abgelöst
    for (const o of [...this.clients]) {
      if (o.userId !== c.userId) continue;
      this.clients.delete(o);
      try { o.ws.close(4409, 'replaced'); } catch { /* schon zu */ }
    }
    this.clients.add(c);
    const all = this.presenter ? this.presenter.released : this.engine.events;
    // Client meldet, wie viele Ereignisse er schon hat ⇒ nur Verpasstes nachliefern (bei Rückschritt nach Neustart: alles)
    const from = since > 0 && since <= all.length ? since : 0;
    this.send(c, {
      t: 'init',
      role: c.role,
      status: this.status,
      // verbleibende Zeit bis zum Anpfiff (relativ, unabhängig von Uhrabweichungen der Geräte)
      walkoutMs: this.walkoutUntil > 0 ? Math.max(0, this.walkoutUntil - Date.now()) : 0,
      walkoutTotalMs: this.walkoutUntil > 0 ? this.walkoutTotal / this.speed : 0,
      skipVotes: [...this.skipVotes],
      skipNeeded: this.walkoutUntil > 0 ? this.skipNeeded() : [],
      fixtureId: this.fixtureId,
      kind: this.db.kind,
      stadium: this.db.stadium ?? null,
      teams: this.roster(),
      snapshot: this.presenter?.lastFrame ?? this.engine.snapshot(),
      scene: this.presenter?.scene ?? 0,
      events: from > 0 ? all.slice(from) : all,
      eventsFrom: from,
      view: c.role === 'spectator' ? null : this.engine.teamView(c.role),
    });
    if (this.status === 'running') this.updateAutopilot();
    // neuer Manager während des Einlaufs: alle sehen, wer noch zustimmen muss
    if (this.status === 'waiting' && this.walkoutUntil > 0 && c.role !== 'spectator') this.broadcast(this.walkoutInfo());
  }

  leave(c: Client): void {
    if (!this.clients.delete(c)) return; // bereits abgelöst
    if (c.role !== 'spectator' && !this.managerOnline(c.role)) this.offlineSince[c.role] ??= Date.now();
    // Manager weg: ggf. haben jetzt alle verbliebenen Manager zugestimmt
    if (this.status === 'waiting' && this.walkoutUntil > 0 && this.skipVotes.size > 0) {
      const needed = this.skipNeeded();
      if (needed.every((s) => this.skipVotes.has(s))) this.begin(); else this.broadcast(this.walkoutInfo());
    }
    if (this.status === 'running') this.updateAutopilot();
  }

  handleStart(c: Client): void {
    if (c.role === 'spectator') return this.send(c, { t: 'error', message: 'Zuschauer können das Spiel nicht starten.' });
    // Pflichtspiele: Anpfiff nach der Einlaufzeremonie für alle gleichzeitig (Überspringen ist nur lokal)
    if (this.status === 'waiting' && this.walkoutUntil === 0) this.begin();
  }

  handleCommand(c: Client, id: number, cmd: MatchCommand): void {
    if (c.role === 'spectator') return this.send(c, { t: 'ack', id, ok: false, error: 'Zuschauer können nichts ändern.' });
    // Idempotenz: ein erneut gesendeter Befehl (z. B. nach Verbindungsabbruch) wird nicht ein zweites Mal ausgeführt
    const key = c.sid ? `${c.role}:${c.sid}` : null;
    const known = key ? this.acks.get(key)?.get(id) : undefined;
    if (known) { this.send(c, { ...known, dup: true }); this.sendView(c.role); return; }
    // Schutz vor Befehlsfluten: höchstens 10 Befehle pro Sekunde
    const now = Date.now();
    c.cmdWindow = c.cmdWindow.filter((t) => now - t < 1000);
    if (c.cmdWindow.length >= 10) return this.send(c, { t: 'ack', id, ok: false, error: 'Zu viele Befehle.' });
    c.cmdWindow.push(now);
    if (this.status === 'finished') return this.send(c, { t: 'ack', id, ok: false, error: 'Die Partie ist beendet.' });
    const res = this.engine.applyCommand(c.role, cmd);
    const ack = { t: 'ack', id, ok: res.ok, error: res.ok ? undefined : res.error, tick: this.engine.tick };
    if (key) {
      let m = this.acks.get(key);
      if (!m) this.acks.set(key, (m = new Map()));
      m.set(id, ack);
      if (m.size > ACK_CACHE) m.delete(m.keys().next().value as number);
    }
    this.send(c, ack);
    if (res.ok) { this.sendView(c.role); this.scheduleCheckpoint(); }
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
    const droppable = (msg as { t?: string }).t === 'frame';
    for (const c of this.clients) {
      if (c.ws.readyState !== 1) continue;
      const queued = c.ws.bufferedAmount;
      if (queued > TERMINATE_ABOVE) { c.ws.terminate(); continue; }
      // Langsame Verbindung: Bilder auslassen (Ereignisse und Zustand gehen nie verloren, das nächste Bild folgt in 100 ms)
      if (droppable && queued > DROP_FRAMES_ABOVE) continue;
      c.ws.send(data);
    }
  }
}
