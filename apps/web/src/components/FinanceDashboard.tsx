import { useEffect, useMemo, useState } from 'react';
import { Card, ErrorBanner, Spinner } from './ui';
import { formatEuro, formatEuroSigned } from '../lib/api';
import { seasonApi } from '../lib/seasonApi';
import { buildBalanceChart, buildFlowRows, compactEuro, FINANCE_GROUPS, groupLabel, type FinanceReport, type FinanceTimelinePoint } from '../lib/financeReport';

const BOX = { width: 720, height: 300, left: 74, right: 22, top: 20, bottom: 40 };

/** Finanzdashboard: Kontoverlauf, Einnahmen/Ausgaben und Kennzahlen einer Saison – alles aus tatsächlichen Buchungen. */
export function FinanceDashboard({ worldId, refreshKey }: { worldId: string; refreshKey: number }) {
  const [seasonId, setSeasonId] = useState<string | null>(null);
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setError(null);
    void seasonApi.financeReport(worldId, seasonId)
      .then((r) => { if (alive) setReport(r); })
      .catch((e) => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [worldId, seasonId, refreshKey]);

  if (!report) return <Card>{error ? <ErrorBanner error={error} /> : <Spinner label="Saisonanalyse wird geladen …" />}</Card>;
  const season = report.seasons.find((s) => s.id === report.season_id);
  return (
    <section className="mt-4 space-y-4" aria-label="Saisonanalyse">
      <ErrorBanner error={error} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Saisonanalyse</p>
          <h2 className="display text-3xl font-bold uppercase">Finanzentwicklung{season ? ` ${season.year}/${String((season.year + 1) % 100).padStart(2, '0')}` : ''}</h2>
        </div>
        <label className="text-sm text-cream-dim">
          Saison
          <select className="mt-1 block min-h-11 rounded-xl border border-olive-600 bg-anthracite px-3 text-base text-cream focus:border-gold focus:outline-none"
            value={report.season_id} onChange={(e) => setSeasonId(e.target.value)}>
            {report.seasons.map((s) => <option key={s.id} value={s.id}>{s.year}/{String((s.year + 1) % 100).padStart(2, '0')}{s.current ? ' (laufend)' : ''}</option>)}
          </select>
        </label>
      </div>
      <KpiRow report={report} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card><h3 className="display mb-1 text-xl font-bold uppercase">Entwicklung des Vereinskontos</h3><BalanceChart report={report} /></Card>
        <Card><h3 className="display mb-1 text-xl font-bold uppercase">Einnahmen und Ausgaben</h3><FlowChart report={report} /></Card>
      </div>
      <TopFactors report={report} />
    </section>
  );
}

function Empty({ text = 'Für diese Saison liegen noch keine Buchungen vor.' }: { text?: string }) {
  return <p className="rounded-xl border border-dashed border-olive-600 p-6 text-center text-cream-dim">{text}</p>;
}

