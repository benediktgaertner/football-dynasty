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
  CLOCK_SECONDS_PER_TICK,
  TICKS_PER_HALF,
  TOTAL_TICKS,
  type EnginePlayerInput,
  type MatchCommand,
  type MatchEvent,
  type MatchResult,
  type MatchSetup,
  type StartingLineup,
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
const BASE_HOME_ADVANTAGE = 0.02;
/**
 * Qualitätskontrast: Duelle vergleichen Angreifer und Verteidiger direkt (nicht gegen einen festen Bezugswert).
 * Größere Werte = Zufall wichtiger. Kalibriert mit packages/engine/scripts/balance.mjs (siehe docs/BALANCING.md).
 */
const Q_DUEL = 7;      // Zweikampf/Dribbling: Logit je Punkt Unterschied = 1/Q_DUEL
const Q_PASS = 50;     // Passqualität gegen Abwehrqualität des Gegners
const Q_SHOT = 0.032;  // Abschluss gegen Torwart: Torwahrscheinlichkeit × e^(Q_SHOT · Unterschied)
/** Bewegungen laufen in echter Fußballzeit: Weg je Tick = Geschwindigkeit × 0,1 s. */
const VIS = TICK_SECONDS;
/** Dauer-Faktor für Ballbehandlung, Laufwege und Reaktionen (in Ticks) */
const TS = 0.8;
/** Sekunden Fußballzeit → Ticks */
const sec = (s: number) => Math.round(s / TICK_SECONDS);
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
  /** Freilaufen: gewählter Versatz zur Grundposition (Stürmer suchen Lücken), neu bewertet alle ~1 s */
  seekU: number;
  seekV: number;
  seekTick: number;
  /** Ball abschirmen bis Tick */
  shieldUntil: number;
  stats: PlayerMatchStats;
}

/** Diagnosewerte der Entscheidungs-KI (Tests und Kalibrierung) */
export interface AiDiagnostics {
  decisions: number;
  /** Entscheidungen in guter Abschlussposition (eigene Torchance ≥ 0,08 xG) */
  shotZone: number;
  shotZoneShots: number;
  /** Rückpässe aus guter Abschlussposition */
  shotZoneBackPasses: number;
  throughBalls: number;
  throughBallsCompleted: number;
  takeOns: number;
  takeOnsWon: number;
  crosses: number;
  shields: number;
  blocks: number;
}

type RunKind = 'behind' | 'overlap' | 'inside' | 'drop' | 'box' | 'support' | 'give_go';
interface Run { u: number; v: number; until: number; kind: RunKind }

interface TeamState {
  side: Side;
  input: TeamInput;
  /** Startaufstellung (öffentlich nach dem Spiel: „zuletzt bekannte Formation“) */
  startLineup: StartingLineup;
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
  /** Art des Balls – nur für die Darstellung (flach, hoch, Flanke, Schuss, Standard) */
  kind?: BallKind;
  resolve: () => void;
}

export type BallKind = 'ground' | 'lofted' | 'through' | 'cross' | 'shot' | 'set_piece';

/**
 * Standardsituation in Vorbereitung (nur während der bestehenden Unterbrechung):
 * Zielpositionen beider Teams im Rahmen der ausführenden Mannschaft. Beeinflusst keine Wahrscheinlichkeit.
 */
interface SetPieceSetup {
  kind: 'corner' | 'free_kick' | 'penalty';
  side: Side;
  u: number;
  v: number;
  targets: Map<LivePlayer, [number, number]>;
  wall: LivePlayer[];
}

export interface CommandRecord { tick: number; side: Side; cmd: MatchCommand }

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const dist = (u1: number, v1: number, u2: number, v2: number) => Math.hypot(u1 - u2, v1 - v2);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function emptyDiag(): AiDiagnostics {
  return { decisions: 0, shotZone: 0, shotZoneShots: 0, shotZoneBackPasses: 0, throughBalls: 0, throughBallsCompleted: 0, takeOns: 0, takeOnsWon: 0, crosses: 0, shields: 0, blocks: 0 };
}

function emptyTeamStats(): TeamMatchStats {
  return { goals: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, passesCompleted: 0, possessionTicks: 0, fouls: 0, corners: 0, offsides: 0, yellow: 0, red: 0, subsUsed: 0, subWindowsUsed: 0 };
}

