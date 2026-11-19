import { describe, expect, it } from 'vitest';
import {
  DRAFT_POOL_REGIONS,
  DRAFT_POOL_SIZE,
  DRAFT_POOL_STRENGTH_BANDS,
  MARKET_VALUE_ANCHORS,
  MILLION,
  OUTFIELD_POSITIONS,
  STARTING_CAPITAL,
  annualSalary,
  contractSalary,
  applyRestDays,
  applyTraining,
  baseMarketValue,
  canonicalInviteCode,
  clubCreationSchema,
  colorDistance,
  CLASH_THRESHOLD,
  createRng,
  familiarity,
  fitnessLoss,
  fitnessPerformanceMultiplier,
  goalkeeperOverall,
  isValidInviteCode,
  isValidStadiumCapacity,
  marketValue,
  normalizeName,
  outfieldOverall,
  positionPenalty,
  positionWeights,
  randomCrest,
  readableTextColor,
  remainingFreeAgentsAfterDraft,
  renderCrestSvg,
  resolveAwayDisplayColor,
  snakeDraftManagerIndex,
  stadiumBuildCost,
  stadiumExpansionCost,
  staminaFactor,
  tacticLoadFactor,
  totalDraftPicks,
  type OutfieldAttributes,
} from '../src/index.js';

describe('Konstanten aus dem Master-Prompt', () => {
  it('D2: Draft-Pool summiert exakt 400, Regionen ebenfalls', () => {
    expect(DRAFT_POOL_STRENGTH_BANDS.reduce((s, b) => s + b.count, 0)).toBe(DRAFT_POOL_SIZE);
    expect(Object.values(DRAFT_POOL_REGIONS).reduce((s, n) => s + n, 0)).toBe(DRAFT_POOL_SIZE);
    expect(Math.max(...DRAFT_POOL_STRENGTH_BANDS.map((b) => b.max))).toBe(83);
  });
  it('I1: Startkapital', () => {
    expect(STARTING_CAPITAL).toEqual({ easy: 320 * MILLION, medium: 260 * MILLION, hard: 210 * MILLION });
  });
});

describe('D4: Marktwert', () => {
  it('trifft alle Stützpunkte exakt', () => {
    for (const [ovr, m] of MARKET_VALUE_ANCHORS) expect(baseMarketValue(ovr)).toBe(Math.round(m * 100) * 10_000);
  });
  it('ist streng monoton steigend von 55 bis 95', () => {
    for (let o = 55; o < 95; o++) expect(baseMarketValue(o + 1)).toBeGreaterThan(baseMarketValue(o));
  });
  it('ist nichtlinear (Zuwachs pro Punkt wächst)', () => {
    expect(baseMarketValue(81) - baseMarketValue(80)).toBeGreaterThan(baseMarketValue(71) - baseMarketValue(70));
  });
  it('wendet Altersfaktoren an', () => {
    expect(marketValue(78, 20)).toBe(Math.round((12.6 * MILLION * 1.07) / 10_000) * 10_000);
    expect(marketValue(78, 25)).toBe(12.6 * MILLION);
    expect(marketValue(78, 30)).toBe(Math.round((12.6 * MILLION * 0.93) / 10_000) * 10_000);
    expect(marketValue(78, 34)).toBe(Math.round((12.6 * MILLION * 0.85) / 10_000) * 10_000);
  });
  it('ein älterer Topspieler bleibt teurer als ein jüngerer, klar schwächerer', () => {
    expect(marketValue(83, 34)).toBeGreaterThan(marketValue(80, 21));
  });
});

