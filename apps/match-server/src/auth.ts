import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A2/F12: Jede Verbindung zum Match-Server weist sich mit dem Supabase-Access-Token aus.
 * Der Server prüft es bei Supabase Auth (funktioniert mit symmetrischen und asymmetrischen
 * Signaturschlüsseln) und leitet daraus die Benutzer-ID ab. Welcher Verein gesteuert
 * werden darf, ergibt sich anschließend aus clubs.manager_user_id – nie aus Client-Angaben.
 */
export interface VerifiedUser {
  userId: string;
  isAnonymous: boolean;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

export async function verifyAccessToken(admin: SupabaseClient, token: string): Promise<VerifiedUser | null> {
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id, isAnonymous: data.user.is_anonymous ?? false };
}

/** Liefert den Verein, den dieser Benutzer in der Welt steuern darf (oder null). */
export async function controlledClub(admin: SupabaseClient, worldId: string, userId: string): Promise<string | null> {
  const { data, error } = await admin
    .from('clubs')
    .select('id')
    .eq('world_id', worldId)
    .eq('manager_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}
