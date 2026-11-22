import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { MATCH_REAL_SECONDS, MATCH_VIRTUAL_MINUTES } from '@fd/shared';
import { bearerToken, verifyAccessToken } from './auth.js';
import { supabaseBackend } from './backend.js';
import { loadConfig } from './config.js';
import { attachMatchServer } from './wsServer.js';
import { createWorldSimulator } from './worldSim.js';

/**
 * Autoritativer Match-Server (Phase 5/6).
 *   GET /health  – Betriebsstatus für Fly.io-Healthchecks
 *   GET /whoami  – prüft das Supabase-Token
 *   WS  /match   – Live-Partien (siehe wsServer.ts / room.ts)
 *   POST /world/simulate?world=… – Spieltag sofort prüfen (zusätzlich läuft alle 10 s ein Sweep ohne Client)
 */
const config = loadConfig();
const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const startedAt = new Date();

function send(res: ServerResponse, status: number, body: unknown, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (origin && config.allowedOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'authorization, content-type';
    headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    headers['vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, null, origin);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, {
      status: 'ok',
      service: 'football-dynasty-match-server',
      startedAt: startedAt.toISOString(),
      engine: { virtualMinutes: MATCH_VIRTUAL_MINUTES, realSeconds: MATCH_REAL_SECONDS, implemented: true },
      rooms: match.rooms.size,
      clients: match.wss.clients.size,
      uptimeSeconds: Math.round(process.uptime()),
    }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/whoami') {
    const token = bearerToken(req.headers.authorization);
    if (!token) return send(res, 401, { error: 'missing_token' }, origin);
    const user = await verifyAccessToken(admin, token);
    if (!user) return send(res, 401, { error: 'invalid_token' }, origin);
    return send(res, 200, user, origin);
  }

  // B4/C8.5: Spieltag – Spiele ohne Live-Zuschauer headless berechnen (idempotent, je Welt ein Durchgang)
  if (req.method === 'POST' && url.pathname === '/world/simulate') {
    const token = bearerToken(req.headers.authorization);
    if (!token) return send(res, 401, { error: 'missing_token' }, origin);
    const user = await verifyAccessToken(admin, token);
    if (!user) return send(res, 401, { error: 'invalid_token' }, origin);
    const worldId = url.searchParams.get('world') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(worldId)) return send(res, 400, { error: 'invalid_world' }, origin);
    if (!(await backend.isMember(worldId, user.userId))) return send(res, 403, { error: 'forbidden' }, origin);
    const r = sim.trigger(worldId);
    return send(res, 202, { ...r, running: sim.isRunning(worldId) }, origin);
  }

  return send(res, 404, { error: 'not_found' }, origin);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('Unerwarteter Fehler', err);
    if (!res.headersSent) send(res, 500, { error: 'internal_error' });
  });
});
const backend = supabaseBackend(admin);
const match = attachMatchServer(server, backend, { allowedOrigins: config.allowedOrigins });
const sim = createWorldSimulator(backend, match.rooms, { worker: `${process.env.FLY_MACHINE_ID ?? hostname()}:${process.pid}` });
// Spieltagssteuerung ohne Client: KI-Spiele werden direkt nach dem Start des Spieltags berechnet,
// abgebrochene/fehlgeschlagene Partien automatisch erneut verarbeitet und die Freigabe nachgeholt.
sim.start(Number(process.env.SWEEP_INTERVAL_MS ?? 10_000));

server.listen(config.port, () => {
  console.log(`Match-Server läuft auf Port ${config.port}`);
});

// Letzte Absicherung: ein unerwarteter Fehler beendet nicht alle laufenden Partien und den Sweep
process.on('uncaughtException', (err) => { console.error('Nicht abgefangener Fehler', err); });
process.on('unhandledRejection', (err) => { console.error('Nicht behandeltes Promise', err); });

// Fly.io stoppt Maschinen per SIGTERM: offene Verbindungen sauber schließen
process.on('SIGTERM', () => {
  sim.stop();
  // Laufende Partien sichern: nach dem Neustart werden sie per Replay exakt fortgesetzt
  void Promise.allSettled([...match.rooms.values()].map((p) => p.then((r) => r.saveCheckpoint()))).then(() => {
    // Clients mit „Dienst startet neu“ (1012) verabschieden: sie verbinden sofort automatisch neu und laden den Stand nach
    for (const ws of match.wss.clients) { try { ws.close(1012, 'server_restart'); } catch { /* schon zu */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  });
  // Fly wartet laut fly.toml (kill_timeout) mindestens 15 s – Rückfall, falls die Datenbank hängt
  setTimeout(() => process.exit(0), 12_000).unref();
});
