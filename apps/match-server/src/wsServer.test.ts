import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildTestTeam, type MatchResult } from '@fd/engine';
import type { Backend } from './backend.js';
import type { DbSetup, DbTeam } from './setup.js';
import { attachMatchServer } from './wsServer.js';

function dbTeam(seed: string, control: 'human' | 'ai', manager: string | null): DbTeam {
  const t = buildTestTeam(seed, 70, { control });
  return {
    clubId: t.clubId, name: t.name, shortName: 'TST', control, managerUserId: manager, color: '#123456', colorAlt: '#ffffff', capacity: 30000,
    squad: t.squad.map((p) => ({ ...p, unavailable: false })), settings: t.settings,
    profiles: Object.fromEntries(Object.entries(t.profiles).map(([k, v]) => [k, { ...v }])) as DbTeam['profiles'], setPieces: {},
  };
}

const finished: Array<{ id: string; result: MatchResult }> = [];
const checkpoints: Array<{ tick: number; data: unknown }> = [];
const users: Record<string, string> = { 'token-home-xxxx': 'u-home', 'token-away-xxxx': 'u-away', 'token-fan-xxxxx': 'u-fan' };
let stored: DbSetup['checkpoint'] = null;
const backend: Backend = {
  async verifyToken(t) { return users[t] ?? null; },
  async role(_f, u) { return u === 'u-home' ? 'home' : u === 'u-away' ? 'away' : u === 'u-fan' ? 'spectator' : null; },
  async setup(f) {
    // league-ai-*: Gegner ist KI · league-anthem-*: Heimhymne 30 s gespeichert · league-measure-*: Hymne ohne gespeicherte Länge
    const anthem = f.startsWith('league-anthem') ? { path: 'w/c/a.mp3', duration: 30 } : f.startsWith('league-measure') ? { path: 'w/c/a.mp3', duration: null } : null;
    return { fixtureId: f, worldId: 'w', seed: `seed-${f}`, kind: f.startsWith('league') ? 'league' : 'friendly', neutral: false,
      home: dbTeam('h', 'human', 'u-home'), away: dbTeam('a', f.startsWith('league-ai') ? 'ai' : 'human', f.startsWith('league-ai') ? null : 'u-away'),
      stadium: anthem ? { name: 'S', capacity: 30000, design: {}, attendance: 20000, fans: { audio: { anthem } } } : null,
      checkpoint: f === 'resume' ? stored : null } as DbSetup;
  },
  async checkpoint(f, tick, data) { if (!f.startsWith('league-')) checkpoints.push({ tick, data }); },
  async finish(id, result) { finished.push({ id, result }); },
  async pendingFixtures() { return []; },
  async isMember() { return true; },
  async claim() { return { ok: true, attempts: 1 }; },
  async failed() {},
  async fallback() {},
  async dueWorlds() { return []; },
  async sweep() { return { pending: [] }; },
};

