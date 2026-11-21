import { describe, expect, it } from 'vitest';
import { UEFA_TOP20, ASSOCIATIONS, EUROPE_ASSOCIATIONS, EUROPE_PLACES, buildEuropeAssociation, buildWorldInitialization, isBlockedClubName, normalizeName, registryFrom } from '../src/index.js';

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
        if (UEFA_TOP20.includes(a.code)) {
          expect(squad.length).toBe(22);
          expect(squad.filter((x) => x.pos === 'GK').length).toBe(3);
        } else {
          // reduzierte Länder: die besten elf in Grundordnung
          expect(squad.length).toBe(11);
          expect(squad.filter((x) => x.pos === 'GK').length).toBe(1);
          expect(squad.filter((x) => ['CB', 'LB', 'RB'].includes(x.pos)).length).toBe(4);
          expect(squad.filter((x) => ['CDM', 'CM', 'CAM', 'LM', 'RM'].includes(x.pos)).length).toBe(3);
        }
      }
      clubs += p.clubs.length; players += p.players.length;
    }
    expect(clubs).toBeGreaterThan(650);
    expect(players).toBeGreaterThan(clubs * 11);
    expect(players).toBeLessThan(clubs * 20);
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

describe('Free Agents', () => {
  it('neu erzeugte Free Agents: überwiegend 55–68, wenige 69–72, keiner über 72', () => {
    const reg = registryFrom([]);
    const fas = ['ENG', 'ESP', 'ITA', 'FRA', 'POR', 'NED', 'TUR', 'POL'].flatMap((c) => buildEuropeAssociation('fa', c, reg).players.filter((p) => p.club_key === null));
    expect(fas.length).toBeGreaterThan(20);
    expect(Math.max(...fas.map((p) => p.overall))).toBeLessThanOrEqual(72);
    expect(Math.min(...fas.map((p) => p.overall))).toBeGreaterThanOrEqual(55);
    expect(fas.filter((p) => p.overall >= 69).length / fas.length).toBeLessThan(0.3);
  });
  it('Verteilung über viele Ziehungen', async () => {
    const { createRng, freeAgentOverall } = await import('../src/index.js');
    const rng = createRng('fa-dist');
    const xs = Array.from({ length: 2000 }, () => freeAgentOverall(rng, rng.int(18, 34)));
    expect(Math.max(...xs)).toBe(72);
    expect(xs.filter((x) => x >= 69).length / xs.length).toBeLessThan(0.15);
    expect(xs.filter((x) => x <= 68).length / xs.length).toBeGreaterThan(0.85);
  });
});

describe('Reduzierte Kader', () => {
  it('reduziert: gleiche Vereine und Stärken, elf Spieler mit bester Grundordnung', () => {
    const full = buildEuropeAssociation('r', 'SVN', registryFrom([]), new Set(), { reduced: false });
    const red = buildEuropeAssociation('r', 'SVN', registryFrom([]), new Set(), { reduced: true });
    expect(red.clubs.map((c) => c.name)).toEqual(full.clubs.map((c) => c.name));
    for (const c of full.clubs) {
      const f = full.players.filter((x) => x.club_key === c.key);
      const r = red.players.filter((x) => x.club_key === c.key);
      expect(r).toHaveLength(11);
      const top11 = f.map((x) => x.overall).sort((a, b) => b - a).slice(0, 11).reduce((a, b) => a + b, 0) / 11;
      const kept = r.reduce((a, b) => a + b.overall, 0) / 11;
      expect(top11 - kept).toBeLessThan(1.5);
    }
  });
});
