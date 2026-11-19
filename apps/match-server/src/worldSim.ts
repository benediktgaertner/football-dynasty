import { MatchEngine } from '@fd/engine';
import type { Backend } from './backend.js';
import type { MatchRoom } from './room.js';
import { toEngineSetup } from './setup.js';

/**
 * C8.5: Spiele ohne (zuschauende) Menschen laufen in derselben Engine im Headless-Modus –
 * ohne Echtzeittakt, mit Automatik für beide Teams (E4). Je Welt läuft höchstens ein Durchgang.
 */
export function createWorldSimulator(backend: Backend, rooms: Map<string, Promise<MatchRoom>>) {
  const running = new Map<string, Promise<number>>();

  async function simulateOne(fixtureId: string): Promise<void> {
    const db = await backend.setup(fixtureId);
    const engine = new MatchEngine(toEngineSetup(db));
    engine.setAutopilot('home', true);
    engine.setAutopilot('away', true);
    // In Häppchen rechnen und den Event-Loop freigeben: Live-Partien und neue Verbindungen bleiben flüssig
    while (!engine.isFinished) {
      for (let i = 0; i < 400 && !engine.isFinished; i++) engine.step();
      await new Promise((r) => setImmediate(r));
    }
    await backend.finish(fixtureId, engine.result());
  }

  async function run(worldId: string): Promise<number> {
    let done = 0;
    for (let round = 0; round < 3; round++) {
      const pending = (await backend.pendingFixtures(worldId)).filter((id) => !rooms.has(id));
      if (pending.length === 0) break;
      for (const id of pending) {
        if (rooms.has(id)) continue;
        try {
          await simulateOne(id);
          done++;
        } catch (e) {
          console.error('Headless-Simulation fehlgeschlagen', id, e instanceof Error ? e.message : e);
        }
        // Event-Loop freigeben, damit Live-Partien flüssig bleiben
        await new Promise((r) => setImmediate(r));
      }
    }
    return done;
  }

  return {
    trigger(worldId: string): { started: boolean } {
      if (running.has(worldId)) return { started: false };
      const p = run(worldId).finally(() => running.delete(worldId));
      running.set(worldId, p);
      return { started: true };
    },
    isRunning: (worldId: string) => running.has(worldId),
    wait: (worldId: string) => running.get(worldId) ?? Promise.resolve(0),
  };
}
