import { TEAM_SETTINGS, readableTextColor, resolveAwayDisplayColor } from '@fd/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { MatchPitch } from '../components/match/MatchPitch';
import { matchServerUrl } from '../lib/matchApi';
import { MatchClient, type EndResult, type MatchEvent, type ProfileName, type RosterTeam, type Side, type TeamView } from '../lib/matchClient';

const PROFILE_LABEL: Record<ProfileName, string> = { offensive: 'Offensiv', neutral: 'Neutral', defensive: 'Defensiv' };
const QUICK_SETTINGS = ['mentality', 'tempo', 'pressingIntensity', 'defensiveLine'] as const;
const EVENT_ICON: Record<string, string> = { goal: '⚽', yellow: '🟨', second_yellow: '🟨🟥', red: '🟥', sub: '🔁', injury: '✚', save: '🧤', woodwork: '▮', penalty: '❗', halftime: '⏸', fulltime: '🏁', kickoff: '▶', chance: '!', tactic: '♟', corner: '⚑', offside: '⚐', free_kick: '◎', miss: '·' };
const TICKER_TYPES = new Set(['goal', 'yellow', 'second_yellow', 'red', 'sub', 'injury', 'save', 'woodwork', 'penalty', 'halftime', 'fulltime', 'kickoff', 'chance', 'tactic', 'corner', 'offside', 'free_kick', 'miss']);

function useMatch(fixtureId: string) {
  const url = matchServerUrl();
  const client = useMemo(() => (url ? new MatchClient(url, fixtureId) : null), [url, fixtureId]);
  useEffect(() => {
    if (!client) return;
    void client.connect();
    return () => client.close();
  }, [client]);
  const state = useSyncExternalStore(
    (fn) => (client ? client.subscribe(fn) : () => undefined),
    () => client?.state ?? null,
  );
  return { client, state, configured: !!url };
}

