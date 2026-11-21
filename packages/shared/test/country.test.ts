import { describe, expect, it } from 'vitest';
import {
  ASSOCIATIONS, buildEuropeAssociation, buildWorldInitialization, capitalFactor, countryOptions, countryTierShift,
  draftPoolMax, economyFactor, europeAssociationsFor, nationalLeagueNames, registryFrom,
} from '../src/index.js';

const humans = [
  { id: 'h1', name: 'FC Heimat', short_name: 'FCH' },
  { id: 'h2', name: 'SV Gast', short_name: 'SVG' },
];

describe('Länderauswahl und Startliga', () => {
  it('alle 55 UEFA-Verbände wählbar', () => {
    expect(countryOptions()).toHaveLength(55);
    expect(countryOptions()[0]!.code).toBe('ENG');
  });

  it('Referenz Deutschland/2. Liga: Faktoren 1, Pool unverändert', () => {
    expect(capitalFactor('GER', 2)).toBe(1);
    expect(economyFactor('GER')).toBe(1);
    expect(countryTierShift('GER', 2)).toBe(0);
    expect(draftPoolMax('GER', 2)).toBe(83);
    const a = buildWorldInitialization('seed-x', humans);
    const b = buildWorldInitialization('seed-x', humans, { country: 'GER', startTier: 2 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.country).toBeUndefined();
  });

  it.each([
    ['ITA', 1], ['SMR', 2], ['NED', 3], ['GER', 3], ['ENG', 1], ['FRO', 3],
  ] as const)('%s, %i. Liga: 3 × 18 Vereine, Menschen in der Startliga, Skalierung', (code, tier) => {
    const p = buildWorldInitialization(`seed-${code}`, humans, { country: code, startTier: tier });
    for (const t of [1, 2, 3] as const) {
      expect(p.ai_clubs.filter((c) => c.tier === t)).toHaveLength(t === tier ? 16 : 18);
    }
    expect(p.country).toBe(code);
    expect(p.start_tier).toBe(tier);
    expect(p.league_names).toEqual(nationalLeagueNames(code));
    const names = p.ai_clubs.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(p.ai_clubs.map((c) => c.short_name)).size).toBe(p.ai_clubs.length);
    const pool = p.players.filter((x) => x.club_key === null);
    expect(pool).toHaveLength(400);
    expect(Math.max(...pool.map((x) => x.overall))).toBeLessThanOrEqual(draftPoolMax(code, tier));
    const avg = (t: number) => p.ai_clubs.filter((c) => c.tier === t).reduce((s, c) => s + c.target_strength, 0) / p.ai_clubs.filter((c) => c.tier === t).length;
    expect(avg(1)).toBeGreaterThan(avg(2));
    expect(avg(2)).toBeGreaterThan(avg(3));
    if (code !== 'GER') expect(p.amateur_names).toHaveLength(30);
    // Kader des Spiellands überwiegend mit heimischen Spielern
    const squad = p.players.filter((x) => x.club_key !== null);
    expect(squad.filter((x) => x.nat === code).length / squad.length).toBeGreaterThan(0.5);
  });

  it('Landesstärke skaliert Spielstärke und Wirtschaft', () => {
    const eng = buildWorldInitialization('s', humans, { country: 'ENG', startTier: 1 });
    const smr = buildWorldInitialization('s', humans, { country: 'SMR', startTier: 1 });
    const top = (p: typeof eng) => Math.max(...p.ai_clubs.map((c) => c.target_strength));
    expect(top(eng)).toBeGreaterThan(top(smr) + 20);
    expect(economyFactor('SMR')).toBeLessThan(economyFactor('FRA'));
    expect(capitalFactor('GER', 1)).toBeGreaterThan(capitalFactor('GER', 2));
    expect(capitalFactor('GER', 3)).toBeLessThan(1);
  });

  it('Ausland: Deutschland als Erstliga, Spielland ausgeschlossen', () => {
    const list = europeAssociationsFor('ITA');
    expect(list).toHaveLength(ASSOCIATIONS.length - 1);
    expect(list.some((a) => a.code === 'ITA')).toBe(false);
    const ger = buildEuropeAssociation('seed', 'GER', registryFrom([]));
    expect(ger.clubs).toHaveLength(18);
    expect(ger.clubs[0]!.league_name).toBe('Bundesliga (Deutschland)');
  });
});
