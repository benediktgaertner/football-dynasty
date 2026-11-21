// Startet den Match-Server mit Test-Backend für Playwright (Echtzeit). Port: E2E_MATCH_PORT (Standard 8791).
import { createServer } from 'node:http';
import { attachMatchServer } from '../src/wsServer.js';
import { makeBackend } from './fixtures.js';

const port = Number(process.env.E2E_MATCH_PORT ?? 8791);
const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
attachMatchServer(server, makeBackend(), { allowedOrigins: [process.env.E2E_ORIGIN ?? 'http://127.0.0.1:5199'], speed: 1 });
server.listen(port, '127.0.0.1', () => console.log(`E2E-Match-Server auf ${port}`));