/** F1–F5/L4: Live-Spiel. Server ist autoritativ; Manager steuern ohne Pause, Zuschauer sehen nur zu. */
export function Match() {
  const { worldId = '', fixtureId = '' } = useParams();
  const { client, state, configured } = useMatch(fixtureId);
  const [panel, setPanel] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const banner = useBanner(state?.events ?? [], state?.teams ?? null);

  if (!configured) {
    return (
      <Shell>
        <Card className="mx-auto max-w-xl">
          <h1 className="display text-3xl font-bold uppercase">Match-Server fehlt</h1>
          <p className="mt-3 text-cream-dim">
            <span className="font-mono text-gold">VITE_MATCH_SERVER_URL</span> ist nicht gesetzt. Trage die Fly.io-Adresse (z. B. https://football-dynasty-match.fly.dev) in Netlify ein und deploye neu.
          </p>
        </Card>
      </Shell>
    );
  }
  if (!client || !state || !state.teams || !state.latest) {
    return (
      <Shell>
        {state?.error ? (
          <Card className="mx-auto max-w-xl">
            <ErrorBanner error={state.error} />
            <Link to={`/w/${worldId}/team`} className="mt-4 inline-block text-gold underline">Zurück zum Team</Link>
          </Card>
        ) : (
          <Spinner label={state?.connection === 'reconnecting' ? 'Verbindung wird wiederhergestellt …' : 'Verbinde mit dem Stadion …'} />
        )}
      </Shell>
    );
  }

  const { teams, latest: snap, role, view, events, status, end } = state;
  const homeColor = teams.home.color;
  const awayColor = resolveAwayDisplayColor(teams.home.color, teams.away.color, teams.away.colorAlt);
  const mySide: Side | null = role === 'home' || role === 'away' ? role : null;
  const send = async (cmd: Parameters<MatchClient['command']>[0]) => {
    const r = await client.command(cmd);
    setMsg(r.ok ? null : (r.error ?? 'Befehl abgelehnt.'));
    return r.ok;
  };
  const activeProfile = mySide ? snap.activeProfile[mySide === 'home' ? 0 : 1] : null;

  return (
    <Shell right={<><Link to={`/w/${worldId}/spieltag`} className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Spieltag</Link><Link to={`/w/${worldId}/team`} className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Team</Link></>}>
      <Scoreboard teams={teams} homeColor={homeColor} awayColor={awayColor} score={snap.score} minute={snap.minute} phase={snap.phase} status={status} connection={state.connection} role={role} />

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="relative">
          <div className="aspect-[111/74] w-full max-h-[64vh]">
            <MatchPitch client={client} teams={teams} homeColor={homeColor} awayColor={awayColor} />
          </div>
          {banner && banner.big && (
            <div key={banner.key} className="fd-banner pointer-events-none absolute left-1/2 top-[40%] text-center">
              <div className="rounded-2xl px-8 py-4 shadow-2xl" style={{ background: banner.color, color: readableTextColor(banner.color) }}>
                <div className="display text-6xl font-extrabold uppercase leading-none tracking-wide">Tor!</div>
                <div className="display mt-1 text-2xl font-semibold uppercase">{banner.text}</div>
              </div>
            </div>
          )}
          {banner && !banner.big && (
            <div key={banner.key} className="fd-toast pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-ink/80 px-4 py-1.5 text-sm font-semibold text-cream shadow-lg">
              {banner.text}
            </div>
          )}
          <SkipBadge skip={state.skip} />
          {status === 'halftime' && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-ink/45">
              <div className="display rounded-2xl bg-ink/80 px-8 py-4 text-4xl font-extrabold uppercase tracking-wide">Halbzeit · {snap.score[0]}:{snap.score[1]}</div>
            </div>
          )}
          {status === 'waiting' && (
            <div className="absolute inset-0 grid place-items-center rounded-xl bg-ink/55">
              <div className="text-center">
                <p className="display mb-3 text-2xl font-bold uppercase">Die Teams stehen bereit</p>
                {mySide ? <Button onClick={() => client.start()}>Anpfiff</Button> : <p className="text-cream-dim">Warte auf den Anpfiff …</p>}
                <p className="mt-2 text-sm text-cream-dim">Spätestens nach 90 Sekunden wird automatisch angepfiffen.</p>
              </div>
            </div>
          )}
          {mySide && status !== 'finished' && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(['offensive', 'neutral', 'defensive'] as const).map((p) => (
                <button key={p} type="button" onClick={() => void send({ kind: 'profile', name: p })}
                  className={`display min-h-12 flex-1 rounded-xl px-4 text-lg font-bold uppercase ${activeProfile === p ? 'bg-gold text-ink' : 'bg-olive-800 text-cream hover:bg-olive-700'}`}>
                  {PROFILE_LABEL[p]}
                </button>
              ))}
              <Button variant="secondary" className="min-h-12 flex-1" onClick={() => setPanel(true)}>Team-Management</Button>
            </div>
          )}
          {msg && <div className="mt-2"><ErrorBanner error={msg} /></div>}
          {view?.autopilot && mySide && <p className="mt-2 text-sm text-cream-dim">Automatik aktiv (E4) – sobald du verbunden bist, übernimmst du wieder.</p>}
        </div>
        <Ticker events={events} teams={teams} homeColor={homeColor} awayColor={awayColor} />
      </div>

      {panel && mySide && view && (
        <ManagementPanel view={view} team={teams[mySide]} onClose={() => setPanel(false)} send={send} />
      )}
      {end && <Summary result={end.result} saved={end.saved} teams={teams} homeColor={homeColor} awayColor={awayColor} worldId={worldId} kind={state.kind} />}
    </Shell>
  );
}

/** Sprung der Regie: „23' ⏩ 31'“ – die Uhr springt, ruhige Phasen werden nicht gezeigt */
function SkipBadge({ skip }: { skip: { from: number; to: number; at: number } | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!skip) return;
    const t = setTimeout(() => force((x) => x + 1), 1800);
    return () => clearTimeout(t);
  }, [skip]);
  if (!skip || performance.now() - skip.at > 1700 || skip.to - skip.from < 20) return null;
  const m = (sec: number) => `${Math.min(90, Math.floor(sec / 60) + 1)}'`;
  return (
    <div key={skip.at} className="fd-toast pointer-events-none absolute right-3 top-3 rounded-full bg-ink/80 px-3 py-1 text-sm font-semibold text-cream shadow-lg">
      {m(skip.from)} ⏩ {m(skip.to)}
    </div>
  );
}

