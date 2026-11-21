import { TEAM_SETTINGS, readableTextColor, resolveAwayDisplayColor } from '@fd/shared';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { competitionTheme, type CompetitionRef } from '../lib/theme';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { MatchPitch, WALKOUT_MS, pitchAspect } from '../components/match/MatchPitch';
import { fanApi } from '../lib/fanApi';
import { prefs } from '../lib/stadiumSound';
import { CHANNELS, mixer, type Track } from '../lib/audioMixer';
import { MatchSound, type ChantRef } from '../lib/fanAudio';
import type { AudioRef, MatchState } from '../lib/matchClient';
import { LiveBoard } from '../components/match/LiveBoard';
import { matchServerUrl } from '../lib/matchApi';
import { seasonApi } from '../lib/seasonApi';
import { formatEuro } from '../lib/api';
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
  // KI-Spiele des Termins serverseitig berechnen lassen (idempotent), auch wenn direkt ins Spiel gewechselt wurde
  useEffect(() => { if (worldId) void seasonApi.simulate(worldId); }, [worldId]);
  const [panel, setPanel] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const banner = useBanner(state?.events ?? [], state?.teams ?? null);
  // Einlauf überspringen ist rein lokal; der Anpfiff kommt für alle gleichzeitig vom Server
  const [skipWalkout, setSkipWalkout] = useState(() => prefs.alwaysSkip);
  const sound = useMatchAudio(state, skipWalkout, fixtureId);
  const [mixerOpen, setMixerOpen] = useState(false);

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
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => client?.retryNow()}>Neu verbinden</Button>
              <Link to={`/w/${worldId}/spieltag`} className="text-gold underline">Zum Spieltag</Link>
            </div>
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
      <Scoreboard teams={teams} homeColor={homeColor} awayColor={awayColor} score={snap.score} minute={snap.minute} phase={snap.phase} status={status} connection={state.connection} role={role} competition={state.stadium?.competition ?? null} />

      <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1fr)_228px] xl:grid-cols-[minmax(0,1fr)_250px]">
        <div className="relative">
          <div className="mx-auto w-full" style={{ aspectRatio: pitchAspect(state.stadium), maxHeight: 'calc(100vh - 220px)', maxWidth: `calc((100vh - 220px) * ${pitchAspect(state.stadium).replace(' / ', ' / ')})` }}>
            <MatchPitch client={client} teams={teams} homeColor={homeColor} awayColor={awayColor} stadium={state.stadium} walkoutEndsAt={state.walkoutEndsAt} walkoutSkipped={skipWalkout} sound={sound.on ? sound.sound : null} />
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
          {status === 'waiting' && state.walkoutEndsAt && (
            <WalkoutOverlay endsAt={state.walkoutEndsAt} skipped={skipWalkout} onSkip={() => { setSkipWalkout(true); sound.stopMusic(); }} sound={sound} />
          )}
          {status !== 'waiting' && status !== 'finished' && (
            <div className="absolute bottom-3 right-3 flex gap-2">
              {sound.on ? (
                <>
                  <button type="button" onClick={() => setMixerOpen((x) => !x)} className="rounded-full bg-ink/80 px-3 py-1.5 text-sm font-semibold text-cream shadow-lg">🎚 Ton</button>
                  <button type="button" onClick={() => sound.mute()} className="rounded-full bg-ink/80 px-3 py-1.5 text-sm font-semibold text-cream shadow-lg">🔇</button>
                </>
              ) : (
                <button type="button" onClick={() => void sound.unlock()} className="rounded-full bg-ink/80 px-3 py-1.5 text-sm font-semibold text-cream shadow-lg">🔈 Stadionsound an</button>
              )}
            </div>
          )}
          {mixerOpen && sound.on && <MixerPanel onClose={() => setMixerOpen(false)} />}
          {status === 'waiting' && !state.walkoutEndsAt && (
            <div className="absolute inset-0 grid place-items-center rounded-xl bg-ink/55">
              <div className="text-center">
                <p className="display mb-3 text-2xl font-bold uppercase">Die Teams stehen bereit</p>
                {mySide ? <Button onClick={() => client.start()}>Anpfiff</Button> : <p className="text-cream-dim">Warte auf den Anpfiff …</p>}
                <p className="mt-2 text-sm text-cream-dim">Spätestens nach 90 Sekunden wird automatisch angepfiffen.</p>
              </div>
            </div>
          )}
          {mySide && status !== 'finished' && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {(['offensive', 'neutral', 'defensive'] as const).map((p) => (
                <button key={p} type="button" onClick={() => void send({ kind: 'profile', name: p })}
                  className={`display min-h-11 flex-1 rounded-lg px-3 text-base font-bold uppercase ${activeProfile === p ? 'bg-gold text-ink' : 'bg-olive-800 text-cream hover:bg-olive-700'}`}>
                  {PROFILE_LABEL[p]}
                </button>
              ))}
              <Button variant="secondary" className="min-h-11 flex-1 !px-3 !text-base" onClick={() => setPanel(true)}>Team-Management</Button>
            </div>
          )}
          {msg && <div className="mt-2"><ErrorBanner error={msg} /></div>}
          {awayColor.toLowerCase() !== teams.away.color.toLowerCase() && <p className="mt-2 text-xs text-amber-200">Farbkonflikt der Trikots – die Gäste werden zur besseren Unterscheidung in einer Ersatzfarbe gezeigt.</p>}
          {view?.autopilot && mySide && <p className="mt-2 text-sm text-cream-dim">Automatik aktiv (E4) – sobald du verbunden bist, übernimmst du wieder.</p>}
        </div>
        <Ticker events={events} teams={teams} homeColor={homeColor} awayColor={awayColor} />
      </div>

      {panel && mySide && view && (
        <LiveBoard view={view} team={teams[mySide]} activeProfile={activeProfile} onClose={() => setPanel(false)} send={send} />
      )}
      {end && <Summary result={end.result} saved={end.saved} teams={teams} homeColor={homeColor} awayColor={awayColor} worldId={worldId} kind={state.kind} fixtureId={fixtureId} />}
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

