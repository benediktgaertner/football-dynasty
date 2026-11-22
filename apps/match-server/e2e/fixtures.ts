/**
 * E2E-Testserver (Playwright): echter Match-Server mit Test-Backend (keine Datenbank), Echtzeit.
 * Fixtures decken alle Einlauf-Fälle ab; Tokens: token-home-xxxx (Heim), token-away-xxxx (Gast).
 */
import { buildTestTeam } from '@fd/engine';
import type { Backend } from '../src/backend.js';
import type { DbSetup, DbTeam } from '../src/setup.js';

export function dbTeam(seed: string, control: 'human' | 'ai', manager: string | null): DbTeam {
  const t = buildTestTeam(seed, 70, { control });
  return {
    clubId: `club-${seed}`, name: control === 'ai' ? `KI ${seed.toUpperCase()}` : `Manager ${seed.toUpperCase()}`, shortName: seed.toUpperCase().slice(0, 3).padEnd(3, 'X'),
    control, managerUserId: manager, color: seed === 'h' ? '#c8102e' : '#1d4ed8', colorAlt: '#ffffff', capacity: 30000,
    squad: t.squad.map((p) => ({ ...p, unavailable: false })), settings: t.settings,
    profiles: Object.fromEntries(Object.entries(t.profiles).map(([k, v]) => [k, { ...v }])) as DbTeam['profiles'], setPieces: {},
  };
}

/** Vereinshymne (15 s, liegt im Web-Projekt unter /e2e/anthem.wav) */
export const ANTHEM = { id: 'anthem-1', name: 'Testhymne', source: 'upload', path: 'anthem.wav', volume: 0.9, duration: 15 };

interface Case { kind: string; homeHuman: boolean; awayHuman: boolean; anthem: boolean; seed?: string; awayChants?: boolean; homeChants?: boolean }

/** hochgeladener Gästegesang (Testsignal, liegt unter /e2e/chant-away.mp3) */
/** hochgeladener Heimgesang (Testsignal, /e2e/chant-home.mp3) */
export const HOME_CHANT = { id: 'up-home-1', name: 'Testgesang Heim', source: 'upload', path: 'chant-home.mp3', volume: 0.9, situation: 'general' };
export const AWAY_CHANT = { id: 'up-away-1', name: 'Testgesang Gäste', source: 'upload', path: 'chant-away.mp3', volume: 0.9, situation: 'general' };
export const CASES: Record<string, Case> = {
  'home-anthem-ai': { kind: 'league', homeHuman: true, awayHuman: false, anthem: true },
  'home-anthem-full': { kind: 'league', homeHuman: true, awayHuman: false, anthem: true },
  'home-noanthem-ai': { kind: 'league', homeHuman: true, awayHuman: false, anthem: false },
  'away-noanthem-ai': { kind: 'league', homeHuman: false, awayHuman: true, anthem: false },
  'cup-anthem-ai': { kind: 'domestic_cup', homeHuman: true, awayHuman: false, anthem: true },
  'cl-anthem-ai': { kind: 'champions_league', homeHuman: true, awayHuman: false, anthem: true },
  // Auswärtsspiel des Managers: eigene hochgeladene Gesänge im Gästeblock, KI-Heimfans
  'away-chants-ai': { kind: 'league', homeHuman: false, awayHuman: true, anthem: false, awayChants: true },
  // Heimspiel des Managers mit eigenen Gesängen gegen KI ohne Uploads
  'home-chants-ai': { kind: 'league', homeHuman: true, awayHuman: false, anthem: false, homeChants: true },
  'mp-anthem': { kind: 'league', homeHuman: true, awayHuman: true, anthem: true },
  // Seeds mit frühem Tor (gesucht mit e2e/findGoalSeed.ts): Heimtor nach ≈ 15 s, Auswärtstor nach ≈ 13 s
  'goal-home-ai': { kind: 'league', homeHuman: true, awayHuman: false, anthem: false, seed: 'goal-seed-9' },
  'goal-away-ai': { kind: 'league', homeHuman: true, awayHuman: false, anthem: false, seed: 'goal-seed-22' },
};

export function makeBackend(): Backend {
  const users: Record<string, string> = { 'token-home-xxxx': 'u-home', 'token-away-xxxx': 'u-away' };
  return {
    async verifyToken(t) { return users[t] ?? null; },
    async role(_f, u) { return u === 'u-home' ? 'home' : u === 'u-away' ? 'away' : null; },
    async setup(f) {
      const base = f.replace(/#.*$/, '');
      const c = CASES[base];
      if (!c) return null;
      const seed = c.seed ?? `seed-${f}`;
      return {
        fixtureId: f, worldId: 'w', seed, kind: c.kind, neutral: false,
        home: dbTeam('h', c.homeHuman ? 'human' : 'ai', c.homeHuman ? 'u-home' : null),
        away: dbTeam('a', c.awayHuman ? 'human' : 'ai', c.awayHuman ? 'u-away' : null),
        stadium: { name: 'Teststadion', capacity: 30000, design: {}, attendance: 26000,
          fans: { flags: [], ultras: [], choreo: null, audio: { anthem: c.anthem ? ANTHEM : null, signature: null, chants: c.homeChants ? [HOME_CHANT] : [] },
            away: c.awayChants ? { id: 'club-a', name: 'Manager A', short: 'MAN', control: 'human', colors: ['#1d4ed8', '#ffffff'], flags: [], ultra: null, chants: [AWAY_CHANT] } : null } },
        checkpoint: null,
      } as unknown as DbSetup;
    },
    async checkpoint() {}, async finish() {}, async pendingFixtures() { return []; }, async isMember() { return true; },
    async claim() { return { ok: true, attempts: 1 }; }, async failed() {}, async fallback() {}, async dueWorlds() { return []; },
    async sweep() { return { pending: [] }; },
  } as Backend;
}
