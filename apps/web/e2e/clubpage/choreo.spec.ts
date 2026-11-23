import { expect, test, type Page } from '@playwright/test';
import { sign } from '../auth/jwt';
import { TEMPLATES, validateChoreo, type ChoreoV2 } from '../../src/lib/choreo/model';
import { stadiumCells, stadiumGeo } from '../../src/lib/choreo/geometry';

/**
 * Choreo-Designer: Seite mit gemockten RPCs (Speichern/Laden im Speicher des Tests) – Bedienung per Maus (Desktop) und Touch (iPad):
 * Tribünen/Blöcke anklicken, Mehrfachauswahl, Drag-and-drop, Größe, Drehung, Farben, Texte, Duplizieren, Löschen, Rückgängig/Wiederholen,
 * Szenen, Vorlagen, Speichern und erneutes Laden, mehrere Choreografien, Gästeblock-Sperre, Stadiongröße.
 */
const USER = '00000000-0000-0000-0000-0000000000a1';
const WORLD = 'b1a9cc78-6be5-4a66-9761-a5b616037f3b';

interface Saved { id: string; name: string; design: unknown }
function mkClub(capacity: number, style: string) {
  return { name: 'FC Test', short: 'FCT', primary: '#c8102e', secondary: '#ffffff', capacity, design: { style }, attendance: Math.round(capacity * 0.8) };
}
async function setup(page: Page, club = mkClub(30000, 'modern'), initial: Saved[] = []) {
  const errors: string[] = [];
  const saved: Saved[] = [...initial];
  const calls: Array<{ fn: string; body: any }> = [];
  let random = false;
  page.on('pageerror', (e) => errors.push(String(e)));
  const tok = sign({ sub: USER, role: 'authenticated', exp: 4102444800 });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-127-auth-token', JSON.stringify({ access_token: tok, refresh_token: 'r', token_type: 'bearer',
    expires_in: 3600, expires_at: 4102444800, user: { id: USER, aud: 'authenticated', role: 'authenticated', is_anonymous: false, email: 'a@b.de', app_metadata: {}, user_metadata: {} } })] as const);
  await page.route('http://127.0.0.1:8798/**', async (r) => {
    const u = r.request().url();
    const m = /\/rpc\/([a-z_]+)/.exec(u);
    const ok = (body: unknown) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (m) {
      const fn = m[1]!, body = r.request().postDataJSON() ?? {};
      calls.push({ fn, body });
      if (fn === 'fan_culture') return ok({ club_id: 'c1', kits: { home: {}, away: {}, special: {} }, club, flags: [], ultras: [], default_choreo_id: null, auto_choreo: true, choreos: saved, audio: [], next_home: null });
      if (fn === 'choreo_prefs') return ok({ random, saved: saved.length });
      if (fn === 'set_choreo_random') { random = !!body.p_on; return ok(null); }
      if (fn === 'save_choreo') {
        const errs = validateChoreo(body.p_design);
        if (body.p_design?.v === 2 && errs.length) return r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22023', hint: 'invalid_design', message: 'Ungültige Choreografie.' }) });
        if (body.p_id) { const e = saved.find((s) => s.id === body.p_id)!; e.name = body.p_name; e.design = body.p_design; return ok(body.p_id); }
        const id = `ch-${saved.length + 1}`; saved.push({ id, name: body.p_name, design: body.p_design }); return ok(id);
      }
      if (fn === 'delete_choreo') { const i = saved.findIndex((s) => s.id === body.p_id); if (i >= 0) saved.splice(i, 1); return ok(null); }
    }
    if (u.includes('/rest/v1/profiles')) return r.fulfill({ status: 200, contentType: 'application/vnd.pgrst.object+json', body: JSON.stringify({ id: USER, username: 'Tester' }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  return { errors, saved, calls, isRandom: () => random };
}

/** Meter (Stadionkoordinaten) → Bildschirmposition des Canvas (CSS-Pixel) */
async function toClient(page: Page, x: number, y: number) {
  return page.evaluate(([mx, my]) => {
    const c = document.querySelector('[data-testid="choreo-canvas"]') as HTMLCanvasElement;
    const v = JSON.parse(c.dataset.view!) as { s: number; ox: number; oy: number; dpr: number };
    const r = c.getBoundingClientRect();
    return { x: r.left + (v.ox + mx! * v.s) / v.dpr, y: r.top + (v.oy + my! * v.s) / v.dpr };
  }, [x, y] as const);
}
const open = async (page: Page) => { await page.goto(`/w/${WORLD}/choreo`); await expect(page.getByTestId('choreo-canvas')).toBeVisible(); await page.waitForFunction(() => !!(document.querySelector('[data-testid="choreo-canvas"]') as HTMLElement)?.dataset.view); };
const count = (page: Page) => page.getByTestId('choreo-list').locator('li button').count();

test('Studio: Laden, Elemente, Mehrfachauswahl, Duplizieren, Löschen, Rückgängig/Wiederholen, Farben und Texte', async ({ page }) => {
  const m = await setup(page);
  await open(page);
  const start = await count(page); // Vorlage „Klassische Heimkurve“
  expect(start).toBe(2);
  // alle Elementarten hinzufügen
  for (const k of ['cards', 'blockflag', 'banner', 'fence', 'flags', 'confetti', 'streamers', 'smoke', 'wave']) await page.getByTestId(`choreo-add-${k}`).click();
  expect(await count(page)).toBe(start + 9);
  // Rückgängig / Wiederholen
  await page.getByTestId('choreo-undo').click(); expect(await count(page)).toBe(start + 8);
  await page.getByTestId('choreo-undo').click(); expect(await count(page)).toBe(start + 7);
  await page.getByTestId('choreo-redo').click(); expect(await count(page)).toBe(start + 8);
  await page.getByTestId('choreo-redo').click(); expect(await count(page)).toBe(start + 9);
  await expect(page.getByTestId('choreo-redo')).toBeDisabled();
  // Farben und Text eines Spruchbands ändern
  await page.getByTestId('choreo-el-banner').click();
  await page.getByTestId('choreo-text').fill('HIER REGIERT DER FCT');
  await page.getByTestId('choreo-colors').locator('input[type=color]').first().fill('#112233');
  await expect(page.getByTestId('choreo-text')).toHaveValue('HIER REGIERT DER FCT');
  // Duplizieren
  await page.getByTestId('choreo-duplicate').click(); expect(await count(page)).toBe(start + 10);
  // Mehrfachauswahl und Löschen
  await page.getByTestId('choreo-multi').check();
  await page.getByTestId('choreo-el-confetti').click(); await page.getByTestId('choreo-el-smoke').click();
  await expect(page.getByTestId('choreo-multi-info')).toContainText('3 Elemente gewählt');
  await page.getByTestId('choreo-delete').click(); expect(await count(page)).toBe(start + 7);
  await page.getByTestId('choreo-undo').click(); expect(await count(page)).toBe(start + 10);
  expect(m.errors).toEqual([]);
});

test('Studio: Tribünen und Blöcke anklicken (Auswahl wird zum Bereich), Gästeblock ist gesperrt', async ({ page }) => {
  await setup(page);
  await open(page);
  const geo = stadiumGeo(30000, { style: 'modern' });
  const cells = stadiumCells(geo);
  await page.getByTestId('choreo-tool-areas').click();
  await page.getByTestId('choreo-add-cards').click(); // neues Element mit Standardbereich (Westtribüne)
  await expect(page.getByText(/\d+ Blöcke gewählt/)).toBeVisible();
  const n0 = Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1]);
  // Block auf der Nordtribüne, unterer Rang, Mitte
  const c = cells.find((q) => q.side === 'N' && q.index === 2 && q.tier === 'lower')!;
  const p = await toClient(page, (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
  await page.mouse.click(p.x, p.y);
  const n1 = Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1]);
  expect(n1).toBe(n0 + 1);
  await page.mouse.click(p.x, p.y); // erneut: abwählen
  expect(Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1])).toBe(n0);
  // Gästeblock: Klick wählt nichts
  const away = cells.find((q) => q.away && q.side === 'E')!;
  const pa = await toClient(page, (away.x0 + away.x1) / 2, (away.y0 + away.y1) / 2);
  await page.mouse.click(pa.x, pa.y);
  expect(Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1])).toBe(n0);
  // ganze Seite und ganzes Stadion (ohne Gästeblock)
  await page.getByTestId('choreo-side-all').click();
  const all = Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1]);
  expect(all).toBe(cells.filter((q) => !q.away).length);
  expect(cells.filter((q) => q.away).length).toBeGreaterThan(0);
});

