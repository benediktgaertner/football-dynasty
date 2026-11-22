import { describe, expect, it } from 'vitest';
import { buildBalanceChart, buildFlowRows, compactEuro, EXPENSE_ORDER, FINANCE_GROUPS, INCOME_ORDER, niceScale, type FinanceTimelinePoint } from './financeReport';

const pt = (x: number, balance: number, extra: Partial<FinanceTimelinePoint> = {}): FinanceTimelinePoint =>
  ({ x, ordinal: Math.floor(x), kind: 'league', label: `Spieltag ${x}`, matchday: x, date: null, balance, delta: 0, count: 1, ...extra });
const BOX = { width: 700, height: 300, left: 60, right: 20, top: 20, bottom: 40 };

describe('Finanzdashboard: Diagrammdaten', () => {
  it('Gruppen: 6 Einnahme- und 5 Ausgabegruppen, alle mit Name und Farbe', () => {
    expect(INCOME_ORDER).toHaveLength(6);
    expect(EXPENSE_ORDER).toHaveLength(5);
    for (const k of [...INCOME_ORDER, ...EXPENSE_ORDER]) { expect(FINANCE_GROUPS[k]!.label.length).toBeGreaterThan(2); expect(FINANCE_GROUPS[k]!.color).toMatch(/^#/); }
    expect(INCOME_ORDER.every((k) => FINANCE_GROUPS[k]!.side === 'income')).toBe(true);
    expect(EXPENSE_ORDER.every((k) => FINANCE_GROUPS[k]!.side === 'expense')).toBe(true);
    expect(FINANCE_GROUPS.contract_termination!.label).toBe('Vertragsauflösungen');
  });
  it('niceScale: runde Schritte, umschließt die Daten', () => {
    const s = niceScale(-1_200_000, 8_300_000);
    expect(s.min).toBeLessThanOrEqual(-1_200_000);
    expect(s.max).toBeGreaterThanOrEqual(8_300_000);
    expect(s.values[0]).toBe(s.min);
    expect(s.values.at(-1)).toBe(s.max);
    expect([1, 2, 5]).toContain(s.step / 10 ** Math.floor(Math.log10(s.step)));
    const flat = niceScale(5, 5);
    expect(flat.max).toBeGreaterThan(flat.min);
  });
  it('compactEuro', () => {
    expect(compactEuro(12_500_000)).toBe('12,5 Mio. €');
    expect(compactEuro(-850_000)).toBe('−850 Tsd. €');
    expect(compactEuro(0)).toBe('0 €');
  });
  it('Kontoverlauf: leer = null, sonst Start links und letzter Punkt = aktueller Stand', () => {
    expect(buildBalanceChart([], 38, BOX)).toBeNull();
    const c = buildBalanceChart([pt(0, 2_000_000, { kind: 'opening' }), pt(1, 2_500_000), pt(2, 2_300_000)], 38, BOX)!;
    expect(c.pts[0]!.px).toBeCloseTo(BOX.left);
    expect(c.pts[2]!.balance).toBe(2_300_000);
    expect(c.pts[2]!.px).toBeGreaterThan(c.pts[1]!.px);
    expect(c.pts[1]!.py).toBeLessThan(c.pts[0]!.py); // höherer Stand = weiter oben
    expect(c.xMax).toBe(38);
    expect(c.line.startsWith('M')).toBe(true);
    expect(c.zeroY).toBeNull();
    for (const p of c.pts) { expect(p.py).toBeGreaterThanOrEqual(BOX.top - 0.01); expect(p.py).toBeLessThanOrEqual(BOX.height - BOX.bottom + 0.01); }
  });
  it('Kontoverlauf: Nulllinie bei negativem Stand', () => {
    const c = buildBalanceChart([pt(0, 1_000_000), pt(1, -500_000)], 10, BOX)!;
    expect(c.zeroY).not.toBeNull();
    expect(c.pts[1]!.py).toBeGreaterThan(c.zeroY!);
  });
  it('Einnahmen/Ausgaben: gemeinsame Skala, fehlende Gruppen = 0', () => {
    const f = buildFlowRows([{ key: 'ticket_sales', side: 'income', amount: 4_000_000, count: 10 }, { key: 'salaries', side: 'expense', amount: 8_000_000, count: 38 }]);
    expect(f.rows).toHaveLength(11);
    expect(f.rows.find((r) => r.key === 'salaries')!.ratio).toBe(1);
    expect(f.rows.find((r) => r.key === 'ticket_sales')!.ratio).toBeCloseTo(0.5);
    expect(f.rows.find((r) => r.key === 'sponsors')!.amount).toBe(0);
    expect(f.rows.map((r) => r.key)).toEqual([...INCOME_ORDER, ...EXPENSE_ORDER]);
  });
});
