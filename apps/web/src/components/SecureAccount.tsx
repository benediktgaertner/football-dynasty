import { useEffect, useState, type FormEvent } from 'react';
import { auth, authMessage, isEmail, passwordProblem, PASSWORD_MIN, type AccountStatus } from '../lib/account';
import { useAuth } from '../lib/auth';
import { requireSupabase } from '../lib/supabase';
import { Button, ErrorBanner, Field, TextInput } from './ui';

export type SecureStep = 'email' | 'pending' | 'password' | 'done';

/** Schritt der Kontensicherung aus dem serverseitigen Kontostatus */
export function secureStep(a: AccountStatus | null): SecureStep {
  if (!a) return 'email';
  if (a.pending_email && !a.email_confirmed) return 'pending';
  if (!a.email_confirmed) return a.pending_email ? 'pending' : 'email';
  if (!a.has_password) return 'password';
  return 'done';
}

/**
 * Account sichern – OHNE neuen Account: Supabase hängt E-Mail und Passwort an den bestehenden Benutzer
 * (gleiche auth.users.id). Reihenfolge: 1. E-Mail hinterlegen → 2. Link bestätigen → 3. Passwort setzen.
 * Die Sitzung bleibt währenddessen bestehen; schlägt ein Schritt fehl, ist der bisherige Account unverändert nutzbar.
 */
