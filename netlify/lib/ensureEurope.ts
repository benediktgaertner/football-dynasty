import { buildEuropeAssociation, europeAssociationsFor, registryFrom, type EuropePayload } from '@fd/shared';
import { json } from './startDraft.js';

/**
 * Europaweiter Transfermarkt: ergänzt eine Welt Verband für Verband um die ausländischen Erstligen.
 * Bestehende Welten werden so sicher nachgerüstet (nichts wird gelöscht; admin_add_europe ist idempotent).
 * Ein Aufruf arbeitet höchstens `budgetMs` und meldet den Fortschritt; der Client ruft erneut auf, bis `finished`.
 */
export interface EuropeStatus {
  seed: string;
  status: string;
  clubs: Array<{ name: string; short_name: string }>;
  done: string[];
  /** Spielland der Welt (dessen Erstliga ist national und wird hier nicht erzeugt) */
  country?: string | null;
}

export interface EnsureEuropeDeps {
  getUserId(token: string): Promise<{ userId: string } | { reason: 'invalid_token' | 'server_key'; detail?: string }>;
  isMember(worldId: string, userId: string): Promise<boolean>;
  status(worldId: string): Promise<EuropeStatus | null>;
  add(worldId: string, payload: EuropePayload): Promise<{ error: string | null }>;
  now?: () => number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleEnsureEurope(req: Request, deps: EnsureEuropeDeps, budgetMs = 6500): Promise<Response> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed', message: 'Nur POST ist erlaubt.' });
  const token = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim())?.[1];
  if (!token) return json(401, { error: 'not_authenticated', message: 'Nicht angemeldet.' });
  const who = await deps.getUserId(token);
  if ('reason' in who) {
    return who.reason === 'server_key'
      ? json(500, { error: 'server_key_rejected', message: 'Supabase lehnt den Server-Schlüssel ab. Bitte SUPABASE_SERVICE_ROLE_KEY in Netlify prüfen.' })
      : json(401, { error: 'session_expired', message: 'Deine Anmeldung ist abgelaufen. Bitte lade die Seite neu.' });
  }
  let worldId: unknown;
  try { worldId = ((await req.json()) as { worldId?: unknown }).worldId; } catch { return json(400, { error: 'invalid_request', message: 'Ungültige Anfrage.' }); }
  if (typeof worldId !== 'string' || !UUID_RE.test(worldId)) return json(400, { error: 'invalid_request', message: 'worldId fehlt oder ist ungültig.' });
  if (!(await deps.isMember(worldId, who.userId))) return json(403, { error: 'forbidden', message: 'Du bist kein Mitglied dieser Welt.' });

  const st = await deps.status(worldId);
  if (!st) return json(404, { error: 'not_found', message: 'Welt nicht gefunden.' });
  const foreign = europeAssociationsFor((st.country ?? 'GER').trim());
  const total = foreign.length;
  if (st.status === 'lobby') return json(409, { error: 'not_started', message: 'Der europäische Markt entsteht mit dem Draft-Start.', done: 0, total, finished: false });

  const done = new Set(st.done);
  const registry = registryFrom(st.clubs);
  const added: string[] = [];
  for (const a of foreign) {
    if (done.has(a.code)) continue;
    if (added.length > 0 && now() - t0 > budgetMs) break;
    const payload = buildEuropeAssociation(st.seed, a.code, registry);
    const { error } = await deps.add(worldId, payload);
    if (error) return json(500, { error: 'db_error', message: `Verband ${a.name} konnte nicht angelegt werden: ${error}`, done: done.size, total, finished: false });
    done.add(a.code);
    added.push(a.code);
  }
  return json(200, { done: done.size, total, finished: done.size >= total, added });
}
