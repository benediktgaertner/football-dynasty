import { STARTING_CAPITAL, type Difficulty } from '@fd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, DIFFICULTY_LABEL, draftApi, formatEuro, type LobbyState } from '../lib/api';
import { requireSupabase } from '../lib/supabase';
import { Crest } from '../components/Crest';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';

/**
 * B2.9–B2.10: Lobby einer Karrierewelt. Der Zustand kommt ausschließlich vom Server
 * (lobby_state); Supabase Realtime meldet nur, dass sich etwas geändert hat.
 */
export function Lobby() {
  const { worldId = '' } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<LobbyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refetchTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setState(await api.lobbyState(worldId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [worldId]);

  useEffect(() => {
    void load();
    const sb = requireSupabase();
    const schedule = () => {
      window.clearTimeout(refetchTimer.current);
      refetchTimer.current = window.setTimeout(() => void load(), 150);
    };
    const channel = sb.channel(`lobby:${worldId}`);
    for (const table of ['world_members', 'clubs', 'club_branding', 'stadiums', 'multiplayer_readiness']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `world_id=eq.${worldId}` }, schedule);
    }
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'career_worlds', filter: `id=eq.${worldId}` }, schedule);
    channel.subscribe();

    // B4: Anwesenheit für Timeout-Regeln; Neuladen beim Zurückkehren in den Tab
    void api.touchPresence(worldId).catch(() => undefined);
    const ping = window.setInterval(() => void api.touchPresence(worldId).catch(() => undefined), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(ping);
      window.clearTimeout(refetchTimer.current);
      document.removeEventListener('visibilitychange', onVisible);
      void sb.removeChannel(channel);
    };
  }, [worldId, load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (state && state.world.status === 'draft') navigate(`/w/${worldId}/draft`, { replace: true });
    else if (state && (state.world.status === 'season' || state.world.status === 'season_end')) navigate(`/w/${worldId}/spieltag`, { replace: true });
    else if (state && state.world.status !== 'lobby') navigate(`/w/${worldId}/team`, { replace: true });
  }, [state, worldId, navigate]);

  if (!state) {
    return <Shell>{error ? <ErrorBanner error={error} /> : <Spinner label="Lobby wird geladen …" />}</Shell>;
  }

  const me = state.members.find((m) => m.user_id === state.me.user_id);
  const isHost = state.me.role === 'host';
  const inLobby = state.world.status === 'lobby';
  const myClub = me?.club ?? null;
  const readyCount = state.members.filter((m) => m.ready && m.club).length;

  return (
    <Shell right={<Link to="/" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Übersicht</Link>}>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="space-y-6">
          <Card className="pitch-stripes">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Karrierewelt</p>
                <h1 className="display text-5xl font-extrabold uppercase leading-none">{state.world.name}</h1>
              </div>
              <div className="text-right">
                <p className="display text-sm font-semibold uppercase tracking-wider text-cream-dim">Einladungscode</p>
                <button
                  type="button"
                  className="display rounded-xl bg-anthracite px-4 py-1 text-4xl font-extrabold tracking-[0.3em] text-gold hover:bg-ink"
                  onClick={() => {
                    void navigator.clipboard?.writeText(state.world.invite_code).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                  title="Kopieren"
                >
                  {state.world.invite_code}
                </button>
                <p className="h-5 text-sm text-cream-dim">{copied ? 'Kopiert!' : 'Tippen zum Kopieren'}</p>
              </div>
            </div>
          </Card>

          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="display text-2xl font-bold uppercase">Manager</h2>
              <Pill tone={state.all_ready ? 'good' : 'neutral'}>
                {readyCount}/{state.members.length} bereit
              </Pill>
            </div>
            <ul className="divide-y divide-olive-700/70">
              {state.members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-4 py-3">
                  {m.club ? <Crest crest={m.club.crest} size={44} /> : <div className="h-[53px] w-11 rounded-lg border border-dashed border-olive-600" />}
                  <div className="min-w-0 flex-1">
                    <div className="display truncate text-xl font-bold">{m.club ? m.club.name : 'Noch kein Verein'}</div>
                    <div className="truncate text-sm text-cream-dim">
                      {m.username}
                      {m.role === 'host' && ' · Host'}
                      {m.club && ` · ${m.club.stadium_name} (${m.club.stadium_capacity.toLocaleString('de-DE')})`}
                    </div>
                  </div>
                  {m.club && (
                    <div className="hidden gap-1 sm:flex" aria-label="Vereinsfarben">
                      {[m.club.primary_color, m.club.secondary_color, m.club.accent_color].map((c, i) => (
                        <span key={i} className="h-5 w-5 rounded-full border border-ink" style={{ background: c }} />
                      ))}
                    </div>
                  )}
                  <Pill tone={m.ready ? 'good' : 'warn'}>{m.ready ? 'Bereit' : 'Wartet'}</Pill>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <aside className="space-y-6">
          <Card>
            <h2 className="display mb-3 text-2xl font-bold uppercase">Dein Verein</h2>
            {myClub ? (
              <div className="flex items-center gap-4">
                <Crest crest={myClub.crest} size={72} />
                <div>
                  <div className="display text-2xl font-bold">{myClub.name}</div>
                  <div className="text-sm text-cream-dim">{myClub.short_name}</div>
                </div>
              </div>
            ) : (
              <p className="text-cream-dim">Gründe deinen Verein mit Namen, Farben, Wappen, Trikot und Stadion.</p>
            )}
            {inLobby && (
              <Button variant={myClub ? 'secondary' : 'primary'} className="mt-4 w-full" onClick={() => navigate(`/w/${worldId}/verein`)}>
                {myClub ? 'Verein bearbeiten' : 'Verein gründen'}
              </Button>
            )}
          </Card>

          <Card>
            <h2 className="display mb-3 text-2xl font-bold uppercase">Schwierigkeit</h2>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={!isHost || !inLobby || busy !== null}
                  onClick={() => void act('difficulty', () => api.setDifficulty(worldId, d))}
                  className={`rounded-xl border px-2 py-3 text-center transition ${
                    state.world.difficulty === d ? 'border-gold bg-gold/10 text-cream' : 'border-olive-600 text-cream-dim'
                  } ${isHost && inLobby ? 'hover:border-gold/70' : 'cursor-default'}`}
                >
                  <div className="display text-lg font-bold uppercase">{DIFFICULTY_LABEL[d]}</div>
                  <div className="text-sm">{formatEuro(STARTING_CAPITAL[d])}</div>
                </button>
              ))}
            </div>
            <p className="mt-3 text-sm text-cream-dim">
              {isHost ? 'Nur du als Host legst die Schwierigkeit fest. Sie ändert ausschließlich das Startkapital.' : 'Der Host legt die Schwierigkeit fest.'}
            </p>
            {myClub && (
              <dl className="mt-4 space-y-1 text-sm">
                <div className="flex justify-between"><dt className="text-cream-dim">Startkapital</dt><dd>{formatEuro(state.world.starting_capital)}</dd></div>
                <div className="flex justify-between"><dt className="text-cream-dim">Stadionbau</dt><dd>− {formatEuro(myClub.stadium_cost)}</dd></div>
                <div className="flex justify-between border-t border-olive-700 pt-1 font-semibold"><dt>Budget für den Draft</dt><dd className="text-gold">{formatEuro(state.world.starting_capital - myClub.stadium_cost)}</dd></div>
              </dl>
            )}
          </Card>

          {inLobby ? (
            <Card>
              <Button
                className="w-full"
                variant={me?.ready ? 'secondary' : 'primary'}
                disabled={!myClub}
                busy={busy === 'ready'}
                onClick={() => void act('ready', () => api.setReady(worldId, !me?.ready))}
              >
                {me?.ready ? 'Bereitschaft zurückziehen' : 'Ich bin bereit'}
              </Button>
              {isHost && (
                <Button
                  className="mt-3 w-full"
                  disabled={!state.all_ready}
                  busy={busy === 'start'}
                  onClick={() => void act('start', () => draftApi.start(worldId))}
                >
                  Draft starten
                </Button>
              )}
              <p className="mt-3 text-sm text-cream-dim">
                {state.all_ready
                  ? isHost
                    ? 'Alle Manager sind bereit. Beim Start entstehen die 54 Vereine der drei Ligen und der Pool mit 400 Spielern. Das dauert einige Sekunden.'
                    : 'Alle Manager sind bereit. Der Host kann jetzt den Draft starten.'
                  : 'Der Draft kann beginnen, sobald alle Manager ihren Verein gegründet und bestätigt haben.'}
              </p>
              {!isHost && (
                <Button variant="danger" className="mt-4 w-full" busy={busy === 'leave'} onClick={() => void act('leave', async () => { await api.leaveWorld(worldId); navigate('/'); })}>
                  Lobby verlassen
                </Button>
              )}
            </Card>
          ) : (
            <Card>
              <p className="text-cream-dim">Diese Karrierewelt hat die Lobby verlassen (Status: {state.world.status}).</p>
            </Card>
          )}
          <ErrorBanner error={error} />
        </aside>
      </div>
    </Shell>
  );
}
