import { describe, expect, it } from 'vitest';
import { AWAY_Y1, AWAY_X0, blockCount, cellsFromRegions, fenceRect, isAwayPoint, placementProblem, rectCorners, regionSeats, regionsFromCells, stadiumCells, stadiumGeo } from './geometry';
import { LIMITS, TEMPLATES, commit, complexityLimits, historyOf, isV2, normalizeChoreo, redo, undo, validateChoreo, withLegacyFields, type ChoreoV2, type StandSide } from './model';
import { L, W } from '../stadiumArt';

const SIZES: Array<[string, number, string]> = [['klein 10 Tsd. offen', 10000, 'classic'], ['mittel 30 Tsd.', 30000, 'modern'], ['groß 50 Tsd. Arena', 50000, 'arena'], ['groß 50 Tsd. traditionell', 50000, 'traditional']];
const colors = { primary: '#c8102e', secondary: '#ffffff', short: 'FCD' };

describe('Choreografie-Modell', () => {
  it('altes Design wird in v2 überführt, v2 bleibt unverändert', () => {
    const old = { pattern: 'checker' as const, colors: ['#111111', '#eeeeee'], text: 'FC', motif: 'crest' as const, block: 'all' as const };
    const v = normalizeChoreo(old);
    expect(isV2(v)).toBe(true);
    expect(v.elements).toHaveLength(1);
    expect(v.elements[0]).toMatchObject({ kind: 'cards', pattern: 'checker', motif: 'crest' });
    expect((v.elements[0] as { regions: Array<{ side: string }> }).regions.map((r) => r.side).sort()).toEqual(['N', 'S', 'W']);
    expect(normalizeChoreo(v)).toBe(v);
    expect(validateChoreo(v)).toEqual([]);
  });

  it('alle Vorlagen sind gültig, tragen Legacy-Felder und passen zu jeder Stadiongröße', () => {
    for (const [, cap, style] of SIZES) {
      const g = stadiumGeo(cap, { style: style as 'classic' });
      const lim = complexityLimits(cap);
      for (const t of TEMPLATES) {
        const d = t.build({ ...colors, tiers: g.tiers, closed: g.closed });
        expect(validateChoreo(d), `${t.key} @ ${cap}`).toEqual([]);
        expect(d.pattern).toBeTruthy(); expect(d.colors.length).toBeGreaterThan(0);
        expect(d.elements.length).toBeLessThanOrEqual(LIMITS.elements);
        expect(lim.elements).toBeGreaterThanOrEqual(12);
      }
    }
    expect(TEMPLATES.map((t) => t.key)).toEqual(expect.arrayContaining(['classic', 'derby', 'top', 'final', 'europe', 'title']));
  });

  it('Prüfung lehnt ungültige Designs ab (Spiegel der Datenbankprüfung)', () => {
    const ok = TEMPLATES[1]!.build({ ...colors, tiers: 2, closed: true });
    const mut = (f: (d: ChoreoV2) => void) => { const c = JSON.parse(JSON.stringify(ok)) as ChoreoV2; f(c); return validateChoreo(c); };
    expect(mut(() => undefined)).toEqual([]);
    expect(mut((d) => { d.scenes = Array.from({ length: 5 }, () => ({ dur: 5 })); }).length).toBeGreaterThan(0);
    expect(mut((d) => { d.scenes[0]!.dur = 1; }).length).toBeGreaterThan(0);
    expect(mut((d) => { (d.elements[0] as { colors: string[] }).colors = ['rot']; }).length).toBeGreaterThan(0);
    expect(mut((d) => { d.elements[0]!.s1 = 9; }).length).toBeGreaterThan(0);
    expect(mut((d) => { (d.elements[0] as { kind: string }).kind = 'laser'; }).length).toBeGreaterThan(0);
    expect(mut((d) => { d.elements = Array.from({ length: 41 }, () => d.elements[0]!); }).length).toBeGreaterThan(0);
    expect(mut((d) => { (d.elements[0] as { text: string }).text = 'x'.repeat(41); }).length).toBeGreaterThan(0);
    expect(mut((d) => { (d.elements[0] as { regions: Array<{ side: string }> }).regions = [{ side: 'X' }]; }).length).toBeGreaterThan(0);
  });

  it('Rückgängig/Wiederholen: Verlauf, Duplikate werden nicht doppelt gespeichert', () => {
    let h = historyOf(1);
    h = commit(h, 2); h = commit(h, 2); h = commit(h, 3);
    expect(h.past).toEqual([1, 2]);
    h = undo(h); expect(h.present).toBe(2);
    h = undo(h); expect(h.present).toBe(1);
    h = undo(h); expect(h.present).toBe(1); // am Anfang nichts mehr
    h = redo(h); h = redo(h); expect(h.present).toBe(3);
    h = redo(h); expect(h.present).toBe(3);
    h = undo(h); h = commit(h, 9); expect(h.future).toEqual([]); // neuer Zweig löscht „Wiederholen“
  });

  it('Legacy-Felder stammen aus dem ersten Kartenelement', () => {
    const d = withLegacyFields({ v: 2, scenes: [{ dur: 5 }], elements: [], pattern: 'stripes', colors: ['#000000'] }, colors);
    expect(d.colors).toEqual([colors.primary, colors.secondary]); expect(d.text).toBe('FCD');
  });

  it('Komplexität wächst mit der Stadiongröße', () => {
    const a = complexityLimits(10000), b = complexityLimits(30000), c = complexityLimits(50000);
    expect(a.elements).toBeLessThan(b.elements); expect(b.elements).toBeLessThan(c.elements);
    expect(a.scenes).toBeLessThan(c.scenes);
  });
});