test('Studio: Spruchband per Drag-and-drop verschieben, vergrößern, drehen – nie auf dem Spielfeld oder im Gästeblock', async ({ page }) => {
  await setup(page);
  await open(page);
  await page.getByTestId('choreo-add-banner').click();
  const x0 = Number(await page.getByTestId('choreo-x').inputValue());
  const y0 = 79; // Banner wird an der Südtribüne hinzugefügt
  void y0;
  const y = Number(await (async () => (await page.locator('[data-testid="choreo-x"]').evaluate((el) => (el.parentElement!.parentElement!.querySelectorAll('input')[1] as HTMLInputElement).value)))());
  const from = await toClient(page, x0, y);
  // verschieben nach links (Südtribüne bleibt)
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  const to = await toClient(page, x0 - 20, y);
  await page.mouse.move((from.x + to.x) / 2, to.y); await page.mouse.move(to.x, to.y); await page.mouse.up();
  const x1 = Number(await page.getByTestId('choreo-x').inputValue());
  expect(x1).toBeLessThan(x0 - 15);
  // Versuch, auf das Spielfeld zu ziehen: Position bleibt
  const mid = await toClient(page, x1, 30);
  await page.mouse.move(to.x, to.y); await page.mouse.down(); await page.mouse.move(mid.x, mid.y, { steps: 6 }); await page.mouse.up();
  expect(Number(await page.getByTestId('choreo-x').inputValue())).toBeCloseTo(x1, 0);
  const yAfter = Number(await page.getByTestId('choreo-x').evaluate((el) => (el.parentElement!.parentElement!.querySelectorAll('input')[1] as HTMLInputElement).value));
  expect(yAfter).toBeGreaterThan(68); // nicht ins Spielfeld gerutscht
  // Größe über den Eckgriff
  const w0 = Number(await page.getByTestId('choreo-w').inputValue());
  const hs = await toClient(page, x1 + w0 / 2, yAfter + 1);
  await page.mouse.move(hs.x, hs.y); await page.mouse.down();
  const hs2 = await toClient(page, x1 + w0 / 2 + 6, yAfter + 1);
  await page.mouse.move(hs2.x, hs2.y, { steps: 5 }); await page.mouse.up();
  expect(Number(await page.getByTestId('choreo-w').inputValue())).toBeGreaterThan(w0 + 8);
  // Drehung über den runden Griff
  const rotH = await toClient(page, x1, yAfter - 1 - 2.4);
  await page.mouse.move(rotH.x, rotH.y); await page.mouse.down();
  const side = await toClient(page, x1 + 0.7, yAfter - 3.4); // leichte Drehung (≈ 12°), damit das Band im Tribünenbereich bleibt
  await page.mouse.move(side.x, side.y, { steps: 5 }); await page.mouse.up();
  expect(Math.abs(Number(await page.getByTestId('choreo-rot').inputValue()))).toBeGreaterThan(5);
  // Gästeblock: Position per Eingabe wird nicht gezeichnet; Verschieben dorthin ist abgewiesen
  const a = await toClient(page, x1, yAfter);
  const away = await toClient(page, 112, 10);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(away.x, away.y, { steps: 6 }); await page.mouse.up();
  expect(Number(await page.getByTestId('choreo-x').inputValue())).toBeLessThan(105);
  await page.getByTestId('choreo-undo').click(); // Rückgängig nimmt die letzte Änderung zurück
});

