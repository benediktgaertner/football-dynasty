import {
  autoLineup,
  createRng,
  effectiveRating,
  fitnessLossWithFactor,
  fitnessPerformanceMultiplier,
  getFormation,
  positionFromCoordinates,
  tacticLoadFactor,
  validatePlayerInstructions,
  type Position,
  type Rng,
  type TacticalProfileName,
  type TeamInstructions,
} from '@fd/shared';
import {
  PITCH_LENGTH as L,
  PITCH_WIDTH as W,
  TICK_SECONDS,
  TICKS_PER_HALF,
  TOTAL_TICKS,
  type EnginePlayerInput,
  type MatchCommand,
  type MatchEvent,
  type MatchResult,
  type MatchSetup,
  type PlayerMatchStats,
  type ProfileInput,
  type Side,
  type Snapshot,
  type TeamInput,
  type TeamMatchStats,
} from './types.js';

/**
 * Match Engine (Phase 5). Deterministisch: gleicher Seed + gleiche Befehle in gleichen Ticks
 * ⇒ exakt gleiche Partie. Alle Zufallswerte kommen aus einem einzigen RNG.
 *
 * Koordinaten intern pro Team im eigenen Angriffsrahmen: u = Abstand zur eigenen Torlinie (0 … 105),
 * v = Breite (0 … 68). Ausgabe in Feldkoordinaten: Heim greift Richtung +x an.
 */

const OTHER: Record<Side, Side> = { home: 'away', away: 'home' };
const MAX_SUBS = 5;
const MAX_SUB_WINDOWS = 3;
const GOAL_U = L;
const GOAL_V = W / 2;
const BASE_HOME_ADVANTAGE = 0.06;
/**
 * Darstellungszeit je Tick für Bewegungen (Sekunden). Die Spieluhr läuft mit 0,75 s je Tick,
 * Laufwege und Bälle bewegen sich aber in „Fernsehtempo“ (≈ 4-fach), damit man folgen kann.
 */
const VIS = 0.045;
/** Zeitstreckung gegenüber der ursprünglichen Abstimmung (VIS 0,1): Aktionen dauern entsprechend mehr Ticks */
const TS = 0.1 / VIS;
const ACCEL = 5.5 * VIS; // max. Geschwindigkeitsänderung je Tick (m/s)

interface LivePlayer {
  input: EnginePlayerInput;
  side: Side;
  slotPos: Position;
  /** Ankerposition aus der Aufstellung, Skala wie Editor (x 0–100 Breite, y 0–100 Tiefe) */
  ax: number;
  ay: number;
  u: number;
  v: number;
  fitness: number;
  onPitch: boolean;
  subbedOff: boolean;
  sentOff: boolean;
  injured: boolean;
  yellow: number;
  instr: Set<string>;
  beatenUntil: number;
  posFactor: number;
  /** Geschwindigkeit (m/s) für flüssige, träge Bewegung */
  vu: number;
  vv: number;
  /** Laufweg ohne Ball (im Rahmen des eigenen Teams) */
  run: Run | null;
  stats: PlayerMatchStats;
}

type RunKind = 'behind' | 'overlap' | 'inside' | 'drop' | 'box' | 'support' | 'give_go';
interface Run { u: number; v: number; until: number; kind: RunKind }

interface TeamState {
  side: Side;
  input: TeamInput;
  profile: TacticalProfileName;
  ti: TeamInstructions;
  adv: ProfileInput['advanced_options'];
  players: LivePlayer[];
  stats: TeamMatchStats;
  pendingSubs: Array<{ outId: string; inId: string }>;
  pendingSince: number;
  takers: { free_kick: string[]; penalty: string[]; corner: string[]; throw_in: string[] };
  autopilot: boolean;
  lastAutoTick: number;
  autoSwitched: boolean;
}

interface Flight {
  fromU: number; fromV: number; // im Rahmen des passenden Teams
  toU: number; toV: number;
  ticks: number;
  total: number;
  /** Scheitelhöhe in Metern (0 = flach) */
  height?: number;
  resolve: () => void;
}

export interface CommandRecord { tick: number; side: Side; cmd: MatchCommand }

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const dist = (u1: number, v1: number, u2: number, v2: number) => Math.hypot(u1 - u2, v1 - v2);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function emptyTeamStats(): TeamMatchStats {
  return { goals: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, passesCompleted: 0, possessionTicks: 0, fouls: 0, corners: 0, offsides: 0, yellow: 0, red: 0, subsUsed: 0, subWindowsUsed: 0 };
}

/** xG aus Distanz und Öffnungswinkel (eigene logistische Kurve, kalibriert auf übliche Werte). */
export function expectedGoals(u: number, v: number, header = false): number {
  const d = Math.max(0.5, dist(u, v, GOAL_U, GOAL_V));
  const a1 = Math.atan2(GOAL_V + 3.66 - v, GOAL_U - u);
  const a2 = Math.atan2(GOAL_V - 3.66 - v, GOAL_U - u);
  const angle = Math.abs(a1 - a2);
  const xg = sigmoid(0.12 - 0.11 * d + 1.4 * angle);
  return header ? xg * 0.6 : xg;
}

export class MatchEngine {
  readonly setup: MatchSetup;
  tick = 0;
  phase: Snapshot['phase'] = 'pre';
  events: MatchEvent[] = [];
  readonly commandLog: CommandRecord[] = [];
  private rng: Rng;
  private teams: Record<Side, TeamState>;
  private possession: Side = 'home';
  private carrier: LivePlayer | null = null;
  private holdTicks = 0;
  private flight: Flight | null = null;
  /** Ballposition in Feldkoordinaten (Heimrahmen) */
  private bx = L / 2;
  private by = W / 2;
  private lastPasser: { id: string; tick: number } | null = null;
  private deadBall = false;
  private restartIn = 0;
  private restart: (() => void) | null = null;

  constructor(setup: MatchSetup) {
    this.setup = setup;
    this.rng = createRng(`match:${setup.seed}`);
    this.teams = { home: this.buildTeam('home', setup.home), away: this.buildTeam('away', setup.away) };
  }

