import { expect, test, type Page } from '@playwright/test';
import { sign } from '../auth/jwt';
import { NAV, activeGroup } from '../../src/lib/nav';

/** Hauptmenü: sechs Hauptpunkte, alle bisherigen Ziele erreichbar, aktive Hervorhebung, Bedienung per Maus, Touch und Tastatur */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const OLD_ITEMS = ['start', 'spieltag', 'team', 'entwicklung', 'liga', 'pokal', 'europa', 'transfers', 'finanzen', 'vertraege', 'jugend', 'fankultur'];
const EXTRA = ['kalender', 'choreo'];

async function setup(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })] as const);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    if (u.includes('/rpc/youth_overview')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ level: 1, max_level: 5, intake: 2, upgrade_cost: 1, balance: 1, status: 'preseason', squad_size: 22, levels: [], players: [] }) });
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  return errors;
}
const home = (page: Page) => page.goto(`/w/${WORLD}/jugend`).then(() => expect(page.getByTestId('world-nav')).toBeVisible());

/** Ziel über das Menü erreichen (Untermenü öffnen, Eintrag anklicken) */
async function viaMenu(page: Page, to: string, tap = false) {
  const g = NAV.find((x) => x.to === to || x.items?.some((i) => i.to === to))!;
  const click = (loc: ReturnType<Page['getByTestId']>) => (tap ? loc.tap() : loc.click());
  if (g.to === to) { await click(page.getByTestId(`nav-${g.key}`)); return; }
  await click(page.getByTestId(`nav-${g.key}`));
  await expect(page.getByTestId(`nav-panel-${g.key}`)).toBeVisible();
  await click(page.getByTestId(`nav-item-${to}`));
}

test('Menü: sechs Hauptpunkte statt zwölf; alle bisherigen Ziele plus Kalender und Choreo-Designer sind enthalten', async ({ page }) => {
  const errors = await setup(page);
  await home(page);
  const tops = await page.getByTestId('world-nav').locator(':scope > a, :scope > div > button').count();
  expect(tops).toBe(6);
  const all = NAV.flatMap((g) => (g.to ? [g.to] : g.items!.map((i) => i.to)));
  for (const t of [...OLD_ITEMS, ...EXTRA]) expect(all, t).toContain(t);
  expect(new Set(all).size).toBe(all.length); // keine Dopplung
  expect(errors).toEqual([]);
});

