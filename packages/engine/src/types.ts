import type { AdvancedOptions, Position, TacticalProfileName, TeamInstructions } from '@fd/shared';

/** Spielfeld in Metern. Heimteam spielt Richtung +x, Gastteam Richtung −x. */
export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
/**
 * Zeitmodell (Wunsch: komplette Partie sehen, Bewegungen 2-fach, ca. 90 s je Halbzeit):
 * 1. Bewegung: jeder Tick ist 0,1 s Bewegungszeit (TICK_SECONDS). Laufen, Pässe, Schüsse folgen
 *    echter Physik und werden mit PLAYBACK_SPEED = 2 abgespielt (50 ms Echtzeit je Tick).
 * 2. Spieluhr: läuft schneller als die Bewegung – CLOCK_SECONDS_PER_TICK = 1,5 s Spielzeit je Tick.
 *    3.600 Ticks = 90 Spielminuten = 180 s Echtzeit (90 s je Halbzeit). Fitness, Einsatzminuten
 *    und alle minutenbasierten Regeln laufen über die Spieluhr.
 * 3. Wiedergabe: durchgehend, ohne Szenensprünge. Der Server ist autoritativ und rechnet im Gleichschritt.
 */
export const TICK_SECONDS = 0.1;
export const CLOCK_SECONDS_PER_TICK = 1.5;
export const TICKS_PER_HALF = 1800;
export const TOTAL_TICKS = TICKS_PER_HALF * 2;
export const PLAYBACK_SPEED = 2;
export const MATCH_REAL_SECONDS = 180;
/** Echtzeit je Tick während der Wiedergabe */
export const PLAYBACK_MS_PER_TICK = (TICK_SECONDS * 1000) / PLAYBACK_SPEED;

export type Side = 'home' | 'away';

export interface EnginePlayerInput {
  id: string;
  shirt: number;
  name: string; // Nachname für Anzeige
  main_position: Position;
  secondary_positions: Position[];
  overall: number;
  fitness: number;
  kind: 'outfield' | 'goalkeeper';
  attributes: Record<string, number>;
  unavailable?: boolean;
}

export interface ProfileInput {
  formation_code: string;
  slots: Array<{ slotIndex: number; position: Position; x: number; y: number; playerId: string | null }>;
  team_instructions: TeamInstructions;
  advanced_options: AdvancedOptions;
  instructions: Record<string, string[]>;
}

export interface ClubSettingsInput {
  active_profile: TacticalProfileName;
  auto_substitutions: boolean;
  auto_switch_enabled: boolean;
  auto_switch_minute: number | null;
  auto_switch_when_trailing: TacticalProfileName | null;
  auto_switch_when_leading: TacticalProfileName | null;
  corner_routine: 'short' | 'near_post' | 'far_post' | 'penalty_spot';
  defensive_set_piece: 'zonal' | 'man' | 'mixed';
}

export interface TeamInput {
  clubId: string;
  name: string;
  shortName: string;
  color: string;
  colorAlt: string;
  /** human = Manager steuert live (Automatik nur, wenn aktiviert); ai = KI-Manager (K2) */
  control: 'human' | 'ai';
  squad: EnginePlayerInput[];
  profiles: Record<TacticalProfileName, ProfileInput>;
  settings: ClubSettingsInput;
  setPieces: Partial<Record<'free_kick' | 'penalty' | 'corner_left' | 'corner_right' | 'throw_in' | 'target_man', string[]>>;
}

export interface MatchSetup {
  seed: string;
  home: TeamInput;
  away: TeamInput;
  /** I5: zusätzlicher Heimvorteil 0 … 0,04 (aus Auslastung/Stadiongröße); 0 bei neutralem Platz */
  homeAdvantage: number;
}

export type MatchCommand =
  | { kind: 'profile'; name: TacticalProfileName }
  | { kind: 'settings'; team_instructions: Partial<TeamInstructions> }
  | { kind: 'sub'; outId: string; inId: string }
  | { kind: 'move'; playerId: string; x: number; y: number }
  | { kind: 'instructions'; playerId: string; codes: string[] }
  | { kind: 'set_piece'; role: 'free_kick' | 'penalty' | 'corner' | 'throw_in'; playerId: string }
  /** nur Server-intern (E4: Manager abwesend/zurück) – wird für Replays protokolliert */
  | { kind: 'autopilot'; on: boolean };

export interface MatchEvent {
  tick: number;
  minute: number;
  type:
    | 'kickoff' | 'goal' | 'shot' | 'save' | 'miss' | 'woodwork' | 'yellow' | 'second_yellow' | 'red' | 'foul'
    | 'injury' | 'sub' | 'halftime' | 'fulltime' | 'corner' | 'offside' | 'penalty' | 'free_kick' | 'tactic' | 'chance';
  side: Side | null;
  playerId?: string;
  otherId?: string;
  text: string;
  xg?: number;
}

export interface PlayerMatchStats {
  playerId: string;
  side: Side;
  minutes: number;
  goals: number;
  assists: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  tacklesWon: number;
  interceptions: number;
  saves: number;
  fouls: number;
  yellow: number;
  red: boolean;
  injured: boolean;
  fitnessStart: number;
  fitnessEnd: number;
  rating: number;
}

export interface TeamMatchStats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  xg: number;
  passes: number;
  passesCompleted: number;
  possessionTicks: number;
  fouls: number;
  corners: number;
  offsides: number;
  yellow: number;
  red: number;
  subsUsed: number;
  subWindowsUsed: number;
}

export interface Snapshot {
  tick: number;
  /** Spieluhr in Sekunden Fußballzeit */
  clock: number;
  minute: number;
  phase: 'pre' | 'first' | 'second' | 'end';
  score: [number, number];
  /** x, y, Höhe (m) */
  ball: [number, number, number];
  possession: Side | null;
  /** Ballführender Spieler */
  carrier: string | null;
  /** 0–1: wie gefährlich die Szene gerade ist (Regie verlangsamt gefährliche Szenen) */
  intensity: number;
  /** [id, x, y] je Spieler auf dem Platz */
  players: Array<[string, number, number]>;
  red: [number, number];
  activeProfile: [TacticalProfileName, TacticalProfileName];
  /** Art des fliegenden Balls (Darstellung): flach, hoch, Steilpass, Flanke, Schuss, Standard */
  ballKind?: 'ground' | 'lofted' | 'through' | 'cross' | 'shot' | 'set_piece' | null;
  /** Standard in Vorbereitung (Ecke, Freistoß mit Mauer, Elfmeter) */
  setPiece?: { kind: 'corner' | 'free_kick' | 'penalty'; side: 'home' | 'away'; wall: string[] } | null;
}

/** Startelf mit Formation (Feldkoordinaten 0–100, wie in den Taktikprofilen) */
export interface StartingLineup {
  formation: string;
  slots: Array<{ playerId: string; position: string; x: number; y: number }>;
}

export interface MatchResult {
  /** Startaufstellungen beider Teams */
  lineups?: { home: StartingLineup; away: StartingLineup };
  score: [number, number];
  stats: { home: TeamMatchStats; away: TeamMatchStats };
  players: PlayerMatchStats[];
  events: MatchEvent[];
  playerOfTheMatch: string | null;
  possessionHome: number;
}
