import type { AuthError } from '@supabase/supabase-js';
import { requireSupabase } from './supabase';

/**
 * E-Mail-Login und Kontensicherung – ausschließlich über Supabase Auth.
 * Passwörter gehen nur an Supabase Auth und landen nie in eigenen Tabellen.
 * Die Umstellung eines anonymen Accounts behält dieselbe auth.users.id (updateUser), es entsteht kein zweiter Account.
 */
export interface AccountStatus {
  user_id: string;
  is_anonymous: boolean;
  email: string | null;
  email_confirmed: boolean;
  pending_email: string | null;
  has_password: boolean;
  has_profile: boolean;
  username: string | null;
  prompt_dismissed: boolean;
  worlds: number;
  clubs: number;
}

export const PASSWORD_MIN = 8;

/** Rücksprungadresse für Links aus E-Mails (muss in Supabase unter „Redirect URLs“ erlaubt sein) */
export const redirectTo = (path = '/') => `${window.location.origin}${path}`;

export async function fetchAccountStatus(): Promise<AccountStatus | null> {
  const { data, error } = await requireSupabase().rpc('account_status');
  if (error) throw new Error(error.message);
  return (data as AccountStatus | null) ?? null;
}

export async function dismissAccountPrompt(): Promise<void> {
  const { error } = await requireSupabase().rpc('dismiss_account_prompt');
  if (error) throw new Error(error.message);
}

export async function usernameAvailable(name: string): Promise<boolean> {
  const { data, error } = await requireSupabase().rpc('username_available', { p_username: name });
  if (error) throw new Error(error.message);
  return data === true;
}

export function passwordProblem(pw: string, repeat?: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Das Passwort braucht mindestens ${PASSWORD_MIN} Zeichen.`;
  if (!/[A-Za-zÄÖÜäöüß]/.test(pw) || !/\d/.test(pw)) return 'Das Passwort braucht mindestens einen Buchstaben und eine Ziffer.';
  if (repeat !== undefined && pw !== repeat) return 'Die Passwörter stimmen nicht überein.';
  return null;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

/** Fehler von Supabase Auth verständlich auf Deutsch (ohne preiszugeben, ob eine Adresse registriert ist) */
export function authMessage(err: unknown): string {
  const e = err as Partial<AuthError> & { message?: string };
  const code = e?.code ?? '';
  const msg = e?.message ?? '';
  if (code === 'email_exists' || code === 'user_already_exists' || /already (been )?registered/i.test(msg))
    return 'Diese E-Mail-Adresse gehört bereits zu einem anderen Account. Dein aktueller Account bleibt unverändert – verwende eine andere Adresse oder melde dich mit jenem Account an.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'E-Mail-Adresse oder Passwort ist falsch.';
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg)) return 'Deine E-Mail-Adresse ist noch nicht bestätigt. Öffne den Link in der Bestätigungsmail.';
  if (code === 'weak_password' || /password should/i.test(msg)) return 'Das Passwort ist zu schwach. Bitte wähle ein längeres Passwort mit Buchstaben und Ziffern.';
  if (code === 'same_password') return 'Das neue Passwort muss sich vom bisherigen unterscheiden.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || /rate limit|security purposes/i.test(msg))
    return 'Zu viele Versuche. Bitte warte einen Moment und versuche es dann erneut.';
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return 'Diese E-Mail-Adresse ist ungültig.';
  if (code === 'signup_disabled') return 'Registrierungen sind derzeit deaktiviert.';
  if (code === 'reauthentication_needed') return 'Zur Sicherheit bitte den Code aus der E-Mail eingeben.';
  if (code === 'otp_expired' || /expired/i.test(msg)) return 'Der Link bzw. Code ist abgelaufen. Bitte fordere einen neuen an.';
  if (/fetch|network/i.test(msg)) return 'Keine Verbindung. Bitte prüfe deine Internetverbindung.';
  return msg || 'Unbekannter Fehler';
}

export const auth = {
  signIn: (email: string, password: string) => requireSupabase().auth.signInWithPassword({ email: email.trim(), password }),
  signUp: (email: string, password: string, managerName: string) =>
    requireSupabase().auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo('/'), data: { manager_name: managerName.trim() } } }),
  resendSignup: (email: string) => requireSupabase().auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: redirectTo('/') } }),
  forgot: (email: string) => requireSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo('/passwort-neu') }),
  magicLink: (email: string) => requireSupabase().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: redirectTo('/') } }),
  /** Umstellung Schritt 1: E-Mail an den BESTEHENDEN Benutzer hängen (gleiche ID, Sitzung bleibt bestehen) */
  linkEmail: (email: string) => requireSupabase().auth.updateUser({ email: email.trim() }, { emailRedirectTo: redirectTo('/konto') }),
  /** Umstellung Schritt 2 bzw. Passwort ändern/zurücksetzen */
  setPassword: (password: string, nonce?: string) => requireSupabase().auth.updateUser(nonce ? { password, nonce } : { password }),
  reauthenticate: () => requireSupabase().auth.reauthenticate(),
};
