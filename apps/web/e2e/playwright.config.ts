import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * E2E-Tests der Matchansicht (Einlauf, Hymne, Überspringen, Torjubel, Fankurve) gegen einen echten
 * Match-Server mit Test-Backend. Start: `npm run e2e -w @fd/web` (startet Vite + Match-Server selbst).
 * Browser: lokal installiertes Chrome (PW_CHROME) oder Playwright-Chromium.
 */
const chrome = process.env.PW_CHROME ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    viewport: { width: 1100, height: 900 },
    launchOptions: {
      executablePath: chrome,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--mute-audio'],
    },
  },
  webServer: [
    { command: 'npx vite --port 5199 --strictPort --host 127.0.0.1', cwd: '..', url: 'http://127.0.0.1:5199/e2e/harness.html', reuseExistingServer: true, timeout: 60_000 },
    { command: 'npx tsx e2e/server.ts', cwd: '../../match-server', url: 'http://127.0.0.1:8791/health', reuseExistingServer: true, timeout: 60_000,
      env: { E2E_MATCH_PORT: '8791', E2E_ORIGIN: 'http://127.0.0.1:5199' } },
  ],
});
