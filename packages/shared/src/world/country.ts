import { ASSOCIATIONS, type Association } from '../associations.js';
import { EUROPE_PLACES, EUROPE_STYLES } from './europeData.js';

/**
 * Land und Startliga einer Karrierewelt.
 * Das gewählte Land stellt drei Ligen à 18 Vereine (voller Spielbetrieb), alle übrigen Länder
 * nur ihre Erstliga als Stammdaten (Transfermarkt, Europapokal-Auswahl, keine Simulation).
 *
 * Skalierung: Deutschland ist die Referenz (Faktor 1, identische Welt wie bisher).
 * Diese Formeln sind in SQL gespiegelt (fd_country_shift, fd_capital_factor, fd_economy_factor).
 */
export type StartTier = 1 | 2 | 3;
export const DEFAULT_COUNTRY = 'GER';
export const DEFAULT_START_TIER: StartTier = 2;
const REF_STRENGTH = 92;

export function associationByCode(code: string): Association {
  const a = ASSOCIATIONS.find((x) => x.code === code);
  if (!a) throw new Error(`Unbekannter Verband ${code}`);
  return a;
}

/** Zielstärke einer deutschen Mannschaft (Referenz) auf das Niveau eines Landes abbilden */
export function countryTransform(strength: number, target: number): number {
  const offTop = 0.345 * (strength - REF_STRENGTH);
  const k = Math.min(1, 0.6 + (0.4 * strength) / REF_STRENGTH);
  return 85 + offTop - (85 - target) * k;
}

/** Typische Stärke je Spielklasse in Deutschland (Mitte der Zielwerte) */
const TIER_CENTER: Record<StartTier, number> = { 1: 80, 2: 74, 3: 68.5 };

/** Verschiebung des Draft-Pools gegenüber der Referenz (2. Liga Deutschland = 0) */
export function countryTierShift(code: string, tier: StartTier): number {
  const s = associationByCode(code).strength;
  return Math.round((countryTransform(s, TIER_CENTER[tier]) - TIER_CENTER[2]) * 10) / 10;
}

/** Höchste Startstärke im Draft-Pool (Referenz 83, Erstligen starker Länder bis 92) */
export function draftPoolMax(code: string, tier: StartTier): number {
  return Math.min(92, 83 + Math.max(0, Math.round(countryTierShift(code, tier))));
}

/** Faktor für Startkapital und Stadionbau (Marktwerte der Draft-Spieler ändern sich etwa um e^(0,2·Δ)) */
export function capitalFactor(code: string, tier: StartTier): number {
  if (code === DEFAULT_COUNTRY && tier === DEFAULT_START_TIER) return 1;
  const f = Math.exp(0.2 * countryTierShift(code, tier));
  return Math.round(Math.min(4, Math.max(0.03, f)) * 10000) / 10000;
}

/** Wirtschaftsniveau eines Landes: Prämien, Sponsoren, Zuschauereinnahmen, Startbudgets der KI */
export function economyFactor(code: string): number {
  if (code === DEFAULT_COUNTRY) return 1;
  const s = associationByCode(code).strength;
  const f = Math.exp(0.2 * (countryTransform(s, 80) - 80));
  return Math.round(Math.min(1.3, Math.max(0.05, f)) * 10000) / 10000;
}

export interface NationalLeagueNames {
  1: string;
  2: string;
  3: string;
  cup: string;
}

/** Landestypische Bezeichnungen (Ligen und Pokal) – in SQL als Tabelle country_league_names gespiegelt */
const NAMES: Record<string, [string, string, string, string]> = {
  GER: ['Bundesliga', '2. Bundesliga', '3. Liga', 'DFB-Pokal'],
  ENG: ['Premier Division', 'Championship', 'League One', 'FA Cup'],
  ESP: ['Primera División', 'Segunda División', 'Primera Federación', 'Copa del Rey'],
  ITA: ['Serie A', 'Serie B', 'Serie C', 'Coppa Italia'],
  FRA: ['Ligue 1', 'Ligue 2', 'National', 'Coupe de France'],
  POR: ['Primeira Liga', 'Segunda Liga', 'Liga 3', 'Taça de Portugal'],
  NED: ['Eredivisie', 'Eerste Divisie', 'Tweede Divisie', 'KNVB Beker'],
  BEL: ['Pro League', 'Challenger Pro League', 'Nationale 1', 'Belgischer Pokal'],
  TUR: ['Süper Lig', '1. Lig', '2. Lig', 'Türkiye Kupası'],
  CZE: ['1. liga', 'Národní liga', 'ČFL', 'MOL Cup'],
  SCO: ['Premiership', 'Championship', 'League One', 'Scottish Cup'],
  AUT: ['Bundesliga', '2. Liga', 'Regionalliga', 'ÖFB-Cup'],
  SUI: ['Super League', 'Challenge League', 'Promotion League', 'Schweizer Cup'],
  GRE: ['Super League', 'Super League 2', 'Gamma Ethniki', 'Griechischer Pokal'],
  NOR: ['Eliteserien', 'OBOS-ligaen', 'PostNord-ligaen', 'NM Cup'],
  DEN: ['Superliga', '1. Division', '2. Division', 'Landspokal'],
  POL: ['Ekstraklasa', 'I liga', 'II liga', 'Puchar Polski'],
  SWE: ['Allsvenskan', 'Superettan', 'Ettan', 'Svenska Cupen'],
  UKR: ['Premier-Liga', 'Perscha Liha', 'Druha Liha', 'Ukrainischer Pokal'],
  RUS: ['Premier-Liga', 'Erste Liga', 'Zweite Liga', 'Russischer Pokal'],
  CRO: ['HNL', 'Prva NL', 'Druga NL', 'Kroatischer Pokal'],
  SRB: ['Prva liga', 'Druga liga', 'Srpska liga', 'Serbischer Pokal'],
  HUN: ['NB I', 'NB II', 'NB III', 'Magyar Kupa'],
  ROU: ['Superliga', 'Liga II', 'Liga III', 'Cupa României'],
};

export function nationalLeagueNames(code: string): NationalLeagueNames {
  const n = NAMES[code];
  if (n) return { 1: n[0], 2: n[1], 3: n[2], cup: n[3] };
  const a = associationByCode(code);
  const e = EUROPE_PLACES[code];
  const style = e ? EUROPE_STYLES[Array.isArray(e.style) ? e.style[0]! : e.style] : undefined;
  return { 1: style?.league ?? `1. Liga ${a.name}`, 2: `2. Liga ${a.name}`, 3: `3. Liga ${a.name}`, cup: `Pokal ${a.name}` };
}

/** Auswahlliste für die Welterstellung: alle 55 UEFA-Verbände, stärkste zuerst */
export function countryOptions(): Array<{ code: string; name: string; strength: number; leagues: NationalLeagueNames }> {
  return [...ASSOCIATIONS]
    .sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name, 'de'))
    .map((a) => ({ code: a.code, name: a.name, strength: a.strength, leagues: nationalLeagueNames(a.code) }));
}
