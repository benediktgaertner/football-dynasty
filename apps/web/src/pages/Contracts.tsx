import { contractBarometer, type ContractInputs } from '@fd/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { contractApi, type ContractOverview, type ContractPlayer } from '../lib/contractApi';

const euro = (v: number) => `${Math.round(v).toLocaleString('de-DE')} €`;
const POS: Record<string, string> = { GK: 'TW', CB: 'IV', LB: 'LV', RB: 'RV', LWB: 'LAV', RWB: 'RAV', CDM: 'ZDM', CM: 'ZM', CAM: 'ZOM', LM: 'LM', RM: 'RM', LW: 'LF', RW: 'RF', CF: 'HS', ST: 'ST' };
const tone = (v: number) => (v >= 75 ? '#34d399' : v >= 50 ? '#a3e635' : v >= 25 ? '#f6c453' : '#f87171');

/** Vertragsmanagement & Kaderplanung im Saisonabschluss. Das Barometer ist die Zusagewahrscheinlichkeit (Formel aus @fd/shared). */
export function Contracts() {
  const { worldId = '' } = useParams();
  const [ov, setOv] = useState<ContractOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => { contractApi.overview(worldId).then(setOv).catch((e) => setError((e as Error).message)); }, [worldId]);
  useEffect(() => { load(); }, [load]);

  if (!ov) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Verträge werden geladen …" />}</Shell>;
  const edit = ov.phase.can_edit;
  const y = ov.phase.season_year;
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <Card className="mb-4">
        <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Saison {y}/{String((y + 1) % 100).padStart(2, '0')}</p>
        <h1 className="display text-4xl font-extrabold uppercase leading-none">Vertragsmanagement & Kaderplanung</h1>
        <p className="mt-2 text-sm text-cream-dim">
          {edit ? 'Verhandle Verlängerungen, Gehälter und Laufzeiten, bevor der Saisonabschluss gestartet wird. Änderungen gelten ab der neuen Saison. Reguläre Transfers sind jetzt gesperrt.'
            : ov.phase.active ? 'Der Saisonabschluss läuft bereits.' : 'Verhandlungen sind nur im Saisonabschluss (nach dem letzten Spieltag) möglich. Du siehst den aktuellen Stand.'}
        </p>
        {edit && <p className="mt-1 text-xs text-cream-dim">Ohne Entscheidung wird ein auslaufender Vertrag um ein Jahr zu unveränderten Konditionen verlängert. Spieler über 82 OVR verlassen den Verein nie ablösefrei.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Pill tone="gold">Kader {ov.squad_size} (min. {ov.min_squad})</Pill>
          <Pill>Gehälter jetzt {euro(ov.wage_now)}</Pill>
          <Pill tone={ov.wage_next > ov.wage_now ? 'warn' : 'good'}>Gehälter neue Saison {euro(ov.wage_next)}</Pill>
          <Link to={`/w/${worldId}/spieltag`} className="text-sm font-semibold text-gold underline">Zum Dashboard</Link>
        </div>
        {msg && <p className="mt-2 text-sm text-emerald-300">{msg}</p>}
        <ErrorBanner error={error} />
      </Card>
      <div className="overflow-x-auto rounded-2xl border border-olive-700/80 bg-olive-900/85">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="display text-xs uppercase tracking-wider text-cream-dim">
            <tr><th className="px-3 py-2">Spieler</th><th>Pos.</th><th>Alter</th><th>OVR</th><th>±</th><th>Eins.</th><th>Min.</th><th>Ø</th><th>Gehalt</th><th>Dauer</th><th>Rest</th><th>Ende</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {ov.players.map((p) => (
              <PlayerRow key={p.player_id} p={p} y={y} edit={edit} open={open === p.player_id} onToggle={() => setOpen(open === p.player_id ? null : p.player_id)}
                onChanged={(m) => { setMsg(m); setError(null); load(); }} onError={setError} />
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function PlayerRow({ p, y, edit, open, onToggle, onChanged, onError }: { p: ContractPlayer; y: number; edit: boolean; open: boolean; onToggle: () => void; onChanged: (m: string) => void; onError: (e: string) => void }) {
  const plan = p.plan;
  const status = plan ? (plan.action === 'leave' ? 'Geht zum Saisonwechsel' : `Neu: ${euro(plan.salary ?? 0)} bis ${(plan.end_year ?? 0) + 1}`) : p.expiring ? 'Läuft aus' : '–';
  return (
    <>
      <tr className="border-t border-olive-700/60">
        <td className="px-3 py-2 font-semibold">{p.name}</td><td>{POS[p.position] ?? p.position}</td><td>{p.age}</td>
        <td className="display text-lg font-bold text-gold">{p.overall}</td>
        <td className={p.overall_change > 0 ? 'text-emerald-300' : p.overall_change < 0 ? 'text-red-300' : ''}>{p.overall_change > 0 ? '+' : ''}{p.overall_change}</td>
        <td>{p.appearances}</td><td>{p.minutes}</td><td>{p.rating ?? '–'}</td><td className="tabular-nums">{euro(p.salary)}</td>
        <td>{p.contract_years} J.</td><td>{p.remaining}</td><td>30.06.{p.end_year + 1}</td>
        <td className={plan ? 'text-gold' : p.expiring ? 'text-sunset' : 'text-cream-dim'}>{status}</td>
        <td className="pr-3 text-right"><Button variant="secondary" className="min-h-9 px-3 text-sm" onClick={onToggle}>{open ? 'Schließen' : edit ? 'Verhandeln' : 'Details'}</Button></td>
      </tr>
      {open && <tr className="bg-olive-800/60"><td colSpan={14} className="p-3"><Negotiation p={p} y={y} edit={edit} onChanged={onChanged} onError={onError} /></td></tr>}
    </>
  );
}

function Negotiation({ p, y, edit, onChanged, onError }: { p: ContractPlayer; y: number; edit: boolean; onChanged: (m: string) => void; onError: (e: string) => void }) {
  const [salary, setSalary] = useState<number>(p.plan?.salary ?? p.salary);
  const [years, setYears] = useState<number>(p.plan?.years ?? Math.max(1, Math.min(5, p.remaining || (p.age <= 23 ? 4 : p.age >= 31 ? 2 : 3))));
  const [busy, setBusy] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const bar = useMemo(() => {
    const i: ContractInputs = { ...p.inputs, offeredSalary: salary, years };
    return contractBarometer(i);
  }, [p.inputs, salary, years]);
  const min = Math.max(30000, Math.round(p.salary * 0.4));
  const max = Math.round(2.5 * Math.max(p.salary, p.market_salary));
  const step = Math.max(5000, Math.round(p.salary / 200 / 5000) * 5000);
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setAnswer(null);
    try { const m = await fn(); onChanged(m); setAnswer(m); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };
  const kind = salary < p.salary ? 'Gehaltsreduktion (nur mit Zustimmung des Spielers)' : salary > p.salary ? 'Verlängerung mit Gehaltserhöhung' : 'Verlängerung zu gleichen Konditionen';
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_260px]">
      <div className="space-y-3">
        <p className="text-sm text-cream-dim">Marktwert {euro(p.market_value)} · marktübliches Gehalt {euro(p.market_salary)} · Minutenanteil {p.minutes_share !== null ? `${Math.round(p.minutes_share * 100)} %` : 'unbekannt'}</p>
        {edit ? (
          <div className="rounded-xl bg-anthracite/70 p-3">
            <div className="flex items-baseline justify-between"><span className="text-sm text-cream-dim">Neues Jahresgehalt (ab Saison {y + 1}/{String((y + 2) % 100).padStart(2, '0')})</span><span className="display text-2xl font-bold tabular-nums">{euro(salary)}</span></div>
            <input type="range" className="mt-2 w-full accent-[#e8b14a]" min={min} max={max} step={step} value={Math.min(max, Math.max(min, salary))} onChange={(e) => setSalary(Number(e.target.value))} aria-label="Neues Jahresgehalt" />
            <div className="flex justify-between text-xs text-cream-dim"><span>{euro(min)}</span><span>{euro(max)}</span></div>
            <div className="mt-2 flex items-center gap-2 text-sm"><span className="text-cream-dim">Laufzeit</span>
              {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" onClick={() => setYears(n)} className={`min-h-9 min-w-9 rounded-lg border ${years === n ? 'border-gold bg-gold/15 text-cream' : 'border-olive-600 text-cream-dim'}`}>{n}</button>)}
              <span className="text-cream-dim">Jahre (bis 30.06.{y + years + 1})</span></div>
            <p className="mt-2 text-xs text-cream-dim">{kind}</p>
          </div>
        ) : null}
        {answer && <p className="text-sm text-emerald-300">{answer}</p>}
        {edit && (
          <div className="flex flex-wrap gap-2">
            <Button busy={busy === 'n'} onClick={() => void run('n', async () => { const r = await contractApi.negotiate(p.player_id, salary, years); return r.message; })}>Angebot unterbreiten</Button>
            {p.expiring && !p.elite && !p.plan && <Button variant="secondary" busy={busy === 'l'} onClick={() => void run('l', async () => { await contractApi.setLeave(p.player_id, true); return `${p.name} wird nicht verlängert und geht zum Saisonwechsel.`; })}>Nicht verlängern</Button>}
            {p.plan && <Button variant="ghost" busy={busy === 'c'} onClick={() => void run('c', async () => { await contractApi.setLeave(p.player_id, false); return 'Entscheidung zurückgenommen.'; })}>Entscheidung zurücknehmen</Button>}
            {!p.expiring && !p.elite && <Button variant="danger" busy={busy === 't'} onClick={() => { if (confirm(`Vertrag mit ${p.name} vorzeitig auflösen? Abfindung ${euro(p.termination_fee)}.`)) void run('t', async () => (await contractApi.terminate(p.player_id)).message); }}>Auflösen ({euro(p.termination_fee)})</Button>}
          </div>
        )}
        {p.elite && <p className="text-xs text-cream-dim">Über 82 OVR: wechselt nur gegen Ablöse (Transfermarkt), nie ablösefrei.</p>}
      </div>
      <div className="rounded-xl bg-anthracite/70 p-3 text-center">
        <p className="display text-sm font-semibold uppercase text-cream-dim">Vertragsattraktivität</p>
        <p className="display text-5xl font-extrabold tabular-nums" style={{ color: tone(bar) }}>{bar}<span className="text-lg text-cream-dim"> /100</span></p>
        <span className="mt-1 block h-2 overflow-hidden rounded bg-olive-700"><span className="block h-full" style={{ width: `${bar}%`, background: tone(bar) }} /></span>
        <p className="mt-2 text-xs text-cream-dim">Chance auf Zusage. Berücksichtigt Gehalt, Stärke und Entwicklung, Spielzeit, Leistung, Alter, Marktlage, Laufzeit, Perspektive und Reputation.</p>
      </div>
    </div>
  );
}
