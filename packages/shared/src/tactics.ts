import { z } from 'zod';
import type { Position } from './domain.js';
import { fitnessPerformanceMultiplier } from './rules/fitness.js';
import { positionPenalty } from './rules/positions.js';

/**
 * E1–E4: Taktikmodell. Diese Definitionen sind die einzige Quelle für Oberfläche,
 * Server-Validierung (gleiche Werte in Migration 0012, Paritätstest) und Match Engine.
 * Die Profilnamen (Offensiv/Neutral/Defensiv) geben KEINE versteckten Boni –
 * es gilt ausschließlich die gespeicherte Konfiguration.
 */

// ---------------------------------------------------------------------------
// E2: Zwölf Grundeinstellungen
// ---------------------------------------------------------------------------
export const SCALE_5 = [1, 2, 3, 4, 5] as const;

export const TEAM_SETTINGS = {
  mentality: { label: 'Mentalität', values: SCALE_5, valueLabels: ['Sehr defensiv', 'Defensiv', 'Ausgewogen', 'Offensiv', 'Sehr offensiv'] },
  buildUp: { label: 'Spielaufbau', values: ['short', 'mixed', 'direct', 'long'], valueLabels: ['Kurz', 'Gemischt', 'Direkt', 'Lang'] },
  tempo: { label: 'Spieltempo', values: SCALE_5, valueLabels: ['Sehr langsam', 'Langsam', 'Normal', 'Schnell', 'Sehr schnell'] },
  attackWidth: { label: 'Angriffsbreite', values: SCALE_5, valueLabels: ['Sehr eng', 'Eng', 'Normal', 'Breit', 'Sehr breit'] },
  attackFocus: { label: 'Angriffsfokus', values: ['left', 'center', 'right', 'both_wings', 'flexible'], valueLabels: ['Links', 'Zentrum', 'Rechts', 'Beide Flügel', 'Flexibel'] },
  chanceCreation: { label: 'Chancenerarbeitung', values: ['patient', 'mixed', 'quick'], valueLabels: ['Geduldig', 'Gemischt', 'Schnelle Abschlüsse'] },
  crossFrequency: { label: 'Flankenhäufigkeit', values: SCALE_5, valueLabels: ['Sehr selten', 'Selten', 'Normal', 'Oft', 'Sehr oft'] },
  pressingIntensity: { label: 'Pressingintensität', values: SCALE_5, valueLabels: ['Sehr gering', 'Gering', 'Normal', 'Hoch', 'Extrem'] },
  defensiveLine: { label: 'Defensive Linie', values: SCALE_5, valueLabels: ['Sehr tief', 'Tief', 'Normal', 'Hoch', 'Sehr hoch'] },
  defensiveWidth: { label: 'Defensive Breite', values: SCALE_5, valueLabels: ['Sehr eng', 'Eng', 'Normal', 'Breit', 'Sehr breit'] },
  onBallWon: { label: 'Nach Ballgewinn', values: ['hold', 'organized', 'counter'], valueLabels: ['Ball halten', 'Geordnet aufbauen', 'Schneller Konter'] },
  onBallLost: { label: 'Nach Ballverlust', values: ['retreat', 'hold_position', 'counter_press'], valueLabels: ['Zurückziehen', 'Position halten', 'Gegenpressing'] },
} as const;
export type TeamSettingKey = keyof typeof TEAM_SETTINGS;

export const teamInstructionsSchema = z
  .object({
    mentality: z.number().int().min(1).max(5),
    buildUp: z.enum(['short', 'mixed', 'direct', 'long']),
    tempo: z.number().int().min(1).max(5),
    attackWidth: z.number().int().min(1).max(5),
    attackFocus: z.enum(['left', 'center', 'right', 'both_wings', 'flexible']),
    chanceCreation: z.enum(['patient', 'mixed', 'quick']),
    crossFrequency: z.number().int().min(1).max(5),
    pressingIntensity: z.number().int().min(1).max(5),
    defensiveLine: z.number().int().min(1).max(5),
    defensiveWidth: z.number().int().min(1).max(5),
    onBallWon: z.enum(['hold', 'organized', 'counter']),
    onBallLost: z.enum(['retreat', 'hold_position', 'counter_press']),
  })
  .strict();