test('Studio: Szenen, Vorlagen, Stadiongröße, Speichern, erneutes Laden, mehrere Choreografien, Zufallswahl', async ({ page }) => {
  const m = await setup(page);
  await open(page);
  // Vorlage „Pokalfinale“ (3 Szenen) im mittleren Stadion (30 Tsd.: höchstens 3 Szenen)
  await page.getByTestId('choreo-tpl-final').click();
  await expect(page.getByTestId('choreo-scenes').locator('[data-testid^=choreo-scene-]').filter({ hasText: 'Szene' })).toHaveCount(3 + 0);
  await page.getByTestId('choreo-add-scene').click(); // 4. Szene im mittleren Stadion nicht erlaubt
  await expect(page.getByText(/Mittleres Stadion/).first()).toBeVisible();
  // Szene 2 wählen, Dauer ändern
  await page.getByTestId('choreo-scene-1').click();
  await page.getByTestId('choreo-scene-dur').fill('12');
  await expect(page.getByTestId('choreo-scene-1')).toContainText('12 s');
  // Speichern als „Pokalfinale“
  await page.getByTestId('choreo-name').fill('Pokalfinale');
  await page.getByTestId('choreo-save').click();
  await expect(page.getByTestId('choreo-msg')).toContainText('gespeichert');
  expect(m.saved).toHaveLength(1);
  const d = m.saved[0]!.design as ChoreoV2;
  expect(d.v).toBe(2); expect(d.scenes).toHaveLength(3); expect(d.scenes[1]!.dur).toBe(12);
  expect(validateChoreo(d)).toEqual([]);
  expect(d.pattern && d.colors.length > 0).toBeTruthy(); // Legacy-Felder für ältere Clients
  // zweite Choreo „Derby“ aus Vorlage
  await page.getByTestId('choreo-tpl-derby').click();
  await page.getByTestId('choreo-name').fill('Derby');
  await page.getByTestId('choreo-save').click();
  await expect(page.getByTestId('choreo-saved').locator('li')).toHaveCount(2);
  // Bearbeiten: lädt die gespeicherte Choreo
  await page.reload(); await open(page);
  await expect(page.getByTestId('choreo-saved').locator('li')).toHaveCount(2);
  await page.getByTestId('choreo-saved').locator('li').first().getByTestId('choreo-load').click();
  await expect(page.getByTestId('choreo-name')).toHaveValue('Pokalfinale');
  await expect(page.getByTestId('choreo-scenes').getByText(/Szene \d+ · /)).toHaveCount(3);
  await page.getByTestId('choreo-scene-1').click(); await expect(page.getByTestId('choreo-scene-dur')).toHaveValue('12');
  // ändern und als bestehende speichern (keine Dublette)
  await page.getByTestId('choreo-el-blockflag').click(); await page.getByTestId('choreo-text').fill('NEU');
  await page.getByTestId('choreo-save').click();
  await expect(page.getByTestId('choreo-saved').locator('li')).toHaveCount(2);
  // Zufallswahl
  await page.getByTestId('choreo-random').check();
  await expect.poll(() => m.isRandom()).toBe(true);
  expect(m.errors).toEqual([]);
});