function Scoreboard({ teams, homeColor, awayColor, score, minute, phase, status, connection, role, competition }: {
  teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string; score: [number, number]; minute: number;
  phase: string; status: string; connection: string; role: string | null; competition: CompetitionRef | null;
}) {
  const clock = status === 'waiting' ? 'Vor dem Spiel' : status === 'halftime' ? 'Halbzeit' : phase === 'end' || status === 'finished' ? 'Abpfiff' : `${Math.min(phase === 'first' ? 45 : 90, minute + 1)}'`;
  // Ergebnisanzeige im Stil des Wettbewerbs (eigene Gestaltung, keine TV-Grafiken)
  const th = competitionTheme(competition);
  return (
    <div className="overflow-hidden rounded-xl border shadow-lg" style={{ background: `linear-gradient(100deg, ${th.board.from}, ${th.board.to})`, borderColor: `${th.board.edge}66` }}>
      <div className="flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3">
        <TeamBadge team={teams.home} color={homeColor} align="right" />
        <div className="min-w-28 text-center">
          <div className="display text-4xl font-extrabold leading-none tabular-nums" style={{ color: th.board.text }}>{score[0]}<span className="mx-1.5 opacity-60">:</span>{score[1]}</div>
          <div className="display mt-0.5 inline-block rounded px-2 text-sm font-bold uppercase" style={{ background: th.board.edge, color: '#0d0f12' }}>{clock}</div>
        </div>
        <TeamBadge team={teams.away} color={awayColor} align="left" />
      </div>
      <div className="flex items-center justify-center gap-2 border-t px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ borderColor: `${th.board.edge}33`, color: th.board.label }}>
        <span>{competition?.name ?? th.label}</span>
        {role === 'spectator' && <span className="text-cream-dim">· Zuschauer</span>}
        {connection === 'reconnecting' && <span className="text-amber-300">· Verbindung wird wiederhergestellt …</span>}
      </div>
    </div>
  );
}

