import { MatchEngine } from '@fd/engine';
import type { Backend } from './backend.js';
import type { MatchRoom } from './room.js';
import { toEngineSetup } from './setup.js';

/** Nach so vielen Fehlversuchen erhält eine Partie ein Ersatzergebnis (admin_fallback_result) */
export const MAX_ATTEMPTS = 3;

/**
 * C8.5 / Spieltagssteuerung: Spiele ohne (zuschauende) Menschen laufen in derselben Engine im
 * Headless-Modus – ohne Echtzeittakt, mit Automatik für beide Teams (E4).
 *
 * Ablauf je Partie: Sperre holen (admin_claim_fixture) → simulieren → speichern (admin_finish_match,
 * idempotent). Schlägt etwas fehl, wird die Partie als „failed“ markiert und beim nächsten Durchgang
 * erneut versucht; nach MAX_ATTEMPTS Fehlversuchen sichert ein Ersatzergebnis den Saisonfortschritt.
 * Bereits gespeicherte Partien werden nie ein zweites Mal simuliert oder überschrieben.
 *
 * Der Sweeper (start) läuft unabhängig von Clients: alle paar Sekunden werden alle Welten mit
 * laufendem Spieltag geprüft. Je Welt läuft höchstens ein Durchgang gleichzeitig.
 */
export function createWorldSimulator(backend: Backend, rooms: Map<string, Promise<MatchRoom>>, opts: { worker?: string; log?: (msg: string) => void } = {}) {
  const running = new Map<string, Promise<number>>();
  const worker = opts.worker ?? `worker-${process.pid}`;
  const log = opts.log ?? ((m: string) => console.log(m));

  async function simulateOne(fixtureId: string): Promise<'done' | 'skipped'> {
    const claim = await backend.claim(fixtureId, worker);
    if (!claim.ok) return 'skipped';
    try {
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
      return 'done';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Bereits beendet (z. B. parallel live gespeichert): kein Fehler
      if (/already_finished|already_saved/.test(msg)) return 'skipped';
      console.error('Headless-Simulation fehlgeschlagen', fixtureId, `Versuch ${claim.attempts}`, msg);
      await backend.failed(fixtureId, msg).catch(() => undefined);
      if (claim.attempts >= MAX_ATTEMPTS) {
        try {
          await backend.fallback(fixtureId);
          log(`Ersatzergebnis für ${fixtureId} nach ${claim.attempts} Fehlversuchen gespeichert`);
          return 'done';
        } catch (e2) {
          console.error('Ersatzergebnis fehlgeschlagen', fixtureId, e2 instanceof Error ? e2.message : e2);
        }
      }
      return 'skipped';
    }
  }

  async function run(worldId: string): Promise<number> {
    let done = 0;
    const tried = new Map<string, number>();
    for (let round = 0; round < 40; round++) {
      // Jeder Sweep erledigt auch einen Teil des KI-Zusatztrainings der Woche (in Häppchen, ohne Zeitlimit-Risiko)
      const sweep = await backend.sweep(worldId);
      // Je Durchgang jede Partie höchstens zweimal; weitere Versuche beim nächsten Sweep (Backoff)
      const pending = sweep.pending.filter((id) => !rooms.has(id) && (tried.get(id) ?? 0) < 2);
      if (pending.length === 0) {
        if ((sweep.trainingLeft ?? 0) > 0) { await new Promise((r) => setImmediate(r)); continue; }
        break;
      }
      for (const id of pending) {
        if (rooms.has(id)) continue;
        tried.set(id, (tried.get(id) ?? 0) + 1);
        try {
          if ((await simulateOne(id)) === 'done') done++;
        } catch (e) {
          console.error('Spieltagssteuerung: Partie übersprungen', id, e instanceof Error ? e.message : e);
        }
        await new Promise((r) => setImmediate(r));
      }
    }
    return done;
  }

  function trigger(worldId: string): { started: boolean } {
    if (running.has(worldId)) return { started: false };
    const p = run(worldId)
      .catch((e: unknown) => { console.error('Spieltagssteuerung fehlgeschlagen', worldId, e instanceof Error ? e.message : e); return 0; })
      .finally(() => running.delete(worldId));
    running.set(worldId, p);
    return { started: true };
  }

  /** Alle Welten mit laufendem Spieltag anstoßen (ohne Client); Fehler blockieren den nächsten Sweep nicht */
  async function sweepAll(): Promise<number> {
    let started = 0;
    try {
      for (const w of await backend.dueWorlds()) if (trigger(w).started) started++;
    } catch (e) {
      console.error('Sweep fehlgeschlagen', e instanceof Error ? e.message : e);
    }
    return started;
  }

  let timer: NodeJS.Timeout | null = null;
  return {
    trigger,
    sweepAll,
    start(intervalMs = 10_000) {
      if (timer) return;
      void sweepAll();
      timer = setInterval(() => void sweepAll(), intervalMs);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    isRunning: (worldId: string) => running.has(worldId),
    wait: (worldId: string) => running.get(worldId) ?? Promise.resolve(0),
  };
}