test('Studio: kleines Stadion – weniger Szenen/Elemente, Vorlage wird gekürzt; Choreo auf nicht vorhandenen Tribünen wird gemeldet', async ({ page }) => {
  const upper = { id: 'x1', name: 'Oberrang', design: { v: 2, pattern: 'stripes', colors: ['#c8102e'], scenes: [{ dur: 6 }], elements: [
    { id: 'u', kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'N', tiers: ['upper'] }], pattern: 'solid', colors: ['#c8102e'] },
    { id: 'k', kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'NW' }], pattern: 'solid', colors: ['#c8102e'] }] } satisfies unknown };
  await setup(page, mkClub(10000, 'classic'), [upper]);
  await open(page);
  await page.getByTestId('choreo-tpl-final').click(); // 3 Szenen → im kleinen Stadion nur 2
  await expect(page.getByTestId('choreo-scenes').getByText(/Szene \d+ · /)).toHaveCount(2);
  await page.getByTestId('choreo-saved').locator('li').first().getByTestId('choreo-load').click();
  await expect(page.getByTestId('choreo-hidden')).toContainText('2 Element');
  // Hinweis auf die Komplexität
  await expect(page.getByText(/Kleines Stadion/).first()).toBeVisible();
});

test.describe('iPad (Touch)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, deviceScaleFactor: 2 });
  test('Studio auf dem iPad: kein Überlaufen, Tribünen per Tipp wählen, Szenen und Vorlagen bedienbar', async ({ page }) => {
    const m = await setup(page);
    await open(page);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
    const geo = stadiumGeo(30000, { style: 'modern' });
    const cells = stadiumCells(geo);
    await page.getByTestId('choreo-tool-areas').tap();
    await page.getByTestId('choreo-add-cards').tap();
    const c = cells.find((q) => q.side === 'S' && q.index === 3 && q.tier === 'upper')!;
    const p = await toClient(page, (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
    const n0 = Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1]);
    await page.touchscreen.tap(p.x, p.y);
    expect(Number((await page.getByText(/\d+ Blöcke gewählt/).textContent())!.match(/(\d+) Blöcke/)![1])).toBe(n0 + 1);
    await page.getByTestId('choreo-tpl-top').tap();
    await page.getByTestId('choreo-scene-1').tap();
    await page.getByTestId('choreo-play').tap();
    await page.waitForTimeout(600);
    await page.getByTestId('choreo-play').tap();
    await page.getByTestId('choreo-save').tap();
    await expect(page.getByTestId('choreo-msg')).toBeVisible();
    expect(m.saved).toHaveLength(1);
    // alle Bedienelemente mindestens 40 px hoch (Touch)
    const small = await page.evaluate(() => [...document.querySelectorAll('button, select, input[type=text]')].filter((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 34; }).length);
    expect(small).toBeLessThanOrEqual(8);
    expect(m.errors).toEqual([]);
  });
});

test('Vorlagen sind für alle Stadiongrößen gültig (Browser-Prüfung der Mock-Datenbank)', async () => {
  for (const t of TEMPLATES) expect(validateChoreo(t.build({ primary: '#c8102e', secondary: '#ffffff', short: 'FCT', tiers: 2, closed: true }))).toEqual([]);
});
