import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchMyProfile, type Profile } from './api';
import { requireSupabase } from './supabase';

/**
 * A2: Anonyme Supabase-Anmeldung als einfacher Einstieg.
 * Die anonyme Sitzung ist ein dauerhafter, eindeutiger Supabase-Benutzer.
 * Zur Wiederherstellung auf anderen Geräten kann später eine E-Mail-Adresse
 * mit demselben Benutzer verknüpft werden (siehe Account-Seite) – ohne
 * ungeschützt gespeicherten Wiederherstellungscode.
 */
interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  isAnonymous: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const loadProfile = useCallback(async (s: Session | null) => {
    setProfile(s ? await fetchMyProfile(s.user.id) : null);
  }, []);

  useEffect(() => {
    const sb = requireSupabase();
    let active = true;
    sb.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      try {
        await loadProfile(data.session);
      } finally {
        if (active) setLoading(false);
      }
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      void loadProfile(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      session,
      profile,
      isAnonymous: session?.user.is_anonymous ?? false,
      refreshProfile: () => loadProfile(session),
      signOut: async () => {
        await requireSupabase().auth.signOut();
        setProfile(null);
      },
    }),
    [loading, session, profile, loadProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth außerhalb von AuthProvider');
  return ctx;
}