/** Einblendungen: großes „TOR!“ und kurze Hinweise bei Großchancen, Paraden, Karten */
function useBanner(events: MatchEvent[], teams: { home: RosterTeam; away: RosterTeam } | null) {
  const [banner, setBanner] = useState<{ key: number; big: boolean; text: string; color: string } | null>(null);
  const seen = useRef(-1);
  useEffect(() => {
    if (!teams) return;
    if (seen.current < 0) { seen.current = events.length; return; }
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    const pick = [...fresh].reverse().find((e) => ['goal', 'save', 'chance', 'woodwork', 'red', 'second_yellow', 'penalty'].includes(e.type));
    if (!pick) return;
    const color = pick.side === 'away' ? teams.away.color : teams.home.color;
    const name = pick.playerId ? [...teams.home.players, ...teams.away.players].find((p) => p.id === pick.playerId)?.name : undefined;
    const big = pick.type === 'goal';
    setBanner({ key: pick.tick, big, text: big ? (name ?? '') : pick.text, color });
    const t = setTimeout(() => setBanner(null), big ? 3500 : 2200);
    return () => clearTimeout(t);
  }, [events, teams]);
  return banner;
}

function Scoreboard({ teams, homeColor, awayColor, score, minute, phase, status, connection, role }: {
  teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string; score: [number, number]; minute: number;
  phase: string; status: string; connection: string; role: string | null;
}) {
  const clock = status === 'waiting' ? 'Vor dem Spiel' : status === 'halftime' ? 'Halbzeit' : phase === 'end' || status === 'finished' ? 'Abpfiff' : `${Math.min(phase === 'first' ? 45 : 90, minute + 1)}'`;
  return (
    <Card className="!p-3">
      <div className="flex items-center gap-3">
        <TeamBadge team={teams.home} color={homeColor} align="right" />
        <div className="min-w-32 text-center">
          <div className="display text-5xl font-extrabold leading-none tabular-nums">{score[0]}<span className="mx-2 text-cream-dim">:</span>{score[1]}</div>
          <div className="display mt-1 text-lg font-semibold uppercase text-gold">{clock}</div>
        </div>
        <TeamBadge team={teams.away} color={awayColor} align="left" />
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-2 text-sm">
        {role === 'spectator' && <Pill>Zuschauer</Pill>}
        {connection === 'reconnecting' && <Pill tone="warn">Verbindung wird wiederhergestellt …</Pill>}
      </div>
    </Card>
  );
}

function TeamBadge({ team, color, align }: { team: RosterTeam; color: string; align: 'left' | 'right' }) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-3 ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      <span className="display grid h-12 w-12 shrink-0 place-items-center rounded-xl text-lg font-bold" style={{ background: color, color: readableTextColor(color) }}>{team.shortName}</span>
      <div className="min-w-0">
        <div className="display truncate text-2xl font-bold uppercase leading-tight">{team.name}</div>
        <div className="text-xs text-cream-dim">{team.control === 'ai' ? 'KI-Verein' : 'Manager'}</div>
      </div>
    </div>
  );
}

function Ticker({ events, teams, homeColor, awayColor }: { events: MatchEvent[]; teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string }) {
  const list = events.filter((e) => TICKER_TYPES.has(e.type)).slice(-80).reverse();
  void teams;
  return (
    <Card className="!p-3 max-h-[64vh] overflow-y-auto">
      <h2 className="display mb-2 text-lg font-bold uppercase tracking-wide text-gold">Liveticker</h2>
      <ol className="space-y-1.5">
        {list.map((e, i) => (
          <li key={`${e.tick}-${i}`} className={`flex gap-2 rounded-lg px-2 py-1 text-sm ${e.type === 'goal' ? 'bg-gold/15 font-semibold' : ''}`}>
            <span className="w-8 shrink-0 tabular-nums text-cream-dim">{e.minute}'</span>
            <span className="w-5 shrink-0 text-center">{EVENT_ICON[e.type] ?? '·'}</span>
            <span className="h-3 w-1 shrink-0 self-center rounded" style={{ background: e.side === 'home' ? homeColor : e.side === 'away' ? awayColor : 'transparent' }} />
            <span className="min-w-0">{e.text}</span>
          </li>
        ))}
        {list.length === 0 && <li className="text-sm text-cream-dim">Noch keine Ereignisse.</li>}
      </ol>
    </Card>
  );
}

