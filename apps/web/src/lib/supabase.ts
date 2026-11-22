import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * O4: Zugangsdaten kommen ausschließlich aus Umgebungsvariablen.
 * Im Frontend wird nur der öffentliche Anon-/Publishable-Key verwendet – niemals der Service-Role-Key (A3).
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const missingEnv: string[] = [
  ...(url ? [] : ['VITE_SUPABASE_URL']),
  ...(anonKey ? [] : ['VITE_SUPABASE_ANON_KEY']),
];

if (anonKey && /service_role/.test(atobSafe(anonKey.split('.')[1] ?? ''))) {
  // Schutz gegen versehentlich eingetragenen Service-Role-Schlüssel
  throw new Error('VITE_SUPABASE_ANON_KEY enthält einen Service-Role-Schlüssel. Dieser darf niemals ins Frontend.');
}

export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        // implicit: Links aus E-Mails (Bestätigung, Passwort vergessen) funktionieren auch auf einem anderen Gerät
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      })
    : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('Supabase ist nicht konfiguriert.');
  return supabase;
}

function atobSafe(s: string): string {
  try {
    return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return '';
  }
}
