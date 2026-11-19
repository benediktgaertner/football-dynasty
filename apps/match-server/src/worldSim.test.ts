import { describe, expect, it } from 'vitest';
import { buildTestTeam, type MatchResult } from '@fd/engine';
import type { Backend } from './backend.js';
import type { DbSetup, DbTeam } from './setup.js';
import type { MatchRoom } from './room.js';
import { createWorldSimulator } from './worldSim.js';

const team = (seed: string): DbTeam => {
  const t = buildTestTeam(seed, 70, { control: 'human' });
  return { ...t, managerUserId: 'u', capacity: 20000, squad: t.squad.map((p) => ({ ...p, unavailable: false })) } as unknown as DbTeam;
};

describe('Headless-Spieltag (C8.5)', () => {
  it('berechnet alle offenen Spiele des Termins mit derselben Engine, überspringt laufende Live-Räume', async () => {
    let pending = ['f1', 'f2', 'f3'];
    const finished: Array<{ id: string; r: MatchResult }> = [];
    const backend: Backend = {
      verifyToken: async () => 'u', role: async () => 'home', checkpoint: async () => {},
      setup: async (id) => ({ fixtureId: id, worldId: 'w', seed: id, kind: 'league', neutral: false, homeAdvantage: 0.01, home: team(`h${id}`), away: team(`a${id}`), checkpoint: null } as DbSetup),
      finish: async (id, r) => { finished.push({ id, r }); pending = pending.filter((x) => x !== id); },
      pendingFixtures: async () => pending,
      isMember: async () => true,
    };
    const rooms = new Map<string, Promise<MatchRoom>>([['f2', Promise.resolve({} as MatchRoom)]]);
    const sim = createWorldSimulator(backend, rooms);
    expect(sim.trigger('w').started).toBe(true);
    expect(sim.trigger('w').started).toBe(false); // nur ein Durchgang je Welt
    await sim.wait('w');
    expect(finished.map((f) => f.id).sort()).toEqual(['f1', 'f3']);
    // gleicher Seed ⇒ gleiches Ergebnis (identische Logik wie live)
    const again: string[] = [];
    pending = ['f1'];
    const b2 = { ...backend, finish: async (id: string, r: MatchResult) => { again.push(`${id}:${r.score}`); pending = []; } };
    const sim2 = createWorldSimulator(b2, new Map());
    sim2.trigger('w'); await sim2.wait('w');
    expect(again[0]).toBe(`f1:${finished.find((f) => f.id === 'f1')!.r.score}`);
  }, 30000);
});