let server: Server;
let url = '';
beforeAll(async () => {
  server = createServer();
  attachMatchServer(server, backend, { allowedOrigins: ['http://ok.test'], speed: 40 });
  await new Promise<void>((r) => server.listen(0, r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/match`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

interface Conn { ws: WebSocket; msgs: any[]; wait: (pred: (m: any) => boolean, ms?: number) => Promise<any>; send: (m: unknown) => void }
function connect(token: string, fixtureId: string, origin = 'http://ok.test'): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin } });
    const msgs: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    });
    const conn: Conn = {
      ws, msgs,
      send: (m) => ws.send(JSON.stringify(m)),
      wait: (pred, ms = 15000) => new Promise((res, rej) => {
        const hit = msgs.find(pred);
        if (hit) return res(hit);
        const t = setTimeout(() => rej(new Error('timeout')), ms);
        waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
      }),
    };
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', token, fixtureId })); resolve(conn); });
    ws.on('error', reject);
  });
}

describe('Match-Server (echte WebSocket-Clients)', () => {
  it('Pflichtspiel: Einlaufzeremonie für alle gleich, Anpfiff serverseitig (Start-Befehl beschleunigt nichts)', async () => {
    const home = await connect('token-home-xxxx', 'league-1');
    const ih = await home.wait((m) => m.t === 'init');
    expect(ih.status).toBe('waiting');
    expect(ih.walkoutMs).toBeGreaterThan(0);
    const t0 = Date.now();
    home.send({ t: 'start' });
    const fan = await connect('token-fan-xxxxx', 'league-1');
    const iff = await fan.wait((m) => m.t === 'init');
    expect(iff.walkoutMs).toBeLessThanOrEqual(ih.walkoutMs);
    await Promise.all([home.wait((m) => m.t === 'status' && m.status === 'running'), fan.wait((m) => m.t === 'status' && m.status === 'running')]);
    // 20 s Einlauf bei 40-facher Testgeschwindigkeit = 500 ms; der Start-Befehl darf nicht vorziehen
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    home.ws.close(); fan.ws.close();
  });

  it('Hymne: Einlauf dauert die volle Hymnenlänge (+ Ausklang)', async () => {
    const home = await connect('token-home-xxxx', 'league-anthem-1');
    const ih = await home.wait((m) => m.t === 'init');
    // 30 s Hymne + 2,5 s bei 40-facher Testgeschwindigkeit ≈ 812 ms (statt 500 ms Standard)
    expect(ih.walkoutTotalMs).toBeGreaterThan(780);
    home.ws.close();
  });

  it('Hymne ohne gespeicherte Länge: Heim-Manager meldet sie, Einlauf wird verlängert', async () => {
    const home = await connect('token-home-xxxx', 'league-measure-1');
    const ih = await home.wait((m) => m.t === 'init');
    expect(ih.walkoutTotalMs).toBe(500);
    home.send({ t: 'anthem', durationMs: 90_000 });
    const w = await home.wait((m) => m.t === 'walkout' && (m.totalMs as number) > 1000);
    expect(w.totalMs).toBeGreaterThan(2300); // (90 s + 2,5 s) / 40
    home.ws.close();
  });

  it('KI-Partie: Hymne sofort überspringbar', async () => {
    const home = await connect('token-home-xxxx', 'league-ai-anthem-1');
    await home.wait((m) => m.t === 'init');
    const t0 = Date.now();
    home.send({ t: 'skip_walkout' });
    await home.wait((m) => m.t === 'status' && m.status === 'running');
    expect(Date.now() - t0).toBeLessThan(300);
    home.ws.close();
  });

  it('Multiplayer: Überspringen nur gemeinsam', async () => {
    const home = await connect('token-home-xxxx', 'league-anthem-mp');
    const away = await connect('token-away-xxxx', 'league-anthem-mp');
    await home.wait((m) => m.t === 'init'); await away.wait((m) => m.t === 'init');
    home.send({ t: 'skip_walkout' });
    const w = await away.wait((m) => m.t === 'walkout' && (m.skipVotes as string[]).includes('home'));
    expect(w.skipNeeded).toEqual(['home', 'away']);
    await new Promise((r) => setTimeout(r, 150));
    expect(home.msgs.some((m) => m.t === 'status' && m.status === 'running')).toBe(false);
    const t0 = Date.now();
    away.send({ t: 'skip_walkout' });
    await Promise.all([home.wait((m) => m.t === 'status' && m.status === 'running'), away.wait((m) => m.t === 'status' && m.status === 'running')]);
    expect(Date.now() - t0).toBeLessThan(300);
    home.ws.close(); away.ws.close();
  });

  it('lehnt fremde Origins und ungültige Tokens ab', async () => {
    await expect(connect('token-home-xxxx', 'f0', 'http://evil.test')).rejects.toThrow();
    const c = await connect('token-unknown-x', 'f0');
    const err = await c.wait((m) => m.t === 'error');
    expect(err.message).toMatch(/Sitzung/);
  });

  it('zwei Manager + Zuschauer sehen dieselbe Partie, Befehle werden bestätigt, Ergebnis wird gespeichert', async () => {
    const home = await connect('token-home-xxxx', 'f1');
    const away = await connect('token-away-xxxx', 'f1');
    const fan = await connect('token-fan-xxxxx', 'f1');
    const ih = await home.wait((m) => m.t === 'init');
    const ia = await away.wait((m) => m.t === 'init');
    const iff = await fan.wait((m) => m.t === 'init');
    expect(ih.role).toBe('home'); expect(ia.role).toBe('away'); expect(iff.role).toBe('spectator');
    expect(iff.view).toBeNull();
    expect(ih.view.players.length).toBeGreaterThan(11);

    // Zuschauer dürfen nichts ändern
    fan.send({ t: 'cmd', id: 1, cmd: { kind: 'profile', name: 'offensive' } });
    expect((await fan.wait((m) => m.t === 'ack' && m.id === 1)).ok).toBe(false);

    home.send({ t: 'start' });
    await home.wait((m) => m.t === 'status' && m.status === 'running');
    await fan.wait((m) => m.t === 'frame' && m.s.tick > 300);

    home.send({ t: 'cmd', id: 7, cmd: { kind: 'profile', name: 'offensive' } });
    const ack = await home.wait((m) => m.t === 'ack' && m.id === 7);
    expect(ack.ok).toBe(true);
    expect(ack.tick).toBeGreaterThan(0);
    home.send({ t: 'cmd', id: 8, cmd: { kind: 'sub', outId: 'nope', inId: 'nope2' } });
    expect((await home.wait((m) => m.t === 'ack' && m.id === 8)).ok).toBe(false);
    home.send({ t: 'cmd', id: 9, cmd: { kind: 'hack' } });
    await home.wait((m) => m.t === 'error' && /Ungültiger Befehl/.test(m.message));

    // Gast trennt Verbindung ⇒ Automatik, verbindet sich wieder ⇒ Zustand kommt mit init
    away.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const away2 = await connect('token-away-xxxx', 'f1');
    const re = await away2.wait((m) => m.t === 'init');
    expect(re.status).toBe('running');
    expect(re.snapshot.tick).toBeGreaterThan(300);

    const endH = await home.wait((m) => m.t === 'end', 20000);
    const endF = await fan.wait((m) => m.t === 'end', 20000);
    expect(endH.result.score).toEqual(endF.result.score);
    expect(endH.saved).toBe(true);
    expect(finished.find((f) => f.id === 'f1')!.result.score).toEqual(endH.result.score);
    expect(checkpoints.length).toBeGreaterThan(5);
    // Beide Manager und der Zuschauer erhalten denselben Bildstrom
    const sig = (c: Conn) => c.msgs.filter((m) => m.t === 'frame' && m.s.tick > 400 && m.s.tick < 2000).map((m) => `${m.s.tick}:${m.s.score}:${m.s.ball}`).join('|');
    expect(sig(home).length).toBeGreaterThan(0);
    expect(sig(home)).toBe(sig(fan));
    // Protokoll enthält den Profilwechsel und den Automatik-Wechsel
    const last = checkpoints.at(-1)!.data as { log: Array<{ cmd: { kind: string } }> };
    expect(last.log.some((r) => r.cmd.kind === 'profile')).toBe(true);
    expect(last.log.some((r) => r.cmd.kind === 'autopilot')).toBe(true);
    for (const c of [home, away2, fan]) c.ws.close();
  }, 30000);

  it('setzt eine Partie nach Neustart aus dem Checkpoint exakt fort', async () => {
    stored = checkpoints.find((c) => c.tick >= 800)!.data as DbSetup['checkpoint'];
    const c = await connect('token-home-xxxx', 'resume');
    const init = await c.wait((m) => m.t === 'init');
    expect(init.status).toBe('running');
    expect(init.snapshot.tick).toBeGreaterThanOrEqual(stored!.tick);
    c.ws.close();
  });
});