function TeamBadge({ team, color, align }: { team: RosterTeam; color: string; align: 'left' | 'right' }) {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2 ${align === 'right' ? 'flex-row-reverse text-right' : ''}`}>
      <span className="display grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold" style={{ background: color, color: readableTextColor(color) }}>{team.shortName}</span>
      <div className="min-w-0">
        <div className="display truncate text-xl font-bold uppercase leading-tight">{team.name}</div>
        <div className="hidden text-[11px] text-cream-dim sm:block">{team.control === 'ai' ? 'KI-Verein' : 'Manager'}</div>
      </div>
    </div>
  );
}

function Ticker({ events, teams, homeColor, awayColor }: { events: MatchEvent[]; teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string }) {
  const list = events.filter((e) => TICKER_TYPES.has(e.type)).slice(-80).reverse();
  void teams;
  return (
    <Card className="!p-2 max-h-[30vh] overflow-y-auto lg:max-h-[calc(100vh-220px)]">
      <h2 className="display mb-1 text-base font-bold uppercase tracking-wide text-gold">Liveticker</h2>
      <ol className="space-y-1">
        {list.map((e, i) => (
          <li key={`${e.tick}-${i}`} className={`flex gap-1.5 rounded-md px-1.5 py-0.5 text-xs leading-snug ${e.type === 'goal' ? 'bg-gold/15 font-semibold' : ''}`}>
            <span className="w-6 shrink-0 tabular-nums text-cream-dim">{e.minute}'</span>
            <span className="w-4 shrink-0 text-center">{EVENT_ICON[e.type] ?? '·'}</span>
            <span className="h-3 w-1 shrink-0 self-center rounded" style={{ background: e.side === 'home' ? homeColor : e.side === 'away' ? awayColor : 'transparent' }} />
            <span className="min-w-0">{e.text}</span>
          </li>
        ))}
        {list.length === 0 && <li className="text-sm text-cream-dim">Noch keine Ereignisse.</li>}
      </ol>
    </Card>
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

/** Zuschauer, Auslastung und Ticketeinnahmen (Heimverein) */
function GateInfo({ fixtureId, saved }: { fixtureId: string; saved: boolean }) {
  const [g, setG] = useState<Awaited<ReturnType<typeof seasonApi.gate>>>(null);
  useEffect(() => {
    if (!saved) return;
    let stop = false;
    const load = (n: number) => void seasonApi.gate(fixtureId).then((r) => { if (stop) return; if (r) setG(r); else if (n < 4) setTimeout(() => load(n + 1), 1500); }).catch(() => undefined);
    load(0);
    return () => { stop = true; };
  }, [fixtureId, saved]);
  if (!g) return null;
  return (
    <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-olive-600 bg-olive-800/60 p-3 text-center">
      <div><p className="text-xs uppercase text-cream-dim">Zuschauer</p><p className="display text-2xl font-bold tabular-nums">{g.attendance.toLocaleString('de-DE')}</p></div>
      <div><p className="text-xs uppercase text-cream-dim">Auslastung</p><p className="display text-2xl font-bold tabular-nums">{g.utilization.toLocaleString('de-DE')} %</p>
        <p className="text-[11px] text-cream-dim">{g.capacity.toLocaleString('de-DE')} Plätze</p></div>
      <div><p className="text-xs uppercase text-cream-dim">Ticketeinnahmen (Heim)</p><p className="display text-2xl font-bold tabular-nums text-emerald-300">+{formatEuro(g.income)}</p>
        <p className="text-[11px] text-cream-dim">{g.ticket_price} € je Ticket{g.booked ? ' · verbucht' : ' · Buchung mit der Ergebnisfreigabe'}</p></div>
    </div>
  );
}

function Summary({ result, saved, teams, homeColor, awayColor, worldId, kind, fixtureId }: { result: EndResult; saved: boolean; teams: { home: RosterTeam; away: RosterTeam }; homeColor: string; awayColor: string; worldId: string; kind: string | null; fixtureId: string }) {
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
        {kind !== 'friendly' && <GateInfo fixtureId={fixtureId} saved={saved} />}
        {!saved && <p className="mt-3 text-sm text-danger">Das Ergebnis konnte noch nicht gespeichert werden – der Server versucht es erneut.</p>}
        <div className="mt-4 flex justify-center">
          <Link to={`/w/${worldId}/${kind === 'friendly' ? 'team?tab=matches' : 'spieltag'}`} className="display rounded-xl bg-gold px-5 py-2 text-lg font-semibold uppercase text-ink">Weiter</Link>
        </div>
      </Card>
    </div>
  );
}

/** Einlauf: Countdown bis zum gemeinsamen Anpfiff, lokal überspringbar, Ton an/aus */
function WalkoutOverlay({ endsAt, skipped, onSkip, sound }: { endsAt: number; skipped: boolean; onSkip: () => void; sound: ReturnType<typeof useMatchAudio> }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(id); }, []);
  const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const [always, setAlways] = useState(prefs.alwaysSkip);
  return (
    <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 ${skipped ? 'top-0 justify-center rounded-xl bg-ink/55' : ''}`}>
      {skipped && <p className="display text-3xl font-extrabold uppercase">Anpfiff in {left} s</p>}
      {sound.line && !skipped && <p className="display rounded-lg bg-ink/70 px-4 py-1.5 text-center text-xl font-bold uppercase text-gold">{sound.line}</p>}
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-xl bg-ink/75 px-3 py-2 text-sm">
        {!skipped && <span className="display text-lg font-bold uppercase">Anpfiff in {left} s</span>}
        {!skipped && <Button variant="secondary" className="min-h-10 !px-3 !text-sm" onClick={onSkip}>Einlauf überspringen</Button>}
        <Button variant="ghost" className="min-h-10 !px-3 !text-sm" onClick={() => void (sound.on ? sound.mute() : sound.unlock())}>{sound.on ? '🔊 Ton aus' : '🔈 Ton an'}</Button>
        <label className="flex items-center gap-1.5 text-cream-dim"><input type="checkbox" checked={always} className="h-4 w-4 accent-[var(--fd-accent)]"
          onChange={(e) => { prefs.alwaysSkip = e.target.checked; setAlways(e.target.checked); if (e.target.checked) onSkip(); }} />Einlauf immer überspringen</label>
      </div>
      <p className="text-xs text-cream-dim">Der Anpfiff erfolgt für alle Manager gleichzeitig – Überspringen ändert nur deine Ansicht.</p>
    </div>
  );
}

