// Testhilfe: erzeugt den Initialisierungs-Payload wie die Netlify-Function.
// Aufruf: node scripts/build-world-payload.mjs <seed> '<json: [{id,name,short_name}]>' [--mutate=<art>]
import { buildWorldInitialization } from '../packages/shared/dist/index.js';

const [seed, humansJson, mutate] = process.argv.slice(2);
const payload = buildWorldInitialization(seed, JSON.parse(humansJson));
if (mutate === '--mutate=pool399') payload.players.splice(payload.players.findIndex((p) => p.club_key === null), 1);
if (mutate === '--mutate=pool84') payload.players.find((p) => p.club_key === null).overall = 84;
if (mutate === '--mutate=badcrest') payload.ai_clubs[0].crest.initials = '<x>';
process.stdout.write(JSON.stringify(payload));
