import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { SecureAccount, secureStep } from '../components/SecureAccount';
import { auth, authMessage, passwordProblem, PASSWORD_MIN } from '../lib/account';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorBanner, Field, Pill, Shell, TextInput } from '../components/ui';

/**
 * Konto: Status, Sicherung (E-Mail → Bestätigung → Passwort, gleicher Benutzer), Passwort ändern, Abmelden.
 * Die E-Mail-Adresse sieht nur der Manager selbst.
 */
export function Account() {
  const { profile, account, signOut } = useAuth();
  const navigate = useNavigate();
  const secured = secureStep(account) === 'done';
  const [justSecured, setJustSecured] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    const p = passwordProblem(pw, pw2);
    if (p) { setError(p); return; }
    setBusy(true); setError(null); setOk(false);
    try {
      const { error: err } = await auth.setPassword(pw);
      if (err) throw err;
      setOk(true); setPw(''); setPw2('');
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell right={<Link to="/" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream">Übersicht</Link>}>
      <div className="mx-auto max-w-xl space-y-6">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h1 className="display text-4xl font-extrabold uppercase">{profile?.username}</h1>
            <Pill tone={secured ? 'good' : 'warn'}>{secured ? 'Gesichert' : 'Nicht gesichert'}</Pill>
          </div>
          <p className="mt-2 text-cream-dim" data-testid="account-email">
            {account?.email ? <>Anmeldung mit {account.email} <span className="text-cream-dim/60">(nur für dich sichtbar)</span></> : 'Noch keine E-Mail-Adresse hinterlegt.'}
          </p>
          {account && <p className="mt-1 text-sm text-cream-dim/70">{account.worlds} Welt{account.worlds === 1 ? '' : 'en'} · {account.clubs} Verein{account.clubs === 1 ? '' : 'e'}</p>}
        </Card>

        {(!secured || justSecured) && (
          <Card>
            <h2 className="display mb-2 text-2xl font-bold uppercase">Account sichern</h2>
            <p className="mb-4 text-cream-dim">
              Dein Account ist bisher nur in diesem Browser gespeichert. Hinterlege E-Mail und Passwort, dann spielst du auf jedem Gerät mit demselben Verein weiter. Es wird kein neuer Account angelegt.
            </p>
            <SecureAccount onDone={() => setJustSecured(true)} />
          </Card>
        )}

        {secured && (
          <Card>
            <form onSubmit={changePassword} className="space-y-4">
              <h2 className="display text-2xl font-bold uppercase">Passwort ändern</h2>
              <Field label="Neues Passwort" hint={`Mindestens ${PASSWORD_MIN} Zeichen, Buchstaben und Ziffern.`}>
                <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
              </Field>
              <Field label="Wiederholen">
                <TextInput type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
              </Field>
              <ErrorBanner error={error} />
              {ok && <p className="text-pitch-light">Passwort geändert.</p>}
              <Button type="submit" busy={busy} variant="secondary">Speichern</Button>
            </form>
          </Card>
        )}

        <Card>
          <Button
            variant="danger"
            data-testid="logout"
            onClick={() => {
              if (!secured && !window.confirm('Dein Account ist nicht gesichert. Nach dem Abmelden kommst du nicht mehr an deine Vereine. Trotzdem abmelden?')) return;
              void signOut().then(() => navigate('/'));
            }}
          >
            Abmelden
          </Button>
          {!secured && <p className="mt-2 text-sm text-cream-dim/70">Tipp: Sichere zuerst deinen Account, bevor du dich abmeldest oder mit einem anderen Account anmeldest.</p>}
        </Card>
      </div>
    </Shell>
  );
}
