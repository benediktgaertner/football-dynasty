import { readFileSync } from 'node:fs';
import { simulate } from '@fd/engine';
import { toEngineSetup, type DbSetup } from './setup.js';

/** CLI für den DB-Ende-zu-Ende-Test: node dist/simulateFromSetup.js setup.json > result.json */
const db = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as DbSetup;
process.stdout.write(JSON.stringify(simulate(toEngineSetup(db))));