describe('H5: Gehälter', () => {
  it('ältere Spieler verdienen bei gleicher Stärke mehr', () => {
    const ages = [19, 22, 26, 29, 32, 35];
    const salaries = ages.map((a) => annualSalary(76, a));
    for (let i = 1; i < salaries.length; i++) expect(salaries[i]!).toBeGreaterThan(salaries[i - 1]!);
  });
  it('Formel: Stärke 70 in der 2. Liga = 330.000 €, Stärke 76 ≈ 805.000 €', () => {
    expect(contractSalary(70, 25, 2)).toBe(330_000);
    expect(annualSalary(76, 26)).toBe(805_000);
  });
  it('Spielklasse, Vereinsgröße und Laufzeit wirken in die richtige Richtung', () => {
    expect(contractSalary(75, 26, 1)).toBeGreaterThan(contractSalary(75, 26, 2));
    expect(contractSalary(75, 26, 2)).toBeGreaterThan(contractSalary(75, 26, 3));
    expect(contractSalary(75, 26, 2, 80)).toBeGreaterThan(contractSalary(75, 26, 2, 30));
    expect(contractSalary(75, 26, 2, 50, 1)).toBeGreaterThan(contractSalary(75, 26, 2, 50, 5));
  });
  it('durchschnittlicher Zweitligakader (22 Spieler) kostet 6–10 Mio. € pro Jahr', () => {
    // 11 Stammspieler um 73, 11 Ergänzungsspieler um 67, gemischtes Alter
    const squad = [74, 73, 73, 72, 74, 73, 72, 73, 74, 72, 73, 68, 67, 66, 67, 68, 66, 65, 67, 66, 62, 60];
    const ages = [27, 25, 29, 31, 24, 26, 28, 33, 22, 27, 30, 21, 26, 29, 19, 24, 32, 28, 23, 26, 34, 18];
    const total = squad.reduce((s, o, i) => s + contractSalary(o, ages[i]!, 2), 0);
    expect(total).toBeGreaterThan(6_000_000);
    expect(total).toBeLessThan(10_000_000);
  });
});

describe('I3: Stadion', () => {
  it('Kosten nach Formel', () => {
    expect(stadiumBuildCost(10_000)).toBe(10_000_000);
    expect(stadiumBuildCost(15_000)).toBe(14_700_000);
    expect(stadiumBuildCost(50_000)).toBe(Math.round(50_000 * 1000 * Math.pow(0.98, 8)));
  });
  it('nur 5.000er-Schritte zwischen 10.000 und 50.000', () => {
    expect(isValidStadiumCapacity(12_500)).toBe(false);
    expect(isValidStadiumCapacity(55_000)).toBe(false);
    expect(isValidStadiumCapacity(5_000)).toBe(false);
    expect(() => stadiumBuildCost(12_000)).toThrow();
  });
  it('Ausbau kostet 25 Mio. € je 5.000 Plätze', () => {
    expect(stadiumExpansionCost(20_000, 30_000)).toBe(50 * MILLION);
    expect(() => stadiumExpansionCost(30_000, 30_000)).toThrow();
  });
});

describe('F7/G1/G2: Fitness', () => {
  it('Standardverlust 0,5 pro Minute bei Ausdauer 75 und normaler Belastung', () => {
    expect(staminaFactor(75)).toBe(1);
    expect(fitnessLoss(90, 'normal', 75)).toBe(45);
  });
  it('Ausdauer und Taktik skalieren den Verlust', () => {
    expect(fitnessLoss(90, 'extreme', 75)).toBeCloseTo(63);
    expect(fitnessLoss(90, 'normal', 50)).toBeCloseTo(45 * 1.2);
    expect(fitnessLoss(90, 'normal', 95)).toBeLessThan(45);
  });
  it('Leistung sinkt abgestuft, mental schwächer als physisch', () => {
    expect(fitnessPerformanceMultiplier(95)).toBe(1);
    const values = [85, 75, 65, 55, 45, 30].map((f) => fitnessPerformanceMultiplier(f));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
    expect(fitnessPerformanceMultiplier(45, 'mental')).toBeGreaterThan(fitnessPerformanceMultiplier(45, 'physical'));
  });
  it('Regeneration +15 pro freiem Tag, Deckel 100; Training −20', () => {
    expect(applyRestDays(50, 2)).toBe(80);
    expect(applyRestDays(90, 3)).toBe(100);
    expect(applyTraining(15)).toBe(0);
  });
  it('Taktikfaktor entsteht aus echten Einstellungen und bleibt in 0,70–1,40', () => {
    expect(tacticLoadFactor({ pressingIntensity: 3, tempo: 3, defensiveLine: 3, counterPress: false })).toBe(1);
    expect(tacticLoadFactor({ pressingIntensity: 5, tempo: 5, defensiveLine: 5, counterPress: true })).toBe(1.4);
    expect(tacticLoadFactor({ pressingIntensity: 1, tempo: 1, defensiveLine: 1, counterPress: false })).toBe(0.7);
  });
});

