import { buildWorldInitialization, type HumanClubRef, type WorldInitPayload } from '@fd/shared';

/**
 * Serverseitiger Start des Drafts (Phase 3).
 * 1. Token prüfen (Supabase Auth) → Benutzer-ID
 * 2. Welt laden; nur der Host darf starten (wird in SQL erneut geprüft)
 * 3. Welt deterministisch aus dem Seed erzeugen (packages/shared)
 * 4. admin_start_draft() speichert alles in einer Transaktion
 *
 * Abhängigkeiten werden injiziert, damit die Logik ohne Supabase testbar ist.
 */
export interface StartDraftDeps {
  getUserId(token: string): Promise<string | null>;
  loadWorld(worldId: string): Promise<{ id: string; seed: string; status: string; host_user_id: string } | null>;
  loadHumanClubs(worldId: string): Promise<HumanClubRef[]>;
  startDraft(worldId: string, userId: string, payload: WorldInitPayload): Promise<{ data: unknown; error: { message: string; hint?: string | null } | null }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export async function handleStartDraft(req: Request, deps: StartDraftDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', message: 'Nur POST ist erlaubt.' });

  const auth = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1];
  if (!token) return json(401, { error: 'not_authenticated', message: 'Nicht angemeldet.' });
  const userId = await deps.getUserId(token);
  if (!userId) return json(401, { error: 'not_authenticated', message: 'Sitzung ungültig oder abgelaufen.' });

  let worldId: unknown;
  try {
    worldId = ((await req.json()) as { worldId?: unknown }).worldId;
  } catch {
    return json(400, { error: 'invalid_request', message: 'Ungültige Anfrage.' });
  }
  if (typeof worldId !== 'string' || !UUID_RE.test(worldId)) {
    return json(400, { error: 'invalid_request', message: 'worldId fehlt oder ist ungültig.' });
  }

  const world = await deps.loadWorld(worldId);
  if (!world) return json(404, { error: 'world_not_found', message: 'Karrierewelt nicht gefunden.' });
  if (world.host_user_id !== userId) return json(403, { error: 'host_only', message: 'Nur der Host darf den Draft starten.' });
  if (world.status !== 'lobby') return json(200, { already_started: true, status: world.status });

  const humans = await deps.loadHumanClubs(worldId);
  if (humans.length === 0) return json(400, { error: 'not_all_ready', message: 'Es gibt noch keine Vereine.' });

  const payload = buildWorldInitialization(world.seed, humans);
  const { data, error } = await deps.startDraft(worldId, userId, payload);
  if (error) {
    const code = error.hint ?? 'start_failed';
    return json(code === 'host_only' ? 403 : 400, { error: code, message: error.message });
  }
  return json(200, data);
}
