import { expect, test, type Page } from '@playwright/test';

/**
 * Matchansicht Ende-zu-Ende: echter Match-Server (Echtzeit) + echte Komponenten im Browser.
 * Diagnose über window.__fd (Zustand, Mixer, Hüllkurve, Spielfeld-Modus).
 */
const SERVER = 'ws://127.0.0.1:8791/match';
let run = 0;
/** jede Partie bekommt einen eigenen Raum (Fixture-Name#Lauf) */
function fx(name: string) { run++; return `${name}#${Date.now()}-${run}`; }

async function open(page: Page, fixture: string, token = 'token-home-xxxx') {
  await page.goto(`/e2e/harness.html?fixture=${encodeURIComponent(fixture)}&token=${token}&server=${encodeURIComponent(SERVER)}`);
  await page.waitForFunction(() => !!(window as any).__fd?.state().status);
}
const st = (p: Page) => p.evaluate(() => (window as any).__fd.state());
const mix = (p: Page) => p.evaluate(() => (window as any).__fd.mixer());
const pitch = (p: Page) => p.evaluate(() => (window as any).__fd.pitch());
const snd = (p: Page) => p.evaluate(() => (window as any).__fd.sound());

async function waitWalkout(page: Page) {
  await page.waitForFunction(() => { const s = (window as any).__fd.state(); return s.status === 'waiting' && !!s.walkoutEndsAt; });
}
async function anthemPlaying(page: Page) {
  await page.waitForFunction(() => (window as any).__fd.mixer().anthem.length === 1, null, { timeout: 15_000 });
}

/** Überspringen: sofort Anpfiff, keine Einlauf-Animation, Einlauf-Audio aus, Spieler auf Startpositionen */
async function expectImmediateKickoff(page: Page, clickedAt: number) {
  await page.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 3000 });
  expect(Date.now() - clickedAt).toBeLessThan(1500);
  await expect(page.getByTestId('skip-walkout')).toHaveCount(0);
  // nächster Frame: Spielfeld zeigt das Spiel (kein Einlauf), Ball am Anstoßpunkt
  await page.waitForFunction(() => (window as any).__fd.pitch()?.mode === 'play');
  const p = await pitch(page);
  expect(Math.abs(p.ball[0] - 52.5)).toBeLessThan(6);
  expect(Math.abs(p.ball[1] - 34)).toBeLessThan(6);
  // Einlaufmusik nach ≤ 0,5 s vollständig gestoppt
  await page.waitForTimeout(500);
  expect((await mix(page)).anthem).toEqual([]);
}

