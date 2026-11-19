import { describe, expect, it } from 'vitest';
import { applyXp, declineAttrs, devAgeFactor, devAttributeCost, devHeadroomFactor, devMultiplier, matchXp, trainingShares } from '../src/rules/development.js';

describe('Spielerentwicklung (G3–G6)', () => {
  it('junge Spieler entwickeln sich deutlich schneller als ältere', () => {
    expect(devAgeFactor(18)).toBeGreaterThan(devAgeFactor(24));
    expect(devAgeFactor(24)).toBeGreaterThan(devAgeFactor(30));
    expect(devAgeFactor(34)).toBeLessThan(0.2);
  });
  it('am Potenzial kaum noch Fortschritt, hohe Spielintelligenz hilft', () => {
    expect(devHeadroomFactor(80, 80)).toBeLessThan(0.2);
    expect(devHeadroomFactor(70, 80)).toBe(1);
    expect(devMultiplier(20, 70, 80, 90)).toBeGreaterThan(devMultiplier(20, 70, 80, 50));
  });
  it('XP werden sofort in Attribute umgewandelt, teurer bei hohen Werten, maximal 99', () => {
    expect(devAttributeCost(85)).toBeGreaterThan(devAttributeCost(60));
    const r = applyXp({ passing: 70 }, {}, { passing: 11 });
    expect(r.attrs.passing).toBe(72);
    expect(r.gains.passing).toBe(2);
    expect(r.xp.passing).toBeCloseTo(11 - devAttributeCost(70) - devAttributeCost(71));
    expect(applyXp({ passing: 98 }, {}, { passing: 1000 }).attrs.passing).toBe(99);
  });
  it('positionsgerechtes Training: Schwerpunkt × Relevanz, Anteile summieren sich zu 1', () => {
    const st = trainingShares('outfield', 'ST', 'offense');
    expect(Object.values(st).reduce((s, v) => s + v, 0)).toBeCloseTo(1);
    expect(st.shooting).toBeGreaterThan(st.crossing ?? 0);
    expect(Object.keys(trainingShares('goalkeeper', 'GK', 'defense'))).toContain('reflexes');
  });
  it('Spielleistung: Note, Tore und Paraden fördern die passenden Attribute; ohne Einsatz nichts', () => {
    expect(matchXp('outfield', 'ST', { minutes: 0, rating: 9, goals: 3, assists: 0, tacklesWon: 0, interceptions: 0, saves: 0 })).toEqual({});
    const good = matchXp('outfield', 'ST', { minutes: 90, rating: 8, goals: 2, assists: 0, tacklesWon: 0, interceptions: 0, saves: 0 });
    const poor = matchXp('outfield', 'ST', { minutes: 90, rating: 5.5, goals: 0, assists: 0, tacklesWon: 0, interceptions: 0, saves: 0 });
    expect(good.shooting!).toBeGreaterThan(poor.shooting!);
    expect(matchXp('goalkeeper', 'GK', { minutes: 90, rating: 7, goals: 0, assists: 0, tacklesWon: 0, interceptions: 0, saves: 6 }).reflexes!).toBeGreaterThan(0.5);
  });
  it('Alterung erst ab 29, körperliche Werte zuerst', () => {
    const attrs = { pace: 80, gameIntelligence: 80, passing: 80 };
    expect(declineAttrs(attrs, 27, 0.9, () => 0)).toEqual({});
    const d = declineAttrs(attrs, 34, 0.5, () => 0.99);
    expect(d.pace!).toBeLessThan(d.gameIntelligence ?? 0);
  });
});