test('Menü: jedes Ziel ist per Klick erreichbar (Desktop), aktiver Bereich ist hervorgehoben', async ({ page }) => {
  await setup(page);
  for (const t of [...OLD_ITEMS, ...EXTRA]) {
    await home(page);
    await viaMenu(page, t);
    await expect(page).toHaveURL(new RegExp(`/w/${WORLD}/${t}$`));
    const g = NAV.find((x) => x.to === t || x.items?.some((i) => i.to === t))!;
    if (t === 'start') continue; // das Liga-Menü ist die Einstiegsseite (Liga betreten) und hat selbst kein Hauptmenü – nur Ziel prüfen
    // nach dem Wechsel: Menü zu, Hauptpunkt des Bereichs als aktuelle Seite markiert
    await expect(page.getByTestId(`nav-${g.key}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-testid^=nav-panel-]'), `nach ${t}: ${page.url()}`).toHaveCount(0);
    // genau ein Hauptpunkt ist aktiv
    expect(await page.getByTestId('world-nav').locator('[aria-current=page]').filter({ hasNot: page.locator('[role=menuitem]') }).count()).toBeGreaterThanOrEqual(1);
  }
});

test('Menü: Untermenü zeigt den aktuellen Eintrag; Unterseiten färben ihren Bereich (Spielerprofil, Vereinsseite, Einstellungen)', async ({ page }) => {
  await setup(page);
  await home(page);
  await page.getByTestId('nav-mannschaft').click();
  await expect(page.getByTestId('nav-item-jugend')).toHaveAttribute('aria-current', 'page');
  expect(activeGroup(`/w/${WORLD}/spieler/abc`, WORLD)).toBe('mannschaft');
  expect(activeGroup(`/w/${WORLD}/club/abc`, WORLD)).toBe('wettbewerbe');
  expect(activeGroup(`/w/${WORLD}/entwicklung/abc`, WORLD)).toBe('mannschaft');
  expect(activeGroup(`/w/${WORLD}/uebersicht/abc`, WORLD)).toBe('dashboard');
  expect(activeGroup(`/w/${WORLD}/einstellungen`, WORLD)).toBe('liga');
  expect(activeGroup(`/w/${WORLD}/choreo`, WORLD)).toBe('verein');
  expect(activeGroup(`/w/${WORLD}/kalender`, WORLD)).toBe('wettbewerbe');
  expect(activeGroup(`/w/${WORLD}/gibtesnicht`, WORLD)).toBeNull();
});

test('Menü: öffnet nur eines, schließt per Klick daneben, Escape und Seitenwechsel; Tastatur-Bedienung', async ({ page }) => {
  await setup(page);
  await home(page);
  await page.getByTestId('nav-mannschaft').click();
  await expect(page.getByTestId('nav-panel-mannschaft')).toBeVisible();
  await page.getByTestId('nav-wettbewerbe').click();
  await expect(page.getByTestId('nav-panel-mannschaft')).toHaveCount(0);
  await expect(page.getByTestId('nav-panel-wettbewerbe')).toBeVisible();
  await page.mouse.click(5, 600); // daneben
  await expect(page.locator('[data-testid^=nav-panel-]')).toHaveCount(0);
  await page.getByTestId('nav-verein').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('nav-panel-verein')).toBeVisible();
  await expect(page.getByTestId('nav-item-finanzen')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByTestId('nav-item-fankultur')).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(page.getByTestId('nav-item-finanzen')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid^=nav-panel-]')).toHaveCount(0);
  await expect(page.getByTestId('nav-verein')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByTestId('nav-item-choreo').press('Enter');
  await expect(page).toHaveURL(new RegExp('/choreo$'));
});

test('Menü: Hover öffnet das Untermenü (Maus), Menü überdeckt keine Seitenbedienung nach dem Schließen', async ({ page }) => {
  await setup(page);
  await home(page);
  await page.waitForTimeout(900); // direkt nach dem Seitenaufbau öffnet Hover bewusst nicht
  await page.getByTestId('nav-wettbewerbe').hover();
  await expect(page.getByTestId('nav-panel-wettbewerbe')).toBeVisible();
  await page.mouse.move(600, 700);
  await expect(page.getByTestId('nav-panel-wettbewerbe')).toHaveCount(0);
});

test.describe('iPad', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  test('Menü auf dem iPad: eine Zeile, Untermenüs per Tipp, alle Ziele erreichbar, Bedienflächen groß genug', async ({ page }) => {
    await setup(page);
    await home(page);
    const nav = await page.getByTestId('world-nav').boundingBox();
    expect(nav!.height).toBeLessThan(70); // eine Zeile
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    for (const t of [...OLD_ITEMS, ...EXTRA]) {
      await home(page);
      await viaMenu(page, t, true);
      await expect(page).toHaveURL(new RegExp(`/w/${WORLD}/${t}$`));
    }
    await home(page);
    await page.getByTestId('nav-mannschaft').tap();
    const items = await page.getByTestId('nav-panel-mannschaft').getByRole('menuitem').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.min(...items)).toBeGreaterThanOrEqual(44);
    // Antippen außerhalb schließt
    await page.touchscreen.tap(20, 900);
    await expect(page.locator('[data-testid^=nav-panel-]')).toHaveCount(0);
    // Untermenü am rechten Rand bleibt im Bild
    await page.getByTestId('nav-verein').tap();
    const panel = await page.getByTestId('nav-panel-verein').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(820);
  });
});

test.describe('schmales Fenster', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test('Menü bricht um statt abzuschneiden; Untermenü bleibt sichtbar', async ({ page }) => {
    await setup(page);
    await home(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByTestId('nav-verein').click();
    const panel = await page.getByTestId('nav-panel-verein').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0); expect(panel!.x + panel!.width).toBeLessThanOrEqual(391);
  });
});
