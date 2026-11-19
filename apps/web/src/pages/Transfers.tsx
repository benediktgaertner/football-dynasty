import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { formatEuro } from '../lib/api';
import { estimateSalary, seasonApi, type MarketFilters, type MarketOptions, type MarketPlayer, type TransferOffer, type WindowInfo } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';

const POSITIONS = ['', 'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];
const STATUS: Record<string, string> = { pending: 'Offen', countered: 'Gegenangebot', accepted: 'Angenommen', rejected: 'Abgelehnt', withdrawn: 'Zurückgezogen', expired: 'Erledigt', completed: 'Abgeschlossen' };
const PAGE = 50;

interface UiFilters {
  country: string; league: string; club: string; position: string; search: string; sort: NonNullable<MarketFilters['sort']>;
  minAge: string; maxAge: string; minOverall: string; maxOverall: string; minValue: string; maxValue: string;
}
const DEFAULT_FILTERS: UiFilters = { country: '', league: '', club: '', position: '', search: '', sort: 'overall', minAge: '', maxAge: '', minOverall: '60', maxOverall: '', minValue: '', maxValue: '' };
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
function toApiFilters(f: UiFilters, free: boolean): MarketFilters {
  const mv = (v: string) => { const n = num(v); return n === undefined ? undefined : Math.round(n * 1e6); };
  return {
    country: f.country || undefined, league: free ? undefined : f.league || undefined, club: free ? undefined : f.club || undefined,
    position: f.position || undefined, search: f.search.trim() || undefined, sort: f.sort,
    min_age: num(f.minAge), max_age: num(f.maxAge), min_overall: num(f.minOverall), max_overall: num(f.maxOverall),
    min_value: mv(f.minValue), max_value: mv(f.maxValue), free_agents: free || undefined,
  };
}

const mio = (v: number) => `${(v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mio. €`;

/** H1–H4: Transfermarkt, Free Agents, Verhandlungen, Verkäufe */
export function Transfers() {
  const { worldId = '' } = useParams();
  const [tab, setTab] = useState<'market' | 'free' | 'offers' | 'squad'>('market');
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [filters, setFilters] = useState<UiFilters>(DEFAULT_FILTERS);
  const [players, setPlayers] = useState<MarketPlayer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [options, setOptions] = useState<MarketOptions | null>(null);
  const [europe, setEurope] = useState<{ done: number; total: number; building: boolean } | null>(null);
  const [offers, setOffers] = useState<TransferOffer[]>([]);
  const [squad, setSquad] = useState<MarketPlayer[]>([]);
  const [target, setTarget] = useState<MarketPlayer | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    const s = await seasonApi.matchday(worldId);
    setWin(s.window); setMyClub(s.my_club);
    const f = await seasonApi.finance(worldId).catch(() => null);
    setBalance(f?.balance ?? null);
    setOffers(await seasonApi.myOffers(worldId));
    if (s.my_club) {
      const { data } = await requireSupabase().from('players').select('id, first_name, last_name, age, main_position, overall, market_value, nationality').eq('club_id', s.my_club).order('overall', { ascending: false });
      setSquad((data ?? []).map((p: any) => ({ ...p, club: null, salary: null })));
    }
    return s.my_club;
  }, [worldId]);

  const search = useCallback(async (_club?: string | null, pg = 0, f: UiFilters = filters) => {
    setPlayers(null);
    try {
      const r = await seasonApi.marketSearch(worldId, toApiFilters(f, tab === 'free'), PAGE, pg * PAGE);
      setPlayers(r.rows); setTotal(r.total); setPage(pg);
    } catch (e) { setError((e as Error).message); setPlayers([]); setTotal(0); }
  }, [worldId, filters, tab]);

  useEffect(() => { void loadMeta().then(() => search(null, 0)).catch((e) => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [worldId, tab]);

  // Europaweiter Markt: fehlende Ligen einmalig im Hintergrund anlegen (bestehende Welten werden ergänzt)
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const st = await seasonApi.europeStatus(worldId);
        if (st && st.associations < st.total && st.world_status !== 'lobby') {
          setEurope({ done: st.associations, total: st.total, building: true });
          for (let i = 0; i < 40 && !stop; i++) {
            const r = await seasonApi.ensureEurope(worldId);
            setEurope({ done: r.done, total: r.total, building: !r.finished });
            if (r.finished) break;
          }
          if (!stop) await search(null, 0);
        }
      } catch (e) { if (!stop) { setEurope(null); setError(`Europäischer Markt: ${(e as Error).message}`); } }
      if (!stop) setOptions(await seasonApi.marketOptions(worldId).catch(() => null));
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId]);

  const act = (key: string, fn: () => Promise<{ message?: string; status?: string } | void>) => void (async () => {
    setBusy(key); setError(null); setMsg(null);
    try { const r = await fn(); if (r && r.message) setMsg(r.message); await loadMeta(); if (tab === 'market' || tab === 'free') await search(myClub, page); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  })();

  const openOffers = offers.filter((o) => o.status === 'pending' || o.status === 'countered');

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="display mr-auto text-4xl font-extrabold uppercase">Transfers</h1>
          {win && <Pill tone={win.open ? 'good' : 'warn'}>{win.open ? `Fenster ${win.window_no} offen bis ${win.until_matchday}. Spieltag` : 'Transferfenster geschlossen'}</Pill>}
          {win?.open && <Pill>Neuzugänge {win.signings}/{win.max_signings}</Pill>}
          {win?.open && <Pill>Verkäufe {win.sales}/{win.max_sales}</Pill>}
          {balance !== null && <Pill tone="gold">Konto {formatEuro(balance)}</Pill>}
        </div>
        <p className="mt-2 text-sm text-cream-dim">Fenster: Saisonvorbereitung bis einschließlich 5. Spieltag sowie nach dem 17. bis einschließlich 22. Spieltag. Je Fenster höchstens 5 Neuzugänge (auch Free Agents) und 5 Verkäufe; Kader 16–30 Spieler.</p>
      </Card>
      <nav className="mb-4 flex flex-wrap gap-2">
        {([['market', 'Transfermarkt'], ['free', 'Free Agents'], ['offers', `Verhandlungen${openOffers.length ? ` (${openOffers.length})` : ''}`], ['squad', 'Eigene Spieler']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`display min-h-11 rounded-full px-5 font-semibold uppercase ${tab === k ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>{l}</button>
        ))}
      </nav>
      <div className="mb-3 space-y-2"><ErrorBanner error={error} />{msg && <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">{msg}</div>}</div>

      {europe?.building && (
        <Card className="mb-4">
          <div className="mb-2 font-semibold">Europäischer Transfermarkt wird aufgebaut … {europe.done}/{europe.total} Verbände</div>
          <div className="h-2 overflow-hidden rounded-full bg-olive-800"><div className="h-full bg-gold transition-all" style={{ width: `${(europe.done / Math.max(1, europe.total)) * 100}%` }} /></div>
          <p className="mt-2 text-xs text-cream-dim">Einmalig je Welt: Vereine und Kader aller 55 Verbände entstehen. Deine Karriere, Kader, Transfers und Finanzen bleiben unverändert.</p>
        </Card>
      )}
      {(tab === 'market' || tab === 'free') && (
        <Card>
          <MarketFilterBar filters={filters} options={options} free={tab === 'free'} onChange={setFilters}
            onSearch={(f) => void search(myClub, 0, f)} onReset={() => { setFilters(DEFAULT_FILTERS); void search(myClub, 0, DEFAULT_FILTERS); }} />
          {!players ? <Spinner label="Suche …" /> : (
            <>
              <div className="mb-2 text-sm text-cream-dim">{total.toLocaleString('de-DE')} Spieler gefunden{total > PAGE ? ` · ${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}` : ''}</div>
              <ul className="divide-y divide-olive-700/50">
                {players.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                    <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{p.first_name} {p.last_name}</div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-cream-dim">
                        <span>{p.main_position} · {p.age} J. · {p.nationality}</span>
                        {p.club ? (
                          <span className="inline-flex items-center gap-1">· <span className="inline-block h-2.5 w-2.5 rounded-full border border-cream/30" style={{ background: p.club.color ?? '#555' }} />
                            {p.club.name}{p.club.control === 'human' ? ' (Manager)' : ''}{p.league_name ? ` · ${p.league_name}` : ''}</span>
                        ) : <span>· vereinslos</span>}
                      </div>
                    </div>
                    <span className="display w-10 text-center text-2xl font-bold">{p.overall}</span>
                    <span className="w-28 text-right text-sm">{tab === 'free' ? `${mio(p.salary ?? 0)}/J.` : mio(p.market_value)}</span>
                    <Button variant="secondary" disabled={!win?.open} onClick={() => setTarget(p)}>{tab === 'free' ? 'Verpflichten' : 'Angebot'}</Button>
                  </li>
                ))}
                {players.length === 0 && <li className="py-3 text-cream-dim">Keine Spieler gefunden.</li>}
              </ul>
              {total > PAGE && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <Button variant="ghost" disabled={page === 0} onClick={() => void search(myClub, page - 1)}>Zurück</Button>
                  <span className="text-sm text-cream-dim">Seite {page + 1} von {Math.ceil(total / PAGE)}</span>
                  <Button variant="ghost" disabled={(page + 1) * PAGE >= total} onClick={() => void search(myClub, page + 1)}>Weiter</Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {tab === 'offers' && (
        <Card>
          <ul className="divide-y divide-olive-700/50">
            {offers.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{o.player.name} <span className="text-cream-dim">({o.player.position}, {o.player.overall})</span></div>
                  <div className="text-xs text-cream-dim">{o.direction === 'out' ? `Dein Angebot an ${o.from.name}` : `Angebot von ${o.to.name}`} · Ablöse {mio(o.fee)} · Gehalt {mio(o.salary)}/J. · {o.years} J.</div>
                  {o.status === 'countered' && <div className="text-sm text-gold">Gegenangebot: {o.counter_fee ? `Ablöse ${mio(o.counter_fee)}` : ''}{o.counter_salary ? ` · Gehalt ${mio(o.counter_salary)}/J.` : ''}</div>}
                </div>
                <Pill tone={o.status === 'completed' ? 'good' : o.status === 'pending' || o.status === 'countered' ? 'gold' : 'neutral'}>{STATUS[o.status] ?? o.status}</Pill>
                {o.direction === 'out' && o.status === 'countered' && <Button busy={busy === 'ac' + o.id} onClick={() => act('ac' + o.id, () => seasonApi.acceptCounter(o.id))}>Annehmen</Button>}
                {o.direction === 'out' && (o.status === 'pending' || o.status === 'countered') && <Button variant="ghost" onClick={() => act('w' + o.id, () => seasonApi.withdraw(o.id))}>Zurückziehen</Button>}
                {o.direction === 'in' && o.status === 'pending' && (
                  <>
                    <Button busy={busy === 'acc' + o.id} onClick={() => act('acc' + o.id, () => seasonApi.respond(o.id, 'accept'))}>Annehmen</Button>
                    <Button variant="secondary" onClick={() => { const v = prompt('Geforderte Ablöse in Mio. €', String(Math.round(o.fee / 1e5) / 10 + 1)); if (v) act('c' + o.id, () => seasonApi.respond(o.id, 'counter', Math.round(Number(v.replace(',', '.')) * 1e6))); }}>Gegenangebot</Button>
                    <Button variant="ghost" onClick={() => act('r' + o.id, () => seasonApi.respond(o.id, 'reject'))}>Ablehnen</Button>
                  </>
                )}
              </li>
            ))}
            {offers.length === 0 && <li className="py-3 text-cream-dim">Noch keine Verhandlungen.</li>}
          </ul>
        </Card>
      )}

      {tab === 'squad' && (
        <Card>
          <p className="mb-3 text-sm text-cream-dim">Verkauf an einen KI-Verein: sofortiges Angebot über 85–95 % des Marktwerts. Freistellen: Der Spieler wird Free Agent, du zahlst die Hälfte des Restgehalts als Abfindung.</p>
          <ul className="divide-y divide-olive-700/50">
            {squad.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-10 font-mono text-cream-dim">{p.main_position}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{p.first_name} {p.last_name} <span className="text-cream-dim">({p.age})</span></span>
                <span className="display w-10 text-center text-xl font-bold">{p.overall}</span>
                <span className="w-24 text-right text-sm">{mio(p.market_value)}</span>
                <Button variant="secondary" disabled={!win?.open} busy={busy === 's' + p.id} onClick={() => { if (confirm(`${p.last_name} an einen KI-Verein verkaufen?`)) act('s' + p.id, () => seasonApi.sellToAi(p.id)); }}>An KI verkaufen</Button>
                <Button variant="ghost" disabled={!win?.open} onClick={() => { if (confirm(`${p.last_name} freistellen? Abfindung: halbes Restgehalt.`)) act('r' + p.id, async () => { await seasonApi.release(p.id); }); }}>Freistellen</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {target && (
        <OfferDialog player={target} free={tab === 'free'} onClose={() => setTarget(null)}
          onSubmit={(fee, salary, years) => { const p = target; setTarget(null); act('offer', () => (tab === 'free' ? seasonApi.signFreeAgent(p.id, years) : seasonApi.offer(p.id, fee, salary, years))); }} />
      )}
    </Shell>
  );
}

function OfferDialog({ player, free, onClose, onSubmit }: { player: MarketPlayer; free: boolean; onClose: () => void; onSubmit: (fee: number, salary: number, years: number) => void }) {
  const [fee, setFee] = useState(Math.round(player.market_value / 1e5) / 10);
  const [salary, setSalary] = useState(Math.round((player.salary ?? estimateSalary(player.market_value, player.age)) / 1e4) / 100);
  const [years, setYears] = useState(3);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/60 p-4" onClick={onClose}>
      <Card className="w-full max-w-md" >
        <div onClick={(e) => e.stopPropagation()}>
          <h2 className="display text-2xl font-bold uppercase">{player.first_name} {player.last_name}</h2>
          <p className="text-sm text-cream-dim">{player.main_position} · {player.age} J. · Stärke {player.overall} · Marktwert {mio(player.market_value)}</p>
          <div className="mt-4 space-y-3">
            {!free && <label className="block text-sm">Ablöse (Mio. €)<TextInput type="number" step="0.1" min={0} value={fee} onChange={(e) => setFee(Number(e.target.value))} /></label>}
            {!free && <label className="block text-sm">Jahresgehalt (Mio. €)<TextInput type="number" step="0.05" min={0.05} value={salary} onChange={(e) => setSalary(Number(e.target.value))} /></label>}
            {free && <p className="text-sm">Festes Jahresgehalt: {mio(player.salary ?? 0)} · keine Ablöse</p>}
            <label className="block text-sm">Vertragslaufzeit (Jahre)
              <select value={years} onChange={(e) => setYears(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-olive-600 bg-olive-800 px-3">
                {[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <p className="text-xs text-cream-dim">KI-Vereine verlangen für Stammspieler mehr und machen Gegenangebote. Der Spieler stimmt nur zu, wenn Gehalt, Liga, Vereinsruf und Aussicht auf Einsatzzeit passen.</p>
          </div>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" onClick={() => onSubmit(Math.round(fee * 1e6), Math.round(salary * 1e6), years)}>{free ? 'Verpflichten' : 'Angebot senden'}</Button>
            <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

const SELECT = 'min-h-11 w-full rounded-xl border border-olive-600 bg-olive-800 px-3';

/** Filter: Land, Liga, Verein, Position, Alter, Stärke, Marktwert, Name, Sortierung */
function MarketFilterBar({ filters: f, options, free, onChange, onSearch, onReset }: {
  filters: UiFilters; options: MarketOptions | null; free: boolean;
  onChange: (f: UiFilters) => void; onSearch: (f: UiFilters) => void; onReset: () => void;
}) {
  const set = (patch: Partial<UiFilters>) => onChange({ ...f, ...patch });
  const leagues = (options?.leagues ?? []).filter((l) => !f.country || l.country === f.country);
  const clubs = (options?.clubs ?? []).filter((c) => (!f.country || c.country === f.country) && (!f.league || c.league === f.league));
  return (
    <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); onSearch(f); }}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <select aria-label="Land" value={f.country} onChange={(e) => set({ country: e.target.value, league: '', club: '' })} className={SELECT}>
          <option value="">Alle Länder ({options?.countries.length ?? '…'})</option>
          {(options?.countries ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        {!free && (
          <select aria-label="Liga" value={f.league} onChange={(e) => set({ league: e.target.value, club: '' })} className={SELECT}>
            <option value="">Alle Ligen</option>
            {leagues.map((l) => <option key={l.key} value={l.key}>{l.name}</option>)}
          </select>
        )}
        {!free && (
          <select aria-label="Verein" value={f.club} onChange={(e) => set({ club: e.target.value })} className={SELECT} disabled={!f.country && !f.league}>
            <option value="">{f.country || f.league ? `Alle Vereine (${clubs.length})` : 'Verein: erst Land oder Liga wählen'}</option>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select aria-label="Position" value={f.position} onChange={(e) => set({ position: e.target.value })} className={SELECT}>
          {POSITIONS.map((p) => <option key={p} value={p}>{p || 'Alle Positionen'}</option>)}
        </select>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <TextInput type="number" min={15} max={45} value={f.minAge} onChange={(e) => set({ minAge: e.target.value })} placeholder="Alter von" aria-label="Alter von" />
        <TextInput type="number" min={15} max={45} value={f.maxAge} onChange={(e) => set({ maxAge: e.target.value })} placeholder="Alter bis" aria-label="Alter bis" />
        <TextInput type="number" min={1} max={99} value={f.minOverall} onChange={(e) => set({ minOverall: e.target.value })} placeholder="Stärke von" aria-label="Stärke von" />
        <TextInput type="number" min={1} max={99} value={f.maxOverall} onChange={(e) => set({ maxOverall: e.target.value })} placeholder="Stärke bis" aria-label="Stärke bis" />
        <TextInput type="number" min={0} step="0.1" value={f.minValue} onChange={(e) => set({ minValue: e.target.value })} placeholder="Wert von (Mio.)" aria-label="Marktwert von in Mio." />
        <TextInput type="number" min={0} step="0.1" value={f.maxValue} onChange={(e) => set({ maxValue: e.target.value })} placeholder="Wert bis (Mio.)" aria-label="Marktwert bis in Mio." />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
        <TextInput value={f.search} onChange={(e) => set({ search: e.target.value })} placeholder="Name" aria-label="Name" />
        <select aria-label="Sortierung" value={f.sort} onChange={(e) => set({ sort: e.target.value as UiFilters['sort'] })} className={SELECT}>
          <option value="overall">Stärke</option><option value="value">Marktwert</option><option value="age">Alter (jung zuerst)</option><option value="name">Name</option>
        </select>
        <Button type="submit">Suchen</Button>
        <Button type="button" variant="ghost" onClick={onReset}>Zurücksetzen</Button>
      </div>
    </form>
  );
}
