import { usernameSchema } from '@fd/shared';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { auth, authMessage, isEmail, passwordProblem, usernameAvailable, PASSWORD_MIN } from '../lib/account';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorBanner, Field, Shell, TextInput } from '../components/ui';

type Mode = 'login' | 'register' | 'forgot' | 'magic';

function Hero() {
  return (
    <section className="animate-rise">
      <p className="display mb-2 text-lg font-semibold uppercase tracking-[0.2em] text-gold">Saison 1 · 55 Länder · 3 Ligen</p>
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
  );
}

function Layout({ children }: { children: ReactNode }) {
  return (
    <Shell>
      <div className="mx-auto grid max-w-5xl items-center gap-8 md:grid-cols-[1.1fr_1fr]">
        <Hero />
        <Card className="animate-rise">{children}</Card>
      </div>
    </Shell>
  );
}

function PasswordInput(props: { value: string; onChange: (v: string) => void; autoComplete: string; testid: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <TextInput type={show ? 'text' : 'password'} value={props.value} onChange={(e) => props.onChange(e.target.value)} autoComplete={props.autoComplete}
        required minLength={PASSWORD_MIN} data-testid={props.testid} autoFocus={props.autoFocus} className="pr-20" />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-3 text-sm text-cream-dim hover:text-cream" aria-label={show ? 'Passwort verbergen' : 'Passwort anzeigen'}>
        {show ? 'Verbergen' : 'Anzeigen'}
      </button>
    </div>
  );
}

/** Anmelden · Registrieren · Passwort vergessen · Anmeldelink */
export function Welcome() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);

  const go = (m: Mode) => { setMode(m); setError(null); setSent(null); setUnconfirmed(false); };

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try { await fn(); } catch (e) { setError(authMessage(e)); } finally { setBusy(false); }
  }

  const login = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const { error: err } = await auth.signIn(email, password);
    if (err) { setUnconfirmed(err.code === 'email_not_confirmed'); throw err; }
  }); };

  const register = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const parsed = usernameSchema.safeParse(name);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Ungültiger Managername');
    if (!isEmail(email)) throw new Error('Bitte gib eine gültige E-Mail-Adresse ein.');
    const pw = passwordProblem(password, password2);
    if (pw) throw new Error(pw);
    if (!(await usernameAvailable(parsed.data))) throw new Error('Dieser Managername ist bereits vergeben.');
    const { error: err } = await auth.signUp(email, password, parsed.data);
    if (err) throw err;
    // Neutral formuliert: verrät nicht, ob die Adresse schon registriert ist
    setSent(`Fast geschafft! Wir haben eine Bestätigungsmail an ${email.trim()} geschickt. Öffne den Link darin – danach bist du angemeldet. Schon registriert? Dann melde dich einfach an oder setze dein Passwort zurück.`);
  }); };

  const forgot = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (!isEmail(email)) throw new Error('Bitte gib eine gültige E-Mail-Adresse ein.');
    const { error: err } = await auth.forgot(email);
    if (err) throw err;
    setSent(`Falls ein Account mit ${email.trim()} existiert, haben wir dir einen Link zum Zurücksetzen des Passworts geschickt.`);
  }); };

  const magic = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (!isEmail(email)) throw new Error('Bitte gib eine gültige E-Mail-Adresse ein.');
    const { error: err } = await auth.magicLink(email);
    if (err && err.code !== 'otp_disabled' && !/signups not allowed/i.test(err.message)) throw err;
    setSent(`Falls ein Account mit ${email.trim()} existiert, haben wir dir einen Anmeldelink geschickt. Du kannst ihn auf jedem Gerät öffnen.`);
  }); };

  const resend = () => void run(async () => {
    const { error: err } = await auth.resendSignup(email);
    if (err) throw err;
    setSent(`Neue Bestätigungsmail an ${email.trim()} verschickt.`);
  });

  const emailField = (
    <Field label="E-Mail-Adresse">
      <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" data-testid="auth-email" autoFocus={mode !== 'register'} />
    </Field>
  );

  return (
    <Layout>
      {(mode === 'login' || mode === 'register') && (
        <div className="mb-5 grid grid-cols-2 rounded-xl bg-anthracite p-1" role="tablist">
          {(['login', 'register'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => go(m)} data-testid={`tab-${m}`}
              className={`display min-h-10 rounded-lg text-lg font-semibold uppercase transition ${mode === m ? 'bg-olive-700 text-cream' : 'text-cream-dim hover:text-cream'}`}>
              {m === 'login' ? 'Anmelden' : 'Registrieren'}
            </button>
          ))}
        </div>
      )}

      {sent ? (
        <div className="space-y-5" data-testid="auth-sent">
          <h2 className="display text-3xl font-bold uppercase">Postfach prüfen</h2>
          <p className="text-cream-dim">{sent}</p>
          <p className="text-sm text-cream-dim/70">Keine Mail? Schau im Spam-Ordner nach oder versuche es in einer Minute erneut.</p>
          <Button variant="secondary" onClick={() => go('login')}>Zur Anmeldung</Button>
        </div>
      ) : mode === 'login' ? (
        <form onSubmit={login} className="space-y-5">
          {emailField}
          <Field label="Passwort">
            <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" testid="auth-password" />
          </Field>
          <ErrorBanner error={error} />
          {unconfirmed && <Button type="button" variant="secondary" onClick={resend} busy={busy}>Bestätigungsmail erneut senden</Button>}
          <Button type="submit" busy={busy} className="w-full" data-testid="auth-submit">Anmelden</Button>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <button type="button" className="text-gold underline-offset-4 hover:underline" onClick={() => go('forgot')} data-testid="auth-forgot">Passwort vergessen?</button>
            <button type="button" className="text-cream-dim underline-offset-4 hover:underline" onClick={() => go('magic')}>Anmeldelink per E-Mail</button>
          </div>
        </form>
      ) : mode === 'register' ? (
        <form onSubmit={register} className="space-y-5">
          <Field label="Managername" hint="3–20 Zeichen. Für deine Mitspieler sichtbar – deine E-Mail-Adresse bleibt privat.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} required autoFocus autoComplete="nickname" maxLength={20} placeholder="z. B. Trainerfuchs" data-testid="auth-name" />
          </Field>
          {emailField}
          <Field label="Passwort" hint={`Mindestens ${PASSWORD_MIN} Zeichen, Buchstaben und Ziffern.`}>
            <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" testid="auth-password" />
          </Field>
          <Field label="Passwort wiederholen">
            <PasswordInput value={password2} onChange={setPassword2} autoComplete="new-password" testid="auth-password2" />
          </Field>
          <ErrorBanner error={error} />
          <Button type="submit" busy={busy} className="w-full" data-testid="auth-submit">Account erstellen</Button>
        </form>
      ) : (
        <form onSubmit={mode === 'forgot' ? forgot : magic} className="space-y-5">
          <h2 className="display text-3xl font-bold uppercase">{mode === 'forgot' ? 'Passwort vergessen' : 'Anmeldelink'}</h2>
          <p className="text-cream-dim">
            {mode === 'forgot' ? 'Gib deine E-Mail-Adresse ein. Du bekommst einen Link, mit dem du ein neues Passwort festlegst.' : 'Du bekommst einen Link, der dich ohne Passwort anmeldet.'}
          </p>
          {emailField}
          <ErrorBanner error={error} />
          <Button type="submit" busy={busy} className="w-full" data-testid="auth-submit">Link senden</Button>
          <button type="button" className="text-sm text-gold underline-offset-4 hover:underline" onClick={() => go('login')}>Zurück zur Anmeldung</button>
        </form>
      )}
    </Layout>
  );
}

