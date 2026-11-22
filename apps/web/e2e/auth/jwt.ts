/** NUR FÜR TESTS: HS256-JWTs für den lokalen Supabase-Ersatz */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = 'fd-e2e-jwt-secret-nur-fuer-tests';
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function sign(claims: Record<string, unknown>): string {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(claims));
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
export function verify(token: string): Record<string, unknown> | null {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const exp = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (exp.length !== s.length || !timingSafeEqual(Buffer.from(exp), Buffer.from(s))) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  if (typeof c.exp === 'number' && c.exp * 1000 < Date.now()) return null;
  return c;
}
export const ANON_KEY = sign({ role: 'anon', iss: 'supabase-e2e', exp: 4102444800 });
