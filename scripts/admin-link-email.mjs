#!/usr/bin/env node
/**
 * NUR FÜR DEN BETREIBER, NUR LOKAL: Notfall-Wiederherstellung eines anonymen Accounts, dessen Browserdaten
 * verloren sind (z. B. Gerät zurückgesetzt), bevor der Manager ihn gesichert hat.
 *
 * Hängt eine E-Mail-Adresse an den BESTEHENDEN Benutzer (gleiche auth.users.id – Vereine, Welten, Finanzen
 * bleiben). Danach setzt der Manager über „Passwort vergessen“ selbst sein Passwort.
 *
 * Keine automatische Zuordnung: Der Betreiber muss die Identität des Managers vorher persönlich prüfen
 * (z. B. Mitspieler bestätigen Managername, Verein, Welt). Ohne --apply wird nur angezeigt.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<geheim, nur lokal> \
 *     node scripts/admin-link-email.mjs <user-id> <email> [--apply]
 *
 * Den Service-Role-Key niemals ins Frontend, ins Repo oder in Chats kopieren; nach Gebrauch aus der Shell löschen.
 * Die Benutzer-ID findest du im Supabase-Dashboard (Authentication → Users) oder per SQL:
 *   select p.id, p.username from public.profiles p where p.username ilike '%name%';
 */
import { createClient } from '@supabase/supabase-js';

const [id, email] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!id || !email || !url || !key) {
  console.error('Aufruf: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/admin-link-email.mjs <user-id> <email> [--apply]');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: got, error: e1 } = await sb.auth.admin.getUserById(id);
if (e1 || !got.user) { console.error('Benutzer nicht gefunden:', e1?.message); process.exit(1); }
const u = got.user;
const { data: prof } = await sb.from('profiles').select('username').eq('id', id).maybeSingle();
const { data: clubs } = await sb.from('clubs').select('name, world_id').eq('manager_user_id', id);
console.log({ id: u.id, anonym: u.is_anonymous, email: u.email || null, managername: prof?.username ?? null, vereine: clubs?.map((c) => c.name) ?? [] });
if (u.email) { console.error('Dieser Benutzer hat bereits eine E-Mail-Adresse – Abbruch (nichts geändert).'); process.exit(1); }
if (!apply) { console.log(`\nTrockenlauf. Zum Ausführen: … ${id} ${email} --apply`); process.exit(0); }

const { data: upd, error: e2 } = await sb.auth.admin.updateUserById(id, { email, email_confirm: true });
if (e2) {
  console.error(/already|exists/i.test(e2.message) ? 'Diese E-Mail-Adresse gehört bereits einem anderen Account – nichts geändert.' : `Fehler: ${e2.message} – nichts geändert.`);
  process.exit(1);
}
console.log({ id: upd.user.id, email: upd.user.email, anonym: upd.user.is_anonymous });
console.log('\nFertig. Der Manager öffnet die App → „Passwort vergessen“ → Link aus der Mail → eigenes Passwort festlegen.');
