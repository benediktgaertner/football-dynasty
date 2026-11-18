// Erzeugt die Migration mit globalen Referenzdaten aus packages/shared,
// damit Datenbank und TypeScript dieselbe Quelle verwenden.
// Aufruf: npm run build -w @fd/shared && node scripts/generate-reference-sql.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ASSOCIATIONS, FORMATIONS, normalizeName, SECOND_TIER_PLACEMENT_PRIZES_MILLIONS, MILLION } from '../packages/shared/dist/index.js';

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
const blocked = {
  GER: ['FC Bayern München', 'Bayern München', 'Borussia Dortmund', 'Bayer 04 Leverkusen', 'Bayer Leverkusen', 'RB Leipzig', 'VfB Stuttgart', 'Eintracht Frankfurt', 'SC Freiburg', 'VfL Wolfsburg', 'Borussia Mönchengladbach', '1. FC Union Berlin', 'Union Berlin', 'SV Werder Bremen', 'Werder Bremen', 'TSG Hoffenheim', 'TSG 1899 Hoffenheim', 'FC Augsburg', '1. FSV Mainz 05', 'Mainz 05', '1. FC Heidenheim', 'FC St. Pauli', 'Hamburger SV', '1. FC Köln', 'Hertha BSC', 'FC Schalke 04', 'Schalke 04', 'Hannover 96', '1. FC Kaiserslautern', 'Fortuna Düsseldorf', '1. FC Nürnberg', 'Karlsruher SC', 'VfL Bochum', 'SV Darmstadt 98', 'Holstein Kiel', 'SC Paderborn 07', 'Eintracht Braunschweig', 'Arminia Bielefeld', 'Dynamo Dresden', 'Hansa Rostock', '1. FC Magdeburg', 'SpVgg Greuther Fürth', 'SV Elversberg', 'Preußen Münster', 'SSV Ulm 1846', 'Jahn Regensburg', 'TSV 1860 München', 'MSV Duisburg', 'Alemannia Aachen', 'Rot-Weiss Essen', 'Energie Cottbus', 'Erzgebirge Aue', 'Waldhof Mannheim', 'Kickers Offenbach', 'SV Wehen Wiesbaden', 'SV Sandhausen', 'VfL Osnabrück', 'Hallescher FC', 'SC Verl', '1. FC Saarbrücken', 'Viktoria Köln', 'Stuttgarter Kickers', 'Wuppertaler SV', 'SG Wattenscheid 09', 'Rot-Weiß Oberhausen', 'Tennis Borussia Berlin', 'Carl Zeiss Jena', 'Chemnitzer FC', 'FC Ingolstadt 04', 'SpVgg Unterhaching'],
  AUT: ['Red Bull Salzburg', 'FC Red Bull Salzburg', 'SK Rapid Wien', 'Rapid Wien', 'FK Austria Wien', 'Austria Wien', 'SK Sturm Graz', 'Sturm Graz', 'LASK', 'Wolfsberger AC'],
  SUI: ['FC Basel', 'BSC Young Boys', 'Young Boys', 'FC Zürich', 'Grasshopper Club Zürich', 'FC St. Gallen', 'FC Luzern', 'Servette FC'],
  ENG: ['Manchester United', 'Manchester City', 'Liverpool FC', 'Liverpool', 'Arsenal FC', 'Arsenal', 'Chelsea FC', 'Chelsea', 'Tottenham Hotspur', 'Newcastle United', 'Aston Villa', 'West Ham United', 'Everton FC', 'Everton', 'Leeds United', 'Leicester City', 'Nottingham Forest', 'Wolverhampton Wanderers', 'Brighton & Hove Albion', 'Crystal Palace', 'Fulham FC', 'Southampton FC', 'Sunderland AFC', 'Ipswich Town', 'Norwich City', 'Sheffield United', 'Sheffield Wednesday', 'Blackburn Rovers', 'Bolton Wanderers', 'Derby County', 'West Bromwich Albion', 'Burnley FC', 'Brentford FC', 'AFC Bournemouth', 'Middlesbrough FC', 'Stoke City', 'Coventry City', 'Queens Park Rangers', 'Preston North End', 'Cardiff City', 'Swansea City'],
  SCO: ['Celtic FC', 'Celtic', 'Rangers FC', 'Rangers', 'Aberdeen FC', 'Heart of Midlothian', 'Hibernian FC', 'Dundee United'],
  ESP: ['Real Madrid', 'FC Barcelona', 'Atlético Madrid', 'Atlético de Madrid', 'Sevilla FC', 'Real Betis', 'Valencia CF', 'Villarreal CF', 'Athletic Club', 'Athletic Bilbao', 'Real Sociedad', 'RC Celta de Vigo', 'Celta Vigo', 'RCD Espanyol', 'Getafe CF', 'CA Osasuna', 'RCD Mallorca', 'UD Las Palmas', 'Deportivo Alavés', 'Rayo Vallecano', 'Real Valladolid', 'Deportivo La Coruña', 'Real Zaragoza', 'Málaga CF', 'Real Oviedo', 'Sporting Gijón', 'Racing Santander', 'Granada CF', 'Cádiz CF', 'Elche CF', 'Levante UD', 'Girona FC'],
  ITA: ['Juventus', 'Juventus FC', 'AC Milan', 'Inter Mailand', 'FC Internazionale', 'Inter', 'AS Roma', 'SS Lazio', 'SSC Napoli', 'Napoli', 'ACF Fiorentina', 'Atalanta BC', 'Atalanta', 'Torino FC', 'Bologna FC', 'Genoa CFC', 'UC Sampdoria', 'Udinese Calcio', 'US Sassuolo', 'Cagliari Calcio', 'Hellas Verona', 'Parma Calcio', 'US Lecce', 'Como 1907', 'Empoli FC', 'Venezia FC', 'AC Monza', 'Palermo FC', 'US Salernitana'],
  FRA: ['Paris Saint-Germain', 'Olympique de Marseille', 'Olympique Marseille', 'Olympique Lyonnais', 'Olympique Lyon', 'AS Monaco', 'LOSC Lille', 'OGC Nice', 'Stade Rennais', 'RC Lens', 'FC Nantes', 'Girondins de Bordeaux', 'AS Saint-Étienne', 'Stade de Reims', 'Montpellier HSC', 'RC Strasbourg', 'Toulouse FC', 'Stade Brestois', 'AJ Auxerre', 'Le Havre AC', 'FC Lorient', 'Angers SCO', 'FC Metz'],
  NED: ['Ajax Amsterdam', 'AFC Ajax', 'Ajax', 'PSV Eindhoven', 'PSV', 'Feyenoord', 'Feyenoord Rotterdam', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'SC Heerenveen', 'Vitesse Arnhem', 'FC Groningen', 'Sparta Rotterdam', 'Go Ahead Eagles', 'NEC Nijmegen', 'Willem II', 'RKC Waalwijk', 'NAC Breda', 'Fortuna Sittard', 'PEC Zwolle', 'Heracles Almelo'],
  BEL: ['Club Brugge', 'RSC Anderlecht', 'Anderlecht', 'Standard Lüttich', 'Standard Liège', 'KRC Genk', 'KAA Gent', 'Royal Antwerp FC', 'Union Saint-Gilloise', 'Cercle Brugge'],
  POR: ['SL Benfica', 'Benfica', 'FC Porto', 'Sporting CP', 'Sporting Lissabon', 'SC Braga', 'Vitória Guimarães', 'Boavista FC'],
  TUR: ['Galatasaray', 'Fenerbahçe', 'Beşiktaş', 'Trabzonspor', 'Başakşehir', 'İstanbul Başakşehir'],
  GRE: ['Olympiakos Piräus', 'Olympiacos', 'Panathinaikos', 'AEK Athen', 'PAOK Saloniki', 'PAOK', 'Aris Thessaloniki'],
  CRO: ['Dinamo Zagreb', 'GNK Dinamo Zagreb', 'HNK Hajduk Split', 'Hajduk Split', 'HNK Rijeka'],
  SRB: ['Roter Stern Belgrad', 'Crvena Zvezda', 'FK Crvena Zvezda', 'Partizan Belgrad', 'FK Partizan'],
  UKR: ['Schachtar Donezk', 'Shakhtar Donetsk', 'Dynamo Kiew', 'Dynamo Kyiv'],
  RUS: ['Zenit St. Petersburg', 'Spartak Moskau', 'Spartak Moscow', 'ZSKA Moskau', 'CSKA Moscow', 'Lokomotive Moskau', 'Lokomotiv Moscow', 'Dynamo Moskau'],
  CZE: ['Sparta Prag', 'AC Sparta Praha', 'Slavia Prag', 'SK Slavia Praha', 'Viktoria Pilsen', 'FC Viktoria Plzeň'],
  DEN: ['FC Kopenhagen', 'FC København', 'Brøndby IF', 'FC Midtjylland'],
  SWE: ['Malmö FF', 'AIK', 'Djurgårdens IF', 'IFK Göteborg', 'Hammarby IF'],
  NOR: ['Rosenborg BK', 'FK Bodø/Glimt', 'Molde FK'],
  POL: ['Legia Warschau', 'Legia Warszawa', 'Lech Posen', 'Lech Poznań', 'Wisła Kraków'],
  HUN: ['Ferencváros', 'Ferencvárosi TC'],
  ROU: ['FCSB', 'Steaua Bukarest', 'Dinamo Bukarest', 'CFR Cluj'],
  BUL: ['Ludogorez Rasgrad', 'Ludogorets Razgrad', 'ZSKA Sofia', 'Lewski Sofia'],
  ISR: ['Maccabi Tel Aviv', 'Maccabi Haifa', 'Hapoel Be’er Sheva'],
  CYP: ['APOEL Nikosia', 'APOEL', 'AC Omonia', 'Omonia Nikosia'],
};
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
