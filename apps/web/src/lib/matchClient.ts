import { requireSupabase } from './supabase';

/** Typen entsprechen packages/engine/src/types.ts (nur die Felder, die die Oberfläche braucht). */
export type Side = 'home' | 'away';
export type ProfileName = 'offensive' | 'neutral' | 'defensive';
export interface Snapshot {
  tick: number; clock?: number; minute: number; phase: 'pre' | 'first' | 'second' | 'end'; score: [number, number];
  ball: [number, number, number?]; possession: Side | null; carrier?: string | null; intensity?: number; players: Array<[string, number, number]>; red: [number, number];
  activeProfile: [ProfileName, ProfileName];
  /** Art des fliegenden Balls (flach, hoch, Steilpass, Flanke, Schuss, Standard) */
  ballKind?: 'ground' | 'lofted' | 'through' | 'cross' | 'shot' | 'set_piece' | null;
  /** Standard in Vorbereitung (Ecke, Freistoß mit Mauer, Elfmeter) */
  setPiece?: { kind: 'corner' | 'free_kick' | 'penalty'; side: Side; wall: string[] } | null;
}
export interface MatchEvent { tick: number; minute: number; type: string; side: Side | null; playerId?: string; otherId?: string; text: string; xg?: number }
export interface RosterPlayer { id: string; shirt: number; name: string; first_name?: string; position: string; overall: number; age?: number; region?: string }
export interface RosterTeam { clubId: string; name: string; shortName: string; color: string; colorAlt: string; kit: { pattern: string; primary: string; secondary: string } | null; control: 'human' | 'ai'; players: RosterPlayer[] }
export interface TeamView {
  profile: ProfileName;
  team_instructions: Record<string, number | string>;
  subsUsed: number; subWindowsUsed: number; pendingSubs: Array<{ outId: string; inId: string }>; autopilot: boolean;
  players: Array<{ id: string; shirt: number; name: string; position: string; main: string; overall: number; fitness: number; onPitch: boolean; subbedOff: boolean; sentOff: boolean; injured: boolean; yellow: number; x: number; y: number; instructions: string[]; unavailable: boolean; rating?: number | null }>;
}
export interface TeamStats { goals: number; shots: number; shotsOnTarget: number; xg: number; passes: number; passesCompleted: number; possessionTicks: number; fouls: number; corners: number; offsides: number; yellow: number; red: number; subsUsed: number }
export interface PlayerStats { playerId: string; side: Side; minutes: number; goals: number; assists: number; shots: number; shotsOnTarget: number; xg: number; passes: number; passesCompleted: number; tacklesWon: number; saves: number; yellow: number; red: boolean; injured: boolean; fitnessEnd: number; rating: number }
export interface EndResult { score: [number, number]; stats: { home: TeamStats; away: TeamStats }; players: PlayerStats[]; playerOfTheMatch: string | null; possessionHome: number }

export type Command =
  | { kind: 'profile'; name: ProfileName }
  | { kind: 'settings'; team_instructions: Record<string, number | string> }
  | { kind: 'sub'; outId: string; inId: string }
  | { kind: 'move'; playerId: string; x: number; y: number }
  | { kind: 'instructions'; playerId: string; codes: string[] };

export interface MatchState {
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';
  error: string | null;
  /** Wiederverbindung: aktueller Versuch, erlaubte Versuche und Beginn der Unterbrechung (lokale Uhr) */
  reconnect: { attempt: number; max: number; since: number } | null;
  /** Zeitpunkt der letzten erfolgreichen Wiederverbindung (für die Anzeige „Verbindung wiederhergestellt“) */
  recoveredAt: number | null;
  /** Dasselbe Spiel wurde in einem anderen Fenster/Gerät geöffnet */
  replaced: boolean;
  role: Side | 'spectator' | null;
  status: 'loading' | 'waiting' | 'running' | 'halftime' | 'finished' | 'failed';
  /** Zuletzt übersprungene Spielphase (Regie) */
  skip: { from: number; to: number; at: number } | null;
  teams: { home: RosterTeam; away: RosterTeam } | null;
  events: MatchEvent[];
  view: TeamView | null;
  latest: Snapshot | null;
  end: { saved: boolean; result: EndResult } | null;
  kind: string | null;
  /** Stadion (Design + Zuschauerzahl) für Tribünen und Fans */
  stadium: StadiumView | null;
  /** Anpfiff nach der Einlaufzeremonie (lokale Uhr, aus der vom Server gemeldeten Restzeit) */
  walkoutEndsAt: number | null;
  /** Beginn und Gesamtdauer des Einlaufs (lokale Uhr) – für synchronen Hymnenstart */
  walkoutStartedAt: number | null;
  walkoutTotalMs: number;
  /** Gemeinsames Überspringen: wer schon zugestimmt hat / wer zustimmen muss */
  walkoutSkip: { votes: Array<'home' | 'away'>; needed: Array<'home' | 'away'> };
}

