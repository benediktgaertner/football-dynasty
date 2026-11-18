// Erzeugt SQL-Prüfungen, die TypeScript- und SQL-Implementierung derselben Regeln vergleichen.
import { normalizeName, stadiumBuildCost, STARTING_CAPITAL, snakeDraftManagerIndex, totalDraftPicks, PLAYER_INSTRUCTIONS, roleGroup, CONFLICTING_INSTRUCTIONS, trainingDevelopmentPoints, POSITIONS, validatePlayerInstructions } from '../packages/shared/dist/index.js';
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
lines.push(`\\echo '>>> 20_parity: TypeScript und SQL rechnen identisch'`);
process.stdout.write(lines.join('\n') + '\n');
