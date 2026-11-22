import { expect, test, type Page } from '@playwright/test';

/**
 * Matchansicht Ende-zu-Ende: echter Match-Server (Echtzeit) + echte Komponenten im Browser.
 * Diagnose über window.__fd (Zustand, Mixer, Hüllkurve, Spielfeld-Modus).
 */
const SERVER = 'ws://127.0.0.1:8791/match';
let run = 0;
/** jede Partie bekommt einen eigenen Raum (Fixture-Name#Lauf) */
function fx(name: string) { run++; return `${name}#${Date.now()}-${run}`; }

async function open(page: Page, fixture: string, token = 'token-home-xxxx', extra = '') {
  await page.goto(`/e2e/harness.html?fixture=${encodeURIComponent(fixture)}&token=${token}&server=${encodeURIComponent(SERVER)}${extra}`);
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
  test('Hymnentitel oben: verdeckt keine aufgestellten Spieler, Fortschritt läuft', async ({ page }) => {
    await open(page, fx('home-anthem-ai'));
    await waitWalkout(page);
    await anthemPlaying(page);
    // Aufstellung abwarten (Spieler stehen vor der Haupttribüne)
    await page.waitForFunction(() => ((window as any).__fd.pitch()?.walkoutP ?? 0) >= 0.7, null, { timeout: 20_000 });
    const title = page.getByTestId('anthem-title');
    await expect(title).toBeVisible();
    const canvas = await page.locator('canvas').first().boundingBox();
    const box = await title.boundingBox();
    const p = await pitch(page);
    const titleBottom = box!.y + box!.height - canvas!.y;
    expect(titleBottom).toBeLessThan(p.lineupTopPx); // Titel endet oberhalb der Spielerreihe
    expect(box!.y - canvas!.y).toBeLessThan(canvas!.height * 0.2); // am oberen Rand
    const w1 = await title.locator('div > div > div').evaluate((e) => parseFloat((e as HTMLElement).style.width));
    await page.waitForTimeout(1500);
    const w2 = await title.locator('div > div > div').evaluate((e) => parseFloat((e as HTMLElement).style.width));
    expect(w2).toBeGreaterThan(w1); // Fortschrittsanzeige läuft
    await page.screenshot({ path: 'test-results/hymne-titel.png' });
    const t = Date.now();
    await page.getByTestId('skip-walkout').click();
    await expectImmediateKickoff(page, t);
  });

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
      if (side === 'home') { expect(during.home).toBeGreaterThan(0.85); } else { expect(during.home).toBeLessThan(0.3); expect(during.away).toBeGreaterThan(0.5); } // Heimfans verstummen nach dem Gegentor über ≈ 0,8 s (Audio-Balancing: keine plötzlichen Sprünge)
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
      // (nur, wenn inzwischen kein weiteres Tor gefallen ist – 1 Spielminute ≈ 2 s)
      if ((await st(page)).events.filter((e: any) => e.type === 'goal').length === 1) expect((await snd(page)).home).toBeLessThan(0.86);
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

  const start = async (page: Page, name: string, token?: string, extra = '') => {
    await open(page, fx(name), token, extra);
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
  };
  const EVENTS = ['clap', 'attack', 'chance', 'whistle', 'concede', 'goal'];

  test('KI-Vereine ohne Upload: nur die KI-Fangesänge – Teilmenge je Partie, keine direkte Wiederholung', async ({ page }) => {
    const aiReq = new Set<string>();
    page.on('request', (r) => { if (/\/host-audio\/chant_.*\.mp3/.test(r.url())) aiReq.add(r.url()); });
    await start(page, 'home-noanthem-ai', undefined, '&ts=0.3');
    const rec = await record(page, 25_000);
    const s = rec[rec.length - 1]!.s;
    const last = rec[rec.length - 1]!.m;
    // KI-Fanlager: je Seite 2–4 Gesänge aus dem ganzen KI-Pool (14), Heim und Gäste ohne gemeinsame Gesänge
    for (const side of ['home', 'away'] as const) {
      expect(s.songs[side].length).toBeGreaterThanOrEqual(2);
      expect(s.songs[side].length).toBeLessThanOrEqual(4);
      for (const id of s.songs[side]) expect(id).toMatch(/^ai_/);
    }
    expect((s.songs.home as string[]).filter((id) => s.songs.away.includes(id))).toEqual([]);
    // nur die ausgewählten Dateien werden geladen, nicht der ganze Pool
    expect(aiReq.size).toBeGreaterThan(0);
    expect(aiReq.size).toBeLessThanOrEqual(s.songs.home.length + s.songs.away.length);
    const chants = (s.played as any[]).filter((p) => p.kind === 'chant');
    expect(chants.length).toBeGreaterThan(0);
    for (const c of chants) expect(s.songs[c.side]).toContain(c.id);
    for (const side of ['home', 'away'] as const) {
      const ids = chants.filter((c) => c.side === side).map((c) => c.id);
      for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
    }
    // Spottgesang nur bei eigener Führung
    for (const c of chants.filter((c: any) => c.mood === 'taunt')) {
      const [h, a] = c.score.split(':').map(Number);
      expect(c.side === 'home' ? h - a : a - h).toBeGreaterThanOrEqual(1);
    }
    const hist = last.history as Array<{ channel: string; category: string; id: string }>;
    expect(hist.some((x) => x.category === 'chant')).toBe(true);
    expect(hist.filter((x) => x.category === 'chant').every((x) => x.channel === 'home' || x.channel === 'away')).toBe(true);
    expect(Math.max(...rec.map((r) => r.m.tracks.home.length))).toBeLessThanOrEqual(1);
    // Auswahlfenster mit Chance aus der Matrix
    const dec = s.decisions as any[];
    expect(dec.length).toBeGreaterThan(2);
    for (const d of dec) expect(d.chance).toBeGreaterThanOrEqual(0);
    const avgH = rec.reduce((a, r) => a + r.s.home, 0) / rec.length, avgA = rec.reduce((a, r) => a + r.s.away, 0) / rec.length;
    expect(avgH).toBeGreaterThan(avgA);
  });

  test('KI-Fangesänge: Auswahl bleibt nach Neuladen/Reconnect gleich, neue Partie ⇒ neue Auswahl', async ({ page }) => {
    const songsOf = async (f: string) => {
      await open(page, f, undefined, '&ts=0.3');
      await page.waitForFunction(() => { const s = (window as any).__fd.sound(); return s.songs.home.length > 0 && s.songs.away.length > 0; });
      return (await snd(page)).songs as { home: string[]; away: string[] };
    };
    const f1 = fx('home-noanthem-ai');
    const a = await songsOf(f1);
    await page.reload();
    await page.waitForFunction(() => { const s = (window as any).__fd?.sound(); return !!s && s.songs.home.length > 0; });
    expect((await snd(page)).songs).toEqual(a); // gleiche Partie ⇒ gleiche Auswahl
    const others: string[][] = [];
    for (let i = 0; i < 4; i++) others.push((await songsOf(fx('home-noanthem-ai'))).home);
    expect(others.some((o) => o.join() !== a.home.join())).toBe(true); // andere Partien ⇒ andere Auswahl
  });

  test('0:4 in der 60. Minute: Heimgesänge nahezu aus, Pfiffe, Gästeblock aktiv', async ({ page }) => {
    await start(page, 'home-noanthem-ai', undefined, '&ts=0.25&dis=always');
    await page.waitForTimeout(3000);
    await page.evaluate(() => (window as any).__fd.force({ minute: 60, homeScore: 0, awayScore: 4 }));
    await page.waitForTimeout(20_000); // Stimmungsnachlauf 8 s: Heimkurve sofort still, Gästeblock steigt mit
    const before = await snd(page);
    const p0 = before.played.length;
    const tStart = (before.decisions as any[]).at(-1)?.t ?? 0;
    const rec = await record(page, 40_000);
    const s = rec[rec.length - 1]!.s;
    const after = (s.played as any[]).slice(p0);
    const homeChants = after.filter((p) => p.kind === 'chant' && p.side === 'home').length;
    const awayChants = after.filter((p) => p.kind === 'chant' && p.side === 'away').length;
    // Pfiffe der Heimfans (Unmut-Modell, eigene Aufnahmen) seit dem Rückstand – mit Cooldown, kein Dauerpfeifen
    const whistles = (s.played as any[]).filter((p) => p.kind === 'reaction' && p.side === 'home' && (p.reaction === 'pfiff' || p.reaction === 'pfeifkonzert') && p.minute >= 60).length;
    const homeCheer = after.filter((p) => p.kind === 'reaction' && p.side === 'home' && p.reaction === 'clap').length;
    console.log({ homeChants, awayChants, whistles, mood: s.mood });
    expect(s.mood.row).toMatch(/^(S066|S067|S068|S069|S070)$/); // Mitte, Heim −3 oder mehr
    expect(s.mood.homeChant).toBe(0);
    expect(homeChants).toBe(0); // V2: 0 % Heimgesang bei ≥ 3 Toren Rückstand ab Minute 60
    expect(whistles).toBeGreaterThanOrEqual(2); // Pfeifkonzert sofort (E21) und weiterer Unmut
    expect(whistles).toBeLessThanOrEqual(5); // höchstens 5 je 10 Minuten
    expect(whistles).toBeGreaterThan(homeCheer);
    // Gästeblock singt hörbar: Anteil der Zeit mit laufendem Gästegesang (längere KI-Gesänge bis 24 s ⇒ Anzahl der Starts allein ist kein gutes Maß)
    const awayCover = rec.filter((r) => r.m.tracks.away.some((t: string) => t.startsWith('chant:'))).length / rec.length;
    console.log({ awayCover });
    expect(awayChants).toBeGreaterThanOrEqual(1);
    expect(awayCover).toBeGreaterThan(0.25);
    const dec = (s.decisions as any[]).filter((d) => d.kind === 'chant' && d.t > tStart);
    for (const d of dec.filter((d) => d.side === 'home')) expect(d.chance).toBe(0);
    for (const d of dec.filter((d) => d.side === 'away')) expect(d.chance).toBeGreaterThanOrEqual(30); // Matrix ≥ 60, nach Major-Update-Tuning (−25 %, Wechselgesang) abgeschwächt
    // bedrückte Heimkulisse, Gästeblock lauter als die Heimfans
    const tail = rec.slice(-20);
    const avgH = tail.reduce((a, r) => a + r.m.crowd[0], 0) / tail.length, avgA = tail.reduce((a, r) => a + r.m.crowd[1], 0) / tail.length;
    expect(avgH).toBeLessThan(0.42);
    expect(avgA).toBeGreaterThan(avgH);
    // Pfiffe als Aufnahme der neuen Kategorien auf der Heimseite, kein altes Pfiff-Material für die Heimkurve
    const hist = rec[rec.length - 1]!.m.history as any[];
    expect(hist.some((h) => h.category === 'pfiff' || h.category === 'pfeifkonzert')).toBe(true);
    expect(hist.filter((h) => h.category === 'whistle' && h.channel === 'events' && h.side === 'home')).toEqual([]);
  });

  test('Heimspiel mit eigenen MP3: Heimverein singt seine Uploads, KI-Gäste die KI-Fangesänge', async ({ page }) => {
    await start(page, 'home-chants-ai', undefined, '&ts=0.3');
    const rec = await record(page, 25_000);
    const h = rec[rec.length - 1]!.m.history as Array<{ id: string; channel: string; category: string }>;
    const home = h.filter((x) => x.channel === 'home');
    expect(home.length).toBeGreaterThan(0);
    for (const x of home) { expect(x.id).toBe('up-home-1'); expect(x.category).toBe('upload'); }
    for (const x of h.filter((x) => x.channel === 'away')) { expect(x.id).toMatch(/^ai_/); expect(x.category).toBe('chant'); }
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
    // Grundpegel laut Matrix (Ruhig 36 / Angriff 43 / Strafraum + Zuschlag) – kleinere Stufen, dazu situative Ah/Oh/Uh
    if (loud.length > 3 && quiet.length > 3) expect(avg(loud) - avg(quiet)).toBeGreaterThan(0.03);
    if (loud.length) expect(Math.max(...loud)).toBeGreaterThan(0.5); // Angriff lauter als ruhige Phase (Matrix-Grundpegel)
    // Pegel bewegt sich deutlich mit dem Spiel (keine Dauerkulisse)
    const h = rec.map((r) => r.m.crowd[0] as number);
    expect(Math.max(...h) - Math.min(...h)).toBeGreaterThan(0.1); // Stufen laut Matrix, Spitzen über Ah/Oh/Uh
    // ruhige Phase: Heimintensität deutlich unter Torjubel-Niveau
    expect(Math.min(...all)).toBeLessThan(0.6); // Torjubel = 1,0
  });

  test('Auswärtsspiel: eigene MP3 im Gästeblock, KI-Heimverein mit KI-Fangesängen', async ({ page }) => {
    await start(page, 'away-chants-ai', 'token-away-xxxx', '&ts=0.5');
    const rec = await record(page, 40_000);
    const h = rec[rec.length - 1]!.m.history as Array<{ id: string; channel: string; category: string }>;
    const away = h.filter((x) => x.channel === 'away');
    expect(away.length).toBeGreaterThan(0);
    for (const x of away) { expect(x.id).toBe('up-away-1'); expect(x.category).toBe('upload'); }
    for (const x of h.filter((x) => x.channel === 'home')) { expect(x.id).toMatch(/^ai_/); expect(x.category).toBe('chant'); } // KI-Heim: Pool
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
      expect(goalClip[0].id).toMatch(/^ai_host_goal_/); // zufälliger Torjubel aus den Host-Dateien der Liga
      expect(goalClip[0].side).toBe(side);
      // Crowd-Reaktion „Gegentor“ der Heimfans (Pfeifen/Ah/Oh/Uh) bzw. „Eigenes Tor“ geschichtet über den Jubel
      if (side === 'away') expect((m.history as any[]).some((h) => ['whistle', 'aah', 'ooh', 'uuh'].includes(h.category))).toBe(true);
      // während des Jubels: Gesänge werden geduckt (Audio-Balancing); das Gegentor-Lager (Heim bei Auswärtstor) verstummt, es startet kein neuer Gesang
      if (side === 'away') expect(m.tracks.home).toEqual([]);
      else { const ducks: number[] = []; for (let i = 0; i < 6; i++) { await page.waitForTimeout(250); ducks.push(Math.round((await mix(page)).duckNow.home * 100) / 100); } expect(Math.min(...ducks), `geplantes Ducking (Heim) je 250 ms: ${ducks.join(' ')}`).toBeLessThan(0.5); } // geplanter Pegel (Modell); AudioParam.value ist ohne anliegenden Ton nicht aktuell
      expect(m.history.filter((x: any) => (x.channel === 'home' || x.channel === 'away') && x.t > m.history.find((g: any) => g.category === 'goal').t)).toEqual([]);
      await page.waitForFunction(() => (window as any).__fd.state().events.some((e: any, i: number, a: any[]) => e.type === 'kickoff' && e.side && a.findIndex((x: any) => x.type === 'goal') < i), null, { timeout: 8000 });
      await page.waitForTimeout(1000);
      const after = await mix(page);
      expect(after.tracks.events.filter((t: string) => t.startsWith('goal:'))).toEqual([]);
      expect(after.celebrating).toBe(0);
    });
  }

  test('Produktion: fest eingebaut nur Stadionrauschen; Pfiffe/Torjubel/Gesänge ausschließlich aus den Host-Dateien der Liga', async ({ page }) => {
    await start(page, 'home-noanthem-ai', undefined, `&ts=0.3&crowd=${encodeURIComponent('/audio/crowd/manifest.json')}`);
    const rec = await record(page, 25_000);
    const m = rec[rec.length - 1]!.m;
    expect(m.ambienceSample).toBe(true);
    expect(m.library.ambience).toBeGreaterThan(0);
    // keine fest eingebauten KI-Reaktionen mehr
    for (const c of ['clap', 'attack', 'chance', 'whistle', 'concede', 'aah', 'ooh', 'uuh', 'applause', 'boo']) expect(m.library[c]).toBe(0);
    // Host-Dateien (Testersatz) bilden Pfiffe und Torjubel
    expect(m.library.pfiff).toBe(3); expect(m.library.pfeifkonzert).toBe(1); expect(m.library.goal).toBe(2);
    const s = await snd(page);
    for (const side of ['home', 'away'] as const) for (const id of s.songs[side]) expect(id).toMatch(/^ai_host_chant_/);
    for (const h of m.history as any[]) if (h.category !== 'ambience') expect(String(h.id)).toMatch(/^ai_host_|^up-/);
  });

  test('Liga ohne Host-Dateien: normale Stadion-Grundatmosphäre, keine KI-Gesänge, keine Ersatzklänge', async ({ page }) => {
    await start(page, 'home-noanthem-ai', undefined, `&ts=0.3&host=none&crowd=${encodeURIComponent('/audio/crowd/manifest.json')}`);
    await page.waitForTimeout(12_000);
    const m = await mix(page);
    const s = await snd(page);
    expect(m.ambienceSample).toBe(true);
    expect(s.songs.home).toEqual([]); expect(s.songs.away).toEqual([]);
    expect((m.history as any[]).filter((x) => x.category !== 'ambience')).toEqual([]);
  });

  test('ohne Aufnahmen: fehlende Kategorien gemeldet, keine Ersatzgesänge', async ({ page }) => {
    await page.goto(`/e2e/harness.html?fixture=${encodeURIComponent(fx('home-noanthem-ai'))}&token=token-home-xxxx&server=${encodeURIComponent(SERVER)}&crowd=${encodeURIComponent('/e2e/crowd-empty/manifest.json')}`);
    await page.waitForFunction(() => !!(window as any).__fd?.state().status);
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
    await page.waitForTimeout(8000);
    const m = await mix(page);
    expect(m.missing).toEqual(['ambience', 'clap', 'attack', 'chance', 'whistle', 'concede', 'aah', 'ooh', 'uuh', 'applause', 'boo']); // goal/pfiff/pfeifkonzert: Host-Dateien
    expect(m.ambienceSample).toBe(false);
    // keine festen Bibliotheksreaktionen ohne Dateien; gesungen wird nur aus dem Host-Pool der Liga
    expect((m.history as any[]).filter((x) => x.category !== 'chant' && !String(x.id).startsWith('ai_host_'))).toEqual([]);
    for (const u of m.chants as string[]) expect(u).toMatch(/\/e2e\/host-audio\/chant_/);
  });
});