function ManagementPanel({ view, team, onClose, send }: { view: TeamView; team: RosterTeam; onClose: () => void; send: (c: any) => Promise<boolean> }) {
  const [outId, setOutId] = useState<string | null>(null);
  const field = view.players.filter((p) => p.onPitch).sort((a, b) => (a.position === 'GK' ? -1 : b.position === 'GK' ? 1 : b.y - a.y));
  const bench = view.players.filter((p) => !p.onPitch && !p.subbedOff && !p.sentOff && !p.unavailable && !p.injured);
  const pendingIn = new Set(view.pendingSubs.map((s) => s.inId));
  const pendingOut = new Set(view.pendingSubs.map((s) => s.outId));
  void team;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/40" onClick={onClose}>
      <aside className="h-full w-full max-w-[560px] overflow-y-auto border-l border-olive-700 bg-olive-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()} aria-label="Team-Management">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="display text-2xl font-bold uppercase">Team-Management</h2>
          <Button variant="ghost" onClick={onClose}>Schließen</Button>
        </div>
        <p className="mb-3 text-sm text-cream-dim">Das Spiel läuft weiter. Änderungen gelten sofort; Wechsel beim nächsten Halt (spätestens nach 45 Spielsekunden).</p>

        <section className="mb-5">
          <h3 className="display mb-2 text-lg font-bold uppercase text-gold">Schnelleinstellungen</h3>
          {QUICK_SETTINGS.map((k) => (
            <div key={k} className="mb-2">
              <div className="mb-1 text-sm text-cream-dim">{TEAM_SETTINGS[k].label}</div>
              <div className="grid grid-cols-5 gap-1">
                {TEAM_SETTINGS[k].values.map((v, i) => (
                  <button key={v} type="button" onClick={() => void send({ kind: 'settings', team_instructions: { [k]: v } })}
                    className={`min-h-11 rounded-lg px-1 text-xs font-semibold ${view.team_instructions[k] === v ? 'bg-gold text-ink' : 'bg-olive-800 text-cream hover:bg-olive-700'}`}>
                    {TEAM_SETTINGS[k].valueLabels[i]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="display text-lg font-bold uppercase text-gold">Wechsel</h3>
            <span className="text-sm text-cream-dim">{view.subsUsed}/5 Wechsel · {view.subWindowsUsed}/3 Fenster</span>
          </div>
          <p className="mb-2 text-sm text-cream-dim">{outId ? 'Jetzt den Einwechselspieler wählen.' : 'Spieler auf dem Platz antippen, der raus soll.'}</p>
          <div className="grid gap-1.5">
            {field.map((p) => (
              <button key={p.id} type="button" disabled={pendingOut.has(p.id)} onClick={() => setOutId(outId === p.id ? null : p.id)}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-left text-sm ${outId === p.id ? 'bg-sunset text-ink' : 'bg-olive-800 hover:bg-olive-700'} disabled:opacity-50`}>
                <span className="w-8 font-mono text-cream-dim">{p.position}</span>
                <span className="w-6 text-right tabular-nums">{p.shirt}</span>
                <span className="flex-1 truncate font-semibold">{p.name}{p.yellow ? ' 🟨' : ''}{pendingOut.has(p.id) ? ' (geht raus)' : ''}</span>
                <FitnessBar value={p.fitness} />
              </button>
            ))}
          </div>
          {outId && (
            <div className="mt-3 grid gap-1.5">
              <div className="text-sm font-semibold text-gold">Bank</div>
              {bench.map((p) => (
                <button key={p.id} type="button" disabled={pendingIn.has(p.id)} onClick={async () => { if (await send({ kind: 'sub', outId, inId: p.id })) setOutId(null); }}
                  className="flex min-h-11 items-center gap-2 rounded-lg bg-olive-700 px-3 text-left text-sm hover:bg-olive-600 disabled:opacity-50">
                  <span className="w-8 font-mono text-cream-dim">{p.main}</span>
                  <span className="w-6 text-right tabular-nums">{p.shirt}</span>
                  <span className="flex-1 truncate font-semibold">{p.name} <span className="text-cream-dim">({p.overall})</span></span>
                  <FitnessBar value={p.fitness} />
                </button>
              ))}
              {bench.length === 0 && <p className="text-sm text-cream-dim">Keine Spieler verfügbar.</p>}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

function FitnessBar({ value }: { value: number }) {
  const tone = value >= 75 ? 'bg-emerald-400' : value >= 55 ? 'bg-gold' : 'bg-danger';
  return (
    <span className="flex w-20 items-center gap-1 text-xs tabular-nums text-cream-dim" title={`Fitness ${value}`}>
      <span className="h-1.5 flex-1 overflow-hidden rounded bg-olive-900"><span className={`block h-full ${tone}`} style={{ width: `${value}%` }} /></span>
      {value}
    </span>
  );
}

function Summary({ result, saved, teams, homeColor, awayColor, worldId, kind }: { result: EndResult; saved: boolean; teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string; worldId: string; kind: string | null }) {
  const names = new Map([...teams.home.players, ...teams.away.players].map((p) => [p.id, p.name]));
  const h = result.stats.home;
  const a = result.stats.away;
  const rows: Array<[string, string | number, string | number]> = [
    ['Ballbesitz', `${result.possessionHome} %`, `${100 - result.possessionHome} %`],
    ['Schüsse (aufs Tor)', `${h.shots} (${h.shotsOnTarget})`, `${a.shots} (${a.shotsOnTarget})`],
    ['xG', h.xg.toFixed(2).replace('.', ','), a.xg.toFixed(2).replace('.', ',')],
    ['Pässe (angekommen)', `${h.passes} (${Math.round((h.passesCompleted / Math.max(1, h.passes)) * 100)} %)`, `${a.passes} (${Math.round((a.passesCompleted / Math.max(1, a.passes)) * 100)} %)`],
    ['Ecken', h.corners, a.corners],
    ['Fouls', h.fouls, a.fouls],
    ['Abseits', h.offsides, a.offsides],
    ['Karten', `${h.yellow} 🟨 ${h.red ? `${h.red} 🟥` : ''}`, `${a.yellow} 🟨 ${a.red ? `${a.red} 🟥` : ''}`],
  ];
  const top = [...result.players].sort((x, y) => y.rating - x.rating).slice(0, 6);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/70 p-4">
      <Card className="w-full max-w-3xl">
        <p className="display text-center text-sm font-semibold uppercase tracking-[0.2em] text-gold">Spielende</p>
        <div className="mt-1 flex items-center justify-center gap-4">
          <span className="display text-2xl font-bold uppercase">{teams.home.shortName}</span>
          <span className="display text-6xl font-extrabold tabular-nums">{result.score[0]}:{result.score[1]}</span>
          <span className="display text-2xl font-bold uppercase">{teams.away.shortName}</span>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <table className="w-full text-sm">
            <tbody>
              {rows.map(([k, x, y]) => (
                <tr key={k} className="border-b border-olive-700/60">
                  <td className="py-1.5 text-right font-semibold tabular-nums" style={{ borderRight: `3px solid ${homeColor}` }}>{x}&nbsp;</td>
                  <td className="px-2 py-1.5 text-center text-cream-dim">{k}</td>
                  <td className="py-1.5 font-semibold tabular-nums" style={{ borderLeft: `3px solid ${awayColor}` }}>&nbsp;{y}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <h3 className="display mb-2 text-lg font-bold uppercase text-gold">Beste Noten</h3>
            <ol className="space-y-1">
              {top.map((p) => (
                <li key={p.playerId} className="flex items-center gap-2 rounded-lg bg-olive-800 px-3 py-1.5 text-sm">
                  <span className="h-3 w-1 rounded" style={{ background: p.side === 'home' ? homeColor : awayColor }} />
                  <span className="flex-1 truncate font-semibold">{names.get(p.playerId) ?? '–'}{p.playerId === result.playerOfTheMatch ? ' ★' : ''}</span>
                  <span className="text-cream-dim">{p.goals ? `${p.goals} T ` : ''}{p.assists ? `${p.assists} V` : ''}</span>
                  <span className="display w-10 text-right text-lg font-bold tabular-nums">{p.rating.toFixed(1).replace('.', ',')}</span>
                </li>
              ))}
            </ol>
            {result.playerOfTheMatch && <p className="mt-2 text-sm text-cream-dim">★ Spieler des Spiels: {names.get(result.playerOfTheMatch)}</p>}
          </div>
        </div>
        {!saved && <p className="mt-3 text-sm text-danger">Das Ergebnis konnte noch nicht gespeichert werden – der Server versucht es erneut.</p>}
        <div className="mt-4 flex justify-center">
          <Link to={`/w/${worldId}/${kind === 'friendly' ? 'team?tab=matches' : 'spieltag'}`} className="display rounded-xl bg-gold px-5 py-2 text-lg font-semibold uppercase text-ink">Weiter</Link>
        </div>
      </Card>
    </div>
  );
}