/**
 * WebSocket-Client: Authentifizierung per Supabase-Token, automatische Wiederverbindung
 * (exponentielles Backoff) und Snapshot-Puffer für flüssige Interpolation (~100 ms Verzögerung).
 */
export type Weather = 'sunny' | 'cloudy' | 'rain' | 'heavy_rain' | 'snow' | 'fog';
/** Stadion, Wetter und Atmosphäre – vom Server im Setup bestimmt, für alle Teilnehmer identisch (rein optisch) */
export interface StadiumView {
  name: string; capacity: number; attendance: number | null; design: StadiumDesign;
  weather?: Weather | null;
  atmosphere?: { choreo: boolean; banners: boolean; pyro_seed: number } | null;
  competition?: { kind: string; tier: number | null; association: string | null; name: string } | null;
  /** Fankultur und Stadionsound des Heimvereins */
  fans?: FanView | null;
}
export interface FlagDesign { shape: 'rect' | 'square' | 'triangle' | 'swallow' | 'banner'; size: 's' | 'm' | 'l'; pattern: 'solid' | 'stripes_h' | 'stripes_v' | 'diagonal' | 'halves' | 'cross' | 'checker' | 'star'; colors: string[]; text?: string;
  /** Anzahl dieser Fahne in der Heimkurve (1–12) und Verteilung entlang der Kurve (0 = oben, 1 = unten) */
  count?: number; from?: number; to?: number }
/** Bereich auf den Tribünen in Stadion-Metern (Spielfeld 105 × 68, Ursprung linke obere Ecke) */
export interface StandArea { x: number; y: number; w: number; h: number }
export type StandBlock = 'home_curve' | 'main_stand' | 'back_stand' | 'corner_left' | 'corner_right';
export interface UltraGroup { id: string; name: string; colors: string[]; banner?: string; block?: StandBlock; area?: StandArea | null; flags?: number; flag?: FlagDesign | null }
export interface ChoreoDesign { pattern: 'stripes' | 'blocks' | 'checker' | 'wave' | 'gradient' | 'rays' | 'mosaic'; colors: string[]; text?: string; motif?: 'none' | 'star' | 'heart' | 'crown' | 'crest' | 'lion' | 'eagle' | 'anchor' | 'castle'; block?: 'home_curve' | 'main_stand' | 'back_stand' | 'all'; name?: string }
export interface AudioRef { id: string; name: string; source: 'upload'; path: string | null; volume: number; situation?: string | null; signature?: boolean; duration?: number | null; club_id?: string }
export interface FanClub { id: string; name: string; short: string; control: 'human' | 'ai'; colors: [string | null, string | null] }
export interface FanView { flags: FlagDesign[]; ultras: UltraGroup[]; choreo: ChoreoDesign | null; audio: { anthem: AudioRef | null; signature: AudioRef | null; chants: AudioRef[] }; walkout: boolean;
  home_club?: FanClub; away?: FanClub & { flags: FlagDesign[]; ultra: UltraGroup | null; chants?: Array<AudioRef & { signature?: boolean }> } }
export interface StadiumDesign { style?: 'classic' | 'modern' | 'arena' | 'traditional'; stand?: string; seat?: string; accent?: string; club_colors?: boolean; roof?: boolean }

/** Höchstzahl automatischer Wiederverbindungsversuche (≈ 1 Minute), danach Schaltfläche „Neu verbinden“ */
export const MAX_RECONNECTS = 15;
const PING_EVERY_MS = 8000;
/** Länger keine Nachricht (Bilder kommen 10/s, Ping-Antworten alle 8 s) ⇒ Verbindung gilt als tot (halboffener Socket) */
const STALE_AFTER_MS = 20000;
/** Unbestätigte Befehle werden nach dem Wiederverbinden höchstens so lange noch nachgereicht */
const RESEND_WINDOW_MS = 20000;

