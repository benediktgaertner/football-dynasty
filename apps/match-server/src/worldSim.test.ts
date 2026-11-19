import { describe, expect, it } from 'vitest';
import { buildTestTeam, type MatchResult } from '@fd/engine';
import type { Backend } from './backend.js';
import type { DbSetup, DbTeam } from './setup.js';
import type { MatchRoom } from './room.js';
import { createWorldSimulator, MAX_ATTEMPTS } from './worldSim.js';

const team = (seed: string): DbTeam => {
  const t = buildTestTeam(seed, 70, { control: 'human' });
  return { ...t, managerUserId: 'u', capacity: 20000, squad: t.squad.map((p) => ({ ...p, unavailable: false })) } as unknown as DbTeam;
};
const setupOf = (id: string) => ({ fixtureId: id, worldId: 'w', seed: id, kind: 'league', neutral: false, homeAdvantage: 0.01, home: team(`h${id}`), away: team(`a${id}`), checkpoint: null } as DbSetup);

/** In-Memory-Backend mit derselben Semantik wie die Datenbank (Sperre, Versuche, idempotentes Speichern) */
function memoryBackend(ids: string[], opts: { failSetup?: Set<string>; busy?: Set<string> } = {}) {
  const pending = new Set(ids);
  const attempts = new Map<string, number>();
  const finished = new Map<string, MatchResult | 'fallback'>();
  let saves = 0;
  const backend: Backend = {
    verifyToken: async () => 'u', role: async () => 'home', checkpoint: async () => {}, isMember: async () => true,
    setup: async (id) => { if (opts.failSetup?.has(id)) throw new Error('kaputt'); return setupOf(id); },
    finish: async (id, r) => { saves++; if (!finished.has(id)) finished.set(id, r); pending.delete(id); },
    pendingFixtures: async () => [...pending],
    claim: async (id) => {
      if (finished.has(id)) return { ok: false, attempts: attempts.get(id) ?? 0, reason: 'done' };
      if (opts.busy?.has(id)) return { ok: false, attempts: 0, reason: 'busy' };
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      return { ok: true, attempts: attempts.get(id)! };
    },
    failed: async () => {},
    fallback: async (id) => { finished.set(id, 'fallback'); pending.delete(id); },
    dueWorlds: async () => (pending.size ? ['w'] : []),
    sweep: async () => ({ pending: [...pending] }),
  };
  return { backend, pending, finished, attempts, saves: () => saves };
}

describe('Spieltagssteuerung (C8.5)', () => {
  it('berechnet alle offenen Spiele des Termins mit derselben Engine, überspringt laufende Live-Räume', async () => {
    const m = memoryBackend(['f1', 'f2', 'f3']);
    const rooms = new Map<string, Promise<MatchRoom>>([['f2', Promise.resolve({} as MatchRoom)]]);
    const sim = createWorldSimulator(m.backend, rooms, { log: () => {} });
    expect(sim.trigger('w').started).toBe(true);
    expect(sim.trigger('w').started).toBe(false); // nur ein Durchgang je Welt
    await sim.wait('w');
    expect([...m.finished.keys()].sort()).toEqual(['f1', 'f3']);
    // gleicher Seed ⇒ gleiches Ergebnis (identische Logik wie live)
    const m2 = memoryBackend(['f1']);
    const sim2 = createWorldSimulator(m2.backend, new Map(), { log: () => {} });
    sim2.trigger('w'); await sim2.wait('w');
    expect((m2.finished.get('f1') as MatchResult).score).toEqual((m.finished.get('f1') as MatchResult).score);
  }, 30000);

  it('läuft ohne Client: der Sweep findet Welten mit offenem Spieltag selbst', async () => {
    const m = memoryBackend(['a', 'b']);
    const sim = createWorldSimulator(m.backend, new Map(), { log: () => {} });
    expect(await sim.sweepAll()).toBe(1);
    await sim.wait('w');
    expect(m.pending.size).toBe(0);
    expect(await sim.sweepAll()).toBe(0); // nichts mehr zu tun
  }, 30000);

  it('wiederholt fehlgeschlagene Partien und sichert nach drei Fehlversuchen ein Ersatzergebnis', async () => {
    const m = memoryBackend(['ok', 'bad'], { failSetup: new Set(['bad']) });
    const sim = createWorldSimulator(m.backend, new Map(), { log: () => {} });
    for (let i = 0; i < 3 && m.pending.size; i++) { await sim.sweepAll(); await sim.wait('w'); }
    expect(m.finished.get('bad')).toBe('fallback');
    expect(m.attempts.get('bad')).toBe(MAX_ATTEMPTS);
    expect(m.finished.get('ok')).not.toBe('fallback');
    expect(m.pending.size).toBe(0);
  }, 30000);

  it('simuliert gesperrte oder bereits beendete Partien nie ein zweites Mal', async () => {
    const m = memoryBackend(['x', 'y'], { busy: new Set(['y']) });
    const sim = createWorldSimulator(m.backend, new Map(), { log: () => {} });
    sim.trigger('w'); await sim.wait('w');
    expect(m.finished.has('y')).toBe(false); // gehört einer anderen Instanz
    const before = m.saves();
    m.pending.add('x'); // erneut gemeldet, aber schon gespeichert
    sim.trigger('w'); await sim.wait('w');
    expect(m.saves()).toBe(before);
  }, 30000);
});