export type TeamInstructions = z.infer<typeof teamInstructionsSchema>;

export const DEFAULT_TEAM_INSTRUCTIONS: TeamInstructions = {
  mentality: 3, buildUp: 'mixed', tempo: 3, attackWidth: 3, attackFocus: 'flexible', chanceCreation: 'mixed',
  crossFrequency: 3, pressingIntensity: 3, defensiveLine: 3, defensiveWidth: 3, onBallWon: 'organized', onBallLost: 'hold_position',
};

// ---------------------------------------------------------------------------
// E2: Fortgeschrittene Optionen
// ---------------------------------------------------------------------------
export const ADVANCED_OPTIONS = {
  pressingTrigger: { label: 'Pressingauslöser', values: ['always', 'back_pass', 'bad_touch', 'wide_areas', 'own_half_only'], valueLabels: ['Immer', 'Rückpass', 'Schlechte Ballannahme', 'Auf den Flügeln', 'Nur eigene Hälfte'] },
  pressingDirection: { label: 'Pressingrichtung', values: ['center', 'balanced', 'wings'], valueLabels: ['Ins Zentrum lenken', 'Ausgewogen', 'Auf die Flügel lenken'] },
  offsideTrap: { label: 'Abseitsfalle', values: [false, true], valueLabels: ['Aus', 'An'] },
  restDefense: { label: 'Restverteidigung', values: [2, 3, 4], valueLabels: ['2 Spieler', '3 Spieler', '4 Spieler'] },
  marking: { label: 'Deckung', values: ['zonal', 'mixed', 'man'], valueLabels: ['Raumdeckung', 'Gemischt', 'Manndeckung'] },
  tackling: { label: 'Zweikampfhärte', values: [1, 2, 3], valueLabels: ['Zurückhaltend', 'Normal', 'Hart'] },
  positionRotation: { label: 'Positionsrotationen', values: [false, true], valueLabels: ['Aus', 'An'] },
  overload: { label: 'Überladungen', values: ['none', 'left', 'center', 'right'], valueLabels: ['Keine', 'Links', 'Zentrum', 'Rechts'] },
  throughBalls: { label: 'Steilpässe', values: [1, 2, 3], valueLabels: ['Selten', 'Normal', 'Oft'] },
  crossHeight: { label: 'Flankenhöhe', values: ['low', 'mixed', 'high'], valueLabels: ['Flach', 'Gemischt', 'Hoch'] },
  boxPresence: { label: 'Strafraumbesetzung', values: [1, 2, 3], valueLabels: ['Wenige', 'Normal', 'Viele'] },
  transitionCover: { label: 'Umschaltsicherung', values: [false, true], valueLabels: ['Aus', 'An'] },
} as const;
export type AdvancedOptionKey = keyof typeof ADVANCED_OPTIONS;

export const advancedOptionsSchema = z
  .object({
    pressingTrigger: z.enum(['always', 'back_pass', 'bad_touch', 'wide_areas', 'own_half_only']),
    pressingDirection: z.enum(['center', 'balanced', 'wings']),
    offsideTrap: z.boolean(),
    restDefense: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    marking: z.enum(['zonal', 'mixed', 'man']),
    tackling: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    positionRotation: z.boolean(),
    overload: z.enum(['none', 'left', 'center', 'right']),
    throughBalls: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    crossHeight: z.enum(['low', 'mixed', 'high']),
    boxPresence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    transitionCover: z.boolean(),
    /** Gegnerbezogen; wird vor einer Partie gesetzt (Phase 5/6) */
    pressTargets: z.array(z.string().uuid()).max(3),
    manMarking: z.array(z.object({ marker: z.string().uuid(), target: z.string().uuid() }).strict()).max(3),
  })
  .strict();
export type AdvancedOptions = z.infer<typeof advancedOptionsSchema>;

export const DEFAULT_ADVANCED_OPTIONS: AdvancedOptions = {
  pressingTrigger: 'always', pressingDirection: 'balanced', offsideTrap: false, restDefense: 3, marking: 'zonal', tackling: 2,
  positionRotation: false, overload: 'none', throughBalls: 2, crossHeight: 'mixed', boxPresence: 2, transitionCover: false,
  pressTargets: [], manMarking: [],
};

