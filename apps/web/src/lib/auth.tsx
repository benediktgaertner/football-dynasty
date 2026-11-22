import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fetchAccountStatus, type AccountStatus } from './account';
import { fetchMyProfile, type Profile } from './api';
import { requireSupabase } from './supabase';

/**
 * Anmeldung über Supabase Auth: E-Mail + Passwort (neu), bestehende anonyme Sitzungen laufen weiter,
 * bis der Manager seinen Account sichert (gleiche Benutzer-ID, siehe SecureAccount).
 * Welche Welten und Vereine geladen werden, hängt allein an der serverseitigen Benutzer-ID (auth.uid()),
 * nicht an lokalen Browserdaten – deshalb sieht man nach der Anmeldung auf jedem Gerät dieselbe Karriere.
 */
interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  /** Profil konnte nicht geladen werden (Netzwerk) – dann NICHT zur Anmeldung leiten (Sitzung bleibt) */
  profileError: string | null;
  account: AccountStatus | null;
  isAnonymous: boolean;
  /** über „Passwort vergessen“-Link angemeldet: neues Passwort setzen */
  recovery: boolean;
  endRecovery: () => void;
  refreshProfile: () => Promise<void>;
  refreshAccount: () => Promise<AccountStatus | null>;
  signOut: () => Promise<void>;
  /** Fehler aus einem E-Mail-Link (abgelaufen/ungültig) – die bisherige Sitzung bleibt bestehen */
  linkError: string | null;
  clearLinkError: () => void;
  /** ungesicherter Account dieses Geräts, der durch eine andere Anmeldung verdrängt wurde (Rettungsanker) */
  stranded: StrandedAccount | null;
  restoreStranded: () => Promise<void>;
  forgetStranded: () => void;
}

/**
 * Rettungsanker: Solange ein Account anonym ist, existiert er nur in diesem Browser. Wird die Sitzung durch
 * eine andere Anmeldung (z. B. fremder Anmeldelink) ersetzt, wäre er sonst unerreichbar. Deshalb merken wir uns
 * die Sitzung des ungesicherten Accounts lokal (nur das eigene Token, das ohnehin im Browser liegt) und bieten
 * die Rückkehr an. Nach dem Sichern bzw. bewusstem Abmelden wird der Eintrag gelöscht.
 */
export interface StrandedAccount { user_id: string; username: string | null; access_token: string; refresh_token: string; saved_at: number }
const STRANDED_KEY = 'fd-unsecured-session';
function readStranded(): StrandedAccount | null {
  try { return JSON.parse(localStorage.getItem(STRANDED_KEY) ?? 'null') as StrandedAccount | null; } catch { return null; }
}
function writeStranded(v: StrandedAccount | null) {
  try { if (v) localStorage.setItem(STRANDED_KEY, JSON.stringify(v)); else localStorage.removeItem(STRANDED_KEY); } catch { /* privat */ }
}

const AuthContext = createContext<AuthState | null>(null);

