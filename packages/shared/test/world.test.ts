import { describe, expect, it } from 'vitest';
import {
  DRAFT_POOL_POSITIONS,
  FAMOUS_PLAYER_NAMES,
  NATIONALITIES,
  bestElevenAverage,
  buildWorldInitialization,
  clubCreationSchema,
  createRng,
  crestConfigSchema,
  generateOutfieldAttributes,
  generateGoalkeeperAttributes,
  goalkeeperOverall,
  isBlockedClubName,
  kitSchema,
  marketValue,
  normalizeName,
  outfieldOverall,
  type GoalkeeperAttributes,
  type OutfieldAttributes,
} from '../src/index.js';

const humans = [
  { id: 'h1', name: 'Test', short_name: 'TES' },
  { id: 'h2', name: 'Würzburger Fickers', short_name: 'FICK' },
];
const payload = buildWorldInitialization('seed-abc', humans);
const pool = payload.players.filter((p) => p.club_key === null);
const squadPlayers = payload.players.filter((p) => p.club_key !== null);

describe('Weltinitialisierung: Vereine (C1, C2, C7)', () => {
  it('erzeugt 54 − menschliche Vereine, verteilt auf drei Ligen à 18', () => {
    expect(payload.ai_clubs).toHaveLength(52);
    expect(payload.ai_clubs.filter((c) => c.tier === 1)).toHaveLength(18);
    expect(payload.ai_clubs.filter((c) => c.tier === 2)).toHaveLength(16);
    expect(payload.ai_clubs.filter((c) => c.tier === 3)).toHaveLength(18);
  });
  it('Namen und Kurznamen sind eindeutig (auch gegenüber menschlichen Vereinen) und nicht gesperrt', () => {
    const names = [...payload.ai_clubs.map((c) => c.name), ...humans.map((h) => h.name)].map(normalizeName);
    const shorts = [...payload.ai_clubs.map((c) => c.short_name), ...humans.map((h) => h.short_name)].map(normalizeName);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(shorts).size).toBe(shorts.length);
    for (const c of payload.ai_clubs) {
      expect(isBlockedClubName(c.name)).toBe(false);
      expect(c.short_name).toMatch(/^[A-ZÄÖÜ0-9]{3,4}$/u);
      expect(c.name.length).toBeLessThanOrEqual(32);
    }
  });
  it('Sperrliste greift (z. B. „VfB Stuttgart“)', () => {
    expect(isBlockedClubName('vfb  stuttgart')).toBe(true);
    expect(isBlockedClubName('VfB Hemmingen')).toBe(false);
  });
  it('Branding und Stadion bestehen dieselbe Validierung wie menschliche Vereine', () => {
    for (const c of payload.ai_clubs) {
      expect(crestConfigSchema.safeParse(c.crest).success).toBe(true);
      expect(kitSchema.safeParse(c.kit).success).toBe(true);
      const r = clubCreationSchema.safeParse({
        name: c.name, shortName: c.short_name, primaryColor: c.primary, secondaryColor: c.secondary, accentColor: c.accent,
        crest: c.crest, kit: c.kit, stadiumName: c.stadium_name, stadiumCapacity: c.capacity,
      });
      expect(r.success, `${c.name}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });
  it('innerhalb einer Liga keine identische Primär-/Sekundärfarbe', () => {
    for (const tier of [1, 2, 3]) {
      const keys = payload.ai_clubs.filter((c) => c.tier === tier).map((c) => `${c.primary}|${c.secondary}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it('C2: Mannschaftsstärken je Liga in den vorgegebenen Bereichen', () => {
    const strength = (key: string) => bestElevenAverage(squadPlayers.filter((p) => p.club_key === key));
    const byTier = (t: number) => payload.ai_clubs.filter((c) => c.tier === t).map((c) => strength(c.key));
    const t1 = byTier(1);
    const t2 = byTier(2);
    const t3 = byTier(3);
    expect(Math.min(...t1)).toBeGreaterThanOrEqual(75.5);
    expect(Math.max(...t1)).toBeGreaterThanOrEqual(83);
    expect(Math.min(...t2)).toBeGreaterThanOrEqual(69.5);
    expect(Math.max(...t2)).toBeLessThanOrEqual(80);
    expect(t2.filter((s) => s >= 75.5).length).toBeGreaterThanOrEqual(4); // ca. fünf Aufstiegskandidaten
    expect(t2.filter((s) => s >= 75.5).length).toBeLessThanOrEqual(7);
    expect(Math.min(...t3)).toBeGreaterThanOrEqual(63.5);
    expect(Math.max(...t3)).toBeLessThanOrEqual(74);
    // Ligen sind im Mittel klar gestaffelt
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(t1)).toBeGreaterThan(avg(t2) + 3);
    expect(avg(t2)).toBeGreaterThan(avg(t3) + 3);
  });
  it('jeder KI-Kader hat 25 Spieler, mindestens 3 Torhüter, eindeutige Trikotnummern und Verträge', () => {
    for (const c of payload.ai_clubs) {
      const squad = squadPlayers.filter((p) => p.club_key === c.key);
      expect(squad).toHaveLength(25);
      expect(squad.filter((p) => p.pos === 'GK').length).toBeGreaterThanOrEqual(3);
      expect(new Set(squad.map((p) => p.shirt)).size).toBe(25);
      for (const p of squad) expect(p.contract_years).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('D2: Draft-Pool', () => {
  it('genau 400 Spieler mit exakter Stärkeverteilung und maximal 83', () => {
    expect(pool).toHaveLength(400);
    const inBand = (a: number, b: number) => pool.filter((p) => p.overall >= a && p.overall <= b).length;
    expect(inBand(60, 64)).toBe(10);
    expect(inBand(65, 69)).toBe(25);
    expect(inBand(70, 73)).toBe(65);
    expect(inBand(74, 78)).toBe(230);
    expect(inBand(79, 81)).toBe(55);
    expect(inBand(82, 83)).toBe(15);
    expect(Math.max(...pool.map((p) => p.overall))).toBeLessThanOrEqual(83);
  });
  it('exakte Herkunftsverteilung nach Kontinenten', () => {
    const count = (r: string) => pool.filter((p) => p.region === r).length;
    expect(count('europe')).toBe(180);
    expect(count('south_america')).toBe(85);
    expect(count('africa')).toBe(65);
    expect(count('asia')).toBe(40);
    expect(count('north_central_america')).toBe(25);
    expect(count('oceania')).toBe(5);
  });
  it('Nationalität passt zur Region, Namen stammen aus dem Namenspool der Nationalität', () => {
    for (const p of pool) {
      const nat = NATIONALITIES.find((n) => n.code === p.nat)!;
      expect(nat.region).toBe(p.region);
      expect(nat.first).toContain(p.first);
      expect(nat.last).toContain(p.last);
      expect(FAMOUS_PLAYER_NAMES.has(`${p.first} ${p.last}`)).toBe(false);
    }
  });
  it('Positionsverteilung inkl. 40 Torhütern, Marktwerte nach Formel', () => {
    expect(DRAFT_POOL_POSITIONS.reduce((s, [, n]) => s + n, 0)).toBe(400);
    expect(pool.filter((p) => p.pos === 'GK')).toHaveLength(40);
    for (const p of pool) expect(p.value).toBe(marketValue(p.overall, p.age));
  });
  it('genügend günstige Spieler: 18 Manager × 22 Picks sind mit Startkapital „Schwer“ möglich', () => {
    const cheapest = pool.map((p) => p.value).sort((a, b) => a - b).slice(0, 22).reduce((a, b) => a + b, 0);
    expect(cheapest).toBeLessThan(210_000_000 - 42_540_000);
  });
});

describe('D5: Attribute treffen die Zielstärke exakt', () => {
  it('Feldspieler und Torhüter, alle Werte 1–99', () => {
    const rng = createRng('attrs');
    for (let i = 0; i < 300; i++) {
      const target = rng.int(55, 90);
      const pos = rng.pick(['CB', 'LB', 'CDM', 'CM', 'CAM', 'LW', 'ST'] as const);
      const a = generateOutfieldAttributes(rng, pos, target);
      expect(outfieldOverall(a, pos)).toBe(target);
      for (const v of Object.values(a)) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(99);
      }
      const g = generateGoalkeeperAttributes(rng, target);
      expect(goalkeeperOverall(g)).toBe(target);
    }
  });
  it('Payload-Spieler: gespeicherte Gesamtstärke entspricht den Attributen', () => {
    for (const p of payload.players) {
      const ovr = p.kind === 'goalkeeper' ? goalkeeperOverall(p.attrs as GoalkeeperAttributes) : outfieldOverall(p.attrs as OutfieldAttributes, p.pos as Exclude<typeof p.pos, 'GK'>);
      expect(ovr).toBe(p.overall);
      expect(p.potential).toBeGreaterThanOrEqual(p.overall);
    }
  });
});

describe('Determinismus', () => {
  it('gleicher Seed ⇒ identische Welt, anderer Seed ⇒ andere Welt', () => {
    const again = buildWorldInitialization('seed-abc', humans);
    expect(JSON.stringify(again)).toBe(JSON.stringify(payload));
    const other = buildWorldInitialization('seed-xyz', humans);
    expect(other.ai_clubs[0]!.name === payload.ai_clubs[0]!.name && other.players[0]!.last === payload.players[0]!.last).toBe(false);
  });
  it('funktioniert für 1 bis 18 menschliche Vereine', () => {
    for (const n of [1, 3, 18]) {
      const h = Array.from({ length: n }, (_, i) => ({ id: `h${i}`, name: `Menschenclub ${i}`, short_name: `MC${String(i).padStart(2, '0')}` }));
      const p = buildWorldInitialization(`n${n}`, h);
      expect(p.ai_clubs).toHaveLength(54 - n);
      expect(p.players.filter((x) => x.club_key === null)).toHaveLength(400);
    }
  });
  it('Payload bleibt kompakt genug für einen RPC-Aufruf', () => {
    expect(JSON.stringify(payload).length).toBeLessThan(2_000_000);
  });
});
