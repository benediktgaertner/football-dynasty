import { canonicalInviteCode, isValidInviteCode, type StartTier } from '@fd/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type WorldSummary } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Card, ErrorBanner, Field, Pill, Shell, Spinner, TextInput } from '../components/ui';
import { CountryPicker } from '../components/CountryPicker';
import { SecurePrompt, secureStep } from '../components/SecureAccount';
import { dismissAccountPrompt } from '../lib/account';

const STATUS_LABEL: Record<string, string> = {
  lobby: 'Lobby',
  draft: 'Draft',
  preseason: 'Vorbereitung',
  season: 'Saison läuft',
  season_end: 'Saisonabschluss',
};

/** B2.2: Karrierewelt erstellen oder beitreten. */
export function Home() {
  const { profile, account, refreshAccount } = useAuth();
  const [promptClosed, setPromptClosed] = useState(false);
  const unsecured = !!account && secureStep(account) !== 'done';
  // einmal geöffnet bleibt die Aufforderung offen, bis sie geschlossen wird (auch nach erfolgreicher Sicherung)
  const [promptOpen, setPromptOpen] = useState(false);
  useEffect(() => { if (unsecured && !account?.prompt_dismissed && !promptClosed) setPromptOpen(true); }, [unsecured, account?.prompt_dismissed, promptClosed]);
  const showPrompt = promptOpen && !promptClosed;
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<WorldSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [worldName, setWorldName] = useState('');
  const [code, setCode] = useState('');
  const [country, setCountry] = useState('GER');
  const [tier, setTier] = useState<StartTier>(2);
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.myWorlds().then(setWorlds, (e: Error) => setLoadError(e.message));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy('create');
    try {
      const r = await api.createWorld(worldName.trim(), country, tier);
      navigate(`/w/${r.world_id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const c = canonicalInviteCode(code);
    if (!isValidInviteCode(c)) {
      setError('Der Einladungscode besteht aus sechs Zeichen (ohne 0, O, 1, I, L).');
      return;
    }
    setBusy('join');
    try {
      navigate(`/w/${await api.joinWorld(c)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell right={<Link to="/konto" className="display rounded-xl px-3 py-2 text-lg font-semibold uppercase text-cream-dim hover:bg-olive-800 hover:text-cream" data-testid="account-link">{profile?.username}</Link>}>
      {showPrompt && (
        <SecurePrompt onClose={(dismissed) => {
          setPromptClosed(true);
          if (dismissed) void dismissAccountPrompt().then(() => refreshAccount()).catch(() => undefined);
        }} />
      )}
      {unsecured && !showPrompt && (
        <Link to="/konto" className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-sunset/40 bg-sunset/10 px-4 py-3 text-cream" data-testid="secure-banner">
          <span>Dein Account ist noch nicht gesichert. Hinterlege E-Mail und Passwort, um auf mehreren Geräten zu spielen.</span>
          <Pill tone="warn">Sichern</Pill>
        </Link>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card className="animate-rise">
          <form onSubmit={create} className="space-y-4">
            <h2 className="display text-3xl font-bold uppercase">Neue Karrierewelt</h2>
            <Field label="Name der Welt" hint="Du wirst Host und legst später die Schwierigkeit fest.">
              <TextInput value={worldName} onChange={(e) => setWorldName(e.target.value)} minLength={3} maxLength={40} required placeholder="z. B. Donnerstagsrunde" />
            </Field>
            <CountryPicker country={country} tier={tier} onChange={(c, t) => { setCountry(c); setTier(t); }} />
            <Button type="submit" busy={busy === 'create'}>
              Welt erstellen
            </Button>
          </form>
        </Card>
        <Card className="animate-rise">
          <form onSubmit={join} className="space-y-4">
            <h2 className="display text-3xl font-bold uppercase">Einer Welt beitreten</h2>
            <Field label="Einladungscode" hint="Den sechsstelligen Code bekommst du vom Host.">
              <TextInput value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={8} required placeholder="AB3K7Q" className="display tracking-[0.4em] uppercase" autoCapitalize="characters" />
            </Field>
            <Button type="submit" variant="secondary" busy={busy === 'join'}>
              Beitreten
            </Button>
          </form>
        </Card>
      </div>

      <div className="mt-4">
        <ErrorBanner error={error} />
      </div>

      <section className="mt-8">
        <h2 className="display mb-3 text-2xl font-bold uppercase text-cream-dim">Deine Welten</h2>
        {loadError && <ErrorBanner error={loadError} />}
        {!worlds && !loadError && <Spinner />}
        {worlds && worlds.length === 0 && <p className="text-cream-dim">Noch keine. Erstelle eine Welt oder tritt mit einem Code bei.</p>}
        <ul className="grid gap-3 sm:grid-cols-2">
          {worlds?.map((w) => (
            <li key={w.world_id}>
              <Link to={`/w/${w.world_id}/start`} data-testid="world-link" className="flex items-center justify-between rounded-2xl border border-olive-700 bg-olive-900/70 px-5 py-4 transition hover:border-gold/60">
                <div>
                  <div className="display text-2xl font-bold">{w.name}</div>
                  <div className="text-sm text-cream-dim">
                    {w.member_count} Manager · {w.role === 'host' ? 'Host' : 'Manager'}
                  </div>
                </div>
                <Pill tone={w.status === 'lobby' ? 'gold' : 'good'}>{STATUS_LABEL[w.status] ?? w.status}</Pill>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}
