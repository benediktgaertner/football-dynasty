/**
 * NUR FÜR TESTS: lokaler Ersatz für Supabase Auth (GoTrue) + PostgREST, damit die Login-Abläufe der App
 * ohne Produktivprojekt und ohne echten Mailversand Ende-zu-Ende getestet werden können.
 *
 * - Auth-Endpunkte bilden die GoTrue-REST-API nach, die supabase-js aufruft (signup, token, user, verify,
 *   recover, otp, resend, logout, reauthenticate) – einschließlich der Supabase-Semantik für die Umstellung
 *   anonymer Benutzer: updateUser({email}) merkt die Adresse vor (email_change), der Bestätigungslink setzt
 *   sie, die Benutzer-ID bleibt gleich; danach updateUser({password}).
 * - Benutzer liegen in der echten (lokalen) Tabelle auth.users; RPCs und Tabellenabfragen laufen gegen die
 *   echten Migrationen mit Rolle anon/authenticated und RLS (wie PostgREST).
 * - E-Mails werden nicht versendet, sondern unter /__test/mail abrufbar gemacht.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pg from 'pg';

const PORT = Number(process.env.MOCK_PORT ?? 8793);
const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.AUTH_PG_PORT ?? 54361), user: 'postgres', database: 'postgres', max: 8 });

import { ANON_KEY, sign, verify } from './jwt';
export { ANON_KEY };

// ------------------------------------------------------------------ Datenhaltung
interface Row {
  id: string; email: string | null; email_change: string | null; email_confirmed_at: string | null; encrypted_password: string | null;
  is_anonymous: boolean; raw_user_meta_data: Record<string, unknown> | null; created_at: string; last_sign_in_at: string | null;
}
const refresh = new Map<string, { user: string; used: boolean }>();
const tokens = new Map<string, { user: string; type: string; email: string; used: boolean; exp: number }>();
const mails: Array<{ to: string; type: string; link: string; at: number; token?: string }> = [];

const hashPw = (pw: string) => { const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw: string, h: string | null) => {
  if (!h?.startsWith('scrypt$')) return false;
  const [, salt, hash] = h.split('$');
  return timingSafeEqual(scryptSync(pw, Buffer.from(salt!, 'hex'), 32), Buffer.from(hash!, 'hex'));
};
async function q<T = Row>(sql: string, args: unknown[] = []) { return (await pool.query(sql, args)).rows as T[]; }
const byId = async (id: string) => (await q('select * from auth.users where id = $1', [id]))[0] ?? null;
const byEmail = async (e: string) => (await q('select * from auth.users where lower(email) = lower($1)', [e]))[0] ?? null;

function userJson(u: Row) {
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email ?? '', phone: '',
    email_confirmed_at: u.email_confirmed_at ?? undefined, confirmed_at: u.email_confirmed_at ?? undefined,
    new_email: u.email_change || undefined,
    app_metadata: u.is_anonymous ? {} : { provider: 'email', providers: ['email'] },
    user_metadata: u.raw_user_meta_data ?? {},
    identities: u.email ? [{ id: u.id, user_id: u.id, identity_id: u.id, provider: 'email', identity_data: { email: u.email, sub: u.id }, created_at: u.created_at }] : [],
    created_at: u.created_at, updated_at: new Date().toISOString(), is_anonymous: u.is_anonymous,
  };
}
async function session(u: Row) {
  const now = Math.floor(Date.now() / 1000);
  const rt = randomBytes(18).toString('hex');
  refresh.set(rt, { user: u.id, used: false });
  await q('update auth.users set last_sign_in_at = now() where id = $1', [u.id]);
  return {
    access_token: sign({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email ?? '', is_anonymous: u.is_anonymous, iat: now, exp: now + 3600, session_id: randomUUID() }),
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: rt, user: userJson(u),
  };
}
function mail(to: string, type: string, user: string, redirect: string) {
  const token = randomBytes(12).toString('hex');
  tokens.set(token, { user, type, email: to, used: false, exp: Date.now() + 3600_000 });
  const link = `http://127.0.0.1:${PORT}/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent(redirect)}`;
  mails.push({ to: to.toLowerCase(), type, link, at: Date.now(), token });
}

// ------------------------------------------------------------------ HTTP-Helfer
function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const fail = (res: ServerResponse, status: number, code: string, msg: string) => send(res, status, { code: status, error_code: code, msg, message: msg });
async function body(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
function claimsOf(req: IncomingMessage) {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
  return t ? verify(t) : null;
}
const PW_OK = (pw: unknown) => typeof pw === 'string' && pw.length >= 8;

// ------------------------------------------------------------------ Auth (GoTrue)
async function auth(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.replace('/auth/v1', '');
  const redirect = url.searchParams.get('redirect_to') ?? 'http://127.0.0.1:5198/';
  if (path === '/signup' && req.method === 'POST') {
    const b = await body(req);
    if (!b.email) {
      // anonyme Anmeldung (bisheriger Einstieg – nur noch für Altaccounts/Tests)
      const u = (await q("insert into auth.users(id, is_anonymous, raw_user_meta_data) values ($1, true, $2) returning *", [randomUUID(), b.data ?? {}]))[0]!;
      return send(res, 200, await session(u));
    }
    if (!PW_OK(b.password)) return fail(res, 422, 'weak_password', 'Password should be at least 8 characters.');
    const ex = await byEmail(b.email);
    if (ex?.email_confirmed_at) {
      // wie Supabase: verschleierte Antwort, keine Auskunft über bestehende Adressen
      return send(res, 200, { ...userJson({ ...ex, id: randomUUID() }), identities: [] });
    }
    const u = ex ?? (await q('insert into auth.users(id, is_anonymous, email, encrypted_password, raw_user_meta_data) values ($1, false, $2, $3, $4) returning *',
      [randomUUID(), b.email.toLowerCase(), hashPw(b.password), b.data ?? {}]))[0]!;
    mail(b.email, 'signup', u.id, redirect);
    return send(res, 200, userJson(u));
  }
  if (path === '/token' && req.method === 'POST') {
    const b = await body(req);
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = await byEmail(b.email ?? '');
      if (!u || !checkPw(b.password ?? '', u.encrypted_password)) return fail(res, 400, 'invalid_credentials', 'Invalid login credentials');
      if (!u.email_confirmed_at) return fail(res, 400, 'email_not_confirmed', 'Email not confirmed');
      return send(res, 200, await session(u));
    }
    if (grant === 'refresh_token') {
      const r = refresh.get(b.refresh_token ?? '');
      if (!r || r.used) return fail(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
      r.used = true;
      const u = await byId(r.user);
      return u ? send(res, 200, await session(u)) : fail(res, 400, 'user_not_found', 'User not found');
    }
    return fail(res, 400, 'unsupported_grant_type', 'unsupported grant');
  }
  if (path === '/verify' && req.method === 'GET') {
    const t = tokens.get(url.searchParams.get('token') ?? '');
    const bad = (code: string, d: string) => { res.writeHead(303, { location: `${redirect}#error=access_denied&error_code=${code}&error_description=${encodeURIComponent(d)}` }); res.end(); };
    if (!t || t.used || t.exp < Date.now()) return bad('otp_expired', 'Email link is invalid or has expired');
    t.used = true;
    if (t.type === 'signup') await q('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [t.user]);
    if (t.type === 'email_change') {
      const clash = await byEmail(t.email);
      if (clash && clash.id !== t.user) return bad('email_exists', 'Email address already registered');
      await q("update auth.users set email = lower($2), email_change = '', email_confirmed_at = now(), is_anonymous = false where id = $1", [t.user, t.email]);
    }
    if (t.type === 'magiclink' || t.type === 'recovery') await q('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [t.user]);
    const s = await session((await byId(t.user))!);
    const hash = new URLSearchParams({ access_token: s.access_token, expires_at: String(s.expires_at), expires_in: '3600', refresh_token: s.refresh_token, token_type: 'bearer', type: t.type });
    res.writeHead(303, { location: `${redirect}#${hash}` });
    return res.end();
  }
  if (path === '/recover' && req.method === 'POST') {
    const b = await body(req);
    const u = await byEmail(b.email ?? '');
    if (u) mail(b.email, 'recovery', u.id, redirect);
    return send(res, 200, {});
  }
  if (path === '/otp' && req.method === 'POST') {
    const b = await body(req);
    const u = await byEmail(b.email ?? '');
    if (u) mail(b.email, 'magiclink', u.id, redirect);
    return send(res, 200, {});
  }
  if (path === '/resend' && req.method === 'POST') {
    const b = await body(req);
    const u = await byEmail(b.email ?? '');
    if (u && !u.email_confirmed_at) mail(b.email, 'signup', u.id, redirect);
    return send(res, 200, {});
  }
  // ab hier: angemeldet
  const c = claimsOf(req);
  if (!c?.sub) return fail(res, 401, 'no_authorization', 'This endpoint requires a Bearer token');
  const me = await byId(String(c.sub));
  if (!me) return fail(res, 403, 'user_not_found', 'User from sub claim in JWT does not exist');
  if (path === '/user' && req.method === 'GET') return send(res, 200, userJson(me));
  if (path === '/user' && req.method === 'PUT') {
    const b = await body(req);
    if (b.email) {
      const clash = await byEmail(b.email);
      if (clash && clash.id !== me.id) return fail(res, 422, 'email_exists', 'A user with this email address has already been registered');
      await q('update auth.users set email_change = lower($2) where id = $1', [me.id, b.email]);
      mail(b.email, 'email_change', me.id, redirect);
    }
    if (b.password !== undefined) {
      if (!PW_OK(b.password)) return fail(res, 422, 'weak_password', 'Password should be at least 8 characters.');
      if (!me.email_confirmed_at) return fail(res, 422, 'email_not_confirmed', 'Email not confirmed');
      await q('update auth.users set encrypted_password = $2 where id = $1', [me.id, hashPw(b.password)]);
    }
    return send(res, 200, userJson((await byId(me.id))!));
  }
  if (path === '/logout' && req.method === 'POST') {
    for (const [k, v] of refresh) if (v.user === me.id) v.used = true; // wie GoTrue: Sitzung widerrufen
    res.writeHead(204); return res.end();
  }
  if (path === '/reauthenticate') return send(res, 200, {});
  return fail(res, 404, 'not_found', `unbekannt: ${req.method} ${path}`);
}

// ------------------------------------------------------------------ REST (PostgREST-Ausschnitt)
const IDENT = /^[a-z_][a-z0-9_]*$/;
async function asRole<T>(claims: Record<string, unknown> | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${claims?.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims ?? {}), String(claims?.sub ?? '')]);
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
async function rest(req: IncomingMessage, res: ServerResponse, url: URL) {
  const claims = claimsOf(req);
  if (!claims) return send(res, 401, { message: 'JWT invalid' });
  const path = url.pathname.replace('/rest/v1/', '');
  try {
    if (path.startsWith('rpc/')) {
      const fn = path.slice(4);
      if (!IDENT.test(fn)) return send(res, 404, { message: 'not found' });
      const args = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
      const meta = (await q<{ retset: boolean; rettype: string; composite: boolean; names: string[] | null; types: string[] }>(
        `select p.proretset retset, format_type(p.prorettype, null) rettype, t.typtype = 'c' composite, p.proargnames names,
                array(select format_type(x, null) from unnest(p.proargtypes::oid[]) x) types
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_type t on t.oid = p.prorettype
         where n.nspname = 'public' and p.proname = $1 order by p.pronargs desc limit 1`, [fn]))[0];
      if (!meta) return send(res, 404, { code: 'PGRST202', message: `function ${fn} not found` });
      const vals: unknown[] = [];
      const parts = Object.entries(args).map(([k, v]) => {
        const i = (meta.names ?? []).indexOf(k);
        if (i < 0 || !IDENT.test(k)) throw Object.assign(new Error(`unknown arg ${k}`), { code: 'PGRST202' });
        const type = meta.types[i]!;
        vals.push(v === null ? null : /json/.test(type) ? JSON.stringify(v) : Array.isArray(v) ? `{${v.join(',')}}` : String(v));
        return `${k} => $${vals.length}::${type}`;
      });
      const call = `public.${fn}(${parts.join(', ')})`;
      const sql = meta.retset ? `select coalesce(json_agg(r), '[]'::json) v from ${call} r`
        : meta.composite ? `select row_to_json(r) v from ${call} r` : meta.rettype === 'void' ? `select ${call}, null::json v` : `select to_json(${call}) v`;
      const r = await asRole(claims, (c) => c.query(sql, vals));
      return send(res, 200, r.rows[0]?.v ?? null);
    }
    if (req.method === 'GET' && IDENT.test(path)) {
      const cols = (url.searchParams.get('select') ?? '*').split(',').map((s) => s.trim());
      if (!cols.every((c) => c === '*' || IDENT.test(c))) return send(res, 400, { message: 'select nicht unterstützt' });
      const where: string[] = []; const vals: unknown[] = [];
      for (const [k, v] of url.searchParams) {
        if (k === 'select' || k === 'limit' || k === 'order' || k === 'offset') continue;
        const m = /^eq\.(.*)$/.exec(v);
        if (!IDENT.test(k) || !m) return send(res, 400, { message: `Filter ${k}=${v} nicht unterstützt` });
        vals.push(m[1]); where.push(`${k}::text = $${vals.length}`);
      }
      const sql = `select coalesce(json_agg(t), '[]'::json) v from (select ${cols.join(', ')} from public.${path}${where.length ? ' where ' + where.join(' and ') : ''}) t`;
      const rows = ((await asRole(claims, (c) => c.query(sql, vals))).rows[0]?.v ?? []) as unknown[];
      if (/vnd\.pgrst\.object/.test(String(req.headers.accept))) {
        if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
        return send(res, 200, rows[0]);
      }
      return send(res, 200, rows);
    }
    return send(res, 404, { message: `nicht unterstützt: ${req.method} ${path}` });
  } catch (e) {
    const err = e as { code?: string; message: string; hint?: string; detail?: string };
    return send(res, err.code === '42501' ? 403 : 400, { code: err.code ?? 'P0001', message: err.message, hint: err.hint ?? null, details: err.detail ?? null });
  }
}

// ------------------------------------------------------------------ Testhilfen (/__test)
async function testApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.replace('/__test/', '');
  if (path === 'mail') {
    const to = (url.searchParams.get('to') ?? '').toLowerCase(), type = url.searchParams.get('type');
    return send(res, 200, mails.filter((m) => m.to === to && (!type || m.type === type)).sort((a, b) => b.at - a.at));
  }
  if (path === 'expire') { // alle offenen Links einer Adresse ungültig machen (Fehlerfall testen)
    const to = (url.searchParams.get('to') ?? '').toLowerCase();
    for (const m of mails) if (m.to === to && m.token) tokens.get(m.token)!.exp = 0;
    return send(res, 200, {});
  }
  if (path === 'legacy' && req.method === 'POST') {
    // bestehender anonymer Manager mit Profil, Welt (neu oder per Einladungscode) und Verein – wie heute in Produktion
    const b = await body(req) as { username: string; world?: string; code?: string; club: string; short: string };
    // Profil entstand vor 0036 (damals durfte ein anonymer Benutzer es anlegen): erst anlegen, dann als anonym markieren
    const u0 = (await q('insert into auth.users(id, is_anonymous) values ($1, false) returning *', [randomUUID()]))[0]!;
    const claims = { sub: u0.id, role: 'authenticated' };
    const r = await asRole(claims, async (c) => {
      await c.query('select public.set_username($1::text)', [b.username]);
      let world: string;
      if (b.code) world = (await c.query('select public.join_world($1::text) r', [b.code])).rows[0].r.world_id;
      else world = (await c.query("select public.create_world($1::text) r", [b.world])).rows[0].r.world_id;
      const club = (await c.query('select public.upsert_my_club($1, tests.club_payload($2::text, $3::text)) id', [world, b.club, b.short])).rows[0].id;
      const code = (await c.query('select invite_code from public.career_worlds where id = $1', [world])).rows[0].invite_code;
      return { world, club, code };
    });
    const u = (await q('update auth.users set is_anonymous = true where id = $1 returning *', [u0.id]))[0]!;
    const s = await session(u);
    return send(res, 200, { session: s, user_id: u.id, ...r });
  }
  if (path === 'state') {
    const id = url.searchParams.get('user')!;
    const r = await q<any>(`select u.id, u.is_anonymous, u.email, u.email_change, coalesce(u.encrypted_password, '') <> '' has_password,
      p.username, (select count(*)::int from public.clubs c where c.manager_user_id = u.id) clubs,
      (select count(*)::int from public.world_members m where m.user_id = u.id) worlds,
      (select json_agg(c.name order by c.name) from public.clubs c where c.manager_user_id = u.id) club_names,
      (select count(*)::int from auth.users) users_total
      from auth.users u left join public.profiles p on p.id = u.id where u.id = $1`, [id]);
    return send(res, 200, r[0] ?? null);
  }
  if (path === 'user-by-email') return send(res, 200, (await byEmail(url.searchParams.get('email') ?? ''))?.id ?? null);
  return send(res, 404, {});
}

createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-expose-headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const h = url.pathname.startsWith('/auth/v1') ? auth : url.pathname.startsWith('/rest/v1') ? rest : url.pathname.startsWith('/__test/') ? testApi : null;
  if (!h) return send(res, 404, { message: 'not found' });
  h(req, res, url).catch((e) => { console.error(e); send(res, 500, { message: String(e) }); });
}).listen(PORT, '127.0.0.1', () => console.log(`Supabase-Testersatz auf http://127.0.0.1:${PORT}`));
