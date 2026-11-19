import { describe, expect, it, vi } from 'vitest';
import { EUROPE_ASSOCIATIONS } from '@fd/shared';
import { handleEnsureEurope, type EnsureEuropeDeps } from './ensureEurope';

const WORLD = '11111111-2222-3333-4444-555555555555';
const req = (token: string | null, body: unknown = { worldId: WORLD }) =>
  new Request('https://example.org/api/ensure-europe', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

function deps(over: Partial<EnsureEuropeDeps> = {}): EnsureEuropeDeps {
  return {
    getUserId: async (t) => (t === 'good' ? { userId: 'u1' } : { reason: 'invalid_token' as const }),
    isMember: async (_w, u) => u === 'u1',
    status: async () => ({ seed: 'abc', status: 'season', clubs: [{ name: 'Mein Verein', short_name: 'MVN' }], done: [] }),
    add: vi.fn(async () => ({ error: null })),
    ...over,
  };
}

describe('POST /api/ensure-europe', () => {
  it('prüft Anmeldung und Mitgliedschaft', async () => {
    expect((await handleEnsureEurope(req(null), deps())).status).toBe(401);
    expect((await handleEnsureEurope(req('bad'), deps())).status).toBe(401);
    expect((await handleEnsureEurope(req('good'), deps({ isMember: async () => false }))).status).toBe(403);
    expect((await handleEnsureEurope(req('good', { worldId: 'x' }), deps())).status).toBe(400);
  });

  it('legt alle fehlenden Verbände an und überspringt vorhandene', async () => {
    const d = deps({ status: async () => ({ seed: 'abc', status: 'season', clubs: [], done: ['ENG', 'ESP'] }) });
    const res = await handleEnsureEurope(req('good'), d, 60_000);
    const body = await res.json() as { done: number; total: number; finished: boolean; added: string[] };
    expect(res.status).toBe(200);
    expect(body.finished).toBe(true);
    expect(body.total).toBe(EUROPE_ASSOCIATIONS.length);
    expect(body.added).not.toContain('ENG');
    expect(d.add).toHaveBeenCalledTimes(EUROPE_ASSOCIATIONS.length - 2);
  });

  it('arbeitet in Etappen, wenn das Zeitbudget erreicht ist', async () => {
    let t = 0;
    const d = deps({ now: () => (t += 1000) });
    const body = await (await handleEnsureEurope(req('good'), d, 2500)).json() as { finished: boolean; added: string[] };
    expect(body.finished).toBe(false);
    expect(body.added.length).toBeGreaterThan(0);
    expect(body.added.length).toBeLessThan(EUROPE_ASSOCIATIONS.length);
  });

  it('nicht vor dem Draft-Start', async () => {
    expect((await handleEnsureEurope(req('good'), deps({ status: async () => ({ seed: 'a', status: 'lobby', clubs: [], done: [] }) }))).status).toBe(409);
  });
});
