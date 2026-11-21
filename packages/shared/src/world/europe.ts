import { ASSOCIATIONS, type Association } from '../associations.js';
import { MILLION } from '../constants.js';
import { randomCrest } from '../crest.js';
import type { Position } from '../domain.js';
import { normalizeName } from '../naming.js';
import { createRng, type Rng } from '../rng.js';
import { KIT_PATTERNS, type KitConfig } from '../schemas.js';
import { ANCHOR_CLUBS, anchorColors } from './anchors.js';
import { CLUB_COLOR_SETS, GERMAN_NAMING, NameRegistry, generateClubName, generateShortName, generateStadiumName, isBlockedClubName } from './clubNames.js';
import { EUROPE_BLOCKLIST, EUROPE_PLACES, EUROPE_STYLES } from './europeData.js';
import { generatePlayer, nationalityByCode, pickNationality, randomAge, type GeneratedPlayer } from './players.js';
import type { GeneratedAiClub } from './worldInit.js';

/**
 * Europaweiter Transfermarkt: Erstligen aller UEFA-Verbände (außer Deutschland, das die
 * spielbaren drei Ligen stellt) mit vollständigen Kadern. Deterministisch aus Welt-Seed und Verband.
 * Die Vereine spielen (noch) keine eigenen Ligen, sind aber vollwertige Transferpartner.
 */

export interface EuropeClub extends Omit<GeneratedAiClub, 'tier'> {
  association_code: string;
  league_name: string;
  /** Virtuelle Spielklasse 1–4 für Gehaltsforderungen und KI-Käufe */
  level: 1 | 2 | 3 | 4;
}

export interface EuropePayloadPlayer extends GeneratedPlayer {
  club_key: string | null;
  contract_years: number | null;
  shirt: number | null;
}

export interface EuropePayload {
  association_code: string;
  clubs: EuropeClub[];
  players: EuropePayloadPlayer[];
}

const BLOCKED = new Set(EUROPE_BLOCKLIST.map(normalizeName));

/** Alle Verbände, die als ausländische Ligen erzeugt werden (Welten mit Deutschland als Spielland) */
export const EUROPE_ASSOCIATIONS: readonly Association[] = ASSOCIATIONS.filter((a) => a.code !== 'GER');

/** Ausländische Erstligen einer Welt: alle Verbände außer dem gewählten Spielland */
export function europeAssociationsFor(country: string): readonly Association[] {
  return ASSOCIATIONS.filter((a) => a.code !== country);
}

/** Mannschaftsstärken einer Erstliga aus der Verbandsstärke (England ≈ 76–87, San Marino ≈ 50–59) */
export function europeTargets(rng: Rng, strength: number, count: number): number[] {
  const top = 52 + strength * 0.345;
  const spread = 6 + strength * 0.045;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const rel = count <= 1 ? 0 : i / (count - 1);
    // Spitzenteams setzen sich ab, das Mittelfeld ist dicht
    const t = top - spread * (rel ** 0.8) + rng.normal(0, 0.6) + (i === 0 ? 0.8 : 0);
    out.push(Math.round(Math.max(45, Math.min(90, t)) * 10) / 10);
  }
  return out.sort((a, b) => b - a);
}

export function levelFor(target: number): 1 | 2 | 3 | 4 {
  return target >= 77 ? 1 : target >= 71 ? 2 : target >= 64 ? 3 : 4;
}

const SQUAD: ReadonlyArray<{ pos: Position; role: 'starter' | 'bench' | 'youth' | 'third' }> = [
  { pos: 'GK', role: 'starter' }, { pos: 'GK', role: 'bench' }, { pos: 'GK', role: 'third' },
  { pos: 'CB', role: 'starter' }, { pos: 'CB', role: 'starter' }, { pos: 'CB', role: 'bench' },
  { pos: 'LB', role: 'starter' }, { pos: 'LB', role: 'bench' }, { pos: 'RB', role: 'starter' }, { pos: 'RB', role: 'bench' },
  { pos: 'CDM', role: 'starter' }, { pos: 'CM', role: 'starter' }, { pos: 'CM', role: 'starter' }, { pos: 'CM', role: 'bench' },
  { pos: 'CAM', role: 'bench' }, { pos: 'LM', role: 'bench' }, { pos: 'RM', role: 'youth' },
  { pos: 'LW', role: 'starter' }, { pos: 'RW', role: 'starter' }, { pos: 'ST', role: 'starter' }, { pos: 'ST', role: 'bench' }, { pos: 'CF', role: 'youth' },
];

/** Heimische Spieler überwiegen, starke Ligen sind internationaler */
function nationality(rng: Rng, a: Association) {
  const homeShare = a.strength >= 85 ? 0.55 : a.strength >= 60 ? 0.68 : 0.82;
  if (rng.next() < homeShare) return nationalityByCode(a.code);
  const r = rng.next();
  const region = r < 0.55 ? 'europe' : r < 0.72 ? 'africa' : r < 0.88 ? 'south_america' : r < 0.95 ? 'asia' : 'north_central_america';
  return pickNationality(rng, region);
}

