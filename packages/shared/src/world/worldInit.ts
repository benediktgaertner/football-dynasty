import { DRAFT_POOL_REGIONS, DRAFT_POOL_STRENGTH_BANDS, LEAGUE_SIZE, MILLION } from '../constants.js';
import { randomCrest, type CrestConfig } from '../crest.js';
import type { Position, Region } from '../domain.js';
import { createRng, type Rng } from '../rng.js';
import { KIT_PATTERNS, type KitConfig } from '../schemas.js';
import { CLUB_COLOR_SETS, GERMAN_NAMING, NameRegistry, generateClubName, generateShortName, generateStadiumName } from './clubNames.js';
import { MANAGER_FIRST, MANAGER_LAST } from './names.js';
import { generatePlayer, nationalityByCode, pickNationality, randomAge, type GeneratedPlayer } from './players.js';

/**
 * Phase 3: Erzeugt beim Draft-Start die deutsche Fußballwelt und den Draft-Pool.
 * Deterministisch aus dem Welt-Seed: gleicher Seed + gleiche menschliche Vereine ⇒ gleiche Welt.
 * Das Ergebnis wird von der SQL-Funktion admin_start_draft in einer Transaktion gespeichert.
 */

export interface HumanClubRef {
  id: string;
  name: string;
  short_name: string;
}

export interface GeneratedAiClub {
  key: string;
  tier: 1 | 2 | 3;
  name: string;
  short_name: string;
  founded_year: number;
  reputation: number;
  primary: string;
  secondary: string;
  accent: string;
  crest: CrestConfig;
  kit: KitConfig;
  stadium_name: string;
  capacity: number;
  balance: number;
  manager_name: string;
  ai_profile: { risk: number; youth_focus: number; rotation: number; preferred_formation: string };
  target_strength: number;
}

export interface PayloadPlayer extends GeneratedPlayer {
  club_key: string | null; // null = Draft-Pool
  contract_years: number | null;
  shirt: number | null;
}

export interface WorldInitPayload {
  version: 1;
  ai_clubs: GeneratedAiClub[];
  players: PayloadPlayer[];
}

// ---------------------------------------------------------------------------
// D2: Draft-Pool
// ---------------------------------------------------------------------------

/** Positionsverteilung des Pools (Summe 400); genug Torhüter für bis zu 18 Manager × 2. */
export const DRAFT_POOL_POSITIONS: ReadonlyArray<readonly [Position, number]> = [
  ['GK', 40], ['CB', 64], ['LB', 26], ['RB', 26], ['LWB', 6], ['RWB', 6], ['CDM', 32], ['CM', 50],
  ['CAM', 30], ['LM', 16], ['RM', 16], ['LW', 26], ['RW', 26], ['CF', 10], ['ST', 26],
];

export function generateDraftPool(rng: Rng, usedNames: Set<string>): GeneratedPlayer[] {
  const overalls: number[] = [];
  for (const band of DRAFT_POOL_STRENGTH_BANDS) {
    for (let i = 0; i < band.count; i++) overalls.push(rng.int(band.min, band.max));
  }
  const regions: Region[] = [];
  for (const [region, count] of Object.entries(DRAFT_POOL_REGIONS) as [Region, number][]) {
    for (let i = 0; i < count; i++) regions.push(region);
  }
  const positions: Position[] = [];
  for (const [pos, count] of DRAFT_POOL_POSITIONS) for (let i = 0; i < count; i++) positions.push(pos);

  const ov = rng.shuffle(overalls);
  const rg = rng.shuffle(regions);
  const ps = rng.shuffle(positions);
  return ov.map((overall, i) =>
    generatePlayer(rng, {
      nat: pickNationality(rng, rg[i]!),
      position: ps[i]!,
      overall,
      age: randomAge(rng, 26, 4.2, 18, 35),
      usedNames,
    }),
  );
}

// ---------------------------------------------------------------------------
// C2: Mannschaftsstärken der KI-Vereine
// ---------------------------------------------------------------------------

/**
 * Zielstärken (Durchschnitt der besten Elf):
 * Bundesliga 77–84+ (zwei Spitzenteams darüber), 2. Liga 71–78 mit ca. fünf
 * Aufstiegskandidaten (76–78), 3. Liga 65–72. Kleine Zufallsstreuung je Welt.
 */
