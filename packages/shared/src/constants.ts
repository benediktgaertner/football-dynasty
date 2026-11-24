/**
 * Verbindliche Spielregeln aus dem Master-Prompt als Konstanten.
 * Abschnittsangaben (z. B. "I1") verweisen auf den Master-Prompt.
 * Werte, die dort als "Ausgangswert" oder "vorgeschlagen" markiert sind,
 * sind hier zentral gebündelt, damit Balancing an genau einer Stelle passiert.
 */
import type { Difficulty, Region } from './domain.js';

export const MILLION = 1_000_000;

/** I1: Startkapital je Schwierigkeitsgrad. */
export const STARTING_CAPITAL: Record<Difficulty, number> = {
  easy: 320 * MILLION,
  medium: 260 * MILLION,
  hard: 210 * MILLION,
};
export const DEFAULT_DIFFICULTY: Difficulty = 'medium';

/** B1: Einladungscode. Alphabet ohne leicht verwechselbare Zeichen (0/O, 1/I/L). */
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** C1: Ligastruktur. */
export const LEAGUE_SIZE = 18;
export const LEAGUE_MATCHDAYS = 34;
export const GERMAN_TIERS = 3;

/** I3: Stadion. */
export const STADIUM_MIN_CAPACITY = 10_000;
/** Größtes Stadion nach Ausbau; beim Vereinsstart (Neubau) sind höchstens STADIUM_BUILD_MAX_CAPACITY möglich. */
export const STADIUM_MAX_CAPACITY = 80_000;
export const STADIUM_BUILD_MAX_CAPACITY = 50_000;
export const STADIUM_CAPACITY_STEP = 5_000;
/** Ausbau je 5.000er-Schritt: Grundpreis + Preis je vorhandenem Platz (Migration 0049; Welten mit Wirtschaftsfaktor skalieren) */
export const STADIUM_EXPANSION_BASE_COST = 3_200_000;
export const STADIUM_EXPANSION_COST_PER_SEAT = 30;

/** D2: Startverteilung der 400 Draft-Spieler. */
export const DRAFT_POOL_SIZE = 400;
export const DRAFT_POOL_STRENGTH_BANDS: ReadonlyArray<{ min: number; max: number; count: number }> = [
  { min: 60, max: 64, count: 10 },
  { min: 65, max: 69, count: 25 },
  { min: 70, max: 73, count: 65 },
  { min: 74, max: 78, count: 230 },
  { min: 79, max: 81, count: 55 },
  { min: 82, max: 83, count: 15 },
];
export const DRAFT_POOL_MAX_START_OVERALL = 83;
export const DRAFT_POOL_REGIONS: Record<Region, number> = {
  europe: 180,
  south_america: 85,
  africa: 65,
  asia: 40,
  north_central_america: 25,
  oceania: 5,
};

/** D3: Snake-Draft. */
export const DRAFT_PICKS_PER_MANAGER = 22;

/** H5: Vertragslaufzeit gedrafteter Spieler. */
export const DRAFT_CONTRACT_YEARS = 3;

/** D4: Marktwert-Stützpunkte (Gesamtstärke → Mio. €, Spieler mittleren Alters). */
export const MARKET_VALUE_ANCHORS: ReadonlyArray<readonly [overall: number, millions: number]> = [
  [65, 0.8],
  [70, 2.6],
  [74, 5.8],
  [76, 8.4],
  [78, 12.6],
  [80, 20.5],
  [83, 39.2],
];

/** F7: Fitness in der Partie. */
export const FITNESS_LOSS_PER_MINUTE = 0.5;
export const STAMINA_REFERENCE = 75;
export const STAMINA_FACTOR_SLOPE = 0.008;
export const TACTIC_LOAD_FACTORS = {
  very_low: 0.7,
  low: 0.85,
  normal: 1.0,
  high: 1.2,
  extreme: 1.4,
} as const;
export type TacticLoad = keyof typeof TACTIC_LOAD_FACTORS;

/** G1/G2: Training und Regeneration. */
export const TRAINING_FITNESS_COST = 20;
export const MAX_TRAINEES_PER_WEEK = 5;
export const REST_DAY_FITNESS_GAIN = 15;
export const MAX_FITNESS = 100;

/** F8: Auswechslungen. */
export const MAX_SUBSTITUTIONS = 5;
export const MAX_SUBSTITUTION_WINDOWS = 3;

/**
 * H1/H2: Transferfenster und Limits.
 * Ein Fenster ist offen, solange der nächste zu spielende Ligaspieltag im Bereich liegt.
 * Fenster 1: Saisonbeginn (inkl. Vorbereitung) bis einschließlich Spieltag 5.
 * Fenster 2: nach Spieltag 17 bis einschließlich Spieltag 22.
 */
export const TRANSFER_WINDOWS = [
  { id: 1, nextMatchdayFrom: 1, nextMatchdayTo: 5 },
  { id: 2, nextMatchdayFrom: 18, nextMatchdayTo: 22 },
] as const;
export const MAX_SIGNINGS_PER_WINDOW = 5;
export const MAX_SALES_PER_WINDOW = 5;

/** F1: Echtzeitdauer einer Live-Partie. */
export const MATCH_VIRTUAL_MINUTES = 90;
export const MATCH_REAL_SECONDS = 180;

/** I6: Prämien 2. Bundesliga. */
export const SECOND_TIER_MATCH_BONUS = { win: 0.5 * MILLION, draw: 0.25 * MILLION, loss: 0.1 * MILLION };
export const SECOND_TIER_PLACEMENT_PRIZES_MILLIONS = [
  25, 23, 21, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5,
] as const;

/** B4: Timeout-Regel, damit getrennte Manager nicht die Karriere blockieren (eigene Festlegung, siehe GAME_DESIGN.md). */
export const READINESS_TIMEOUT_SECONDS = 15 * 60;

/** Länge von Vereinsnamen und Kurznamen (C7.1). */
export const CLUB_NAME_MIN = 3;
export const CLUB_NAME_MAX = 32;
export const CLUB_SHORT_NAME_MIN = 3;
export const CLUB_SHORT_NAME_MAX = 4;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
