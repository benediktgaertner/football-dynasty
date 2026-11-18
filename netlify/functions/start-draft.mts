import { createClient } from '@supabase/supabase-js';
import { checkServiceKey } from '../lib/serverKey.js';
import { handleStartDraft, json } from '../lib/startDraft.js';

/**
 * POST /api/start-draft  { worldId }  (Authorization: Bearer <Supabase-Access-Token>)
 *
 * Benötigte Netlify-Umgebungsvariablen (nur serverseitig, Scope „Functions“):
 *   SUPABASE_SERVICE_ROLE_KEY   Service-Role-/Secret-Schlüssel – niemals mit VITE_-Präfix!
 *   SUPABASE_URL                optional; sonst wird VITE_SUPABASE_URL verwendet
 */
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
        // Unterscheiden: Liegt es am Server-Schlüssel oder am Login-Token?
        const probe = await admin.from('associations').select('code').limit(1);
        if (probe.error) return { reason: 'server_key', detail: probe.error.message };
        console.warn('Token abgelehnt:', error?.message);
        return { reason: 'invalid_token' };
      },
      async loadWorld(worldId) {
        const { data } = await admin.from('career_worlds').select('id, seed, status, host_user_id').eq('id', worldId).maybeSingle();
        return data;
      },
      async loadHumanClubs(worldId) {
        const { data, error } = await admin.from('clubs').select('id, name, short_name').eq('world_id', worldId).eq('control', 'human').order('created_at');
        if (error) throw error;
        return data ?? [];
      },
      async startDraft(worldId, userId, payload) {
        const { data, error } = await admin.rpc('admin_start_draft', { p_world: worldId, p_user: userId, p_payload: payload });
        return { data, error: error ? { message: error.message, hint: error.hint } : null };
      },
    });
  } catch (err) {
    console.error('start-draft fehlgeschlagen', err);
    return json(500, { error: 'internal_error', message: 'Der Draft konnte nicht gestartet werden.' });
  }
};

export const config = { path: '/api/start-draft' };
