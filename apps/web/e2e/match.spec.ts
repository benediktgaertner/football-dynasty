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

test.describe('KI-Fankurve (echte Stadionaufnahmen)', () => {
  /** Mixer-Zustand alle 250 ms mitschreiben */
  async function record(page: Page, ms: number) {
    const out: Array<{ m: any; s: any }> = [];
    const end = Date.now() + ms;
    while (Date.now() < end) { out.push({ m: await mix(page), s: await snd(page) }); await page.waitForTimeout(250); }
    return out;
  }
  const noRepeat = (h: Array<{ id: string; channel: string }>, ch: string, n: number) => {
    const ids = h.filter((x) => x.channel === ch).map((x) => x.id);
    for (let i = 1; i < ids.length; i++) if (n > 1) expect(ids[i], `${ch}: ${ids.join(',')}`).not.toBe(ids[i - 1]);
    return ids;
  };

  const start = async (page: Page, name: string, token?: string) => {
    await open(page, fx(name), token);
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
  };
  const EVENTS = ['clap', 'attack', 'chance', 'whistle', 'concede', 'goal'];

  test('KI ohne Uploads: keine Fangesänge, nur Stadionrauschen und situative Reaktionen', async ({ page }) => {
    await start(page, 'home-noanthem-ai');
    const rec = await record(page, 22_000);
    const last = rec[rec.length - 1]!.m;
    expect(last.missing).toEqual([]);
    expect(last.ambienceSample).toBe(true);
    const h = last.history as Array<{ id: string; channel: string; category: string }>;
    // keine Gesangsspur: weder Heim noch Gäste singen
    expect(h.filter((x) => x.channel === 'home' || x.channel === 'away')).toEqual([]);
    expect(rec.every((r) => r.m.tracks.home.length === 0 && r.m.tracks.away.length === 0)).toBe(true);
    // nur Rauschen + Reaktionen aus Aufnahmen
    for (const x of h) {
      if (x.channel === 'ambience') expect(x.category).toBe('ambience');
      else { expect(x.channel).toBe('events'); expect(EVENTS).toContain(x.category); }
      expect(x.id).toMatch(/_test_/);
    }
    noRepeat(h, 'ambience', 2);
    const avgH = rec.reduce((a, r) => a + r.s.home, 0) / rec.length, avgA = rec.reduce((a, r) => a + r.s.away, 0) / rec.length;
    expect(avgH).toBeGreaterThan(avgA * 1.5);
  });

  test('Heimspiel mit eigenen MP3: nur der Heimverein singt (Heimspur), KI-Gäste still', async ({ page }) => {
    await start(page, 'home-chants-ai');
    const rec = await record(page, 25_000);
    const h = rec[rec.length - 1]!.m.history as Array<{ id: string; channel: string; category: string }>;
    const home = h.filter((x) => x.channel === 'home');
    expect(home.length).toBeGreaterThan(0);
    for (const x of home) { expect(x.id).toBe('up-home-1'); expect(x.category).toBe('upload'); }
    expect(h.filter((x) => x.channel === 'away')).toEqual([]);
    // höchstens ein Gesang gleichzeitig, mit Pausen
    expect(Math.max(...rec.map((r) => r.m.tracks.home.length))).toBeLessThanOrEqual(1);
    expect(rec.some((r) => r.m.tracks.home.length === 0)).toBe(true);
  });

  test('ruhige Phasen leiser als Angriffe; Lautstärke folgt dem Spielgeschehen', async ({ page }) => {
    await open(page, fx('home-noanthem-ai'));
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
    const rec = await record(page, 25_000);
    // nur stabile Phasen ohne Ereignis (Tor/Chance): Anstieg ≈ 0,6 s, Abklingen ≈ 2,2 s ⇒ laut ab 1 s, ruhig ab 3 s
    const stable = (n: number) => rec.filter((r, i) => i >= n && !r.s.busy && rec.slice(i - n, i).every((x) => x.s.situation === r.s.situation && !x.s.busy));
    const QUIET = ['calm', 'harmless', 'away_possession', 'away_attack', 'away_box'];
    const all = rec.filter((r) => QUIET.includes(r.s.situation)).map((r) => r.m.crowd[0] as number);
    const quiet = stable(12).filter((r) => QUIET.includes(r.s.situation)).map((r) => r.m.crowd[0] as number);
    const loud = stable(4).filter((r) => r.s.situation === 'home_attack' || r.s.situation === 'home_box').map((r) => r.m.crowd[0] as number);
    expect(all.length).toBeGreaterThan(3);
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log('laut', loud.length ? avg(loud).toFixed(2) : '-', loud.length, 'ruhig', quiet.length ? avg(quiet).toFixed(2) : '-', quiet.length);
    if (loud.length > 3 && quiet.length > 3) expect(avg(loud) - avg(quiet)).toBeGreaterThan(0.12);
    if (loud.length) expect(Math.max(...loud)).toBeGreaterThan(0.6); // Angriff hörbar lauter
    // Pegel bewegt sich deutlich mit dem Spiel (keine Dauerkulisse)
    const h = rec.map((r) => r.m.crowd[0] as number);
    expect(Math.max(...h) - Math.min(...h)).toBeGreaterThan(0.2);
    // ruhige Phase: Heimintensität deutlich unter Torjubel-Niveau
    expect(Math.min(...all)).toBeLessThan(0.5);
  });

  test('Auswärtsspiel: eigene MP3 im Gästeblock, KI-Heimverein ohne Gesang', async ({ page }) => {
    await start(page, 'away-chants-ai', 'token-away-xxxx');
    const rec = await record(page, 40_000);
    const h = rec[rec.length - 1]!.m.history as Array<{ id: string; channel: string; category: string }>;
    const away = h.filter((x) => x.channel === 'away');
    expect(away.length).toBeGreaterThan(0);
    for (const x of away) { expect(x.id).toBe('up-away-1'); expect(x.category).toBe('upload'); }
    expect(h.filter((x) => x.channel === 'home')).toEqual([]); // KI-Heim: keine Gesänge
    const avgH = rec.reduce((a, r) => a + r.s.home, 0) / rec.length, avgA = rec.reduce((a, r) => a + r.s.away, 0) / rec.length;
    expect(avgH).toBeGreaterThan(avgA); // Heimfans dominieren auch beim Auswärtsspiel
    expect(avgA).toBeGreaterThan(0.08); // Gäste hörbar
  });

  for (const [name, side] of [['goal-home-ai', 'home'], ['goal-away-ai', 'away']] as const) {
    test(`${side === 'home' ? 'Heimtor' : 'Auswärtstor'}: Jubelaufnahme${side === 'away' ? ' im Gästeblock + Enttäuschung der Heimfans' : ''}, endet beim Anstoß`, async ({ page }) => {
      await open(page, fx(name));
      await waitWalkout(page);
      await page.getByTestId('skip-walkout').click();
      await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
      await page.waitForFunction(() => (window as any).__fd.state().events.some((e: any) => e.type === 'goal'), null, { timeout: 40_000 });
      await page.waitForFunction(() => (window as any).__fd.mixer().tracks.events.some((t: string) => t.startsWith('goal:')), null, { timeout: 1500 });
      const m = await mix(page);
      const goalClip = m.history.filter((x: any) => x.category === 'goal');
      expect(goalClip.length).toBe(1);
      if (side === 'away') expect(m.tracks.events.some((t: string) => t.startsWith('concede:'))).toBe(true);
      // während des Jubels keine Fangesänge
      expect(m.tracks.home).toEqual([]);
      await page.waitForFunction(() => (window as any).__fd.state().events.some((e: any, i: number, a: any[]) => e.type === 'kickoff' && e.side && a.findIndex((x: any) => x.type === 'goal') < i), null, { timeout: 8000 });
      await page.waitForTimeout(1000);
      const after = await mix(page);
      expect(after.tracks.events.filter((t: string) => t.startsWith('goal:') || t.startsWith('concede:'))).toEqual([]);
      expect(after.celebrating).toBe(0);
    });
  }

  test('ohne Aufnahmen: fehlende Kategorien gemeldet, keine Ersatzgesänge', async ({ page }) => {
    await page.goto(`/e2e/harness.html?fixture=${encodeURIComponent(fx('home-noanthem-ai'))}&token=token-home-xxxx&server=${encodeURIComponent(SERVER)}&crowd=${encodeURIComponent('/audio/crowd/manifest.json')}`);
    await page.waitForFunction(() => !!(window as any).__fd?.state().status);
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
    await page.waitForTimeout(8000);
    const m = await mix(page);
    expect(m.missing.length).toBe(7);
    expect(m.ambienceSample).toBe(false);
    expect(m.history).toEqual([]);
    expect(m.chants).toEqual([]);
  });
});
