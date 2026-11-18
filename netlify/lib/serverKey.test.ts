import { describe, expect, it } from 'vitest';
import { checkServiceKey, projectRefFromUrl } from './serverKey';

const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const URL = 'https://abcdefgh.supabase.co';

describe('Prüfung des Server-Schlüssels', () => {
  it('liest die Projekt-Referenz aus der URL', () => {
    expect(projectRefFromUrl(URL)).toBe('abcdefgh');
  });
  it('akzeptiert service_role des gleichen Projekts und Secret-Keys', () => {
    expect(checkServiceKey(URL, jwt({ role: 'service_role', ref: 'abcdefgh' }))).toBeNull();
    expect(checkServiceKey(URL, 'sb_secret_abc123')).toBeNull();
  });
  it('erkennt typische Verwechslungen', () => {
    expect(checkServiceKey(URL, jwt({ role: 'anon', ref: 'abcdefgh' }))).toContain('anon-Schlüssel');
    expect(checkServiceKey(URL, 'sb_publishable_xyz')).toContain('Publishable');
    expect(checkServiceKey(URL, jwt({ role: 'service_role', ref: 'zzzzzzzz' }))).toContain('anderen Supabase-Projekt');
    expect(checkServiceKey(URL, 'eyJabc def')).toContain('Leerzeichen');
    expect(checkServiceKey(URL, 'irgendwas')).toContain('unbekanntes Format');
  });
});