export class MatchClient {
  state: MatchState = { connection: 'connecting', error: null, reconnect: null, recoveredAt: null, replaced: false, role: null, status: 'loading', skip: null, teams: null, events: [], view: null, latest: null, end: null, kind: null, stadium: null, walkoutEndsAt: null, walkoutStartedAt: null, walkoutTotalMs: 0, walkoutSkip: { votes: [], needed: [] } };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private buffer: Array<{ at: number; s: Snapshot }> = [];
  private nextId = 1;
  private pending = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  /** gesendet, aber noch nicht bestätigt: wird nach einer Wiederverbindung mit derselben id erneut gesendet (Server dedupliziert) */
  private inflight = new Map<number, { cmd: Command; at: number }>();
  private retry = 0;
  private gotInit = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private lastMsgAt = 0;
  private lastPingAt = 0;
  private downSince: number | null = null;
  private scene = 0;
  /** Zeitpunkt des letzten Schnitts (für kurze Überblendung) */
  cutAt = 0;
  private stopped = false;
  private fatal = false;
  private tokenRetried = false;
  /** bleibt über alle Wiederverbindungen gleich: Grundlage für idempotente Befehle auf dem Server */
  private readonly sid = (globalThis.crypto?.randomUUID?.() ?? `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).slice(0, 36);

  /** opts.token: eigene Token-Quelle (E2E-Tests ohne Supabase) */
  constructor(private url: string, private fixtureId: string, private opts: { token?: () => Promise<string | null> } = {}) {}

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(patch: Partial<MatchState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }

  /** Verbindung aufbauen (auch nach close(), z. B. React-StrictMode: mount → unmount → mount) */
  async connect(): Promise<void> {
    this.stopped = false;
    this.attachPageListeners();
    return this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    let token: string | null | undefined;
    try {
      if (this.opts.token) token = await this.opts.token();
      else {
        const { data } = await requireSupabase().auth.getSession();
        token = data.session?.access_token;
        // Token läuft bald ab (oder war abgelaufen): vor jedem Verbindungsversuch erneuern
        if (data.session && (this.tokenRetried || (data.session.expires_at ?? 0) * 1000 < Date.now() + 60_000)) {
          token = (await requireSupabase().auth.refreshSession()).data.session?.access_token ?? token;
        }
      }
    } catch {
      // Netz weg: Token kann gerade nicht gelesen/erneuert werden ⇒ normal weiter versuchen
      if (!this.stopped) this.scheduleReconnect();
      return;
    }
    if (!token) { this.emit({ connection: 'error', error: 'Nicht angemeldet.' }); return; }
    // Seite wurde während des Verbindungsaufbaus verlassen: keinen verwaisten Socket öffnen
    if (this.stopped) return;
    this.detach();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.gotInit = false;
    this.lastMsgAt = performance.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // since: schon bekannte Ereignisse – der Server liefert nur das Verpasste nach
      ws.send(JSON.stringify({ t: 'hello', token, fixtureId: this.fixtureId, sid: this.sid, ...(this.state.teams ? { since: this.state.events.length } : {}) }));
      // Antwortet der Server nicht, neu verbinden statt endlos zu warten
      clearTimeout(this.initTimer);
      this.initTimer = setTimeout(() => { if (this.ws === ws && !this.gotInit) this.dropped(ws, 4008); }, 12000);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastMsgAt = performance.now();
      let m: unknown;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      this.onMessage(m);
    };
    ws.onerror = () => { /* onclose folgt */ };
    ws.onclose = (e) => { if (this.ws === ws) this.dropped(ws, e.code); };
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.tick(ws), 2000);
  }

  /** Alten Socket lösen, ohne dass dessen Ereignisse noch etwas bewirken (verhindert doppelte Verbindungen/Nachrichten) */
  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.watchdog);
    clearTimeout(this.initTimer);
    if (!ws) return;
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
    try { ws.close(1000, 'leave'); } catch { /* bereits geschlossen */ }
  }

  /** Alle 2 s: Ping senden und tote (halboffene) Verbindungen erkennen, z. B. WLAN-Wechsel oder iPad im Ruhezustand */
  private tick(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || !this.gotInit) return;
    const now = performance.now();
    for (const [id, f] of this.inflight) if (Date.now() - f.at > 60_000) this.inflight.delete(id);
    if (now - this.lastMsgAt > STALE_AFTER_MS) { this.dropped(ws, 4009); return; }
    if (now - this.lastPingAt >= PING_EVERY_MS) { this.lastPingAt = now; try { ws.send('{"t":"ping"}'); } catch { /* close folgt */ } }
  }

  private pageListeners = false;
  private onOnline = () => this.nudge();
  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    this.nudge();
    // iPad/Safari beendet Sockets im Hintergrund oft lautlos: sofort prüfen, ob die Verbindung noch lebt
    const ws = this.ws;
    if (ws && this.gotInit && ws.readyState === WebSocket.OPEN) {
      const t = performance.now();
      this.lastPingAt = t;
      try { ws.send('{"t":"ping"}'); } catch { /* close folgt */ }
      setTimeout(() => { if (this.ws === ws && this.lastMsgAt < t) this.dropped(ws, 4009); }, 3000);
    }
  };
  private attachPageListeners(): void {
    if (this.pageListeners || typeof window === 'undefined') return;
    this.pageListeners = true;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('pageshow', this.onOnline);
    document.addEventListener('visibilitychange', this.onVisible);
  }
  private detachPageListeners(): void {
    if (!this.pageListeners || typeof window === 'undefined') return;
    this.pageListeners = false;
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('pageshow', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
  }
  /** Netz wieder da / Seite wieder sichtbar: nicht auf den nächsten Backoff warten */
  private nudge(): void {
    if (this.stopped || this.fatal || this.state.status === 'finished') return;
    if (this.state.connection === 'reconnecting' && !this.ws) { clearTimeout(this.retryTimer); void this.open(); }
  }

  /** Verbindung ist weg (Close, Zeitüberschreitung, tot): Zustand behalten, Wiederverbindung planen */
  private dropped(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return;
    this.detach();
    // Bereits abgeschickte, unbestätigte Befehle: Aufrufer sofort informieren, Befehl aber nachreichen (gleiche id ⇒ kein Doppel)
    for (const [, r] of this.pending) { r({ ok: false, error: 'Verbindung unterbrochen – der Befehl wird nach dem Wiederverbinden automatisch geprüft.' }); }
    this.pending.clear();
    if (this.stopped || this.fatal || this.state.status === 'finished') {
      this.emit({ connection: this.state.error ? 'error' : 'closed' });
      return;
    }
    if (code === 4409) {
      this.fatal = true;
      this.emit({ connection: 'error', replaced: true, error: 'Dieses Spiel ist in einem anderen Fenster oder auf einem anderen Gerät geöffnet.' });
      return;
    }
    if (code === 4401 && !this.tokenRetried && !this.opts.token) {
      // Sitzung abgelaufen: einmal mit erneuertem Token versuchen, bevor aufgegeben wird
      this.tokenRetried = true;
      this.scheduleReconnect(true);
      return;
    }
    if (code === 4401 || code === 4403 || code === 4500) {
      this.emit({ connection: 'error', error: this.state.error ?? (code === 4401 ? 'Sitzung abgelaufen – bitte neu anmelden.' : code === 4403 ? 'Kein Zugriff auf dieses Spiel.' : 'Das Spiel ist nicht mehr verfügbar.') });
      return;
    }
    // Nie verbunden und mehrfach gescheitert ⇒ verständliche Diagnose statt Endlos-Spinner
    if (!this.state.teams && this.retry >= 3) {
      const host = this.url.replace(/^ws/, 'http').replace(/\/match$/, '');
      this.fatal = true;
      this.emit({
        connection: 'error', reconnect: null,
        error: `Der Match-Server antwortet nicht (${host}). Prüfe ${host}/health – dort muss "implemented": true stehen. ` +
          `Auf Fly.io muss das Secret ALLOWED_ORIGINS genau ${window.location.origin} enthalten.`,
      });
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(immediate = false): void {
    if (this.stopped) return;
    if (this.downSince === null) this.downSince = Date.now();
    if (this.retry >= MAX_RECONNECTS) {
      this.downSince = null;
      this.emit({ connection: 'error', reconnect: null, error: 'Die Verbindung zum Match-Server konnte nicht wiederhergestellt werden. Die Partie läuft auf dem Server weiter – nichts geht verloren.' });
      return;
    }
    // exponentieller Backoff (max. 5 s) mit Streuung, damit nicht alle Clients gleichzeitig anklopfen
    const base = Math.min(5000, 400 * 2 ** this.retry);
    const delay = immediate ? 0 : Math.round(base * (0.75 + Math.random() * 0.5));
    this.retry++;
    this.emit({ connection: 'reconnecting', reconnect: { attempt: this.retry, max: MAX_RECONNECTS, since: this.downSince } });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  close(): void {
    this.stopped = true;
    this.detachPageListeners();
    clearTimeout(this.retryTimer);
    this.detach();
    for (const [, r] of this.pending) r({ ok: false, error: 'Verbindung beendet.' });
    this.pending.clear();
    this.inflight.clear();
  }

  /** Nach einem Fehler erneut versuchen */
  retryNow(): void {
    this.fatal = false; this.stopped = false; this.retry = 0; this.tokenRetried = false; this.downSince = null;
    this.attachPageListeners();
    this.emit({ error: null, replaced: false, reconnect: null, connection: this.state.teams ? 'reconnecting' : 'connecting' });
    void this.open();
  }

  private onMessage(m: any): void {
    switch (m.t) {
      case 'init': {
        const reconnected = this.downSince !== null;
        this.retry = 0;
        this.tokenRetried = false;
        this.downSince = null;
        this.gotInit = true;
        this.lastPingAt = performance.now();
        clearTimeout(this.initTimer);
        this.scene = m.scene ?? 0;
        this.buffer = [{ at: performance.now(), s: m.snapshot }];
        // Ereignisse: der Server liefert ab eventsFrom nach – bereits Bekanntes bleibt unverändert (keine Duplikate, keine Lücke)
        const from = Number(m.eventsFrom ?? 0);
        const events = from > 0 && from <= this.state.events.length ? [...this.state.events.slice(0, from), ...m.events] : m.events;
        this.emit({ connection: 'open', error: null, reconnect: null, recoveredAt: reconnected ? Date.now() : this.state.recoveredAt, role: m.role, status: m.status, teams: m.teams, events, view: m.view, latest: m.snapshot, kind: m.kind, stadium: m.stadium ?? null,
          ...this.walkoutFrom(m.status === 'waiting' ? Number(m.walkoutMs) : 0, Number(m.walkoutTotalMs ?? 0), m.skipVotes, m.skipNeeded) });
        // Unbestätigte Befehle vor dem Abbruch: mit derselben id erneut senden (Server führt sie höchstens einmal aus)
        const now = Date.now();
        for (const [id, f] of [...this.inflight]) {
          if (now - f.at > RESEND_WINDOW_MS) { this.inflight.delete(id); continue; }
          if (this.state.role !== 'home' && this.state.role !== 'away') { this.inflight.delete(id); continue; }
          this.ws?.send(JSON.stringify({ t: 'cmd', id, cmd: f.cmd }));
        }
        break;
      }
      case 'frame':
        // Neue Szene (Schnitt/Sprung): nicht über den Schnitt hinweg interpolieren
        if (m.scene !== this.scene) { this.scene = m.scene; this.buffer = []; this.cutAt = performance.now(); }
        this.buffer.push({ at: performance.now(), s: m.s });
        if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
        // Anzeige (Uhr/Score) nur bei Änderung neu rendern; Positionen zeichnet das Canvas selbst
        if (!this.state.latest || m.s.minute !== this.state.latest.minute || m.s.score[0] !== this.state.latest.score[0] || m.s.score[1] !== this.state.latest.score[1] || m.s.phase !== this.state.latest.phase || m.s.activeProfile.join() !== this.state.latest.activeProfile.join()) this.emit({ latest: m.s });
        else this.state.latest = m.s;
        break;
      case 'ev': {
        // m.from = Index des ersten Ereignisses: bereits Gesehenes ignorieren, bei Lücke neu synchronisieren
        const have = this.state.events.length;
        const from = typeof m.from === 'number' ? m.from : have;
        if (from > have) { const ws = this.ws; if (ws) this.dropped(ws, 4010); break; }
        const fresh = (m.events as MatchEvent[]).slice(have - from);
        if (fresh.length > 0) this.emit({ events: [...this.state.events, ...fresh] });
        break;
      }
      case 'view':
        this.emit({ view: m.view });
        break;
      case 'walkout':
        if (this.state.status === 'waiting') this.emit(this.walkoutFrom(Number(m.ms), Number(m.totalMs), m.skipVotes, m.skipNeeded));
        break;
      case 'status':
        this.emit({ status: m.status, walkoutEndsAt: m.status === 'running' ? null : this.state.walkoutEndsAt, walkoutSkip: m.status === 'running' ? { votes: [], needed: [] } : this.state.walkoutSkip });
        break;
      case 'skip':
        this.emit({ skip: { from: m.from, to: m.to, at: performance.now() } });
        break;
      case 'ack': {
        const r = this.pending.get(m.id);
        this.pending.delete(m.id);
        this.inflight.delete(m.id);
        r?.({ ok: m.ok, error: m.error });
        break;
      }
      case 'end':
        this.emit({ status: 'finished', end: { saved: m.saved, result: m.result } });
        break;
      case 'error':
        // vorübergehende Serverfehler (m.transient) lösen die automatische Wiederverbindung aus statt eines Abbruchs
        if (!this.state.teams && !m.transient) this.fatal = true;
        if (!m.transient) this.emit({ error: m.message });
        break;
    }
  }

  private sendRaw(msg: unknown): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  start(): void { this.sendRaw({ t: 'start' }); }
  /** Hymne überspringen (KI-Partie sofort, Multiplayer erst wenn alle Manager zustimmen) */
  skipWalkout(): void { this.sendRaw({ t: 'skip_walkout' }); }
  /** Gemessene Länge der Heimhymne melden (nur Heim-Manager, falls noch nicht gespeichert) */
  reportAnthem(durationMs: number): void { this.sendRaw({ t: 'anthem', durationMs: Math.round(durationMs) }); }

  private walkoutFrom(ms: number, totalMs: number, votes: unknown, needed: unknown): Partial<MatchState> {
    if (!(ms > 0)) return { walkoutEndsAt: null, walkoutStartedAt: null, walkoutTotalMs: 0 };
    const now = Date.now();
    const total = totalMs > 0 ? totalMs : ms;
    return {
      walkoutEndsAt: now + ms, walkoutStartedAt: now + ms - total, walkoutTotalMs: total,
      walkoutSkip: { votes: Array.isArray(votes) ? votes : [], needed: Array.isArray(needed) ? needed : [] },
    };
  }

  command(cmd: Command): Promise<{ ok: boolean; error?: string }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.gotInit) return resolve({ ok: false, error: 'Keine Verbindung – dein Befehl wurde nicht gesendet. Bitte nach dem Wiederverbinden erneut versuchen.' });
      this.pending.set(id, resolve);
      this.inflight.set(id, { cmd, at: Date.now() });
      this.ws.send(JSON.stringify({ t: 'cmd', id, cmd }));
      setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: 'Keine Antwort vom Server.' }); }, 8000);
    });
  }

  /** Interpolierter Zustand ~100 ms in der Vergangenheit (zwischen zwei Snapshots). */
  interpolated(now = performance.now()): { tick: number; ball: [number, number, number]; carrier: string | null; players: Map<string, [number, number]>; minute: number; score: [number, number]; setPiece: Snapshot['setPiece'] | null; ballKind: Snapshot['ballKind'] | null } | null {
    const b = this.buffer;
    if (b.length === 0) return null;
    const renderAt = now - 150;
    let i = b.length - 1;
    while (i > 0 && b[i - 1]!.at > renderAt) i--;
    const a = b[Math.max(0, i - 1)]!;
    const c = b[i]!;
    const span = c.at - a.at;
    const k = span > 0 ? Math.max(0, Math.min(1, (renderAt - a.at) / span)) : 1;
    const players = new Map<string, [number, number]>();
    const prev = new Map(a.s.players.map(([id, x, y]) => [id, [x, y] as [number, number]]));
    for (const [id, x, y] of c.s.players) {
      const p = prev.get(id);
      players.set(id, p ? [p[0] + (x - p[0]) * k, p[1] + (y - p[1]) * k] : [x, y]);
    }
    const za = a.s.ball[2] ?? 0, zc = c.s.ball[2] ?? 0;
    const near = k < 0.5 ? a.s : c.s;
    return { tick: near.tick, ball: [a.s.ball[0] + (c.s.ball[0] - a.s.ball[0]) * k, a.s.ball[1] + (c.s.ball[1] - a.s.ball[1]) * k, za + (zc - za) * k], carrier: near.carrier ?? null, players,
      minute: near.minute, score: near.score, setPiece: near.setPiece ?? null, ballKind: near.ballKind ?? null };
  }
}
