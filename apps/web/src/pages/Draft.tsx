import { READINESS_TIMEOUT_SECONDS } from '@fd/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, draftApi, fetchPool, fetchSquad, formatEuro, type DraftState, type PoolPlayer } from '../lib/api';
import { requireSupabase } from '../lib/supabase';
import { Crest } from '../components/Crest';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner, TextInput } from '../components/ui';

/** L4: Draft-Oberfläche. Reihenfolge, Budget und Picks kommen ausschließlich vom Server. */

const GROUPS = {
  ALL: { label: 'Alle', positions: null },
  GK: { label: 'TW', positions: ['GK'] },
  DEF: { label: 'Abwehr', positions: ['CB', 'LB', 'RB', 'LWB', 'RWB'] },
  MID: { label: 'Mittelfeld', positions: ['CDM', 'CM', 'CAM', 'LM', 'RM'] },
  ATT: { label: 'Angriff', positions: ['LW', 'RW', 'CF', 'ST'] },
} as const;
type GroupKey = keyof typeof GROUPS;
/** Empfohlener Kader (22 Spieler) – Grundlage der Anzeige „Kaderbedarf“ */
const NEED: Record<Exclude<GroupKey, 'ALL'>, number> = { GK: 2, DEF: 7, MID: 7, ATT: 6 };

const POS_LABEL: Record<string, string> = {
  GK: 'TW', CB: 'IV', LB: 'LV', RB: 'RV', LWB: 'LAV', RWB: 'RAV', CDM: 'DM', CM: 'ZM', CAM: 'OM', LM: 'LM', RM: 'RM', LW: 'LA', RW: 'RA', CF: 'HS', ST: 'ST',
};
const ATTR_LABEL: Record<string, string> = {
  pace: 'Tempo', shooting: 'Schießen', passing: 'Passen', dribbling: 'Dribbling', defending: 'Verteidigung', physical: 'Physis',
  stamina: 'Ausdauer', gameIntelligence: 'Spielintelligenz', heading: 'Kopfball', mentality: 'Mentalität', freeKicks: 'Freistöße',
  penalties: 'Elfmeter', corners: 'Eckbälle', crossing: 'Flanken', throwIns: 'Einwürfe', reflexes: 'Reflexe', handling: 'Fangen',
  positioning: 'Stellungsspiel', oneOnOne: 'Eins gegen eins', commandOfArea: 'Strafraumbeherrschung', distribution: 'Spieleröffnung',
  kicking: 'Abschläge', reactionSpeed: 'Reaktion',
};
type SortKey = 'overall' | 'market_value' | 'age' | 'main_position' | 'last_name';

function groupOf(pos: string): Exclude<GroupKey, 'ALL'> {
  for (const k of ['GK', 'DEF', 'MID', 'ATT'] as const) if ((GROUPS[k].positions as readonly string[]).includes(pos)) return k;
  return 'ATT';
}
function ratingColor(v: number): string {
  if (v >= 82) return 'text-gold';
  if (v >= 77) return 'text-pitch-light';
  if (v >= 70) return 'text-cream';
  return 'text-cream-dim';
}

