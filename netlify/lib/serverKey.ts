/**
 * Prüft den Server-Schlüssel, bevor er verwendet wird, und liefert eine verständliche
 * Fehlermeldung statt eines allgemeinen Auth-Fehlers.
 */
export function projectRefFromUrl(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.(co|in)\/?$/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Gibt null zurück, wenn der Schlüssel plausibel ist, sonst eine deutsche Fehlermeldung. */
export function checkServiceKey(url: string, key: string): string | null {
  if (/\s/.test(key)) return 'SUPABASE_SERVICE_ROLE_KEY enthält Leerzeichen oder Zeilenumbrüche. Bitte den Wert ohne Leerzeichen neu einfügen.';
  if (key.startsWith('sb_publishable_')) {
    return 'In SUPABASE_SERVICE_ROLE_KEY steht der öffentliche Publishable-Key. Benötigt wird der Secret-Key (sb_secret_…) oder der Legacy-Schlüssel „service_role“.';
  }
  if (key.startsWith('sb_secret_')) return null;
  if (key.startsWith('eyJ')) {
    const payload = decodeJwtPayload(key);
    if (!payload) return 'SUPABASE_SERVICE_ROLE_KEY ist kein gültiger Schlüssel (unvollständig kopiert?).';
    if (payload.role === 'anon') {
      return 'In SUPABASE_SERVICE_ROLE_KEY steht der anon-Schlüssel. Benötigt wird der Schlüssel „service_role“ (bzw. der Secret-Key).';
    }
    if (payload.role !== 'service_role') return 'SUPABASE_SERVICE_ROLE_KEY ist kein service_role-Schlüssel.';
    const ref = projectRefFromUrl(url);
    if (ref && typeof payload.ref === 'string' && payload.ref.toLowerCase() !== ref) {
      return `SUPABASE_SERVICE_ROLE_KEY gehört zu einem anderen Supabase-Projekt (${payload.ref}) als die URL (${ref}).`;
    }
    return null;
  }
  return 'SUPABASE_SERVICE_ROLE_KEY hat ein unbekanntes Format. Erwartet wird sb_secret_… oder ein service_role-Schlüssel (eyJ…).';
}
