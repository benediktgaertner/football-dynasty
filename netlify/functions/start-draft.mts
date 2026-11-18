import { createClient } from '@supabase/supabase-js';
import { checkServiceKey } from '../lib/serverKey.js';
import { handleStartDraft, json, type DraftContext } from '../lib/startDraft.js';

/**
 * POST /api/start-draft  { worldId }  (Authorization: Bearer <Supabase-Access-Token>)
 *
 * Benötigte Netlify-Umgebungsvariablen (nur serverseitig, Scope „Functions“):
 *   SUPABASE_SERVICE_ROLE_KEY   Secret-/Service-Role-Schlüssel – niemals mit VITE_-Präfix!
 *   SUPABASE_URL                optional; sonst wird VITE_SUPABASE_URL verwendet
 */

/** Übersetzt typische Supabase-Fehler in verständliche Hinweise. */
function explain(error: { code?: string; message: string }, what: string): string {
  const raw = `${error.code ? `${error.code}: ` : ''}${error.message}`;
  if (error.code === 'PGRST202' || /could not find the function/i.test(error.message)) {
    return `Ein Datenbank-Update fehlt (${what}). Bitte die neueste SQL-Update-Datei im Supabase-SQL-Editor ausführen. [${raw}]`;
  }
  if (error.code === '42501' || /permission denied/i.test(error.message)) {
    return `Der Server-Schlüssel hat in Supabase keine Service-Role-Rechte. In SUPABASE_SERVICE_ROLE_KEY muss der Secret-Key (sb_secret_…) bzw. „service_role“ desselben Projekts stehen. [${raw}]`;
  }
  return `Datenbankfehler (${what}): ${raw}`;
}

export default async (req: Request): Promise<Response> => {
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.trim().replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/^["']|["']$/g, '').trim();
  if (!url || !serviceKey) {
    return json(500, {
      error: 'server_not_configured',
      message: 'Auf Netlify fehlt die Umgebungsvariable SUPABASE_SERVICE_ROLE_KEY (siehe docs/DEPLOYMENT.md).',
    });
  }
  const keyProblem = checkServiceKey(url, serviceKey);
  if (keyProblem) return json(500, { error: 'server_key_invalid', message: keyProblem });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    return await handleStartDraft(req, {
      async getUserId(token) {
        const { data, error } = await admin.auth.getUser(token);
        if (!error && data.user) return { userId: data.user.id };
        if (error && /api ?key/i.test(error.message)) return { reason: 'server_key', detail: error.message };
        console.warn('Token abgelehnt:', error?.message);
        return { reason: 'invalid_token' };
      },
      async loadContext(worldId) {
        const { data, error } = await admin.rpc('admin_draft_context', { p_world: worldId });
        if (error) throw new Error(explain(error, 'admin_draft_context'));
        return (data as DraftContext | null) ?? null;
      },
      async startDraft(worldId, userId, payload) {
        const { data, error } = await admin.rpc('admin_start_draft', { p_world: worldId, p_user: userId, p_payload: payload });
        return { data, error: error ? { message: error.hint ? error.message : explain(error, 'admin_start_draft'), hint: error.hint } : null };
      },
    });
  } catch (err) {
    console.error('start-draft fehlgeschlagen', err);
    return json(500, { error: 'internal_error', message: `Der Draft konnte nicht gestartet werden: ${(err as Error).message}` });
  }
};

export const config = { path: '/api/start-draft' };
