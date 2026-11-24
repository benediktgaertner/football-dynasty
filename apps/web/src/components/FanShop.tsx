import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorBanner, Spinner, TextInput } from './ui';
import { formatEuro, formatEuroSigned } from '../lib/api';
import type { CrestConfig } from '@fd/shared';
import { MerchPreview } from './MerchPreview';
import { MERCH_PALETTE, MERCH_PATTERNS, PRODUCT_FAMILY, effectiveDesign, type ClubColors, type MerchDesign } from '../lib/merchDesign';
import { requireSupabase } from '../lib/supabase';
import { seasonApi, type FinanceDebt, type MerchOverview, type MerchProduct } from '../lib/seasonApi';

/** Fanshop im Finanzbereich: Preise, Lager, Nachbestellung und Auswertung (Daten ausschließlich aus merch_overview). */
export function FanShop({ worldId, onChange }: { worldId: string; onChange?: () => void }) {
  const [ov, setOv] = useState<MerchOverview | null>(null);
  const [debt, setDebt] = useState<FinanceDebt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, { price?: number; qty?: number; target?: number }>>({});
  const [club, setClub] = useState<{ colors: ClubColors; crest: CrestConfig | null }>({ colors: { primary: '#1d4ed8', secondary: '#ffffff', accent: '#f2c14e' }, crest: null });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<MerchDesign | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const sb = requireSupabase();
        const { data: u } = await sb.auth.getUser();
        const { data } = await sb.from('club_branding').select('primary_color, secondary_color, accent_color, crest, kit, clubs!inner(world_id, manager_user_id)').eq('clubs.world_id', worldId);
        const mine = (data ?? []).find((b: any) => b.clubs?.manager_user_id === u.user?.id) as any;
        if (mine) setClub({ colors: { primary: mine.primary_color, secondary: mine.secondary_color, accent: mine.accent_color, kitPattern: mine.kit?.pattern }, crest: mine.crest ?? null });
      } catch { /* Vorschau bleibt in Standardfarben */ }
    })();
  }, [worldId]);
  const openEditor = (p: MerchProduct) => { setEditing(p.key); setDraft(effectiveDesign(p.key, p.design, club.colors)); };
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
                    <td className="py-1 font-semibold">
                      <div className="flex items-center gap-2">
                        <MerchPreview product={p.key} design={effectiveDesign(p.key, p.design, club.colors)} crest={club.crest} size={44} label={`${p.label} (Vorschau)`} />
                        <div>{p.label}{p.reorder_needed && <span className="ml-1 rounded bg-gold/20 px-1 text-xs text-gold">Nachbestellen</span>}
                          <div><button type="button" className="text-xs font-normal text-gold underline" data-testid={`merch-design-${p.key}`} onClick={() => openEditor(p)}>Design anpassen</button></div></div>
                      </div>
                    </td>
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
      {editing && draft && (() => {
        const prod = ov.products.find((x) => x.key === editing)!;
        const fam = PRODUCT_FAMILY[editing] ?? 'jersey';
        const swatches = [...new Set([club.colors.primary, club.colors.secondary, club.colors.accent, ...MERCH_PALETTE])];
        const set = (patch: Partial<MerchDesign>) => setDraft({ ...draft, ...patch });
        const colorRow = (label: string, key: 'c1' | 'c2' | 'c3') => (
          <div key={key} className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-sm">{label}</span>
            <input type="color" aria-label={label} value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} className="h-11 w-14 rounded-lg border border-olive-600 bg-olive-800" data-testid={`merch-color-${key}`} />
            <div className="flex flex-wrap gap-1">{swatches.map((c) => <button key={c} type="button" aria-label={`${label} ${c}`} onClick={() => set({ [key]: c })} className={`h-8 w-8 rounded-full border-2 ${draft[key].toLowerCase() === c.toLowerCase() ? 'border-gold' : 'border-olive-600'}`} style={{ background: c }} />)}</div>
          </div>
        );
        return (
          <Card data-testid="merch-editor">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="display text-lg font-bold uppercase">Design: {prod.label}</h3>
              <button type="button" className="text-sm text-cream-dim underline" onClick={() => { setEditing(null); setDraft(null); }}>Schließen</button>
            </div>
            <div className="mt-3 grid gap-4 md:grid-cols-[200px_1fr]">
              <div className="flex flex-col items-center gap-2 rounded-xl bg-olive-800 p-3">
                <MerchPreview product={editing} design={draft} crest={club.crest} size={176} label={`${prod.label} – Live-Vorschau`} />
                <p className="text-center text-xs text-cream-dim">Live-Vorschau. Das Design ist kostenlos und ändert weder Nachfrage noch Preis oder Erlös.</p>
              </div>
              <div className="space-y-3">
                <div>
                  <p className="mb-1 text-sm font-semibold">Muster</p>
                  <div className="flex flex-wrap gap-2">
                    {MERCH_PATTERNS[fam].map((pt) => (
                      <button key={pt.key} type="button" data-testid={`merch-pattern-${pt.key}`} aria-pressed={draft.pattern === pt.key} onClick={() => set({ pattern: pt.key })}
                        className={`min-h-11 rounded-xl border px-3 text-sm ${draft.pattern === pt.key ? 'border-gold bg-gold/20 text-gold' : 'border-olive-600 bg-olive-800'}`}>{pt.label}</button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">{colorRow('Hauptfarbe', 'c1')}{colorRow('Zweitfarbe', 'c2')}{colorRow('Akzent', 'c3')}</div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={draft.crest} onChange={(e) => set({ crest: e.target.checked })} data-testid="merch-crest" /> Vereinslogo</label>
                  <label className="flex items-center gap-2 text-sm">Aufdruck
                    <TextInput value={draft.text} maxLength={16} placeholder="z. B. Ultras 1904" data-testid="merch-text" onChange={(e) => set({ text: e.target.value.replace(/[^A-Za-zÄÖÜäöüß0-9 .!&-]/g, '') })} /></label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button busy={busy === 'design'} onClick={() => act('design', async () => { await seasonApi.merchSetDesign(worldId, editing, draft); setEditing(null); setDraft(null); })}>Design speichern</Button>
                  <Button variant="secondary" onClick={() => setDraft(effectiveDesign(editing, null, club.colors))}>Auf Vereinsfarben zurücksetzen</Button>
                </div>
              </div>
            </div>
          </Card>
        );
      })()}
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
