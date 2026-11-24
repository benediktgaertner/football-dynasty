import { expect, test, type Page } from '@playwright/test';
import { sign } from '../auth/jwt';

/** Fanshop und Schulden im Finanzbereich (RPCs gemockt): Anzeige, Preis setzen, Einkauf, Schuldenhinweis */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const PRODUCTS = [
  { key: 'home_jersey', family: 'jersey', design: {}, label: 'Heimtrikot', price: 90, base_price: 90, unit_cost: 38, stock: 400, reorder_target: 0, margin: 52, season_units: 120, season_revenue: 10800, season_profit: 6000, recent_units: 40, reorder_needed: false },
  { key: 'scarf', family: 'scarf', design: {}, label: 'Schal', price: 25, base_price: 25, unit_cost: 7, stock: 300, reorder_target: 0, margin: 18, season_units: 300, season_revenue: 7500, season_profit: 5000, recent_units: 100, reorder_needed: false },
  { key: 'cap', family: 'cap', design: {}, label: 'Cap', price: 22, base_price: 22, unit_cost: 6, stock: 300, reorder_target: 0, margin: 16, season_units: 10, season_revenue: 220, season_profit: 100, recent_units: 5, reorder_needed: false },
  { key: 'flag', family: 'flag', design: {}, label: 'Fahne', price: 15, base_price: 15, unit_cost: 4, stock: 300, reorder_target: 0, margin: 11, season_units: 10, season_revenue: 150, season_profit: 100, recent_units: 5, reorder_needed: false },
];

async function boot(page: import('@playwright/test').Page, saved: Array<{ product: string; design: any }>) {
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })]);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    const m = /\/rpc\/([a-z_]+)/.exec(u);
    const json = (b: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m) {
      let body: any = null; try { body = r.request().postDataJSON(); } catch { /* leer */ }
      if (m[1] === 'merch_overview') return json({ products: PRODUCTS.map((p) => ({ ...p, design: saved.find((s) => s.product === p.key)?.design ?? {} })), timeline: [], season: { revenue: 1, units: 1, profit: 1, margin: 1, storage: 0 }, balance: 5_000_000, slot_live: false });
      if (m[1] === 'merch_set_design') { saved.push({ product: body.p_product, design: body.p_design }); return json(null); }
      if (m[1] === 'finance_debt') return json({ balance: 1, debt: 0, interest_per_matchday: 0, interest_season: 0, tiers: [] });
      if (m[1] === 'finance_overview') return json({ balance: 5_000_000, salaries: 1, status: 'preseason', squad_size: 20, league_slots: 34, slot_live: false, season_sum: 0, ledger_ok: true, tickets: null,
        stadium: { club_id: 'c', name: 'Arena', capacity: 30000, ticket_price_league: 25, ticket_price_cup: 20, ticket_price_international: 35, design: {} }, season_totals: {}, transactions: [], last_attendance: null });
      if (m[1] === 'stadium_expansion_quote') return json({ capacity: 30000, next_capacity: null, max: true });
      return json(null);
    }
    if (u.includes('/auth/v1/user')) return json({ id: USER, aud: 'authenticated', role: 'authenticated', email: 'a@b.de', app_metadata: {}, user_metadata: {} });
    if (u.includes('/rest/v1/club_branding')) return json([{ primary_color: '#c8102e', secondary_color: '#ffffff', accent_color: '#f2c14e', crest: null, kit: { pattern: 'hoops' }, clubs: { world_id: WORLD, manager_user_id: USER } }]);
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test('Fanartikel-Design: Standard in Vereinsfarben, Live-Vorschau, Speichern und Anzeige im Fanshop', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
  const saved: Array<{ product: string; design: any }> = [];
  await boot(page, saved);
  await page.goto(`/w/${WORLD}/finanzen`);
  // Standard: Heimtrikot in Vereinsfarben (Ringel), Schal gestreift
  await expect(page.getByTestId('merch-preview-home_jersey').first()).toHaveAttribute('data-c1', '#c8102e');
  await expect(page.getByTestId('merch-preview-home_jersey').first()).toHaveAttribute('data-pattern', 'hoops');
  await page.getByTestId('merch-design-home_jersey').click();
  const editor = page.getByTestId('merch-editor');
  await expect(editor).toBeVisible();
  const big = editor.getByTestId('merch-preview-home_jersey');
  // Muster wechseln = sofort sichtbar
  await editor.getByTestId('merch-pattern-chevron').click();
  await expect(big).toHaveAttribute('data-pattern', 'chevron');
  await editor.getByTestId('merch-pattern-pinstripe').click();
  await expect(big).toHaveAttribute('data-pattern', 'pinstripe');
  // Farbe wählen (Palette) und Aufdruck eintippen
  await editor.getByLabel('Hauptfarbe #003b95').click();
  await expect(big).toHaveAttribute('data-c1', '#003b95');
  await editor.getByTestId('merch-text').fill('Ultras <1904>');
  await expect(editor.getByTestId('merch-text')).toHaveValue('Ultras 1904');
  await editor.getByTestId('merch-crest').uncheck();
  await expect(big.locator('text')).toContainText('Ultras 1904');
  if (process.env.FD_SHOT) await editor.screenshot({ path: `${process.env.FD_SHOT}/editor-jersey.png` });
  await editor.getByRole('button', { name: 'Design speichern' }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toEqual({ product: 'home_jersey', design: { pattern: 'pinstripe', c1: '#003b95', c2: '#ffffff', c3: '#f2c14e', crest: false, text: 'Ultras 1904' } });
  // nach dem Neuladen: Design erscheint in der Tabelle
  await expect(page.getByTestId('merch-preview-home_jersey').first()).toHaveAttribute('data-pattern', 'pinstripe');
  await expect(page.getByTestId('merch-preview-home_jersey').first()).toHaveAttribute('data-c1', '#003b95');
  expect(errors).toEqual([]);
});

test('Fanartikel-Design: Schal, Kappe und Fahne bieten eigene Muster; Zurücksetzen stellt die Vereinsfarben her', async ({ page }) => {
  const saved: Array<{ product: string; design: any }> = [];
  await boot(page, saved);
  await page.goto(`/w/${WORLD}/finanzen`);
  for (const [product, pattern] of [['scarf', 'checker'], ['cap', 'twotone'], ['flag', 'cross']] as const) {
    await page.getByTestId(`merch-design-${product}`).click();
    const editor = page.getByTestId('merch-editor');
    await expect(editor.getByTestId('merch-pattern-hoops')).toHaveCount(0); // Trikotmuster gibt es nur beim Trikot
    await editor.getByTestId(`merch-pattern-${pattern}`).click();
    await expect(editor.getByTestId(`merch-preview-${product}`)).toHaveAttribute('data-pattern', pattern);
  }
  if (process.env.FD_SHOT) await page.getByTestId('fanshop').screenshot({ path: `${process.env.FD_SHOT}/fanshop.png` });
  await page.getByTestId('merch-editor').getByRole('button', { name: 'Auf Vereinsfarben zurücksetzen' }).click();
  await expect(page.getByTestId('merch-editor').getByTestId('merch-preview-flag')).toHaveAttribute('data-c1', '#c8102e');
  await expect(page.getByTestId('merch-editor').getByTestId('merch-preview-flag')).toHaveAttribute('data-pattern', 'horizontal');
});