/**
 * Stadionton (nur im Browser, kein Streaming über den Match-Server, keine Datenbankabfragen im Spiel):
 * Einlauf → Hymne des Heimvereins, danach Signatur-Fangesang; im Spiel Kulisse, Reaktionen und
 * zufällige Fangesänge über den zentralen Mixer. Verlassen der Seite oder Abpfiff ⇒ sanft aus.
 */
function useMatchAudio(state: MatchState | null, skipped: boolean, fixtureId: string) {
  const sound = useMemo(() => new MatchSound((p) => fanApi.publicUrl(p)), [fixtureId]);
  const [on, setOn] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const walkoutTrack = useRef<Track | null>(null);
  const played = useRef(false);
  const begun = useRef(false);
  const st = state?.stadium ?? null;
  const fans = st?.fans ?? null;

  const start = useCallback(async () => {
    if (!st) return false;
    // Gästeblock: etwa 8 % der Plätze (kleine Stadien relativ größer), Auslastung und Zuschauerzahl bestimmen den Pegel
    const att = st.attendance ?? st.capacity * 0.7;
    const awayShare = Math.min(0.15, Math.max(0.04, 2400 / Math.max(10000, st.capacity)));
    const ok = await mixer.start({ attendance: att, capacity: st.capacity, importance: st.atmosphere?.choreo ? 1 : 0.4, awayShare });
    setOn(ok); setNeedsUnlock(!ok);
    if (ok) mixer.setCrowd(0.55, 0.2); // Vorfreude vor dem Anpfiff (Einlauf)
    if (ok) prefs.sound = true;
    return ok;
  }, [st]);

  // Gesänge aus dem Match-Setup übernehmen (einmal je Spiel), Ton wie zuletzt gewählt starten
  useEffect(() => {
    if (!fans) return;
    sound.setChants((fans.audio.chants ?? []) as ChantRef[], (fans.away?.chants ?? []) as ChantRef[], { home: fans.home_club?.id ?? state?.teams?.home.clubId ?? null, away: fans.away?.id ?? state?.teams?.away.clubId ?? null });
    if (prefs.sound) void start();
  }, [fans, sound]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seite verlassen ⇒ alles sanft ausblenden; kein Ton im Menü
  useEffect(() => () => { walkoutTrack.current?.stop(0.4); sound.stop(0.6); }, [sound]);

  // Einlauf: Hymne, danach Signatur-Fangesang (bis zum Anpfiff); Kulisse wird dabei abgesenkt
  const endsAt = state?.walkoutEndsAt ?? null;
  useEffect(() => {
    if (!on || !endsAt || skipped || played.current || state?.status !== 'waiting' || !fans) return;
    played.current = true;
    const left = (endsAt - Date.now()) / 1000;
    const anthemSec = Math.max(4, Math.min(12, left * 0.6));
    let cancelled = false;
    let sig: ReturnType<typeof setTimeout> | undefined;
    mixer.ducking(0.5, 1);
    void (async () => {
      const a = fans.audio.anthem;
      if (a?.path) {
        const t = await mixer.play(fanApi.publicUrl(a.path), { channel: 'anthem', volume: a.volume, maxSec: anthemSec, fadeIn: 1 });
        if (cancelled) { t?.stop(0.3); return; }
        walkoutTrack.current = t;
        if (t) setLine(`♪ ${a.name}`);
      }
      sig = setTimeout(async () => {
        const g = fans.audio.signature;
        if (cancelled || !g?.path) return;
        walkoutTrack.current?.stop(1);
        const t2 = await mixer.play(fanApi.publicUrl(g.path), { channel: 'anthem', volume: g.volume, maxSec: Math.max(3, (endsAt - Date.now()) / 1000), fadeIn: 1 });
        walkoutTrack.current = t2;
        if (t2) setLine(`♪ ${g.name}`);
        mixer.push(0.8, 4);
      }, (a?.path ? anthemSec - 1 : 0) * 1000);
    })();
    return () => { cancelled = true; if (sig) clearTimeout(sig); };
  }, [on, endsAt, skipped, state?.status, fans]);

  // Anpfiff: Einlaufmusik ausblenden, Playlist starten
  useEffect(() => {
    if (state?.status === 'running' && on && !begun.current) {
      begun.current = true;
      walkoutTrack.current?.stop(1.2);
      walkoutTrack.current = null;
      setLine(null);
      mixer.ducking(1, 1.5);
      sound.begin();
    }
    if (state?.status === 'finished') sound.finish();
  }, [state?.status, on, sound]);

  return {
    sound, on, needsUnlock, line,
    unlock: async () => { const ok = await start(); if (ok && state?.status === 'running' && !begun.current) { begun.current = true; sound.begin(); } },
    mute: () => { walkoutTrack.current?.stop(0.3); sound.stop(0.4); setOn(false); prefs.sound = false; begun.current = false; },
    stopMusic: () => { walkoutTrack.current?.stop(0.6); walkoutTrack.current = null; setLine(null); mixer.ducking(1); },
  };
}

/** Lautstärke je Soundkategorie */
function MixerPanel({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState(() => mixer.getVolumes());
  return (
    <div className="absolute bottom-14 right-3 z-20 w-64 rounded-xl border border-olive-600 bg-ink/95 p-3 text-sm shadow-xl">
      <div className="mb-2 flex items-center justify-between"><span className="display font-bold uppercase">Ton</span><button type="button" onClick={onClose} aria-label="Schließen">✕</button></div>
      {CHANNELS.map((c) => (
        <label key={c.key} className="mb-1 block">
          <span className="text-xs text-cream-dim">{c.label}</span>
          <input type="range" min={0} max={1} step={0.05} value={v[c.key]} className="w-full accent-[var(--fd-accent)]"
            onChange={(e) => { const x = Number(e.target.value); mixer.setVolume(c.key, x); setV((o) => ({ ...o, [c.key]: x })); }} />
        </label>
      ))}
    </div>
  );
}
// Einlaufdauer: gleiche Konstante wie im Match-Server
void WALKOUT_MS;
