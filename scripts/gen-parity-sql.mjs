// Erzeugt SQL-Prüfungen, die TypeScript- und SQL-Implementierung derselben Regeln vergleichen.
import { POSITIONS as ALL_POS, generateOutfieldAttributes, generateGoalkeeperAttributes, outfieldOverall, goalkeeperOverall, createRng, marketValue, devMultiplier, devAttributeCost, devAgeFactor, matchXp, normalizeName, stadiumBuildCost, STARTING_CAPITAL, snakeDraftManagerIndex, totalDraftPicks, PLAYER_INSTRUCTIONS, roleGroup, CONFLICTING_INSTRUCTIONS, trainingDevelopmentPoints, POSITIONS, validatePlayerInstructions } from '../packages/shared/dist/index.js';
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const names = ['FC Köln-Süd 1908', 'Straße United', 'Atlético Málaga', 'ŁKS Łódź', 'Øster IF', 'Æro BK', 'Beşiktaş Gençlik', 'Dinamo Đakovo', 'Œuvre FC', "Sporting d'Évora", 'SV Grünwald 1911', '  1. FC  Über-Ägypten  ', 'İzmirspor', 'Žalgiris Šiauliai', 'Cœur de Lion'];
const lines = ['\\set ON_ERROR_STOP on'];
for (const n of names) {
  lines.push(`select tests.assert(public.normalize_name(${q(n)}) = ${q(normalizeName(n))}, ${q('Normalisierung TS=SQL: ' + n + ' → ' + normalizeName(n))});`);
}
for (let c = 10000; c <= 50000; c += 5000) {
  lines.push(`select tests.assert(public.stadium_build_cost(${c}) = ${stadiumBuildCost(c)}, ${q('Stadionkosten TS=SQL bei ' + c)});`);
}
for (const [d, v] of Object.entries(STARTING_CAPITAL)) {
  lines.push(`select tests.assert(public.starting_capital(${q(d)}) = ${v}, ${q('Startkapital TS=SQL ' + d)});`);
}
for (const n of [1, 2, 3, 5, 18]) {
  const ts = Array.from({ length: totalDraftPicks(n) }, (_, i) => snakeDraftManagerIndex(n, i)).join(',');
  lines.push(`select tests.assert((select string_agg(public.fd_snake_index(${n}, i)::text, ',' order by i) from generate_series(0, ${totalDraftPicks(n) - 1}) i) = ${q(ts)}, ${q('Snake-Reihenfolge TS=SQL für ' + n + ' Manager')});`);
}
for (const pos of POSITIONS) {
  const codes = PLAYER_INSTRUCTIONS[roleGroup(pos)].map((i) => i.code).sort();
  lines.push(`select tests.assert((select array_agg(c order by c) from unnest(public.fd_allowed_instructions(${q(pos)})) c)::text = ${q('{' + codes.join(',') + '}')}, ${q('Anweisungen TS=SQL für ' + pos)});`);
}
for (const [a, b] of CONFLICTING_INSTRUCTIONS) {
  const pos = POSITIONS.find((p) => PLAYER_INSTRUCTIONS[roleGroup(p)].some((i) => i.code === a));
  lines.push(`select tests.assert(public.fd_valid_player_instructions(${q(pos)}, array[${q(a)}, ${q(b)}]) = ${validatePlayerInstructions(pos, [a, b]) === null}, ${q('Konflikt TS=SQL ' + a + '/' + b)});`);
}
for (const [age, ovr, pot] of [[18, 70, 85], [22, 75, 75], [25, 78, 80], [29, 80, 80], [32, 76, 79], [35, 74, 74]]) {
  lines.push(`select tests.assert(public.fd_training_points(${age}, ${ovr}, ${pot}) = ${trainingDevelopmentPoints(age, ovr, pot)}, ${q('Trainingspunkte TS=SQL ' + age + '/' + ovr + '/' + pot)});`);
}
// Spielerentwicklung (Migration 0023): Gesamtstärke aus Attributen, Marktwert, Multiplikatoren, Spiel-XP
const prng = createRng('parity-dev');
for (let i = 0; i < 120; i++) {
  const pos = ALL_POS[i % ALL_POS.length];
  const target = 45 + ((i * 7) % 50);
  const attrs = pos === 'GK' ? generateGoalkeeperAttributes(prng, target) : generateOutfieldAttributes(prng, pos, target);
  const kind = pos === 'GK' ? 'goalkeeper' : 'outfield';
  const ovr = pos === 'GK' ? goalkeeperOverall(attrs) : outfieldOverall(attrs, pos);
  lines.push(`select tests.assert(public.fd_overall(${q(kind)}, ${q(pos)}, ${q(JSON.stringify(attrs))}::jsonb) = ${ovr}, ${q('OVR TS=SQL ' + pos + ' #' + i)});`);
}
for (let o = 50; o <= 92; o += 3) for (const a of [18, 24, 30, 34]) {
  lines.push(`select tests.assert(public.fd_market_value(${o}, ${a}) = ${marketValue(o, a)}, ${q('Marktwert TS=SQL ' + o + '/' + a)});`);
  lines.push(`select tests.assert(abs(public.fd_dev_multiplier(${a}, ${o}, ${o + (a % 7)}, ${40 + o % 50}) - ${devMultiplier(a, o, o + (a % 7), 40 + o % 50)}) < 1e-9, ${q('Entwicklungsfaktor TS=SQL ' + a + '/' + o)});`);
}
for (const v of [1, 40, 50, 63, 77, 98]) lines.push(`select tests.assert(abs(public.fd_dev_cost(${v}) - ${devAttributeCost(v)}) < 1e-9, ${q('Attributkosten TS=SQL ' + v)});`);
for (const [kind, pos, line] of [['outfield', 'ST', { minutes: 90, rating: 7.4, goals: 2, assists: 0, tacklesWon: 1, interceptions: 0, saves: 0 }], ['goalkeeper', 'GK', { minutes: 75, rating: 6.8, goals: 0, assists: 0, tacklesWon: 0, interceptions: 1, saves: 5 }], ['outfield', 'CB', { minutes: 30, rating: 5.5, goals: 0, assists: 1, tacklesWon: 3, interceptions: 2, saves: 0 }]]) {
  const xp = matchXp(kind, pos, line);
  for (const [k, v] of Object.entries(xp)) {
    lines.push(`select tests.assert(abs((public.fd_dev_match_xp(${q(kind)}, ${q(pos)}, ${line.minutes}, ${line.rating}, ${line.goals}, ${line.assists}, ${line.tacklesWon}, ${line.interceptions}, ${line.saves}) ->> ${q(k)})::numeric - ${v}) < 1e-9, ${q('Spiel-XP TS=SQL ' + pos + ' ' + k)});`);
  }
}
lines.push(`\\echo '>>> 20_parity: TypeScript und SQL rechnen identisch'`);
process.stdout.write(lines.join('\n') + '\n');