/** xG aus Distanz und Öffnungswinkel (eigene logistische Kurve, kalibriert auf übliche Werte). */
export function expectedGoals(u: number, v: number, header = false): number {
  const d = Math.max(0.5, dist(u, v, GOAL_U, GOAL_V));
  const a1 = Math.atan2(GOAL_V + 3.66 - v, GOAL_U - u);
  const a2 = Math.atan2(GOAL_V - 3.66 - v, GOAL_U - u);
  const angle = Math.abs(a1 - a2);
  const xg = sigmoid(-0.35 - 0.11 * d + 1.4 * angle);
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
  private setPiece: SetPieceSetup | null = null;
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
        seekU: 0, seekV: 0, seekTick: -100, shieldUntil: -1,
        posFactor: Math.max(0.5, effectiveRating(p, slotPos) / Math.max(1, p.overall)),
        stats: {
          playerId: p.id, side, minutes: 0, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, xg: 0, passes: 0, passesCompleted: 0,
          tacklesWon: 0, interceptions: 0, saves: 0, fouls: 0, yellow: 0, red: false, injured: false, fitnessStart: p.fitness, fitnessEnd: p.fitness, rating: 6,
        },
      };
    });
    const sp = input.setPieces;
    const startLineup: StartingLineup = {
      formation: getFormation(prof.formation_code) ? prof.formation_code : formation.code,
      slots: slots.filter((x) => x.playerId).map((x) => ({ playerId: x.playerId!, position: x.position, x: x.x, y: x.y })),
    };
    return {
      side, input, startLineup, profile, ti: { ...prof.team_instructions }, adv: { ...prof.advanced_options }, players, stats: emptyTeamStats(),
      pendingSubs: [], pendingSince: 0,
      takers: { free_kick: [...(sp.free_kick ?? [])], penalty: [...(sp.penalty ?? [])], corner: [...(sp.corner_left ?? []), ...(sp.corner_right ?? [])], throw_in: [...(sp.throw_in ?? [])] },
      autopilot: input.control === 'ai', lastAutoTick: 0, autoSwitched: false,
    };
  }

  // -------------------------------------------------------------------------
  // Öffentliche API
  // -------------------------------------------------------------------------
  get isFinished(): boolean { return this.phase === 'end'; }
  get minute(): number { return Math.min(90, Math.floor((this.tick * CLOCK_SECONDS_PER_TICK) / 60)); }
  get clock(): number { return Math.round(this.tick * CLOCK_SECONDS_PER_TICK * 10) / 10; }
  /** Ball ruht (Unterbrechung) und wie viele Ticks bis zur Fortsetzung */
  get isDeadBall(): boolean { return this.deadBall; }
  get ticksToRestart(): number { return this.deadBall ? this.restartIn : 0; }
  /** Wurde seit dem letzten Abruf neu aufgestellt (Anstoß, Standard, Wechsel)? Dann zeigt die Regie einen Schnitt. */
  takeCut(): boolean { const c = this.cut; this.cut = false; return c; }
  private cut = false;
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
    // Verletzte nehmen sofort nicht mehr am Spiel teil (bis zur Auswechslung bzw. dauerhaft bei Unterzahl)
    if (!c) { c = this.teams[side].players.filter((p) => p.onPitch && !p.injured); this.pitchCache[side] = c; }
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
        // Vorläufige Matchnote (nur wer schon gespielt hat)
        rating: p.stats.minutes > 0 ? this.ratingOf(p, side === 'home' ? this.score[1] : this.score[0], side === 'home' ? this.score[0] : this.score[1]) : null,
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
      this.cut = true;
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
    const minute = Math.min(this.phase === 'first' ? 45 : 90, Math.floor((this.tick * CLOCK_SECONDS_PER_TICK) / 60) + 1);
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
  /** Mannschaftsqualität der aktuell eingesetzten Elf (Position, Fitness, Heimvorteil) – Cache je ~6 Spielsekunden */
  private qCache: Record<Side, { tick: number; def: number; gk: number }> = { home: { tick: -999, def: 70, gk: 70 }, away: { tick: -999, def: 70, gk: 70 } };
  private teamQuality(side: Side): { def: number; gk: number } {
    const c = this.qCache[side];
    if (this.tick - c.tick < 60) return c;
    const field = this.onPitch(side).filter((p) => p.slotPos !== 'GK');
    c.def = field.length ? field.reduce((s, p) => s + this.skill(p, 'defending') * 0.6 + this.skill(p, 'gameIntelligence') * 0.25 + this.skill(p, 'physical') * 0.15, 0) / field.length : 40;
    const gk = this.onPitch(side).find((p) => p.slotPos === 'GK');
    c.gk = gk ? (this.keeperSkill(gk, 'reflexes') + this.keeperSkill(gk, 'positioning') + this.keeperSkill(gk, 'handling') + this.keeperSkill(gk, 'oneOnOne')) / 4 : 30;
    c.tick = this.tick;
    return c;
  }

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
      // Freilaufen: Offensivspieler suchen im letzten Drittel die Lücke zwischen den Verteidigern
      if (bu > 50 && ['ST', 'CF', 'CAM', 'LW', 'RW'].includes(p.slotPos) && this.carrier !== p) {
        if (this.tick - p.seekTick > sec(1.2)) {
          p.seekTick = this.tick;
          const gi = this.skill(p, 'gameIntelligence') / 99;
          let bestO = -1, bu2 = 0, bv2 = 0;
          for (const [du, dv] of [[0, 0], [0, -6], [0, 6], [-4, -3], [-4, 3], [3, 0]] as const) {
            const cu = clamp(u + du, 2, L - 2), cv = clamp(v + dv, 2, W - 2);
            const o = Math.min(this.nearestOpponentTo(t.side, cu, cv), 10) + this.rng.normal(0, (1 - gi) * 2) + (cu > L - 20 && Math.abs(cv - GOAL_V) < 12 ? 1.5 : 0);
            if (o > bestO) { bestO = o; bu2 = du; bv2 = dv; }
          }
          p.seekU = bu2; p.seekV = bv2;
        }
        u += p.seekU; v += p.seekV;
      }
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
    // Konter: nach Ballgewinn starten Stürmer und Flügel sofort in die Tiefe (Tempo zählt)
    const counter = t.ti.onBallWon === 'counter' && this.tick - this.lastTurnover < sec(2) && bu < L - 30;
    if (counter && this.counterPlanned !== this.lastTurnover) {
      this.counterPlanned = this.lastTurnover;
      for (const p of this.onPitch(t.side)) {
        if (p === c || !['ST', 'CF', 'LW', 'RW', 'LM', 'RM', 'CAM'].includes(p.slotPos)) continue;
        const wingSide = p.slotPos === 'LW' || p.slotPos === 'LM' ? -1 : p.slotPos === 'RW' || p.slotPos === 'RM' ? 1 : 0;
        p.run = { u: Math.min(L - 10, Math.max(p.u + 20, off + 4)), v: clamp(GOAL_V + wingSide * 18 + (p.v - GOAL_V) * 0.3, 4, W - 4), until: this.tick + sec(8), kind: 'behind' };
      }
    }
    const possessionStyle = t.ti.buildUp === 'short' || t.ti.chanceCreation === 'patient';
    for (const p of this.onPitch(t.side)) {
      if (p === c || p.slotPos === 'GK' || this.activeRun(p)) continue;
      const pos = p.slotPos;
      // Ballbesitzspiel: Mitspieler bieten sich in Passdreiecken an
      if (possessionStyle && dist(p.u, p.v, bu, bv) < 22 && this.rng.next() < 0.012) {
        const ang = Math.atan2(p.v - bv, p.u - bu);
        p.run = { u: clamp(bu + Math.cos(ang) * 11, 4, L - 6), v: clamp(bv + Math.sin(ang) * 11, 3, W - 3), until: this.tick + sec(3), kind: 'support' };
        continue;
      }
      const chance = (0.05 / TS) * this.creativity(p) * mentality * (t.ti.tempo >= 4 ? 1.15 : 1);
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
        const spt = this.deadBall && this.setPiece ? this.setPieceTarget(p, this.setPiece) : null;
        if (spt) {
          [tu, tv] = spt; urgency = 1;
        } else {
        if (this.chase && this.chase.player === p) {
          const [bu, bv] = this.ballFor(side);
          tu = bu; tv = bv; urgency = 1;
        }
        const run = defending || (this.chase && this.chase.player === p) ? null : this.activeRun(p);
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
          } else if (this.carrier) this.coverLane(p, side, (x, y) => { tu = x; tv = y; });
        } else if (defending && this.carrier && p.slotPos !== 'GK') {
          this.coverLane(p, side, (x, y) => { tu = x; tv = y; });
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
        const acc = ACCEL * (0.8 + this.skill(p, 'pace') / 250);
        if (dm > acc) { ddu = (ddu / dm) * acc; ddv = (ddv / dm) * acc; }
        p.vu += ddu; p.vv += ddv;
        p.u = clamp(p.u + p.vu * VIS, 0.5, L - 0.5);
        p.v = clamp(p.v + p.vv * VIS, 0.5, W - 0.5);
      }
    }
  }

  /**
   * Passwege schließen: der Spieler stellt sich zwischen Ballführenden und den nächsten Gegenspieler
   * in seiner Zone (Deckungsschatten), immer torseitig. Spielintelligenz bestimmt, wie gut das gelingt.
   */
  private coverLane(p: LivePlayer, side: Side, set: (u: number, v: number) => void): void {
    const c = this.carrier!;
    const [tu0, tv0] = this.targetFor(p, this.teams[side]);
    let mark: LivePlayer | null = null; let md = 11;
    for (const a of this.onPitch(OTHER[side])) {
      if (a === c || a.slotPos === 'GK') continue;
      const [au, av] = this.posIn(a, side);
      const d = dist(tu0, tv0, au, av);
      if (d < md) { md = d; mark = a; }
    }
    if (!mark) return;
    const gi = this.skill(p, 'gameIntelligence') / 99;
    const [au, av] = this.posIn(mark, side);
    const [cu, cv] = this.posIn(c, side);
    // Punkt auf der Linie Gegenspieler → Ball, 30 % Richtung Ball, leicht torseitig
    const lu = au + (cu - au) * 0.3 - 1.2, lv = av + (cv - av) * 0.3;
    const w = clamp(0.2 + gi * 0.35 + (this.skill(p, 'defending') / 99) * 0.3, 0, 0.85);
    set(clamp(tu0 + (lu - tu0) * w, 2, L - 2), clamp(tv0 + (lv - tv0) * w, 1, W - 1));
  }

  private boxPlanTick = -100;
  private counterPlanned = -1;

  private lastTurnover = -100;

  // -------------------------------------------------------------------------
  // Spielablauf
  // -------------------------------------------------------------------------
  private resetFormation(): void {
    this.cut = true;
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
    this.chase = null;
  }

  private giveBall(p: LivePlayer, hold = 2, force = false): void {
    // Liegt der Ball nicht beim Spieler, läuft er hin (kein Versetzen des Balls)
    const [bu0, bv0] = this.ballFor(p.side);
    if (!force && dist(p.u, p.v, bu0, bv0) > 3) {
      if (this.possession !== p.side) {
        this.lastTurnover = this.tick;
        for (const x of this.teams[this.possession].players) x.run = null;
        this.possession = p.side;
      }
      this.carrier = null;
      this.flight = null;
      this.chase = { player: p, then: () => this.giveBall(p, hold, true), until: this.tick + sec(5) };
      return;
    }
    if (this.possession !== p.side) {
      this.lastTurnover = this.tick;
      for (const x of this.teams[this.possession].players) x.run = null;
    }
    p.run = null;
    this.chase = null;
    this.possession = p.side;
    this.carrier = p;
    this.holdTicks = hold;
    this.flight = null;
    this.setBallFrom(p.side, p.u, p.v);
  }

  /** Spielunterbrechung mit Neustart nach kurzer Pause (ermöglicht Wechsel = Wechselfenster) */
  private stoppage(ticks: number, restart: () => void, setPiece?: SetPieceSetup): void {
    const r0 = restart;
    restart = setPiece ? () => { this.setPiece = null; r0(); } : () => { this.cut = true; this.setPiece = null; r0(); };
    this.deadBall = true;
    this.restartIn = ticks;
    this.restart = restart;
    this.carrier = null;
    this.flight = null;
    this.chase = null;
    this.setPiece = setPiece ?? null;
    if (setPiece) {
      // Ball an den Ausführungsort: größere Sprünge kurz abblenden, danach laufen die Spieler sichtbar in Position
      const [bu, bv] = this.ballFor(setPiece.side);
      if (dist(bu, bv, setPiece.u, setPiece.v) > 2) this.cut = true;
      this.setBallFrom(setPiece.side, setPiece.u, setPiece.v); this.ballZ = 0;
    }
  }

  /** Spieler an den Ausführungsort setzen; nur größere Sprünge werden (wie bisher) mit einer Abblende kaschiert */
  private snap(p: LivePlayer, u: number, v: number): void {
    if (dist(p.u, p.v, u, v) > 0.8) this.cut = true;
    p.u = u; p.v = v; p.vu = 0; p.vv = 0;
  }

  /** In den Rahmen des ausführenden Teams umgerechnetes Ziel eines Spielers */
  private setPieceTarget(p: LivePlayer, sp: SetPieceSetup): [number, number] | null {
    const t = sp.targets.get(p);
    if (!t) return null;
    return p.side === sp.side ? t : [L - t[0], W - t[1]];
  }

  /**
   * Aufstellung bei Standards (rein räumlich, keine Zufallszahlen):
   * Ecke – Kopfballstarke in den Strafraum, Verteidiger nach Mann- oder Raumdeckung;
   * Freistoß – Mauer (3–5 Spieler, 9,15 m), Torwart deckt die freie Ecke;
   * Elfmeter – Schütze am Punkt, alle anderen außerhalb von Strafraum und Teilkreis.
   */
  private buildSetPiece(kind: SetPieceSetup['kind'], att: TeamState, u: number, v: number, taker: LivePlayer | null): SetPieceSetup {
    const def = this.teams[OTHER[att.side]];
    const targets = new Map<LivePlayer, [number, number]>();
    const wall: LivePlayer[] = [];
    // Positionen der Verteidiger werden hier im Rahmen des Angreifers notiert
    const A = this.onPitch(att.side).filter((p) => p.slotPos !== 'GK');
    const D = this.onPitch(def.side).filter((p) => p.slotPos !== 'GK');
    const agk = this.keeper(att), dgk = this.keeper(def);
    const head = (p: LivePlayer) => this.skill(p, 'heading') + this.skill(p, 'physical') * 0.3;
    if (dgk) targets.set(dgk, [L - 0.6, GOAL_V]);
    if (agk) targets.set(agk, [agk.u, agk.v]);
    if (kind === 'penalty') {
      if (taker) targets.set(taker, [L - 12.4, GOAL_V]);
      const others = [...A.filter((p) => p !== taker), ...D];
      others.forEach((p, i) => {
        const k = i % 2 === 0 ? i / 2 : -(i + 1) / 2;
        targets.set(p, [L - 19.5 - (i % 3) * 1.4, clamp(GOAL_V + k * 2.4, 6, W - 6)]);
      });
      if (dgk) targets.set(dgk, [L - 0.3, GOAL_V]);
      return { kind, side: att.side, u: L - 11, v: GOAL_V, targets, wall };
    }
    const s = v < W / 2 ? -1 : 1; // Seite der Ausführung (−1 = obere Seitenlinie)
    let spots: Array<[number, number]>;
    if (kind === 'corner') {
      if (taker) targets.set(taker, [L - 0.9, v < W / 2 ? 0.9 : W - 0.9]);
      if (att.input.settings.corner_routine === 'short') {
        spots = [[L - 7, v < W / 2 ? 10 : W - 10], [L - 11, GOAL_V], [L - 6, GOAL_V - s * 3], [L - 17, GOAL_V + s * 5]];
      } else {
        spots = [[L - 4.5, GOAL_V + s * 2.6], [L - 5.2, GOAL_V - s * 4], [L - 11, GOAL_V], [L - 7, GOAL_V + s * 0.4], [L - 13, GOAL_V - s * 5.5], [L - 15.5, GOAL_V + s * 7]];
        if (att.adv.boxPresence < 3) spots.pop();
      }
    } else {
      // Freistoß: Schütze hinter dem Ball, zweiter Mann daneben, Kopfballspieler auf Höhe der Abseitslinie
      if (taker) targets.set(taker, [u - 1.3, v + 0.4]);
      spots = [[u - 1.1, v - s * 1.8], [L - 12.5, GOAL_V - 5], [L - 12, GOAL_V + 4], [L - 13.5, GOAL_V], [L - 14, GOAL_V + s * 8]];
    }
    const pool = A.filter((p) => p !== taker).sort((a, b) => head(b) - head(a));
    const boxers: LivePlayer[] = [];
    spots.forEach((spt, i) => { const p = pool[i]; if (p) { targets.set(p, spt); boxers.push(p); } });
    // Restverteidigung gegen Konter
    pool.slice(spots.length).forEach((p, i) => targets.set(p, [kind === 'corner' ? L / 2 + 6 - i * 2 : Math.min(u - 14, L / 2 + 8) - i * 3, clamp(GOAL_V + (i % 2 ? 9 : -9) * (1 + Math.floor(i / 2) * 0.4), 5, W - 5)]));
    const free = [...D];
    const take = (pt: [number, number]): LivePlayer | null => {
      let best = -1, bd = Infinity;
      free.forEach((p, i) => { const [pu, pv] = this.posIn(p, att.side); const d = dist(pu, pv, pt[0], pt[1]); if (d < bd) { bd = d; best = i; } });
      return best >= 0 ? free.splice(best, 1)[0]! : null;
    };
    if (kind === 'free_kick') {
      const dg = dist(u, v, GOAL_U, GOAL_V);
      const n = dg < 20 ? 5 : dg < 25 ? 4 : 3;
      const ux = (GOAL_U - u) / dg, vx = (GOAL_V - v) / dg;
      const cu = u + ux * 9.15, cv = v + vx * 9.15;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 0.75;
        const pt: [number, number] = [cu - vx * off, cv + ux * off];
        const p = take(pt);
        if (p) { targets.set(p, pt); wall.push(p); }
      }
      // Torwart stellt sich in die Ecke, die die Mauer nicht abdeckt
      if (dgk) targets.set(dgk, [L - 0.7, GOAL_V + (v < GOAL_V ? 1.6 : -1.6)]);
    }
    const zonal = def.input.settings.defensive_set_piece;
    if (kind === 'corner' && zonal !== 'man') {
      // Raumdeckung: Kette auf der Fünfmeterlinie, ein Spieler am kurzen Pfosten
      const zones: Array<[number, number]> = [[L - 0.8, GOAL_V + s * 3.2]];
      const nz = zonal === 'mixed' ? 3 : 5;
      for (let i = 0; i < nz; i++) zones.push([L - 5.6, GOAL_V + (i - (nz - 1) / 2) * 2.7]);
      for (const z of zones) { const p = take(z); if (p) targets.set(p, z); }
    }
    // Manndeckung der gefährlichen Angreifer (zwischen Gegner und Tor)
    for (const a of boxers) {
      const at = targets.get(a)!;
      const p = take(at);
      if (p) targets.set(p, [Math.min(L - 1, at[0] + 0.9), at[1] + (GOAL_V - at[1]) * 0.1]);
    }
    // Übrige: einer an der Strafraumgrenze, der Rest als Konterspieler
    free.forEach((p, i) => targets.set(p, i === 0 ? [L - 18, GOAL_V] : [L - 40 - i * 3, clamp(GOAL_V + (i % 2 ? 12 : -12), 5, W - 5)]));
    return { kind, side: att.side, u: kind === 'corner' ? L - 0.5 : u, v: kind === 'corner' ? (v < W / 2 ? 0.5 : W - 0.5) : v, targets, wall };
  }

  private goalKick(side: Side): void {
    const gk = this.keeper(this.teams[side]);
    this.stoppage(sec(2.5), () => {
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
    if (this.carrier || this.flight || this.chase) this.teams[this.possession].stats.possessionTicks++;

    // Automatik/KI alle 40 Ticks (30 virtuelle Sekunden)
    if (this.tick % sec(10) === 0) for (const s of ['home', 'away'] as const) this.autoManage(this.teams[s]);

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
        if (t.pendingSubs.length && this.tick - t.pendingSince > sec(5)) this.stoppage(sec(2.5), this.resumeAfterSub(s));
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
    const minutes = CLOCK_SECONDS_PER_TICK / 60;
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
    if (this.chase) {
      const ch = this.chase;
      const [bu, bv] = this.ballFor(ch.player.side);
      const d = dist(ch.player.u, ch.player.v, bu, bv);
      if (d <= 3 || this.tick >= ch.until || !ch.player.onPitch) {
        this.chase = null;
        if (ch.player.onPitch) ch.then();
        else { const any = this.onPitch(this.possession).find((p) => p.slotPos !== 'GK'); if (any) this.giveBall(any); }
      } else {
        // Ball rollt dem Spieler langsam entgegen
        const k = Math.min(1, (6 * VIS) / d);
        this.setBallFrom(ch.player.side, bu + (ch.player.u - bu) * k, bv + (ch.player.v - bv) * k);
      }
      return;
    }
    const c = this.carrier;
    if (!c || !c.onPitch) {
      const any = this.onPitch(this.possession).find((p) => p.slotPos !== 'GK');
      if (any) this.giveBall(any); else this.kickoff(this.possession);
      return;
    }
    const t = this.teams[c.side];
    const { op, d: pressure } = this.nearestOpponent(c);

    // Zweikampf, wenn ein Gegner nah ist
    if (op && pressure < 3.5 && op.beatenUntil < this.tick) {
      const ot = this.teams[op.side];
      const attempt = 0.35 * (0.22 + (ot.ti.pressingIntensity - 3) * 0.02 + (ot.adv.tackling - 2) * 0.03) * (c.u > 80 ? 1.4 : 1);
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
    const shielding = c.shieldUntil >= this.tick;
    const att = shielding
      ? this.skill(c, 'physical') * 0.6 + this.skill(c, 'dribbling') * 0.3 + this.skill(c, 'mentality') * 0.1 + 4
      : this.skill(c, 'dribbling') * 0.6 + this.skill(c, 'physical') * 0.2 + this.skill(c, 'pace') * 0.2;
    const def = shielding
      ? this.skill(op, 'physical') * 0.5 + this.skill(op, 'defending') * 0.5
      : this.skill(op, 'defending') * 0.65 + this.skill(op, 'physical') * 0.2 + this.skill(op, 'gameIntelligence') * 0.15;
    const pWin = sigmoid((def - att) / Q_DUEL + 0.15);
    // Foul?
    const [cu, cv] = [c.u, c.v];
    const inBox = cu > L - 16.5 && Math.abs(cv - GOAL_V) < 20.16;
    const foulP = (0.45 + (ot.adv.tackling - 2) * 0.08 + (att > def ? 0.06 : 0)) * (inBox ? 0.2 : 1);
    if (this.rng.next() < foulP) { this.foul(op, c, cu, cv); return; }
    if (this.rng.next() < pWin) {
      op.stats.tacklesWon++;
      this.giveBall(op, Math.round(2 * TS));
    } else {
      // Gewonnenes Duell: der Angreifer setzt sich ab, der Verteidiger braucht Zeit zum Nachsetzen
      op.beatenUntil = this.tick + Math.round(14 * TS);
      op.vu *= 0.4; op.vv *= 0.4;
      c.u = Math.min(L - 3, c.u + 0.8); c.vu = this.speed(c) * 0.9;
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
    else if (r < 0.28 + hard * 0.05 + (inDanger ? 0.04 : 0)) this.book(offender);
    // Verletzung
    if (this.rng.next() < 0.015 + hard * 0.01) this.injure(victim);
    // Standard
    const inBox = u > L - 16.5 && Math.abs(v - GOAL_V) < 20.16;
    if (inBox) {
      this.stoppage(sec(4), () => this.penalty(vt), this.buildSetPiece('penalty', vt, L - 11, GOAL_V, this.taker(vt, 'penalty', 'penalties')));
      this.log({ type: 'penalty', side: vt.side, text: `Elfmeter für ${vt.input.shortName}!` });
      return;
    }
    const dGoal = dist(u, v, GOAL_U, GOAL_V);
    const direct = dGoal < 30 && Math.abs(v - GOAL_V) < 22;
    this.stoppage(sec(3), () => {
      if (direct) this.directFreeKick(vt, u, v);
      else {
        const vic = victim.onPitch ? victim : this.onPitch(vt.side).find((p) => p.slotPos !== 'GK');
        if (vic) { vic.u = u; vic.v = v; this.giveBall(vic, Math.round(2 * TS)); }
        else this.kickoff(vt.side);
      }
    }, direct ? this.buildSetPiece('free_kick', vt, u, v, this.taker(vt, 'free_kick', 'freeKicks')) : undefined);
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
    p.vu = 0; p.vv = 0;
    this.dirty();
    // Hatte er den Ball, übernimmt der nächste Mitspieler
    if (this.carrier === p) {
      let best: LivePlayer | null = null; let bd = Infinity;
      for (const m of this.onPitch(p.side)) { const d = dist(m.u, m.v, p.u, p.v); if (d < bd) { bd = d; best = m; } }
      this.carrier = null;
      if (best) this.giveBall(best, Math.round(4 * TS));
    }
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
    const won = this.tick - this.lastTurnover < sec(8);
    const f = won && t.ti.onBallWon === 'counter' ? 0.5 : won && t.ti.onBallWon === 'hold' ? 1.4 : 1;
    return Math.max(2, Math.round(f * (3 + (5 - t.ti.tempo) * 1.2 + (t.ti.chanceCreation === 'patient' ? 2 : 0) + this.rng.int(0, 2)) * TS));
  }

  private crowdAround(side: Side, u: number, v: number, r: number): number {
    let n = 0;
    for (const o of this.onPitch(OTHER[side])) { const [ou, ov] = this.posIn(o, side); if (dist(ou, ov, u, v) < r) n++; }
    return n;
  }

  // -------------------------------------------------------------------------
  // Entscheidungs-KI (Utility AI): jede Option wird mit erwartetem Nutzen bewertet
  // -------------------------------------------------------------------------
  readonly diagnostics: Record<Side, AiDiagnostics> = { home: emptyDiag(), away: emptyDiag() };

  /** Gefahr eines Ballbesitzes an (u, v) – ähnlich „Expected Threat“ */
  private threat(u: number, v: number): number {
    const prog = (clamp(u, 0, L) / L) ** 2.2 * 0.05 * (1 - Math.min(1, Math.abs(v - GOAL_V) / 40) * 0.5);
    return expectedGoals(u, v) * 0.55 + prog;
  }

  /** Kosten eines Ballverlusts an Position u (tief = Konter des Gegners) */
  private lossCost(u: number): number {
    return 0.01 + 0.035 * (1 - clamp(u, 0, L) / L) ** 2;
  }

  /** Gegner im Schussweg (Korridor zwischen Ball und Tor, ohne Torwart) */
  private laneBlockers(side: Side, u: number, v: number, tu = GOAL_U, tv = GOAL_V, width = 1.6): LivePlayer[] {
    const out: LivePlayer[] = [];
    const du = tu - u, dv = tv - v; const len2 = du * du + dv * dv;
    if (len2 < 0.01) return out;
    for (const o of this.onPitch(OTHER[side])) {
      if (o.slotPos === 'GK') continue;
      const [ou, ov] = this.posIn(o, side);
      const k = ((ou - u) * du + (ov - v) * dv) / len2;
      if (k <= 0.03 || k >= 1) continue;
      if (dist(ou, ov, u + du * k, v + dv * k) < width + k * 0.6) out.push(o);
    }
    return out;
  }

  /** Abschlussqualität des Schützen (Schießen, Mentalität unter Druck) */
  private finishing(p: LivePlayer, pressure: number, header = false): number {
    const sk = header ? this.skill(p, 'heading') : this.skill(p, 'shooting');
    const nerve = pressure < 3 ? 1 - (1 - this.skill(p, 'mentality') / 99) * 0.3 : 1;
    const q = this.teamQuality(OTHER[p.side]);
    return Math.exp((sk - (q.gk * 0.45 + q.def * 0.55)) * Q_SHOT) * nerve;
  }

  /** Geschätzte Passerfolgsquote – dieselbe Formel nutzt passTo für die Ausführung */
  private passSuccess(c: LivePlayer, t: TeamState, toU: number, toV: number, pressure: number, opt: { through?: boolean; lofted?: boolean; finish?: boolean }): number {
    const d = dist(c.u, c.v, toU, toV);
    const { op: marker, d: open } = this.nearestOpponentAt(t.side, toU, toV);
    // Gute Verteidiger stehen enger am Gegenspieler und antizipieren
    const mDefQ = marker ? this.skill(marker, 'defending') * 0.7 + this.skill(marker, 'gameIntelligence') * 0.3 : 0;
    const passing = this.skill(c, 'passing') * 0.75 + this.skill(c, 'gameIntelligence') * 0.25;
    // Passqualität relativ zur Abwehrqualität des Gegners (gleich stark ≈ 0,7)
    const pq = clamp(0.7 + (passing - this.teamQuality(OTHER[t.side]).def) / Q_PASS, 0.25, 1.05);
    const mDef = marker ? clamp(Math.exp((mDefQ - passing) / 25), 0.45, 2.2) : 1;
    // Druck: Mentalität entscheidet, wie sauber unter Bedrängnis gespielt wird
    const nerve = 1.25 - this.skill(c, 'mentality') / 99 * 0.5;
    let p = 1.05 - (1 - pq) * 0.45 - d * 0.005 * (1.6 - pq) - Math.max(0, 3 - pressure) * 0.04 * nerve - Math.max(0, 5 - open) * 0.05 * mDef;
    // Schwierige Zuspiele (Steilpass, hoher Ball, lange Wege) hängen stark vom Passwert ab
    if (opt.through) p -= 0.02 + 0.16 * (1 - pq) ** 1.5;
    if (opt.lofted) p -= 0.02 + 0.08 * (1 - (this.skill(c, 'crossing') * 0.3 + passing * 0.7) / 99);
    if (toU > 65 && !opt.finish) p -= this.crowdAround(t.side, toU, toV, 7) * 0.018 + (toU - 65) * 0.002;
    const prog = toU - c.u;
    if (prog > 12) p -= (prog - 12) * 0.004 * (1.4 - pq);
    p -= (t.ti.tempo - 3) * 0.012;
    // Lücken zwischen Gegnern: Pässe durch Spieler hindurch werden abgefangen
    // Verteidiger mit hoher Spielintelligenz lesen den Pass
    if (!opt.lofted) for (const b of this.laneBlockers(t.side, c.u, c.v, toU, toV, 1.1)) p -= (0.12 - pq * 0.06) * (this.skill(b, 'gameIntelligence') * 0.6 + this.skill(b, 'defending') * 0.4) / 70;
    return clamp(p, 0.2, 0.98);
  }

  private decide(c: LivePlayer, t: TeamState, pressure: number): void {
    const ti = t.ti;
    if (c.slotPos === 'GK') { this.pass(c, t, pressure, true); return; }
    const dg = this.diagnostics[t.side];
    dg.decisions++;
    const gi = this.skill(c, 'gameIntelligence') / 99;
    const ment = this.skill(c, 'mentality') / 99;
    const vision = clamp(gi * 0.65 + (this.skill(c, 'passing') / 99) * 0.35, 0.1, 1.1);
    // Entscheidungsrauschen: Spielintelligenz = bessere Wahl, Mentalität = ruhiger unter Druck
    const sigma = 0.08 + 0.9 * Math.max(0, 1 - gi) ** 1.2 + (pressure < 3 ? 0.35 * Math.max(0, 1 - ment) : 0);
    type Opt = { kind: string; gain: number; loss: number; run: () => void };
    const opts: Opt[] = [];
    const here = this.threat(c.u, c.v);

    // --- Abschluss ---------------------------------------------------------
    const xgRaw = expectedGoals(c.u, c.v);
    const lane = c.u > 55 ? this.laneBlockers(t.side, c.u, c.v).length : 9;
    const shotValue = xgRaw * this.finishing(c, pressure) * 0.72 ** lane * (pressure < 1.5 ? 0.75 : pressure < 3 ? 0.88 : 1);
    const inShotZone = shotValue >= 0.08;
    if (inShotZone) dg.shotZone++;
    if (c.u > 60) {
      let bias = (c.instr.has('shoot_more') ? 1.3 : 1) * (ti.chanceCreation === 'quick' ? 1.15 : ti.chanceCreation === 'patient' ? 0.9 : 1);
      // Gute Abschlussposition: der Schuss ist die Regel (Profis schließen ab)
      if (xgRaw >= 0.06) bias *= 1.7;
      // Unter Druck schneller abschließen
      if (pressure < 2.5 && xgRaw > 0.04) bias *= 1.2;
      // Freie Schussbahn aus der zweiten Reihe (bis ca. 28 m): gute Schützen ziehen ab
      const dGoal = dist(c.u, c.v, GOAL_U, GOAL_V);
      if (lane === 0 && pressure > 2 && dGoal < 28 && dGoal > 16) bias *= 1.5 + (this.skill(c, 'shooting') - 60) / 50;
      opts.push({ kind: 'shoot', gain: shotValue * bias, loss: (1 - shotValue) * here * 0.12, run: () => { dg.shotZoneShots += inShotZone ? 1 : 0; this.shoot(c, t, xgRaw, pressure, false); } });
    }

    // --- Pässe (inkl. Steilpass, Querpass, Zurücklegen, Verlagerung) ---------
    const longPref = ti.buildUp === 'long' ? 1.5 : ti.buildUp === 'direct' ? 1.2 : ti.buildUp === 'short' ? 0.6 : 0.9;
    const won = this.tick - this.lastTurnover < sec(8);
    const risky = (c.instr.has('risky_passes') ? 1.3 : c.instr.has('safe_passes') ? 0.75 : 1) * (won && ti.onBallWon === 'counter' ? 1.4 : ti.buildUp === 'short' || ti.chanceCreation === 'patient' ? 0.85 : 1);
    const offLine = this.offsideLine(t.side);
    const wide = c.v < 16 || c.v > W - 16;
    const focus = ti.attackFocus;
    for (const m of this.onPitch(t.side)) {
      if (m === c || m.slotPos === 'GK') continue;
      // Läufe erkennt nur, wer das Spiel liest
      const r = this.activeRun(m);
      const seesRun = !!r && r.kind !== 'support' && this.rng.next() < 0.3 + 0.7 * vision;
      const pt = seesRun ? this.passPoint(m) : { u: m.u, v: m.v, running: false };
      const d = dist(c.u, c.v, pt.u, pt.v);
      if (d < 4 || d > 62) continue;
      // Abseits erkennen
      if (m.u > offLine + 0.3 && m.u > L / 2 && m.u > c.u && this.rng.next() < 0.25 + 0.75 * gi) continue;
      const through = pt.running && pt.u > c.u + 6;
      const lofted = d > 34 || (Math.abs(pt.v - c.v) > 28 && d > 26);
      const cutback = wide && c.u > L - 14 && pt.u > L - 22 && pt.u < c.u && Math.abs(pt.v - GOAL_V) < 11;
      if (through && (t.adv.throughBalls - 1) * 0.25 + vision < 0.45) continue;
      let pS = this.passSuccess(c, t, pt.u, pt.v, pressure, { through, lofted, finish: cutback });
      pS = clamp(pS * (1 + this.rng.normal(0, (1 - vision) * 0.12)), 0.05, 0.99);
      const recvOpen = Math.min(this.nearestOpponentTo(t.side, pt.u, pt.v), 10);
      const recvChance = expectedGoals(pt.u, pt.v) * this.finishing(m, recvOpen) * (recvOpen > 3 ? 1 : 0.8) * 0.72 ** this.laneBlockers(t.side, pt.u, pt.v).length;
      let value = Math.max(this.threat(pt.u, pt.v) * (0.85 + Math.min(recvOpen, 8) * 0.03), recvChance * (cutback ? 1.05 : 0.9));
      // Taktik: Passlänge, Risiko, Angriffsseite
      const prog = pt.u - c.u;
      value *= 1 + clamp(prog, -20, 30) * 0.012 * (risky - 0.85);
      value *= 1 + clamp((d - 18) / 30, -0.6, 1) * (longPref - 0.9) * 0.35;
      const sideOk = focus === 'left' ? pt.v < 22 : focus === 'right' ? pt.v > W - 22 : focus === 'center' ? Math.abs(pt.v - GOAL_V) < 12 : focus === 'both_wings' ? Math.abs(pt.v - GOAL_V) > 18 : false;
      if (sideOk) value *= 1.12;
      if (through) value *= 1 + (t.adv.throughBalls - 2) * 0.08 + (m.instr.has('run_in_behind') ? 0.1 : 0);
      const back = prog < -3;
      // Aus guter Abschlussposition nur zurückspielen, wenn der Mitspieler deutlich besser steht
      if (inShotZone && back && recvChance < shotValue * 1.6) continue;
      const kind = cutback ? 'cutback' : through ? 'through' : lofted ? 'switch' : 'pass';
      opts.push({
        kind, gain: pS * value * 0.94, loss: (1 - pS) * (here + this.lossCost((c.u + pt.u) / 2)),
        run: () => {
          if (inShotZone && back) dg.shotZoneBackPasses++;
          if (through) dg.throughBalls++;
          // Doppelpass: kurzer Pass, Passgeber startet sofort in den Raum
          if (!through && !lofted && !cutback && pressure < 4 && c.u > 35 && d > 5 && d < 14 && this.rng.next() < 0.35 * vision) {
            c.run = { u: Math.min(L - 8, c.u + 13), v: clamp(c.v + (m.v > c.v ? 3 : -3), 3, W - 3), until: this.tick + Math.round(40 * TS), kind: 'give_go' };
            this.wallPass = { receiver: m, giverId: c.input.id, at: Math.round(2 * TS) };
          }
          this.passTo(c, t, m, pressure, cutback ? { finish: true } : pt.running ? { lead: [pt.u, pt.v], through } : { lofted });
        },
      });
    }

    // --- Flanke ------------------------------------------------------------
    if ((c.v < 20 || c.v > W - 20) && c.u > 65) {
      const box = this.onPitch(t.side).filter((p) => p !== c && p.slotPos !== 'GK' && ((p.u > L - 20 && Math.abs(p.v - GOAL_V) < 16) || (p.run?.kind === 'box' && p.run.u > L - 20)));
      if (box.length) {
        const low = t.adv.crossHeight === 'low';
        const tgt = Math.max(...box.map((p) => this.skill(p, low ? 'shooting' : 'heading')));
        const pC = clamp(0.35 + (this.skill(c, 'crossing') / 99) * 0.4 + (t.adv.boxPresence - 2) * 0.06, 0.1, 0.9);
        const def = this.crowdAround(t.side, L - 8, GOAL_V, 9);
        const hx = expectedGoals(L - 8, GOAL_V, !low) * 0.95 * sigmoid((tgt - 60) / 12 - def * 0.15) * 1.6;
        const mod = (0.6 + ti.crossFrequency * 0.15) * (c.instr.has('cross_often') ? 1.35 : 1) * (c.instr.has('to_byline') && c.u > 90 ? 1.3 : 1) * (c.instr.has('cut_inside') ? 0.7 : 1);
        opts.push({ kind: 'cross', gain: pC * hx * mod, loss: (1 - pC) * (here * 0.5 + this.lossCost(c.u)), run: () => { dg.crosses++; this.cross(c, t); } });
      }
    }

    // --- Dribbling: Raum gewinnen oder Gegenspieler ausspielen ---------------
    const near = this.goalSideDefenders(c, 5);
    const { op } = this.nearestOpponent(c);
    const dribbleMod = c.instr.has('dribble_more') ? 1.3 : 1;
    if (near === 0 && c.u < L - 8 && !(inShotZone && c.u > L - 14)) {
      const fu = Math.min(L - 6, c.u + 7);
      const fv = c.v + (GOAL_V - c.v) * (c.u > 70 ? 0.25 : 0.05);
      const pKeep = clamp(0.9 + this.skill(c, 'dribbling') / 1000 + (pressure > 6 ? 0.05 : 0), 0.6, 0.995);
      const carry = Math.max(this.threat(fu, fv), expectedGoals(fu, fv) * this.finishing(c, 4) * 0.85) * (0.96 + (this.skill(c, 'pace') - 60) / 600) * (inShotZone ? 0.7 : 1);
      opts.push({ kind: 'carry', gain: pKeep * carry * dribbleMod * (c.instr.has('run_into_space') ? 1.15 : 1), loss: (1 - pKeep) * (here + this.lossCost(c.u)), run: () => { this.holdTicks = Math.round(6 * TS); this.dribble(c, pressure); } });
    } else if (near === 1 && op && op.beatenUntil < this.tick && c.u > 40) {
      const att = this.skill(c, 'dribbling') * 0.65 + this.skill(c, 'pace') * 0.25 + this.skill(c, 'physical') * 0.1;
      const def = this.skill(op, 'defending') * 0.65 + this.skill(op, 'pace') * 0.25 + this.skill(op, 'gameIntelligence') * 0.1;
      const pBeat = sigmoid((att - def) / Q_DUEL - 0.25);
      // Schlechte Entscheider überschätzen sich
      const pEst = clamp(pBeat + this.rng.normal(0, (1 - gi) * 0.15), 0.02, 0.98);
      const au2 = Math.min(L - 5, c.u + 9), av2 = c.v + (GOAL_V - c.v) * 0.3;
      const after = Math.max(this.threat(au2, av2), expectedGoals(au2, av2) * this.finishing(c, 3) * 0.85) * 1.05;
      opts.push({ kind: 'take_on', gain: pEst * after * dribbleMod, loss: (1 - pEst) * (here + this.lossCost(c.u) * 1.2), run: () => {
        dg.takeOns++;
        if (this.rng.next() < pBeat) {
          dg.takeOnsWon++;
          op.beatenUntil = this.tick + Math.round(25 * TS);
          op.vu *= 0.2; op.vv *= 0.2;
          c.vu = this.speed(c);
          this.holdTicks = Math.round(8 * TS);
          if (c.u > 65) this.log({ type: 'chance', side: t.side, playerId: c.input.id, text: `${c.input.name} lässt ${op.input.name} stehen!` });
          return;
        }
        op.stats.tacklesWon++;
        this.giveBall(op, Math.round(6 * TS));
      } });
    }

    // --- Ball halten / abschirmen ------------------------------------------
    if (pressure < 3 && op && !inShotZone) {
      const hold = this.skill(c, 'physical') * 0.6 + this.skill(c, 'dribbling') * 0.4;
      const pKeep = sigmoid((hold - this.skill(op, 'defending') * 0.6 - this.skill(op, 'physical') * 0.4) / 10 + 0.5);
      opts.push({ kind: 'shield', gain: pKeep * here * 0.8, loss: (1 - pKeep) * (here + this.lossCost(c.u)), run: () => {
        dg.shields++;
        c.shieldUntil = this.tick + Math.round(5 * TS);
        this.holdTicks = Math.round(4 * TS);
        c.vu *= 0.3; c.vv *= 0.3;
        this.setBallFrom(c.side, c.u, c.v);
      } });
    } else if (pressure >= 3 && !inShotZone && (ti.chanceCreation === 'patient' || (won && ti.onBallWon === 'hold'))) {
      // Ruhiger Aufbau: Ball halten und auf Laufwege warten
      opts.push({ kind: 'hold', gain: here * 0.97, loss: 0.002, run: () => { this.holdTicks = Math.round(4 * TS); this.dribble(c, pressure); } });
    }

    if (opts.length === 0) { this.holdTicks = Math.round(4 * TS); this.dribble(c, pressure); return; }
    let best: Opt = opts[0]!; let bs = -Infinity;
    for (const o of opts) {
      const sc = o.gain * Math.exp(this.rng.normal(0, sigma)) - o.loss;
      if (sc > bs) { bs = sc; best = o; }
    }
    best.run();
  }

  /** Zielpunkt für einen Pass: läuft der Mitspieler, wird in den Lauf gespielt */
  private passPoint(m: LivePlayer): { u: number; v: number; running: boolean } {
    const r = this.activeRun(m);
    if (r && r.kind !== 'support') {
      const k = r.kind === 'behind' || r.kind === 'overlap' ? 0.55 : 0.35;
      return { u: m.u + (r.u - m.u) * k, v: m.v + (r.v - m.v) * k, running: true };
    }
    return { u: m.u, v: m.v, running: false };
  }

  /** Torwart-Abspiel (Aufbau von hinten oder langer Abschlag) */
  private pass(c: LivePlayer, t: TeamState, pressure: number, fromKeeper: boolean): void {
    const ti = t.ti;
    const mates = this.onPitch(t.side).filter((p) => p !== c && (p.slotPos !== 'GK' || ti.buildUp === 'short'));
    if (mates.length === 0) { this.dribble(c, pressure); return; }
    const gkLong = fromKeeper ? (c.instr.has('long_kicks') ? 1.8 : c.instr.has('short_distribution') ? 0.4 : ti.buildUp === 'long' ? 1.5 : ti.buildUp === 'short' ? 0.5 : 1) : 1;
    const offLine = this.offsideLine(t.side);
    let best: LivePlayer | null = null; let bestScore = -Infinity;
    for (const m of mates) {
      const d = dist(c.u, c.v, m.u, m.v);
      if (d < 4) continue;
      const open = Math.min(this.nearestOpponentTo(t.side, m.u, m.v), 9);
      let sc = (m.u - c.u) * 0.3 + open * 1.4 + d * 0.08 * (gkLong - 0.8) + this.rng.normal(0, 1.6);
      if (m.u > offLine + 0.3 && m.u > L / 2) sc -= 12;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (!best) { this.dribble(c, pressure); return; }
    this.passTo(c, t, best, pressure, { lofted: dist(c.u, c.v, best.u, best.v) > 35 });
  }

  private nearestOpponentAt(side: Side, u: number, v: number): { op: LivePlayer | null; d: number } {
    let bd = Infinity; let best: LivePlayer | null = null;
    for (const o of this.onPitch(OTHER[side])) { const [ou, ov] = this.posIn(o, side); const d = dist(ou, ov, u, v); if (d < bd) { bd = d; best = o; } }
    return { op: best, d: bd };
  }

  private nearestOpponentTo(side: Side, u: number, v: number): number {
    let bd = Infinity;
    for (const o of this.onPitch(OTHER[side])) { const [ou, ov] = this.posIn(o, side); bd = Math.min(bd, dist(ou, ov, u, v)); }
    return bd;
  }

  /** Pass ausführen: Erfolg, Abseits und Flugzeit werden beim Abspiel bestimmt, aufgelöst bei Ankunft. */
  private passTo(c: LivePlayer, t: TeamState, recv: LivePlayer, pressure: number, opt: { lead?: [number, number]; through?: boolean; lofted?: boolean; finish?: boolean }): void {
    const offLine = this.offsideLine(t.side);
    const [toU0, toV0] = opt.lead ?? [recv.u, recv.v];
    const toU = clamp(toU0, 1, L - 2), toV = clamp(toV0, 1, W - 1);
    const d = dist(c.u, c.v, toU, toV);
    const pSucc = this.passSuccess(c, t, toU, toV, pressure, opt);
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
      fromU, fromV, toU, toV, ticks: total, total, height: opt.lofted ? Math.min(9, d / 5) : d > 30 ? 1.5 : 0, kind: opt.lofted ? 'lofted' : recv.u > c.u + 12 ? 'through' : 'ground',
      resolve: () => {
        if (offside) {
          t.stats.offsides++;
          this.log({ type: 'offside', side: t.side, playerId: recv.input.id, text: `Abseits – ${recv.input.name}` });
          const dt = this.teams[OTHER[t.side]];
          this.stoppage(sec(2.5), () => {
            const dp = [...this.onPitch(dt.side)].filter((p) => p.slotPos !== 'GK').sort((a, b) => a.u - b.u)[0];
            if (dp) this.giveBall(dp, Math.round(6 * TS)); else this.kickoff(dt.side);
          });
          return;
        }
        if (success) {
          t.stats.passesCompleted++; c.stats.passesCompleted++;
          // Verdichtete Partie: kurze Ballstafetten zwischen den gezeigten Aktionen werden mitgezählt
          if (pressure > 4 && toU < 80 && !opt.lofted) {
            const extra = this.rng.int(4, 9);
            t.stats.passes += extra; t.stats.passesCompleted += extra; c.stats.passes += extra; c.stats.passesCompleted += extra;
          }
          this.lastPasser = { id: c.input.id, tick: this.tick };
          // Ballannahme: der Empfänger läuft zum Ball (kein Versetzen von Spielern)
          if (opt.through) this.diagnostics[t.side].throughBallsCompleted++;
          this.whenReached(recv, () => {
            // Ballannahme unter Druck: Dribbling (Ballkontrolle) und Mentalität
            const rp = this.nearestOpponent(recv);
            if (!opt.finish && rp.op && rp.d < 2.2) {
              const miss = (0.16 * (1 - this.skill(recv, 'dribbling') / 99) + (opt.lofted ? 0.05 : 0)) * (1.3 - this.skill(recv, 'mentality') / 99 * 0.6) * clamp(Math.exp((this.skill(rp.op, 'defending') - this.skill(recv, 'dribbling')) / 22), 0.4, 2.5);
              if (this.rng.next() < miss) { rp.op.stats.interceptions++; this.giveBall(rp.op, Math.round(4 * TS)); return; }
            }
            this.giveBall(recv, this.holdFor(t));
            if (opt.finish) { this.holdTicks = Math.round(1 * TS); this.shoot(recv, t, expectedGoals(recv.u, recv.v) * 1.1, this.nearestOpponent(recv).d, false); return; }
            if (this.wallPass && this.wallPass.receiver === recv) this.holdTicks = Math.round(3 * TS);
            if (opt.through) this.holdTicks = Math.round(2 * TS);
          });
          return;
        }
        if (this.wallPass?.receiver === recv) this.wallPass = null;
        // Fehlpass: Seitenaus oder abgefangen
        if (toV < 2 || toV > W - 2 || this.rng.next() < 0.12) {
          const dt = this.teams[OTHER[t.side]];
          this.stoppage(sec(2), () => {
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
  private chase: { player: LivePlayer; then: () => void; until: number } | null = null;

  /** Ball liegt am Zielpunkt; Aktion erst, wenn der Spieler ihn erreicht */
  private whenReached(p: LivePlayer, then: () => void): void {
    const [bu, bv] = this.ballFor(p.side);
    if (dist(p.u, p.v, bu, bv) <= 3) { then(); return; }
    this.carrier = null;
    this.chase = { player: p, then, until: this.tick + sec(4) };
  }
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
    // Verdichtete Partie: jede gezeigte Chance steht für mehr Spielzeit ⇒ höhere Torgefahr je Abschluss
    let xg = xgBase * 2.45 * (pressure < 1.5 ? 0.65 : pressure < 3 ? 0.85 : 1);
    const shotSkill = header ? this.skill(c, 'heading') : setPiece === 'free_kick' ? this.skill(c, 'freeKicks') : setPiece === 'penalty' ? this.skill(c, 'penalties') : this.skill(c, 'shooting');
    xg = clamp(xg, 0.005, 0.95);
    t.stats.shots++; c.stats.shots++;
    t.stats.xg += xg; c.stats.xg += xg;
    // Schusshärte (Schießen + Physis) und Präzision (Schießen, Mentalität unter Druck)
    const power = header ? 10 + this.skill(c, 'heading') / 99 * 6 : setPiece === 'penalty' ? 22 + shotSkill / 99 * 6 : 17 + (shotSkill * 0.75 + this.skill(c, 'physical') * 0.25) / 99 * 13 + this.rng.normal(0, 1.5);
    const nerve = pressure < 3 && !setPiece ? 1 - (1 - this.skill(c, 'mentality') / 99) * 0.35 : 1;
    const precision = clamp((shotSkill / 99) * nerve, 0.1, 1);
    const shotDist = dist(c.u, c.v, GOAL_U, GOAL_V);
    // Verteidiger im Schussweg blocken (Verteidigung + Stellungsspiel)
    if (!setPiece || setPiece === 'free_kick') {
      for (const bl of this.laneBlockers(t.side, c.u, c.v).slice(0, setPiece === 'free_kick' ? 1 : undefined)) {
        const pB = clamp(0.16 * Math.exp((this.skill(bl, 'defending') * 0.7 + this.skill(bl, 'gameIntelligence') * 0.3 - shotSkill) / 30), 0.04, 0.4) * (setPiece ? 1.4 : 1);
        if (this.rng.next() < pB) {
          this.diagnostics[OTHER[t.side]].blocks++;
          this.lastPasser = null;
          const [bu, bv] = this.posIn(bl, t.side);
          this.log({ type: 'miss', side: t.side, playerId: c.input.id, otherId: bl.input.id, xg: round2(xg), text: `${c.input.name} zieht ab – ${bl.input.name} blockt!` });
          const fromU = c.u, fromV = c.v;
          this.carrier = null;
          const ticks = Math.max(2, Math.round(dist(fromU, fromV, bu, bv) / (power * VIS)));
          this.flight = { fromU, fromV, toU: bu, toV: bv, ticks, total: ticks, height: 0.4, kind: 'shot', resolve: () => {
            if (this.rng.next() < 0.35) { this.corner(t); return; }
            bl.stats.interceptions++; this.giveBall(bl, Math.round(3 * TS));
          } };
          return;
        }
      }
    }
    // Torwart: kurze Distanz = Eins-gegen-eins, harte Schüsse fordern Reflexe/Reaktion, weite Schüsse Stellungsspiel/Fangen
    const react = shotDist / power; // Reaktionszeit in s
    const gkSkill = setPiece === 'penalty'
      ? (this.keeperSkill(gk, 'reactionSpeed') * 0.6 + this.keeperSkill(gk, 'reflexes') * 0.4)
      : shotDist < 12
        ? (this.keeperSkill(gk, 'oneOnOne') * 0.5 + this.keeperSkill(gk, 'reflexes') * 0.3 + this.keeperSkill(gk, 'positioning') * 0.2)
        : react < 0.9
          ? (this.keeperSkill(gk, 'reflexes') * 0.45 + this.keeperSkill(gk, 'reactionSpeed') * 0.35 + this.keeperSkill(gk, 'positioning') * 0.2)
          : (this.keeperSkill(gk, 'positioning') * 0.45 + this.keeperSkill(gk, 'handling') * 0.35 + this.keeperSkill(gk, 'reflexes') * 0.2);
    const reactF = clamp(1 + (0.75 - react) * 0.35, 0.85, 1.2);
    // Torwahrscheinlichkeit: Lage (xG) × Abschlussqualität × Torwart; Präzision verteilt sie auf „aufs Tor“
    // Schütze gegen Torwart direkt verglichen: gleich stark = Lage-xG, Qualitätsvorsprung wirkt exponentiell
    // Torwart (45 %) und Abwehrqualität der gegnerischen Elf (55 %, Bedrängnis/Winkel) zusammen
    const resist = gkSkill * 0.45 + this.teamQuality(OTHER[t.side]).def * 0.55;
    const pGoal = clamp(xg * Math.exp((shotSkill - resist) * Q_SHOT) * nerve * reactF, 0.004, 0.96);
    const pOnTarget = clamp(Math.max(pGoal + 0.05, 0.12 + precision * 0.33 + xg * 0.45 - (pressure < 1.5 ? 0.06 : 0)), 0.1, 0.97);
    const pGoalGivenOn = clamp(pGoal / pOnTarget, 0.01, 0.99);
    const r = this.rng.next();
    const onTarget = r < pOnTarget;
    const assist = this.lastPasser && this.tick - this.lastPasser.tick < sec(10) && this.lastPasser.id !== c.input.id ? this.lastPasser.id : null;
    this.lastPasser = null;
    const name = c.input.name;
    const goal = onTarget && this.rng.next() < pGoalGivenOn;
    const wood = !onTarget && this.rng.next() < 0.05;
    const r2 = this.rng.next();
    const r3 = this.rng.next();
    // Zielpunkt des Schusses (Flug sichtbar, Ergebnis steht beim Abschluss fest)
    const side = this.rng.next() < 0.5 ? -1 : 1;
    const [tu, tv, h] = goal ? [L + 0.6, GOAL_V + side * (1 + this.rng.next() * 2.4), header ? 1.2 : 0.8]
      : onTarget ? [L - 0.8, GOAL_V + side * this.rng.next() * 2.5, 0.8]
      : wood ? [L, GOAL_V + side * 3.66, 1]
      : [L + 1.5, GOAL_V + side * (4.5 + this.rng.next() * 6 * (1.3 - precision)), this.rng.next() < 0.6 - precision * 0.3 ? 3.5 : 1];
    const outcome = () => {
      if (goal) {
        t.stats.shotsOnTarget++; c.stats.shotsOnTarget++;
        t.stats.goals++; c.stats.goals++;
        if (assist) { const a = t.players.find((p) => p.input.id === assist); if (a) a.stats.assists++; }
        const how = setPiece === 'penalty' ? ' (Elfmeter)' : setPiece === 'free_kick' ? ' (Freistoß)' : header ? ' (Kopfball)' : '';
        this.log({ type: 'goal', side: t.side, playerId: c.input.id, otherId: assist ?? undefined, xg: round2(xg), text: `TOR für ${t.input.shortName}! ${name}${how} – ${this.score[0]}:${this.score[1]}` });
        // Wiederanstoß wird protokolliert (Client beendet damit den Torjubel); Ablauf und Zufall unverändert
        this.stoppage(sec(6), () => { this.kickoff(dt.side); this.log({ type: 'kickoff', side: dt.side, text: 'Wiederanstoß' }); });
        return;
      }
      if (onTarget) {
        t.stats.shotsOnTarget++; c.stats.shotsOnTarget++;
        if (gk) gk.stats.saves++;
        this.log({ type: 'save', side: t.side, playerId: c.input.id, otherId: gk?.input.id, xg: round2(xg), text: `${name} schießt – ${gk?.input.name ?? 'Abwehr'} pariert!` });
        if (r2 < 0.32) { this.corner(t); return; }
        if (gk) { this.giveBall(gk, sec(4)); return; }
        this.stoppage(sec(2), () => this.kickoff(dt.side));
        return;
      }
      if (wood) this.log({ type: 'woodwork', side: t.side, playerId: c.input.id, xg: round2(xg), text: `${name} trifft nur Aluminium!` });
      else this.log({ type: xg > 0.18 ? 'chance' : 'miss', side: t.side, playerId: c.input.id, xg: round2(xg), text: xg > 0.18 ? `Große Chance! ${name} vergibt.` : `${name} schießt vorbei.` });
      if (r3 < 0.18) { this.corner(t); return; }
      this.goalKick(dt.side);
    };
    const d = dist(c.u, c.v, tu, tv);
    const ticks = Math.max(2, Math.round(d / (power * VIS)));
    this.carrier = null;
    this.flight = { fromU: c.u, fromV: c.v, toU: tu, toV: tv, ticks, total: ticks, height: h, kind: 'shot', resolve: outcome };
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
      fromU, fromV, toU: aim[0]!, toV: aim[1]!, ticks: ct, total: ct, height: crossLow ? 0.6 : 5, kind: 'cross',
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
        const reach = dist(target.u, target.v, aim[0]!, aim[1]!) < 5;
        if (reach && this.rng.next() < sigmoid((attH - defH) / 12 - 0.2)) {
          t.stats.passesCompleted++; c.stats.passesCompleted++;
          this.lastPasser = { id: c.input.id, tick: this.tick };
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
    // Eckfahne auf der Seite, auf der der Ball ins Aus ging; Spieler beziehen während der Unterbrechung Position
    const [, outV] = this.ballFor(t.side);
    const cornerTaker = this.taker(t, 'corner', 'corners');
    const sp = this.buildSetPiece('corner', t, L - 0.5, outV, cornerTaker);
    this.stoppage(sec(3.5), () => {
      const taker = cornerTaker.onPitch ? cornerTaker : this.taker(t, 'corner', 'corners');
      void this.rng.next(); // Zufallsfolge wie bisher (früher: Wahl der Eckfahne)
      this.snap(taker, L - 0.5, sp.v);
      this.possession = t.side;
      this.setBallFrom(t.side, taker.u, taker.v);
      const routine = t.input.settings.corner_routine;
      const dt = this.teams[OTHER[t.side]];
      // Ball fliegt sichtbar von der Eckfahne zum Ziel, die Entscheidung fällt bei der Ankunft
      const kick = (tu: number, tv: number, height: number, then: () => void) => {
        const d = dist(taker.u, taker.v, tu, tv);
        const ticks = Math.max(6, Math.round(d / ((height > 2 ? 15 : 19) * VIS)));
        this.carrier = null;
        this.flight = { fromU: taker.u, fromV: taker.v, toU: tu, toV: tv, ticks, total: ticks, height, kind: 'set_piece', resolve: then };
      };
      if (routine === 'short') {
        const near = this.nearestToPoint(t.side, L - 8, taker.v < 10 ? 8 : W - 8);
        if (near && near !== taker) kick(near.u, near.v, 0, () => this.giveBall(near, Math.round(2 * TS)));
        else this.giveBall(taker, Math.round(2 * TS));
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
        const hu = routine === 'penalty_spot' ? L - 11 : L - 6 - this.rng.next() * 3;
        const hv = routine === 'near_post' ? GOAL_V + (taker.v < 10 ? -2.5 : 2.5) : routine === 'far_post' ? GOAL_V + (taker.v < 10 ? 3 : -3) : GOAL_V;
        kick(hu, hv, 7, () => {
          this.snap(header, hu, hv);
          this.lastPasser = { id: taker.input.id, tick: this.tick };
          this.setBallFrom(t.side, header.u, header.v);
          this.shoot(header, t, expectedGoals(header.u, header.v, true) * 0.85, 1.4, true);
        });
      } else {
        const gk = this.keeper(dt);
        const clr = this.rng.next() < 0.3 && gk ? gk : this.nearestToPoint(dt.side, 8, GOAL_V);
        if (clr) { const [cu, cv] = this.posIn(clr, t.side); kick(cu, cv, 6, () => this.giveBall(clr, Math.round(2 * TS))); }
        else this.kickoff(dt.side);
      }
    }, sp);
  }

  private directFreeKick(t: TeamState, u: number, v: number): void {
    this.log({ type: 'free_kick', side: t.side, text: `Freistoß in aussichtsreicher Position für ${t.input.shortName}` });
    const taker = this.taker(t, 'free_kick', 'freeKicks');
    this.snap(taker, u, v);
    this.possession = t.side;
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
    this.snap(taker, L - 11, GOAL_V);
    this.possession = t.side;
    this.setBallFrom(t.side, taker.u, taker.v);
    const gk = this.keeper(this.teams[OTHER[t.side]]);
    const pen = this.skill(taker, 'penalties');
    const gkS = this.keeperSkill(gk, 'reactionSpeed');
    const pGoal = clamp(0.76 + (pen - gkS) / 400, 0.55, 0.92);
    // Elfmeter: fester xG-Wert, Torchance aus Schütze gegen Torwart
    void pGoal;
    this.shoot(taker, t, clamp(0.76 + (pen - gkS) / 400, 0.55, 0.92), 9, false, 'penalty');
  }

  // -------------------------------------------------------------------------
  // K2/E4: Automatik
  // -------------------------------------------------------------------------
  private autoManage(t: TeamState): void {
    const minute = (this.tick * CLOCK_SECONDS_PER_TICK) / 60;
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
    if (this.tick - t.lastAutoTick < sec(40)) return;
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
      clock: this.clock,
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
      ballKind: this.flight?.kind ?? null,
      setPiece: this.deadBall && this.setPiece ? { kind: this.setPiece.kind, side: this.setPiece.side, wall: this.setPiece.wall.map((p) => p.input.id) } : null,
    };
  }

  /** Note 1–10 aus den bisherigen Spielwerten (am Spielende endgültig, während der Partie vorläufig) */
  private ratingOf(p: LivePlayer, conceded: number, scored: number): number {
    const s = p.stats;
    const minutes = Math.round(s.minutes);
    const gk = p.slotPos === 'GK' && p.input.kind === 'goalkeeper';
    const def = ['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'].includes(p.slotPos);
    // Note 1–10: Tore/Vorlagen zählen voll, Fleißwerte sind gedeckelt (sonst Noteninflation)
    const per90 = 90 / Math.max(30, minutes);
    let r = 6.0 + s.goals * 0.9 + s.assists * 0.55 + Math.min(0.4, s.shotsOnTarget * 0.1)
      + Math.min(0.5, s.tacklesWon * per90 * 0.025) + Math.min(0.35, s.interceptions * per90 * 0.02) + Math.min(1.5, s.saves * 0.22);
    if (s.passes > 10) r += clamp((s.passesCompleted / s.passes - 0.68) * 2.5, -0.5, 0.5);
    if (gk || def) r += conceded === 0 ? 0.6 : -0.3 * conceded;
    r += scored > conceded ? 0.3 : scored < conceded ? -0.3 : 0;
    r -= s.yellow * 0.3 + (s.red ? 1.5 : 0);
    if (minutes < 20) r = 6 + (r - 6) * 0.5;
    return Math.round(clamp(r, 1, 10) * 10) / 10;
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
        s.rating = this.ratingOf(p, conceded, scored);
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
      lineups: { home: this.teams.home.startLineup, away: this.teams.away.startLineup },
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