describe('D3: Snake-Draft', () => {
  it('folgt A–B–C, C–B–A, A–B–C', () => {
    const order = Array.from({ length: 9 }, (_, i) => 'ABC'[snakeDraftManagerIndex(3, i)]).join('');
    expect(order).toBe('ABCCBAABC');
  });
  it('jeder Manager bekommt genau 22 Picks', () => {
    for (const n of [1, 2, 3, 5, 18]) {
      const counts = new Array(n).fill(0);
      for (let i = 0; i < totalDraftPicks(n); i++) counts[snakeDraftManagerIndex(n, i)]++;
      expect(counts.every((c) => c === 22)).toBe(true);
    }
  });
  it('Free Agents werden aus der Teilnehmerzahl berechnet', () => {
    expect(remainingFreeAgentsAfterDraft(3)).toBe(400 - 66);
    expect(() => remainingFreeAgentsAfterDraft(19)).toThrow();
  });
});

describe('D5: Positionen und Gesamtstärke', () => {
  it('Gewichte je Position summieren sich auf 1', () => {
    for (const pos of OUTFIELD_POSITIONS) {
      const sum = Object.values(positionWeights(pos)).reduce((s, w) => s + (w ?? 0), 0);
      expect(sum).toBeCloseTo(1, 6);
    }
  });
  it('gleichmäßige Attribute ergeben genau diesen Wert', () => {
    const attrs = Object.fromEntries(
      ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'physical', 'stamina', 'gameIntelligence', 'heading', 'mentality', 'freeKicks', 'penalties', 'corners', 'crossing', 'throwIns'].map((k) => [k, 77]),
    ) as unknown as OutfieldAttributes;
    for (const pos of OUTFIELD_POSITIONS) expect(outfieldOverall(attrs, pos)).toBe(77);
    expect(
      goalkeeperOverall({ reflexes: 80, handling: 80, positioning: 80, oneOnOne: 80, commandOfArea: 80, distribution: 80, kicking: 80, reactionSpeed: 80, gameIntelligence: 80, mentality: 80, stamina: 60, penalties: 40 }),
    ).toBe(80);
  });
  it('ein Stürmer ist als Stürmer stärker als als Innenverteidiger', () => {
    const striker: OutfieldAttributes = { pace: 85, shooting: 88, passing: 70, dribbling: 80, defending: 35, physical: 75, stamina: 75, gameIntelligence: 78, heading: 80, mentality: 75, freeKicks: 60, penalties: 80, corners: 50, crossing: 55, throwIns: 40 };
    expect(outfieldOverall(striker, 'ST')).toBeGreaterThan(outfieldOverall(striker, 'CB') + 10);
  });
  it('Malus ist abgestuft und hält die Bereiche ein', () => {
    expect(positionPenalty('CB', [], 'CB')).toBe(0);
    expect(positionPenalty('CB', ['CDM'], 'CDM')).toBe(-1);
    expect(familiarity('CB', [], 'LB')).toBe('related');
    const related = positionPenalty('CB', [], 'LB');
    expect(related).toBeLessThanOrEqual(-3);
    expect(related).toBeGreaterThanOrEqual(-5);
    expect(familiarity('CB', [], 'CM')).toBe('unfamiliar');
    const unfamiliar = positionPenalty('CB', [], 'CM');
    expect(unfamiliar).toBeLessThanOrEqual(-6);
    expect(unfamiliar).toBeGreaterThanOrEqual(-10);
    expect(familiarity('CB', [], 'ST')).toBe('unsuitable');
    const bad = positionPenalty('CB', [], 'ST');
    expect(bad).toBeLessThanOrEqual(-11);
    expect(bad).toBeGreaterThanOrEqual(-20);
    expect(positionPenalty('ST', [], 'GK')).toBe(-20);
    expect(positionPenalty('GK', [], 'CB')).toBe(-16);
  });
  it('alle Positionspaare liegen im Bereich 0 bis −20', () => {
    const all = ['GK', ...OUTFIELD_POSITIONS] as const;
    for (const a of all) for (const b of all) {
      const p = positionPenalty(a, [], b);
      expect(p).toBeLessThanOrEqual(0);
      expect(p).toBeGreaterThanOrEqual(-20);
    }
  });
});

describe('Namen und Einladungscodes', () => {
  it('C7.1: Normalisierung ignoriert Schreibweise, Akzente und Leerzeichen', () => {
    expect(normalizeName('FC Köln-Süd 1908')).toBe(normalizeName('fc koln sud 1908'));
    expect(normalizeName('Straße United')).toBe('strasseunited');
    expect(normalizeName('Atlético Málaga')).toBe('atleticomalaga');
  });
  it('B1: Einladungscode-Format', () => {
    expect(isValidInviteCode('AB3K7Q')).toBe(true);
    expect(isValidInviteCode('AB3K7')).toBe(false);
    expect(isValidInviteCode('AB0K7Q')).toBe(false);
    expect(canonicalInviteCode(' ab3-k7q ')).toBe('AB3K7Q');
  });
});

