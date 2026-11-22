import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Verbindliche Login-Tests:
 * 1. Neuer Nutzer registriert sich mit E-Mail und Passwort
 * 2. Bestehender anonymer Nutzer verknüpft E-Mail und setzt Passwort (gleiche Benutzer-ID, Karriere bleibt)
 * 3. Derselbe Nutzer meldet sich auf einem anderen Gerät an und sieht seinen Verein
 * 4. Zwei Manager derselben Welt: getrennte Accounts, gemeinsamer Spielstand
 * 5. Fehlgeschlagene Umstellung führt zu keinem Datenverlust
 * 6. Passwort zurücksetzen
 */
const MOCK = 'http://127.0.0.1:8793';
const KEY = 'sb-127-auth-token';
const PW = 'Sicher2026';
let n = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${n++}`;

interface Legacy { session: { access_token: string; refresh_token: string; user: { id: string } }; user_id: string; world: string; club: string; code: string }

async function legacy(request: APIRequestContext, o: { username: string; world?: string; code?: string; club: string; short: string }): Promise<Legacy> {
  const r = await request.post(`${MOCK}/__test/legacy`, { data: o });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function state(request: APIRequestContext, user: string) {
  return (await request.get(`${MOCK}/__test/state?user=${user}`)).json();
}
async function mailLink(request: APIRequestContext, to: string, type: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const m = await (await request.get(`${MOCK}/__test/mail?to=${encodeURIComponent(to)}&type=${type}`)).json();
    if (m.length) return m[0].link;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`keine Mail (${type}) an ${to}`);
}
/** Gerät mit bestehender anonymer Sitzung (wie heute im Browser gespeichert) */
async function deviceWith(context: BrowserContext, s: Legacy['session']) {
  await context.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, [KEY, JSON.stringify(s)] as const);
}
const storedUser = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null')?.user?.id ?? null, KEY);

/** registrierter, bestätigter Account direkt über die Auth-API (für Konflikt-/Reset-Tests) */
async function registered(request: APIRequestContext, email: string, name: string) {
  const r = await request.post(`${MOCK}/auth/v1/signup`, { data: { email, password: PW, data: { manager_name: name } } });
  expect(r.ok()).toBe(true);
  const link = await mailLink(request, email, 'signup');
  await request.get(link, { maxRedirects: 0 });
  return (await (await request.get(`${MOCK}/__test/user-by-email?email=${encodeURIComponent(email)}`)).json()) as string;
}

async function login(page: Page, email: string, pw = PW) {
  await page.goto('/');
  await page.getByTestId('tab-login').click();
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(pw);
  await page.getByTestId('auth-submit').click();
}

/** Umstellung über die Oberfläche: E-Mail → Link → Passwort */
async function secureViaUi(page: Page, request: APIRequestContext, email: string) {
  await page.getByTestId('secure-email').fill(email);
  await page.getByTestId('secure-send').click();
  await expect(page.getByTestId('secure-pending')).toBeVisible();
  await page.goto(await mailLink(request, email, 'email_change'));
  await expect(page.getByTestId('secure-password')).toBeVisible();
  await page.getByTestId('secure-password').fill(PW);
  await page.getByTestId('secure-password2').fill(PW);
  await page.getByTestId('secure-save-password').click();
  await expect(page.getByTestId('secure-done')).toBeVisible();
}

test('1 · Neuer Nutzer: Registrierung mit E-Mail, Bestätigung, Managername, Login/Logout', async ({ page, request }) => {
  const email = `${uniq('neu')}@test.de`, name = uniq('Neu').slice(0, 18);
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('auth-name').fill(name);
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-password').fill(PW);
  await page.getByTestId('auth-password2').fill(PW);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-sent')).toContainText(email);
  // vor der Bestätigung: Anmeldung abgelehnt
  await login(page, email);
  await expect(page.getByRole('alert')).toContainText('noch nicht bestätigt');
  // Bestätigungslink ⇒ angemeldet, Managername aus der Registrierung übernommen
  await page.goto(await mailLink(request, email, 'signup'));
  await expect(page.getByTestId('account-link')).toHaveText(name);
  const id = await storedUser(page);
  const st = await state(request, id);
  expect(st).toMatchObject({ is_anonymous: false, email, has_password: true, username: name, clubs: 0 });
  await expect(page.getByTestId('secure-prompt')).toHaveCount(0); // gesichert: keine Aufforderung
  // Logout ⇒ Login mit Passwort
  await page.goto('/konto');
  await expect(page.getByTestId('account-email')).toContainText(email);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('tab-login')).toBeVisible();
  await login(page, email, 'Falsch1234');
  await expect(page.getByRole('alert')).toContainText('falsch');
  await login(page, email);
  await expect(page.getByTestId('account-link')).toHaveText(name);
  // Managername ist eindeutig
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await page.getByTestId('tab-register').click();
  await page.getByTestId('auth-name').fill(name);
  await page.getByTestId('auth-email').fill(`${uniq('x')}@test.de`);
  await page.getByTestId('auth-password').fill(PW);
  await page.getByTestId('auth-password2').fill(PW);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByRole('alert')).toContainText('bereits vergeben');
});

test('2 + 3 · Anonymer Altaccount: E-Mail + Passwort, gleiche ID, Verein erhalten; Login auf neuem Gerät', async ({ page, request, browser }) => {
  const name = uniq('Alt').slice(0, 16), email = `${uniq('alt')}@test.de`;
  const L = await legacy(request, { username: name, world: uniq('Stammtisch'), club: uniq('SV Altdorf').slice(0, 24), short: 'SVA' });
  const before = await state(request, L.user_id);
  await deviceWith(page.context(), L.session);
  await page.goto('/');
  // einmalige Aufforderung nach dem Login
  const prompt = page.getByTestId('secure-prompt');
  await expect(prompt).toContainText('Sichere deinen Account');
  await expect(prompt).toContainText('Hinterlege deine E-Mail-Adresse und ein Passwort, damit du Football Dynasty auf mehreren Geräten spielen kannst.');
  // Schritt 1: E-Mail – Sitzung bleibt, noch anonym
  await page.getByTestId('secure-email').fill(email);
  await page.getByTestId('secure-send').click();
  await expect(page.getByTestId('secure-pending')).toContainText(email);
  expect(await state(request, L.user_id)).toMatchObject({ is_anonymous: true, email_change: email, clubs: 1 });
  expect(await storedUser(page)).toBe(L.user_id);
  // Schritt 2: Link bestätigen ⇒ gleiche Benutzer-ID
  await page.goto(await mailLink(request, email, 'email_change'));
  await expect(page.getByTestId('secure-password')).toBeVisible();
  expect(await storedUser(page)).toBe(L.user_id);
  // Schritt 3: Passwort
  await page.getByTestId('secure-password').fill(PW);
  await page.getByTestId('secure-password2').fill(PW);
  await page.getByTestId('secure-save-password').click();
  await expect(page.getByTestId('secure-done')).toBeVisible();
  const after = await state(request, L.user_id);
  expect(after).toMatchObject({ id: L.user_id, is_anonymous: false, email, has_password: true, username: name, clubs: before.clubs, worlds: before.worlds });
  expect(after.club_names).toEqual(before.club_names);
  expect(after.users_total).toBe(before.users_total); // kein zweiter Account
  await page.goto('/');
  await expect(page.getByTestId('secure-prompt')).toHaveCount(0);
  await expect(page.getByTestId('secure-banner')).toHaveCount(0);

  // 3 · anderes Gerät (leerer Browser): Anmeldung mit E-Mail + Passwort ⇒ eigener Verein
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await login(p2, email);
  await expect(p2.getByTestId('account-link')).toHaveText(name);
  expect(await storedUser(p2)).toBe(L.user_id);
  const worldName = (await state(request, L.user_id)).worlds;
  expect(worldName).toBe(1);
  await p2.goto(`/w/${L.world}`);
  await expect(p2.getByText(before.club_names[0]).first()).toBeVisible();
  await other.close();
});

test('4 · Zwei Manager einer Welt: getrennte Accounts, gemeinsamer Spielstand', async ({ browser, request }) => {
  const A = await legacy(request, { username: uniq('Anna').slice(0, 16), world: uniq('Freunde'), club: uniq('FC Anna').slice(0, 24), short: 'FCA' });
  const B = await legacy(request, { username: uniq('Ben').slice(0, 16), code: A.code, club: uniq('SV Ben').slice(0, 24), short: 'SVB' });
  expect(B.world).toBe(A.world);
  const ea = `${uniq('anna')}@test.de`, eb = `${uniq('ben')}@test.de`;
  for (const [L, e] of [[A, ea], [B, eb]] as const) {
    const ctx = await browser.newContext();
    await deviceWith(ctx, L.session);
    const p = await ctx.newPage();
    await p.goto('/');
    await secureViaUi(p, request, e);
    await ctx.close();
  }
  const sa = await state(request, A.user_id), sb = await state(request, B.user_id);
  expect(sa.id).not.toBe(sb.id);
  expect(sa).toMatchObject({ email: ea, clubs: 1, worlds: 1, is_anonymous: false });
  expect(sb).toMatchObject({ email: eb, clubs: 1, worlds: 1, is_anonymous: false });
  expect(sa.club_names).not.toEqual(sb.club_names);
  // beide neu angemeldet: dieselbe Welt mit beiden Vereinen, jeder nur mit eigenem Account
  for (const [e, mine, theirs] of [[ea, sa.club_names[0], sb.club_names[0]], [eb, sb.club_names[0], sa.club_names[0]]]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await login(p, e);
    await expect(p.getByTestId('account-link')).toBeVisible();
    await p.goto(`/w/${A.world}`);
    await expect(p.getByText(mine).first()).toBeVisible();
    await expect(p.getByText(theirs).first()).toBeVisible();
    await p.goto('/konto');
    await expect(p.getByTestId('account-email')).toContainText(e);
    await expect(p.getByTestId('account-email')).not.toContainText(e === ea ? eb : ea); // fremde Adresse privat
    await ctx.close();
  }
});

test('5 · Fehlgeschlagene Umstellung: belegte Adresse, abgelaufener Link, fremde Anmeldung – kein Datenverlust', async ({ page, request }) => {
  const taken = `${uniq('belegt')}@test.de`;
  const otherId = await registered(request, taken, uniq('Fremd').slice(0, 16));
  const name = uniq('Vorsicht').slice(0, 16);
  const L = await legacy(request, { username: name, world: uniq('Testliga'), club: uniq('TSV Vorsicht').slice(0, 24), short: 'TSV' });
  const before = await state(request, L.user_id);
  await deviceWith(page.context(), L.session);
  await page.goto('/');
  // a) Adresse gehört einem anderen Account ⇒ Fehlermeldung, nichts verändert, keine Zusammenführung
  await page.getByTestId('secure-email').fill(taken);
  await page.getByTestId('secure-send').click();
  await expect(page.getByRole('alert')).toContainText('gehört bereits zu einem anderen Account');
  expect(await state(request, L.user_id)).toMatchObject({ is_anonymous: true, email: null, email_change: '', clubs: before.clubs });
  expect(await storedUser(page)).toBe(L.user_id);
  // b) Link abgelaufen ⇒ Hinweis, Sitzung bleibt, Karriere da
  const email = `${uniq('vorsicht')}@test.de`;
  await page.getByTestId('secure-email').fill(email);
  await page.getByTestId('secure-send').click();
  await expect(page.getByTestId('secure-pending')).toBeVisible();
  const link = await mailLink(request, email, 'email_change');
  await request.get(`${MOCK}/__test/expire?to=${encodeURIComponent(email)}`);
  await page.goto(link);
  await expect(page.getByTestId('link-error')).toContainText('abgelaufen');
  await expect(page.getByRole('heading', { name })).toBeVisible(); // Kontoseite des bisherigen Accounts
  await expect(page.getByTestId('secure-pending')).toBeVisible(); // Vormerkung besteht, neu senden möglich
  expect(await storedUser(page)).toBe(L.user_id);
  await page.goto('/');
  await expect(page.getByTestId('account-link')).toHaveText(name);
  await page.getByTestId('secure-later').click();
  await page.reload();
  await expect(page.getByTestId('secure-banner')).toBeVisible(); // Aufforderung einmalig, Hinweis bleibt
  await expect(page.getByTestId('secure-prompt')).toHaveCount(0);
  expect(await state(request, L.user_id)).toMatchObject({ is_anonymous: true, clubs: before.clubs, worlds: before.worlds });
  // c) fremder Anmeldelink verdrängt die Sitzung ⇒ Rückkehr zum ungesicherten Account möglich
  await request.post(`${MOCK}/auth/v1/otp`, { data: { email: taken, create_user: false } });
  await page.goto(await mailLink(request, taken, 'magiclink'));
  await expect.poll(() => storedUser(page)).toBe(otherId);
  await expect(page.getByTestId('stranded')).toContainText(name);
  await page.getByTestId('stranded-restore').click();
  await expect(page.getByTestId('account-link')).toHaveText(name);
  expect(await storedUser(page)).toBe(L.user_id);
  // danach normal sichern – weiterhin dieselbe ID und alle Daten
  await page.goto('/konto');
  await page.getByRole('button', { name: 'Andere Adresse' }).click();
  await secureViaUi(page, request, `${uniq('final')}@test.de`);
  const after = await state(request, L.user_id);
  expect(after).toMatchObject({ is_anonymous: false, has_password: true, clubs: before.clubs, worlds: before.worlds, users_total: before.users_total }); // kein zweiter Account entstanden
  expect(after.club_names).toEqual(before.club_names);
});

test('6 · Passwort vergessen: Link, neues Passwort, altes ungültig', async ({ page, request }) => {
  const email = `${uniq('reset')}@test.de`;
  await registered(request, email, uniq('Reset').slice(0, 16));
  await page.goto('/');
  await page.getByTestId('auth-forgot').click();
  await page.getByTestId('auth-email').fill(email);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-sent')).toContainText('Falls ein Account');
  await page.goto(await mailLink(request, email, 'recovery'));
  await page.getByTestId('reset-password').fill('Neues2027pw');
  await page.getByTestId('reset-password2').fill('Neues2027pw');
  await page.getByTestId('reset-submit').click();
  await expect(page.getByTestId('reset-done')).toBeVisible();
  await page.getByTestId('reset-continue').click();
  await expect(page.getByTestId('account-link')).toBeVisible();
  await page.goto('/konto');
  await page.getByTestId('logout').click();
  await login(page, email, PW);
  await expect(page.getByRole('alert')).toContainText('falsch');
  await login(page, email, 'Neues2027pw');
  await expect(page.getByTestId('account-link')).toBeVisible();
  // Unbekannte Adresse: gleiche neutrale Antwort (keine Auskunft, ob registriert)
  await page.goto('/konto');
  await page.getByTestId('logout').click();
  await page.getByTestId('auth-forgot').click();
  await page.getByTestId('auth-email').fill('gibtsnicht@test.de');
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-sent')).toContainText('Falls ein Account');
});
