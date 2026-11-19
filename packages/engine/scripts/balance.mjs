// Balancing-Analyse der Match Engine (echte Engine, parallel auf allen Kernen).
//   node packages/engine/scripts/balance.mjs quick            – Siegquoten bei 0/3/5/10 OVR Unterschied
//   node packages/engine/scripts/balance.mjs full [K] [S]     – zusätzlich Ligapools (K Spiele je Paarung),
//                                                             1.000 Saisons daraus, S komplett simulierte Saisons,
//                                                             Heimvorteil, Fitness, Taktik
// Vorher: npm run build -w @fd/engine
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENGINE = new URL('../dist/index.js', import.meta.url).href;

// ---------------------------------------------------------------------------
// Worker: spielt Partien
// ---------------------------------------------------------------------------
if (!isMainThread) {
  const { MatchEngine, buildTestTeam } = await import(ENGINE);
  const cache = new Map();
  const team = (key, ovr, opts) => {
    const k = `${key}|${ovr}|${opts?.formation ?? ''}`;
    if (!cache.has(k)) cache.set(k, buildTestTeam(key, ovr, { formation: opts?.formation }));
    return cache.get(k);
  };
  parentPort.on('message', (jobs) => {
    const out = [];
    for (const j of jobs) {
      let home = team(j.hk, j.ho, j.hopt);
      let away = team(j.ak, j.ao, j.aopt);
      if (j.hopt?.fitness) home = { ...home, squad: home.squad.map((p) => ({ ...p, fitness: j.hopt.fitness })) };
      if (j.aopt?.fitness) away = { ...away, squad: away.squad.map((p) => ({ ...p, fitness: j.aopt.fitness })) };
      if (j.hopt?.profile) home = { ...home, settings: { ...home.settings, active_profile: j.hopt.profile } };
      if (j.aopt?.profile) away = { ...away, settings: { ...away.settings, active_profile: j.aopt.profile } };
      const e = new MatchEngine({ seed: j.seed, home, away, homeAdvantage: j.ha ?? 0 });
      if (j.noAuto) { e.setAutopilot('home', false); e.setAutopilot('away', false); }
      while (!e.isFinished) e.step();
      const r = e.result();
      out.push({ id: j.id, hg: r.score[0], ag: r.score[1] });
    }
    parentPort.postMessage(out);
  });
} else {
  // -------------------------------------------------------------------------
  // Hauptprozess
  // -------------------------------------------------------------------------
  const mode = process.argv[2] ?? 'quick';
  const K = Number(process.argv[3] ?? 10);
  const FULL_SEASONS = Number(process.argv[4] ?? 4);
  const N = Number(process.env.N ?? 160);
  const threads = Math.max(1, availableParallelism());
  const workers = Array.from({ length: threads }, () => new Worker(fileURLToPath(import.meta.url)));
  const t0 = Date.now();

  async function play(jobs) {
    jobs.forEach((j, i) => { j.id = i; });
    const results = new Array(jobs.length);
    const chunks = [];
    const size = Math.max(4, Math.ceil(jobs.length / (threads * 8)));
    for (let i = 0; i < jobs.length; i += size) chunks.push(jobs.slice(i, i + size));
    let next = 0;
    await Promise.all(workers.map((w) => new Promise((resolve) => {
      const feed = () => { if (next >= chunks.length) return resolve(); w.once('message', (res) => { for (const r of res) results[r.id] = r; feed(); }); w.postMessage(chunks[next++]); };
      feed();
    })));
    return results;
  }

  const pct = (a, b) => `${b ? ((a / b) * 100).toFixed(1) : '0.0'} %`;
  const lines = [];
  const log = (s = '') => { console.log(s); lines.push(s); };

  // Siegquoten bei Stärkeunterschied d (Heim/Auswärts gespiegelt, Heimvorteil wie im Spiel)
  async function diffTable(base = 72) {
    log(`Siegquoten des stärkeren Teams (Basis ${base}, N=${N} je Unterschied, Heim/Auswärts gespiegelt, normaler Heimvorteil)`);
    log('Unterschied | Sieg | Remis | Niederlage | Tore stark:schwach');
    const out = {};
    for (const d of [0, 3, 5, 10]) {
      const jobs = [];
      for (let i = 0; i < N; i++) {
        const strongHome = i % 2 === 0;
        jobs.push({ hk: `s${i % 24}`, ho: strongHome ? base + d : base, ak: `w${i % 24}`, ao: strongHome ? base : base + d, seed: `d${d}-${i}`, strongHome, ha: 0 });
      }
      const r = await play(jobs);
      let w = 0, dr = 0, l = 0, gs = 0, gw = 0;
      r.forEach((x, i) => {
        const sh = jobs[i].strongHome;
        const s = sh ? x.hg : x.ag, o = sh ? x.ag : x.hg;
        gs += s; gw += o;
        if (s > o) w++; else if (s === o) dr++; else l++;
      });
      out[d] = { w: w / N, d: dr / N, l: l / N };
      log(`${String(d).padStart(5)} OVR   | ${pct(w, N).padStart(6)} | ${pct(dr, N).padStart(6)} | ${pct(l, N).padStart(8)} | ${(gs / N).toFixed(2)}:${(gw / N).toFixed(2)}`);
    }
    return out;
  }

  // Liga: realistische Stärkeverteilung einer Bundesliga (18 Teams, 85,5 … 77)
  const LEAGUE = [85.5, 83.5, 81, 80.5, 80, 79.8, 79.5, 79.2, 79, 78.8, 78.5, 78.2, 78, 77.8, 77.6, 77.4, 77.2, 77];
  const ovr = (x) => Math.round(x);

  function table(results, n) {
    const pts = new Array(n).fill(0), gd = new Array(n).fill(0);
    for (const r of results) {
      gd[r.h] += r.hg - r.ag; gd[r.a] += r.ag - r.hg;
      if (r.hg > r.ag) pts[r.h] += 3; else if (r.hg < r.ag) pts[r.a] += 3; else { pts[r.h]++; pts[r.a]++; }
    }
    const order = [...Array(n).keys()].sort((a, b) => pts[b] - pts[a] || gd[b] - gd[a] || Math.random() - 0.5);
    const rank = new Array(n); order.forEach((t, i) => { rank[t] = i + 1; });
    return { pts, rank };
  }
  function spearman(rank) { // Stärke-Rang = Index+1 (LEAGUE absteigend)
    const n = rank.length; let s = 0;
    for (let i = 0; i < n; i++) s += (rank[i] - (i + 1)) ** 2;
    return 1 - (6 * s) / (n * (n * n - 1));
  }

  // Effektive Stärke der eingesetzten Elf (Ø OVR der Startelf aus dem Taktikprofil)
  const { buildTestTeam } = await import(ENGINE);
  const XI = LEAGUE.map((o, i) => {
    const t = buildTestTeam(`L${i}`, ovr(o));
    const ids = new Set(t.profiles.neutral.slots.map((x) => x.playerId));
    const xi = t.squad.filter((p) => ids.has(p.id));
    return xi.reduce((a, p) => a + p.overall, 0) / xi.length;
  });
  function spearmanBy(rank, strength) {
    const n = rank.length;
    const order = [...Array(n).keys()].sort((a, b) => strength[b] - strength[a]);
    const sr = new Array(n); order.forEach((t, i) => { sr[t] = i + 1; });
    let s = 0; for (let i = 0; i < n; i++) s += (rank[i] - sr[i]) ** 2;
    return 1 - (6 * s) / (n * (n * n - 1));
  }

  async function seasons() {
    const n = LEAGUE.length;
    log('');
    log(`Liga mit ${n} Teams, Stärken: ${LEAGUE.join(', ')}`);
    // a) Pools: jede Heim/Auswärts-Paarung K-mal mit der echten Engine
    const jobs = [];
    for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) if (h !== a) for (let k = 0; k < K; k++)
      jobs.push({ hk: `L${h}`, ho: ovr(LEAGUE[h]), ak: `L${a}`, ao: ovr(LEAGUE[a]), seed: `pool-${h}-${a}-${k}`, h, a, ha: 0 });
    const res = await play(jobs);
    const pool = new Map();
    res.forEach((r, i) => { const j = jobs[i]; const key = `${j.h}-${j.a}`; if (!pool.has(key)) pool.set(key, []); pool.get(key).push(r); });
    let hw = 0, dw = 0, aw = 0, surprises = 0, bigDiffGames = 0;
    for (const [key, list] of pool) {
      const [h, a] = key.split('-').map(Number);
      for (const r of list) {
        if (r.hg > r.ag) hw++; else if (r.hg === r.ag) dw++; else aw++;
        if (Math.abs(LEAGUE[h] - LEAGUE[a]) >= 5) { bigDiffGames++; const weakerWon = LEAGUE[h] < LEAGUE[a] ? r.hg > r.ag : r.ag > r.hg; if (weakerWon) surprises++; }
      }
    }
    log(`Engine-Spiele für die Pools: ${res.length} (${K} je Heim/Auswärts-Paarung)`);
    log(`Heimsieg ${pct(hw, res.length)} · Remis ${pct(dw, res.length)} · Auswärtssieg ${pct(aw, res.length)}`);
    log(`Überraschungssiege (schwächeres Team gewinnt bei ≥ 5 OVR Unterschied): ${pct(surprises, bigDiffGames)} von ${bigDiffGames} Spielen`);

    // b) 1.000 Saisons aus den Engine-Ergebnissen (je Spiel ein zufälliges Engine-Ergebnis der Paarung)
    const S = 1000;
    const sumPts = new Array(n).fill(0), sumRank = new Array(n).fill(0), champ = new Array(n).fill(0);
    let rho = 0, rhoXi = 0, bottom3Champ = 0, bottom6Champ = 0, top3Relegated = 0;
    for (let s = 0; s < S; s++) {
      const rs = [];
      for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) if (h !== a) {
        const list = pool.get(`${h}-${a}`); const r = list[Math.floor(Math.random() * list.length)];
        rs.push({ h, a, hg: r.hg, ag: r.ag });
      }
      const t = table(rs, n);
      rho += spearman(t.rank);
      rhoXi += spearmanBy(t.rank, XI);
      for (let i = 0; i < n; i++) { sumPts[i] += t.pts[i]; sumRank[i] += t.rank[i]; if (t.rank[i] === 1) champ[i]++; }
      const c = t.rank.indexOf(1);
      if (c >= n - 3) bottom3Champ++;
      if (c >= n - 6) bottom6Champ++;
      for (let i = 0; i < 3; i++) if (t.rank[i] > n - 2) top3Relegated++;
    }
    log('');
    log(`1.000 Saisons (aus Engine-Ergebnissen zusammengesetzt):`);
    log(`Rangkorrelation Stärke ↔ Tabellenplatz (Spearman, Ø): Kader-Zielstärke ${(rho / S).toFixed(3)} · effektive Startelf ${(rhoXi / S).toFixed(3)}`);
    log('Stärke | Startelf Ø | Ø Punkte | Ø Platz | Meister');
    for (let i = 0; i < n; i++) log(`${LEAGUE[i].toFixed(1).padStart(6)} | ${XI[i].toFixed(1).padStart(10)} | ${(sumPts[i] / S).toFixed(1).padStart(8)} | ${(sumRank[i] / S).toFixed(1).padStart(7)} | ${pct(champ[i], S)}`);
    const grp = (a, b) => (sumPts.slice(a, b).reduce((x, y) => x + y, 0) / S / (b - a)).toFixed(1);
    log(`Ø Punkte: Top-6 ${grp(0, 6)} · Mitte ${grp(6, 12)} · Unten-6 ${grp(12, 18)}`);
    log(`Meister aus den 3 schwächsten Teams: ${pct(bottom3Champ, S)} · aus den 6 schwächsten: ${pct(bottom6Champ, S)} · Top-3-Team steigt ab: ${pct(top3Relegated, S * 3)} je Team`);

    // c) Komplett mit der Engine durchgespielte Saisons (Kontrolle)
    if (FULL_SEASONS > 0) {
      const fj = [];
      for (let s = 0; s < FULL_SEASONS; s++) for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) if (h !== a)
        fj.push({ hk: `L${h}`, ho: ovr(LEAGUE[h]), ak: `L${a}`, ao: ovr(LEAGUE[a]), seed: `season-${s}-${h}-${a}`, h, a, s, ha: 0 });
      const fr = await play(fj);
      let frho = 0; const fpts = new Array(n).fill(0); const champs = [];
      for (let s = 0; s < FULL_SEASONS; s++) {
        const rs = fr.map((r, i) => ({ ...fj[i], hg: r.hg, ag: r.ag })).filter((x) => x.s === s);
        const t = table(rs, n);
        frho += spearman(t.rank);
        for (let i = 0; i < n; i++) fpts[i] += t.pts[i];
        champs.push(LEAGUE[t.rank.indexOf(1)]);
      }
      log('');
      log(`${FULL_SEASONS} komplett mit der Engine gespielte Saisons (${fr.length} Spiele): Spearman Ø ${(frho / FULL_SEASONS).toFixed(3)} · Meister-Stärken ${champs.join(', ')}`);
      log(`Ø Punkte stärkstes/schwächstes Team: ${(fpts[0] / FULL_SEASONS).toFixed(1)} / ${(fpts[n - 1] / FULL_SEASONS).toFixed(1)}`);
    }
  }

  // Einflüsse: Heimvorteil, Fitness, Taktik (gleich starke Teams bzw. −5 OVR)
  async function factors() {
    log('');
    log(`Einflussfaktoren (N=${N} je Test, gleich stark = 75):`);
    const run = async (label, mk) => {
      const jobs = Array.from({ length: N }, (_, i) => mk(i));
      const r = await play(jobs);
      let w = 0, d = 0;
      r.forEach((x, i) => { const aHome = jobs[i].aIsHome; const a = aHome ? x.hg : x.ag, b = aHome ? x.ag : x.hg; if (a > b) w++; else if (a === b) d++; });
      log(`${label.padEnd(58)} Sieg ${pct(w, N)} · Remis ${pct(d, N)} · Niederlage ${pct(N - w - d, N)}`);
    };
    await run('Heimteam (75) gegen Gast (75), normaler Heimvorteil', (i) => ({ hk: `a${i % 24}`, ho: 75, ak: `b${i % 24}`, ao: 75, seed: `ha${i}`, ha: 0, aIsHome: true }));
    await run('Heimteam (75) gegen Gast (75), volles 50.000er-Stadion', (i) => ({ hk: `a${i % 24}`, ho: 75, ak: `b${i % 24}`, ao: 75, seed: `haf${i}`, ha: 0.015, aIsHome: true }));
    await run('Heimteam (72) gegen stärkeren Gast (75), normaler Heimvorteil', (i) => ({ hk: `a${i % 24}`, ho: 72, ak: `b${i % 24}`, ao: 75, seed: `hab${i}`, ha: 0, aIsHome: true }));
    await run('Team mit 100 % Fitness gegen 70 % Fitness (gleich stark)', (i) => ({ hk: `a${i % 24}`, ho: 75, ak: `b${i % 24}`, ao: 75, aopt: { fitness: 70 }, seed: `fit${i}`, ha: -0.02, aIsHome: true }));
    await run('Offensives Profil gegen neutrales Profil (gleich stark)', (i) => ({ hk: `a${i % 24}`, ho: 75, hopt: { profile: 'offensive' }, ak: `b${i % 24}`, ao: 75, seed: `tac${i}`, ha: -0.02, noAuto: true, aIsHome: true }));
    await run('Schwächeres Team (70) offensiv gegen 75 neutral', (i) => ({ hk: `a${i % 24}`, ho: 70, hopt: { profile: 'offensive' }, ak: `b${i % 24}`, ao: 75, seed: `tac5o${i}`, ha: -0.02, noAuto: true, aIsHome: true }));
    await run('Schwächeres Team (70) defensiv gegen 75 neutral', (i) => ({ hk: `a${i % 24}`, ho: 70, hopt: { profile: 'defensive' }, ak: `b${i % 24}`, ao: 75, seed: `tac5d${i}`, ha: -0.02, noAuto: true, aIsHome: true }));
  }

  await diffTable();
  if (mode === 'full') { await seasons(); await factors(); }
  log('');
  log(`Laufzeit ${((Date.now() - t0) / 1000).toFixed(0)} s auf ${threads} Kernen`);
  if (process.env.OUT) (await import('node:fs')).writeFileSync(process.env.OUT, lines.join('\n') + '\n');
  for (const w of workers) await w.terminate();
}