function Kpi({ label, value, tone, hint }: { label: string; value: string; tone?: 'good' | 'bad'; hint?: string }) {
  return (
    <div className="rounded-xl border border-olive-700/80 bg-olive-900/85 p-3">
      <p className="display text-xs font-semibold uppercase tracking-[0.15em] text-cream-dim">{label}</p>
      <p className={`display mt-1 text-2xl font-bold tabular-nums ${tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-danger' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-cream-dim">{hint}</p>}
    </div>
  );
}

function KpiRow({ report }: { report: FinanceReport }) {
  const m = report.metrics;
  const e = report.empty;
  const dash = '–';
  const tone = (v: number) => (e ? undefined : v < 0 ? 'bad' as const : v > 0 ? 'good' as const : undefined);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Kpi label="Einnahmen" value={e ? dash : formatEuro(m.income)} />
      <Kpi label="Ausgaben" value={e ? dash : formatEuro(m.expense)} />
      <Kpi label="Saisonsaldo" value={e ? dash : formatEuroSigned(m.saldo)} tone={tone(m.saldo)} hint="Einnahmen − Ausgaben" />
      <Kpi label="Gehaltskosten" value={e ? dash : formatEuro(m.salaries)} hint={!e && m.expense > 0 ? `${Math.round((m.salaries / m.expense) * 100)} % der Ausgaben` : undefined} />
      <Kpi label="Netto-Transferbilanz" value={e ? dash : formatEuroSigned(m.net_transfer)} tone={tone(m.net_transfer)} hint={e ? undefined : `Verkäufe ${formatEuro(m.transfer_income)} · Käufe ${formatEuro(m.transfer_spend)}`} />
    </div>
  );
}

function fmtDate(d: string | null): string { return d ? new Date(`${d}T12:00:00`).toLocaleDateString('de-DE') : ''; }
function pointTitle(p: FinanceTimelinePoint): string {
  if (p.kind === 'opening') return p.label;
  return p.kind === 'league' && p.matchday ? `${p.matchday}. Spieltag` : p.label;
}

function BalanceChart({ report }: { report: FinanceReport }) {
  const chart = useMemo(() => buildBalanceChart(report.timeline, report.slot_count, BOX), [report]);
  const [hover, setHover] = useState<number | null>(null);
  if (!chart) return <Empty />;
  const last = chart.pts[chart.pts.length - 1]!;
  const first = chart.pts[0]!;
  const hp = hover !== null ? chart.pts[hover] ?? null : null;
  const onMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * BOX.width;
    let best = 0;
    chart.pts.forEach((p, i) => { if (Math.abs(p.px - x) < Math.abs(chart.pts[best]!.px - x)) best = i; });
    setHover(best);
  };
  const current = report.season_id === report.current_season_id;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} className="w-full touch-pan-y select-none" role="img"
        aria-label={`Kontoverlauf: Start ${formatEuro(first.balance)}, Ende ${formatEuro(last.balance)}`}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="fd-bal-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--fd-accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--fd-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {chart.scale.values.map((v) => (
          <g key={v}>
            <line x1={BOX.left} x2={BOX.width - BOX.right} y1={chart.py(v)} y2={chart.py(v)} stroke="var(--color-olive-700)" strokeWidth="1" strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={BOX.left - 8} y={chart.py(v) + 4} textAnchor="end" fontSize="12" fill="var(--color-cream-dim)">{compactEuro(v)}</text>
          </g>
        ))}
        {chart.zeroY !== null && <line x1={BOX.left} x2={BOX.width - BOX.right} y1={chart.zeroY} y2={chart.zeroY} stroke="var(--color-danger)" strokeOpacity="0.7" strokeWidth="1.2" />}
        {chart.xTicks.map((v) => (
          <text key={v} x={chart.px(v)} y={BOX.height - BOX.bottom + 18} textAnchor="middle" fontSize="12" fill="var(--color-cream-dim)">{v}</text>
        ))}
        <text x={BOX.left + (BOX.width - BOX.left - BOX.right) / 2} y={BOX.height - 6} textAnchor="middle" fontSize="12" fill="var(--color-cream-dim)">Saisontermine (Spieltage und Pokalrunden)</text>
        <path d={chart.area} fill="url(#fd-bal-area)" />
        <path d={chart.line} fill="none" stroke="var(--fd-accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {hp && <line x1={hp.px} x2={hp.px} y1={BOX.top} y2={BOX.height - BOX.bottom} stroke="var(--color-cream-dim)" strokeOpacity="0.5" strokeDasharray="2 3" />}
        <circle cx={first.px} cy={first.py} r="5" fill="var(--color-anthracite)" stroke="var(--color-cream)" strokeWidth="2" />
        {hp && hover !== 0 && hover !== chart.pts.length - 1 && <circle cx={hp.px} cy={hp.py} r="4.5" fill="var(--fd-accent)" stroke="var(--color-cream)" strokeWidth="1.5" />}
        <circle cx={last.px} cy={last.py} r="7" fill="var(--fd-accent)" stroke="var(--color-cream)" strokeWidth="2.5" />
        <text x={Math.min(last.px, BOX.width - BOX.right - 4)} y={Math.max(last.py - 14, 12)} textAnchor={last.px > BOX.width - 140 ? 'end' : 'middle'} fontSize="13" fontWeight="700" fill="var(--color-cream)">{formatEuro(last.balance)}</text>
      </svg>
      {hp && (
        <div className="pointer-events-none absolute z-10 w-52 rounded-xl border border-olive-600 bg-ink/95 p-2 text-xs shadow-xl"
          style={{ left: `${Math.min(Math.max((hp.px / BOX.width) * 100, 14), 86)}%`, top: 0, transform: 'translateX(-50%)' }}>
          <p className="font-semibold">{pointTitle(hp)}{hp.date ? ` · ${fmtDate(hp.date)}` : ''}</p>
          <p className="tabular-nums">Kontostand {formatEuro(hp.balance)}</p>
          {hp.kind !== 'opening' && <p className={`tabular-nums ${hp.delta < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuroSigned(hp.delta)} ({hp.count} {hp.count === 1 ? 'Buchung' : 'Buchungen'})</p>}
        </div>
      )}
      <p className="mt-1 text-xs text-cream-dim">
        {first.kind === 'opening' ? `${first.label}: ${formatEuro(first.balance)}` : ''} · {current ? 'aktueller Kontostand' : 'Stand am Saisonende'}: <span className="font-semibold text-cream">{formatEuro(last.balance)}</span>.
        Buchungen ohne Spieltag (z. B. Transfers) erscheinen beim zuletzt gebuchten Termin.
      </p>
    </div>
  );
}

