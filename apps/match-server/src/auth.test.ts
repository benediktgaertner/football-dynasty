import { describe, expect, it } from 'vitest';
import { bearerToken } from './auth.js';
import { loadConfig } from './config.js';

describe('bearerToken', () => {
  it('liest das Token aus dem Authorization-Header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   xyz')).toBe('xyz');
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
  });
});

describe('loadConfig', () => {
  it('verweigert den Start ohne Pflichtwerte', () => {
    expect(() => loadConfig({})).toThrow(/SUPABASE_URL/);
  });
  it('liest Port und erlaubte Origins', () => {
    const c = loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PORT: '8080', ALLOWED_ORIGINS: 'https://a.netlify.app, http://localhost:5173' });
    expect(c.port).toBe(8080);
    expect(c.allowedOrigins).toEqual(['https://a.netlify.app', 'http://localhost:5173']);
  });
});