export function SecureAccount({ onDone }: { onDone?: () => void }) {
  const { account, refreshAccount } = useAuth();
  const step = secureStep(account);
  const [editEmail, setEditEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [nonce, setNonce] = useState('');
  const [needNonce, setNeedNonce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const shown: SecureStep = editEmail && step === 'pending' ? 'email' : step;

  // Bestätigung kann auf einem anderen Gerät passieren: solange offen, alle 10 s den Status prüfen (max. 10 min)
  useEffect(() => {
    if (shown !== 'pending') return;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 60) { clearInterval(t); return; }
      void refreshAccount();
    }, 10_000);
    return () => clearInterval(t);
  }, [shown, refreshAccount]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null); setInfo(null);
    try { await fn(); } catch (e) { setError(authMessage(e)); } finally { setBusy(false); }
  }

  const sendEmail = (e?: FormEvent, again?: string) => { e?.preventDefault(); void run(async () => {
    const target = again ?? email;
    if (!isEmail(target)) throw new Error('Bitte gib eine gültige E-Mail-Adresse ein.');
    const { error: err } = await auth.linkEmail(target);
    if (err) throw err;
    setEditEmail(false);
    await refreshAccount();
    if (again) setInfo('Bestätigungslink erneut gesendet.');
  }); };

  const checkConfirmed = () => void run(async () => {
    await requireSupabase().auth.refreshSession();
    const a = await refreshAccount();
    if (secureStep(a) === 'pending') setInfo('Noch nicht bestätigt. Öffne den Link in der E-Mail (auf diesem oder einem anderen Gerät).');
  });

  const savePassword = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const p = passwordProblem(pw, pw2);
    if (p) throw new Error(p);
    const { error: err } = await auth.setPassword(pw, needNonce ? nonce.trim() : undefined);
    if (err?.code === 'reauthentication_needed') {
      // „Sichere Passwortänderung“ aktiv: Supabase schickt einen Code an die bestätigte Adresse
      const r = await auth.reauthenticate();
      if (r.error) throw r.error;
      setNeedNonce(true);
      setInfo('Zur Sicherheit haben wir dir einen Code per E-Mail geschickt. Gib ihn unten ein.');
      return;
    }
    if (err) throw err;
    await refreshAccount();
    onDone?.();
  }); };

  if (shown === 'done') {
    return (
      <div className="space-y-2" data-testid="secure-done">
        <h3 className="display text-2xl font-bold uppercase">Account gesichert</h3>
        <p className="text-cream-dim">Melde dich auf jedem Gerät mit {account?.email} und deinem Passwort an – du siehst dort deine Vereine und Welten.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ol className="flex gap-2 text-xs uppercase tracking-wider" aria-label="Fortschritt">
        {(['E-Mail', 'Bestätigen', 'Passwort'] as const).map((l, i) => {
          const cur = { email: 0, pending: 1, password: 2, done: 3 }[shown];
          return <li key={l} className={`display flex-1 rounded-full px-3 py-1 text-center font-semibold ${i < cur ? 'bg-pitch text-cream' : i === cur ? 'bg-gold text-ink' : 'bg-olive-700 text-cream-dim'}`}>{i + 1}. {l}</li>;
        })}
      </ol>

      {shown === 'email' && (
        <form onSubmit={sendEmail} className="space-y-4">
          <Field label="E-Mail-Adresse" hint="Wir schicken dir einen Bestätigungslink. Deine Adresse ist für andere Manager nicht sichtbar.">
            <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" data-testid="secure-email" />
          </Field>
          <ErrorBanner error={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy} data-testid="secure-send">Bestätigungslink senden</Button>
            {editEmail && <Button type="button" variant="ghost" onClick={() => setEditEmail(false)}>Abbrechen</Button>}
          </div>
        </form>
      )}

      {shown === 'pending' && (
        <div className="space-y-4" data-testid="secure-pending">
          <p className="text-cream-dim">
            Wir haben einen Bestätigungslink an <b className="text-cream">{account?.pending_email}</b> geschickt. Öffne ihn – gern auch auf dem Handy. Bis dahin spielst du ganz normal weiter; nichts geht verloren.
          </p>
          {info && <p className="text-sm text-gold">{info}</p>}
          <ErrorBanner error={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={checkConfirmed} busy={busy} data-testid="secure-check">Ich habe bestätigt</Button>
            <Button type="button" variant="secondary" onClick={() => sendEmail(undefined, account?.pending_email ?? '')} disabled={busy}>Erneut senden</Button>
            <Button type="button" variant="ghost" onClick={() => { setEditEmail(true); setEmail(''); }}>Andere Adresse</Button>
          </div>
        </div>
      )}

      {shown === 'password' && (
        <form onSubmit={savePassword} className="space-y-4">
          <p className="text-cream-dim">E-Mail bestätigt ({account?.email}). Lege jetzt ein Passwort fest, damit du dich auf anderen Geräten anmelden kannst.</p>
          <Field label="Passwort" hint={`Mindestens ${PASSWORD_MIN} Zeichen, Buchstaben und Ziffern.`}>
            <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required minLength={PASSWORD_MIN} data-testid="secure-password" />
          </Field>
          <Field label="Passwort wiederholen">
            <TextInput type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required data-testid="secure-password2" />
          </Field>
          {needNonce && (
            <Field label="Code aus der E-Mail">
              <TextInput value={nonce} onChange={(e) => setNonce(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
            </Field>
          )}
          {info && <p className="text-sm text-gold">{info}</p>}
          <ErrorBanner error={error} />
          <Button type="submit" busy={busy} data-testid="secure-save-password">Passwort speichern</Button>
        </form>
      )}
    </div>
  );
}

/** Einmalige Aufforderung nach dem Login (serverseitig gemerkt – erscheint nicht auf jedem Gerät erneut) */
export function SecurePrompt({ onClose }: { onClose: (dismissed: boolean) => void }) {
  const { account } = useAuth();
  const step = secureStep(account);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="secure-title" data-testid="secure-prompt">
      <div className="w-full max-w-lg rounded-2xl border border-gold/40 bg-olive-900 p-6 shadow-2xl">
        <h2 id="secure-title" className="display mb-2 text-3xl font-extrabold uppercase">Sichere deinen Account</h2>
        {step !== 'done' && (
          <p className="mb-4 text-cream-dim">
            Hinterlege deine E-Mail-Adresse und ein Passwort, damit du Football Dynasty auf mehreren Geräten spielen kannst.
            {account && account.clubs > 0 && <> {account.clubs === 1 ? 'Dein Verein bleibt' : `Deine ${account.clubs} Vereine bleiben`} vollständig erhalten.</>}
          </p>
        )}
        <SecureAccount />
        <div className="mt-5 flex justify-end">
          <Button variant="ghost" onClick={() => onClose(step !== 'done')} data-testid="secure-later">{step === 'done' ? 'Schließen' : 'Später'}</Button>
        </div>
      </div>
    </div>
  );
}

/** Hinweise über allen Seiten: Fehler aus E-Mail-Links und verdrängter ungesicherter Account */
export function AccountNotices() {
  const { linkError, clearLinkError, stranded, restoreStranded, forgetStranded } = useAuth();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!linkError && !stranded) return null;
  return (
    <div className="fixed inset-x-0 top-2 z-40 mx-auto flex max-w-xl flex-col gap-2 px-3">
      {linkError && (
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-sunset/50 bg-olive-900/95 px-4 py-3 text-cream shadow-xl" data-testid="link-error">
          <span className="flex-1">{linkError}</span>
          <button type="button" onClick={clearLinkError} aria-label="Schließen">✕</button>
        </div>
      )}
      {stranded && (
        <div className="rounded-xl border border-gold/50 bg-olive-900/95 px-4 py-3 text-cream shadow-xl" data-testid="stranded">
          <p>Auf diesem Gerät gibt es noch den ungesicherten Account <b>{stranded.username ?? 'ohne Namen'}</b>. Er ist nur hier gespeichert.</p>
          {err && <p className="mt-1 text-sm text-danger">{err}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button busy={busy} onClick={() => { setBusy(true); setErr(null); restoreStranded().catch((e: Error) => setErr(e.message)).finally(() => setBusy(false)); }} data-testid="stranded-restore">Zu diesem Account wechseln</Button>
            <Button variant="ghost" onClick={() => { if (window.confirm(`Den ungesicherten Account „${stranded.username ?? ''}“ auf diesem Gerät endgültig aufgeben? Seine Vereine sind danach nicht mehr erreichbar.`)) forgetStranded(); }}>Verwerfen</Button>
          </div>
        </div>
      )}
    </div>
  );
}