function stylesFor(code: string) {
  const entry = EUROPE_PLACES[code];
  if (!entry) throw new Error(`Keine Orte für Verband ${code}`);
  const styles = (Array.isArray(entry.style) ? entry.style : [entry.style]).map((s) => {
    const st = EUROPE_STYLES[s];
    if (!st) throw new Error(`Unbekannter Namensstil ${s}`);
    return st;
  });
  return { places: entry.places, styles };
}

function isBlocked(name: string): boolean {
  return isBlockedClubName(name) || BLOCKED.has(normalizeName(name));
}

/** Fiktiver, landestypischer Vereinsname: jeder Ort einmal je Verband, keine Doppelungen in der Welt */
export function generateEuropeClubName(rng: Rng, code: string, registry: NameRegistry, usedPlaces: Set<string>): { name: string; place: string } {
  const { places, styles } = stylesFor(code);
  for (let attempt = 0; attempt < 400; attempt++) {
    const place = rng.pick(places);
    if (usedPlaces.has(place) && attempt < 300) continue;
    const style = rng.pick(styles);
    const name = rng.pick(style.patterns).replace('{p}', place).replace(/\s+/g, ' ').trim();
    if (name.length > 32 || isBlocked(name) || registry.hasName(name)) continue;
    usedPlaces.add(place);
    return { name, place };
  }
  throw new Error(`Kein freier Vereinsname für ${code}`);
}

/**
 * Vereinsname für die drei nationalen Ligen des Spiellands. Kleine Länder haben wenige Orte:
 * reicht der Vorrat nicht, entstehen Namen mit Gründungsjahr („FC Vaduz 1932“).
 */
export function nationalClubName(rng: Rng, code: string, registry: NameRegistry, usedPlaces: Set<string>): { name: string; place: string } {
  try {
    return generateEuropeClubName(rng, code, registry, usedPlaces);
  } catch {
    const { places, styles } = stylesFor(code);
    for (let attempt = 0; attempt < 2000; attempt++) {
      const place = rng.pick(places);
      const base = rng.pick(rng.pick(styles).patterns).replace('{p}', place).replace(/\s+/g, ' ').trim();
      const name = `${base.slice(0, 27)} ${rng.int(1885, 1995)}`;
      if (isBlocked(name) || registry.hasName(name)) continue;
      return { name, place };
    }
    throw new Error(`Kein freier Vereinsname für ${code}`);
  }
}

export function europeStadiumName(rng: Rng, code: string, place: string): string {
  return stadiumName(rng, code, place);
}

function stadiumName(rng: Rng, code: string, place: string): string {
  const { styles } = stylesFor(code);
  const s = rng.pick(rng.pick(styles).stadiums).replace('{p}', place);
  return s.slice(0, 40);
}

export function leagueName(a: Association): string {
  if (a.code === 'GER') return `Bundesliga (${a.name})`;
  const { styles } = stylesFor(a.code);
  return `${styles[0]!.league} (${a.name})`;
}

/**
 * Erzeugt eine komplette ausländische Erstliga. `registry` enthält alle bereits vergebenen
 * Vereinsnamen und Kürzel der Welt (Eindeutigkeit über alle Verbände).
 */
