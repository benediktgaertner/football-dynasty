import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Liga-Startmenü und Liga-Einstellungen (KI-Stadionatmosphäre, Migration 0041) gegen die lokale Datenbank mit allen
 * Migrationen und RLS; Storage über den lokalen Supabase-Ersatz (Rechte prüft storage.objects mit den echten Policies).
 */
const MOCK = 'http://127.0.0.1:8793';
const KEY = 'sb-127-auth-token';
let n = 0;
const uniq = (p: string) => `${p}${Date.now().toString(36)}${n++}`;
interface Legacy { session: { access_token: string; refresh_token: string; user: { id: string } }; user_id: string; world: string; club: string; code: string }
async function legacy(request: APIRequestContext, o: { username: string; world?: string; code?: string; club: string; short: string }): Promise<Legacy> {
  const r = await request.post(`${MOCK}/__test/legacy`, { data: o });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
async function device(context: BrowserContext, s: Legacy['session']) {
  await context.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, [KEY, JSON.stringify(s)] as const);
}
const mp3 = (name: string) => ({ name, mimeType: 'audio/mpeg', buffer: readFileSync(new URL(`../host-audio/${name}`, import.meta.url)) });
async function uploadFiles(page: Page, cat: 'chant' | 'boo' | 'goal', names: string[]) {
  await page.getByTestId(`upload-${cat}`).setInputFiles(names.map(mp3));
  await expect(page.getByTestId(`list-${cat}`).getByTestId('audio-item')).toHaveCount(names.length, { timeout: 20_000 });
}

