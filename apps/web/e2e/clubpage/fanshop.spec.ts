import { expect, test, type Page } from '@playwright/test';
import { sign } from '../auth/jwt';

/** Fanshop und Schulden im Finanzbereich (RPCs gemockt): Anzeige, Preis setzen, Einkauf, Schuldenhinweis */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const PRODUCTS = [
  { key: 'home_jersey', label: 'Heimtrikot', price: 90, base_price: 90, unit_cost: 38, stock: 400, reorder_target: 0, margin: 52, season_units: 120, season_revenue: 10800, season_profit: 6000, recent_units: 40, reorder_needed: false },
  { key: 'scarf', label: 'Schal', price: 25, base_price: 25, unit_cost: 7, stock: 10, reorder_target: 0, margin: 18, season_units: 300, season_revenue: 7500, season_profit: 5000, recent_units: 100, reorder_needed: true },
];

test('Fanshop: Kennzahlen, Preis setzen, Einkauf und Schuldenhinweis', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const calls: Array<{ fn: string; body: any }> = [];
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })]);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    const m = /\/rpc\/([a-z_]+)/.exec(u);
    const json = (b: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m) {
      let body: any = null; try { body = r.request().postDataJSON(); } catch { /* leer */ }
      calls.push({ fn: m[1]!, body });
      if (m[1] === 'merch_overview') return json({ products: PRODUCTS, timeline: [{ ordinal: 1, label: '1. Spieltag', revenue: 8000, profit: 5000, units: 200, home: true }], season: { revenue: 18300, units: 420, profit: 11000, margin: 58.2, storage: 40 }, balance: -3000000, slot_live: false });
      if (m[1] === 'finance_debt') return json({ balance: -3000000, debt: 3000000, interest_per_matchday: 5294, interest_season: 10588, tiers: [] });
      if (m[1] === 'finance_overview') return json({ balance: -3000000, salaries: 1000000, status: 'preseason', squad_size: 20, league_slots: 34, slot_live: false, season_sum: 0, ledger_ok: true, tickets: null,
        stadium: { club_id: 'c', name: 'Testarena', capacity: 20000, ticket_price_league: 25, ticket_price_cup: 20, ticket_price_international: 35, design: {} }, season_totals: {}, transactions: [], last_attendance: null });
      if (m[1] === 'finance_season_report') return json(null);
      return json(null);
    }
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto(`/w/${WORLD}/finanzen`);
  await expect(page.getByTestId('fanshop')).toBeVisible();
  await expect(page.getByTestId('debt-box')).toContainText('Schulden');
  await expect(page.getByTestId('debt-box')).toContainText('Zinsen je Ligaspieltag');
  await expect(page.getByTestId('merch-scarf')).toContainText('Nachbestellen');
  await expect(page.getByTestId('merch-home_jersey')).toContainText('Heimtrikot');
  // Preis ändern
  await page.getByTestId('merch-scarf').locator('input[type=number]').first().fill('30');
  await page.getByTestId('merch-scarf').getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'merch_set_price')?.body).toEqual({ p_world: WORLD, p_product: 'scarf', p_price: 30 });
  // Einkauf
  await page.getByTestId('merch-scarf').locator('input[type=number]').nth(1).fill('250');
  await page.getByTestId('merch-scarf').getByRole('button', { name: 'Kaufen' }).click();
  await expect.poll(() => calls.find((c) => c.fn === 'merch_order')?.body).toEqual({ p_world: WORLD, p_product: 'scarf', p_qty: 250 });
  expect(errors).toEqual([]);
});
