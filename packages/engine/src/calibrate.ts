import { MatchEngine, type AiDiagnostics } from './engine.js';
import { buildTestTeam } from './fixtures.js';
import type { MatchResult, MatchSetup, TeamInput } from './types.js';

/** Kalibrierung: npm run calibrate -w @fd/engine [-- N] */
const n = Number(process.argv[2] ?? 60);

function run(setup: MatchSetup): { r: MatchResult; d: { home: AiDiagnostics; away: AiDiagnostics } } {
  const e = new MatchEngine(setup);
  while (!e.isFinished) e.step();
  return { r: e.result(), d: e.diagnostics };
}

/** Ein Attribut im ganzen Kader verschieben (für Attribut-Wirkungstests) */
function shift(t: TeamInput, keys: string[], delta: number): TeamInput {
  return { ...t, squad: t.squad.map((p) => ({ ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, keys.includes(k) ? Math.max(1, Math.min(99, v + delta)) : v])) })) };
}

let goals = 0, draws = 0, homeWins = 0, awayWins = 0, shots = 0, xg = 0, onT = 0, fouls = 0, yellow = 0, red = 0, corners = 0, off = 0, passes = 0, pc = 0;
let strongWins = 0, strongDraw = 0;
const D = { decisions: 0, shotZone: 0, shotZoneShots: 0, shotZoneBackPasses: 0, throughBalls: 0, throughBallsCompleted: 0, takeOns: 0, takeOnsWon: 0, crosses: 0, shields: 0, blocks: 0 } as AiDiagnostics;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const { r, d } = run({ seed: `cal${i}`, home: buildTestTeam(`h${i % 20}`, 70), away: buildTestTeam(`a${i % 20}`, 70), homeAdvantage: 0.01 });
  const [h, a] = r.score;
  goals += h + a; if (h === a) draws++; if (h > a) homeWins++; if (a > h) awayWins++;
  for (const s of [r.stats.home, r.stats.away]) { shots += s.shots; xg += s.xg; onT += s.shotsOnTarget; fouls += s.fouls; yellow += s.yellow; red += s.red; corners += s.corners; off += s.offsides; passes += s.passes; pc += s.passesCompleted; }
  for (const side of [d.home, d.away]) for (const k of Object.keys(D) as Array<keyof AiDiagnostics>) D[k] += side[k];
  const s2 = run({ seed: `str${i}`, home: buildTestTeam(`s${i % 20}`, 78), away: buildTestTeam(`w${i % 20}`, 66), homeAdvantage: 0 }).r;
  if (s2.score[0] > s2.score[1]) strongWins++; else if (s2.score[0] === s2.score[1]) strongDraw++;
}
const f = (x: number) => (x / n).toFixed(2);
const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(0) : 0}%`;
console.log(`Spiele ${n} in ${Date.now() - t0} ms`);
console.log(`Tore/Spiel ${f(goals)} | Remis ${pct(draws, n)} | Heimsiege ${pct(homeWins, n)} | Auswärtssiege ${pct(awayWins, n)}`);
console.log(`Schüsse/Team ${(shots / n / 2).toFixed(1)} | aufs Tor ${(onT / n / 2).toFixed(1)} | xG/Team ${(xg / n / 2).toFixed(2)} | xG/Schuss ${(xg / Math.max(1, shots)).toFixed(3)}`);
console.log(`Pässe/Team ${(passes / n / 2).toFixed(0)} (${pct(pc, passes)}) | Fouls ${f(fouls)} | Gelb ${f(yellow)} | Rot ${f(red)} | Ecken ${f(corners)} | Abseits ${f(off)}`);
console.log(`Stark (78) vs schwach (66): Siege ${pct(strongWins, n)} Remis ${pct(strongDraw, n)}`);
console.log(`KI: Abschlusspositionen ${D.shotZone} → Schuss ${pct(D.shotZoneShots, D.shotZone)}, Rückpass ${pct(D.shotZoneBackPasses, D.shotZone)} | Steilpässe ${(D.throughBalls / n / 2).toFixed(1)}/Team (${pct(D.throughBallsCompleted, D.throughBalls)}) | Dribblings ${(D.takeOns / n / 2).toFixed(1)} (${pct(D.takeOnsWon, D.takeOns)}) | Flanken ${(D.crosses / n / 2).toFixed(1)} | Abschirmen ${(D.shields / n / 2).toFixed(1)} | Blocks ${(D.blocks / n / 2).toFixed(1)}`);

// Attributwirkung: gleiche Teams, ein Attribut +15 für Heim
const m = Math.max(10, Math.round(n / 3));
for (const keys of [['shooting'], ['passing'], ['gameIntelligence'], ['dribbling'], ['defending'], ['pace']]) {
  let gd = 0, w = 0, thr = 0, thrC = 0, to = 0, toW = 0;
  for (let i = 0; i < m; i++) {
    const base = buildTestTeam(`x${i % 20}`, 70);
    const home = shift(base, keys, 15);
    const { r, d } = run({ seed: `attr${keys[0]}${i}`, home, away: buildTestTeam(`x${i % 20}`, 70), homeAdvantage: -0.06 });
    gd += r.score[0] - r.score[1]; if (r.score[0] > r.score[1]) w++;
    thr += d.home.throughBalls; thrC += d.home.throughBallsCompleted; to += d.home.takeOns; toW += d.home.takeOnsWon;
  }
  console.log(`+15 ${keys.join('+').padEnd(16)} Tordiff/Spiel ${(gd / m).toFixed(2)} | Siege ${pct(w, m)} | Steilpass ${pct(thrC, thr)} | Dribbling ${pct(toW, to)}`);
}