  // -------------------------------------------------------------------------
  // Aufbau
  // -------------------------------------------------------------------------
  private buildTeam(side: Side, input: TeamInput): TeamState {
    const profile = input.settings.active_profile;
    const prof = input.profiles[profile];
    const formation = getFormation(prof.formation_code) ?? getFormation('4-4-2')!;
    let slots = prof.slots.length === 11 ? prof.slots : formation.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y, playerId: null }));
    const byId = new Map(input.squad.map((p) => [p.id, p]));
    const invalid = slots.some((s) => !s.playerId || !byId.get(s.playerId) || byId.get(s.playerId)!.unavailable) || new Set(slots.map((s) => s.playerId)).size !== 11;
    if (invalid) {
      // Ungültige/fehlende Aufstellung: gültige Spieler behalten, Rest automatisch füllen (E4)
      const keep = new Set<string>();
      const partial = slots.map((s) => {
        const p = s.playerId ? byId.get(s.playerId) : undefined;
        if (p && !p.unavailable && !keep.has(p.id) && (s.position === 'GK') === (p.kind === 'goalkeeper')) { keep.add(p.id); return s; }
        return { ...s, playerId: null };
      });
      const open = partial.filter((s) => !s.playerId);
      const filled = autoLineup(open, input.squad.filter((p) => !keep.has(p.id)).map((p) => ({ ...p, secondary_positions: [...p.secondary_positions] })));
      const fillMap = new Map(filled.map((s) => [s.slotIndex, s.playerId]));
      slots = partial.map((s) => (s.playerId ? s : { ...s, playerId: fillMap.get(s.slotIndex) ?? null }));
    }
    const onPitch = new Map(slots.filter((s) => s.playerId).map((s) => [s.playerId!, s]));
    const players: LivePlayer[] = input.squad.map((p) => {
      const slot = onPitch.get(p.id);
      const slotPos = slot?.position ?? p.main_position;
      return {
        input: p,
        side,
        slotPos,
        ax: slot?.x ?? 50,
        ay: slot?.y ?? 50,
        u: 0,
        v: 0,
        fitness: p.fitness,
        onPitch: !!slot,
        subbedOff: false,
        sentOff: false,
        injured: false,
        yellow: 0,
        instr: new Set(prof.instructions[p.id] ?? []),
        beatenUntil: -1,
        vu: 0,
        vv: 0,
        run: null,
        posFactor: Math.max(0.5, effectiveRating(p, slotPos) / Math.max(1, p.overall)),
        stats: {
          playerId: p.id, side, minutes: 0, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, passesCompleted: 0,
          tacklesWon: 0, interceptions: 0, saves: 0, fouls: 0, yellow: 0, red: false, injured: false, fitnessStart: p.fitness, fitnessEnd: p.fitness, rating: 6,
        },
      };
    });
    const sp = input.setPieces;
    return {
      side, input, profile, ti: { ...prof.team_instructions }, adv: { ...prof.advanced_options }, players, stats: emptyTeamStats(),
      pendingSubs: [], pendingSince: 0,
      takers: { free_kick: [...(sp.free_kick ?? [])], penalty: [...(sp.penalty ?? [])], corner: [...(sp.corner_left ?? []), ...(sp.corner_right ?? [])], throw_in: [...(sp.throw_in ?? [])] },
      autopilot: input.control === 'ai', lastAutoTick: 0, autoSwitched: false,
    };
  }

  // -------------------------------------------------------------------------
  // Öffentliche API
  // -------------------------------------------------------------------------
  get isFinished(): boolean { return this.phase === 'end'; }
  get minute(): number { return Math.min(90, Math.floor((this.tick * TICK_SECONDS) / 60)); }
  get score(): [number, number] { return [this.teams.home.stats.goals, this.teams.away.stats.goals]; }

  /** E4: Automatik übernimmt (KI-Verein oder abwesender Manager). */
  setAutopilot(side: Side, on: boolean): void {
    if (this.teams[side].autopilot === (on || this.teams[side].input.control === 'ai')) return;
    this.applyCommand(side, { kind: 'autopilot', on });
  }
  isAutopilot(side: Side): boolean { return this.teams[side].autopilot; }

  private pitchCache: Record<Side, LivePlayer[] | null> = { home: null, away: null };
  private offCache: Record<Side, [number, number]> = { home: [-1, 0], away: [-1, 0] };
  onPitch(side: Side): LivePlayer[] {
    let c = this.pitchCache[side];
    if (!c) { c = this.teams[side].players.filter((p) => p.onPitch); this.pitchCache[side] = c; }
    return c;
  }
  private dirty(): void { this.pitchCache.home = null; this.pitchCache.away = null; }

  /** Live-Zustand eines Teams für das Team-Management-Overlay. */
  teamView(side: Side) {
    const t = this.teams[side];
    return {
      profile: t.profile,
      team_instructions: t.ti,
      subsUsed: t.stats.subsUsed,
      subWindowsUsed: t.stats.subWindowsUsed,
      pendingSubs: t.pendingSubs,
      autopilot: t.autopilot,
      players: t.players.map((p) => ({
        id: p.input.id, shirt: p.input.shirt, name: p.input.name, position: p.slotPos, main: p.input.main_position, overall: p.input.overall,
        fitness: Math.round(p.fitness), onPitch: p.onPitch, subbedOff: p.subbedOff, sentOff: p.sentOff, injured: p.injured, yellow: p.yellow,
        x: Math.round(p.ax), y: Math.round(p.ay), instructions: [...p.instr], unavailable: !!p.input.unavailable,
      })),
    };
  }

  /** Befehl eines Managers. Wird sofort im aktuellen Tick angewendet und protokolliert (für Replay). */
  applyCommand(side: Side, cmd: MatchCommand): { ok: true } | { ok: false; error: string } {
    if (this.phase === 'end') return { ok: false, error: 'Die Partie ist beendet.' };
    const t = this.teams[side];
    const res = this.execute(t, cmd);
    if (res.ok) this.commandLog.push({ tick: this.tick, side, cmd });
    return res;
  }

  private execute(t: TeamState, cmd: MatchCommand): { ok: true } | { ok: false; error: string } {
    const find = (id: string) => t.players.find((p) => p.input.id === id);
    switch (cmd.kind) {
      case 'profile': {
        if (!t.input.profiles[cmd.name]) return { ok: false, error: 'Unbekanntes Profil.' };
        this.switchProfile(t, cmd.name);
        return { ok: true };
      }
      case 'settings': {
        const next = { ...t.ti, ...cmd.team_instructions } as TeamInstructions;
        for (const k of ['mentality', 'tempo', 'attackWidth', 'crossFrequency', 'pressingIntensity', 'defensiveLine', 'defensiveWidth'] as const) {
          const v = next[k];
          if (!Number.isInteger(v) || v < 1 || v > 5) return { ok: false, error: 'Ungültiger Wert.' };
        }
        t.ti = next;
        this.log({ type: 'tactic', side: t.side, text: `${t.input.shortName} passt die Taktik an.` });
        return { ok: true };
      }
      case 'sub': {
        const out = find(cmd.outId);
        const inn = find(cmd.inId);
        if (!out || !inn) return { ok: false, error: 'Spieler nicht gefunden.' };
        if (!out.onPitch) return { ok: false, error: 'Der Spieler steht nicht auf dem Platz.' };
        if (inn.onPitch || inn.subbedOff || inn.sentOff || inn.input.unavailable || inn.injured) return { ok: false, error: 'Dieser Spieler kann nicht eingewechselt werden.' };
        if (t.pendingSubs.some((s) => s.outId === out.input.id || s.inId === inn.input.id)) return { ok: false, error: 'Wechsel ist bereits vorgemerkt.' };
        if (t.stats.subsUsed + t.pendingSubs.length >= MAX_SUBS) return { ok: false, error: 'Alle fünf Wechsel sind aufgebraucht.' };
        const atHalftime = this.isHalftime();
        if (!atHalftime && t.stats.subWindowsUsed >= MAX_SUB_WINDOWS && t.pendingSubs.length === 0) return { ok: false, error: 'Alle drei Wechselfenster sind aufgebraucht.' };
        t.pendingSubs.push({ outId: out.input.id, inId: inn.input.id });
        if (t.pendingSubs.length === 1) t.pendingSince = this.tick;
        if (atHalftime || this.phase === 'pre') this.executeSubs(t, true);
        return { ok: true };
      }
      case 'move': {
        const p = find(cmd.playerId);
        if (!p || !p.onPitch) return { ok: false, error: 'Spieler nicht auf dem Platz.' };
        const isGk = p.slotPos === 'GK';
        const x = clamp(cmd.x, 4, 96);
        const y = isGk ? clamp(cmd.y, 2, 14) : clamp(cmd.y, 12, 95);
        p.ax = x; p.ay = y;
        if (!isGk) p.slotPos = positionFromCoordinates(x, y, false);
        p.posFactor = Math.max(0.5, effectiveRating(p.input, p.slotPos) / Math.max(1, p.input.overall));
        return { ok: true };
      }
      case 'instructions': {
        const p = find(cmd.playerId);
        if (!p) return { ok: false, error: 'Spieler nicht gefunden.' };
        const err = validatePlayerInstructions(p.slotPos, cmd.codes);
        if (err) return { ok: false, error: err };
        p.instr = new Set(cmd.codes);
        return { ok: true };
      }
      case 'autopilot': {
        t.autopilot = cmd.on || t.input.control === 'ai';
        return { ok: true };
      }
      case 'set_piece': {
        const p = find(cmd.playerId);
        if (!p) return { ok: false, error: 'Spieler nicht gefunden.' };
        const list = t.takers[cmd.role];
        t.takers[cmd.role] = [p.input.id, ...list.filter((id) => id !== p.input.id)];
        return { ok: true };
      }
    }
  }

  private isHalftime(): boolean { return this.tick === TICKS_PER_HALF && this.phase === 'first'; }

  private switchProfile(t: TeamState, name: TacticalProfileName): void {
    const prof = t.input.profiles[name];
    t.profile = name;
    t.ti = { ...prof.team_instructions };
    t.adv = { ...prof.advanced_options };
    const formation = getFormation(prof.formation_code);
    const slots = prof.slots.length === 11 ? prof.slots : formation?.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y, playerId: null })) ?? [];
    const active = t.players.filter((p) => p.onPitch);
    // Spieler, die im Profil vorgesehen und auf dem Platz sind, bekommen ihren Profil-Slot; Rest bestmöglich verteilen.
    const free = [...slots];
    const assigned = new Map<LivePlayer, (typeof slots)[number]>();
    for (const p of active) {
      const i = free.findIndex((s) => s.playerId === p.input.id);
      if (i >= 0) { assigned.set(p, free[i]!); free.splice(i, 1); }
    }
    for (const p of active.filter((x) => !assigned.has(x)).sort((a, b) => (a.slotPos === 'GK' ? -1 : b.slotPos === 'GK' ? 1 : 0))) {
      let best = -1; let bestScore = -Infinity;
      free.forEach((s, i) => {
        if ((s.position === 'GK') !== (p.slotPos === 'GK')) return;
        const sc = effectiveRating(p.input, s.position);
        if (sc > bestScore) { bestScore = sc; best = i; }
      });
      if (best < 0) best = free.findIndex((s) => s.position !== 'GK');
      if (best < 0) continue;
      assigned.set(p, free[best]!); free.splice(best, 1);
    }
    for (const [p, s] of assigned) {
      p.ax = s.x; p.ay = s.y; p.slotPos = s.position;
      p.posFactor = Math.max(0.5, effectiveRating(p.input, p.slotPos) / Math.max(1, p.input.overall));
      p.instr = new Set(prof.instructions[p.input.id] ?? []);
    }
    const label = name === 'offensive' ? 'Offensiv' : name === 'defensive' ? 'Defensiv' : 'Neutral';
    this.log({ type: 'tactic', side: t.side, text: `${t.input.shortName} wechselt auf Profil „${label}“.` });
  }

  private executeSubs(t: TeamState, free = false): void {
    if (t.pendingSubs.length === 0) return;
    let done = 0;
    for (const s of t.pendingSubs) {
      const out = t.players.find((p) => p.input.id === s.outId)!;
      const inn = t.players.find((p) => p.input.id === s.inId)!;
      if (!out.onPitch || inn.onPitch || inn.subbedOff || inn.sentOff || t.stats.subsUsed >= MAX_SUBS) continue;
      out.onPitch = false; out.subbedOff = true;
      inn.onPitch = true;
      this.dirty();
      inn.ax = out.ax; inn.ay = out.ay; inn.u = out.u; inn.v = out.v;
      inn.slotPos = out.slotPos === 'GK' ? 'GK' : out.slotPos;
      if (inn.slotPos === 'GK' && inn.input.kind !== 'goalkeeper') inn.slotPos = out.slotPos;
      inn.posFactor = Math.max(0.5, effectiveRating(inn.input, inn.slotPos) / Math.max(1, inn.input.overall));
      if (this.carrier === out) this.carrier = inn;
      t.stats.subsUsed++;
      done++;
      this.log({ type: 'sub', side: t.side, playerId: inn.input.id, otherId: out.input.id, text: `Wechsel ${t.input.shortName}: ${inn.input.name} für ${out.input.name}` });
    }
    if (done > 0 && !free && !(this.tick === TICKS_PER_HALF)) t.stats.subWindowsUsed++;
    t.pendingSubs = [];
  }

  // -------------------------------------------------------------------------
  // Hilfen
  // -------------------------------------------------------------------------
  private log(e: Omit<MatchEvent, 'tick' | 'minute'>): void {
    const minute = Math.min(this.phase === 'first' ? 45 : 90, Math.floor((this.tick * TICK_SECONDS) / 60) + 1);
    this.events.push({ tick: this.tick, minute, ...e });
  }

  private skill(p: LivePlayer, key: string): number {
    const a = p.input.attributes;
    let base: number;
    if (p.input.kind === 'goalkeeper') {
      const gkMap: Record<string, string> = { passing: 'distribution', pace: 'reactionSpeed', physical: 'commandOfArea', defending: 'positioning', dribbling: 'distribution', shooting: 'kicking', heading: 'commandOfArea', crossing: 'kicking' };
      base = a[key] ?? (gkMap[key] ? (a[gkMap[key]!] ?? 40) * (key === 'passing' || key === 'gameIntelligence' ? 1 : 0.6) : 40);
    } else {
      base = a[key] ?? 40;
    }
    const physical = key === 'pace' || key === 'physical' || key === 'stamina' || key === 'defending';
    let m = fitnessPerformanceMultiplier(p.fitness, physical ? 'physical' : 'mental') * p.posFactor;
    if (p.side === 'home') m *= 1 + BASE_HOME_ADVANTAGE + this.setup.homeAdvantage;
    return base * m;
  }

  /** Torwartstärke (Feldspieler im Tor = sehr schwach) */
  private keeperSkill(p: LivePlayer | undefined, key: string): number {
    if (!p) return 15;
    if (p.input.kind !== 'goalkeeper') return 25;
    const m = fitnessPerformanceMultiplier(p.fitness, 'mental') * (p.side === 'home' ? 1 + BASE_HOME_ADVANTAGE + this.setup.homeAdvantage : 1);
    return (p.input.attributes[key] ?? 50) * m;
  }

  private keeper(t: TeamState): LivePlayer | undefined {
    return t.players.find((p) => p.onPitch && p.slotPos === 'GK') ?? t.players.find((p) => p.onPitch && p.input.kind === 'goalkeeper');
  }

  /** Ball in den Rahmen des Teams umrechnen */
  private ballFor(side: Side): [number, number] {
    return side === 'home' ? [this.bx, this.by] : [L - this.bx, W - this.by];
  }
  private setBallFrom(side: Side, u: number, v: number): void {
    if (side === 'home') { this.bx = u; this.by = v; } else { this.bx = L - u; this.by = W - v; }
  }
  /** Position eines Spielers im Rahmen eines (ggf. gegnerischen) Teams */
  private posIn(p: LivePlayer, side: Side): [number, number] {
    return p.side === side ? [p.u, p.v] : [L - p.u, W - p.v];
  }

  private nearestOpponent(p: LivePlayer, u = p.u, v = p.v): { op: LivePlayer | null; d: number } {
    let best: LivePlayer | null = null; let bd = Infinity;
    for (const o of this.onPitch(OTHER[p.side])) {
      const [ou, ov] = this.posIn(o, p.side);
      const d = dist(u, v, ou, ov);
      if (d < bd) { bd = d; best = o; }
    }
    return { op: best, d: bd };
  }

  /** Zweitletzter Verteidiger (inkl. Torwart) aus Sicht des angreifenden Teams = Abseitslinie */
  private offsideLine(attacking: Side): number {
    const c = this.offCache[attacking];
    if (c[0] === this.tick) return c[1];
    const val = this.computeOffside(attacking);
    this.offCache[attacking] = [this.tick, val];
    return val;
  }
  private computeOffside(attacking: Side): number {
    const us = this.onPitch(OTHER[attacking]).map((o) => this.posIn(o, attacking)[0]).sort((a, b) => b - a);
    const second = us[1] ?? L;
    const [bu] = this.ballFor(attacking);
    return Math.max(L / 2, Math.max(second, bu));
  }

  private taker(t: TeamState, role: keyof TeamState['takers'], attr: string): LivePlayer {
    const field = t.players.filter((p) => p.onPitch);
    for (const id of t.takers[role]) {
      const p = field.find((x) => x.input.id === id);
      if (p) return p;
    }
    return [...field].filter((p) => p.slotPos !== 'GK').sort((a, b) => (b.input.attributes[attr] ?? 0) - (a.input.attributes[attr] ?? 0))[0] ?? field[0]!;
  }

  // -------------------------------------------------------------------------
  // Positionierung
  // -------------------------------------------------------------------------
  private targetFor(p: LivePlayer, t: TeamState): [number, number] {
    const inPoss = this.possession === t.side;
    const [bu, bv] = this.ballFor(t.side);
    const ti = t.ti;
    if (p.slotPos === 'GK') {
      const sweeper = p.instr.has('sweeper_keeper') ? 6 : p.instr.has('conservative_positioning') ? -1 : 0;
      const u = clamp(3 + (inPoss ? 6 : 2) + sweeper + (bu - 30) * 0.05, 1, 22);
      return [u, GOAL_V + (bv - GOAL_V) * 0.15];
    }
    const field = this.onPitch(t.side).filter((x) => x.slotPos !== 'GK');
    let dMin = 100, dMax = 0;
    for (const f of field) { dMin = Math.min(dMin, f.ay); dMax = Math.max(dMax, f.ay); }
    const rel = dMax > dMin ? (p.ay - dMin) / (dMax - dMin) : 0.5;
    let line: number; let length: number;
    if (inPoss) {
      line = clamp(24 + ti.mentality * 4 + (bu - 52) * 0.45, 16, 66);
      length = 40 + (ti.mentality - 3) * 3;
    } else {
      line = clamp(14 + ti.defensiveLine * 4 + (bu - 52) * 0.32, 8, 50);
      length = 30 - (ti.pressingIntensity - 3) * 2;
    }
    let u = line + rel * length;
    const widthF = inPoss ? 0.75 + ti.attackWidth * 0.08 : 0.55 + ti.defensiveWidth * 0.07;
    let v = GOAL_V + ((p.ax / 100) * W - GOAL_V) * widthF + (bv - GOAL_V) * (inPoss ? 0.15 : 0.3);
    const ins = p.instr;
    if (inPoss) {
      if (ins.has('get_forward') || ins.has('overlap')) u += 9;
      if (ins.has('stay_back') || ins.has('hold_position')) u -= 6;
      if (ins.has('run_in_behind')) u += 4;
      if (ins.has('come_short')) u -= 7;
      if (ins.has('stay_wide')) v = p.ax < 50 ? 3 : W - 3;
      if (ins.has('cut_inside') || ins.has('invert')) v = GOAL_V + (v - GOAL_V) * 0.55;
      if (ins.has('drift_wide')) v = GOAL_V + (v - GOAL_V) * 1.6;
      if (ins.has('roam')) v += Math.sin(this.tick / 37 + p.input.shirt) * 6;
      const overload = t.adv.overload;
      if (overload === 'left') v -= 4; else if (overload === 'right') v += 4; else if (overload === 'center') v = GOAL_V + (v - GOAL_V) * 0.8;
      // Restverteidigung: die tiefsten Spieler bleiben hinten
      const deepest = [...field].sort((a, b) => a.ay - b.ay).slice(0, t.adv.restDefense);
      if (deepest.includes(p)) u = Math.min(u, line + 6 + (t.adv.transitionCover ? -4 : 0));
      // Nicht ins Abseits laufen (Stürmer mit „In die Tiefe“ riskieren mehr)
      const off = this.offsideLine(t.side);
      const risk = ins.has('run_in_behind') ? 1.5 : -0.8;
      u = Math.min(u, off + risk);
    } else {
      if (ins.has('track_back')) u -= 6;
      if (ins.has('step_up')) u += 3;
      if (ins.has('conservative')) u -= 3;
    }
    return [clamp(u, 2, L - 2), clamp(v, 1, W - 1)];
  }

  /** Höchstgeschwindigkeit in m/s */
  private speed(p: LivePlayer): number {
    return 5.2 + (this.skill(p, 'pace') / 99) * 3.4;
  }

  /** Aktueller Laufweg in Team-Koordinaten, falls noch gültig */
  private activeRun(p: LivePlayer): Run | null {
    if (!p.run) return null;
    if (p.run.until < this.tick || this.possession !== p.side) { p.run = null; return null; }
    return p.run;
  }

  /** Kreativität: Spielintelligenz, Mentalität und Anweisungen bestimmen, wie oft Laufwege entstehen */
  private creativity(p: LivePlayer): number {
    return (this.skill(p, 'gameIntelligence') * 0.6 + this.skill(p, 'mentality') * 0.2 + this.skill(p, 'pace') * 0.2) / 70;
  }

  /** Laufwege des ballbesitzenden Teams starten (Tiefenlauf, Hinterlaufen, Einrücken, Entgegenkommen, Strafraum) */
  private planRuns(t: TeamState): void {
    if (!this.carrier || this.carrier.side !== t.side || this.deadBall) return;
    const c = this.carrier;
    const [bu, bv] = [c.u, c.v];
    const off = this.offsideLine(t.side);
    const mentality = 0.75 + t.ti.mentality * 0.1;
    const wideBall = bv < 18 || bv > W - 18;
    // Flankenzone: Strafraum gezielt besetzen (erster Pfosten, zweiter Pfosten, Elfmeterpunkt, Rückraum)
    if (bu > L - 32 && wideBall && this.tick - this.boxPlanTick > 40 * TS) {
      this.boxPlanTick = this.tick;
      const near = bv < GOAL_V ? GOAL_V - 4 : GOAL_V + 4;
      const far = bv < GOAL_V ? GOAL_V + 6 : GOAL_V - 6;
      const spots: Array<[number, number]> = [[L - 6, near], [L - 8, far], [L - 12, GOAL_V], [L - 19, GOAL_V + (bv < GOAL_V ? 4 : -4)]];
      const cands = this.onPitch(t.side).filter((p) => p !== c && p.slotPos !== 'GK' && !['CB', 'LB', 'RB'].includes(p.slotPos))
        .sort((a, b) => b.u - a.u);
      const n = Math.min(spots.length, 2 + Math.max(0, t.adv.boxPresence - 1));
      for (let i = 0; i < Math.min(n, cands.length); i++) {
        const [su, sv] = spots[i]!;
        cands[i]!.run = { u: su + this.rng.normal(0, 1), v: sv + this.rng.normal(0, 1.5), until: this.tick + Math.round(60 * TS), kind: 'box' };
      }
      return;
    }
    for (const p of this.onPitch(t.side)) {
      if (p === c || p.slotPos === 'GK' || this.activeRun(p)) continue;
      const pos = p.slotPos;
      const chance = (0.02 / TS) * this.creativity(p) * mentality * (t.ti.tempo >= 4 ? 1.15 : 1);
      if (this.rng.next() > chance) continue;
      const fwd = pos === 'ST' || pos === 'CF';
      const wing = pos === 'LW' || pos === 'RW' || pos === 'LM' || pos === 'RM';
      const fb = pos === 'LB' || pos === 'RB' || pos === 'LWB' || pos === 'RWB';
      const mid = pos === 'CM' || pos === 'CAM' || pos === 'CDM';
      const sameFlank = (p.v < GOAL_V) === (bv < GOAL_V);
      if (fwd && bu > 35) {
        if (p.instr.has('come_short') || (!p.instr.has('run_in_behind') && this.rng.next() < 0.3)) {
          p.run = { u: bu + 6, v: bv + (p.v - bv) * 0.4, until: this.tick + Math.round(25 * TS), kind: 'drop' };
          // Dritter Mann: ein Mittelfeldspieler startet in den freien Raum
          const third = this.onPitch(t.side).find((m) => (m.slotPos === 'CAM' || m.slotPos === 'CM' || m.slotPos === 'LW' || m.slotPos === 'RW') && !m.run && m !== c);
          if (third) third.run = { u: Math.min(L - 10, off + 7), v: GOAL_V + (third.v - GOAL_V) * 0.5, until: this.tick + Math.round(40 * TS), kind: 'behind' };
        } else {
          const channel = p.v + (this.rng.next() < 0.5 ? -8 : 8);
          p.run = { u: Math.min(L - 9, off + 6 + this.rng.next() * 8), v: clamp(channel, 10, W - 10), until: this.tick + Math.round(40 * TS), kind: 'behind' };
        }
      } else if (wing && bu > 40) {
        if (p.instr.has('cut_inside') || (!p.instr.has('stay_wide') && this.rng.next() < 0.45)) {
          p.run = { u: Math.min(L - 14, off + 3), v: GOAL_V + (p.v < GOAL_V ? -9 : 9), until: this.tick + Math.round(40 * TS), kind: 'inside' };
        } else {
          p.run = { u: Math.min(L - 6, off + 8), v: p.v < GOAL_V ? 4 : W - 4, until: this.tick + Math.round(40 * TS), kind: 'behind' };
        }
      } else if (fb && sameFlank && bu > 35 && bu < L - 20 && !p.instr.has('stay_back') && (p.instr.has('overlap') || p.instr.has('get_forward') || this.rng.next() < 0.5)) {
        p.run = { u: Math.min(L - 10, bu + 14), v: p.v < GOAL_V ? 3 : W - 3, until: this.tick + Math.round(45 * TS), kind: 'overlap' };
      } else if (mid && bu > 45 && !p.instr.has('stay_back') && !p.instr.has('hold_position')) {
        if (this.rng.next() < 0.5) p.run = { u: Math.min(L - 12, bu + 16), v: GOAL_V + this.rng.normal(0, 8), until: this.tick + Math.round(40 * TS), kind: 'box' };
        else p.run = { u: bu - 4, v: clamp(bv + (p.v > bv ? 11 : -11), 4, W - 4), until: this.tick + Math.round(20 * TS), kind: 'support' };
      }
    }
  }

  private moveTeams(): void {
    for (const side of ['home', 'away'] as const) {
      const t = this.teams[side];
      const players = this.onPitch(side);
      const defending = this.possession !== side;
      if (!defending) this.planRuns(t);
      // Pressing: die nächsten Spieler laufen den Ballführenden an
      let pressers: Set<LivePlayer> = new Set();
      if (defending && this.carrier && !this.flight) {
        const [bu] = this.ballFor(side);
        const trig = t.adv.pressingTrigger;
        const allowed = trig !== 'own_half_only' || bu < L / 2;
        const n = allowed ? (t.ti.pressingIntensity >= 4 ? 2 : 1) + (t.ti.onBallLost === 'counter_press' && this.tick - this.lastTurnover < 30 * TS ? 1 : 0) : 0;
        const [cu, cv] = this.posIn(this.carrier, side);
        pressers = new Set(players.filter((p) => p.slotPos !== 'GK').sort((a, b) => dist(a.u, a.v, cu, cv) - dist(b.u, b.v, cu, cv)).slice(0, n));
      }
      // Verteidiger verfolgen gefährliche Läufe (Manndeckung im Strafraum, Kreativität wird so nicht zum Selbstläufer)
      const attackers = defending ? this.onPitch(OTHER[side]).filter((a) => a.run && (a.run.kind === 'behind' || a.run.kind === 'box' || a.run.kind === 'inside')) : [];
      for (const p of players) {
        if (p === this.carrier && !this.flight) continue;
        let [tu, tv] = this.targetFor(p, t);
        let urgency = 0.6;
        const run = defending ? null : this.activeRun(p);
        if (run) { tu = run.u; tv = run.v; urgency = run.kind === 'support' || run.kind === 'drop' ? 0.75 : 1; }
        if (pressers.has(p) && this.carrier) {
          const [cu, cv] = this.posIn(this.carrier, side);
          const aggr = 0.55 + t.ti.pressingIntensity * 0.09;
          tu = tu + (cu - 1.2 - tu) * aggr; tv = tv + (cv - tv) * aggr;
          urgency = 0.95;
        } else if (attackers.length && p.slotPos !== 'GK') {
          // nächsten gefährlichen Läufer aufnehmen, wenn er in die eigene Zone läuft
          let best: LivePlayer | null = null; let bd = 9 + this.skill(p, 'gameIntelligence') / 20;
          for (const a of attackers) {
            const [au, av] = this.posIn(a, side);
            const d = dist(p.u, p.v, au, av);
            if (d < bd) { bd = d; best = a; }
          }
          if (best) {
            const [au, av] = this.posIn(best, side);
            tu = Math.max(2, au - 1.5); tv = av + (GOAL_V - av) * 0.15;
            urgency = 0.95;
          }
        }
        // Lenkverhalten: Wunschgeschwindigkeit Richtung Ziel, begrenzte Beschleunigung ⇒ flüssige Wege
        const d = dist(p.u, p.v, tu, tv);
        const max = this.speed(p) * urgency * (0.75 + 0.25 * fitnessPerformanceMultiplier(p.fitness, 'physical'));
        const want = d < 0.3 ? 0 : Math.min(max, d / (VIS * 3));
        const du = d > 0 ? ((tu - p.u) / d) * want : 0;
        const dv = d > 0 ? ((tv - p.v) / d) * want : 0;
        let ddu = du - p.vu, ddv = dv - p.vv;
        const dm = Math.hypot(ddu, ddv);
        if (dm > ACCEL) { ddu = (ddu / dm) * ACCEL; ddv = (ddv / dm) * ACCEL; }
        p.vu += ddu; p.vv += ddv;
        p.u = clamp(p.u + p.vu * VIS, 0.5, L - 0.5);
        p.v = clamp(p.v + p.vv * VIS, 0.5, W - 0.5);
      }
    }
  }

  private boxPlanTick = -100;

  private lastTurnover = -100;

  // -------------------------------------------------------------------------
  // Spielablauf
  // -------------------------------------------------------------------------
  private resetFormation(): void {
    for (const side of ['home', 'away'] as const) {
      for (const p of this.onPitch(side)) {
        p.vu = 0; p.vv = 0; p.run = null;
        if (p.slotPos === 'GK') { p.u = 4; p.v = GOAL_V; continue; }
        p.u = clamp(8 + (p.ay / 100) * 42, 6, 50);
        p.v = (p.ax / 100) * W;
      }
    }
  }

  private kickoff(side: Side): void {
    this.resetFormation();
    this.bx = L / 2; this.by = W / 2;
    this.possession = side;
    const field = this.onPitch(side).filter((p) => p.slotPos !== 'GK');
    const c = [...field].sort((a, b) => b.ay - a.ay || Math.abs(a.ax - 50) - Math.abs(b.ax - 50))[0] ?? field[0] ?? null;
    if (c) { c.u = L / 2 - 0.5; c.v = W / 2; }
    this.carrier = c;
    this.holdTicks = Math.round(8 * TS);
    this.flight = null;
  }

  private giveBall(p: LivePlayer, hold = 2): void {
    if (this.possession !== p.side) {
      this.lastTurnover = this.tick;
      for (const x of this.teams[this.possession].players) x.run = null;
    }
    p.run = null;
    this.possession = p.side;
    this.carrier = p;
    this.holdTicks = hold;
    this.flight = null;
    this.setBallFrom(p.side, p.u, p.v);
  }

  /** Spielunterbrechung mit Neustart nach kurzer Pause (ermöglicht Wechsel = Wechselfenster) */
  private stoppage(ticks: number, restart: () => void): void {
    this.deadBall = true;
    this.restartIn = ticks;
    this.restart = restart;
    this.carrier = null;
    this.flight = null;
  }

  private goalKick(side: Side): void {
    const gk = this.keeper(this.teams[side]);
    this.stoppage(18, () => {
      if (gk) { gk.u = 6; gk.v = GOAL_V; this.giveBall(gk, Math.round(3 * TS)); }
      else this.kickoff(side);
    });
  }

  step(): void {
    if (this.phase === 'end') return;
    if (this.phase === 'pre') {
      this.phase = 'first';
      this.kickoff('home');
      this.log({ type: 'kickoff', side: null, text: 'Anpfiff!' });
    }
    this.tick++;
    if (this.carrier || this.flight) this.teams[this.possession].stats.possessionTicks++;

    // Automatik/KI alle 40 Ticks (30 virtuelle Sekunden)
    if (this.tick % 40 === 0) for (const s of ['home', 'away'] as const) this.autoManage(this.teams[s]);

    if (this.deadBall) {
      for (const s of ['home', 'away'] as const) this.executeSubs(this.teams[s]);
      this.restartIn--;
      if (this.restartIn <= 0) {
        this.deadBall = false;
        const r = this.restart; this.restart = null;
        r?.();
      }
    } else {
      // Vorgemerkte Wechsel spätestens nach 45 virtuellen Sekunden ausführen
      for (const s of ['home', 'away'] as const) {
        const t = this.teams[s];
        if (t.pendingSubs.length && this.tick - t.pendingSince > 60) this.stoppage(4, this.resumeAfterSub(s));
      }
      if (!this.deadBall) this.play();
    }
    this.moveTeams();
    this.drainFitness();

    if (this.tick === TICKS_PER_HALF) {
      this.log({ type: 'halftime', side: null, text: `Halbzeit – ${this.score[0]}:${this.score[1]}` });
      for (const s of ['home', 'away'] as const) {
        const t = this.teams[s];
        this.executeSubs(t, true);
        for (const p of t.players) if (p.onPitch) p.fitness = Math.min(100, p.fitness + 2);
      }
      this.phase = 'second';
      this.deadBall = false; this.restart = null;
      this.kickoff('away');
    }
    if (this.tick >= TOTAL_TICKS) this.finish();
  }

  private resumeAfterSub(side: Side): () => void {
    const carrier = this.carrier && this.carrier.side === this.possession ? this.carrier : null;
    const poss = this.possession;
    return () => {
      const t = this.teams[poss];
      const c = carrier && carrier.onPitch ? carrier : this.onPitch(poss).find((p) => p.slotPos !== 'GK');
      if (c) this.giveBall(c, Math.round(2 * TS)); else this.kickoff(t.side);
      void side;
    };
  }

  private drainFitness(): void {
    const minutes = TICK_SECONDS / 60;
    for (const s of ['home', 'away'] as const) {
      const t = this.teams[s];
      const base = tacticLoadFactor({
        pressingIntensity: t.ti.pressingIntensity as 1 | 2 | 3 | 4 | 5,
        tempo: t.ti.tempo as 1 | 2 | 3 | 4 | 5,
        defensiveLine: t.ti.defensiveLine as 1 | 2 | 3 | 4 | 5,
        counterPress: t.ti.onBallLost === 'counter_press',
      });
      for (const p of t.players) {
        if (!p.onPitch) continue;
        p.stats.minutes += minutes;
        const f = p.slotPos === 'GK' ? 0.4 : base * (p.instr.has('get_forward') || p.instr.has('overlap') || p.instr.has('roam') ? 1.08 : 1);
        p.fitness = Math.max(0, p.fitness - fitnessLossWithFactor(minutes, f, p.input.attributes.stamina ?? 60));
      }
    }
  }

  private play(): void {
    if (this.flight) {
      const f = this.flight;
      f.ticks--;
      const k = 1 - f.ticks / f.total;
      this.setBallFrom(this.possession, f.fromU + (f.toU - f.fromU) * k, f.fromV + (f.toV - f.fromV) * k);
      this.ballZ = (f.height ?? 0) * Math.sin(Math.PI * k);
      if (f.ticks <= 0) { this.flight = null; this.ballZ = 0; f.resolve(); }
      return;
    }
    this.ballZ = 0;
    const c = this.carrier;
    if (!c || !c.onPitch) {
      const any = this.onPitch(this.possession).find((p) => p.slotPos !== 'GK');
      if (any) this.giveBall(any); else this.kickoff(this.possession);
      return;
    }
    const t = this.teams[c.side];
    const { op, d: pressure } = this.nearestOpponent(c);

    // Zweikampf, wenn ein Gegner nah ist
    if (op && pressure < 2.6 && op.beatenUntil < this.tick) {
      const ot = this.teams[op.side];
      const attempt = (1 / Math.sqrt(TS)) * (0.22 + (ot.ti.pressingIntensity - 3) * 0.02 + (ot.adv.tackling - 2) * 0.03) * (c.u > 80 ? 1.4 : 1);
      if (this.rng.next() < attempt) { this.duel(c, op); return; }
    }

    // Doppelpass: der Empfänger spielt direkt in den Lauf des Passgebers zurück
    if (this.wallPass && this.wallPass.receiver === c && this.holdTicks <= this.wallPass.at) {
      const wp = this.wallPass; this.wallPass = null;
      const giver = t.players.find((p) => p.input.id === wp.giverId);
      if (giver && giver.onPitch && giver.run?.kind === 'give_go') { this.passTo(c, t, giver, pressure, { lead: [giver.run.u, giver.run.v] }); return; }
    }
    this.holdTicks--;
    if (this.holdTicks > 0) { this.dribble(c, pressure); return; }
    this.decide(c, t, pressure);
  }

  /** Gegner zwischen Ball und Tor im Umkreis r */
  private goalSideDefenders(c: LivePlayer, r: number): number {
    let n = 0;
    for (const o of this.onPitch(OTHER[c.side])) {
      const [ou, ov] = this.posIn(o, c.side);
      if (ou > c.u - 0.5 && dist(ou, ov, c.u, c.v) < r) n++;
    }
    return n;
  }

  private dribble(c: LivePlayer, pressure: number): void {
    const blocked = this.goalSideDefenders(c, 4);
    if (blocked > 0 && c.u > 55) {
      // Gegner stellt zu: kein Raumgewinn, im letzten Drittel droht Ballverlust
      if (c.u > 70 && this.rng.next() < 0.1 * blocked) {
        const { op } = this.nearestOpponent(c);
        if (op) { op.stats.tacklesWon++; this.giveBall(op, Math.round(2 * TS)); return; }
      }
      this.setBallFrom(c.side, c.u, c.v);
      return;
    }
    const s = this.speed(c) * (pressure < 4 ? 0.45 : pressure > 10 ? 0.8 : 0.65) * VIS;
    // Ballführender sucht den freien Raum: weg vom nächsten Gegner, Richtung Tor
    const { op } = this.nearestOpponent(c);
    let side = 0;
    if (op && pressure < 8) { const [, ov] = this.posIn(op, c.side); side = ov > c.v ? -0.6 : 0.6; }
    const [tu, tv] = [Math.min(L - 4, c.u + 8), clamp(c.v + side * 4 + (GOAL_V - c.v) * (c.u > 70 ? 0.3 : 0.05), 2, W - 2)];
    const d = dist(c.u, c.v, tu, tv);
    if (d > 0.01) {
      c.vu = ((tu - c.u) / d) * (s / VIS); c.vv = ((tv - c.v) / d) * (s / VIS);
      c.u += ((tu - c.u) / d) * Math.min(s, d); c.v += ((tv - c.v) / d) * Math.min(s, d);
    }
    this.setBallFrom(c.side, c.u, c.v);
  }

  private duel(c: LivePlayer, op: LivePlayer): void {
    const ot = this.teams[op.side];
    const att = this.skill(c, 'dribbling') * 0.6 + this.skill(c, 'physical') * 0.2 + this.skill(c, 'pace') * 0.2;
    const def = this.skill(op, 'defending') * 0.65 + this.skill(op, 'physical') * 0.2 + this.skill(op, 'gameIntelligence') * 0.15;
    const pWin = sigmoid((def - att) / 7 + 0.15);
    // Foul?
    const [cu, cv] = [c.u, c.v];
    const inBox = cu > L - 16.5 && Math.abs(cv - GOAL_V) < 20.16;
    const foulP = (0.68 + (ot.adv.tackling - 2) * 0.08 + (att > def ? 0.06 : 0)) * (inBox ? 0.2 : 1);
    if (this.rng.next() < foulP) { this.foul(op, c, cu, cv); return; }
    if (this.rng.next() < pWin) {
      op.stats.tacklesWon++;
      this.giveBall(op, Math.round(2 * TS));
    } else {
      op.beatenUntil = this.tick + Math.round(4 * TS);
      c.u = Math.min(L - 3, c.u + 1.5);
      this.setBallFrom(c.side, c.u, c.v);
    }
  }

  private foul(offender: LivePlayer, victim: LivePlayer, u: number, v: number): void {
    const ot = this.teams[offender.side];
    const vt = this.teams[victim.side];
    ot.stats.fouls++; offender.stats.fouls++;
    this.log({ type: 'foul', side: offender.side, playerId: offender.input.id, otherId: victim.input.id, text: `Foul von ${offender.input.name} an ${victim.input.name}` });
    // Karten
    const hard = ot.adv.tackling - 2;
    const r = this.rng.next();
    const inDanger = u > 75;
    if (r < 0.0015 + hard * 0.002 + (inDanger ? 0.001 : 0)) this.sendOff(offender, 'red');
    else if (r < 0.19 + hard * 0.05 + (inDanger ? 0.04 : 0)) this.book(offender);
    // Verletzung
    if (this.rng.next() < 0.015 + hard * 0.01) this.injure(victim);
    // Standard
    const inBox = u > L - 16.5 && Math.abs(v - GOAL_V) < 20.16;
    if (inBox) {
      this.stoppage(40, () => this.penalty(vt));
      this.log({ type: 'penalty', side: vt.side, text: `Elfmeter für ${vt.input.shortName}!` });
      return;
    }
    const dGoal = dist(u, v, GOAL_U, GOAL_V);
    this.stoppage(20, () => {
      if (dGoal < 30 && Math.abs(v - GOAL_V) < 22) this.directFreeKick(vt, u, v);
      else {
        const vic = victim.onPitch ? victim : this.onPitch(vt.side).find((p) => p.slotPos !== 'GK');
        if (vic) { vic.u = u; vic.v = v; this.giveBall(vic, Math.round(2 * TS)); }
        else this.kickoff(vt.side);
      }
    });
  }

  private book(p: LivePlayer): void {
    const t = this.teams[p.side];
    p.yellow++; p.stats.yellow++; t.stats.yellow++;
    if (p.yellow >= 2) {
      this.log({ type: 'second_yellow', side: p.side, playerId: p.input.id, text: `Gelb-Rot für ${p.input.name}!` });
      this.sendOff(p, 'second');
    } else this.log({ type: 'yellow', side: p.side, playerId: p.input.id, text: `Gelbe Karte für ${p.input.name}` });
  }

  private sendOff(p: LivePlayer, kind: 'red' | 'second'): void {
    const t = this.teams[p.side];
    if (kind === 'red') this.log({ type: 'red', side: p.side, playerId: p.input.id, text: `Rote Karte für ${p.input.name}!` });
    p.sentOff = true; p.onPitch = false; p.stats.red = true; t.stats.red++;
    this.dirty();
    t.pendingSubs = t.pendingSubs.filter((s) => s.outId !== p.input.id);
    if (this.carrier === p) this.carrier = null;
    // Torwart vom Platz: Ersatztorwart bringen (falls Wechsel übrig), sonst geht ein Feldspieler ins Tor
    if (p.slotPos === 'GK') {
      const field = this.onPitch(p.side);
      const sub = t.players.find((x) => !x.onPitch && !x.subbedOff && !x.sentOff && !x.input.unavailable && x.input.kind === 'goalkeeper');
      const victim = [...field].filter((x) => x.slotPos !== 'GK').sort((a, b) => b.ay - a.ay)[0];
      if (sub && victim && t.stats.subsUsed < MAX_SUBS && (t.stats.subWindowsUsed < MAX_SUB_WINDOWS)) {
        victim.slotPos = 'GK';
        t.pendingSubs.push({ outId: victim.input.id, inId: sub.input.id });
        t.pendingSince = this.tick;
        this.executeSubs(t);
        sub.slotPos = 'GK'; sub.ax = 50; sub.ay = 5;
        sub.posFactor = 1;
      } else if (field.length) {
        const stand = [...field].sort((a, b) => a.ay - b.ay)[0]!;
        stand.slotPos = 'GK'; stand.ax = 50; stand.ay = 5;
      }
    }
  }

  private injure(p: LivePlayer): void {
    if (!p.onPitch) return;
    const t = this.teams[p.side];
    p.injured = true; p.stats.injured = true;
    this.log({ type: 'injury', side: p.side, playerId: p.input.id, text: `${p.input.name} ist verletzt.` });
    // Verletzte werden automatisch ersetzt, wenn möglich – sonst Unterzahl
    const bench = t.players.filter((x) => !x.onPitch && !x.subbedOff && !x.sentOff && !x.input.unavailable && !x.injured);
    const canSub = t.stats.subsUsed + t.pendingSubs.length < MAX_SUBS && (t.stats.subWindowsUsed < MAX_SUB_WINDOWS || t.pendingSubs.length > 0);
    const repl = this.bestReplacement(p, bench);
    if (canSub && repl) {
      t.pendingSubs.push({ outId: p.input.id, inId: repl.input.id });
      if (t.pendingSubs.length === 1) t.pendingSince = this.tick;
    } else {
      p.onPitch = false; p.subbedOff = true;
      this.dirty();
      if (this.carrier === p) this.carrier = null;
    }
  }

  private bestReplacement(out: LivePlayer, bench: LivePlayer[]): LivePlayer | null {
    const gk = out.slotPos === 'GK';
    const pool = bench.filter((b) => (b.input.kind === 'goalkeeper') === gk);
    let best: LivePlayer | null = null; let bs = -Infinity;
    for (const b of pool) {
      const s = effectiveRating(b.input, out.slotPos) * fitnessPerformanceMultiplier(b.fitness);
      if (s > bs) { bs = s; best = b; }
    }
    return best;
  }

  private holdFor(t: TeamState): number {
    return Math.round((3 + (5 - t.ti.tempo) * 1.2 + (t.ti.chanceCreation === 'patient' ? 2 : 0) + this.rng.int(0, 2)) * TS);
  }

  private crowdAround(side: Side, u: number, v: number, r: number): number {
    let n = 0;
    for (const o of this.onPitch(OTHER[side])) { const [ou, ov] = this.posIn(o, side); if (dist(ou, ov, u, v) < r) n++; }
    return n;
  }

  private decide(c: LivePlayer, t: TeamState, pressure: number): void {
    const ti = t.ti;
    // Torwart spielt ab
    if (c.slotPos === 'GK') { this.pass(c, t, pressure, true); return; }
    const vision = (this.skill(c, 'gameIntelligence') * 0.6 + this.skill(c, 'passing') * 0.4) / 70;
    // 1) Abschluss
    const xg = expectedGoals(c.u, c.v);
    const thr = (ti.chanceCreation === 'patient' ? 0.055 : ti.chanceCreation === 'quick' ? 0.026 : 0.037) * (c.instr.has('shoot_more') ? 0.75 : 1) * (1.1 - ti.mentality * 0.04);
    const blockers = this.goalSideDefenders(c, 6);
    if (c.u > 68 && (xg >= thr || (xg > thr * 0.45 && this.rng.next() < 0.08))) {
      if (blockers === 0 ? this.rng.next() < 0.95 : this.rng.next() < 0.6 / blockers) {
        this.shoot(c, t, xg, pressure, false);
        return;
      }
    }
    // 2) Distanzschuss bei freier Bahn
    if (c.u > 74 && c.u < 86 && Math.abs(c.v - GOAL_V) < 14 && blockers <= 1 && this.rng.next() < 0.05 * (this.skill(c, 'shooting') / 70) * (c.instr.has('shoot_more') ? 1.8 : 1)) {
      this.shoot(c, t, xg, pressure, false);
      return;
    }
    const wide = c.v < 16 || c.v > W - 16;
    // 3) Zurücklegen von der Grundlinie in den Rückraum
    if (wide && c.u > L - 12) {
      const cut = this.onPitch(t.side).filter((m) => m !== c && m.slotPos !== 'GK' && m.u > L - 22 && m.u < L - 8 && Math.abs(m.v - GOAL_V) < 11)
        .sort((a, b) => this.crowdAround(t.side, b.u, b.v, 3) - this.crowdAround(t.side, a.u, a.v, 3))[0];
      if (cut && this.rng.next() < 0.45 * vision + (t.adv.crossHeight === 'low' ? 0.15 : 0)) { this.passTo(c, t, cut, pressure, { finish: true }); return; }
    }
    // 4) Flanke
    if (wide && c.u > 72) {
      const p = 0.08 + ti.crossFrequency * 0.06 + (c.instr.has('cross_often') ? 0.15 : 0) + (c.instr.has('to_byline') && c.u > 90 ? 0.25 : 0) - (c.instr.has('cut_inside') ? 0.12 : 0);
      if (this.rng.next() < p) { this.cross(c, t); return; }
    }
    // 5) Eins-gegen-eins: Gegenspieler ausspielen
    const near = this.goalSideDefenders(c, 5);
    if (c.u > 55 && near === 1 && this.rng.next() < 0.22 * (this.skill(c, 'dribbling') / 70) + (c.instr.has('dribble_more') ? 0.15 : 0)) {
      const { op } = this.nearestOpponent(c);
      if (op) {
        const att = this.skill(c, 'dribbling') * 0.7 + this.skill(c, 'pace') * 0.3;
        const def = this.skill(op, 'defending') * 0.7 + this.skill(op, 'pace') * 0.3;
        if (this.rng.next() < sigmoid((att - def) / 10 - 0.1)) {
          op.beatenUntil = this.tick + Math.round(25 * TS);
          op.vu *= 0.2; op.vv *= 0.2;
          c.vu = this.speed(c);
          this.holdTicks = Math.round(8 * TS);
          this.log({ type: 'chance', side: t.side, playerId: c.input.id, text: `${c.input.name} lässt ${op.input.name} stehen!` });
          return;
        }
        op.stats.tacklesWon++;
        this.giveBall(op, Math.round(6 * TS));
        return;
      }
    }
    // 6) Doppelpass unter Druck
    if (pressure < 4 && c.u > 35) {
      const wall = this.onPitch(t.side).find((m) => m !== c && m.slotPos !== 'GK' && dist(m.u, m.v, c.u, c.v) > 5 && dist(m.u, m.v, c.u, c.v) < 14 && this.nearestOpponent(m).d > 3);
      if (wall && this.rng.next() < 0.3 * vision) {
        const runU = Math.min(L - 8, c.u + 13), runV = clamp(c.v + (wall.v > c.v ? 3 : -3), 3, W - 3);
        c.run = { u: runU, v: runV, until: this.tick + Math.round(40 * TS), kind: 'give_go' };
        this.wallPass = { receiver: wall, giverId: c.input.id, at: Math.round(2 * TS) };
        this.passTo(c, t, wall, pressure, {});
        return;
      }
    }
    // 7) Spielverlagerung, wenn es eng wird
    if (this.crowdAround(t.side, c.u, c.v, 12) >= 3 && c.u > 25) {
      const sw = this.onPitch(t.side).filter((m) => m !== c && m.slotPos !== 'GK' && Math.abs(m.v - c.v) > 26 && m.u > c.u - 10 && this.nearestOpponent(m).d > 7)[0];
      if (sw && this.rng.next() < 0.4 * vision) { this.passTo(c, t, sw, pressure, { lofted: true }); return; }
    }
    // 8) Freier Raum ⇒ andribbeln
    if (pressure > 7 && c.u < 82 && this.rng.next() < 0.4 + (c.instr.has('run_into_space') ? 0.15 : 0)) {
      this.holdTicks = Math.round(6 * TS);
      this.dribble(c, pressure);
      return;
    }
    this.pass(c, t, pressure, false);
  }

  /** Zielpunkt für einen Pass: läuft der Mitspieler, wird in den Lauf gespielt */
  private passPoint(m: LivePlayer): { u: number; v: number; running: boolean } {
    const r = this.activeRun(m);
    if (r && r.kind !== 'support') {
      const k = r.kind === 'behind' || r.kind === 'overlap' ? 0.8 : 0.55;
      return { u: m.u + (r.u - m.u) * k, v: m.v + (r.v - m.v) * k, running: true };
    }
    return { u: m.u, v: m.v, running: false };
  }

  private pass(c: LivePlayer, t: TeamState, pressure: number, fromKeeper: boolean): void {
    const ti = t.ti;
    const mates = this.onPitch(t.side).filter((p) => p !== c && (p.slotPos !== 'GK' || ti.buildUp === 'short'));
    if (mates.length === 0) { this.dribble(c, pressure); return; }
    const longPref = ti.buildUp === 'long' ? 1.6 : ti.buildUp === 'direct' ? 1.2 : ti.buildUp === 'short' ? 0.5 : 0.85;
    const gkLong = fromKeeper && (c.instr.has('long_kicks') ? 1.8 : c.instr.has('short_distribution') ? 0.4 : 1);
    const offLine = this.offsideLine(t.side);
    const risky = c.instr.has('risky_passes') ? 1.3 : c.instr.has('safe_passes') ? 0.7 : 1;
    const vision = (this.skill(c, 'gameIntelligence') * 0.6 + this.skill(c, 'passing') * 0.4) / 70;
    let best: LivePlayer | null = null; let bestScore = -Infinity;
    for (const m of mates) {
      const pt = this.passPoint(m);
      const d = dist(c.u, c.v, pt.u, pt.v);
      if (d < 4) continue;
      const progress = pt.u - c.u;
      const open = Math.min(this.nearestOpponentTo(t.side, pt.u, pt.v), 9);
      const focus = ti.attackFocus;
      const sideBonus = focus === 'left' ? (pt.v < 22 ? 4 : 0) : focus === 'right' ? (pt.v > W - 22 ? 4 : 0) : focus === 'center' ? (Math.abs(pt.v - GOAL_V) < 12 ? 4 : 0) : focus === 'both_wings' ? (Math.abs(pt.v - GOAL_V) > 18 ? 3 : 0) : 0;
      const lenScore = fromKeeper ? (gkLong ? d * 0.08 * (gkLong - 0.8) : 0) : (d - 18) * 0.06 * (longPref - 0.9);
      let sc = progress * 0.32 * risky + open * 1.1 + lenScore + sideBonus - (d > 35 ? (d - 35) * 0.15 : 0) + this.rng.normal(0, 1.6);
      // Läufe sehen und bedienen: kreative Passgeber finden sie öfter
      if (pt.running) sc += (1.5 + (t.adv.throughBalls - 1) * 1.2) * vision + (m.instr.has('run_in_behind') ? 1.5 : 0);
      // Abseitsstellung erkennen (Spielintelligenz)
      if (m.u > offLine + 0.3 && m.u > L / 2) sc -= 6 * vision;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (!best) { this.dribble(c, pressure); return; }
    const pt = this.passPoint(best);
    this.passTo(c, t, best, pressure, pt.running ? { lead: [pt.u, pt.v], through: pt.u > offLine } : { lofted: fromKeeper && dist(c.u, c.v, best.u, best.v) > 35 });
  }

  private nearestOpponentTo(side: Side, u: number, v: number): number {
    let bd = Infinity;
    for (const o of this.onPitch(OTHER[side])) { const [ou, ov] = this.posIn(o, side); bd = Math.min(bd, dist(ou, ov, u, v)); }
    return bd;
  }

  /** Pass ausführen: Erfolg, Abseits und Flugzeit werden beim Abspiel bestimmt, aufgelöst bei Ankunft. */
  private passTo(c: LivePlayer, t: TeamState, recv: LivePlayer, pressure: number, opt: { lead?: [number, number]; through?: boolean; lofted?: boolean; finish?: boolean }): void {
    const ti = t.ti;
    const offLine = this.offsideLine(t.side);
    const [toU0, toV0] = opt.lead ?? [recv.u, recv.v];
    const toU = clamp(toU0, 1, L - 2), toV = clamp(toV0, 1, W - 1);
    const d = dist(c.u, c.v, toU, toV);
    const open = this.nearestOpponentTo(t.side, toU, toV);
    const passing = this.skill(c, 'passing') * 0.75 + this.skill(c, 'gameIntelligence') * 0.25;
    let pSucc = 0.955 - d * 0.0075 * (1.9 - (1.35 * passing) / 99) - Math.max(0, 3 - pressure) * 0.035 - Math.max(0, 4 - open) * 0.055;
    if (opt.through) pSucc -= 0.1;
    if (opt.lofted) pSucc -= 0.04;
    if (toU > 65 && !opt.finish) pSucc -= this.crowdAround(t.side, toU, toV, 7) * 0.035 + (toU - 65) * 0.002;
    const prog = toU - c.u;
    if (prog > 12) pSucc -= (prog - 12) * 0.004;
    pSucc -= (ti.tempo - 3) * 0.012;
    pSucc = clamp(pSucc, 0.25, 0.98);
    t.stats.passes++; c.stats.passes++;
    const success = this.rng.next() < pSucc;
    const defT = this.teams[OTHER[t.side]];
    const trapShift = defT.adv.offsideTrap ? (this.rng.next() < 0.5 ? 1.6 : 0) : 0;
    const offside = recv.slotPos !== 'GK' && recv.u > offLine - trapShift + 0.3 && recv.u > L / 2 && c.u < recv.u;
    // Ballgeschwindigkeit in „Fernsehtempo“: flache Pässe schneller, hohe Bälle langsamer
    const ballSpeed = opt.lofted ? 17 : 20 + Math.min(8, d / 6);
    const total = Math.max(3, Math.round(d / (ballSpeed * VIS)));
    const fromU = c.u, fromV = c.v;
    this.carrier = null;
    this.flight = {
      fromU, fromV, toU, toV, ticks: total, total, height: opt.lofted ? Math.min(9, d / 5) : d > 30 ? 1.5 : 0,
      resolve: () => {
        if (offside) {
          t.stats.offsides++;
          this.log({ type: 'offside', side: t.side, playerId: recv.input.id, text: `Abseits – ${recv.input.name}` });
          const dt = this.teams[OTHER[t.side]];
          this.stoppage(16, () => {
            const dp = [...this.onPitch(dt.side)].filter((p) => p.slotPos !== 'GK').sort((a, b) => a.u - b.u)[0];
            if (dp) this.giveBall(dp, Math.round(6 * TS)); else this.kickoff(dt.side);
          });
          return;
        }
        if (success) {
          t.stats.passesCompleted++; c.stats.passesCompleted++;
          // Kurze Ballstafetten ohne Gegnerdruck werden nicht einzeln gezeigt, aber gezählt
          if (pressure > 5 && toU < 75 && !opt.lofted) {
            const extra = this.rng.int(4, 10);
            t.stats.passes += extra; t.stats.passesCompleted += extra; c.stats.passes += extra; c.stats.passesCompleted += extra;
          }
          recv.u = toU; recv.v = toV;
          this.lastPasser = { id: c.input.id, tick: this.tick };
          this.giveBall(recv, this.holdFor(t));
          if (opt.finish) { this.holdTicks = Math.round(1 * TS); this.shoot(recv, t, expectedGoals(recv.u, recv.v) * 1.1, this.nearestOpponent(recv).d, false); return; }
          if (this.wallPass && this.wallPass.receiver === recv) this.holdTicks = Math.round(6 * TS);
          if (opt.through) this.holdTicks = Math.round(4 * TS);
          return;
        }
        if (this.wallPass?.receiver === recv) this.wallPass = null;
        // Fehlpass: Seitenaus oder abgefangen
        if (toV < 2 || toV > W - 2 || this.rng.next() < 0.12) {
          const dt = this.teams[OTHER[t.side]];
          this.stoppage(12, () => {
            const near = this.nearestToPoint(dt.side, L - toU, W - toV);
            if (near) { near.u = clamp(L - toU, 3, L - 3); near.v = clamp(W - toV, 0.5, W - 0.5); this.giveBall(near, Math.round(6 * TS)); } else this.kickoff(dt.side);
          });
          return;
        }
        const interceptor = this.nearestToPoint(OTHER[t.side], L - (fromU + toU) / 2 - (toU - fromU) * 0.25, W - (fromV + toV) / 2);
        if (interceptor) { interceptor.stats.interceptions++; this.giveBall(interceptor, Math.round(6 * TS)); }
      },
    };
  }

  private wallPass: { receiver: LivePlayer; giverId: string; at: number } | null = null;
  private ballZ = 0;

  private nearestToPoint(side: Side, u: number, v: number): LivePlayer | null {
    let best: LivePlayer | null = null; let bd = Infinity;
    for (const p of this.onPitch(side)) {
      const d = dist(p.u, p.v, u, v) + (p.slotPos === 'GK' ? 8 : 0);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  private shoot(c: LivePlayer, t: TeamState, xgBase: number, pressure: number, header: boolean, setPiece?: 'free_kick' | 'penalty' | 'corner'): void {
    const dt = this.teams[OTHER[t.side]];
    const gk = this.keeper(dt);
    let xg = xgBase * (pressure < 1.5 ? 0.65 : pressure < 3 ? 0.85 : 1);
    const shotSkill = header ? this.skill(c, 'heading') : setPiece === 'free_kick' ? this.skill(c, 'freeKicks') : setPiece === 'penalty' ? this.skill(c, 'penalties') : this.skill(c, 'shooting');
    const gkSkill = (this.keeperSkill(gk, 'reflexes') + this.keeperSkill(gk, 'positioning') + this.keeperSkill(gk, setPiece === 'penalty' ? 'reactionSpeed' : 'oneOnOne')) / 3;
    xg = clamp(xg, 0.005, 0.95);
    t.stats.shots++; c.stats.shots++;
    t.stats.xg += xg; c.stats.xg += xg;
    const blockers = setPiece === 'penalty' ? 0 : this.goalSideDefenders(c, 9);
    const pOnTarget = clamp(0.15 + shotSkill / 300 + xg * 0.6 - (pressure < 1.5 ? 0.08 : 0) - blockers * 0.05, 0.1, 0.9);
    const pGoalGivenOn = clamp((xg / Math.max(0.2, pOnTarget * 0.92)) * (0.35 + shotSkill / 110) * (1.6 - gkSkill / 120), 0.02, 0.97);
    const r = this.rng.next();
    const onTarget = r < pOnTarget;
    const assist = this.lastPasser && this.tick - this.lastPasser.tick < 14 && this.lastPasser.id !== c.input.id ? this.lastPasser.id : null;
    this.lastPasser = null;
    const name = c.input.name;
    if (onTarget) {
      t.stats.shotsOnTarget++; c.stats.shotsOnTarget++;
      if (this.rng.next() < pGoalGivenOn) {
        t.stats.goals++; c.stats.goals++;
        if (assist) { const a = t.players.find((p) => p.input.id === assist); if (a) a.stats.assists++; }
        const how = setPiece === 'penalty' ? ' (Elfmeter)' : setPiece === 'free_kick' ? ' (Freistoß)' : header ? ' (Kopfball)' : '';
        this.setBallFrom(t.side, L, GOAL_V);
        this.log({ type: 'goal', side: t.side, playerId: c.input.id, otherId: assist ?? undefined, xg: round2(xg), text: `TOR für ${t.input.shortName}! ${name}${how} – ${this.score[0]}:${this.score[1]}` });
        this.stoppage(70, () => this.kickoff(dt.side));
        return;
      }
      if (gk) gk.stats.saves++;
      this.log({ type: 'save', side: t.side, playerId: c.input.id, otherId: gk?.input.id, xg: round2(xg), text: `${name} schießt – ${gk?.input.name ?? 'Abwehr'} pariert!` });
      if (this.rng.next() < 0.32) { this.corner(t); return; }
      this.stoppage(4, () => { if (gk) this.giveBall(gk, Math.round(3 * TS)); else this.kickoff(dt.side); });
      return;
    }
    if (this.rng.next() < 0.05) this.log({ type: 'woodwork', side: t.side, playerId: c.input.id, xg: round2(xg), text: `${name} trifft nur Aluminium!` });
    else this.log({ type: xg > 0.18 ? 'chance' : 'miss', side: t.side, playerId: c.input.id, xg: round2(xg), text: xg > 0.18 ? `Große Chance! ${name} vergibt.` : `${name} schießt vorbei.` });
    if (this.rng.next() < 0.18) { this.corner(t); return; }
    this.goalKick(dt.side);
  }

  private cross(c: LivePlayer, t: TeamState): void {
    const dt = this.teams[OTHER[t.side]];
    const box = this.onPitch(t.side).filter((p) => p !== c && p.slotPos !== 'GK' && ((p.u > L - 20 && Math.abs(p.v - GOAL_V) < 16) || (p.run?.kind === 'box' && p.run.u > L - 20)));
    const defenders = this.onPitch(dt.side).filter((p) => p.slotPos !== 'GK' && p.u < 20);
    t.stats.passes++; c.stats.passes++;
    const quality = this.skill(c, 'crossing') / 99;
    const crossLow = t.adv.crossHeight === 'low';
    const target = [...box].sort((a, b) => this.skill(b, crossLow ? 'shooting' : 'heading') - this.skill(a, crossLow ? 'shooting' : 'heading'))[0];
    const fromU = c.u, fromV = c.v;
    this.carrier = null;
    const aim = target?.run?.kind === 'box' ? [target.run.u, target.run.v] : [L - 9, GOAL_V + this.rng.normal(0, 4)];
    const cd = dist(fromU, fromV, aim[0]!, aim[1]!);
    const ct = Math.max(5, Math.round(cd / ((crossLow ? 18 : 14) * VIS)));
    this.flight = {
      fromU, fromV, toU: aim[0]!, toV: aim[1]!, ticks: ct, total: ct, height: crossLow ? 0.6 : 5,
      resolve: () => {
        const gk = this.keeper(dt);
        const claimP = (crossLow ? 0.05 : 0.12) * (this.keeperSkill(gk, 'commandOfArea') / 70);
        if (!target || this.rng.next() > 0.35 + quality * 0.4 + (t.adv.boxPresence - 2) * 0.06 - (box.length === 0 ? 1 : 0)) {
          if (this.rng.next() < 0.25) { this.corner(t); return; }
          const clr = defenders[0] ?? this.onPitch(dt.side)[0];
          if (clr) this.giveBall(clr, Math.round(2 * TS));
          return;
        }
        if (gk && this.rng.next() < claimP) { this.giveBall(gk, Math.round(3 * TS)); return; }
        const marker = [...defenders].sort((a, b) => dist(L - a.u, W - a.v, target.u, target.v) - dist(L - b.u, W - b.v, target.u, target.v))[0];
        const attH = this.skill(target, crossLow ? 'shooting' : 'heading') * 0.7 + this.skill(target, 'physical') * 0.3;
        const defH = marker ? this.skill(marker, 'heading') * 0.6 + this.skill(marker, 'defending') * 0.4 : 20;
        if (this.rng.next() < sigmoid((attH - defH) / 12 - 0.2)) {
          t.stats.passesCompleted++; c.stats.passesCompleted++;
          this.lastPasser = { id: c.input.id, tick: this.tick };
          target.u = clamp(aim[0]!, L - 16, L - 4); target.v = clamp(aim[1]!, GOAL_V - 10, GOAL_V + 10);
          this.setBallFrom(t.side, target.u, target.v);
          this.shoot(target, t, expectedGoals(target.u, target.v, !crossLow) * 0.95, 2.5, !crossLow);
        } else {
          if (marker) { marker.stats.interceptions++; this.giveBall(marker, Math.round(2 * TS)); }
        }
      },
    };
  }

  private corner(t: TeamState): void {
    t.stats.corners++;
    this.log({ type: 'corner', side: t.side, text: `Ecke für ${t.input.shortName}` });
    this.stoppage(30, () => {
      const taker = this.taker(t, 'corner', 'corners');
      taker.u = L - 0.5; taker.v = this.rng.next() < 0.5 ? 0.5 : W - 0.5;
      this.setBallFrom(t.side, taker.u, taker.v);
      const routine = t.input.settings.corner_routine;
      const dt = this.teams[OTHER[t.side]];
      if (routine === 'short') {
        const near = this.nearestToPoint(t.side, L - 8, taker.v < 10 ? 8 : W - 8);
        if (near && near !== taker) { near.u = L - 7; near.v = taker.v < 10 ? 10 : W - 10; this.giveBall(near, Math.round(2 * TS)); } else this.giveBall(taker, Math.round(2 * TS));
        return;
      }
      const q = this.skill(taker, 'corners') / 99;
      const box = this.onPitch(t.side).filter((p) => p !== taker && p.slotPos !== 'GK');
      const header = [...box].sort((a, b) => this.skill(b, 'heading') + this.skill(b, 'physical') * 0.3 - this.skill(a, 'heading') - this.skill(a, 'physical') * 0.3)[0];
      const zonal = dt.input.settings.defensive_set_piece;
      const defBest = Math.max(...this.onPitch(dt.side).filter((p) => p.slotPos !== 'GK').map((p) => this.skill(p, 'heading')), 30);
      const routineMod = routine === 'near_post' ? 1.0 : routine === 'far_post' ? 1.05 : 0.95;
      const defMod = zonal === 'man' ? 0.95 : zonal === 'mixed' ? 0.97 : 1;
      const pWin = clamp((0.2 + q * 0.25) * routineMod * defMod * (header ? sigmoid((this.skill(header, 'heading') - defBest) / 12) * 2 : 0), 0.05, 0.55);
      if (header && this.rng.next() < pWin) {
        header.u = routine === 'penalty_spot' ? L - 11 : L - 6 - this.rng.next() * 3;
        header.v = routine === 'near_post' ? GOAL_V + (taker.v < 10 ? -2.5 : 2.5) : routine === 'far_post' ? GOAL_V + (taker.v < 10 ? 3 : -3) : GOAL_V;
        this.lastPasser = { id: taker.input.id, tick: this.tick };
        this.setBallFrom(t.side, header.u, header.v);
        this.shoot(header, t, expectedGoals(header.u, header.v, true) * 0.85, 1.4, true);
      } else {
        const gk = this.keeper(dt);
        const clr = this.rng.next() < 0.3 && gk ? gk : this.nearestToPoint(dt.side, 8, GOAL_V);
        if (clr) this.giveBall(clr, Math.round(2 * TS)); else this.kickoff(dt.side);
      }
    });
  }

  private directFreeKick(t: TeamState, u: number, v: number): void {
    this.log({ type: 'free_kick', side: t.side, text: `Freistoß in aussichtsreicher Position für ${t.input.shortName}` });
    const taker = this.taker(t, 'free_kick', 'freeKicks');
    taker.u = u; taker.v = v;
    this.setBallFrom(t.side, u, v);
    if (this.rng.next() < 0.55) {
      const fk = this.skill(taker, 'freeKicks');
      this.shoot(taker, t, clamp(0.055 * (fk / 70) ** 1.4 * (25 / Math.max(16, dist(u, v, GOAL_U, GOAL_V))), 0.01, 0.15), 5, false, 'free_kick');
    } else {
      this.giveBall(taker, Math.round(1 * TS));
      this.cross(taker, t);
    }
  }

  private penalty(t: TeamState): void {
    const taker = this.taker(t, 'penalty', 'penalties');
    taker.u = L - 11; taker.v = GOAL_V;
    this.setBallFrom(t.side, taker.u, taker.v);
    const gk = this.keeper(this.teams[OTHER[t.side]]);
    const pen = this.skill(taker, 'penalties');
    const gkS = this.keeperSkill(gk, 'reactionSpeed');
    const pGoal = clamp(0.76 + (pen - gkS) / 400, 0.55, 0.92);
    // Elfmeter: eigene Auflösung (fester xG-Wert 0,76)
    t.stats.shots++; taker.stats.shots++; t.stats.xg += 0.76; taker.stats.xg += 0.76;
    const r = this.rng.next();
    if (r < pGoal) {
      t.stats.shotsOnTarget++; taker.stats.shotsOnTarget++;
      t.stats.goals++; taker.stats.goals++;
      this.log({ type: 'goal', side: t.side, playerId: taker.input.id, xg: 0.76, text: `TOR für ${t.input.shortName}! ${taker.input.name} (Elfmeter) – ${this.score[0]}:${this.score[1]}` });
      this.stoppage(70, () => this.kickoff(OTHER[t.side]));
    } else if (r < pGoal + (1 - pGoal) * 0.65) {
      t.stats.shotsOnTarget++; taker.stats.shotsOnTarget++;
      if (gk) gk.stats.saves++;
      this.log({ type: 'save', side: t.side, playerId: taker.input.id, otherId: gk?.input.id, xg: 0.76, text: `${gk?.input.name ?? 'Der Torwart'} hält den Elfmeter von ${taker.input.name}!` });
      this.stoppage(4, () => { if (gk) this.giveBall(gk, Math.round(3 * TS)); else this.kickoff(OTHER[t.side]); });
    } else {
      this.log({ type: 'miss', side: t.side, playerId: taker.input.id, xg: 0.76, text: `${taker.input.name} verschießt den Elfmeter!` });
      this.goalKick(OTHER[t.side]);
    }
  }

  // -------------------------------------------------------------------------
  // K2/E4: Automatik
  // -------------------------------------------------------------------------
  private autoManage(t: TeamState): void {
    const minute = (this.tick * TICK_SECONDS) / 60;
    const [my, their] = t.side === 'home' ? this.score : [this.score[1], this.score[0]];
    const s = t.input.settings;
    // Automatischer Profilwechsel (Manager-Einstellung) oder KI-Logik
    if (!t.autoSwitched && s.auto_switch_enabled && s.auto_switch_minute != null && minute >= s.auto_switch_minute) {
      const target = my < their ? s.auto_switch_when_trailing : my > their ? s.auto_switch_when_leading : null;
      if (target && target !== t.profile) this.switchProfile(t, target);
      t.autoSwitched = true;
    }
    if (t.autopilot) {
      if (!t.autoSwitched && minute >= 65) {
        const target: TacticalProfileName | null = my < their ? 'offensive' : my > their + 0 && minute >= 75 ? 'defensive' : null;
        if (target && target !== t.profile) { this.switchProfile(t, target); t.autoSwitched = true; }
      }
    }
    // Automatische Wechsel: KI, Automatik oder vom Manager aktiviert
    const autoSubs = t.autopilot || s.auto_substitutions;
    if (!autoSubs || minute < 55 || t.stats.subWindowsUsed >= MAX_SUB_WINDOWS || t.stats.subsUsed >= MAX_SUBS || t.pendingSubs.length) return;
    if (this.tick - t.lastAutoTick < 400) return;
    const field = this.onPitch(t.side);
    const bench = t.players.filter((x) => !x.onPitch && !x.subbedOff && !x.sentOff && !x.input.unavailable && !x.injured);
    const tired = field.filter((p) => p.slotPos !== 'GK' && (p.fitness < 62 || (p.yellow === 1 && minute > 60 && p.fitness < 75))).sort((a, b) => a.fitness - b.fitness);
    const window = minute < 65 ? 2 : minute < 78 ? 2 : 1;
    let n = 0;
    for (const out of tired) {
      if (n >= window || t.stats.subsUsed + t.pendingSubs.length >= MAX_SUBS) break;
      const repl = this.bestReplacement(out, bench.filter((b) => !t.pendingSubs.some((s) => s.inId === b.input.id)));
      if (!repl) continue;
      if (effectiveRating(repl.input, out.slotPos) * fitnessPerformanceMultiplier(repl.fitness) < effectiveRating(out.input, out.slotPos) * fitnessPerformanceMultiplier(out.fitness) - 1) continue;
      t.pendingSubs.push({ outId: out.input.id, inId: repl.input.id });
      n++;
    }
    if (n > 0) { t.pendingSince = this.tick; t.lastAutoTick = this.tick; }
  }

  // -------------------------------------------------------------------------
  // Ende, Ergebnis, Snapshot
  // -------------------------------------------------------------------------
  private finish(): void {
    this.phase = 'end';
    this.log({ type: 'fulltime', side: null, text: `Abpfiff – ${this.score[0]}:${this.score[1]}` });
  }

  /** 0 = ruhiger Aufbau, 1 = gefährliche Szene (für die Regie: langsamer zeigen) */
  intensity(): number {
    if (this.deadBall) return this.restartIn > 0 && this.events.length && this.tick - this.events[this.events.length - 1]!.tick < 30 ? 0.6 : 0.3;
    const [bu] = this.ballFor(this.possession);
    if (bu > L - 30) return 1;
    if (bu > L / 2 + 10) return 0.6;
    return 0.15;
  }

  snapshot(): Snapshot {
    const players: Snapshot['players'] = [];
    for (const side of ['home', 'away'] as const) {
      for (const p of this.onPitch(side)) {
        const x = side === 'home' ? p.u : L - p.u;
        const y = side === 'home' ? p.v : W - p.v;
        players.push([p.input.id, round1(x), round1(y)]);
      }
    }
    return {
      tick: this.tick,
      minute: this.minute,
      phase: this.phase,
      score: this.score,
      ball: [round1(this.bx), round1(this.by), round1(this.ballZ)],
      possession: this.carrier || this.flight ? this.possession : null,
      carrier: this.carrier?.input.id ?? null,
      intensity: this.intensity(),
      players,
      red: [this.teams.home.stats.red, this.teams.away.stats.red],
      activeProfile: [this.teams.home.profile, this.teams.away.profile],
    };
  }

  result(): MatchResult {
    const [hg, ag] = this.score;
    const all: PlayerMatchStats[] = [];
    for (const side of ['home', 'away'] as const) {
      const t = this.teams[side];
      const conceded = side === 'home' ? ag : hg;
      const scored = side === 'home' ? hg : ag;
      for (const p of t.players) {
        if (p.stats.minutes <= 0) continue;
        const s = p.stats;
        s.minutes = Math.round(s.minutes);
        s.fitnessEnd = Math.round(p.fitness * 10) / 10;
        s.xg = round2(s.xg);
        const gk = p.slotPos === 'GK' && p.input.kind === 'goalkeeper';
        const def = ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'].includes(p.slotPos);
        // Note 1–10: Tore/Vorlagen zählen voll, Fleißwerte sind gedeckelt (sonst Noteninflation)
        const per90 = 90 / Math.max(30, s.minutes);
        let r = 6.0 + s.goals * 0.9 + s.assists * 0.55 + Math.min(0.4, s.shotsOnTarget * 0.1)
          + Math.min(0.5, s.tacklesWon * per90 * 0.025) + Math.min(0.35, s.interceptions * per90 * 0.02) + Math.min(1.5, s.saves * 0.22);
        if (s.passes > 10) r += clamp((s.passesCompleted / s.passes - 0.68) * 2.5, -0.5, 0.5);
        if (gk || def) r += conceded === 0 ? 0.6 : -0.3 * conceded;
        r += scored > conceded ? 0.3 : scored < conceded ? -0.3 : 0;
        r -= s.yellow * 0.3 + (s.red ? 1.5 : 0);
        if (s.minutes < 20) r = 6 + (r - 6) * 0.5;
        s.rating = Math.round(clamp(r, 1, 10) * 10) / 10;
        all.push({ ...s });
      }
    }
    const winnerSide = hg > ag ? 'home' : ag > hg ? 'away' : null;
    const potm = [...all].filter((p) => p.minutes >= 30).sort((a, b) => (b.rating + (b.side === winnerSide ? 0.2 : 0)) - (a.rating + (a.side === winnerSide ? 0.2 : 0)))[0];
    const total = this.teams.home.stats.possessionTicks + this.teams.away.stats.possessionTicks;
    const home = { ...this.teams.home.stats, xg: round2(this.teams.home.stats.xg) };
    const away = { ...this.teams.away.stats, xg: round2(this.teams.away.stats.xg) };
    return {
      score: [hg, ag],
      stats: { home, away },
      players: all,
      events: this.events,
      playerOfTheMatch: potm?.playerId ?? null,
      possessionHome: total ? Math.round((this.teams.home.stats.possessionTicks / total) * 100) : 50,
    };
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Headless: komplette Partie ohne Wartezeit (KI-Spiele, Tests, Kalibrierung). */
export function simulate(setup: MatchSetup): MatchResult {
  const e = new MatchEngine(setup);
  while (!e.isFinished) e.step();
  return e.result();
}

/** Wiederherstellung nach Absturz: Seed + Befehlsprotokoll bis zum Tick nachspielen (deterministisch). */
export function replay(setup: MatchSetup, log: readonly CommandRecord[], toTick: number): MatchEngine {
  const e = new MatchEngine(setup);
  let i = 0;
  // Befehle mit tick = 0 vor dem ersten Schritt
  while (i < log.length && log[i]!.tick === 0) { e.applyCommand(log[i]!.side, log[i]!.cmd); i++; }
  while (e.tick < toTick && !e.isFinished) {
    e.step();
    while (i < log.length && log[i]!.tick === e.tick) { e.applyCommand(log[i]!.side, log[i]!.cmd); i++; }
  }
  return e;
}