function FlowChart({ report }: { report: FinanceReport }) {
  const { rows, max } = useMemo(() => buildFlowRows(report.groups), [report]);
  const [hover, setHover] = useState<string | null>(null);
  if (report.empty) return <Empty />;
  const W = 640, labelW = 170, barW = W - labelW - 110, rowH = 30;
  const headerH = 26;
  const income = rows.filter((r) => r.side === 'income');
  const expense = rows.filter((r) => r.side === 'expense');
  const H = headerH * 2 + rowH * rows.length + 8;
  const section = (title: string, list: typeof rows, y0: number, total: number) => (
    <g>
      <text x={0} y={y0 + 16} fontSize="13" fontWeight="700" fill="var(--color-cream)" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</text>
      <text x={W} y={y0 + 16} textAnchor="end" fontSize="13" fontWeight="700" fill="var(--color-cream)">{formatEuro(total)}</text>
      {list.map((r, i) => {
        const y = y0 + headerH + i * rowH;
        const w = Math.max(r.amount !== 0 ? 3 : 0, r.ratio * barW);
        return (
          <g key={r.key} onPointerEnter={() => setHover(r.key)} onPointerDown={() => setHover(r.key)} onPointerLeave={() => setHover(null)} opacity={hover && hover !== r.key ? 0.55 : 1}>
            <rect x={0} y={y} width={W} height={rowH} fill="transparent" />
            <text x={0} y={y + 19} fontSize="13" fill="var(--color-cream-dim)">{r.label}</text>
            <rect x={labelW} y={y + 6} width={barW} height={rowH - 12} rx="4" fill="var(--color-olive-800)" />
            <rect x={labelW} y={y + 6} width={w} height={rowH - 12} rx="4" fill={r.color} />
            <text x={W} y={y + 19} textAnchor="end" fontSize="13" className="tabular-nums" fill={r.amount === 0 ? 'var(--color-cream-dim)' : 'var(--color-cream)'}>{formatEuro(r.amount)}</text>
          </g>
        );
      })}
    </g>
  );
  const hr = rows.find((r) => r.key === hover);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" role="img" aria-label="Einnahmen und Ausgaben nach Gruppen">
        {section('Einnahmen', income, 0, report.metrics.income)}
        {section('Ausgaben', expense, headerH + rowH * income.length + 8, report.metrics.expense)}
      </svg>
      <p className="mt-1 min-h-4 text-xs text-cream-dim">
        {hr ? `${hr.label}: ${formatEuro(hr.amount)} aus ${hr.count} ${hr.count === 1 ? 'Buchung' : 'Buchungen'}${hr.amount ? ` · ${Math.round((Math.abs(hr.amount) / max) * 100)} % des größten Postens` : ''}` : 'Balken auf gemeinsamer Skala; Antippen zeigt Details.'}
      </p>
    </div>
  );
}

function TopFactors({ report }: { report: FinanceReport }) {
  const top = report.metrics.top;
  return (
    <Card>
      <h3 className="display mb-2 text-xl font-bold uppercase">Wichtigste Einflussfaktoren</h3>
      {top.length === 0 ? <Empty text="Noch keine Einnahmen oder Ausgaben in dieser Saison." /> : (
        <ul className="grid gap-3 md:grid-cols-3">
          {top.map((t, i) => (
            <li key={t.key} className="rounded-xl border border-olive-700/80 p-3">
              <p className="flex items-center gap-2 text-sm text-cream-dim"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: FINANCE_GROUPS[t.key]?.color }} aria-hidden />{i + 1}. {groupLabel(t.key)}</p>
              <p className={`display text-2xl font-bold tabular-nums ${t.side === 'income' ? 'text-emerald-300' : 'text-danger'}`}>{t.side === 'income' ? '+' : '−'}{formatEuro(t.amount)}</p>
              <p className="text-xs text-cream-dim">{t.share !== null ? `${t.share.toLocaleString('de-DE')} % aller ${t.side === 'income' ? 'Einnahmen' : 'Ausgaben'}` : ''}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
