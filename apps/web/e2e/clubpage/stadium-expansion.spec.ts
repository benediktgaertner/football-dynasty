import { expect, test, type Page } from '@playwright/test';
import { sign } from '../auth/jwt';

/** Fanshop und Schulden im Finanzbereich (RPCs gemockt): Anzeige, Preis setzen, Einkauf, Schuldenhinweis */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const PRODUCTS = [
  { key: 'home_jersey', label: 'Heimtrikot', price: 90, base_price: 90, unit_cost: 38, stock: 400, reorder_target: 0, margin: 52, season_units: 120, season_revenue: 10800, season_profit: 6000, recent_units: 40, reorder_needed: false },
  { key: 'scarf', label: 'Schal', price: 25, base_price: 25, unit_cost: 7, stock: 10, reorder_target: 0, margin: 18, season_units: 300, season_revenue: 7500, season_profit: 5000, recent_units: 100, reorder_needed: true },
];


const OV = (cap: number) => ({ balance: 20_000_000, salaries: 1_000_000, status: 'preseason', squad_size: 20, league_slots: 34, slot_live: false, season_sum: 0, ledger_ok: true, tickets: null,
  stadium: { club_id: 'c', name: 'Testarena', capacity: cap, ticket_price_league: 25, ticket_price_cup: 20, ticket_price_international: 35, design: {} }, season_totals: {}, transactions: [], last_attendance: null });
const QUOTE = { capacity: 30000, next_capacity: 35000, max: false, cost: 4_100_000, demand: 34000, attendance_now: 29900, attendance_after: 33100, extra_attendance: 3200, utilization_now: 99.7,
  utilization_after: 94.6, games: 19, annual_tickets: 1_520_000, annual_catering: 425_000, annual_merch: 146_000, annual_running_extra: 270_000, annual_net: 1_821_000, payback_years: 2.25, verdict: 'third_season' };

async function boot(page: import('@playwright/test').Page, cap: number, quote: unknown) {
  const calls: Array<{ fn: string }> = [];
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })]);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    const m = /\/rpc\/([a-z_]+)/.exec(u);
    const json = (b: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m) {
      calls.push({ fn: m[1]! });
      if (m[1] === 'finance_overview') return json(OV(cap));
      if (m[1] === 'stadium_expansion_quote') return json(quote);
      if (m[1] === 'expand_stadium') return json({ capacity: cap + 5000, cost: 4_100_000 });
      if (m[1] === 'merch_overview') return json({ products: [], timeline: [], season: { revenue: 0, units: 0, profit: 0, margin: 0, storage: 0 }, balance: 0, slot_live: false });
      if (m[1] === 'finance_debt') return json({ balance: 1, debt: 0, interest_per_matchday: 0, interest_season: 0, tiers: [] });
      return json(null);
    }
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return calls;
}

test('Stadionausbau: Kosten und Break-even-Prognose werden vor dem Ausbau angezeigt, Bestätigung nennt den Preis', async ({ page }) => {
  const calls = await boot(page, 30000, QUOTE);
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
  await page.goto(`/w/${WORLD}/finanzen`);
  const box = page.getByTestId('stadium-quote');
  await expect(box).toContainText('35.000');
  await expect(box).toContainText('Break-even erst in der dritten Saison');
  await expect(box).toContainText('Gastronomie');
  await expect(box).toContainText('Fanshop');
  await expect(box).toContainText('Betrieb');
  await expect(page.getByRole('button', { name: /Ausbau \+5\.000/ })).toBeEnabled();
  await page.getByRole('button', { name: /Ausbau \+5\.000/ }).click();
  await expect.poll(() => calls.some((c) => c.fn === 'expand_stadium')).toBe(true);
  expect(dialogs[0]).toMatch(/4[,.]1/);
  expect(dialogs[0]).toContain('dritten Saison');
});

test('Stadionausbau: bei 80.000 Plätzen ist das Maximum erreicht', async ({ page }) => {
  await boot(page, 80000, { capacity: 80000, next_capacity: null, max: true });
  await page.goto(`/w/${WORLD}/finanzen`);
  await expect(page.getByRole('button', { name: /Maximale Größe erreicht \(80\.000\)/ })).toBeDisabled();
  await expect(page.getByTestId('stadium-quote')).toHaveCount(0);
});
