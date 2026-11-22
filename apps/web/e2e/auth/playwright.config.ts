import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { ANON_KEY } from './jwt';

/**
 * Login-E2E-Tests (E-Mail/Passwort, Umstellung anonymer Accounts, Passwort vergessen, mehrere Geräte).
 * Läuft gegen eine lokale PostgreSQL mit allen Migrationen und einen lokalen Ersatz für Supabase Auth/REST
 * (mockSupabase.ts) – kein Produktivprojekt, kein echter Mailversand.
 * Start: `npm run e2e:auth -w @fd/web`
 */
const chrome = process.env.PW_CHROME ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const MOCK = 'http://127.0.0.1:8793';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5198', viewport: { width: 1100, height: 900 }, launchOptions: { executablePath: chrome } },
  webServer: [
    { command: 'bash ../../scripts/auth-e2e-db.sh && npx tsx e2e/auth/mockSupabase.ts', cwd: '../..', url: `${MOCK}/__test/state?user=00000000-0000-0000-0000-000000000000`,
      reuseExistingServer: false, timeout: 180_000 },
    { command: 'npx vite --port 5198 --strictPort --host 127.0.0.1', cwd: '../..', url: 'http://127.0.0.1:5198/', reuseExistingServer: false, timeout: 60_000,
      env: { VITE_SUPABASE_URL: MOCK, VITE_SUPABASE_ANON_KEY: ANON_KEY } },
  ],
});
