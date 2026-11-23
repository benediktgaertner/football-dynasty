import { expect, test, type Page } from '@playwright/test';
import { regionSeats, stadiumGeo } from '../src/lib/choreo/geometry';

/**
 * Choreografien in der echten Matchansicht (echter Match-Server, Echtzeit): sichtbar im Spielereinlauf, alle Seiten, Ecken, Ränge,
 * Gästeblock unberührt, Szenenfolge, beständige Elemente im Spiel, Multiplayer-Gleichheit, Bildrate/Spielgeschwindigkeit.
 * Die Pixelprobe liest die Zeichenfläche an den echten Sitzpositionen (gleiche Geometrie wie der Editor).
 */
const SERVER = 'ws://127.0.0.1:8791/match';
let run = 0;
const fx = (name: string) => { run++; return `${name}#${Date.now()}-${run}`; };
async function open(page: Page, fixture: string, token = 'token-home-xxxx') {
  await page.goto(`/e2e/harness.html?fixture=${encodeURIComponent(fixture)}&token=${token}&server=${encodeURIComponent(SERVER)}`);
  await page.waitForFunction(() => !!(window as any).__fd?.state().status);
}
const pitch = (p: Page) => p.evaluate(() => (window as any).__fd.pitch());
const state = (p: Page) => p.evaluate(() => (window as any).__fd.state());
async function walkout(page: Page) {
  await page.waitForFunction(() => { const s = (window as any).__fd.state(); return s.status === 'waiting' && !!s.walkoutEndsAt && (window as any).__fd.pitch()?.view; });
}
/** Farbe an einer Stadionposition (Meter) auf der Zeichenfläche */
const px = (page: Page, x: number, y: number) => page.evaluate(([mx, my]) => {
  const w = window as any, v = w.__fdPitch.view as { s: number; ox: number; oy: number };
  const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0] as HTMLCanvasElement;
  const d = c.getContext('2d')!.getImageData(Math.round(v.ox + mx! * v.s), Math.round(v.oy + my! * v.s), 1, 1).data;
  return [d[0]!, d[1]!, d[2]!];
}, [x, y] as const);
const isMagenta = (c: number[]) => c[0]! > 200 && c[1]! < 70 && c[2]! > 200;
const isCyan = (c: number[]) => c[0]! < 70 && c[1]! > 200 && c[2]! > 200;
const isGreen = (c: number[]) => c[0]! < 70 && c[1]! > 200 && c[2]! < 70;
/** Zeit seit Beginn des Einlaufs (s) */
const elapsed = (page: Page) => page.evaluate(() => (Date.now() - (window as any).__fd.state().walkoutStartedAt) / 1000);
async function waitElapsed(page: Page, sec: number) { await page.waitForFunction((t) => (Date.now() - (window as any).__fd.state().walkoutStartedAt) / 1000 >= t, sec, { timeout: 40_000 }); }
const total = (page: Page) => page.evaluate(() => { const s = (window as any).__fd.state(); return (s.walkoutEndsAt - s.walkoutStartedAt) / 1000; });
const sample = <T,>(a: T[], n: number): T[] => { const out: T[] = []; for (let i = 0; i < n; i++) out.push(a[Math.min(a.length - 1, Math.floor(((i + 0.5) / n) * a.length))]!); return out; };
const geo30 = stadiumGeo(30000, {});
/** Mindestens 75 % der Proben erfüllen die Bedingung (einzelne Sitze können von Schwenkfahnen o. Ä. überdeckt sein) */
async function mostly(page: Page, seats: Array<{ seat: { x: number; y: number } }>, pred: (c: number[]) => boolean, expected: boolean, label: string) {
  let ok = 0; const bad: string[] = [];
  for (const s of seats) { const c = await px(page, s.seat.x, s.seat.y); if (pred(c) === expected) ok++; else bad.push(`${s.seat.x.toFixed(1)},${s.seat.y.toFixed(1)}:${c.join('/')}`); }
  expect(ok / seats.length, `${label}: ${bad.join(' ')}`).toBeGreaterThanOrEqual(0.75);
}

