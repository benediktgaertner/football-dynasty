/**
 * E2E-Testseite (nur Dev-Server, nicht im Produktions-Build): echte Match-Komponenten
 * (MatchClient, MatchPitch, Einlauf-Overlay, Stadionton) gegen den E2E-Match-Server.
 * URL: /e2e/harness.html?fixture=home-anthem-ai&token=token-home-xxxx&server=ws://127.0.0.1:8791/match
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { MatchClient, type MatchState } from '../src/lib/matchClient';
import { MatchPitch } from '../src/components/match/MatchPitch';
import { WalkoutOverlay, useMatchAudio } from '../src/pages/Match';
import { mixer } from '../src/lib/audioMixer';
import { ConnectionBanner } from '../src/components/match/ConnectionBanner';

const q = new URLSearchParams(location.search);
const fixture = q.get('fixture') ?? 'home-anthem-ai';
const token = q.get('token') ?? 'token-home-xxxx';
const server = q.get('server') ?? 'ws://127.0.0.1:8791/match';
(window as unknown as { __fdDebug: boolean }).__fdDebug = true;

function App() {
  const client = useMemo(() => new MatchClient(server, fixture, { token: async () => token }), []);
  useEffect(() => { void client.connect(); return () => client.close(); }, [client]);
  const state = useSyncExternalStore((f) => client.subscribe(f), () => client.state) as MatchState;
  const sound = useMatchAudio(state, client, fixture, (p) => `/e2e/${p}`, q.get('crowd') ?? '/e2e/crowd-test/manifest.json', Number(q.get('ts') ?? 1));
  const [voted, setVoted] = useState(false);
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__fd = {
      state: () => ({ status: client.state.status, walkoutEndsAt: client.state.walkoutEndsAt, walkoutStartedAt: client.state.walkoutStartedAt,
        skip: client.state.walkoutSkip, events: (client.state.events as Array<{ type: string; side: string | null; tick: number }>).map((e) => ({ type: e.type, side: e.side, tick: e.tick })) }),
      mixer: () => mixer.debug(),
      sound: () => ({ situation: sound.sound.situation, home: sound.sound.envelope.home, away: sound.sound.envelope.away, busy: sound.sound.envelope.busy,
        songs: { home: sound.sound.songs.home.map((x) => x.id), away: sound.sound.songs.away.map((x) => x.id) },
        played: sound.sound.played.slice(), mood: sound.sound.mood ? { ...sound.sound.mood, row: sound.sound.mood.row.id } : null,
        decisions: sound.sound.scheduler.log.slice() }),
      force: (f: { minute?: number; homeScore?: number; awayScore?: number } | null) => { sound.sound.forceState = f; },
      pitch: () => (window as unknown as { __fdPitch?: unknown }).__fdPitch ?? null,
      leave: () => { root.unmount(); },
      // Test-Hilfen für Verbindungsabbrüche und Befehle
      /** Socket hart schließen (wie ein Netzabbruch); after = Funktion, die nach dem Senden eines Befehls sofort trennt */
      drop: () => { (client as unknown as { ws: WebSocket | null }).ws?.close(); },
      cmdThenDrop: (c: unknown) => { const p = client.command(c as Parameters<typeof client.command>[0]); (client as unknown as { ws: WebSocket | null }).ws?.close(); return p; },
      cmd: (c: unknown) => client.command(c as Parameters<typeof client.command>[0]),
      conn: () => ({ connection: client.state.connection, reconnect: client.state.reconnect, recoveredAt: client.state.recoveredAt, role: client.state.role, view: client.state.view ? { pendingSubs: client.state.view.pendingSubs, subsUsed: client.state.view.subsUsed, players: client.state.view.players.map((p) => ({ id: p.id, onPitch: p.onPitch, main: p.main, unavailable: p.unavailable })) } : null,
        score: client.state.latest?.score ?? null, tick: client.state.latest?.tick ?? 0 }),
      events: () => (client.state.events as Array<{ type: string; side: string | null; tick: number }>).map((e) => `${e.tick}:${e.type}:${e.side}`),
    };
  }, [client, sound]);
  if (!state.teams) return <p style={{ color: '#fff' }}>verbinde … {state.connection}</p>;
  const teams = state.teams;
  return (
    <div style={{ position: 'relative', width: 960 }}>
      <div style={{ aspectRatio: '1.45 / 1', width: 960 }}>
        <MatchPitch client={client} teams={teams} homeColor={teams.home.color} awayColor={teams.away.color} stadium={state.stadium}
          walkoutEndsAt={state.walkoutEndsAt} walkoutStartedAt={state.walkoutStartedAt} sound={sound.on ? sound.sound : null} />
      </div>
      {state.status === 'waiting' && state.walkoutEndsAt && (
        <WalkoutOverlay state={state} voted={voted} onSkip={() => { setVoted(true); client.skipWalkout(); }} sound={sound} />
      )}
      <ConnectionBanner state={state} client={client} />
      <div data-testid="status" style={{ color: '#fff' }}>{state.status}</div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
// ohne StrictMode: der Testclient soll genau eine Verbindung aufbauen
root.render(<App />);
