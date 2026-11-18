// Erzeugt die Migration mit globalen Referenzdaten aus packages/shared,
// damit Datenbank und TypeScript dieselbe Quelle verwenden.
// Aufruf: npm run build -w @fd/shared && node scripts/generate-reference-sql.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ASSOCIATIONS, FORMATIONS, normalizeName, SECOND_TIER_PLACEMENT_PRIZES_MILLIONS, MILLION, CLUB_NAME_BLOCKLIST } from '../packages/shared/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = [];
const out = (s = '') => lines.push(s);

out('-- =====================================================================');
out('-- Migration 0009: Globale Referenzdaten (GENERIERT – nicht von Hand bearbeiten)');
out('-- Quelle: packages/shared (associations.ts, formations.ts, constants.ts)');
out('-- Neu erzeugen: node scripts/generate-reference-sql.mjs');
out('-- =====================================================================');
out();

out('insert into public.associations(code, name, naming_profile, start_strength, league_size) values');
out(ASSOCIATIONS.map((a) => `  (${q(a.code)}, ${q(a.name)}, ${q(a.naming)}, ${a.strength}, ${a.leagueSize})`).join(',\n') + ';');
out();

out('insert into public.formations(code, name, slots) values');
out(FORMATIONS.map((f) => `  (${q(f.code)}, ${q(f.name)}, ${q(JSON.stringify(f.slots))}::jsonb)`).join(',\n') + ';');
out();

// I7: Sponsoren. Werte für Liga 2 laut Master-Prompt; Liga 1 (×1,6) und Liga 3 (×0,5) als Ausgangswerte.
const tier2 = [
  [1, 'security', 'Sicherheit', 'per_league_match', 0.6, null],
  [2, 'performance', 'Leistungsbonus', 'per_league_win', 1.1, null],
  [3, 'points', 'Punktejäger', 'per_league_point', 0.4, null],
  [4, 'goals', 'Torjäger', 'per_league_goal', 0.4, null],
  [5, 'fortress', 'Defensive Festung', 'max_goals_against', 30, 30],
  [6, 'top_half', 'Obere Tabellenhälfte', 'placement_at_most', 25, 9],
  [7, 'top6', 'Top 6', 'placement_at_most', 30, 6],
  [8, 'promotion', 'Aufstieg', 'promotion', 40, null],
  [9, 'top3', 'Top 3', 'placement_at_most', 35, 3],
  [10, 'champion', 'Meisterschaft', 'champion', 50, null],
];
const sponsorRows = [];
for (const [tier, factor] of [[1, 1.6], [2, 1], [3, 0.5]]) {
  for (const [n, code, name, kind, millions, threshold] of tier2) {
    let k = kind;
    let c = code;
    let nm = name;
    let th = threshold;
    if (tier === 1 && kind === 'promotion') { k = 'placement_at_most'; c = 'top4'; nm = 'Top 4'; th = 4; }
    const amount = Math.round(millions * factor * MILLION);
    sponsorRows.push(`  (${(tier - 1) * 10 + n}, ${tier}, ${q(c)}, ${q(nm)}, ${q(k)}, ${amount}, ${th ?? 'null'})`);
  }
}
out('insert into public.sponsor_offers(id, tier, code, name, kind, amount, threshold) values');
out(sponsorRows.join(',\n') + ';');
out();

// I6 + C9.3: Prämien-Vorlagen
const prizes = [];
const tierFactor = { 1: 2, 2: 1, 3: 0.4 };
const matchBonus = { win: 0.5, draw: 0.25, loss: 0.1 };
for (const tier of [1, 2, 3]) {
  for (const [key, m] of Object.entries(matchBonus)) prizes.push(['league', tier, `match_${key}`, m * tierFactor[tier]]);
  SECOND_TIER_PLACEMENT_PRIZES_MILLIONS.forEach((m, i) => prizes.push(['league', tier, `placement_${i + 1}`, m * tierFactor[tier]]));
}
const euro = {
  qualifying_round: [1.0, 0.5],
  group_start: [15.0, 6.0],
  group_win: [2.5, 0.8],
  group_draw: [0.8, 0.3],
  group_winner: [2.0, 1.0],
  group_runner_up: [1.0, 0.5],
  reach_round_of_16: [8.0, 2.5],
  reach_quarter_final: [10.0, 3.5],
  reach_semi_final: [12.0, 5.0],
  reach_final: [15.0, 7.0],
  title: [8.0, 5.0],
};
for (const [key, [cl, el]] of Object.entries(euro)) {
  if (!(el < cl)) throw new Error(`C9.3 verletzt: EL-Prämie ${key} muss kleiner als CL-Prämie sein`);
  prizes.push(['champions_league', 0, key, cl]);
  prizes.push(['europa_league', 0, key, el]);
}
out('insert into public.prize_templates(competition_kind, tier, prize_key, amount) values');
out(prizes.map(([k, t, key, m]) => `  (${q(k)}, ${t}, ${q(key)}, ${Math.round(m * MILLION)})`).join(',\n') + ';');
out();

// C7.1: Sperrliste realer Profi- und Traditionsvereine (Auszug; erweiterbar)
const blocked = CLUB_NAME_BLOCKLIST;
const seen = new Set();
const blockRows = [];
for (const [code, names] of Object.entries(blocked)) {
  for (const name of names) {
    const n = normalizeName(name);
    if (n.length < 3 || seen.has(n)) continue;
    seen.add(n);
    blockRows.push(`  (${q(code)}, ${q(n)})`);
  }
}
out('insert into public.club_name_blocklist(association_code, name_normalized) values');
out(blockRows.join(',\n') + ';');
out();

const target = join(root, 'supabase/migrations/20261118000009_reference_data.sql');
writeFileSync(target, lines.join('\n'));
console.log(`geschrieben: ${target} (${ASSOCIATIONS.length} Verbände, ${FORMATIONS.length} Formationen, ${sponsorRows.length} Sponsoren, ${prizes.length} Prämien, ${blockRows.length} Sperrnamen)`);
