import { ClubLink, PlayerLink } from '../components/links';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { FaNegotiation } from '../components/FaNegotiation';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { formatEuro } from '../lib/api';
import { estimateSalary, seasonApi, type FaOverview, type Negotiation, type MarketFilters, type MarketOptions, type MarketPlayer, type TransferOffer, type WindowInfo } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';
import { clearMarketState, loadMarketState, saveMarketState } from '../lib/marketState';

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
  const saved = useRef(loadMarketState<UiFilters>(worldId));
  const restoreScroll = useRef<number | null>(saved.current?.scrollY ?? null);
  const [tab, setTab] = useState<'market' | 'free' | 'offers' | 'squad'>((['market', 'free', 'offers', 'squad'] as const).find((t) => t === saved.current?.tab) ?? 'market');
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [filters, setFilters] = useState<UiFilters>(saved.current ? { ...DEFAULT_FILTERS, ...saved.current.filters } : DEFAULT_FILTERS);
  const [players, setPlayers] = useState<MarketPlayer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(saved.current?.page ?? 0);
  const [options, setOptions] = useState<MarketOptions | null>(null);
  const [europe, setEurope] = useState<{ done: number; total: number; building: boolean } | null>(null);
  const [offers, setOffers] = useState<TransferOffer[]>([]);
  const [squad, setSquad] = useState<MarketPlayer[]>([]);
  const [target, setTarget] = useState<MarketPlayer | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [faPlayer, setFaPlayer] = useState<string | null>(null);
  const [faReload, setFaReload] = useState(0);

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
      setPlayers(r.rows); setTotal(r.total); setPage(pg); saved.current = null;
    } catch (e) { setError((e as Error).message); setPlayers([]); setTotal(0); }
  }, [worldId, filters, tab]);

  useEffect(() => {
    const pg = saved.current?.page ?? 0; // gespeicherte Seite nur für die erste Suche nach dem Öffnen
    void loadMeta().then(() => search(null, pg)).catch((e) => setError((e as Error).message));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [worldId, tab]);

  // Ansicht merken (Filter, Seite, Reiter) und Scrollposition nach dem Laden der Ergebnisse wiederherstellen
  useEffect(() => { saveMarketState(worldId, { tab, filters, page, scrollY: window.scrollY }); }, [worldId, tab, filters, page]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => { clearTimeout(t); t = setTimeout(() => saveMarketState(worldId, { tab, filters, page, scrollY: window.scrollY }), 150); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { clearTimeout(t); window.removeEventListener('scroll', onScroll); };
  }, [worldId, tab, filters, page]);
  useEffect(() => {
    if (players && restoreScroll.current !== null) { const y = restoreScroll.current; restoreScroll.current = null; requestAnimationFrame(() => window.scrollTo(0, y)); }
  }, [players]);

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
      {tab === 'free' && <FaPanel worldId={worldId} act={act} reloadKey={`${msg ?? ''}:${faReload}`} onOpen={setFaPlayer} />}
      {(tab === 'market' || tab === 'free') && (
        <Card>
          <MarketFilterBar filters={filters} options={options} free={tab === 'free'} onChange={setFilters}
            onSearch={(f) => void search(myClub, 0, f)} onReset={() => { clearMarketState(worldId); setFilters(DEFAULT_FILTERS); void search(myClub, 0, DEFAULT_FILTERS); }} />
          {!players ? <Spinner label="Suche …" /> : (
            <>
              <div className="mb-2 text-sm text-cream-dim">{total.toLocaleString('de-DE')} Spieler gefunden{total > PAGE ? ` · ${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}` : ''}</div>
              <ul className="divide-y divide-olive-700/50">
                {players.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                    <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold"><PlayerLink id={p.id}>{p.first_name} {p.last_name}</PlayerLink></div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-cream-dim">
                        <span>{p.main_position} · {p.age} J. · {p.nationality}</span>
                        {p.club ? (
                          <span className="inline-flex items-center gap-1">· <span className="inline-block h-2.5 w-2.5 rounded-full border border-cream/30" style={{ background: p.club.color ?? '#555' }} />
                            <ClubLink club={p.club} />{p.club.control === 'human' ? ' (Manager)' : ''}{p.league_name ? ` · ${p.league_name}` : ''}</span>
                        ) : <span>· vereinslos</span>}
                      </div>
                    </div>
                    <span className="display w-10 text-center text-2xl font-bold">{p.overall}</span>
                    <span className="w-28 text-right text-sm">{tab === 'free' ? `${mio(p.salary ?? 0)}/J.` : mio(p.market_value)}</span>
                    <Button variant="secondary" disabled={!win?.open} onClick={() => setTarget(p)}>{tab === 'free' ? 'Bewerben' : 'Angebot'}</Button>
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

      {tab === 'offers' && <NegotiationsPanel worldId={worldId} busy={busy} act={act} reloadKey={offers.length + (msg ?? '')} />}

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

      {target && tab !== 'free' && (
        <OfferDialog player={target} free={false} onClose={() => setTarget(null)}
          onSubmit={(fee, salary, years) => { const p = target; setTarget(null); act('offer', () => seasonApi.offer(p.id, fee, salary, years)); }} />
      )}
      {(faPlayer || (target && tab === 'free')) && (
        <FaNegotiation playerId={faPlayer ?? target!.id} onClose={() => { setTarget(null); setFaPlayer(null); setFaReload((x) => x + 1); }} onChanged={() => setFaReload((x) => x + 1)} />
      )}
    </Shell>
  );
}

function OfferDialog({ player, free, onClose, onSubmit }: { player: MarketPlayer; free: boolean; onClose: () => void; onSubmit: (fee: number, salary: number, years: number) => void }) {
  const [fee, setFee] = useState(Math.round(player.market_value / 1e5) / 10);
  const [salary, setSalary] = useState(Math.round((player.salary ?? estimateSalary(player.overall, player.age)) / 1e4) / 100);
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
            {free && <p className="text-sm">Festes, nicht verhandelbares Jahresgehalt: {mio(player.salary ?? 0)} · keine Ablöse. Der Spieler entscheidet frühestens 7 Tage nach der ersten Interessensbekundung – auch weitere Vereine können sich in dieser Woche bewerben.</p>}
            <label className="block text-sm">Vertragslaufzeit (Jahre)
              <select value={years} onChange={(e) => setYears(Number(e.target.value))} className="mt-1 min-h-11 w-full rounded-xl border border-olive-600 bg-olive-800 px-3">
                {[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            {!free && <p className="text-xs text-cream-dim">Der Verein antwortet sofort mit Annahme, Ablehnung oder Zögern. Beim Zögern folgt frühestens nach einer Woche ein Gegenangebot – höchstens drei Runden in vier Wochen, nur im geöffneten Transferfenster.</p>}
          </div>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" onClick={() => onSubmit(Math.round(fee * 1e6), Math.round(salary * 1e6), years)}>{free ? 'Interesse bekunden' : 'Angebot senden'}</Button>
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

const NSTATUS: Record<string, string> = { pending: 'Verein überlegt', countered: 'Gegenangebot', completed: 'Abgeschlossen', rejected: 'Gescheitert', withdrawn: 'Zurückgezogen', expired: 'Verfallen', accepted: 'Angenommen' };
const ACTION: Record<string, string> = { offer: 'Angebot', hesitate: 'Verein zögert', counter: 'Gegenforderung', rebid: 'Neues Angebot', accept: 'Einigung', reject: 'Abgelehnt', withdraw: 'Ausstieg', salary: 'Gehaltsforderung', failed: 'Abbruch' };
const dm = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '–');

/** Verhandlungen: Status, aktuelle Forderung, bisherige Angebote und nächster Antworttermin */
function NegotiationsPanel({ worldId, busy, act, reloadKey }: { worldId: string; busy: string | null; act: (k: string, fn: () => Promise<{ message?: string } | void>) => void; reloadKey: unknown }) {
  const [rows, setRows] = useState<Negotiation[] | null>(null);
  useEffect(() => { void seasonApi.negotiations(worldId).then(setRows).catch(() => setRows([])); }, [worldId, reloadKey]);
  if (!rows) return <Card><p className="text-cream-dim">Verhandlungen werden geladen …</p></Card>;
  return (
    <Card>
      <ul className="divide-y divide-olive-700/50">
        {rows.map((o) => {
          const open = o.status === 'pending' || o.status === 'countered';
          return (
            <li key={o.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{o.name} <span className="text-cream-dim">({o.position}, OVR {o.overall}, {o.age} J. · Marktwert {mio(o.market_value)})</span></div>
                  <div className="text-xs text-cream-dim">{o.incoming ? `Angebot von ${o.buyer.name}` : `Verhandlung mit ${o.seller?.name ?? '–'}`} · Runde {o.round}/3 · Angebot {mio(o.fee)} · Gehalt {mio(o.salary)}/J.</div>
                  {o.status === 'countered' && <div className="text-sm font-semibold text-gold">Forderung: {o.counter_fee ? `Ablöse ${mio(o.counter_fee)}` : ''}{o.counter_salary ? ` · Gehalt ${mio(o.counter_salary)}/J.` : ''}</div>}
                  {o.status === 'pending' && o.next_response_on && <div className="text-sm text-gold">Antwort spätestens am {dm(o.next_response_on)}</div>}
                  {open && o.deadline_on && <div className="text-xs text-cream-dim">Verhandlungsende: {dm(o.deadline_on)}</div>}
                  {o.note && !open && <div className="text-xs text-cream-dim">{o.note}</div>}
                </div>
                <Pill tone={o.status === 'completed' ? 'good' : open ? 'gold' : 'neutral'}>{NSTATUS[o.status] ?? o.status}</Pill>
                {!o.incoming && o.status === 'countered' && <Button busy={busy === 'ac' + o.id} onClick={() => act('ac' + o.id, () => seasonApi.acceptCounter(o.id))}>Annehmen</Button>}
                {!o.incoming && o.status === 'countered' && o.round < 3 && !o.counter_salary && (
                  <Button variant="secondary" onClick={() => { const v = prompt('Neues Angebot (Ablöse in Mio. €)', String(Math.round(((o.fee + (o.counter_fee ?? o.fee)) / 2) / 1e5) / 10)); if (v) act('rb' + o.id, () => seasonApi.renegotiate(o.id, Math.round(Number(v.replace(',', '.')) * 1e6))); }}>Neu verhandeln</Button>
                )}
                {!o.incoming && open && <Button variant="ghost" onClick={() => act('w' + o.id, () => seasonApi.withdraw(o.id))}>Zurückziehen</Button>}
                {o.incoming && o.status === 'pending' && (
                  <>
                    <Button busy={busy === 'acc' + o.id} onClick={() => act('acc' + o.id, () => seasonApi.respond(o.id, 'accept'))}>Annehmen</Button>
                    <Button variant="secondary" onClick={() => { const v = prompt('Geforderte Ablöse in Mio. €', String(Math.round(o.fee / 1e5) / 10 + 1)); if (v) act('c' + o.id, () => seasonApi.respond(o.id, 'counter', Math.round(Number(v.replace(',', '.')) * 1e6))); }}>Gegenangebot</Button>
                    <Button variant="ghost" onClick={() => act('r' + o.id, () => seasonApi.respond(o.id, 'reject'))}>Ablehnen</Button>
                  </>
                )}
              </div>
              {o.history.length > 0 && (
                <ol className="mt-1 flex flex-wrap gap-1 text-[11px] text-cream-dim">
                  {o.history.map((h, i) => <li key={i} className="rounded bg-olive-800 px-1.5 py-0.5">{dm(h.on)} · {ACTION[h.action] ?? h.action}{h.fee ? ` ${mio(h.fee)}` : ''}</li>)}
                </ol>
              )}
            </li>
          );
        })}
        {rows.length === 0 && <li className="py-3 text-cream-dim">Noch keine Verhandlungen.</li>}
      </ul>
    </Card>
  );
}

/** Free Agents: persönliches Limit, offene Bewerbungen mit Countdown, Entscheidungen (für alle Manager gleich) */
function FaPanel({ worldId, act, reloadKey, onOpen }: { worldId: string; act: (k: string, fn: () => Promise<{ message?: string } | void>) => void; reloadKey: unknown; onOpen: (playerId: string) => void }) {
  const [d, setD] = useState<FaOverview | null>(null);
  useEffect(() => { void seasonApi.faOverview(worldId).then(setD).catch(() => setD(null)); }, [worldId, reloadKey]);
  if (!d) return null;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="display text-xl font-bold uppercase">Free-Agent-Verhandlungen</h2>
        <Pill tone={d.limit.used >= d.limit.max ? 'warn' : 'gold'}>Verpflichtet {d.limit.used}/{d.limit.max} in dieser Saison</Pill>
        {!d.window_open && <Pill tone="warn">Bewerbungen nur im offenen Fenster</Pill>}
      </div>
      <p className="mt-1 text-sm text-cream-dim">Nach dem ersten Angebot entscheidet der Spieler exakt 7 Tage später. Liegt mindestens ein für ihn akzeptables Angebot vor, unterschreibt er. Das Barometer (0–100) ist deine tatsächliche Verpflichtungswahrscheinlichkeit; Gehalt und Laufzeit kannst du bis zur Entscheidung verbessern. Absagen verbrauchen keinen Platz.</p>
      {d.open.length > 0 && (
        <ul className="mt-3 space-y-2">
          {d.open.map((f) => (
            <li key={f.player_id} className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 ${f.mine ? 'bg-gold/10 ring-1 ring-gold/40' : 'bg-olive-800/60'}`}>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{f.name} <span className="text-cream-dim">({f.position}, OVR {f.overall}, {f.age} J.) · {mio(f.salary)}/J.</span></div>
                <div className="text-xs text-cream-dim">Interessenten: {(f.clubs ?? []).map((c) => c.name).join(', ') || '–'}</div>
              </div>
              {f.mine && f.my_barometer != null && <span className="display rounded-lg bg-gold/15 px-2 py-1 text-lg font-bold tabular-nums text-gold" title="Deine Verpflichtungswahrscheinlichkeit">{f.my_barometer}/100</span>}
              <Button variant="secondary" onClick={() => onOpen(f.player_id)}>{f.mine ? 'Verhandeln' : 'Ansehen'}</Button>
              <span className="display rounded-lg bg-anthracite px-3 py-1 text-lg font-bold tabular-nums" title={`Entscheidung am ${dm(f.decision_on)}`}>
                {f.days_left > 0 ? `noch ${f.days_left} ${f.days_left === 1 ? 'Tag' : 'Tage'}` : 'Entscheidung heute'}
              </span>
              {f.mine && f.application_id && <Button variant="ghost" onClick={() => act('fw' + f.player_id, () => seasonApi.withdrawFa(f.application_id!))}>Zurückziehen</Button>}
            </li>
          ))}
        </ul>
      )}
      {d.mine.some((a) => a.status !== 'pending') && (
        <div className="mt-3 text-sm">
          <p className="text-xs uppercase text-cream-dim">Deine Bewerbungen dieser Saison</p>
          <ul className="mt-1 space-y-0.5">
            {d.mine.filter((a) => a.status !== 'pending').map((a) => (
              <li key={a.id}>{a.name}: <span className={a.status === 'signed' ? 'text-emerald-300' : 'text-cream-dim'}>{({ signed: 'unterschrieben', lost: 'anderer Verein', declined: 'abgelehnt', expired: 'verfallen', withdrawn: 'zurückgezogen' } as Record<string, string>)[a.status] ?? a.status}</span>{a.note ? ` – ${a.note}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {d.decisions.length > 0 && (
        <p className="mt-3 text-xs text-cream-dim">Zuletzt entschieden: {d.decisions.slice(0, 4).map((x) => `${x.name} → ${x.club.name}`).join(' · ')}</p>
      )}
    </Card>
  );
}
