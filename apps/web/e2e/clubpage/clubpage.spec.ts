import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { sign } from '../auth/jwt';

/**
 * Vereinsprofil (Black-Screen-Bug): Supabase wird per page.route ersetzt, die Antworten von club_profile sind
 * echte Ausgaben der Funktion aus einer lokalen Testwelt (fixtures/*.json).
 * ausland_kompakt_alt.json = Ausgabe VOR Migration 0040 (formation.slots = null) – genau der Fall, der die App schwarz machte.
 * Start: `npm run e2e:club -w @fd/web` (mit PREVIEW=1 gegen den Produktions-Build)
 */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';
const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const FIX = { liga1: fx('liga1'), liga2: fx('liga2'), liga3: fx('liga3'), ausland: fx('ausland'), kompakt: fx('ausland_kompakt_alt') };

async function setup(page: Page, profiles: Record<string, unknown>, extra?: (u: string) => unknown) {
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
    const x = extra?.(u);
    if (x !== undefined) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  return errors;
}
const byId = (...ps: Array<{ club: { id: string } }>) => Object.fromEntries(ps.map((p) => [p.club.id, p]));

async function expectProfile(page: Page, p: { club: { name: string }; squad: Array<{ name: string }> }) {
  await expect(page.getByRole('heading', { level: 1, name: p.club.name })).toBeVisible();
  await expect(page.getByText(`${p.squad.length} Spieler`)).toBeVisible();
  await expect(page.getByRole('link', { name: p.squad[0]!.name }).first()).toBeVisible();
  await expect(page.getByText('Stärke Top-11')).toBeVisible();
}

for (const [label, key] of [['1. Liga', 'liga1'], ['2. Liga', 'liga2'], ['3. Liga', 'liga3'], ['Ausland', 'ausland']] as const) {
  test(`Vereinsprofil ${label}: Kader, OVR, Stärke, Ergebnisse`, async ({ page }) => {
    const p = FIX[key];
    const errors = await setup(page, byId(p));
    await page.goto(`/w/${WORLD}/club/${p.club.id}`);
    await expectProfile(page, p);
    expect(errors).toEqual([]);
  });
}

test('Kompakt-Simulation (slots = null, Daten vor dem Fix): Seite stürzt nicht ab', async ({ page }) => {
  const p = FIX.kompakt;
  expect(p.formation.slots).toBeNull(); // genau der Fehlerfall aus der Produktion
  const errors = await setup(page, byId(p));
  await page.goto(`/w/${WORLD}/club/${p.club.id}`);
  await expectProfile(page, p);
  await expect(page.getByText('Noch keine bekannte Formation')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Navigation: Gegner-Link → anderer Verein → Zurück, ohne Absturz', async ({ page }) => {
  const a = FIX.liga1, b = { ...FIX.liga2, club: { ...FIX.liga2.club, id: a.results[0].opponent.id, name: a.results[0].opponent.name } };
  const errors = await setup(page, byId(a, b));
  await page.goto(`/w/${WORLD}/club/${a.club.id}`);
  await expectProfile(page, a);
  await page.getByRole('link', { name: a.results[0].opponent.name }).first().click();
  await expect(page).toHaveURL(new RegExp(`/club/${b.club.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: b.club.name })).toBeVisible();
  await page.getByRole('button', { name: '← Zurück' }).click();
  await expectProfile(page, a);
  await page.goForward(); // Browser-Vorwärts zurück zum zweiten Verein
  await expect(page.getByRole('heading', { level: 1, name: b.club.name })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Kein Zugriff / Fehler der Datenbank: Fehlermeldung statt schwarzer Seite', async ({ page }) => {
  await setup(page, {});
  await page.goto(`/w/${WORLD}/club/00000000-0000-0000-0000-00000000dead`);
  await expect(page.getByText('Kein Zugriff.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Hauptmenü' })).toBeVisible();
});

test('Fehlergrenze: Renderfehler einer Seite zeigt Fehlerkarte statt schwarzem Bild, Navigation geht weiter', async ({ page }) => {
  // absichtlich unrenderbarer Datensatz (Objekt als Spielername) – simuliert einen unbekannten künftigen Datenfehler
  const bad = { ...FIX.liga1, squad: [{ ...FIX.liga1.squad[0], name: { kaputt: true } }, ...FIX.liga1.squad.slice(1)] };
  await setup(page, byId(bad, FIX.liga2));
  await page.goto(`/w/${WORLD}/club/${bad.club.id}`);
  await expect(page.getByTestId('page-error')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neu laden' })).toBeVisible();
  // Seitenwechsel setzt die Fehlergrenze zurück
  await page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, `/w/${WORLD}/club/${FIX.liga2.club.id}`);
  await expectProfile(page, FIX.liga2);
});

test.describe('iPad', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  test('Vereinsprofil 1. Liga auf dem iPad', async ({ page }) => {
    const p = FIX.liga1;
    const errors = await setup(page, byId(p));
    await page.goto(`/w/${WORLD}/club/${p.club.id}`);
    await expectProfile(page, p);
    expect(errors).toEqual([]);
  });
});