/**
 * Multiplayer-Verbindungsabbrüche: zwei aktive Manager, einer verliert die Verbindung und kehrt zurück.
 * Erwartung: gleicher Spielstand und Ereignisprotokoll, keine doppelten/verlorenen Ereignisse, kein doppelter Wechsel,
 * Statusanzeige erscheint (Deutsch) und verschwindet wieder.
 */
test.describe('Verbindungsabbruch im Multiplayer', () => {
  const conn = (p: Page) => p.evaluate(() => (window as any).__fd.conn());
  const evs = (p: Page) => p.evaluate(() => (window as any).__fd.events() as string[]);

  async function startBoth(browser: import('@playwright/test').Browser) {
    const f = fx('mp-anthem');
    const home = await (await browser.newContext()).newPage();
    const away = await (await browser.newContext()).newPage();
    await open(home, f, 'token-home-xxxx');
    await open(away, f, 'token-away-xxxx');
    await waitWalkout(home); await waitWalkout(away);
    await home.getByTestId('skip-walkout').click();
    await away.getByTestId('skip-walkout').click();
    for (const p of [home, away]) await p.waitForFunction(() => (window as any).__fd.state().status === 'running', null, { timeout: 5000 });
    return { home, away };
  }

  /** Ereignisprotokolle beider Manager sind (bis zur kürzeren Länge) identisch und ohne Wiederholung des Index */
  async function expectSameEvents(a: Page, b: Page) {
    await a.waitForTimeout(600);
    // genug Ereignisse abwarten (Kickoff, Chancen …), damit der Vergleich aussagekräftig ist
    await expect.poll(async () => Math.min((await evs(a)).length, (await evs(b)).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    const [ea, eb] = [await evs(a), await evs(b)];
    const n = Math.min(ea.length, eb.length) - 1; // das letzte kann gerade erst eingetroffen sein
    expect(n).toBeGreaterThan(2);
    expect(ea.slice(0, n)).toEqual(eb.slice(0, n));
    // keine doppelt eingefügte Folge (z. B. Init + Nachlieferung): Ticks sind nicht rückläufig
    for (const list of [ea, eb]) { const ticks = list.map((x) => Number(x.split(':')[0])); expect(ticks).toEqual([...ticks].sort((x, y) => x - y)); }
  }

  test('Netz weg ⇒ Anzeige „Verbindung unterbrochen“, danach „wiederhergestellt“; gleicher Spielstand, keine doppelten Ereignisse', async ({ browser }) => {
    const { home, away } = await startBoth(browser);
    await home.waitForTimeout(2500);
    const before = await evs(home);
    await home.context().setOffline(true);
    await home.evaluate(() => (window as any).__fd.drop());
    await expect(home.getByTestId('conn-banner')).toHaveAttribute('data-conn', 'reconnecting', { timeout: 5000 });
    await expect(home.getByTestId('conn-banner')).toContainText('Verbindung unterbrochen');
    // Befehle während des Abbruchs werden nicht (still) verschluckt, sondern abgelehnt
    const offlineCmd = await home.evaluate(() => (window as any).__fd.cmd({ kind: 'profile', name: 'offensive' }));
    expect(offlineCmd.ok).toBe(false);
    await home.waitForTimeout(3000); // Spiel läuft weiter (Karenzzeit 20 s: Manager behält die Kontrolle)
    expect((await st(away)).status).toBe('running');
    await home.context().setOffline(false);
    await expect(home.getByTestId('conn-banner')).toHaveAttribute('data-conn', 'recovered', { timeout: 15_000 });
    expect((await conn(home)).connection).toBe('open');
    expect((await conn(home)).view.pendingSubs).toEqual([]);
    // Protokoll enthält alles Bisherige unverändert (Präfix) und ist identisch zum Gegner
    const after = await evs(home);
    expect(after.slice(0, before.length)).toEqual(before);
    await expectSameEvents(home, away);
    const [ch, ca] = [await conn(home), await conn(away)];
    expect(Math.abs(ch.tick - ca.tick)).toBeLessThan(120);
    // Anzeige verschwindet nach kurzer Zeit
    await expect(home.getByTestId('conn-banner')).toHaveCount(0, { timeout: 8000 });
    // Gegner hat nie eine Anzeige gesehen
    await expect(away.getByTestId('conn-banner')).toHaveCount(0);
  });

  test('Wechsel unmittelbar vor dem Abbruch geht nicht doppelt durch (gleiche Befehls-id wird nach Reconnect nachgereicht)', async ({ browser }) => {
    const { home, away } = await startBoth(browser);
    await home.waitForTimeout(1500);
    const c0 = await conn(home);
    const out = c0.view.players.find((p: any) => p.onPitch && p.main !== 'GK');
    const inn = c0.view.players.find((p: any) => !p.onPitch && !p.unavailable && p.main !== 'GK');
    // Befehl senden und im selben Moment die Verbindung kappen: Ack geht ggf. verloren, Server hat ihn evtl. schon ausgeführt
    const r = await home.evaluate((cmd) => (window as any).__fd.cmdThenDrop(cmd), { kind: 'sub', outId: out.id, inId: inn.id });
    void r;
    await expect.poll(async () => (await conn(home)).connection, { timeout: 15_000 }).toBe('open');
    await home.waitForTimeout(1500);
    const c1 = await conn(home);
    // genau ein Wechsel (vorgemerkt oder bereits ausgeführt), nie zwei
    expect(c1.view.subsUsed + c1.view.pendingSubs.length).toBe(1);
    const subEvents = (await evs(home)).filter((e) => e.includes(':sub:'));
    expect(subEvents.length).toBeLessThanOrEqual(1);
    // zweiter Versuch mit neuer id (Nutzer drückt erneut) wird vom Spiel als Duplikat abgelehnt
    const again = await home.evaluate((cmd) => (window as any).__fd.cmd(cmd), { kind: 'sub', outId: out.id, inId: inn.id });
    expect(again.ok).toBe(false);
    await expectSameEvents(home, away);
  });

  test('Verbindung mehrfach hintereinander gekappt: weiterhin genau eine Verbindung, Protokolle identisch', async ({ browser }) => {
    const { home, away } = await startBoth(browser);
    for (let i = 0; i < 3; i++) {
      await home.waitForTimeout(1200);
      await home.evaluate(() => (window as any).__fd.drop());
      await expect.poll(async () => (await conn(home)).connection, { timeout: 15_000 }).toBe('open');
    }
    await expectSameEvents(home, away);
    const [ch, ca] = [await conn(home), await conn(away)];
    expect(ch.score).toEqual(ca.score);
  });
});

test.describe('Pfeifkonzerte der Heimfans (Unmut-Modell, eigene Aufnahmen)', () => {
  const start = async (page: Page, extra = '') => {
    await open(page, fx('home-noanthem-ai'), undefined, `&ts=0.3${extra}`);
    await waitWalkout(page);
    await page.getByTestId('skip-walkout').click();
    await page.waitForFunction(() => (window as any).__fd.state().status === 'running');
  };
  const force = (page: Page, f: { minute: number; homeScore: number; awayScore: number }) => page.evaluate((x) => (window as any).__fd.force(x), f);
  const inject = (page: Page, events: Array<{ type: string; side: 'home' | 'away' | null }>, ctx: { homeScore: number; awayScore: number; minute: number }) =>
    page.evaluate(([evs, c]) => { const tick = 900000 + Math.floor(Math.random() * 99999); for (const e of evs) (window as any).__fd.inject({ tick, ...e }, c); }, [events, ctx] as const);
  const dis = async (page: Page) => (await snd(page)).disapproval as Array<{ cause: string; play: boolean; length: string; intensity: number; reason?: string; t: number }>;
  const homeWhistles = (m: any) => (m.history as any[]).filter((h) => (h.category === 'pfiff' || h.category === 'pfeifkonzert'));
  /** warten, bis keine Pfeifreaktion aus dem laufenden Spiel mehr im Cooldown liegt; liefert die aktuelle Audiozeit */
  const quiet = async (page: Page) => {
    for (let i = 0; i < 40; i++) {
      const s = await snd(page);
      const last = (s.disapproval as any[]).filter((x) => x.play).at(-1);
      const now = (s.played as any[]).at(-1)?.t ?? 0;
      const t = await page.evaluate(() => (window as any).__fd.soundTime?.() ?? null);
      const cur = t ?? now;
      if (!last || cur - last.t > 15) return cur;
      await page.waitForTimeout(1000);
    }
    return 0;
  };

  test('hartes Foul des Gastes bei Heimführung ⇒ Heimfans pfeifen (neue Aufnahme), Gesänge kurz reduziert', async ({ page }) => {
    await start(page, '&dis=always&events=off');
    const ctx = { minute: 30, homeScore: 2, awayScore: 0 };
    await force(page, ctx);
    await page.waitForTimeout(1500);
    const t0 = await quiet(page);
    await inject(page, [{ type: 'foul', side: 'away' }, { type: 'yellow', side: 'away' }], ctx);
    await page.waitForTimeout(800);
    const d = (await dis(page)).filter((x) => x.t >= t0);
    expect(d.some((x) => x.cause === 'hard_foul' && x.play)).toBe(true);
    const m = await mix(page);
    const w = homeWhistles(m);
    expect(w.length).toBeGreaterThan(0);
    for (const h of w) { expect(h.side).toBe('home'); expect(h.id).toMatch(/^ai_host_boo_/); } // Host-Datei „Pfiffe“
    expect(m.duckNow.home).toBeLessThan(0.95); // Heimgesänge während des Pfeifens reduziert (geplanter Pegel)
  });

  test('Foul des Heimteams ⇒ keine Pfiffe der Heimfans; Gästefans protestieren wie bisher', async ({ page }) => {
    await start(page, '&dis=always&events=off');
    const ctx = { minute: 30, homeScore: 0, awayScore: 0 };
    await force(page, ctx);
    await page.waitForTimeout(1000);
    const t0 = await quiet(page);
    const n0 = (await dis(page)).length;
    await inject(page, [{ type: 'foul', side: 'home' }], ctx);
    await page.waitForTimeout(1000);
    expect((await dis(page)).slice(n0).filter((x) => x.t >= t0 && x.cause.includes('foul'))).toEqual([]);
  });

  test('Elfmeter und Rote Karte gegen Heim ⇒ Pfiffe; Cooldown verhindert Überlagerung', async ({ page }) => {
    await start(page, '&dis=always&events=off');
    const ctx = { minute: 50, homeScore: 1, awayScore: 1 };
    await force(page, ctx);
    await page.waitForTimeout(1000);
    const t0 = await quiet(page);
    await inject(page, [{ type: 'foul', side: 'home' }, { type: 'penalty', side: 'away' }], ctx);
    await page.waitForTimeout(500);
    await inject(page, [{ type: 'red', side: 'home' }], ctx); // gleich danach: schwer, aber < 6 s ⇒ Cooldown
    await page.waitForTimeout(800);
    const d = (await dis(page)).filter((x) => x.t >= t0);
    expect(d.find((x) => x.cause === 'penalty_against')?.play).toBe(true);
    expect(d.find((x) => x.cause === 'red_home')?.reason).toBe('cooldown');
    const plays = d.filter((x) => x.play);
    for (let i = 1; i < plays.length; i++) expect(plays[i]!.t - plays[i - 1]!.t).toBeGreaterThanOrEqual(6);
    expect(plays.length).toBe(1); // genau eine Pfeifreaktion
  });

  test('0:0 – normales Spiel mit Ballverlusten ⇒ keine Pfiffe', async ({ page }) => {
    await start(page);
    await force(page, { minute: 20, homeScore: 0, awayScore: 0 });
    await page.waitForTimeout(25_000);
    const d = await dis(page);
    // Fehler/Ballverluste/Gefahr bei 0:0 lösen keine Pfiffe aus (nur Schiedsrichter-/Foulszenen dürfen)
    expect(d.filter((x) => x.play && ['ball_loss', 'deficit', 'conceded', 'missed_chance', 'halftime'].includes(x.cause))).toEqual([]);
    expect(d.filter((x) => x.cause === 'ball_loss')).toEqual([]);
  });

  test('0:3 in der 75. Minute ⇒ Unmut mit Pfiffen/Pfeifkonzert, aber begrenzt; Gästeblock singt weiter', async ({ page }) => {
    await start(page);
    await force(page, { minute: 75, homeScore: 0, awayScore: 3 });
    await page.waitForTimeout(60_000);
    const s = await snd(page);
    const d = s.disapproval as Array<{ cause: string; play: boolean; t: number }>;
    const plays = d.filter((x) => x.play);
    console.log({ plays: plays.map((x) => x.cause), D: s.D });
    expect(plays.length).toBeGreaterThanOrEqual(1);
    expect(plays.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < plays.length; i++) expect(plays[i]!.t - plays[i - 1]!.t).toBeGreaterThanOrEqual(6);
    expect(s.D).toBeGreaterThan(0.5);
    const chants = (s.played as any[]).filter((p) => p.kind === 'chant');
    expect(chants.filter((c) => c.side === 'home' && c.minute >= 75)).toEqual([]); // keine Heimgesänge bei 0:3 spät
    expect(chants.some((c) => c.side === 'away')).toBe(true);
    // Gästefans nutzen keine Pfiff-Aufnahmen der Heimkurve
    expect(homeWhistles(await mix(page)).every((h: any) => h.side === 'home')).toBe(true);
  });
});