export function buildEuropeAssociation(worldSeed: string, code: string, registry: NameRegistry, usedNames = new Set<string>()): EuropePayload {
  const a = ASSOCIATIONS.find((x) => x.code === code);
  if (!a) throw new Error(`Ungültiger Verband ${code}`);
  // Deutschland als ausländische Erstliga (Welten mit anderem Spielland): deutsches Namensprofil
  const german = code === 'GER';
  const rng = createRng(`europe:${worldSeed}:${code}`);
  const targets = europeTargets(rng, a.strength, a.leagueSize);
  const usedPlaces = new Set<string>();
  const league = leagueName(a);
  const clubs: EuropeClub[] = [];
  const players: EuropePayloadPlayer[] = [];

  targets.forEach((target, i) => {
    const key = `${code}${i + 1}`;
    const genDe = german ? generateClubName(rng, GERMAN_NAMING, registry) : null;
    const gen = genDe ?? generateEuropeClubName(rng, code, registry, usedPlaces);
    const genShort = generateShortName(rng, gen.name, gen.place, registry);
    // Orientierungsvereine an den großen Standorten (fiktiv), sonst landestypischer Name
    const anchor = ANCHOR_CLUBS[code]?.[i];
    const useAnchor = !!anchor && !registry.hasName(anchor.name) && !registry.hasShort(anchor.short) && !isBlockedClubName(anchor.name);
    const name = useAnchor ? anchor!.name : gen.name;
    const place = useAnchor ? anchor!.place : gen.place;
    const short = useAnchor ? anchor!.short : genShort;
    registry.reserve(name, short);
    let colors = rng.pick(CLUB_COLOR_SETS);
    for (let k = 0; k < 20 && registry.colorsTaken(100 + ASSOCIATIONS.indexOf(a), colors[0], colors[1]); k++) colors = rng.pick(CLUB_COLOR_SETS);
    if (useAnchor) colors = anchorColors(anchor!, (c1, c2) => registry.colorsTaken(100 + ASSOCIATIONS.indexOf(a), c1, c2)) as unknown as typeof colors;
    registry.reserveColors(100 + ASSOCIATIONS.indexOf(a), colors[0], colors[1]);
    const [primary, secondary, accent] = colors;
    const foundedYear = rng.int(1878, 1975);
    const crest = { ...randomCrest(() => rng.next(), short), primary, secondary, accent, foundedYear: rng.next() < 0.6 ? foundedYear : null };
    const kit: KitConfig = { pattern: rng.pick(KIT_PATTERNS), primary, secondary };
    const level = levelFor(target);
    // Stadiongröße im Schema der Spielwelt: 10.000–50.000 in 5.000er-Schritten
    const capacity = Math.min(50000, Math.max(10000, Math.round((8000 + (target - 50) ** 2 * 40 + rng.int(0, 4) * 2500) / 5000) * 5000));
    clubs.push({
      key,
      association_code: code,
      league_name: league,
      level,
      name,
      short_name: short,
      founded_year: foundedYear,
      reputation: Math.round(Math.max(8, Math.min(96, 20 + (target - 55) * 2.2)) * 10) / 10,
      primary,
      secondary,
      accent,
      crest,
      kit,
      stadium_name: german ? generateStadiumName(rng, GERMAN_NAMING, place, useAnchor ? null : genDe!.adjective) : stadiumName(rng, code, place),
      capacity,
      // Budget nach Stärke: Spitzenclubs der großen Ligen sind sehr finanzstark
      balance: Math.round((Math.max(2, (target - 50) ** 2 * 0.12) * (0.7 + rng.next() * 0.6)) * 10) * (MILLION / 10),
      manager_name: '',
      ai_profile: { risk: Math.round(rng.next() * 100) / 100, youth_focus: Math.round(rng.next() * 100) / 100, rotation: 0.5, preferred_formation: '4-3-3' },
      target_strength: target,
    });
    const shirts = new Set<number>();
    for (const { pos, role } of SQUAD) {
      const base = role === 'starter' ? target + rng.normal(0, 2) : role === 'bench' ? target - 3.5 + rng.normal(0, 2) : role === 'third' ? target - 9 : target - 8 + rng.normal(0, 1.5);
      const age = role === 'youth' ? rng.int(18, 20) : role === 'starter' ? randomAge(rng, 26.5, 3.5, 19, 34) : randomAge(rng, 25.5, 4.5, 18, 36);
      const p = generatePlayer(rng, { nat: nationality(rng, a), position: pos, overall: Math.max(40, Math.min(92, Math.round(base))), age, usedNames });
      let shirt = p.prefShirt;
      if (shirts.has(shirt)) { shirt = 1; while (shirts.has(shirt)) shirt++; }
      shirts.add(shirt);
      players.push({ ...p, club_key: key, contract_years: rng.int(1, 4), shirt });
    }
  });

  // Einige vereinslose Spieler je Land (Free Agents): bewusst schwächer als Vertragsspieler
  const faCount = Math.max(2, Math.round(a.leagueSize / 5));
  const positions: Position[] = ['GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST'];
  for (let i = 0; i < faCount; i++) {
    const age = rng.next() < 0.25 ? rng.int(18, 21) : randomAge(rng, 28, 4, 22, 35);
    const p = generatePlayer(rng, { nat: nationality(rng, a), position: rng.pick(positions), overall: freeAgentOverall(rng, age), age, usedNames });
    players.push({ ...p, club_key: null, contract_years: null, shirt: null });
  }

  return { association_code: code, clubs, players };
}

/**
 * Stärke neu erzeugter Free Agents: überwiegend 55–68, selten 69–72, nie darüber.
 * Junge Spieler (≤ 21) liegen eher im unteren Bereich; Potenzial vergibt der Spielergenerator.
 */
export function freeAgentOverall(rng: Rng, age: number): number {
  if (rng.next() < 0.12) return rng.int(69, 72);
  const lo = age <= 21 ? 55 : 57;
  const hi = age <= 21 ? 64 : 68;
  return Math.min(68, Math.max(55, Math.round(lo + (hi - lo) * (0.5 + rng.normal(0, 0.28)))));
}

/** Registry aus den bereits vorhandenen Vereinen einer Welt aufbauen */
export function registryFrom(existing: ReadonlyArray<{ name: string; short_name: string }>): NameRegistry {
  const r = new NameRegistry();
  for (const c of existing) r.reserve(c.name, c.short_name);
  return r;
}
