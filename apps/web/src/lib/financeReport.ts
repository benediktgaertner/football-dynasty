/** Finanzdashboard: Typen und reine Hilfsfunktionen für die Diagramme (Daten kommen aus finance_season_report, nichts wird geschätzt). */

export type FinanceSide = 'income' | 'expense';

export interface FinanceGroupRow { key: string; side: FinanceSide; amount: number; count: number }
export interface FinanceTimelinePoint {
  x: number; ordinal: number; kind: string; label: string; matchday: number | null; date: string | null; balance: number; delta: number; count: number;
}
export interface FinanceTop { key: string; side: FinanceSide; amount: number; share: number | null }
export interface FinanceReport {
  club_id: string; season_id: string; current_season_id: string | null; balance: number; empty: boolean; booking_count: number; slot_count: number;
  seasons: Array<{ id: string; year: number; status: string; current: boolean; has_bookings: boolean }>;
  timeline: FinanceTimelinePoint[]; starting_capital: number; groups: FinanceGroupRow[];
  metrics: { income: number; expense: number; saldo: number; salaries: number; transfer_income: number; transfer_spend: number; net_transfer: number; top: FinanceTop[] };
}

/** Anzeigename und Farbe je Gruppe; die Zuordnung der Buchungstypen selbst liegt zentral in der DB (fd_finance_group). */
export const FINANCE_GROUPS: Record<string, { label: string; side: FinanceSide; color: string }> = {
  ticket_sales: { label: 'Tickets & Gastronomie', side: 'income', color: '#34d399' },
  match_bonus: { label: 'Spielprämien', side: 'income', color: '#2dd4bf' },
  sponsors: { label: 'Sponsoren', side: 'income', color: '#60a5fa' },
  merchandising: { label: 'Fanshop', side: 'income', color: '#22d3ee' },
  transfer_sales: { label: 'Transferverkäufe', side: 'income', color: '#a3e635' },
  competition_prizes: { label: 'Wettbewerbsprämien', side: 'income', color: '#fbbf24' },
  other_income: { label: 'Sonstige Einnahmen', side: 'income', color: '#94a3b8' },
  salaries: { label: 'Spielergehälter', side: 'expense', color: '#f87171' },
  transfer_purchases: { label: 'Transferkäufe', side: 'expense', color: '#fb923c' },
  stadium_expansion: { label: 'Stadionausbau', side: 'expense', color: '#c084fc' },
  contract_termination: { label: 'Vertragsauflösungen', side: 'expense', color: '#f472b6' },
  merch_costs: { label: 'Fanshop-Kosten', side: 'expense', color: '#e879f9' },
  interest: { label: 'Kreditzinsen', side: 'expense', color: '#ef4444' },
  other_expense: { label: 'Sonstige Ausgaben', side: 'expense', color: '#94a3b8' },
};
export const INCOME_ORDER = ['ticket_sales', 'match_bonus', 'sponsors', 'merchandising', 'transfer_sales', 'competition_prizes', 'other_income'];
export const EXPENSE_ORDER = ['salaries', 'transfer_purchases', 'stadium_expansion', 'contract_termination', 'merch_costs', 'interest', 'other_expense'];

export function groupLabel(key: string): string { return FINANCE_GROUPS[key]?.label ?? key; }

/** Kompakte Euro-Anzeige für Achsen: 12,5 Mio. €, 850 Tsd. €, 0 € */
export function compactEuro(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio. €`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000).toLocaleString('de-DE')} Tsd. €`;
  return `${sign}${a.toLocaleString('de-DE')} €`;
}

/** Runde Achsenteilung (1/2/5 · 10^n); enthält immer min und max der Daten. */
export function niceScale(dataMin: number, dataMax: number, ticks = 5): { min: number; max: number; step: number; values: number[] } {
  let lo = dataMin;
  let hi = dataMax;
  if (hi === lo) { hi = lo + 1; }
  const raw = (hi - lo) / Math.max(1, ticks);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const values: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) values.push(Math.round(v));
  return { min: lo, max: hi, step, values };
}

export interface ChartBox { width: number; height: number; left: number; right: number; top: number; bottom: number }

/** Pixelpositionen der Kontoverlauf-Linie (Punkte, Linienpfad, Flächenpfad). */
export function buildBalanceChart(timeline: FinanceTimelinePoint[], slotCount: number, box: ChartBox) {
  if (timeline.length === 0) return null;
  const xMax = Math.max(slotCount, ...timeline.map((p) => p.x), 1);
  const scale = niceScale(Math.min(...timeline.map((p) => p.balance)), Math.max(...timeline.map((p) => p.balance)));
  const iw = box.width - box.left - box.right;
  const ih = box.height - box.top - box.bottom;
  const px = (x: number) => box.left + (x / xMax) * iw;
  const py = (v: number) => box.top + (1 - (v - scale.min) / (scale.max - scale.min)) * ih;
  const pts = timeline.map((p) => ({ ...p, px: px(p.x), py: py(p.balance) }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ');
  const baseY = py(Math.max(scale.min, Math.min(0, scale.max)));
  const area = `${line} L${pts[pts.length - 1]!.px.toFixed(1)},${baseY.toFixed(1)} L${pts[0]!.px.toFixed(1)},${baseY.toFixed(1)} Z`;
  const xStep = Math.max(1, Math.ceil(xMax / 10));
  const xTicks: number[] = [];
  for (let v = xStep; v <= xMax; v += xStep) xTicks.push(v);
  return { xMax, scale, px, py, pts, line, area, zeroY: scale.min < 0 && scale.max > 0 ? py(0) : null, xTicks };
}

/** Balkenlängen (0..1) für Einnahmen und Ausgaben auf gemeinsamer Skala; Reihenfolge wie in INCOME_ORDER/EXPENSE_ORDER. */
export function buildFlowRows(groups: FinanceGroupRow[]) {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const rows = [...INCOME_ORDER, ...EXPENSE_ORDER].map((key) => {
    const g = byKey.get(key);
    return { key, label: groupLabel(key), side: FINANCE_GROUPS[key]!.side, color: FINANCE_GROUPS[key]!.color, amount: g?.amount ?? 0, count: g?.count ?? 0 };
  });
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.amount)));
  return { rows: rows.map((r) => ({ ...r, ratio: Math.min(1, Math.abs(r.amount) / max) })), max };
}
