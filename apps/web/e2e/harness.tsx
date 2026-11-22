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
      <div data-testid="status" style={{ color: '#fff' }}>{state.status}</div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
// ohne StrictMode: der Testclient soll genau eine Verbindung aufbauen
root.render(<App />);
