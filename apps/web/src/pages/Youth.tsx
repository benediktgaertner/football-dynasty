import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { formatEuro } from '../lib/api';
import { seasonApi, type YouthOverview } from '../lib/seasonApi';

const posLabel = (p: string) => p;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** Jugendabteilung: Ausbau (einmalige Investition, nur in der Vorbereitung) und Jugendspieler (16–19 Jahre) */
export function Youth() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<YouthOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await seasonApi.youth(worldId)); } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  const act = (k: string, fn: () => Promise<unknown>, ok: string) => void (async () => {
    setBusy(k); setError(null); setMsg(null);
    try { await fn(); setMsg(ok); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();
  if (!data) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Jugendabteilung wird geladen …" />}</Shell>;
  const canUpgrade = data.status === 'preseason' && data.upgrade_cost != null && data.balance >= data.upgrade_cost;
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <div className="mb-3 space-y-2"><ErrorBanner error={error} />{msg && <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">{msg}</div>}</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Jugendabteilung</p>
          <p className="display mt-1 text-5xl font-extrabold" data-testid="youth-level">Stufe {data.level}<span className="text-2xl text-cream-dim"> / {data.max_level}</span></p>
          <p className="mt-2 text-sm text-cream-dim">Jedes Jahr kommen {data.intake} neue Talente (16–17 Jahre). Höhere Stufen bringen mehr und bessere Talente.</p>
          <Button className="mt-3 w-full" variant="secondary" disabled={!canUpgrade} busy={busy === 'up'} data-testid="youth-upgrade"
            onClick={() => { if (confirm(`Jugendabteilung auf Stufe ${data.level + 1} für ${formatEuro(data.upgrade_cost ?? 0)} ausbauen?`)) act('up', () => seasonApi.youthUpgrade(worldId), 'Jugendabteilung ausgebaut.'); }}>
            {data.upgrade_cost == null ? 'Höchste Stufe erreicht' : `Ausbau (${formatEuro(data.upgrade_cost)})`}
          </Button>
          {data.upgrade_cost != null && data.status !== 'preseason' && <p className="mt-2 text-sm text-cream-dim">Ausbau ist nur in der Vorbereitung möglich.</p>}
          {data.upgrade_cost != null && data.status === 'preseason' && data.balance < data.upgrade_cost && <p className="mt-2 text-sm text-danger">Nicht genug Guthaben.</p>}
        </Card>
        <Card className="lg:col-span-2">
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Stufen</p>
          <div className="mt-2 grid grid-cols-5 gap-2 text-center text-sm">
            {data.levels.map((l) => (
              <div key={l.level} className={`rounded-xl border px-2 py-3 ${l.level === data.level ? 'border-gold bg-gold/10' : 'border-white/10'}`}>
                <p className="display text-lg font-bold">{l.level}</p>
                <p className="text-cream-dim">{l.intake} Talente</p>
                <p className="text-cream-dim">{l.cost == null ? 'Start' : formatEuro(l.cost)}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-cream-dim">Profikader: {data.squad_size} Spieler. KI-Vereine übernehmen ihre Talente mit 18 automatisch; bei dir entscheidest du – spätestens mit 19 Jahren werden Talente automatisch übernommen, sofern Platz im Kader ist (sonst scheiden sie aus).</p>
        </Card>
      </div>
      <Card className="mt-4">
        <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Jugendspieler ({data.players.length})</p>
        {data.players.length === 0 ? <p className="mt-2 text-cream-dim">Noch keine Jugendspieler. Der erste Jahrgang kommt zum nächsten Saisonwechsel.</p> : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left" data-testid="youth-table">
              <thead className="text-sm text-cream-dim"><tr><th className="py-2">Name</th><th>Alter</th><th>Pos.</th><th>OVR</th><th>Talent</th><th /></tr></thead>
              <tbody>
                {data.players.map((p) => (
                  <tr key={p.id} className="border-t border-white/10">
                    <td className="py-2 font-semibold">{p.name} {p.must_decide && <Pill tone="warn">Entscheidung fällig</Pill>}</td>
                    <td>{p.age}</td><td>{posLabel(p.position)}</td><td>{p.overall}</td>
                    <td className="text-gold" aria-label={`${p.stars} von 5 Sternen`}>{stars(p.stars)}</td>
                    <td className="space-x-2 py-2 text-right">
                      <Button variant="secondary" disabled={p.age < 17} busy={busy === 'p' + p.id}
                        onClick={() => act('p' + p.id, () => seasonApi.youthPromote(p.id), `${p.name} spielt jetzt im Profikader.`)}>In den Kader</Button>
                      <Button variant="ghost" busy={busy === 'r' + p.id}
                        onClick={() => { if (confirm(`${p.name} aus der Jugend entlassen?`)) act('r' + p.id, () => seasonApi.youthRelease(p.id), `${p.name} entlassen.`); }}>Entlassen</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}
