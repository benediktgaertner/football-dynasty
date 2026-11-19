import { requireSupabase } from './supabase';

/** Typen entsprechen packages/engine/src/types.ts (nur die Felder, die die Oberfläche braucht). */
export type Side = 'home' | 'away';
export type ProfileName = 'offensive' | 'neutral' | 'defensive';
export interface Snapshot {
  tick: number; clock?: number; minute: number; phase: 'pre' | 'first' | 'second' | 'end'; score: [number, number];
  ball: [number, number, number?]; possession: Side | null; carrier?: string | null; intensity?: number; players: Array<[string, number, number]>; red: [number, number];
  activeProfile: [ProfileName, ProfileName];
}
export interface MatchEvent { tick: number; minute: number; type: string; side: Side | null; playerId?: string; otherId?: string; text: string; xg?: number }
export interface RosterPlayer { id: string; shirt: number; name: string; first_name?: string; position: string; overall: number; age?: number; region?: string }
export interface RosterTeam { clubId: string; name: string; shortName: string; color: string; colorAlt: string; kit: { pattern: string; primary: string; secondary: string } | null; control: 'human' | 'ai'; players: RosterPlayer[] }
export interface TeamView {
  profile: ProfileName;
  team_instructions: Record<string, number | string>;
  subsUsed: number; subWindowsUsed: number; pendingSubs: Array<{ outId: string; inId: string }>; autopilot: boolean;
  players: Array<{ id: string; shirt: number; name: string; position: string; main: string; overall: number; fitness: number; onPitch: boolean; subbedOff: boolean; sentOff: boolean; injured: boolean; yellow: number; x: number; y: number; instructions: string[]; unavailable: boolean }>;
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
}

/**
 * WebSocket-Client: Authentifizierung per Supabase-Token, automatische Wiederverbindung
 * (exponentielles Backoff) und Snapshot-Puffer für flüssige Interpolation (~100 ms Verzögerung).
 */
export class MatchClient {
  state: MatchState = { connection: 'connecting', error: null, role: null, status: 'loading', skip: null, teams: null, events: [], view: null, latest: null, end: null, kind: null };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private buffer: Array<{ at: number; s: Snapshot }> = [];
  private nextId = 1;
  private pending = new Map<number, (r: { ok: boolean; error?: string }) => void>();
  private retry = 0;
  private gotInit = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private scene = 0;
  /** Zeitpunkt des letzten Schnitts (für kurze Überblendung) */
  cutAt = 0;
  private stopped = false;
  private fatal = false;

  constructor(private url: string, private fixtureId: string) {}

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(patch: Partial<MatchState>) { this.state = { ...this.state, ...patch }; for (const l of this.listeners) l(); }

