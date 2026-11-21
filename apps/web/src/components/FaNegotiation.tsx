import { faBarometers, type FaModel } from '@fd/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Crest } from './Crest';
import type { ClubRefFull } from './links';
import { Button, Card, ErrorBanner } from './ui';
import { seasonApi, type FaNegotiationState } from '../lib/seasonApi';

const euro = (v: number) => `${Math.round(v).toLocaleString('de-DE')} €`;
const POS: Record<string, string> = { GK: 'TW', CB: 'IV', LB: 'LV', RB: 'RV', LWB: 'LAV', RWB: 'RAV', CDM: 'ZDM', CM: 'ZM', CAM: 'ZOM', LM: 'LM', RM: 'RM', LW: 'LF', RW: 'RF', CF: 'HS', ST: 'ST' };

function tone(v: number) {
  return v >= 75 ? '#34d399' : v >= 50 ? '#a3e635' : v >= 25 ? '#f6c453' : '#f87171';
}

/**
 * Free-Agent-Verhandlung: eigenes Angebot (Gehalt, Laufzeit) mit Live-Barometer und Ranking aller Interessenten.
 * Fremde Gehälter sind nicht abrufbar; das Barometer ist die tatsächliche Verpflichtungswahrscheinlichkeit.
 */
export function FaNegotiation({ playerId, onClose, onChanged }: { playerId: string; onClose: () => void; onChanged?: () => void }) {
  const [st, setSt] = useState<FaNegotiationState | null>(null);
  const [salary, setSalary] = useState<number | null>(null);
  const [years, setYears] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    try {
      const s = await seasonApi.faNegotiation(playerId);
      setSt(s);
      if (initial && s.available) {
        setSalary(s.mine?.salary ?? s.ask);
        setYears(s.mine?.years ?? (s.player.age <= 23 ? 4 : 3));
      }
    } catch (e) { setError((e as Error).message); }
  }, [playerId]);

  // Alle Manager sehen denselben Stand: beim Öffnen laden, danach alle 20 s (nur solange die Ansicht offen ist)
  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 20_000);
    return () => window.clearInterval(t);
  }, [load]);

  const preview = useMemo(() => {
    if (!st?.available || !st.model || salary === null) return null;
    const others = st.board.filter((b) => !b.mine && b.u !== null).map((b) => b.u as number);
    const res = faBarometers(st.model as FaModel, others, salary, st.ask, years);
    const rows: Array<{ club: ClubRefFull; mine: boolean; value: number }> = [
      { club: st.my_club!, mine: true, value: res.mine },
      ...st.board.filter((b) => !b.mine).map((b, i) => ({ club: b.club, mine: false, value: res.others[i] ?? b.barometer })),
    ];
    return rows.sort((a, b) => b.value - a.value);
  }, [st, salary, years]);

  if (!st) return <Overlay onClose={onClose}><Card><p className="text-cream-dim">{error ?? 'Verhandlung wird geladen …'}</p></Card></Overlay>;
  if (!st.available) return <Overlay onClose={onClose}><Card><p>Der Spieler ist nicht mehr vereinslos.</p><Button className="mt-3" onClick={onClose}>Schließen</Button></Card></Overlay>;

  const max = Math.min(st.max_salary, Math.max(st.min_salary, st.budget));
  const rows = preview ?? st.board.map((b) => ({ club: b.club, mine: b.mine, value: b.barometer }));
  const mine = rows.find((r) => r.mine)?.value ?? null;
  const changed = !st.mine || st.mine.salary !== salary || st.mine.years !== years;
  const blocked = !st.window_open ? 'Angebote nur im geöffneten Transferfenster.' : st.limit.used >= st.limit.max ? 'Limit von zwei Free Agents pro Saison erreicht.' : st.budget < st.min_salary ? 'Das verfügbare Budget reicht nicht für ein Angebot.' : null;

  async function submit() {
    if (salary === null) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const s = await seasonApi.faOffer(playerId, Math.round(salary), years);
      setSt(s); setMsg(st?.mine ? 'Angebot verbessert.' : 'Angebot abgegeben.'); onChanged?.();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Overlay onClose={onClose}>
      <Card className="w-full max-w-lg">
        <p className="display text-xs font-semibold uppercase tracking-[0.25em] text-gold">Free Agent · Verhandlung</p>
        <div className="mt-1 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="display truncate text-3xl font-extrabold uppercase leading-tight">{st.player.name}</h2>
            <p className="text-sm text-cream-dim">{st.player.age} Jahre · {POS[st.player.position] ?? st.player.position} · Vertragslos · Forderung {euro(st.ask)}</p>
          </div>
          <div className="text-center"><div className="display text-4xl font-extrabold leading-none text-gold">{st.player.overall}</div><div className="text-[10px] uppercase text-cream-dim">OVR</div></div>
        </div>

        {st.model && salary !== null && (
          <div className="mt-4 rounded-xl bg-anthracite/70 p-3">
            <div className="flex items-baseline justify-between"><span className="text-sm text-cream-dim">Dein Jahresgehalt</span><span className="display text-2xl font-bold tabular-nums">{euro(salary)}</span></div>
            <input type="range" className="mt-2 w-full accent-[#e8b14a]" min={st.min_salary} max={max} step={Math.max(5000, Math.round(st.ask / 200 / 5000) * 5000)}
              value={Math.min(salary, max)} disabled={!!blocked} onChange={(e) => setSalary(Number(e.target.value))} aria-label="Jahresgehalt" />
            <div className="flex justify-between text-xs text-cream-dim"><span>{euro(st.min_salary)}</span><span>{euro(max)}</span></div>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="text-cream-dim">Laufzeit</span>
              {[1, 2, 3, 4, 5].map((y) => (
                <button key={y} type="button" disabled={!!blocked} onClick={() => setYears(y)}
                  className={`min-h-9 min-w-9 rounded-lg border ${years === y ? 'border-gold bg-gold/15 text-cream' : 'border-olive-600 text-cream-dim'}`}>{y}</button>
              ))}
              <span className="text-cream-dim">Jahre</span>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <h3 className="display text-lg font-bold uppercase">Aktuelles Angebotsranking</h3>
          <span className="rounded-lg bg-anthracite px-2 py-1 text-sm">{st.days_left === null ? 'Frist startet mit dem ersten Angebot' : st.days_left > 0 ? `Entscheidung in ${st.days_left} ${st.days_left === 1 ? 'Tag' : 'Tagen'}` : 'Entscheidung heute'}</span>
        </div>
        <ol className="mt-2 space-y-1.5">
          {rows.map((r, i) => (
            <li key={r.club.id} className={`flex items-center gap-3 rounded-lg px-2 py-1.5 ${r.mine ? 'bg-gold/10 ring-1 ring-gold/50' : 'bg-olive-800/60'}`}>
              <span className="w-5 text-right text-sm text-cream-dim">{i + 1}.</span>
              {r.club.crest ? <Crest crest={r.club.crest} size={28} /> : <span className="grid h-8 w-7 place-items-center rounded bg-olive-700 text-xs font-bold">{r.club.short_name?.[0]}</span>}
              <span className="min-w-0 flex-1 truncate">{r.club.name}{r.mine && <span className="ml-2 text-xs text-gold">Dein Angebot{changed && st.mine ? ' (Vorschau)' : !st.mine ? ' (noch nicht abgegeben)' : ''}</span>}</span>
              <span className="h-2 w-20 overflow-hidden rounded bg-olive-700"><span className="block h-full" style={{ width: `${r.value}%`, background: tone(r.value) }} /></span>
              <span className="display w-14 text-right text-lg font-bold tabular-nums" style={{ color: tone(r.value) }}>{r.value}<span className="text-xs text-cream-dim"> /100</span></span>
            </li>
          ))}
          {!rows.length && <li className="text-sm text-cream-dim">Noch kein Interessent.</li>}
        </ol>
        {mine !== null && (
          <p className="mt-3 text-center text-sm text-cream-dim">Deine aktuelle Verpflichtungswahrscheinlichkeit <span className="display ml-1 text-2xl font-bold" style={{ color: tone(mine) }}>{mine} %</span></p>
        )}
        <p className="mt-1 text-center text-xs text-cream-dim">0 keine Chance · 25 gering · 50 realistisch · 75 sehr gut · 100 sichere Zusage. Konkrete Angebote anderer Vereine bleiben vertraulich.</p>
        {blocked && <p className="mt-2 text-sm text-sunset">{blocked}</p>}
        {msg && <p className="mt-2 text-sm text-emerald-300">{msg}</p>}
        <ErrorBanner error={error} />
        <div className="mt-3 flex gap-2">
          <Button className="flex-1" disabled={!!blocked || !changed || salary === null} busy={busy} onClick={() => void submit()}>{st.mine ? 'Angebot verbessern' : 'Angebot abgeben'}</Button>
          <Button variant="ghost" onClick={onClose}>Schließen</Button>
        </div>
      </Card>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-ink/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