// vor der Auswertung des Links durch supabase-js festhalten (der Hash wird danach entfernt)
const initialRecovery = typeof window !== 'undefined' && (/type=recovery/.test(window.location.hash) || window.location.pathname === '/passwort-neu');
const initialLinkError = (() => {
  if (typeof window === 'undefined') return null;
  const h = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search.replace(/^\?/, ''));
  const code = h.get('error_code'), desc = h.get('error_description');
  if (!code && !desc) return null;
  return code === 'otp_expired' ? 'Der Link ist abgelaufen oder wurde bereits verwendet. Fordere bei Bedarf einen neuen an – dein Account ist unverändert.'
    : `Der Link konnte nicht verwendet werden (${desc ?? code}). Dein Account ist unverändert.`;
})();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [recovery, setRecovery] = useState(initialRecovery && !initialLinkError);
  const [linkError, setLinkError] = useState<string | null>(initialLinkError);
  const [stranded, setStranded] = useState<StrandedAccount | null>(() => readStranded());
  const userRef = useRef<string | null>(null);

  const loadAccount = useCallback(async (s: Session | null) => {
    if (!s) { setAccount(null); return null; }
    try {
      const a = await fetchAccountStatus();
      setAccount(a);
      if (a && a.is_anonymous && a.has_profile) {
        writeStranded({ user_id: a.user_id, username: a.username, access_token: s.access_token, refresh_token: s.refresh_token, saved_at: Date.now() });
      } else if (a && !a.is_anonymous && readStranded()?.user_id === a.user_id) {
        writeStranded(null); // gesichert: Rettungsanker nicht mehr nötig
      }
      setStranded(readStranded());
      // Account wurde (evtl. auf einem anderen Gerät) gesichert: Sitzung auffrischen, damit das Token stimmt
      if (a && !a.is_anonymous && s.user.is_anonymous) void requireSupabase().auth.refreshSession();
      return a;
    } catch { return null; }
  }, []);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); setProfileError(null); return; }
    try {
      setProfile(await fetchMyProfile(s.user.id));
      setProfileError(null);
    } catch (e) {
      setProfileError((e as Error).message || 'Verbindung fehlgeschlagen');
    }
  }, []);

  useEffect(() => {
    const sb = requireSupabase();
    let active = true;
    sb.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      userRef.current = data.session?.user.id ?? null;
      try {
        await Promise.all([loadProfile(data.session), loadAccount(data.session)]);
      } finally {
        if (active) setLoading(false);
      }
    });
    const { data: sub } = sb.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
      // aktuelle Tokens des ungesicherten Accounts mitführen (Refresh-Tokens rotieren)
      const st = readStranded();
      if (s && st && st.user_id === s.user.id && s.user.is_anonymous) writeStranded({ ...st, access_token: s.access_token, refresh_token: s.refresh_token, saved_at: Date.now() });
      // nur bei Benutzerwechsel bzw. Änderung am Benutzer neu laden (nicht bei jedem Token-Refresh)
      const changed = (s?.user.id ?? null) !== userRef.current;
      userRef.current = s?.user.id ?? null;
      if (changed || event === 'USER_UPDATED' || event === 'SIGNED_IN') {
        void loadProfile(s);
        void loadAccount(s);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile, loadAccount]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      profileError,
      account,
      isAnonymous: account ? account.is_anonymous : session?.user.is_anonymous ?? false,
      recovery,
      endRecovery: () => {
        setRecovery(false);
        if (window.location.pathname === '/passwort-neu') window.history.replaceState(null, '', '/');
      },
      refreshProfile: () => loadProfile(session),
      refreshAccount: () => loadAccount(session),
      signOut: async () => {
        // nur diese Sitzung beenden (andere Geräte bleiben angemeldet); bewusstes Abmelden ⇒ kein Rettungsanker
        if (readStranded()?.user_id === session?.user.id) writeStranded(null);
        setStranded(readStranded());
        await requireSupabase().auth.signOut({ scope: 'local' });
        setProfile(null);
        setAccount(null);
      },
      linkError,
      clearLinkError: () => setLinkError(null),
      stranded: stranded && stranded.user_id !== session?.user.id ? stranded : null,
      restoreStranded: async () => {
        const st = readStranded();
        if (!st) return;
        const { error } = await requireSupabase().auth.setSession({ access_token: st.access_token, refresh_token: st.refresh_token });
        if (error) { writeStranded(null); setStranded(null); throw new Error('Der ungesicherte Account konnte nicht wiederhergestellt werden (Sitzung abgelaufen).'); }
      },
      forgetStranded: () => { writeStranded(null); setStranded(null); },
    }),
    [loading, session, profile, profileError, account, recovery, linkError, stranded, loadProfile, loadAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth außerhalb von AuthProvider');
  return ctx;
}
