import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { ANON_KEY } from '../auth/jwt';
const chrome = process.env.PW_CHROME ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
/** Vereinsprofil-Tests: Supabase vollständig per page.route gemockt (Daten aus echter club_profile-Ausgabe) */
export default defineConfig({
  testDir: '.', testMatch: /.*\.spec\.ts/, timeout: 60_000, workers: 1, reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5199', launchOptions: { executablePath: chrome } },
  webServer: { command: process.env.PREVIEW ? 'npx vite build >/dev/null && npx vite preview --port 5199 --strictPort --host 127.0.0.1' : 'npx vite --port 5199 --strictPort --host 127.0.0.1', cwd: '../..', url: 'http://127.0.0.1:5199/', reuseExistingServer: false, timeout: 180_000,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:8798', VITE_SUPABASE_ANON_KEY: ANON_KEY } },
});
