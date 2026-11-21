// Testhilfe: erzeugt den Initialisierungs-Payload wie die Netlify-Function.
// Aufruf: node scripts/build-world-payload.mjs <seed> '<json: [{id,name,short_name}]>' [--mutate=<art>] [--country=XXX --tier=N]
import { buildWorldInitialization } from '../packages/shared/dist/index.js';

// Optional: --country=ITA --tier=1 (Spielland/Startliga)
const args = process.argv.slice(2);
const [seed, humansJson] = args;
const mutate = args.find((a) => a.startsWith('--mutate='));
const country = args.find((a) => a.startsWith('--country='))?.slice(10);
const tier = args.find((a) => a.startsWith('--tier='))?.slice(7);
const payload = buildWorldInitialization(seed, JSON.parse(humansJson), country ? { country, startTier: Number(tier ?? 2) } : {});
if (mutate === '--mutate=pool399') payload.players.splice(payload.players.findIndex((p) => p.club_key === null), 1);
if (mutate === '--mutate=pool84') payload.players.find((p) => p.club_key === null).overall = 84;
if (mutate === '--mutate=badcrest') payload.ai_clubs[0].crest.initials = '<x>';
process.stdout.write(JSON.stringify(payload));
