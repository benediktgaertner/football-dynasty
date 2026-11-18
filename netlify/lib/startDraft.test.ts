import { describe, expect, it, vi } from 'vitest';
import { handleStartDraft, type StartDraftDeps } from './startDraft';

const WORLD = '11111111-2222-3333-4444-555555555555';

function deps(overrides: Partial<StartDraftDeps> = {}): StartDraftDeps {
  return {
    getUserId: async (t) => (t === 'good' ? { userId: 'host-id' } : t === 'guest' ? { userId: 'guest-id' } : t === 'keyfail' ? { reason: 'server_key' as const, detail: 'Invalid API key' } : { reason: 'invalid_token' as const }),
    loadContext: async () => ({
      id: WORLD, seed: 'abc', status: 'lobby', host_user_id: 'host-id',
      humans: [
        { id: 'c1', name: 'Test', short_name: 'TES' },
        { id: 'c2', name: 'Zweiter Verein', short_name: 'ZWV' },
      ],
    }),
    startDraft: vi.fn(async () => ({ data: { draft_id: 'd1' }, error: null })),
    ...overrides,
  };
}

const req = (token: string | null, body: unknown = { worldId: WORLD }, method = 'POST') =>
  new Request('https://example.org/api/start-draft', {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

describe('POST /api/start-draft', () => {
  it('verlangt POST und ein gültiges Token', async () => {
    expect((await handleStartDraft(req('good', {}, 'GET'), deps())).status).toBe(405);
    expect((await handleStartDraft(req(null), deps())).status).toBe(401);
    expect((await handleStartDraft(req('bad'), deps())).status).toBe(401);
  });
  it('unterscheidet abgelaufene Anmeldung und abgelehnten Server-Schlüssel', async () => {
    const expired = await handleStartDraft(req('bad'), deps());
    expect(await expired.json()).toMatchObject({ error: 'session_expired' });
    const keyfail = await handleStartDraft(req('keyfail'), deps());
    expect(keyfail.status).toBe(500);
    expect((await keyfail.json()).message).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('meldet Datenbank- und Rechtefehler im Klartext statt „nicht gefunden“', async () => {
    const r = await handleStartDraft(req('good'), deps({ loadContext: async () => { throw new Error('Der Server-Schlüssel hat keine Service-Role-Rechte [42501]'); } }));
    expect(r.status).toBe(500);
    expect((await r.json()).message).toContain('42501');
    const missing = await handleStartDraft(req('good'), deps({ loadContext: async () => null }));
    expect(missing.status).toBe(404);
  });
  it('prüft die worldId', async () => {
    expect((await handleStartDraft(req('good', { worldId: 'x; drop table' }), deps())).status).toBe(400);
  });
  it('nur der Host darf starten', async () => {
    const d = deps();
    const r = await handleStartDraft(req('guest'), d);
    expect(r.status).toBe(403);
    expect(d.startDraft).not.toHaveBeenCalled();
  });
  it('ein bereits gestarteter Draft wird nicht neu erzeugt', async () => {
    const d = deps({ loadContext: async () => ({ id: WORLD, seed: 'abc', status: 'draft', host_user_id: 'host-id', humans: [] }) });
    const r = await handleStartDraft(req('good'), d);
    expect(await r.json()).toMatchObject({ already_started: true });
    expect(d.startDraft).not.toHaveBeenCalled();
  });
  it('erzeugt die Welt und übergibt sie an admin_start_draft', async () => {
    const d = deps();
    const r = await handleStartDraft(req('good'), d);
    expect(r.status).toBe(200);
    const [worldId, userId, payload] = (d.startDraft as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(worldId).toBe(WORLD);
    expect(userId).toBe('host-id');
    expect(payload.ai_clubs).toHaveLength(52);
    expect(payload.players.filter((p: { club_key: unknown }) => p.club_key === null)).toHaveLength(400);
  });
  it('gibt Datenbankfehler mit Code weiter', async () => {
    const d = deps({ startDraft: async () => ({ data: null, error: { message: 'Noch nicht alle bereit.', hint: 'not_all_ready' } }) });
    const r = await handleStartDraft(req('good'), d);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'not_all_ready', message: 'Noch nicht alle bereit.' });
  });
});