/** Nach der E-Mail-Bestätigung: Managername übernehmen (aus der Registrierung) bzw. wählen */
export function ProfileSetup() {
  const { session, refreshProfile, signOut } = useAuth();
  const preset = String(session?.user.user_metadata?.manager_name ?? '');
  const [name, setName] = useState(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  async function save(value: string) {
    const parsed = usernameSchema.safeParse(value);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Ungültiger Managername'); return; }
    setBusy(true);
    setError(null);
    try {
      await api.setUsername(parsed.data);
      await refreshProfile();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Managername aus der Registrierung automatisch übernehmen (einmal)
  useEffect(() => {
    if (preset && !tried.current) { tried.current = true; void save(preset); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  return (
    <Layout>
      <form onSubmit={(e) => { e.preventDefault(); void save(name); }} className="space-y-5">
        <h2 className="display text-3xl font-bold uppercase">Managername</h2>
        <p className="text-cream-dim">Angemeldet als {session?.user.email}. Wie sollen dich deine Mitspieler sehen?</p>
        <Field label="Managername" hint="3–20 Zeichen. Für deine Mitspieler sichtbar.">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={20} data-testid="profile-name" />
        </Field>
        <ErrorBanner error={error} />
        <Button type="submit" busy={busy} className="w-full" data-testid="profile-save">Anpfiff</Button>
        <button type="button" className="text-sm text-cream-dim underline-offset-4 hover:underline" onClick={() => void signOut()}>Abmelden</button>
      </form>
    </Layout>
  );
}

/** Über den Link aus „Passwort vergessen“ angemeldet: neues Passwort festlegen */
export function ResetPassword() {
  const { session, endRecovery } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = passwordProblem(pw, pw2);
    if (p) { setError(p); return; }
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await auth.setPassword(pw);
      if (err) throw err;
      setDone(true);
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <Layout>
        <div className="space-y-4">
          <h2 className="display text-3xl font-bold uppercase">Link ungültig</h2>
          <p className="text-cream-dim">Der Link ist abgelaufen oder wurde schon verwendet. Fordere über „Passwort vergessen“ einen neuen an.</p>
          <Button variant="secondary" onClick={endRecovery}>Zur Anmeldung</Button>
        </div>
      </Layout>
    );
  }
  return (
    <Layout>
      {done ? (
        <div className="space-y-4" data-testid="reset-done">
          <h2 className="display text-3xl font-bold uppercase">Passwort geändert</h2>
          <p className="text-cream-dim">Ab jetzt meldest du dich mit dem neuen Passwort an – auf jedem Gerät.</p>
          <Button onClick={endRecovery} data-testid="reset-continue">Weiter</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <h2 className="display text-3xl font-bold uppercase">Neues Passwort</h2>
          <p className="text-cream-dim">Für {session.user.email}</p>
          <Field label="Neues Passwort" hint={`Mindestens ${PASSWORD_MIN} Zeichen, Buchstaben und Ziffern.`}>
            <PasswordInput value={pw} onChange={setPw} autoComplete="new-password" testid="reset-password" autoFocus />
          </Field>
          <Field label="Passwort wiederholen">
            <PasswordInput value={pw2} onChange={setPw2} autoComplete="new-password" testid="reset-password2" />
          </Field>
          <ErrorBanner error={error} />
          <Button type="submit" busy={busy} className="w-full" data-testid="reset-submit">Passwort speichern</Button>
        </form>
      )}
    </Layout>
  );
}
