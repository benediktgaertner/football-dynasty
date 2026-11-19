import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { formatEuro } from '../lib/api';
import { estimateSalary, seasonApi, type MarketPlayer, type TransferOffer, type WindowInfo } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';

const POSITIONS = ['', 'GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];
const STATUS: Record<string, string> = { pending: 'Offen', countered: 'Gegenangebot', accepted: 'Angenommen', rejected: 'Abgelehnt', withdrawn: 'Zurückgezogen', expired: 'Erledigt', completed: 'Abgeschlossen' };
const mio = (v: number) => `${(v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mio. €`;

/** H1–H4: Transfermarkt, Free Agents, Verhandlungen, Verkäufe */
export function Transfers() {
  const { worldId = '' } = useParams();
  const [tab, setTab] = useState<'market' | 'free' | 'offers' | 'squad'>('market');
  const [win, setWin] = useState<WindowInfo | null>(null);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [filters, setFilters] = useState({ position: '', minOverall: 65, maxValue: 0, search: '' });
  const [players, setPlayers] = useState<MarketPlayer[] | null>(null);
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

  const search = useCallback(async (club: string | null) => {
    setPlayers(null);
    try {
      setPlayers(await seasonApi.market(worldId, { ...filters, maxValue: filters.maxValue ? filters.maxValue * 1e6 : undefined, freeAgents: tab === 'free', excludeClub: club }));
    } catch (e) { setError((e as Error).message); setPlayers([]); }
  }, [worldId, filters, tab]);

  useEffect(() => { void loadMeta().then((c) => search(c)).catch((e) => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [worldId, tab]);

  const act = (key: string, fn: () => Promise<{ message?: string; status?: string } | void>) => void (async () => {
    setBusy(key); setError(null); setMsg(null);
    try { const r = await fn(); if (r && r.message) setMsg(r.message); await loadMeta(); if (tab === 'market' || tab === 'free') await search(myClub); }
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

      {(tab === 'market' || tab === 'free') && (
        <Card>
          <div className="mb-3 grid gap-2 sm:grid-cols-5">
            <select value={filters.position} onChange={(e) => setFilters({ ...filters, position: e.target.value })} className="min-h-11 rounded-xl border border-olive-600 bg-olive-800 px-3">
              {POSITIONS.map((p) => <option key={p} value={p}>{p || 'Alle Positionen'}</option>)}
            </select>
            <TextInput type="number" min={40} max={95} value={filters.minOverall} onChange={(e) => setFilters({ ...filters, minOverall: Number(e.target.value) })} placeholder="Mindeststärke" aria-label="Mindeststärke" />
            <TextInput type="number" min={0} value={filters.maxValue || ''} onChange={(e) => setFilters({ ...filters, maxValue: Number(e.target.value) })} placeholder="Max. Wert (Mio.)" aria-label="Maximaler Marktwert in Mio." />
            <TextInput value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="Nachname" aria-label="Nachname" />
            <Button onClick={() => void search(myClub)}>Suchen</Button>
          </div>
          {!players ? <Spinner label="Suche …" /> : (
            <ul className="divide-y divide-olive-700/50">
              {players.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                  <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{p.first_name} {p.last_name}</div>
                    <div className="text-xs text-cream-dim">{p.main_position} · {p.age} J. · {p.nationality}{p.club ? ` · ${p.club.name}${p.club.control === 'human' ? ' (Manager)' : ''}` : ''}</div>
                  </div>
                  <span className="display w-10 text-center text-2xl font-bold">{p.overall}</span>
                  <span className="w-28 text-right text-sm">{tab === 'free' ? `${mio(p.salary ?? 0)}/J.` : mio(p.market_value)}</span>
                  <Button variant="secondary" disabled={!win?.open} onClick={() => setTarget(p)}>{tab === 'free' ? 'Verpflichten' : 'Angebot'}</Button>
                </li>
              ))}
              {players.length === 0 && <li className="py-3 text-cream-dim">Keine Spieler gefunden.</li>}
            </ul>
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