test('Host: Liga-Menü, Einstellungen, Upload je Kategorie, Neuladen, Probehören, Entfernen; Mitglied: nur lesen, keine Änderungen', async ({ browser, request }) => {
  const H = await legacy(request, { username: uniq('Host').slice(0, 16), world: uniq('Y-City').slice(0, 20), club: uniq('FC Host').slice(0, 24), short: 'FCH' });
  const M = await legacy(request, { username: uniq('Gast').slice(0, 16), code: H.code, club: uniq('SV Gast').slice(0, 24), short: 'SVG' });
  expect(M.world).toBe(H.world);

  // ---------------- Host
  const hc = await browser.newContext(); await device(hc, H.session);
  const hp = await hc.newPage();
  await hp.goto('/');
  // anonymer Altaccount: Hinweis zur Kontosicherung zuerst schließen
  const later = hp.getByTestId('secure-later');
  if (await later.waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)) await later.click();
  await hp.getByTestId('world-link').first().click();
  await expect(hp.getByTestId('league-start')).toBeVisible();
  await expect(hp.getByTestId('enter-league')).toBeVisible();
  await hp.getByTestId('open-league-settings').click();
  await expect(hp.getByTestId('league-settings')).toBeVisible();
  for (const c of ['chant', 'boo', 'goal'] as const) await expect(hp.getByTestId(`count-${c}`)).toContainText('0 Dateien');

  // mehrere Dateien gleichzeitig je Kategorie
  await uploadFiles(hp, 'chant', ['chant_1.mp3', 'chant_2.mp3', 'chant_3.mp3']);
  await uploadFiles(hp, 'boo', ['boo_1.mp3', 'boo_lang.mp3']);
  await uploadFiles(hp, 'goal', ['goal_1.mp3', 'goal_2.mp3']);
  await expect(hp.getByTestId('count-chant')).toContainText('3 Dateien');
  await expect(hp.getByTestId('list-boo').getByTestId('audio-duration').last()).toHaveText(/0:1\d|0:0\d/); // Dauer angezeigt
  await expect(hp.getByTestId('list-chant').getByTestId('audio-name').first()).toHaveText('chant_1.mp3');

  // falsche Datei ⇒ verständlicher Fehler, nichts gespeichert
  await hp.getByTestId('upload-goal').setInputFiles({ name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('kein mp3') });
  await expect(hp.getByTestId('upload-error').first()).toContainText('keine MP3');
  await expect(hp.getByTestId('count-goal')).toContainText('2 Dateien');

  // nach Neuladen weiterhin vorhanden
  await hp.reload();
  await expect(hp.getByTestId('count-chant')).toContainText('3 Dateien');
  await expect(hp.getByTestId('count-boo')).toContainText('2 Dateien');
  await expect(hp.getByTestId('count-goal')).toContainText('2 Dateien');

  // Probehören: signierte URL, Wiedergabe startet (Stopp-Taste), erneuter Klick stoppt
  const first = hp.getByTestId('list-chant').getByTestId('preview').first();
  await first.click();
  await expect(first).toHaveAttribute('aria-label', 'Stopp');
  await first.click();
  await expect(first).toHaveAttribute('aria-label', 'Probehören');

  // Entfernen (mit Bestätigung)
  const item = hp.getByTestId('list-chant').getByTestId('audio-item').last();
  await item.getByTestId('delete').click();
  await item.getByTestId('confirm-delete').click();
  await expect(hp.getByTestId('count-chant')).toContainText('2 Dateien');
  await hp.reload();
  await expect(hp.getByTestId('list-chant').getByTestId('audio-item')).toHaveCount(2);

  // ---------------- Mitglied (kein Host)
  const mc = await browser.newContext(); await device(mc, M.session);
  const mp = await mc.newPage();
  await mp.goto(`/w/${M.world}/start`);
  await expect(mp.getByTestId('league-start')).toBeVisible();
  await expect(mp.getByTestId('enter-league')).toBeVisible();
  await expect(mp.getByTestId('open-league-settings')).toHaveCount(0); // Button nur für den Host
  await expect(mp.getByTestId('league-start').locator('..')).toContainText('2 Fangesänge · 2 Pfiffe/Buhrufe · 2 Torjubel'); // gleiche Liga-Sounds für alle
  await mp.goto(`/w/${M.world}/einstellungen`); // direkte URL
  await expect(mp.getByTestId('not-host')).toBeVisible();
  await expect(mp.getByTestId('upload-chant')).toHaveCount(0);

  // direkte API-/Storage-Aufrufe des Mitglieds werden abgewiesen
  const tok = M.session.access_token;
  const hdr = { authorization: `Bearer ${tok}`, apikey: 'x' };
  const path = `${M.world}/chant/${crypto.randomUUID()}.mp3`;
  const up = await request.post(`${MOCK}/storage/v1/object/world-audio/${path}`, { headers: { ...hdr, 'content-type': 'audio/mpeg' }, data: readFileSync(new URL('../host-audio/chant_4.mp3', import.meta.url)) });
  expect(up.status()).toBe(403);
  const add = await request.post(`${MOCK}/rest/v1/rpc/add_world_ai_audio`, { headers: hdr, data: { p_world: M.world, p_category: 'chant', p_name: 'x', p_path: path, p_duration: 7 } });
  expect(add.status()).toBe(403);
  const s = await (await request.post(`${MOCK}/rest/v1/rpc/world_ai_audio_settings`, { headers: hdr, data: { p_world: M.world } })).json();
  expect(s.is_host).toBe(false);
  expect(s.files.length).toBe(6);
  const del = await request.post(`${MOCK}/rest/v1/rpc/delete_world_ai_audio`, { headers: hdr, data: { p_id: s.files[0].id } });
  expect(del.status()).toBe(403);
  const rm = await request.delete(`${MOCK}/storage/v1/object/world-audio`, { headers: hdr, data: { prefixes: [s.files[0].path] } });
  expect(await rm.json()).toEqual([]); // nichts gelöscht
  // Mitglied darf abspielen (signierte URL), Fremde nicht
  const signed = await (await request.post(`${MOCK}/storage/v1/object/sign/world-audio`, { headers: hdr, data: { paths: [s.files[0].path], expiresIn: 60 } })).json();
  expect(signed[0].signedURL).toBeTruthy();
  const X = await legacy(request, { username: uniq('Fremd').slice(0, 16), world: uniq('Andere').slice(0, 20), club: uniq('FC Fremd').slice(0, 24), short: 'FCF' });
  const xs = await (await request.post(`${MOCK}/storage/v1/object/sign/world-audio`, { headers: { authorization: `Bearer ${X.session.access_token}`, apikey: 'x' }, data: { paths: [s.files[0].path], expiresIn: 60 } })).json();
  expect(xs[0].signedURL).toBeNull();
  const xr = await request.post(`${MOCK}/rest/v1/rpc/world_ai_audio_settings`, { headers: { authorization: `Bearer ${X.session.access_token}`, apikey: 'x' }, data: { p_world: M.world } });
  expect(xr.status()).toBe(403);
  await hc.close(); await mc.close();
});

test('iPad: Liga-Einstellungen bedienbar (Touch, schmale Breite)', async ({ browser, request }) => {
  const H = await legacy(request, { username: uniq('Pad').slice(0, 16), world: uniq('Pad-Liga').slice(0, 20), club: uniq('FC Pad').slice(0, 24), short: 'FCP' });
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true });
  await device(ctx, H.session);
  const p = await ctx.newPage();
  await p.goto(`/w/${H.world}/start`);
  await p.getByTestId('open-league-settings').tap();
  await uploadFiles(p, 'goal', ['goal_1.mp3']);
  await expect(p.getByTestId('count-goal')).toContainText('1 Datei');
  const box = await p.getByTestId('list-goal').getByTestId('preview').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40); // Fingergröße
  await ctx.close();
});