export function tierTargets(rng: Rng, tier: 1 | 2 | 3, count: number): number[] {
  const out: number[] = [];
  if (tier === 1) {
    for (let i = 0; i < count; i++) {
      if (i === 0) out.push(84 + rng.next() * 1.5);
      else if (i === 1) out.push(82.5 + rng.next() * 1.5);
      else out.push(81 - ((i - 2) / Math.max(1, count - 3)) * 4 + rng.normal(0, 0.4));
    }
  } else if (tier === 2) {
    const contenders = Math.min(5, count);
    for (let i = 0; i < count; i++) {
      if (i < contenders) out.push(76 + rng.next() * 2);
      else out.push(75 - ((i - contenders) / Math.max(1, count - contenders - 1)) * 4 + rng.normal(0, 0.4));
    }
  } else {
    for (let i = 0; i < count; i++) out.push(72 - (i / Math.max(1, count - 1)) * 7 + rng.normal(0, 0.4));
  }
  return out.map((t) => Math.round(t * 10) / 10);
}

// ---------------------------------------------------------------------------
// KI-Kader (25 Spieler)
// ---------------------------------------------------------------------------

const SQUAD_TEMPLATE: ReadonlyArray<{ pos: Position; role: 'starter' | 'bench' | 'third' | 'youth' }> = [
  { pos: 'GK', role: 'starter' }, { pos: 'GK', role: 'bench' }, { pos: 'GK', role: 'third' },
  { pos: 'CB', role: 'starter' }, { pos: 'CB', role: 'starter' }, { pos: 'CB', role: 'bench' }, { pos: 'CB', role: 'youth' },
  { pos: 'LB', role: 'starter' }, { pos: 'LB', role: 'bench' },
  { pos: 'RB', role: 'starter' }, { pos: 'RB', role: 'bench' },
  { pos: 'CDM', role: 'starter' }, { pos: 'CDM', role: 'bench' },
  { pos: 'CM', role: 'starter' }, { pos: 'CM', role: 'starter' }, { pos: 'CM', role: 'bench' },
  { pos: 'CAM', role: 'bench' }, { pos: 'LM', role: 'bench' }, { pos: 'RM', role: 'bench' },
  { pos: 'LW', role: 'starter' }, { pos: 'RW', role: 'starter' },
  { pos: 'ST', role: 'starter' }, { pos: 'ST', role: 'bench' }, { pos: 'ST', role: 'youth' }, { pos: 'CF', role: 'bench' },
];

function squadNationality(rng: Rng, tier: number) {
  const germanShare = tier === 1 ? 0.6 : tier === 2 ? 0.72 : 0.85;
  if (rng.next() < germanShare) return nationalityByCode('GER');
  const r = rng.next();
  const region: Region = r < 0.6 ? 'europe' : r < 0.75 ? 'africa' : r < 0.87 ? 'south_america' : r < 0.95 ? 'asia' : 'north_central_america';
  return pickNationality(rng, region);
}

export function generateAiSquad(rng: Rng, target: number, tier: 1 | 2 | 3, usedNames: Set<string>): Array<GeneratedPlayer & { shirt: number; contract_years: number }> {
  const used = new Set<number>();
  return SQUAD_TEMPLATE.map(({ pos, role }) => {
    const base = role === 'starter' ? target + rng.normal(0, 2) : role === 'bench' ? target - 3.5 + rng.normal(0, 2) : role === 'third' ? target - 9 : target - 8 + rng.normal(0, 1.5);
    const age = role === 'youth' ? rng.int(18, 20) : role === 'starter' ? randomAge(rng, 26.5, 3.5, 19, 34) : randomAge(rng, 25.5, 4.5, 18, 36);
    const p = generatePlayer(rng, { nat: squadNationality(rng, tier), position: pos, overall: Math.max(45, Math.min(92, Math.round(base))), age, usedNames });
    let shirt = p.prefShirt;
    if (used.has(shirt)) {
      shirt = 1;
      while (used.has(shirt)) shirt++;
    }
    used.add(shirt);
    return { ...p, shirt, contract_years: rng.int(1, 4) };
  });
}

/** Durchschnitt der stärksten Elf in Grundordnung (1 TW, 4 Abwehr, 3–4 Mittelfeld, 2–3 Angriff). */
export function bestElevenAverage(players: ReadonlyArray<{ pos: Position; overall: number }>): number {
  const groups: Record<string, Position[]> = {
    gk: ['GK'],
    def: ['CB', 'LB', 'RB', 'LWB', 'RWB'],
    mid: ['CDM', 'CM', 'CAM', 'LM', 'RM'],
    att: ['LW', 'RW', 'CF', 'ST'],
  };
  const take = (g: Position[], n: number) => players.filter((p) => g.includes(p.pos)).map((p) => p.overall).sort((a, b) => b - a).slice(0, n);
  const xi = [...take(groups.gk!, 1), ...take(groups.def!, 4), ...take(groups.mid!, 3), ...take(groups.att!, 3)];
  return xi.reduce((s, v) => s + v, 0) / xi.length;
}