describe('Farben (F2)', () => {
  it('Trikotnummern bleiben lesbar', () => {
    expect(readableTextColor('#FFFFFF')).toBe('#111111');
    expect(readableTextColor('#1B1B1B')).toBe('#FFFFFF');
  });
  it('ähnliche Vereinsfarben bekommen eine Ausweichfarbe', () => {
    const away = resolveAwayDisplayColor('#C0392B', '#B03A2E', '#FFFFFF');
    expect(away).toBe('#FFFFFF');
    expect(colorDistance(away, '#C0392B')).toBeGreaterThanOrEqual(CLASH_THRESHOLD);
    expect(resolveAwayDisplayColor('#C0392B', '#1F5FA8', '#FFFFFF')).toBe('#1F5FA8');
  });
});

describe('B3: Wappen', () => {
  it('rendert gültiges, sicheres SVG', () => {
    const rng = createRng('crest');
    const crest = randomCrest(() => rng.next(), 'FCD');
    const svg = renderCrestSvg(crest, 'x1');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('FCD');
    expect(svg).not.toMatch(/<script|on\w+=/i);
  });
  it('lehnt eingeschleuste Inhalte ab', () => {
    const rng = createRng('crest');
    const crest = { ...randomCrest(() => rng.next(), 'FC'), initials: '<s>' };
    expect(() => renderCrestSvg(crest)).toThrow();
    expect(() => renderCrestSvg({ ...crest, initials: 'FC', primary: 'red;"/><script>' })).toThrow();
  });
});

describe('Seed-RNG', () => {
  it('ist reproduzierbar und unterscheidet Seeds', () => {
    const a = createRng('welt-1');
    const b = createRng('welt-1');
    const c = createRng('welt-2');
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
  });
  it('kann aus dem Zustand exakt fortgesetzt werden', () => {
    const a = createRng('x');
    a.next();
    const copy = createRng(a.state());
    expect(copy.next()).toBe(a.next());
  });
  it('int() bleibt im Bereich und ist grob gleichverteilt', () => {
    const r = createRng('dist');
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 60_000; i++) counts[r.int(0, 5)]!++;
    for (const n of counts) expect(Math.abs(n - 10_000)).toBeLessThan(500);
  });
});

describe('Eingabeschema Vereinsgründung', () => {
  const rng = createRng('club');
  const valid = {
    name: 'SV Grünwald 1911',
    shortName: 'SVG',
    primaryColor: '#1E7A46',
    secondaryColor: '#FFFFFF',
    accentColor: '#F2C14E',
    crest: randomCrest(() => rng.next(), 'SVG'),
    kit: { pattern: 'stripes', primary: '#1E7A46', secondary: '#FFFFFF' },
    stadiumName: 'Waldstadion am See',
    stadiumCapacity: 25_000,
  };
  it('akzeptiert gültige Eingaben', () => {
    expect(clubCreationSchema.safeParse(valid).success).toBe(true);
  });
  it('lehnt ungültige Kapazität und Kurznamen ab', () => {
    expect(clubCreationSchema.safeParse({ ...valid, stadiumCapacity: 27_000 }).success).toBe(false);
    expect(clubCreationSchema.safeParse({ ...valid, shortName: 'sv' }).success).toBe(false);
  });
});

import { ASSOCIATIONS, FORMATIONS } from '../src/index.js';

describe('Referenzdaten', () => {
  it('C5: genau 55 eindeutige UEFA-Verbände', () => {
    expect(ASSOCIATIONS).toHaveLength(55);
    expect(new Set(ASSOCIATIONS.map((a) => a.code)).size).toBe(55);
    expect(ASSOCIATIONS.find((a) => a.code === 'GER')?.leagueSize).toBe(18);
  });
  it('E1: rund 30 Formationen mit je genau 11 Positionen und einem Torhüter', () => {
    expect(FORMATIONS.length).toBe(30);
    expect(new Set(FORMATIONS.map((f) => f.code)).size).toBe(FORMATIONS.length);
    for (const f of FORMATIONS) {
      expect(f.slots).toHaveLength(11);
      expect(f.slots.filter((s) => s.position === 'GK')).toHaveLength(1);
      for (const s of f.slots) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(100);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(100);
      }
    }
  });
});