// ---------------------------------------------------------------------------
// E3: Individuelle Anweisungen je Rolle
// ---------------------------------------------------------------------------
export type RoleGroup = 'GK' | 'CB' | 'FB' | 'MID' | 'WING' | 'FWD';

export function roleGroup(position: Position): RoleGroup {
  switch (position) {
    case 'GK': return 'GK';
    case 'CB': return 'CB';
    case 'LB': case 'RB': case 'LWB': case 'RWB': return 'FB';
    case 'CDM': case 'CM': case 'CAM': return 'MID';
    case 'LM': case 'RM': case 'LW': case 'RW': return 'WING';
    case 'CF': case 'ST': return 'FWD';
  }
}

export const PLAYER_INSTRUCTIONS: Record<RoleGroup, ReadonlyArray<{ code: string; label: string }>> = {
  FWD: [
    { code: 'run_in_behind', label: 'In die Tiefe starten' },
    { code: 'come_short', label: 'Entgegenkommen' },
    { code: 'stay_central', label: 'Zentral bleiben' },
    { code: 'drift_wide', label: 'Auf die Flügel ausweichen' },
    { code: 'shoot_more', label: 'Häufiger abschließen' },
  ],
  WING: [
    { code: 'stay_wide', label: 'Außen bleiben' },
    { code: 'cut_inside', label: 'Nach innen ziehen' },
    { code: 'to_byline', label: 'Zur Grundlinie' },
    { code: 'track_back', label: 'Defensiv mitarbeiten' },
    { code: 'run_into_space', label: 'In freie Räume starten' },
  ],
  MID: [
    { code: 'hold_position', label: 'Position halten' },
    { code: 'get_forward', label: 'Vorstöße' },
    { code: 'safe_passes', label: 'Risikoarme Pässe' },
    { code: 'risky_passes', label: 'Riskante Pässe' },
    { code: 'roam', label: 'Frei bewegen' },
  ],
  FB: [
    { code: 'stay_back', label: 'Defensiv bleiben' },
    { code: 'overlap', label: 'Überlaufen' },
    { code: 'invert', label: 'Invertiert einrücken' },
    { code: 'cross_often', label: 'Häufig flanken' },
  ],
  CB: [
    { code: 'conservative', label: 'Konservativ verteidigen' },
    { code: 'step_up', label: 'Aggressiv herausrücken' },
    { code: 'support_buildup', label: 'Spielaufbau unterstützen' },
  ],
  GK: [
    { code: 'short_distribution', label: 'Kurze Spieleröffnung' },
    { code: 'long_kicks', label: 'Lange Abschläge' },
    { code: 'sweeper_keeper', label: 'Mitspielender Torwart' },
    { code: 'conservative_positioning', label: 'Konservatives Stellungsspiel' },
  ],
};

/** Anweisungen, die sich gegenseitig ausschließen */
export const CONFLICTING_INSTRUCTIONS: ReadonlyArray<readonly [string, string]> = [
  ['run_in_behind', 'come_short'],
  ['stay_central', 'drift_wide'],
  ['stay_wide', 'cut_inside'],
  ['hold_position', 'get_forward'],
  ['hold_position', 'roam'],
  ['safe_passes', 'risky_passes'],
  ['stay_back', 'overlap'],
  ['stay_back', 'invert'],
  ['overlap', 'invert'],
  ['conservative', 'step_up'],
  ['short_distribution', 'long_kicks'],
  ['sweeper_keeper', 'conservative_positioning'],
];