test.describe('Choreografie im Einlauf', () => {
  test('Szenenfolge: Karten → Blockfahne → Fahnen/Konfetti; Spruchband bleibt; mehrere Elemente gleichzeitig; Gästeblock bleibt frei', async ({ page }) => {
    await open(page, fx('choreo-show')); await walkout(page);
    const T = await total(page);
    const D = 17, scale = D > T ? D / T : 1;
    const west = sample(regionSeats(geo30, [{ side: 'W' }]), 10);
    const away = sample(geo30.seats.filter((s) => s.seat.away), 6);
    // Szene 1 (0–5 s): magentafarbene Karten auf der Westtribüne
    await waitElapsed(page, 2.2 / scale);
    await mostly(page, west, isMagenta, true, 'Karten Westtribüne');
    // Spruchband (beständig, grün) – Pixel abseits der Schrift
    expect(isGreen(await px(page, 52 + 8, 74.2))).toBe(true);
    // Gästeblock: keine Choreo-Farben
    await mostly(page, away, (c) => isMagenta(c) || isCyan(c), false, 'Gästeblock frei');
    expect(((await pitch(page)).choreo as string[])).toEqual(expect.arrayContaining(['c1', 'bn']));
    // Szene 2 (5–11 s): cyanfarbene Blockfahne ersetzt die Karten
    await waitElapsed(page, 8 / scale);
    await mostly(page, west, isCyan, true, 'Blockfahne Westtribüne');
    const ids2 = (await pitch(page)).choreo as string[];
    expect(ids2).toContain('bf'); expect(ids2).not.toContain('c1');
    // Szene 3 (11–17 s): Fahnen + Konfetti + Spruchband gleichzeitig
    await waitElapsed(page, 14 / scale);
    const ids3 = (await pitch(page)).choreo as string[];
    expect(ids3).toEqual(expect.arrayContaining(['fl', 'cf', 'bn']));
    expect(ids3).not.toContain('bf');
    expect(isGreen(await px(page, 52 + 8, 74.2))).toBe(true);
  });

  test('nach dem Einlauf bleiben Fahnen und Banner, große Choreo und Konfetti verschwinden', async ({ page }) => {
    await open(page, fx('choreo-show')); await walkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
    await page.waitForFunction(() => { const p = (window as any).__fd.pitch(); return p?.mode === 'play' && Array.isArray(p.choreo); });
    // Anstoß: Schlusszustand (Fahnen, Banner, Konfetti)
    expect(((await pitch(page)).choreo as string[]).sort()).toEqual(['bn', 'cf', 'fl']);
    // später im Spiel: nur noch beständige Elemente (Fahnen, Banner)
    await page.waitForFunction(() => (window as any).__fd.pitch()?.minute >= 6.5, null, { timeout: 40_000 });
    expect(((await pitch(page)).choreo as string[]).sort()).toEqual(['bn', 'fl']);
    expect(isGreen(await px(page, 52 + 8, 74.2))).toBe(true); // Banner steht weiter
    // Spielfeld bleibt frei: Pixel in der Spielfeldmitte ist Rasen (grün, nicht Choreo-Magenta/Cyan)
    const mid = await px(page, 52.5, 34);
    expect(isMagenta(mid) || isCyan(mid)).toBe(false);
  });

  test('Spielgeschwindigkeit bleibt unverändert (20 Ticks/s) bei großer Choreografie', async ({ page }) => {
    await open(page, fx('choreo-heavy')); await walkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.pitch()?.mode === 'play');
    const a = await pitch(page); await page.waitForTimeout(3000); const b = await pitch(page);
    expect(b.tick - a.tick).toBeGreaterThanOrEqual(52); // ≈ 60 in 3 s
    expect(((await pitch(page)).choreo as string[]).length).toBeGreaterThan(8);
  });
});

test.describe('Stadiumgeometrie in der Partie', () => {
  test('ganzes Stadion (mittel, geschlossen): alle Seiten und Ecken, Gästeblock bleibt unberührt', async ({ page }) => {
    await open(page, fx('choreo-whole')); await walkout(page);
    await waitElapsed(page, 2);
    for (const side of ['N', 'S', 'W', 'E', 'NW', 'SW', 'SE'] as const) {
      const seats = sample(regionSeats(geo30, [{ side }]), 8);
      expect(seats.length, side).toBeGreaterThan(0);
      await mostly(page, seats, isMagenta, true, `Seite ${side}`);
    }
    const awaySeats = sample(geo30.seats.filter((s) => s.seat.away), 16);
    for (const s of awaySeats) expect(isMagenta(await px(page, s.seat.x, s.seat.y)), `Gästeblock ${s.seat.x},${s.seat.y}`).toBe(false); // hier gilt: nie
  });

  test('kleines Stadion (10 Tsd., offene Ecken): vier Seiten, keine Ecken; Spielfeld frei', async ({ page }) => {
    const g = stadiumGeo(10000, { style: 'classic' });
    await open(page, fx('choreo-small')); await walkout(page);
    await waitElapsed(page, 2);
    expect(g.closed).toBe(false);
    for (const side of ['N', 'S', 'W', 'E'] as const) await mostly(page, sample(regionSeats(g, [{ side }]), 8), isMagenta, true, `klein ${side}`);
    for (const c of ['NW', 'NE', 'SW', 'SE'] as const) expect(regionSeats(g, [{ side: c }])).toHaveLength(0);
    expect(isMagenta(await px(page, 52.5, 34))).toBe(false);
  });

  test('großes Stadion (50 Tsd., drei Ränge): Oberrang Nord und Unterrang Süd – andere Ränge bleiben frei', async ({ page }) => {
    const g = stadiumGeo(50000, { style: 'modern' });
    expect(g.tiers).toBe(3);
    await open(page, fx('choreo-large')); await walkout(page);
    await waitElapsed(page, 2);
    const nUp = sample(regionSeats(g, [{ side: 'N', tiers: ['upper'] }]), 5), nLow = sample(regionSeats(g, [{ side: 'N', tiers: ['lower'] }]), 5), nMid = sample(regionSeats(g, [{ side: 'N', tiers: ['middle'] }]), 5);
    const sLow = sample(regionSeats(g, [{ side: 'S', tiers: ['lower'] }]), 5), sUp = sample(regionSeats(g, [{ side: 'S', tiers: ['upper'] }]), 5);
    await mostly(page, [...nUp, ...sLow], isCyan, true, 'Ränge gewählt');
    for (const s of [...nLow, ...nMid, ...sUp]) expect(isCyan(await px(page, s.seat.x, s.seat.y)), 'nicht gewählter Rang bleibt frei').toBe(false);
  });
});

