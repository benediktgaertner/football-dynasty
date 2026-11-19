import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { formatEuro } from '../lib/api';
import { TX_LABEL, seasonApi } from '../lib/seasonApi';

/** I2–I4: Bankkonto, Buchungen, Stadion und Ticketpreise */
export function Finance() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<Awaited<ReturnType<typeof seasonApi.finance>> | null>(null);
  const [prices, setPrices] = useState({ league: 25, cup: 20, intl: 35 });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await seasonApi.finance(worldId);
      setData(d);
      setPrices({ league: d.stadium.ticket_price_league, cup: d.stadium.ticket_price_cup, intl: d.stadium.ticket_price_international });
    } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  const act = (k: string, fn: () => Promise<unknown>, ok: string) => void (async () => {
    setBusy(k); setError(null); setMsg(null);
    try { await fn(); setMsg(ok); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();
  if (!data) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Finanzen werden geladen …" />}</Shell>;
  const totals = Object.entries(data.season_totals).sort((a, b) => b[1] - a[1]);
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <div className="mb-3 space-y-2"><ErrorBanner error={error} />{msg && <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">{msg}</div>}</div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Vereinskonto</p>
          <p className={`display mt-1 text-5xl font-extrabold ${data.balance < 0 ? 'text-danger' : ''}`}>{formatEuro(data.balance)}</p>
          <p className="mt-2 text-sm text-cream-dim">Gehälter: {formatEuro(data.salaries)} pro Jahr ({formatEuro(Math.round(data.salaries / 34))} je Ligaspieltag)</p>
          {data.balance < 0 && <p className="mt-2 text-sm text-danger">Das Konto ist im Minus – Transfers sind erst wieder mit Guthaben möglich.</p>}
        </Card>
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Stadion</p>
          <h2 className="display text-3xl font-bold uppercase">{data.stadium.name}</h2>
          <p className="text-cream-dim">{data.stadium.capacity.toLocaleString('de-DE')} Plätze{data.last_attendance ? ` · zuletzt ${data.last_attendance.attendance.toLocaleString('de-DE')} Zuschauer (${data.last_attendance.label})` : ''}</p>
          <Button className="mt-3 w-full" variant="secondary" disabled={data.status !== 'preseason' || data.stadium.capacity >= 50000} busy={busy === 'x'}
            onClick={() => { if (confirm('Stadion um 5.000 Plätze für 25 Mio. € ausbauen?')) act('x', () => seasonApi.expandStadium(worldId), 'Stadion ausgebaut.'); }}>
            Ausbau +5.000 (25 Mio. €)
          </Button>
          <p className="mt-1 text-xs text-cream-dim">Ausbau nur zum Saisonwechsel (Saisonvorbereitung), maximal 50.000 Plätze. Ein volles großes Stadion gibt mehr Heimvorteil.</p>
        </Card>
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Ticketpreise</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label className="text-sm">Liga<TextInput type="number" min={5} max={500} value={prices.league} onChange={(e) => setPrices({ ...prices, league: Number(e.target.value) })} /></label>
            <label className="text-sm">Pokal<TextInput type="number" min={5} max={500} value={prices.cup} onChange={(e) => setPrices({ ...prices, cup: Number(e.target.value) })} /></label>
            <label className="text-sm">International<TextInput type="number" min={5} max={500} value={prices.intl} onChange={(e) => setPrices({ ...prices, intl: Number(e.target.value) })} /></label>
          </div>
          <Button className="mt-3 w-full" busy={busy === 't'} onClick={() => act('t', () => seasonApi.setTickets(worldId, prices.league, prices.cup, prices.intl), 'Ticketpreise gespeichert.')}>Speichern</Button>
          <p className="mt-1 text-xs text-cream-dim">Die Nachfrage hängt von Preis, Tabellenplatz, Gegner, Spielbedeutung, Liga, Stadiongröße und Ruf ab. Die Zuschauerzahl zeigt sich nach dem Spiel.</p>
        </Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Saisonbilanz</h2>
          <ul className="space-y-1 text-sm">
            {totals.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span>{TX_LABEL[k] ?? k}</span><span className={`tabular-nums ${v < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuro(v)}</span></li>)}
            {totals.length === 0 && <li className="text-cream-dim">Noch keine Buchungen in dieser Saison.</li>}
          </ul>
        </Card>
        <Card className="overflow-x-auto">
          <h2 className="display mb-2 text-2xl font-bold uppercase">Buchungen</h2>
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-left text-xs uppercase text-cream-dim"><tr><th className="py-1">Datum</th><th>Art</th><th>Beschreibung</th><th className="text-right">Betrag</th><th className="text-right">Saldo</th></tr></thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} className="border-t border-olive-700/50">
                  <td className="py-1 text-cream-dim">{new Date(t.created_at).toLocaleDateString('de-DE')}</td>
                  <td><Pill>{TX_LABEL[t.kind] ?? t.kind}</Pill></td>
                  <td className="max-w-xs truncate">{t.description}</td>
                  <td className={`text-right tabular-nums ${t.amount < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuro(t.amount)}</td>
                  <td className="text-right tabular-nums">{formatEuro(t.balance_after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </Shell>
  );
}
