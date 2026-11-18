import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { MATCH_REAL_SECONDS, MATCH_VIRTUAL_MINUTES } from '@fd/shared';
import { bearerToken, verifyAccessToken } from './auth.js';
import { loadConfig } from './config.js';

/**
 * Autoritativer Match-Server (Phase 1: Grundgerüst).
 *
 * Bereits umgesetzt:
 *   GET /health  – Betriebsstatus für Fly.io-Healthchecks
 *   GET /whoami  – prüft das Supabase-Token und gibt die Benutzer-ID zurück
 *
 * Folgt in Phase 5/6 (siehe docs/ARCHITECTURE.md): Colyseus-MatchRoom mit 20-Hz-Simulation,
 * Headless-Modus für KI-Partien, Ereignis-Persistenz und Wiederverbindung.
 * Es gibt hier bewusst noch keinen Endpunkt, der eine Partie nur vortäuscht.
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
      engine: { virtualMinutes: MATCH_VIRTUAL_MINUTES, realSeconds: MATCH_REAL_SECONDS, implemented: false },
    }, origin);
  }

  if (req.method === 'GET' && url.pathname === '/whoami') {
    const token = bearerToken(req.headers.authorization);
    if (!token) return send(res, 401, { error: 'missing_token' }, origin);
    const user = await verifyAccessToken(admin, token);
    if (!user) return send(res, 401, { error: 'invalid_token' }, origin);
    return send(res, 200, user, origin);
  }

  return send(res, 404, { error: 'not_found' }, origin);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    console.error('Unerwarteter Fehler', err);
    if (!res.headersSent) send(res, 500, { error: 'internal_error' });
  });
});

server.listen(config.port, () => {
  console.log(`Match-Server läuft auf Port ${config.port}`);
});

// Fly.io stoppt Maschinen per SIGTERM: offene Verbindungen sauber schließen
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
});
