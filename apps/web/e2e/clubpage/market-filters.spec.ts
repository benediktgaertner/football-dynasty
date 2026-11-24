import { expect, test } from '@playwright/test';
import { sign } from '../auth/jwt';

/** Transfermarkt: Filter, Seite und Scrollposition bleiben nach dem Besuch eines Spielerprofils erhalten (RPCs gemockt) */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const player = (i: number) => ({ id: `p${i}`, first_name: 'Max', last_name: `Spieler${i}`, age: 24, main_position: 'ST', overall: 80 - (i % 10), market_value: 5_000_000, nationality: 'GER', club: null, salary: null });

test('Transfermarkt: Filter, Seite und Scrollposition überleben Profil und Zurück; Zurücksetzen löscht', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const searches: Array<{ filters: any; offset: number }> = [];
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })]);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    const m = /\/rpc\/([a-z_]+)/.exec(u);
    const json = (b: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m) {
      let body: any = null; try { body = r.request().postDataJSON(); } catch { /* leer */ }
      if (m[1] === 'transfer_market_search') {
        searches.push({ filters: body?.p_filters ?? body, offset: body?.p_offset ?? 0 });
        const off = body?.p_offset ?? 0;
        return json({ total: 120, rows: Array.from({ length: 50 }, (_, i) => player(off + i)) });
      }
      if (m[1] === 'matchday_state') return json({ window: { open: false, window_no: 1, until_matchday: 5, signings: 0, max_signings: 5, sales: 0, max_sales: 5 }, my_club: 'c1', slot: null, fixtures: [] });
      if (m[1] === 'finance_overview') return json({ balance: 1000000 });
      if (m[1] === 'transfer_market_options') return json({ countries: [], leagues: [], clubs: [] });
      if (m[1] === 'europe_market_status') return json({ associations: 55, total: 55, world_status: 'season' });
      return json(m[1] === 'my_transfer_offers' ? [] : null);
    }
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto(`/w/${WORLD}/transfers`);
  await expect(page.getByText('Spieler0').first()).toBeVisible();
  await page.getByLabel('Position').selectOption('ST');
  await page.getByPlaceholder(/name/i).first().fill('Spieler').catch(() => undefined);
  await page.getByRole('button', { name: /suchen/i }).first().click();
  await expect(page.getByText('Spieler0').first()).toBeVisible();
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByText('Seite 2 von 3')).toBeVisible();
  await expect(page.getByText('Spieler50').first()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(400);
  await page.getByText('Spieler55').first().click();
  await expect(page).toHaveURL(/\/spieler\/p55$/);
  await page.goBack();
  await expect(page.getByText('Seite 2 von 3')).toBeVisible();
  await expect(page.getByLabel('Position')).toHaveValue('ST');
  const last = searches[searches.length - 1]!;
  expect(last.offset).toBe(50);
  expect(JSON.stringify(last.filters)).toContain('"position":"ST"');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  // aktives Zurücksetzen löscht die gespeicherte Ansicht
  await page.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(page.getByLabel('Position')).toHaveValue('');
  expect(await page.evaluate((w) => sessionStorage.getItem(`fd:market:${w}`), WORLD)).not.toContain('"position":"ST"');
  expect(errors).toEqual([]);
});
