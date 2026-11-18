// Erzeugt SQL-Prüfungen, die TypeScript- und SQL-Implementierung derselben Regeln vergleichen.
import { normalizeName, stadiumBuildCost, STARTING_CAPITAL } from '../packages/shared/dist/index.js';
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
lines.push(`\\echo '>>> 20_parity: TypeScript und SQL rechnen identisch'`);
process.stdout.write(lines.join('\n') + '\n');
