import { simulate } from './engine.js';
import { buildTestTeam } from './fixtures.js';

/** Kalibrierung: npm run calibrate -w @fd/engine [-- N] */
const n = Number(process.argv[2] ?? 200);
let goals = 0, draws = 0, homeWins = 0, awayWins = 0, shots = 0, xg = 0, onT = 0, fouls = 0, yellow = 0, red = 0, corners = 0, off = 0, passes = 0, pc = 0;
let strongWins = 0, strongDraw = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  const r = simulate({ seed: `cal${i}`, home: buildTestTeam(`h${i % 20}`, 70), away: buildTestTeam(`a${i % 20}`, 70), homeAdvantage: 0.01 });
  const [h, a] = r.score;
  goals += h + a; if (h === a) draws++; if (h > a) homeWins++; if (a > h) awayWins++;
  for (const s of [r.stats.home, r.stats.away]) { shots += s.shots; xg += s.xg; onT += s.shotsOnTarget; fouls += s.fouls; yellow += s.yellow; red += s.red; corners += s.corners; off += s.offsides; passes += s.passes; pc += s.passesCompleted; }
  const s2 = simulate({ seed: `str${i}`, home: buildTestTeam(`s${i % 20}`, 78), away: buildTestTeam(`w${i % 20}`, 66), homeAdvantage: 0 });
  if (s2.score[0] > s2.score[1]) strongWins++; else if (s2.score[0] === s2.score[1]) strongDraw++;
}
const f = (x: number) => (x / n).toFixed(2);
console.log(`Spiele ${n} in ${Date.now() - t0} ms`);
console.log(`Tore/Spiel ${f(goals)} | Remis ${((draws / n) * 100).toFixed(0)}% | Heimsiege ${((homeWins / n) * 100).toFixed(0)}% | Auswärtssiege ${((awayWins / n) * 100).toFixed(0)}%`);
console.log(`Schüsse/Team ${(shots / n / 2).toFixed(1)} | aufs Tor ${(onT / n / 2).toFixed(1)} | xG/Team ${(xg / n / 2).toFixed(2)}`);
console.log(`Pässe/Team ${(passes / n / 2).toFixed(0)} (${((pc / passes) * 100).toFixed(0)}%) | Fouls ${f(fouls)} | Gelb ${f(yellow)} | Rot ${f(red)} | Ecken ${f(corners)} | Abseits ${f(off)}`);
console.log(`Stark (78) vs schwach (66): Siege ${((strongWins / n) * 100).toFixed(0)}% Remis ${((strongDraw / n) * 100).toFixed(0)}%`);
