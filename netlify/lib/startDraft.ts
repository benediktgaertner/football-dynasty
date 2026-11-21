import { buildWorldInitialization, type HumanClubRef, type StartTier, type WorldInitPayload } from '@fd/shared';

/**
 * Serverseitiger Start des Drafts (Phase 3).
 * 1. Token prüfen (Supabase Auth) → Benutzer-ID
 * 2. Kontext der Welt über die abgesicherte RPC admin_draft_context laden
 * 3. Welt deterministisch aus dem Seed erzeugen (packages/shared)
 * 4. admin_start_draft() speichert alles in einer Transaktion und prüft Host/Bereitschaft erneut
 *
 * Abhängigkeiten werden injiziert, damit die Logik ohne Supabase testbar ist.
 */
export interface DraftContext {
  id: string;
  seed: string;
  status: string;
  host_user_id: string;
  humans: HumanClubRef[];
  /** Spielland und Startliga (fehlen bei älteren Datenbankständen: Deutschland, 2. Liga) */
  country?: string | null;
  start_tier?: number | null;
}

export interface StartDraftDeps {
  /** userId bei Erfolg; sonst reason: 'invalid_token' (Login abgelaufen) oder 'server_key' (Server-Schlüssel abgelehnt) */
  getUserId(token: string): Promise<{ userId: string } | { reason: 'invalid_token' | 'server_key'; detail?: string }>;
  /** Liefert den Kontext oder null (Welt existiert nicht). Wirft bei Datenbank-/Rechtefehlern mit Klartext. */
  loadContext(worldId: string): Promise<DraftContext | null>;
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
  const who = await deps.getUserId(token);
  if ('reason' in who) {
    if (who.reason === 'server_key') {
      return json(500, {
        error: 'server_key_rejected',
        message: `Supabase lehnt den Server-Schlüssel ab${who.detail ? ` (${who.detail})` : ''}. Bitte SUPABASE_SERVICE_ROLE_KEY in Netlify prüfen: richtiger Schlüssel, gleiches Projekt wie VITE_SUPABASE_URL, danach neu deployen.`,
      });
    }
    return json(401, { error: 'session_expired', message: 'Deine Anmeldung ist abgelaufen. Bitte lade die Seite neu und versuche es erneut.' });
  }
  const userId = who.userId;

  let worldId: unknown;
  try {
    worldId = ((await req.json()) as { worldId?: unknown }).worldId;
  } catch {
    return json(400, { error: 'invalid_request', message: 'Ungültige Anfrage.' });
  }
  if (typeof worldId !== 'string' || !UUID_RE.test(worldId)) {
    return json(400, { error: 'invalid_request', message: 'worldId fehlt oder ist ungültig.' });
  }

  let ctx: DraftContext | null;
  try {
    ctx = await deps.loadContext(worldId);
  } catch (e) {
    return json(500, { error: 'database_error', message: (e as Error).message });
  }
  if (!ctx) return json(404, { error: 'world_not_found', message: 'Karrierewelt nicht gefunden.' });
  if (ctx.host_user_id !== userId) return json(403, { error: 'host_only', message: 'Nur der Host darf den Draft starten.' });
  if (ctx.status !== 'lobby') return json(200, { already_started: true, status: ctx.status });
  if (ctx.humans.length === 0) return json(400, { error: 'not_all_ready', message: 'Es gibt noch keine Vereine.' });

  const country = (ctx.country ?? 'GER').trim();
  const startTier = (ctx.start_tier ?? 2) as StartTier;
  // Deutschland/2. Liga: Payload exakt wie bisher (ohne Zusatzfelder)
  const payload = country === 'GER' && startTier === 2
    ? buildWorldInitialization(ctx.seed, ctx.humans)
    : buildWorldInitialization(ctx.seed, ctx.humans, { country, startTier });
  const { data, error } = await deps.startDraft(worldId, userId, payload);
  if (error) {
    const code = error.hint ?? 'start_failed';
    return json(code === 'host_only' ? 403 : 400, { error: code, message: error.message });
  }
  return json(200, data);
}