  async connect(): Promise<void> {
    if (this.stopped) return;
    const { data } = await requireSupabase().auth.getSession();
    let token = data.session?.access_token;
    if (data.session && (data.session.expires_at ?? 0) * 1000 < Date.now() + 60_000) {
      token = (await requireSupabase().auth.refreshSession()).data.session?.access_token ?? token;
    }
    if (!token) { this.emit({ connection: 'error', error: 'Nicht angemeldet.' }); return; }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.gotInit = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', token, fixtureId: this.fixtureId }));
      // Antwortet der Server nicht, neu verbinden statt endlos zu warten
      clearTimeout(this.initTimer);
      this.initTimer = setTimeout(() => { if (this.ws === ws && !this.gotInit) ws.close(4008, 'init_timeout'); }, 12000);
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)));
    ws.onclose = (e) => {
      for (const [, r] of this.pending) r({ ok: false, error: 'Verbindung unterbrochen.' });
      this.pending.clear();
      if (this.stopped || this.fatal || this.state.status === 'finished' || e.code === 4401 || e.code === 4403) {
        this.emit({ connection: this.state.error ? 'error' : 'closed' });
        return;
      }
      // Nie verbunden und mehrfach gescheitert ⇒ verständliche Diagnose statt Endlos-Spinner
      if (!this.state.teams && this.retry >= 3) {
        const host = this.url.replace(/^ws/, 'http').replace(/\/match$/, '');
        this.fatal = true;
        this.emit({
          connection: 'error',
          error: `Der Match-Server antwortet nicht (${host}). Prüfe ${host}/health – dort muss "implemented": true stehen. ` +
            `Auf Fly.io muss das Secret ALLOWED_ORIGINS genau ${window.location.origin} enthalten.`,
        });
        return;
      }
      this.emit({ connection: 'reconnecting' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => void this.connect(), delay);
    };
  }

  close(): void { this.stopped = true; clearTimeout(this.initTimer); this.ws?.close(); }

  /** Nach einem Fehler erneut versuchen */
  retryNow(): void { this.fatal = false; this.stopped = false; this.retry = 0; this.emit({ error: null, connection: 'connecting' }); void this.connect(); }

  private onMessage(m: any): void {
    switch (m.t) {
      case 'init':
        this.retry = 0;
        this.gotInit = true;
        clearTimeout(this.initTimer);
        this.scene = m.scene ?? 0;
        this.buffer = [{ at: performance.now(), s: m.snapshot }];
        this.emit({ connection: 'open', error: null, role: m.role, status: m.status, teams: m.teams, events: m.events, view: m.view, latest: m.snapshot, kind: m.kind });
        break;
      case 'frame':
        // Neue Szene (Schnitt/Sprung): nicht über den Schnitt hinweg interpolieren
        if (m.scene !== this.scene) { this.scene = m.scene; this.buffer = []; this.cutAt = performance.now(); }
        this.buffer.push({ at: performance.now(), s: m.s });
        if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
        // Anzeige (Uhr/Score) nur bei Änderung neu rendern; Positionen zeichnet das Canvas selbst
        if (!this.state.latest || m.s.minute !== this.state.latest.minute || m.s.score[0] !== this.state.latest.score[0] || m.s.score[1] !== this.state.latest.score[1] || m.s.phase !== this.state.latest.phase || m.s.activeProfile.join() !== this.state.latest.activeProfile.join()) this.emit({ latest: m.s });
        else this.state.latest = m.s;
        break;
      case 'ev':
        this.emit({ events: [...this.state.events, ...m.events] });
        break;
      case 'view':
        this.emit({ view: m.view });
        break;
      case 'status':
        this.emit({ status: m.status });
        break;
      case 'skip':
        this.emit({ skip: { from: m.from, to: m.to, at: performance.now() } });
        break;
      case 'ack': {
        const r = this.pending.get(m.id);
        this.pending.delete(m.id);
        r?.({ ok: m.ok, error: m.error });
        break;
      }
      case 'end':
        this.emit({ status: 'finished', end: { saved: m.saved, result: m.result } });
        break;
      case 'error':
        if (!this.state.teams) this.fatal = true;
        this.emit({ error: m.message });
        break;
    }
  }

  start(): void { this.ws?.send(JSON.stringify({ t: 'start' })); }

  command(cmd: Command): Promise<{ ok: boolean; error?: string }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return resolve({ ok: false, error: 'Keine Verbindung.' });
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ t: 'cmd', id, cmd }));
      setTimeout(() => { if (this.pending.delete(id)) resolve({ ok: false, error: 'Keine Antwort vom Server.' }); }, 8000);
    });
  }

  /** Interpolierter Zustand ~100 ms in der Vergangenheit (zwischen zwei Snapshots). */
  interpolated(now = performance.now()): { ball: [number, number, number]; carrier: string | null; players: Map<string, [number, number]> } | null {
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
    return { ball: [a.s.ball[0] + (c.s.ball[0] - a.s.ball[0]) * k, a.s.ball[1] + (c.s.ball[1] - a.s.ball[1]) * k, za + (zc - za) * k], carrier: (k < 0.5 ? a.s.carrier : c.s.carrier) ?? null, players };
  }
}
