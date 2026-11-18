/**
 * Zentrale Domänentypen von Football Dynasty.
 * Diese Typen werden von Web-App, Match-Server und Tests gemeinsam verwendet.
 * Die Datenbank (supabase/migrations) ist die verbindliche Quelle der Daten;
 * diese Typen spiegeln deren Struktur.
 */

export type Uuid = string;

/** Geldbeträge werden immer als ganze Euro (bigint in Postgres) geführt, nie als Float. */
export type Euro = number;

export type Difficulty = 'easy' | 'medium' | 'hard';

export type WorldStatus =
  | 'lobby' // Manager treten bei und gründen Vereine
  | 'draft' // Snake-Draft läuft
  | 'preseason' // Taktik, Aufstellung, Sponsoren
  | 'season' // Kalender läuft
  | 'season_end'; // Saisonabrechnung

export type MemberRole = 'host' | 'manager';

export type ClubControl = 'human' | 'ai';

export const OUTFIELD_POSITIONS = [
  'CB', // Innenverteidiger
  'LB', // Linker Außenverteidiger
  'RB', // Rechter Außenverteidiger
  'LWB',
  'RWB',
  'CDM',
  'CM',
  'CAM',
  'LM',
  'RM',
  'LW',
  'RW',
  'CF',
  'ST',
] as const;

export const POSITIONS = ['GK', ...OUTFIELD_POSITIONS] as const;
export type Position = (typeof POSITIONS)[number];

/** D5: zehn Hauptattribute + fünf Standardattribute für Feldspieler (Skala 1–99). */
export interface OutfieldAttributes {
  pace: number;
  shooting: number;
  passing: number;
  dribbling: number;
  defending: number;
  physical: number;
  stamina: number;
  gameIntelligence: number;
  heading: number;
  mentality: number;
  freeKicks: number;
  penalties: number;
  corners: number;
  crossing: number;
  throwIns: number;
}

/** D5: eigenes Attributsystem für Torhüter. */
export interface GoalkeeperAttributes {
  reflexes: number;
  handling: number;
  positioning: number;
  oneOnOne: number;
  commandOfArea: number;
  distribution: number;
  kicking: number;
  reactionSpeed: number;
  gameIntelligence: number;
  mentality: number;
  /** Auch Torhüter brauchen Ausdauer für die Fitnessformel (F7) und Elfmeter für Elfmeterschießen. */
  stamina: number;
  penalties: number;
}

export type AttributeKey = keyof OutfieldAttributes;
export type GoalkeeperAttributeKey = keyof GoalkeeperAttributes;

export type TacticalProfileName = 'offensive' | 'neutral' | 'defensive';
export const TACTICAL_PROFILE_NAMES: readonly TacticalProfileName[] = ['offensive', 'neutral', 'defensive'];

export type Region = 'europe' | 'south_america' | 'africa' | 'asia' | 'north_central_america' | 'oceania';

export type CompetitionKind =
  | 'league'
  | 'domestic_cup'
  | 'champions_league'
  | 'europa_league'
  | 'relegation';

export type EuropeanStatus =
  | 'none'
  | 'cl_qualifying'
  | 'champions_league'
  | 'el_qualifying'
  | 'europa_league';
