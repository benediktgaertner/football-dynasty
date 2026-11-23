import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorBanner, Spinner, TextInput } from './ui';
import { formatEuro, formatEuroSigned } from '../lib/api';
import { seasonApi, type FinanceDebt, type MerchOverview } from '../lib/seasonApi';

/** Fanshop im Finanzbereich: Preise, Lager, Nachbestellung und Auswertung (Daten ausschließlich aus merch_overview). */
export function FanShop({ worldId, onChange }: { worldId: string; onChange?: () => void }) {
  const [ov, setOv] = useState<MerchOverview | null>(null);
  const [debt, setDebt] = useState<FinanceDebt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, { price?: number; qty?: number; target?: number }>>({});
  const load = useCallback(async () => {
    try { const [o, d] = await Promise.all([seasonApi.merchOverview(worldId), seasonApi.financeDebt(worldId)]); setOv(o); setDebt(d); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  const act = (k: string, fn: () => Promise<unknown>) => void (async () => {
    setBusy(k); setError(null);
    try { await fn(); await load(); onChange?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();
  if (!ov) return <Card className="mt-4">{error ? <ErrorBanner error={error} /> : <Spinner label="Fanshop wird geladen …" />}</Card>;
  const best = [...ov.products].sort((a, b) => b.season_units - a.season_units)[0];
  const maxRev = Math.max(1, ...ov.timeline.map((t) => t.revenue));
  return (
    <div className="mt-4 space-y-4" data-testid="fanshop">
      <ErrorBanner error={error} />
      {debt && debt.debt > 0 && (
        <div className="rounded-xl border border-danger/50 bg-danger/10 p-3 text-sm" data-testid="debt-box">
          <p className="display font-semibold uppercase tracking-wide text-danger">Schulden: {formatEuro(debt.debt)}</p>
          <p>Zinsen je Ligaspieltag: <b>{formatEuro(debt.interest_per_matchday)}</b> · in dieser Saison bisher {formatEuro(debt.interest_season)}.</p>
          <p className="text-cream-dim">Staffel pro Jahr: bis 10 Mio. € 6 %, bis 50 Mio. € 11 %, darüber 18 %. Schulden wachsen durch Zinsen weiter; Transfers sind nur mit Guthaben möglich.</p>
        </div>
      )}
      <Card>
        <h2 className="display text-2xl font-bold uppercase">Fanshop</h2>
        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="Umsatz Saison" value={formatEuro(ov.season.revenue)} />
          <Stat label="Gewinn Saison" value={formatEuroSigned(ov.season.profit)} />
          <Stat label="Ø Marge" value={`${ov.season.margin.toLocaleString('de-DE')} %`} />
          <Stat label="Verkauft" value={`${ov.season.units.toLocaleString('de-DE')} Stk.${best && best.season_units > 0 ? ` · Top: ${best.label}` : ''}`} />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-xs uppercase text-cream-dim"><tr><th className="py-1">Produkt</th><th>Preis (Einkauf)</th><th>Marge</th><th>Lager</th><th>Nachbestellen</th><th className="text-right">Saison</th></tr></thead>
            <tbody>
              {ov.products.map((p) => {
                const e = edit[p.key] ?? {};
                return (
                  <tr key={p.key} className="border-t border-olive-700/50 align-middle" data-testid={`merch-${p.key}`}>
                    <td className="py-1 font-semibold">{p.label}{p.reorder_needed && <span className="ml-1 rounded bg-gold/20 px-1 text-xs text-gold">Nachbestellen</span>}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <TextInput type="number" className="w-20" value={e.price ?? p.price} onChange={(x) => setEdit({ ...edit, [p.key]: { ...e, price: Number(x.target.value) } })} />
                        <Button variant="secondary" disabled={ov.slot_live || (e.price ?? p.price) === p.price} busy={busy === `p${p.key}`} onClick={() => act(`p${p.key}`, () => seasonApi.merchSetPrice(worldId, p.key, e.price ?? p.price))}>OK</Button>
                      </div>
                      <span className="text-xs text-cream-dim">Einkauf {p.unit_cost} €</span>
                    </td>
                    <td className={p.margin < 0 ? 'text-danger' : ''}>{p.margin} €</td>
                    <td className="tabular-nums">{p.stock.toLocaleString('de-DE')}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <TextInput type="number" className="w-20" min={1} value={e.qty ?? 500} onChange={(x) => setEdit({ ...edit, [p.key]: { ...e, qty: Number(x.target.value) } })} />
                        <Button variant="secondary" busy={busy === `o${p.key}`} onClick={() => act(`o${p.key}`, () => seasonApi.merchOrder(worldId, p.key, e.qty ?? 500))}>Kaufen</Button>
                      </div>
                      <label className="text-xs text-cream-dim">Auto bis
                        <input type="number" className="ml-1 w-16 rounded bg-olive-800 px-1" min={0} value={e.target ?? p.reorder_target} onChange={(x) => setEdit({ ...edit, [p.key]: { ...e, target: Number(x.target.value) } })}
                          onBlur={() => { if (e.target !== undefined && e.target !== p.reorder_target) act(`r${p.key}`, () => seasonApi.merchSetReorder(worldId, p.key, e.target!)); }} /> Stk.
                      </label>
                    </td>
                    <td className="text-right tabular-nums">{p.season_units.toLocaleString('de-DE')} · {formatEuro(p.season_revenue)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ov.slot_live && <p className="mt-2 text-xs text-gold">Während eines laufenden Spieltags sind die Preise gesperrt.</p>}
        <p className="mt-2 text-xs text-cream-dim">Die Nachfrage hängt von Zuschauern, Stadion, Ruf und Tabellenplatz ab; höhere Preise bringen mehr Marge, aber weniger Verkäufe. Verkauft wird nur aus dem Lager, Einkauf wird sofort bezahlt, Lagerbestand kostet je Spieltag.</p>
      </Card>
      {ov.timeline.length > 0 && (
        <Card>
          <h3 className="display text-lg font-bold uppercase">Umsatz je Spieltermin</h3>
          <div className="mt-2 flex h-28 items-end gap-1" role="img" aria-label="Fanshop-Umsatz je Spieltermin">
            {ov.timeline.map((t) => <div key={t.ordinal} title={`${t.label}: ${formatEuro(t.revenue)} (Gewinn ${formatEuroSigned(t.profit)})`} className={`flex-1 rounded-t ${t.home ? 'bg-emerald-400' : 'bg-sky-400'}`} style={{ height: `${Math.max(3, (t.revenue / maxRev) * 100)}%` }} />)}
          </div>
          <p className="mt-1 text-xs text-cream-dim">Grün: Heimspiel · Blau: Auswärtsspiel</p>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-olive-800 p-2"><p className="text-xs uppercase text-cream-dim">{label}</p><p className="display text-lg font-bold">{value}</p></div>;
}
