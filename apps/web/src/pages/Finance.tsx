import { StadiumDesigner } from '../components/StadiumDesigner';
import { FinanceDashboard } from '../components/FinanceDashboard';
import { FanShop } from '../components/FanShop';
import { requireSupabase } from '../lib/supabase';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { formatEuro, formatEuroSigned } from '../lib/api';
import { STADIUM_VERDICT, TX_LABEL, seasonApi, type StadiumAttendanceForecast, type StadiumQuote } from '../lib/seasonApi';

/** I2–I4: Bankkonto, Buchungen, Stadion und Ticketpreise */
export function Finance() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<Awaited<ReturnType<typeof seasonApi.finance>> | null>(null);
  const [prices, setPrices] = useState({ league: 25, cup: 20, intl: 35 });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [quote, setQuote] = useState<StadiumQuote | null>(null);
  const [forecast, setForecast] = useState<StadiumAttendanceForecast | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [colors, setColors] = useState<[string, string]>(['#1d4ed8', '#ffffff']);
  useEffect(() => {
    void requireSupabase().from('club_branding').select('primary_color, secondary_color, clubs!inner(world_id, manager_user_id)').eq('clubs.world_id', worldId)
      .then(async ({ data }) => {
        const { data: u } = await requireSupabase().auth.getUser();
        const mine = (data ?? []).find((b: any) => b.clubs?.manager_user_id === u.user?.id) as any;
        if (mine) setColors([mine.primary_color, mine.secondary_color]);
      });
  }, [worldId]);
  const load = useCallback(async () => {
    try {
      const d = await seasonApi.finance(worldId);
      setData(d);
      void seasonApi.stadiumQuote(worldId).then(setQuote).catch(() => setQuote(null));
      setPrices({ league: d.stadium.ticket_price_league, cup: d.stadium.ticket_price_cup, intl: d.stadium.ticket_price_international });
    } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!data || !Number.isInteger(prices.league) || prices.league < 5 || prices.league > 500) { setForecast(null); return; }
    let active = true;
    const timer = setTimeout(() => {
      void seasonApi.stadiumAttendanceForecast(worldId, prices.league).then((result) => {
        if (active) { setForecast(result); setForecastError(null); }
      }).catch((error: unknown) => {
        if (active) { setForecast(null); setForecastError(error instanceof Error ? error.message : 'Prognose nicht verfügbar.'); }
      });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [worldId, prices.league, data]);
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
          <p className="mt-2 text-sm text-cream-dim">Gehälter: {formatEuro(data.salaries)} pro Jahr für {data.squad_size} Spieler ({formatEuro(Math.round(data.salaries / data.league_slots))} je Ligatermin, {data.league_slots} Termine)</p>
          {!data.ledger_ok && <p className="mt-2 text-sm text-danger">Achtung: Kontostand und Buchungen weichen voneinander ab. Bitte melden.</p>}
          {data.balance < 0 && <p className="mt-2 text-sm text-danger">Das Konto ist im Minus – es fallen Kreditzinsen an (Details unten), Transfers sind erst wieder mit Guthaben möglich.</p>}
        </Card>
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Stadion</p>
          <h2 className="display text-3xl font-bold uppercase">{data.stadium.name}</h2>
          <p className="text-cream-dim">{data.stadium.capacity.toLocaleString('de-DE')} Plätze{data.last_attendance ? ` · zuletzt ${data.last_attendance.attendance.toLocaleString('de-DE')} Zuschauer (${data.last_attendance.label})` : ''}</p>
          {quote && !quote.max && quote.cost !== undefined && (
            <div className="mt-3 rounded-xl bg-olive-800 p-3 text-sm" data-testid="stadium-quote">
              <p className="font-semibold">Ausbau auf {quote.next_capacity!.toLocaleString('de-DE')} Plätze: {formatEuro(quote.cost)}</p>
              <p className={quote.verdict === 'not_profitable' || quote.verdict === 'long_term' ? 'text-danger' : 'text-emerald-300'}>{STADIUM_VERDICT[quote.verdict!]}{quote.payback_years ? ` (≈ ${quote.payback_years.toLocaleString('de-DE')} Jahre)` : ''}</p>
              <table className="mt-1 w-full text-xs text-cream-dim"><tbody>
                <tr><td>Zuschauer je Heimspiel</td><td className="text-right">{quote.attendance_now!.toLocaleString('de-DE')} → {quote.attendance_after!.toLocaleString('de-DE')} (Nachfrage {quote.demand!.toLocaleString('de-DE')})</td></tr>
                <tr><td>Auslastung</td><td className="text-right">{quote.utilization_now} % → {quote.utilization_after} %</td></tr>
                <tr><td>Tickets / Jahr</td><td className="text-right">+{formatEuro(quote.annual_tickets!)}</td></tr>
                <tr><td>Gastronomie / Jahr</td><td className="text-right">+{formatEuro(quote.annual_catering!)}</td></tr>
                <tr><td>Fanshop / Jahr</td><td className="text-right">+{formatEuro(quote.annual_merch!)}</td></tr>
                <tr><td>Betrieb & Instandhaltung / Jahr</td><td className="text-right">−{formatEuro(quote.annual_running_extra!)}</td></tr>
                <tr className="font-semibold text-cream"><td>Netto-Ertrag / Jahr</td><td className="text-right">{formatEuroSigned(quote.annual_net!)}</td></tr>
              </tbody></table>
              <p className="mt-1 text-xs text-cream-dim">Prognose bei aktuellen Ticketpreisen, normaler Form und {quote.games} Heimspielen pro Saison. Die Nachfrage ändert sich mit Preis, Tabellenplatz und Ruf.</p>
            </div>
          )}
          <Button className="mt-3 w-full" variant="secondary" disabled={data.status !== 'preseason' || data.stadium.capacity >= 80000} busy={busy === 'x'}
            onClick={() => { if (confirm(`Stadion um 5.000 Plätze für ${formatEuro(quote?.cost ?? 0)} ausbauen?${quote?.verdict ? `\n${STADIUM_VERDICT[quote.verdict]}.` : ''}`)) act('x', () => seasonApi.expandStadium(worldId), 'Stadion ausgebaut.'); }}>
            {data.stadium.capacity >= 80000 ? 'Maximale Größe erreicht (80.000)' : `Ausbau +5.000${quote?.cost ? ` (${formatEuro(quote.cost)})` : ''}`}
          </Button>
          <p className="mt-1 text-xs text-cream-dim">Ausbau nur zum Saisonwechsel (Saisonvorbereitung), maximal 80.000 Plätze. Ein größeres Stadion bringt nur dann mehr Zuschauer, wenn die Nachfrage es füllt.</p>
        </Card>
        <Card>
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Ticketpreise</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <label className="text-sm">Liga<TextInput type="number" min={5} max={500} value={prices.league} onChange={(e) => setPrices({ ...prices, league: Number(e.target.value) })} /></label>
            <label className="text-sm">Pokal<TextInput type="number" min={5} max={500} value={prices.cup} onChange={(e) => setPrices({ ...prices, cup: Number(e.target.value) })} /></label>
            <label className="text-sm">International<TextInput type="number" min={5} max={500} value={prices.intl} onChange={(e) => setPrices({ ...prices, intl: Number(e.target.value) })} /></label>
          </div>
          {data.slot_live && <p className="mt-2 text-xs text-gold">Während eines laufenden Spieltags sind die Preise gesperrt.</p>}
          <Button className="mt-3 w-full" busy={busy === 't'} disabled={data.slot_live} onClick={() => act('t', () => seasonApi.setTickets(worldId, prices.league, prices.cup, prices.intl), 'Ticketpreise gespeichert.')}>Speichern</Button>
          {forecast && forecast.proposed_price === prices.league && (
            <div className="mt-3 rounded-xl bg-olive-800 p-3 text-sm" aria-live="polite">
              <p className="font-semibold">Prognose für ein Ligaspiel</p>
              <p className="mt-1">Ticketpreis {forecast.current_price} € → {forecast.proposed_price} €</p>
              <p>Erwartete Zuschauer {forecast.current_attendance.toLocaleString('de-DE')} → {forecast.proposed_attendance.toLocaleString('de-DE')}</p>
              <p>Auslastung {forecast.current_utilization.toLocaleString('de-DE')} % → {forecast.proposed_utilization.toLocaleString('de-DE')} %</p>
              <p>Nachfrage {forecast.current_demand.toLocaleString('de-DE')} → {forecast.proposed_demand.toLocaleString('de-DE')} Plätze</p>
              <p className="mt-2 text-xs text-cream-dim">Auslastung = Zuschauer ÷ {forecast.capacity.toLocaleString('de-DE')} Plätze. Prognose für Liga {forecast.tier}, Vereinsruf {forecast.reputation}, neutralen Tabellenstand und Gegner mit Ruf 50. Die tatsächliche Zahl hängt zusätzlich vom Tabellenplatz, Gegner, Spielbedeutung und einer spielabhängigen Schwankung von ±3 % ab.</p>
              <p className="mt-1 text-xs text-cream-dim">Ein niedrigerer Preis erhöht die Nachfrage bis zur Preisgrenze. Ein Ausbau erhöht die Kapazität. Liga und Vereinsruf beeinflussen die Nachfrage; die Stadiongröße begrenzt die Zuschauerzahl.</p>
            </div>
          )}
          {forecastError && <p className="mt-2 text-xs text-danger">Prognose: {forecastError}</p>}
        </Card>
      </div>
      <FinanceDashboard worldId={worldId} refreshKey={data.balance} />
      <FanShop worldId={worldId} onChange={() => void load()} />
      <div className="mt-4">
        <StadiumDesigner name={data.stadium.name} capacity={data.stadium.capacity} attendance={data.last_attendance?.attendance ?? null}
          design={data.stadium.design ?? {}} homeColors={colors} worldId={worldId}
          onSave={async (name, design) => { await seasonApi.saveStadiumDesign(worldId, name, design); await load(); }} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Saisonbilanz</h2>
          {data.tickets && data.tickets.games > 0 && (
            <div className="mb-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
              <p className="display text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">Ticketverkäufe</p>
              <p className="display text-3xl font-bold text-emerald-300">{formatEuroSigned(data.tickets.income)}</p>
              <p className="text-xs text-cream-dim">{data.tickets.games} Heimspiele · Ø {data.tickets.avg_attendance.toLocaleString('de-DE')} Zuschauer · Ø {data.tickets.avg_utilization.toLocaleString('de-DE')} % Auslastung</p>
            </div>
          )}
          <ul className="space-y-1 text-sm">
            {totals.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span>{TX_LABEL[k] ?? k}</span><span className={`tabular-nums ${v < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuroSigned(v)}</span></li>)}
            {totals.length === 0 && <li className="text-cream-dim">Noch keine Buchungen in dieser Saison.</li>}
            {totals.length > 0 && <li className="mt-2 flex justify-between gap-2 border-t border-olive-600 pt-2 font-semibold"><span>Saldo der Saison</span><span className={`tabular-nums ${data.season_sum < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuroSigned(data.season_sum)}</span></li>}
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
                  <td className={`whitespace-nowrap text-right font-semibold tabular-nums ${t.amount < 0 ? 'text-danger' : 'text-emerald-300'}`}>{formatEuroSigned(t.amount)}</td>
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