describe('Stadiongeometrie der Choreografien (identisch zur Matchansicht)', () => {
  for (const [label, cap, style] of SIZES) {
    describe(label, () => {
      const g = stadiumGeo(cap, { style: style as 'classic' });
      it('Ränge und Seiten entsprechen Kapazität und Stil; Ecken nur bei geschlossenen Stadien', () => {
        expect(g.tiers).toBe(cap <= 20000 ? 1 : cap <= 40000 ? 2 : 3);
        expect(g.tierNames).toHaveLength(g.tiers);
        const corners = g.sides.filter((s) => s.length === 2);
        expect(corners.length).toBe(g.closed ? 4 : 0);
        expect(g.closed).toBe(style === 'modern' || style === 'arena');
        for (const s of g.seats) expect(g.sides).toContain(s.side);
      });
      it('kein Sitz auf dem Spielfeld; Gästeblock-Sitze sind in keinem Bereich enthalten', () => {
        for (const s of g.seats) expect(s.seat.x > 0 && s.seat.x < L && s.seat.y > 0 && s.seat.y < W).toBe(false);
        const all = regionSeats(g, g.sides.map((side) => ({ side })));
        expect(all.length).toBeGreaterThan(0);
        expect(all.every((s) => !s.seat.away && !isAwayPoint(s.seat.x, s.seat.y))).toBe(true);
        // Osttribüne: nur der Teil unterhalb des Gästeblocks
        const east = regionSeats(g, [{ side: 'E' }]);
        expect(east.every((s) => s.seat.y >= AWAY_Y1 - 1e-9)).toBe(true);
        expect(g.seats.filter((s) => s.seat.away).length).toBeGreaterThan(0);
      });
      it('jede Tribünenseite hat Sitze; Rang-Filter respektiert vorhandene Ränge', () => {
        for (const side of g.sides) expect(regionSeats(g, [{ side }]).length, side).toBeGreaterThan(0);
        const upper = regionSeats(g, [{ side: 'N', tiers: ['upper'] }]);
        if (g.tiers === 1) expect(upper).toHaveLength(0); // kein Oberrang im kleinen Stadion ⇒ nichts anzeigen
        else expect(upper.length).toBeGreaterThan(0);
        const lower = regionSeats(g, [{ side: 'N', tiers: ['lower'] }]);
        const everyTier = regionSeats(g, [{ side: 'N' }]);
        expect(lower.length).toBeLessThanOrEqual(everyTier.length);
        if (g.tiers === 3) expect(regionSeats(g, [{ side: 'S', tiers: ['middle'] }]).length).toBeGreaterThan(0);
      });
      it('Ecken existieren nur bei geschlossenen Stadien', () => {
        for (const c of ['NW', 'NE', 'SW', 'SE'] as StandSide[]) {
          const n = regionSeats(g, [{ side: c }]).length;
          if (g.closed) { if (c !== 'NE') expect(n, c).toBeGreaterThan(0); } else expect(n, c).toBe(0);
        }
      });
      it('Bereichsanteil (von/bis) schneidet die Tribüne', () => {
        const half = regionSeats(g, [{ side: 'S', from: 0, to: 0.5 }]), full = regionSeats(g, [{ side: 'S' }]);
        expect(half.length).toBeGreaterThan(0); expect(half.length).toBeLessThan(full.length);
        expect(half.every((s) => s.u <= 0.5 + 1e-9)).toBe(true);
      });
      it('Blockraster: Zellen ↔ Bereiche (Hin- und Rückweg), Zellen im Gästeblock gesperrt', () => {
        const cells = stadiumCells(g);
        expect(cells.length).toBeGreaterThan(0);
        for (const side of g.sides) expect(Math.max(...cells.filter((c) => c.side === side).map((c) => c.index)) + 1).toBeLessThanOrEqual(blockCount(side));
        expect(cells.some((c) => c.away)).toBe(true);
        const keys = new Set(cells.filter((c) => !c.away && (c.side === 'W' || (c.side === 'S' && c.index < 3))).map((c) => c.key));
        const regions = regionsFromCells(g, keys);
        const back = cellsFromRegions(g, regions);
        expect([...back].sort()).toEqual([...keys].sort());
        // Einzelner Block
        const one = new Set([cells.find((c) => c.side === 'N' && c.index === 2 && c.tier === 'lower')!.key]);
        const r1 = regionsFromCells(g, one);
        expect(r1).toHaveLength(1);
        expect(r1[0]).toMatchObject({ side: 'N', tiers: g.tiers > 1 ? ['lower'] : null });
        expect(r1[0]!.from).toBeCloseTo(2 / 6, 2); expect(r1[0]!.to).toBeCloseTo(3 / 6, 2);
      });
    });
  }

  it('Platzierung freier Elemente: nicht auf dem Spielfeld, nicht im Gästeblock, innerhalb der Tribünen', () => {
    const g = stadiumGeo(30000, { style: 'modern' });
    const rect = (x: number, y: number, w = 10, h = 2, r = 0) => rectCorners(x, y, w, h, r);
    expect(placementProblem(g, rect(50, 74))).toBeNull(); // Haupttribüne
    expect(placementProblem(g, rect(50, 30))).toBe('pitch');
    expect(placementProblem(g, rect(L + 6, 10))).toBe('away');
    expect(placementProblem(g, rect(L + 6, W - 8, 6, 2))).toBeNull(); // Osttribüne unterhalb des Gästeblocks
    expect(placementProblem(g, rect(-6, 30, 2, 12))).toBeNull(); // Heimkurve
    expect(placementProblem(g, rect(200, 30))).toBe('outside');
    expect(isAwayPoint(AWAY_X0 + 1, AWAY_Y1 - 1)).toBe(true);
  });

  it('Stadionausbau: gespeicherte Bereiche bleiben erhalten und passen sich an (Oberrang bleibt außen, Unterrang am Spielfeld)', () => {
    const small = stadiumGeo(15000, { style: 'modern' }), mid = stadiumGeo(30000, { style: 'modern' }), big = stadiumGeo(50000, { style: 'modern' });
    expect([small.tiers, mid.tiers, big.tiers]).toEqual([1, 2, 3]);
    const upper = (g: typeof small) => regionSeats(g, [{ side: 'N', tiers: ['upper'] }]);
    expect(upper(small)).toHaveLength(0); // im kleinen Stadion gibt es keinen Oberrang
    expect(upper(mid).length).toBeGreaterThan(0); expect(upper(big).length).toBeGreaterThan(0);
    // der Oberrang liegt immer am weitesten vom Spielfeld entfernt, der Unterrang am nächsten
    const depth = (g: typeof mid, t: 'lower' | 'upper') => Math.min(...regionSeats(g, [{ side: 'N', tiers: [t] }]).map((x) => -x.seat.y));
    expect(depth(big, 'upper')).toBeGreaterThan(depth(big, 'lower'));
    // Bereiche ohne Rangangabe (alle Ränge) wachsen mit dem Stadion mit
    const all = (g: typeof mid) => regionSeats(g, [{ side: 'W' }]).length;
    expect(all(small)).toBeLessThan(all(mid)); expect(all(mid)).toBeLessThan(all(big));
    // Vorlagen funktionieren vor und nach dem Ausbau
    for (const g of [small, mid, big]) for (const t of TEMPLATES) expect(validateChoreo(t.build({ ...colors, tiers: g.tiers, closed: g.closed }))).toEqual([]);
  });

  it('Zaunbanner liegen am Spielfeldrand und enden am Gästeblock', () => {
    const e = fenceRect('E', 0, 1, 1)!;
    expect(e.y - e.h / 2 + e.w / 2 - 0.01).toBeGreaterThanOrEqual(AWAY_Y1 - 0.5); // Beginn unterhalb des Gästeblocks
    const n = fenceRect('N', 0.1, 0.9, 1)!, s = fenceRect('S', 0.1, 0.9, 1)!;
    expect(n.y).toBeLessThan(0); expect(s.y).toBeGreaterThan(W);
    expect(fenceRect('W', 0, 1, 1)!.x).toBeLessThan(0);
  });
});