test.describe('Einlauf & Hymne überspringen', () => {
  test('Heimspiel mit eigener Hymne (gegen KI): Überspringen ⇒ sofort Anpfiff', async ({ page }) => {
    await open(page, fx('home-anthem-ai'));
    await waitWalkout(page);
    await anthemPlaying(page);
    expect((await pitch(page)).mode).toBe('walkout');
    const s = await st(page);
    expect(s.walkoutEndsAt - s.walkoutStartedAt).toBeGreaterThan(17_000); // 15 s Hymne + Ausklang
    await expect(page.getByTestId('skip-walkout')).toHaveText(/Einlauf & Hymne überspringen/);
    const t = Date.now();
    await page.getByTestId('skip-walkout').click();
    await expectImmediateKickoff(page, t);
  });

  test('Auswärtsspiel gegen KI ohne Hymne: kurze Sequenz, Überspringen sofort', async ({ page }) => {
    await open(page, fx('away-noanthem-ai'), 'token-away-xxxx');
    await waitWalkout(page);
    const s = await st(page);
    expect(s.walkoutEndsAt - s.walkoutStartedAt).toBeLessThanOrEqual(12_500);
    expect((await mix(page)).anthem).toEqual([]);
    const t = Date.now();
    await page.getByTestId('skip-walkout').click();
    await expectImmediateKickoff(page, t);
  });

  test('Heimspiel ohne Hymne: Überspringen sofort', async ({ page }) => {
    await open(page, fx('home-noanthem-ai'));
    await waitWalkout(page);
    const t = Date.now();
    await page.getByTestId('skip-walkout').click();
    await expectImmediateKickoff(page, t);
  });

  for (const [name, label] of [['cup-anthem-ai', 'Pokalspiel'], ['cl-anthem-ai', 'Champions League']] as const) {
    test(`${label}: Überspringen sofort`, async ({ page }) => {
      await open(page, fx(name));
      await waitWalkout(page);
      await anthemPlaying(page);
      const t = Date.now();
      await page.getByTestId('skip-walkout').click();
      await expectImmediateKickoff(page, t);
    });
  }

  test('Heimspiel ohne Hymne, nicht übersprungen: kurze Einlaufsequenz (≈ 12 s), dann Anpfiff', async ({ page }) => {
    await open(page, fx('home-noanthem-ai'));
    await waitWalkout(page);
    const s = await st(page);
    const t0 = Date.now();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 20_000 });
    expect(Date.now() - t0).toBeLessThan(s.walkoutEndsAt - t0 + 1500);
    expect(s.walkoutEndsAt - s.walkoutStartedAt).toBeLessThanOrEqual(12_500);
  });

  test('Hymne nicht übersprungen: läuft vollständig, Anpfiff erst danach', async ({ page }) => {
    await open(page, fx('home-anthem-full'));
    await waitWalkout(page);
    await anthemPlaying(page);
    // nach 13 s läuft die 15-s-Hymne noch, Spieler stehen vor der Haupttribüne
    await page.waitForTimeout(13_000);
    expect((await mix(page)).anthem.length).toBe(1);
    expect((await st(page)).status).toBe('waiting');
    expect((await pitch(page)).mode).toBe('walkout');
    // Hymne endet, danach Anpfiff
    await page.waitForFunction(() => (window as any).__fd.mixer().anthem.length === 0, null, { timeout: 6000 });
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 6000 });
  });

  test('Multiplayer: Überspringen nur gemeinsam, beide erleben denselben Anpfiff', async ({ browser }) => {
    const f = fx('mp-anthem');
    const home = await (await browser.newContext()).newPage();
    const away = await (await browser.newContext()).newPage();
    await open(home, f, 'token-home-xxxx');
    await open(away, f, 'token-away-xxxx');
    await waitWalkout(home); await waitWalkout(away);
    await home.getByTestId('skip-walkout').click();
    await expect(home.getByTestId('skip-waiting')).toContainText('1/2');
    await home.waitForTimeout(1500);
    expect((await st(home)).status).toBe('waiting');
    expect((await st(away)).status).toBe('waiting');
    expect((await pitch(away)).mode).toBe('walkout');
    const t = Date.now();
    await away.getByTestId('skip-walkout').click();
    await Promise.all([
      home.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 3000 }),
      away.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 3000 }),
    ]);
    expect(Date.now() - t).toBeLessThan(1500);
    for (const p of [home, away]) {
      await p.waitForTimeout(500);
      expect((await mix(p)).anthem).toEqual([]);
      expect((await pitch(p)).mode).not.toBe('walkout');
    }
  });

  test('Verlassen der Partie: alle Sounds gestoppt', async ({ page }) => {
    await open(page, fx('home-anthem-ai'));
    await waitWalkout(page);
    await anthemPlaying(page);
    await page.evaluate(() => (window as any).__fd.leave());
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => (window as any).__fd.mixer());
    expect(m.active).toBe(false);
    expect(m.sources).toBe(0);
    expect(m.anthem).toEqual([]);
  });
});

