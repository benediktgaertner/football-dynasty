import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { requireSupabase } from '../lib/supabase';
import { Button, Card, ErrorBanner, Field, Pill, Shell, TextInput } from '../components/ui';

/**
 * A2: Konto sichern. Eine E-Mail-Adresse wird mit dem bestehenden (anonymen)
 * Supabase-Benutzer verknüpft. Supabase bestätigt die Adresse per Mail; danach kann
 * sich der Manager auf jedem Gerät per Anmeldelink einloggen – derselbe Benutzer,
 * derselbe Verein. Es gibt keinen ungeschützt gespeicherten Wiederherstellungscode.
 */
export function Account() {
  const { session, profile, isAnonymous, signOut } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function secure(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await requireSupabase().auth.updateUser({ email: email.trim() }, { emailRedirectTo: window.location.origin });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell right={<Link to="/" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Übersicht</Link>}>
      <div className="mx-auto max-w-xl space-y-6">
        <Card>
          <div className="flex items-center justify-between">
            <h1 className="display text-4xl font-extrabold uppercase">{profile?.username}</h1>
            <Pill tone={isAnonymous ? 'warn' : 'good'}>{isAnonymous ? 'Nicht gesichert' : 'Gesichert'}</Pill>
          </div>
          {!isAnonymous && <p className="mt-2 text-cream-dim">Verknüpft mit {session?.user.email}</p>}
        </Card>

        {isAnonymous && (
          <Card>
            {sent ? (
              <p className="text-cream-dim">
                Bestätigungsmail verschickt. Sobald du den Link öffnest, ist dein Konto gesichert und du kannst dich auf jedem Gerät per E-Mail anmelden.
              </p>
            ) : (
              <form onSubmit={secure} className="space-y-4">
                <h2 className="display text-2xl font-bold uppercase">Konto sichern</h2>
                <p className="text-cream-dim">
                  Dein Konto existiert gerade nur in diesem Browser. Verknüpfe eine E-Mail-Adresse, damit du deinen Verein nicht verlierst und ihn auch auf dem iPad oder Handy weiterführen kannst.
                </p>
                <Field label="E-Mail-Adresse">
                  <TextInput type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                </Field>
                <ErrorBanner error={error} />
                <Button type="submit" busy={busy}>
                  Bestätigungslink senden
                </Button>
              </form>
            )}
          </Card>
        )}

        <Card>
          <Button
            variant="danger"
            onClick={() => {
              if (isAnonymous && !window.confirm('Dein Konto ist nicht gesichert. Nach dem Abmelden kannst du es nicht wiederherstellen. Trotzdem abmelden?')) return;
              void signOut().then(() => navigate('/'));
            }}
          >
            Abmelden
          </Button>
        </Card>
      </div>
    </Shell>
  );
}
