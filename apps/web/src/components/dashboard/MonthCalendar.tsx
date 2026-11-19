import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClubLogo } from '../links';
import { Card } from '../ui';
import { seasonApi, type CalendarFixture } from '../../lib/seasonApi';

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Farbcode je Wettbewerb: Liga = Akzent, Pokal = Gold, Europapokal = Violett, Test = Grau */
function kindStyle(kind: string): { cls: string; label: string } {
  if (kind === 'league') return { cls: 'border-gold/70 bg-gold/10', label: 'Liga' };
  if (kind === 'friendly') return { cls: 'border-olive-600 bg-olive-800/60', label: 'Test' };
  if (/champions|europa|continental/.test(kind)) return { cls: 'border-violet-400/70 bg-violet-500/10', label: 'Europa' };
  return { cls: 'border-amber-400/70 bg-amber-500/10', label: 'Pokal' };
}

/**
 * Monatskalender auf dem Dashboard (vorhandene Spielplandaten): Gegnerlogo, Kürzel, H/A,
 * Wettbewerb farblich, Klick öffnet die Spielvorschau. Darunter die nächsten drei Spiele.
 */
export function MonthCalendar({ worldId }: { worldId: string }) {
  const navigate = useNavigate();
  const [data, setData] = useState<{ today: string; fixtures: CalendarFixture[] } | null>(null);
  const [month, setMonth] = useState<Date | null>(null);
  useEffect(() => {
    void seasonApi.seasonCalendar(worldId).then((d) => {
      setData(d);
      const t = new Date(`${d.today}T12:00:00`);
      setMonth((m) => m ?? new Date(t.getFullYear(), t.getMonth(), 1));
    }).catch(() => setData({ today: iso(new Date()), fixtures: [] }));
  }, [worldId]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarFixture[]>();
    for (const f of data?.fixtures ?? []) m.set(f.date, [...(m.get(f.date) ?? []), f]);
    return m;
  }, [data]);
  if (!data || !month) return <Card><p className="text-sm text-cream-dim">Kalender wird geladen …</p></Card>;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = [...Array(offset).fill(null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1))];
  while (cells.length % 7) cells.push(null);
  const next3 = data.fixtures.filter((f) => f.status === 'scheduled' || f.status === 'live').slice(0, 3);
  const open = (f: CalendarFixture) => navigate(`/w/${worldId}/match/${f.id}`);
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="display text-xl font-bold uppercase">Kalender</h2>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="Vorheriger Monat" className="grid h-9 w-9 place-items-center rounded-lg bg-olive-800 text-lg hover:bg-olive-700" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
          <span className="display w-32 text-center text-lg font-semibold">{MONTHS[month.getMonth()]} {month.getFullYear()}</span>
          <button type="button" aria-label="Nächster Monat" className="grid h-9 w-9 place-items-center rounded-lg bg-olive-800 text-lg hover:bg-olive-700" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] uppercase tracking-wide text-cream-dim">{WD.map((d) => <span key={d}>{d}</span>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="aspect-square" />;
          const key = iso(d);
          const fx = byDay.get(key) ?? [];
          const today = key === data.today;
          const f = fx[0];
          const st = f ? kindStyle(f.kind) : null;
          return (
            <button key={i} type="button" disabled={!f} onClick={() => f && open(f)}
              title={f ? `${st!.label}: ${f.home ? 'Heim' : 'Auswärts'} gegen ${f.opponent.name}${f.gf != null ? ` (${f.gf}:${f.ga})` : ''}` : undefined}
              className={`relative flex aspect-square min-h-11 flex-col items-center justify-between rounded-lg border p-0.5 text-xs ${f ? `${st!.cls} hover:brightness-125` : 'border-transparent text-cream-dim/70'} ${today ? 'ring-2 ring-cream/80' : ''}`}>
              <span className={`self-start pl-0.5 text-[10px] tabular-nums ${today ? 'font-bold text-cream' : ''}`}>{d.getDate()}</span>
              {f && (
                <>
                  <ClubLogo club={f.opponent} size={18} />
                  <span className="text-[10px] font-semibold leading-none">{f.opponent.short_name} <span className="text-cream-dim">{f.home ? 'H' : 'A'}</span></span>
                  {f.gf != null && <span className={`absolute right-0.5 top-0.5 rounded px-0.5 text-[9px] font-bold ${f.gf > f.ga! ? 'bg-emerald-600' : f.gf < f.ga! ? 'bg-danger' : 'bg-olive-600'}`}>{f.gf}:{f.ga}</span>}
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-cream-dim">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-gold" />Liga</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400" />Pokal</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-400" />Europapokal</span>
        <span>H = Heim · A = Auswärts</span>
      </div>
      {next3.length > 0 && (
        <>
          <p className="mt-3 text-xs uppercase text-cream-dim">Nächste Spiele</p>
          <ul className="mt-1 space-y-1 text-sm">
            {next3.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => open(f)} className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-olive-800">
                  <span className="w-12 shrink-0 text-xs text-cream-dim">{new Date(`${f.date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
                  <span className="w-4 text-xs font-bold text-cream-dim">{f.home ? 'H' : 'A'}</span>
                  <ClubLogo club={f.opponent} size={18} />
                  <span className="min-w-0 flex-1 truncate">{f.opponent.name}</span>
                  <span className="text-[11px] text-cream-dim">{kindStyle(f.kind).label}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