/** null = gültig, sonst Fehlertext */
export function validatePlayerInstructions(position: Position, codes: readonly string[]): string | null {
  const allowed = new Set(PLAYER_INSTRUCTIONS[roleGroup(position)].map((i) => i.code));
  for (const c of codes) if (!allowed.has(c)) return `Anweisung „${c}“ passt nicht zur Position ${position}.`;
  if (new Set(codes).size !== codes.length) return 'Anweisung doppelt.';
  for (const [a, b] of CONFLICTING_INSTRUCTIONS) {
    if (codes.includes(a) && codes.includes(b)) return 'Zwei Anweisungen widersprechen sich.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// E1: Aufstellung und freie Positionierung
// ---------------------------------------------------------------------------
export interface LineupSlot {
  slotIndex: number;
  position: Position;
  x: number;
  y: number;
  playerId: string | null;
}

/**
 * Rolle aus der Feldposition ableiten, wenn ein Spieler frei verschoben wird.
 * x: 0 links … 100 rechts, y: 0 eigenes Tor … 100 gegnerisches Tor.
 */
export function positionFromCoordinates(x: number, y: number, isGoalkeeperSlot: boolean): Position {
  if (isGoalkeeperSlot) return 'GK';
  const side = x < 30 ? 'L' : x > 70 ? 'R' : 'C';
  if (y < 30) return side === 'L' ? 'LB' : side === 'R' ? 'RB' : 'CB';
  if (y < 42) return side === 'L' ? 'LWB' : side === 'R' ? 'RWB' : 'CDM';
  if (y < 58) return side === 'L' ? 'LM' : side === 'R' ? 'RM' : 'CM';
  if (y < 70) return side === 'L' ? 'LW' : side === 'R' ? 'RW' : 'CAM';
  return side === 'L' ? 'LW' : side === 'R' ? 'RW' : y < 76 ? 'CF' : 'ST';
}

/** Spieler darf nur im eigenen Strafraum-Bereich als Torwart stehen; Feldspieler nicht im Tor. */
export function clampSlotCoordinates(x: number, y: number, isGoalkeeperSlot: boolean): { x: number; y: number } {
  const cx = Math.max(4, Math.min(96, x));
  if (isGoalkeeperSlot) return { x: Math.max(30, Math.min(70, cx)), y: Math.max(2, Math.min(14, y)) };
  return { x: cx, y: Math.max(12, Math.min(95, y)) };
}

export interface SquadPlayerForLineup {
  id: string;
  main_position: Position;
  secondary_positions: Position[];
  overall: number;
  fitness: number;
  unavailable?: boolean; // verletzt/gesperrt
}

/** Effektive Stärke auf einer Position (ohne Fitness) – D5 */
export function effectiveRating(player: { main_position: Position; secondary_positions: readonly Position[]; overall: number }, slotPosition: Position): number {
  return player.overall + positionPenalty(player.main_position, player.secondary_positions, slotPosition);
}

/** Aktuelle Leistungsfähigkeit inkl. Fitness (F7) – Anzeige „effektive Leistung“ */
export function matchReadyRating(player: { main_position: Position; secondary_positions: readonly Position[]; overall: number; fitness: number }, slotPosition: Position): number {
  return Math.round(effectiveRating(player, slotPosition) * fitnessPerformanceMultiplier(player.fitness));
}

/**
 * Automatische Aufstellung: Schwierige Positionen (Torwart, wenige passende Spieler) zuerst,
 * jeweils der Spieler mit der höchsten Leistungsfähigkeit. Verletzte/gesperrte werden übersprungen.
 */
export function autoLineup(slots: ReadonlyArray<Omit<LineupSlot, 'playerId'>>, squad: readonly SquadPlayerForLineup[]): LineupSlot[] {
  const available = squad.filter((p) => !p.unavailable);
  const scarcity = (pos: Position) => available.filter((p) => effectiveRating(p, pos) >= p.overall - 1).length;
  const order = [...slots].sort((a, b) => (a.position === 'GK' ? -1 : b.position === 'GK' ? 1 : scarcity(a.position) - scarcity(b.position)));
  const used = new Set<string>();
  const assigned = new Map<number, string | null>();
  for (const slot of order) {
    let best: SquadPlayerForLineup | null = null;
    let bestScore = -Infinity;
    for (const p of available) {
      if (used.has(p.id)) continue;
      if ((slot.position === 'GK') !== (p.main_position === 'GK')) continue;
      const score = matchReadyRating(p, slot.position);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) used.add(best.id);
    assigned.set(slot.slotIndex, best?.id ?? null);
  }
  return slots.map((s) => ({ ...s, playerId: assigned.get(s.slotIndex) ?? null }));
}

/** Gültigkeit einer Aufstellung (gleiche Regeln wie in SQL). null = gültig. */
export function validateLineup(slots: readonly LineupSlot[], squadIds: ReadonlySet<string>): string | null {
  if (slots.length !== 11) return 'Eine Aufstellung braucht genau 11 Positionen.';
  if (new Set(slots.map((s) => s.slotIndex)).size !== 11 || slots.some((s) => s.slotIndex < 0 || s.slotIndex > 10)) return 'Ungültige Positionsnummern.';
  if (slots.filter((s) => s.position === 'GK').length !== 1) return 'Es muss genau ein Torwart aufgestellt sein.';
  const ids = slots.map((s) => s.playerId);
  if (ids.some((id) => !id)) return 'Alle 11 Positionen müssen besetzt sein.';
  if (new Set(ids).size !== 11) return 'Ein Spieler ist doppelt aufgestellt.';
  if (ids.some((id) => !squadIds.has(id!))) return 'Ein Spieler gehört nicht zu deinem Kader.';
  if (slots.some((s) => s.x < 0 || s.x > 100 || s.y < 0 || s.y > 100)) return 'Position außerhalb des Spielfelds.';
  return null;
}

// ---------------------------------------------------------------------------
// F9: Standards
// ---------------------------------------------------------------------------
export const SET_PIECE_KINDS = [
  { kind: 'free_kick', label: 'Freistöße' },
  { kind: 'penalty', label: 'Elfmeter' },
  { kind: 'corner_left', label: 'Ecken links' },
  { kind: 'corner_right', label: 'Ecken rechts' },
  { kind: 'throw_in', label: 'Einwürfe' },
  { kind: 'target_man', label: 'Zielspieler' },
] as const;
export type SetPieceKind = (typeof SET_PIECE_KINDS)[number]['kind'];
export const MAX_SET_PIECE_PRIORITY = 3;

export const CORNER_ROUTINES = [
  { value: 'short', label: 'Kurze Ecke' },
  { value: 'near_post', label: 'Erster Pfosten' },
  { value: 'far_post', label: 'Zweiter Pfosten' },
  { value: 'penalty_spot', label: 'Elfmeterpunkt' },
] as const;
export const DEFENSIVE_SET_PIECES = [
  { value: 'zonal', label: 'Raumdeckung' },
  { value: 'man', label: 'Manndeckung' },
  { value: 'mixed', label: 'Gemischt' },
] as const;

/** Welches Attribut für einen Standard maßgeblich ist (Vorschlagsliste in der Oberfläche) */
export const SET_PIECE_ATTRIBUTE: Record<SetPieceKind, string> = {
  free_kick: 'freeKicks',
  penalty: 'penalties',
  corner_left: 'corners',
  corner_right: 'corners',
  throw_in: 'throwIns',
  target_man: 'heading',
};

// ---------------------------------------------------------------------------
// G1/G4: Training
// ---------------------------------------------------------------------------
export const TRAINING_FOCI = [
  { value: 'offense', label: 'Offensive' },
  { value: 'defense', label: 'Defensive' },
  { value: 'technique', label: 'Technik' },
  { value: 'physical', label: 'Physis' },
  { value: 'tactics', label: 'Taktik' },
  { value: 'set_pieces', label: 'Standardsituationen' },
] as const;
export type TrainingFocus = (typeof TRAINING_FOCI)[number]['value'];

/** G4: Trainingsmultiplikator nach Alter */
export function trainingAgeMultiplier(age: number): number {
  if (age <= 20) return 1.5;
  if (age <= 23) return 1.3;
  if (age <= 27) return 1.0;
  if (age <= 30) return 0.75;
  if (age <= 33) return 0.5;
  return 0.25;
}

/** Entwicklungspunkte einer Zusatzeinheit. Spieler am Potenzial-Limit profitieren kaum (G4). */
export const TRAINING_BASE_POINTS = 1;
export function trainingDevelopmentPoints(age: number, overall: number, potential: number): number {
  const headroom = potential > overall ? 1 : 0.2;
  return Math.round(TRAINING_BASE_POINTS * trainingAgeMultiplier(age) * headroom * 100) / 100;
}
