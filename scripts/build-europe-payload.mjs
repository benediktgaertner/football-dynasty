// Testhilfe: erzeugt Europa-Payloads wie die Netlify-Function /api/ensure-europe (gemeinsame Namens-Registry).
// Aufruf: node scripts/build-europe-payload.mjs <seed> '<json: [{name,short_name}]>' <Zielordner> <Verband…>
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildEuropeAssociation, registryFrom } from '../packages/shared/dist/index.js';

const [seed, clubsJson, dir, ...codes] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const registry = registryFrom(JSON.parse(clubsJson));
for (const code of codes) writeFileSync(`${dir}/${code}.json`, JSON.stringify(buildEuropeAssociation(seed, code, registry)));
