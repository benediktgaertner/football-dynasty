import { usernameSchema } from '@fd/shared';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { requireSupabase } from '../lib/supabase';
import { Button, Card, ErrorBanner, Field, Shell, TextInput } from '../components/ui';

/** B2.1: Benutzername eingeben bzw. bestehende Sitzung wiederherstellen. */
export function Welcome() {
  const { session, refreshProfile } = useAuth();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'restore'>('new');
  const [email, setEmail] = useState('');
  const [mailSent, setMailSent] = useState(false);

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Ungültiger Benutzername');
      return;
    }
    setBusy(true);
    try {
      const sb = requireSupabase();
      if (!session) {
        const { error: authError } = await sb.auth.signInAnonymously();
        if (authError) throw new ApiError(authError.message, authError.code ?? null);
      }
      await api.setUsername(parsed.data);
      await refreshProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Anmeldung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  async function restore(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { error: otpError } = await requireSupabase().auth.signInWithOtp({
        email: email.trim(),
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
      });
      if (otpError) throw otpError;
      setMailSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Versand fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto grid max-w-5xl items-center gap-8 md:grid-cols-[1.1fr_1fr]">
        <section className="animate-rise">
          <p className="display mb-2 text-lg font-semibold uppercase tracking-[0.2em] text-gold">Saison 1 · 2. Bundesliga</p>
          <h1 className="display text-6xl font-extrabold uppercase leading-[0.95] sm:text-7xl">
            Gründe deinen Verein.
            <br />
            <span className="text-pitch-light">Schreib Geschichte.</span>
          </h1>
          <p className="mt-5 max-w-md text-lg text-cream-dim">
            Ein gemeinsamer Fußballmanager für dich und deine Freunde: eigener Verein, Snake-Draft, Taktik und eine live
            simulierte Partie, die alle gleichzeitig sehen.
          </p>
        </section>

        <Card className="animate-rise">
          {mode === 'new' ? (
            <form onSubmit={start} className="space-y-5">
              <h2 className="display text-3xl font-bold uppercase">{session ? 'Benutzername wählen' : 'Loslegen'}</h2>
              <Field label="Benutzername" hint="3–20 Zeichen. Er ist für deine Mitspieler sichtbar.">
                <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="nickname" maxLength={20} placeholder="z. B. Trainerfuchs" />
              </Field>
              <ErrorBanner error={error} />
              <Button type="submit" busy={busy} className="w-full">
                Anpfiff
              </Button>
              <p className="text-sm text-cream-dim/80">
                Kein Passwort nötig. Du kannst dein Konto später per E-Mail sichern, um es auf anderen Geräten zu nutzen.
              </p>
              {!session && (
                <button type="button" className="text-sm text-gold underline-offset-4 hover:underline" onClick={() => { setMode('restore'); setError(null); }}>
                  Ich habe bereits ein gesichertes Konto
                </button>
              )}
            </form>
          ) : (
            <form onSubmit={restore} className="space-y-5">
              <h2 className="display text-3xl font-bold uppercase">Konto wiederherstellen</h2>
              {mailSent ? (
                <p className="text-cream-dim">Wir haben dir einen Anmeldelink geschickt. Öffne ihn auf diesem Gerät.</p>
              ) : (
                <>
                  <Field label="E-Mail-Adresse deines gesicherten Kontos">
                    <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
                  </Field>
                  <ErrorBanner error={error} />
                  <Button type="submit" busy={busy} className="w-full">
                    Anmeldelink senden
                  </Button>
                </>
              )}
              <button type="button" className="text-sm text-gold underline-offset-4 hover:underline" onClick={() => { setMode('new'); setError(null); setMailSent(false); }}>
                Zurück
              </button>
            </form>
          )}
        </Card>
      </div>
    </Shell>
  );
}