test.describe('Multiplayer', () => {
  test('beide Manager sehen dieselbe Choreografie zur selben Zeit (Heim- und Auswärtsspieler)', async ({ browser }) => {
    const room = fx('choreo-mp');
    const home = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    const away = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
    await open(home, room); await open(away, room, 'token-away-xxxx');
    await walkout(home); await walkout(away);
    const T = await total(home), scale = 17 > T ? 17 / T : 1;
    const west = sample(regionSeats(geo30, [{ side: 'W' }]), 8);
    for (const [sec, test_] of [[2.5, isMagenta], [8, isCyan]] as const) {
      await waitElapsed(home, sec / scale); await waitElapsed(away, sec / scale);
      const [ih, ia] = [((await pitch(home)).choreo as string[]).join(','), ((await pitch(away)).choreo as string[]).join(',')];
      expect(ia).toBe(ih);
      await mostly(home, west, test_, true, 'Heim sieht Choreo'); await mostly(away, west, test_, true, 'Gast sieht Choreo');
    }
    await home.context().close(); await away.context().close();
  });
});

test.describe('Performance (Bildrate im Einlauf)', () => {
  async function frames(page: Page, ms: number) {
    return page.evaluate((dur) => new Promise<number[]>((res) => {
      const d: number[] = []; let last = performance.now(); const end = last + dur;
      const f = (t: number) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(d); };
      requestAnimationFrame(f);
    }), ms);
  }
  const stats = (d: number[]) => { const s = [...d].sort((a, b) => a - b); return { mean: d.reduce((a, b) => a + b, 0) / d.length, p95: s[Math.floor(s.length * 0.95)]!, max: s[s.length - 1]!, n: d.length }; };
  for (const [label, vp, dpr] of [['Desktop', { width: 1100, height: 900 }, 1], ['iPad', { width: 820, height: 1180 }, 2]] as const) {
    test(`${label}: viele gleichzeitige Elemente (Konfetti, Rauch, Luftschlangen, 40 Doppelfahnen, Welle) verursachen keine Bildrateneinbrüche`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr });
      // nacheinander (Hintergrund-Tabs werden vom Browser gedrosselt und verfälschen die Messung)
      const base = await ctx.newPage();
      await open(base, fx('choreo-none')); await walkout(base); await base.waitForTimeout(2000);
      const b = stats(await frames(base, 4000));
      await base.close();
      const heavy = await ctx.newPage();
      await open(heavy, fx('choreo-heavy')); await walkout(heavy); await heavy.waitForTimeout(2000);
      const ids = (await pitch(heavy)).choreo as string[];
      expect(ids.length).toBeGreaterThan(8); // alle Elemente sind tatsächlich aktiv
      const h = stats(await frames(heavy, 4000));
      console.log(`BILDRATE ${label}: ohne Choreo Ø ${b.mean.toFixed(1)} ms (p95 ${b.p95.toFixed(1)}, max ${b.max.toFixed(0)}, ${b.n} Frames) · mit Choreo Ø ${h.mean.toFixed(1)} ms (p95 ${h.p95.toFixed(1)}, max ${h.max.toFixed(0)}, ${h.n} Frames)`);
      expect(h.mean).toBeLessThan(Math.max(b.mean * 1.6, b.mean + 6)); // höchstens leicht langsamer als ohne Choreo
      expect(h.p95).toBeLessThan(Math.max(50, b.p95 * 1.8));
      expect(h.n).toBeGreaterThan(b.n * 0.55);
      await ctx.close();
    });
  }
});
