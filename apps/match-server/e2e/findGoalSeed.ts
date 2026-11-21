// Sucht einen Seed mit frühem Tor (für den Torjubel-Test in Echtzeit)
import { MatchEngine } from '@fd/engine';
import { toEngineSetup } from '../src/setup.js';
import { CASES, makeBackend } from './fixtures.js';
void CASES;
const b = makeBackend();
for (let i = 0; i < 400; i++) {
  const seed = `goal-seed-${i}`;
  const db = { ...(await b.setup('goal-home-ai'))!, seed };
  const e = new MatchEngine(toEngineSetup(db));
  while (!e.isFinished && e.tick < 600) e.step();
  const g = e.events.find((x) => x.type === 'goal');
  if (g && g.tick > 150 && g.tick < 500 && g.side === (process.argv[2] ?? 'home')) { console.log(seed, g.tick, g.side); break; }
}
