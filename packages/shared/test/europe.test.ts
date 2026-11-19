import { describe, expect, it } from 'vitest';
import { ASSOCIATIONS, EUROPE_ASSOCIATIONS, EUROPE_PLACES, buildEuropeAssociation, buildWorldInitialization, isBlockedClubName, normalizeName, registryFrom } from '../src/index.js';

describe('Europaweiter Transfermarkt', () => {
  it('jeder Verband hat genug Orte für seine Liga', () => {
    for (const a of EUROPE_ASSOCIATIONS) {
      const e = EUROPE_PLACES[a.code];
      expect(e, a.code).toBeDefined();
      expect(new Set(e!.places).size, a.code).toBeGreaterThanOrEqual(a.leagueSize);
    }
    expect(EUROPE_ASSOCIATIONS.length).toBe(ASSOCIATIONS.length - 1);
  });

  it('erzeugt alle 54 Ligen mit vollen Kadern, eindeutigen fiktiven Namen und Kürzeln', () => {
    const world = buildWorldInitialization('eu-seed', [{ id: 'h1', name: 'Mein Verein', short_name: 'MVN' }]);
    const reg = registryFrom([...world.ai_clubs, { name: 'Mein Verein', short_name: 'MVN' }]);
    const names = new Set<string>(); const shorts = new Set<string>();
    for (const c of world.ai_clubs) { names.add(normalizeName(c.name)); shorts.add(normalizeName(c.short_name)); }
    let clubs = 0, players = 0;
    for (const a of EUROPE_ASSOCIATIONS) {
      const p = buildEuropeAssociation('eu-seed', a.code, reg);
      expect(p.clubs.length).toBe(a.leagueSize);
      for (const c of p.clubs) {
        expect(names.has(normalizeName(c.name)), c.name).toBe(false);
        expect(shorts.has(normalizeName(c.short_name)), c.short_name).toBe(false);
        names.add(normalizeName(c.name)); shorts.add(normalizeName(c.short_name));
        expect(isBlockedClubName(c.name)).toBe(false);
        expect(c.short_name).toMatch(/^[A-ZÄÖÜ0-9]{3,4}$/u);
        const squad = p.players.filter((x) => x.club_key === c.key);
        expect(squad.length).toBe(22);
        expect(squad.filter((x) => x.pos === 'GK').length).toBe(3);
      }
      clubs += p.clubs.length; players += p.players.length;
    }
    expect(clubs).toBeGreaterThan(650);
    expect(players).toBeGreaterThan(clubs * 22);
  });

  it('deterministisch und Stärke folgt der Verbandsstärke', () => {
    const a = buildEuropeAssociation('s', 'ENG', registryFrom([]));
    const b = buildEuropeAssociation('s', 'ENG', registryFrom([]));
    expect(a.clubs.map((c) => c.name)).toEqual(b.clubs.map((c) => c.name));
    const smr = buildEuropeAssociation('s', 'SMR', registryFrom([]));
    expect(a.clubs[0]!.target_strength).toBeGreaterThan(smr.clubs[0]!.target_strength + 15);
    expect(a.clubs[0]!.level).toBe(1);
    expect(smr.clubs[0]!.level).toBe(4);
  });
});
