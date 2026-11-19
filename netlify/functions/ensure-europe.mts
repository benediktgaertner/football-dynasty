import { createClient } from '@supabase/supabase-js';
import { handleEnsureEurope, type EuropeStatus } from '../lib/ensureEurope.js';
import { checkServiceKey } from '../lib/serverKey.js';
import { json } from '../lib/startDraft.js';

/**
 * POST /api/ensure-europe  { worldId }  (Authorization: Bearer <Supabase-Access-Token>)
 * Legt fehlende ausländische Ligen (Vereine + Kader) einer Welt an – schrittweise, idempotent.
 * Benötigt dieselben Netlify-Variablen wie /api/start-draft (SUPABASE_SERVICE_ROLE_KEY, nur serverseitig).
 */
export default async (req: Request): Promise<Response> => {
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL)?.trim().replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/^["']|["']$/g, '').trim();
  if (!url || !serviceKey) return json(500, { error: 'server_not_configured', message: 'Auf Netlify fehlt SUPABASE_SERVICE_ROLE_KEY.' });
  const keyProblem = checkServiceKey(url, serviceKey);
  if (keyProblem) return json(500, { error: 'server_key_invalid', message: keyProblem });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const missing = (msg: string) => (/could not find the function|PGRST202/i.test(msg) ? 'Datenbank-Update fehlt: bitte die SQL-Datei für den europäischen Transfermarkt in Supabase ausführen. ' : '') + msg;

  try {
    return await handleEnsureEurope(req, {
      async getUserId(token) {
        const { data, error } = await admin.auth.getUser(token);
        if (!error && data.user) return { userId: data.user.id };
        if (error && /api ?key/i.test(error.message)) return { reason: 'server_key', detail: error.message };
        return { reason: 'invalid_token' };
      },
      async isMember(worldId, userId) {
        const { data, error } = await admin.rpc('admin_world_member', { p_world: worldId, p_user: userId });
        if (error) throw new Error(missing(error.message));
        return data === true;
      },
      async status(worldId) {
        const { data, error } = await admin.rpc('admin_europe_status', { p_world: worldId });
        if (error) throw new Error(missing(error.message));
        return (data as EuropeStatus | null) ?? null;
      },
      async add(worldId, payload) {
        const { error } = await admin.rpc('admin_add_europe', { p_world: worldId, p_payload: payload });
        return { error: error ? missing(error.message) : null };
      },
    });
  } catch (err) {
    console.error('ensure-europe fehlgeschlagen', err);
    return json(500, { error: 'internal_error', message: (err as Error).message });
  }
};

export const config = { path: '/api/ensure-europe' };