export function Draft() {
  const { worldId = '' } = useParams();
  const [state, setState] = useState<DraftState | null>(null);
  const [pool, setPool] = useState<PoolPlayer[]>([]);
  const [squad, setSquad] = useState<Awaited<ReturnType<typeof fetchSquad>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [group, setGroup] = useState<GroupKey>('ALL');
  const [search, setSearch] = useState('');
  const [onlyAffordable, setOnlyAffordable] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'overall', dir: -1 });
  const [tab, setTab] = useState<'squad' | 'picks'>('squad');
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const s = await draftApi.state(worldId);
      setState(s);
      const [p, sq] = await Promise.all([fetchPool(worldId), s.my_club_id ? fetchSquad(s.my_club_id) : Promise.resolve([])]);
      setPool(p);
      setSquad(sq);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [worldId]);

  useEffect(() => {
    void load();
    const sb = requireSupabase();
    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void load(), 120);
    };
    const channel = sb
      .channel(`draft:${worldId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_picks', filter: `world_id=eq.${worldId}` }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'draft_sessions', filter: `world_id=eq.${worldId}` }, schedule)
      .subscribe();
    void api.touchPresence(worldId).catch(() => undefined);
    const ping = window.setInterval(() => void api.touchPresence(worldId).catch(() => undefined), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(ping);
      window.clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
      void sb.removeChannel(channel);
    };
  }, [worldId, load]);

  const clubsById = useMemo(() => new Map((state?.clubs ?? []).map((c) => [c.club_id, c])), [state]);
  const myClub = state?.my_club_id ? clubsById.get(state.my_club_id) : undefined;
  const current = state?.current_club_id ? clubsById.get(state.current_club_id) : undefined;
  const myTurn = !!state && state.status === 'running' && state.current_club_id === state.my_club_id;
  const budget = myClub?.balance ?? 0;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const positions = GROUPS[group].positions as readonly string[] | null;
    return pool
      .filter((p) => !positions || positions.includes(p.main_position))
      .filter((p) => !q || `${p.first_name} ${p.last_name} ${p.nationality}`.toLowerCase().includes(q))
      .filter((p) => !onlyAffordable || p.market_value <= budget)
      .sort((a, b) => {
        const av = a[sort.key];
        const bv = b[sort.key];
        const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'de');
        return c * sort.dir || b.overall - a.overall;
      });
  }, [pool, group, search, onlyAffordable, sort, budget]);

  const selectedPlayer = pool.find((p) => p.id === selected) ?? null;
  const needs = useMemo(() => {
    const have: Record<string, number> = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
    for (const p of squad) have[groupOf(p.main_position)]!++;
    return have;
  }, [squad]);

  async function pick(playerId: string) {
    setBusy('pick');
    setError(null);
    try {
      await draftApi.pick(worldId, playerId);
      setSelected(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function autoPick() {
    setBusy('auto');
    setError(null);
    try {
      await draftApi.autoPick(worldId);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!state) return <Shell>{error ? <ErrorBanner error={error} /> : <Spinner label="Draft wird geladen …" />}</Shell>;
  if (state.status === 'none') {
    return (
      <Shell>
        <Card>
          <p className="text-cream-dim">Für diese Welt wurde noch kein Draft gestartet.</p>
          <Link to={`/w/${worldId}`} className="mt-3 inline-block text-gold">Zur Lobby</Link>
        </Card>
      </Shell>
    );
  }

  const currentAbsent =
    current?.last_seen_at && Date.now() - new Date(current.last_seen_at).getTime() > READINESS_TIMEOUT_SECONDS * 1000;
  const myPicks = myClub?.picks ?? 0;

  return (
    <Shell right={<Link to="/" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Übersicht</Link>}>
      {/* Kopfzeile: wer ist dran, Reihenfolge */}
      <Card className={`mb-4 ${myTurn ? 'border-gold shadow-[0_0_0_2px_rgba(242,193,78,0.35)]' : ''}`}>
        {state.status === 'finished' ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Snake-Draft</p>
              <h1 className="display text-4xl font-extrabold uppercase">Draft abgeschlossen</h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="max-w-md text-cream-dim">Alle Kader sind komplett. Jetzt Aufstellung, Taktik, Standards und Sponsor festlegen.</p>
              <Link to={`/w/${worldId}/team`} className="display inline-flex min-h-11 items-center rounded-xl bg-gold px-5 text-lg font-semibold uppercase text-ink shadow-[0_4px_0_0_#b8902f]">
                Zum Team-Management
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-5">
            <div>
              <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">
                Runde {state.round}/{state.picks_per_club} · Pick {state.current_pick + 1}/{state.total_picks}
              </p>
              <div className="flex items-center gap-3">
                {current && <Crest crest={current.crest} size={40} />}
                <h1 className="display text-3xl font-extrabold uppercase leading-tight">
                  {myTurn ? 'Du bist am Zug!' : `${current?.name ?? '…'} wählt`}
                </h1>
              </div>
              {!myTurn && current && <p className="text-sm text-cream-dim">Manager: {current.manager}</p>}
            </div>
            <div className="ml-auto flex max-w-full gap-1.5 overflow-x-auto pb-1" aria-label="Nächste Picks">
              {state.upcoming.map((u, i) => {
                const c = clubsById.get(u.club_id);
                return (
                  <div key={u.pick_index} className={`flex w-14 shrink-0 flex-col items-center rounded-lg px-1 py-1 ${i === 0 ? 'bg-gold/15 ring-1 ring-gold' : 'bg-anthracite'}`} title={c?.name}>
                    {c && <Crest crest={c.crest} size={24} />}
                    <span className="display text-xs font-semibold text-cream-dim">#{u.pick_index + 1}</span>
                  </div>
                );
              })}
            </div>
            {state.is_host && !myTurn && currentAbsent && (
              <Button variant="secondary" busy={busy === 'auto'} onClick={() => void autoPick()}>
                Für abwesenden Manager wählen
              </Button>
            )}
          </div>
        )}
      </Card>

      <div className="mb-4">
        <ErrorBanner error={error} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* Spielerpool */}
        <Card className="min-w-0 p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-olive-700 p-4">
            {(Object.keys(GROUPS) as GroupKey[]).map((g) => (
              <button key={g} type="button" onClick={() => setGroup(g)} className={`display min-h-10 rounded-full px-4 text-base font-semibold uppercase ${group === g ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}>
                {GROUPS[g].label}
              </button>
            ))}
            <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name oder Nation" className="ml-auto !min-h-10 max-w-52 !text-base" />
            <label className="flex items-center gap-2 text-sm text-cream-dim">
              <input type="checkbox" checked={onlyAffordable} onChange={(e) => setOnlyAffordable(e.target.checked)} className="h-5 w-5 accent-[var(--color-gold)]" />
              bezahlbar
            </label>
          </div>
          <div className="max-h-[62vh] overflow-auto">
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10 bg-olive-900 text-xs uppercase tracking-wider text-cream-dim">
                <tr>
                  {(
                    [
                      ['main_position', 'Pos'],
                      ['last_name', 'Name'],
                      ['age', 'Alter'],
                      ['overall', 'Stärke'],
                      ['market_value', 'Marktwert'],
                    ] as const
                  ).map(([key, label]) => (
                    <th key={key} className="px-3 py-2">
                      <button type="button" className="display font-semibold uppercase hover:text-cream" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === 'last_name' || key === 'main_position' ? 1 : -1 }))}>
                        {label}
                        {sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : ''}
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2 display">Gehalt/Jahr</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const affordable = p.market_value <= budget;
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setSelected(p.id)}
                      className={`cursor-pointer border-t border-olive-800 transition ${selected === p.id ? 'bg-gold/10' : 'hover:bg-olive-800/60'} ${affordable ? '' : 'opacity-50'}`}
                    >
                      <td className="px-3 py-2">
                        <span className="display rounded bg-olive-700 px-2 py-0.5 text-sm font-semibold">{POS_LABEL[p.main_position] ?? p.main_position}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-3">
                          <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={40} />
                          <div>
                            <div className="font-semibold">{p.first_name} {p.last_name}</div>
                            <div className="text-xs text-cream-dim">{p.nationality}{p.secondary_positions.length > 0 && ` · auch ${p.secondary_positions.map((x) => POS_LABEL[x] ?? x).join(', ')}`}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">{p.age}</td>
                      <td className={`display px-3 py-2 text-2xl font-extrabold tabular-nums ${ratingColor(p.overall)}`}>{p.overall}</td>
                      <td className="px-3 py-2 tabular-nums">{formatEuro(p.market_value)}</td>
                      <td className="px-3 py-2 text-sm tabular-nums text-cream-dim">{p.salary ? formatEuro(p.salary) : '–'}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-cream-dim">Keine Spieler für diesen Filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="border-t border-olive-700 px-4 py-2 text-sm text-cream-dim">{filtered.length} von {pool.length} verfügbaren Spielern</div>
        </Card>

        {/* Seitenleiste */}
        <aside className="space-y-4">
          <Card>
            <div className="flex items-center gap-3">
              {myClub && <Crest crest={myClub.crest} size={44} />}
              <div className="flex-1">
                <div className="display text-xl font-bold">{myClub?.name}</div>
                <div className="text-sm text-cream-dim">{myPicks}/{state.picks_per_club} Spieler</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-cream-dim">Restbudget</div>
                <div className="display text-2xl font-extrabold text-gold">{formatEuro(budget)}</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-4 gap-2 text-center" aria-label="Kaderbedarf">
              {(Object.keys(NEED) as Array<keyof typeof NEED>).map((g) => {
                const done = (needs[g] ?? 0) >= NEED[g];
                return (
                  <div key={g} className={`rounded-lg px-1 py-2 ${done ? 'bg-pitch/40' : 'bg-anthracite'}`}>
                    <div className="display text-xs font-semibold uppercase text-cream-dim">{GROUPS[g].label}</div>
                    <div className="display text-xl font-bold">{needs[g] ?? 0}/{NEED[g]}</div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-cream-dim">Empfohlener Kader. Ein Kauf ist nur möglich, wenn danach genug Geld bleibt, um sicher auf 22 Spieler zu kommen.</p>
          </Card>

          {selectedPlayer && state.status === 'running' && (
            <Card className="animate-rise">
              <div className="flex items-start justify-between gap-3">
                <PlayerAvatar
                  id={selectedPlayer.id}
                  nationality={selectedPlayer.nationality}
                  age={selectedPlayer.age}
                  size={76}
                  shirt={myClub?.primary_color}
                  collar={myClub?.secondary_color}
                />
                <div className="flex-1">
                  <div className="display text-2xl font-bold leading-tight">{selectedPlayer.first_name} {selectedPlayer.last_name}</div>
                  <div className="text-sm text-cream-dim">
                    {POS_LABEL[selectedPlayer.main_position]} · {selectedPlayer.nationality} · {selectedPlayer.age} Jahre
                  </div>
                </div>
                <div className={`display text-5xl font-extrabold ${ratingColor(selectedPlayer.overall)}`}>{selectedPlayer.overall}</div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {Object.entries(selectedPlayer.attributes).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between text-xs"><span className="text-cream-dim">{ATTR_LABEL[k] ?? k}</span><span className="tabular-nums">{v}</span></div>
                    <div className="h-1.5 rounded bg-anthracite"><div className="h-1.5 rounded bg-pitch-light" style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-cream-dim">Marktwert (Kaufpreis)</dt><dd>{formatEuro(selectedPlayer.market_value)}</dd></div>
                <div className="flex justify-between"><dt className="text-cream-dim">Gehalt (3 Jahre Vertrag)</dt><dd>{selectedPlayer.salary ? `${formatEuro(selectedPlayer.salary)} / Jahr` : '–'}</dd></div>
              </dl>
              <Button className="mt-4 w-full" disabled={!myTurn || selectedPlayer.market_value > budget} busy={busy === 'pick'} onClick={() => void pick(selectedPlayer.id)}>
                {myTurn ? (selectedPlayer.market_value > budget ? 'Zu teuer' : 'Verpflichten') : 'Warte auf deinen Pick'}
              </Button>
            </Card>
          )}

          <Card className="p-0">
            <div className="flex border-b border-olive-700">
              {(['squad', 'picks'] as const).map((t) => (
                <button key={t} type="button" onClick={() => setTab(t)} className={`display flex-1 py-3 text-base font-semibold uppercase ${tab === t ? 'text-gold' : 'text-cream-dim'}`}>
                  {t === 'squad' ? 'Mein Kader' : 'Alle Picks'}
                </button>
              ))}
            </div>
            <ul className="max-h-[40vh] divide-y divide-olive-800 overflow-auto">
              {tab === 'squad'
                ? squad.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 px-4 py-2">
                      <span className="display w-7 text-right text-lg font-bold text-cream-dim">{p.shirt_number}</span>
                      <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={32} shirt={myClub?.primary_color} collar={myClub?.secondary_color} />
                      <span className="display w-9 text-sm">{POS_LABEL[p.main_position]}</span>
                      <span className="flex-1 truncate">{p.first_name} {p.last_name}</span>
                      <span className={`display text-xl font-bold ${ratingColor(p.overall)}`}>{p.overall}</span>
                    </li>
                  ))
                : state.picks.map((p) => {
                    const c = clubsById.get(p.club_id);
                    return (
                      <li key={p.pick_index} className="flex items-center gap-3 px-4 py-2">
                        <span className="display w-8 text-sm text-cream-dim">#{p.pick_index + 1}</span>
                        <PlayerAvatar id={p.player_id} nationality={p.nationality} age={p.age} size={30} shirt={c?.primary_color} collar={c?.secondary_color} />
                        {c && <Crest crest={c.crest} size={20} />}
                        <span className="flex-1 truncate">{p.name}</span>
                        <span className="display text-sm">{POS_LABEL[p.position]}</span>
                        <span className={`display text-lg font-bold ${ratingColor(p.overall)}`}>{p.overall}</span>
                      </li>
                    );
                  })}
              {tab === 'squad' && squad.length === 0 && <li className="px-4 py-6 text-center text-cream-dim">Noch keine Spieler.</li>}
              {tab === 'picks' && state.picks.length === 0 && <li className="px-4 py-6 text-center text-cream-dim">Noch keine Picks.</li>}
            </ul>
          </Card>

          <Card>
            <h2 className="display mb-2 text-lg font-bold uppercase text-cream-dim">Reihenfolge Runde 1</h2>
            <ul className="space-y-2">
              {state.clubs.map((c) => (
                <li key={c.club_id} className="flex items-center gap-3">
                  <span className="display w-5 text-cream-dim">{c.order}</span>
                  <Crest crest={c.crest} size={24} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-sm text-cream-dim">{c.picks}/{state.picks_per_club}</span>
                  <Pill tone={c.club_id === state.current_club_id ? 'gold' : 'neutral'}>{formatEuro(c.balance)}</Pill>
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </Shell>
  );
}
