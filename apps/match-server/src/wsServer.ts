import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { MatchCommand } from '@fd/engine';
import type { Backend } from './backend.js';
import { clientMessageSchema } from './protocol.js';
import { MatchRoom, type Client } from './room.js';

/**
 * WebSocket-Endpunkt /match. Ablauf:
 * 1. Client verbindet und sendet {t:'hello', token, fixtureId}
 * 2. Server prüft Token (Supabase Auth) und Rolle (clubs.manager_user_id) → home/away/spectator
 * 3. Server lädt/öffnet den Raum und schickt {t:'init'}; danach Snapshots mit 10 Hz
 */
export function attachMatchServer(server: Server, backend: Backend, opts: { allowedOrigins: string[]; speed?: number }) {
  const rooms = new Map<string, Promise<MatchRoom>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (url.pathname !== '/match' || (origin && !opts.allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  const getRoom = (fixtureId: string): Promise<MatchRoom> => {
    let p = rooms.get(fixtureId);
    if (!p) {
      const room = new MatchRoom(fixtureId, backend, () => rooms.delete(fixtureId), opts.speed ?? 1);
      p = room.load().then(() => room);
      p.catch(() => rooms.delete(fixtureId));
      rooms.set(fixtureId, p);
    }
    return p;
  };

  wss.on('connection', (ws: WebSocket) => {
    let client: Client | null = null;
    let room: MatchRoom | null = null;
    let busy = false;
    // ohne Fehler-Listener würde ein Socketfehler (z. B. ECONNRESET) als unbehandelte Ausnahme enden
    ws.on('error', () => { /* close folgt */ });
    const fail = (message: string, code = 4000, transient = false) => {
      try { ws.send(JSON.stringify({ t: 'error', message, transient })); ws.close(code, message.slice(0, 100)); } catch { /* Socket schon zu */ }
    };
    const helloTimeout = setTimeout(() => { if (!client) fail('Keine Anmeldung.', 4001); }, 10_000);
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) ws.terminate(); alive = false; ws.ping(); }, 20_000);

    ws.on('message', async (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { return fail('Ungültige Nachricht.'); }
      const msg = clientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        if (client) return ws.send(JSON.stringify({ t: 'error', message: 'Ungültiger Befehl.' }));
        return fail('Ungültige Nachricht.');
      }
      const m = msg.data;
      if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', at: Date.now() }));
      if (m.t === 'hello') {
        if (client || busy) return;
        busy = true;
        try {
          const userId = await backend.verifyToken(m.token);
          if (!userId) return fail('Sitzung ungültig oder abgelaufen.', 4401);
          const role = await backend.role(m.fixtureId, userId);
          if (!role) return fail('Kein Zugriff auf dieses Spiel.', 4403);
          // Laden des Spiels darf nicht hängen bleiben (z. B. Datenbank langsam)
          room = await Promise.race([
            getRoom(m.fixtureId),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('room_load_timeout')), 20_000)),
          ]);
          // Raum wurde gerade geschlossen (Abpfiff + 30 s): frisch laden statt in einen toten Raum zu laufen
          if (room.closed) { rooms.delete(m.fixtureId); room = await getRoom(m.fixtureId); }
          if (ws.readyState !== 1) return;
          client = { ws, userId, role, cmdWindow: [], sid: m.sid };
          clearTimeout(helloTimeout);
          room.join(client, m.since ?? 0);
        } catch (e) {
          const message = e instanceof Error && /already_finished/.test(e.message) ? 'Das Spiel ist bereits beendet. Das Ergebnis siehst du nach der Freigabe am Spieltag.'
            : e instanceof Error && /slot_not_live|not_current/.test(e.message) ? 'Dieses Spiel ist gerade nicht angesetzt.'
            : 'Spiel konnte nicht geladen werden. Bitte neu verbinden.';
          const transient = !(e instanceof Error && /already_finished|slot_not_live|not_current/.test(e.message));
          console.error('hello fehlgeschlagen', e);
          // vorübergehende Fehler (Datenbank, Neustart): Client verbindet automatisch neu
          return fail(message, transient ? 4502 : 4500, transient);
        } finally {
          busy = false;
        }
        return;
      }
      if (!client || !room) return fail('Bitte zuerst anmelden.', 4001);
      if (m.t === 'start') return room.handleStart(client);
      if (m.t === 'skip_walkout') return room.handleSkipWalkout(client);
      if (m.t === 'anthem') return room.handleAnthemDuration(client, m.durationMs);
      if (m.t === 'cmd') return room.handleCommand(client, m.id, m.cmd as MatchCommand);
    });
    ws.on('close', () => {
      clearTimeout(helloTimeout);
      clearInterval(heartbeat);
      if (client && room) room.leave(client);
    });
  });

  return { rooms, wss };
}