test.describe('Torjubel', () => {
  for (const [name, side] of [['goal-home-ai', 'home'], ['goal-away-ai', 'away']] as const) {
    test(`${side === 'home' ? 'Heimtor' : 'Auswärtstor'}: ≈ 4–5 s Jubel, endet mit dem Wiederanstoß`, async ({ page }) => {
      await open(page, fx(name));
      await waitWalkout(page);
      await page.getByTestId('skip-walkout').click();
      await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
      // auf das Tor warten
      await page.waitForFunction(() => (window as any).__fd.state().events.some((e: any) => e.type === 'goal'), null, { timeout: 40_000 });
      const tGoal = Date.now();
      // sofort: Jubelbild und Jubel-Pegel
      await page.waitForFunction(() => (window as any).__fd.pitch()?.mode === 'celebration', null, { timeout: 1500 });
      await page.waitForTimeout(800);
      const during = await snd(page);
      if (side === 'home') { expect(during.home).toBeGreaterThan(0.85); } else { expect(during.home).toBeLessThan(0.2); expect(during.away).toBeGreaterThan(0.5); }
      const m1 = await mix(page);
      expect(m1.roars).toBe(1);
      // Wiederanstoß nach ≈ 4–5 s
      await page.waitForFunction(() => (window as any).__fd.state().events.some((e: any, i: number, a: any[]) => e.type === 'kickoff' && e.side && a.findIndex((x: any) => x.type === 'goal') < i), null, { timeout: 8000 });
      const pause = (Date.now() - tGoal) / 1000;
      expect(pause).toBeGreaterThanOrEqual(3.6);
      expect(pause).toBeLessThanOrEqual(5.6);
      // Jubel vorbei: kein Jubelsound mehr, Jubelbild beendet, Kulisse folgt wieder dem Spiel
      await page.waitForTimeout(900);
      const after = await mix(page);
      expect(after.celebrating).toBe(0);
      expect(after.roars).toBe(1); // keine überlappenden Jubel
      expect((await pitch(page)).mode).toBe('play');
      const s2 = await snd(page);
      expect(s2.busy).toBe(false);
      await page.waitForTimeout(2500);
      expect((await snd(page)).home).toBeLessThan(0.86);
      // Spiel läuft ohne zusätzliche Verzögerung weiter
      // (nur messen, wenn in der Messzeit kein weiteres Tor fällt)
      const g0 = (await st(page)).events.filter((e: any) => e.type === 'goal').length;
      const p1 = await pitch(page); await page.waitForTimeout(2000); const p2 = await pitch(page);
      const g1 = (await st(page)).events.filter((e: any) => e.type === 'goal').length;
      if (g1 === g0 && p1.mode === 'play' && p2.mode === 'play') expect(p2.tick - p1.tick).toBeGreaterThanOrEqual(30); // 20 Ticks/s
    });
  }
});

test.describe('KI-Fankurve', () => {
  test('generische Reaktionen klingen wie eine Kurve (Rufen/Klatschen), nicht wie Musik', async ({ page }) => {
    await open(page, fx('home-noanthem-ai'));
    const r = await page.evaluate(async () => {
      const m = await import('/src/lib/synthChant.ts');
      const out: Array<{ name: string; h: number; db: number; claps: number; hasClaps: boolean }> = [];
      for (let i = 0; i < m.CHANT_PATTERNS.length; i++) {
        const b = (await m.renderChant(i, 22050))!;
        const d = b.getChannelData(0);
        let e = 0; for (const v of d) e += v * v;
        // Klatsch-/Ruf-Transienten: sprunghafte Energieanstiege in 20-ms-Fenstern
        const w = 441; let prev = 0, peaks = 0;
        for (let k = 0; k + w < d.length; k += w) { let s = 0; for (let j = 0; j < w; j++) s += d[k + j]! * d[k + j]!; if (s > prev * 4 && s > 0.02) peaks++; prev = s; }
        out.push({ name: m.CHANT_PATTERNS[i]!.name, h: m.harmonicity(d, 22050), db: 10 * Math.log10(e / d.length), claps: peaks, hasClaps: m.CHANT_PATTERNS[i]!.claps.length > 0 });
      }
      // Gegenprobe: ein gesungener Unisono-Chor (Musik) muss deutlich „tonaler“ sein
      const c = new OfflineAudioContext(1, 22050 * 2, 22050);
      for (let v = 0; v < 26; v++) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 196; o.detune.value = (Math.random() - 0.5) * 60; const g = c.createGain(); g.gain.value = 0.02; o.connect(g).connect(c.destination); o.start(); }
      const music = m.harmonicity((await c.startRendering()).getChannelData(0), 22050);
      return { out, music };
    });
    expect(r.music).toBeGreaterThan(0.8);
    for (const c of r.out) {
      expect(c.h, c.name).toBeLessThan(0.35); // kein Ton/keine Melodie
      expect(c.db, c.name).toBeGreaterThan(-36); // hörbar
      if (c.hasClaps) expect(c.claps, c.name).toBeGreaterThan(2); // synchrones Klatschen als Impulse
    }
  });
});
