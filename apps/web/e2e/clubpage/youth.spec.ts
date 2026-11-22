import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sign } from '../auth/jwt';

/** Jugendabteilung (Migration 0043): Seite mit gemockten RPCs – Anzeige, Ausbau, Übernahme, Rechte der Buttons, Tablet-Layout */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const overview = (o: Record<string, unknown> = {}) => ({
  level: 1, max_level: 5, intake: 2, upgrade_cost: 6_000_000, balance: 50_000_000, status: 'preseason', squad_size: 22,
  levels: [1, 2, 3, 4, 5].map((l) => ({ level: l, intake: [2, 3, 3, 4, 4][l - 1], cost: [null, 6e6, 15e6, 30e6, 55e6][l - 1] })),
  players: [
    { id: 'y1', name: 'Tim Neumann', age: 18, position: 'CM', overall: 58, nationality: 'GER', stars: 4, must_decide: false },
    { id: 'y2', name: 'Jan Kowalski', age: 16, position: 'GK', overall: 41, nationality: 'POL', stars: 2, must_decide: false },
    { id: 'y3', name: 'Leo Braun', age: 19, position: 'ST', overall: 61, nationality: 'GER', stars: 3, must_decide: true },
  ], ...o });

async function setup(page: Page, profiles: Record<string, unknown>, extra?: (u: string, body: any) => unknown) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })] as const);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    if (u.includes('/rpc/club_profile')) {
      const id = (r.request().postDataJSON() as { p_club: string }).p_club;
      const p = profiles[id];
      return p ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p) })
        : r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'Kein Zugriff.' }) });
    }
    const x = extra?.(u, r.request().postDataJSON());
    if (x !== undefined) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  return errors;
}

test('Jugend: Übersicht, Ausbau (Bestätigung), Übernahme; keine Laufzeitfehler', async ({ page }) => {
  let level = 1; const calls: string[] = [];
  const errors = await setup(page, {}, (u, b) => {
    if (u.includes('/rpc/youth_overview')) return overview({ level, upgrade_cost: level >= 5 ? null : 6e6 });
    if (u.includes('/rpc/youth_upgrade')) { level += 1; calls.push('upgrade'); return { level, cost: 6e6 }; }
    if (u.includes('/rpc/youth_promote')) { calls.push('promote:' + b.p_youth); return { player_id: 'p1' }; }
    return undefined;
  });
  page.on('dialog', (d) => void d.accept());
  await page.goto(`/w/${WORLD}/jugend`);
  await expect(page.getByTestId('youth-level')).toContainText('Stufe 1');
  await expect(page.getByTestId('youth-table').getByRole('row')).toHaveCount(4);
  await expect(page.getByText('Entscheidung fällig')).toBeVisible();
  await expect(page.getByRole('button', { name: /In den Kader/ }).nth(1)).toBeDisabled(); // 16-Jähriger noch nicht
  await page.getByTestId('youth-upgrade').click();
  await expect(page.getByText('Jugendabteilung ausgebaut.')).toBeVisible();
  await expect(page.getByTestId('youth-level')).toContainText('Stufe 2');
  await page.getByRole('button', { name: /In den Kader/ }).first().click();
  await expect(page.getByText(/spielt jetzt im Profikader/)).toBeVisible();
  expect(calls).toEqual(['upgrade', 'promote:y1']);
  expect(errors).toEqual([]);
});

test('Jugend: Ausbau außerhalb der Vorbereitung gesperrt, höchste Stufe, Fehlermeldung statt schwarzem Bildschirm', async ({ page }) => {
  let mode = 'season';
  const errors = await setup(page, {}, (u) => {
    if (u.includes('/rpc/youth_overview')) return mode === 'season' ? overview({ status: 'season' }) : overview({ level: 5, upgrade_cost: null, players: [] });
    return undefined;
  });
  await page.goto(`/w/${WORLD}/jugend`);
  await expect(page.getByTestId('youth-upgrade')).toBeDisabled();
  await expect(page.getByText('nur in der Vorbereitung')).toBeVisible();
  mode = 'max';
  await page.reload();
  await expect(page.getByText('Höchste Stufe erreicht')).toBeVisible();
  await expect(page.getByText('Noch keine Jugendspieler')).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('iPad', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  test('Jugend auf dem iPad: kein horizontales Überlaufen der Seite', async ({ page }) => {
    await setup(page, {}, (u) => (u.includes('/rpc/youth_overview') ? overview() : undefined));
    await page.goto(`/w/${WORLD}/jugend`);
    await expect(page.getByTestId('youth-level')).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });
});