// ---------------------------------------------------------------------------
// Gesamte Weltinitialisierung
// ---------------------------------------------------------------------------

const CAPACITY_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [30_000, 50_000], 2: [15_000, 35_000], 3: [10_000, 20_000] };
const BALANCE_RANGE: Record<1 | 2 | 3, [number, number]> = { 1: [60, 120], 2: [20, 50], 3: [5, 15] };
const REPUTATION: Record<1 | 2 | 3, number> = { 1: 75, 2: 55, 3: 38 };
const FORMATIONS_AI = ['4-4-2', '4-3-3', '4-2-3-1', '4-1-4-1', '3-5-2', '4-4-2-diamond', '5-3-2', '4-2-3-1-wide'];

export function buildWorldInitialization(seed: string, humans: readonly HumanClubRef[]): WorldInitPayload {
  if (humans.length < 1 || humans.length > LEAGUE_SIZE) throw new RangeError('1–18 menschliche Vereine erforderlich');
  const rng = createRng(`world-init:${seed}`);
  const registry = new NameRegistry();
  for (const h of humans) registry.reserve(h.name, h.short_name);
  const usedNames = new Set<string>();

  const aiClubs: GeneratedAiClub[] = [];
  const players: PayloadPlayer[] = [];
  const tierCounts: Array<[1 | 2 | 3, number]> = [[1, LEAGUE_SIZE], [2, LEAGUE_SIZE - humans.length], [3, LEAGUE_SIZE]];

  let index = 0;
  for (const [tier, count] of tierCounts) {
    const targets = tierTargets(rng, tier, count);
    for (const target of targets) {
      const key = `ai${++index}`;
      const { name, place, adjective, foundedYear } = generateClubName(rng, GERMAN_NAMING, registry);
      const short = generateShortName(rng, name, place, registry);
      registry.reserve(name, short);

      let colors = rng.pick(CLUB_COLOR_SETS);
      for (let i = 0; i < 30 && registry.colorsTaken(tier, colors[0], colors[1]); i++) colors = rng.pick(CLUB_COLOR_SETS);
      registry.reserveColors(tier, colors[0], colors[1]);
      const [primary, secondary, accent] = colors;

      const crest = { ...randomCrest(() => rng.next(), short), primary, secondary, accent, foundedYear: rng.next() < 0.7 ? foundedYear : null };
      const kit: KitConfig = { pattern: rng.pick(KIT_PATTERNS), primary, secondary };
      const [cmin, cmax] = CAPACITY_RANGE[tier];
      const capacity = cmin + rng.int(0, (cmax - cmin) / 5000) * 5000;
      const [bmin, bmax] = BALANCE_RANGE[tier];

      aiClubs.push({
        key,
        tier,
        name,
        short_name: short,
        founded_year: foundedYear,
        reputation: Math.round((REPUTATION[tier] + (target - (tier === 1 ? 79 : tier === 2 ? 74 : 68)) * 2) * 10) / 10,
        primary,
        secondary,
        accent,
        crest,
        kit,
        stadium_name: generateStadiumName(rng, GERMAN_NAMING, place, adjective),
        capacity,
        balance: Math.round((bmin + rng.next() * (bmax - bmin)) * 10) * (MILLION / 10),
        manager_name: `${rng.pick(MANAGER_FIRST)} ${rng.pick(MANAGER_LAST)}`,
        ai_profile: {
          risk: Math.round(rng.next() * 100) / 100,
          youth_focus: Math.round(rng.next() * 100) / 100,
          rotation: Math.round((0.3 + rng.next() * 0.6) * 100) / 100,
          preferred_formation: rng.pick(FORMATIONS_AI),
        },
        target_strength: target,
      });

      for (const p of generateAiSquad(rng, target, tier, usedNames)) {
        players.push({ ...p, club_key: key });
      }
    }
  }

  for (const p of generateDraftPool(rng, usedNames)) {
    players.push({ ...p, club_key: null, contract_years: null, shirt: null });
  }

  return { version: 1, ai_clubs: aiClubs, players };
}
