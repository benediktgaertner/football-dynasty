import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { worldAudioApi, type WorldAudioSettings } from '../lib/worldAudioApi';

const STATUS: Record<string, string> = { lobby: 'Lobby', draft: 'Draft', preseason: 'Saisonvorbereitung', season: 'Saison läuft', season_end: 'Saisonende' };

/**
 * Liga-Startseite: erscheint beim Öffnen einer Liga aus dem Startdashboard.
 * „Liga betreten“ für alle Mitglieder; „Liga-Einstellungen“ nur für den gespeicherten Host (Prüfung in der Datenbank).
 */
export function LeagueStart() {
  const { worldId = '' } = useParams();
  const navigate = useNavigate();
  const [s, setS] = useState<WorldAudioSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { worldAudioApi.settings(worldId).then(setS).catch((e) => setError((e as Error).message)); }, [worldId]);
  if (error) return <Shell><ErrorBanner error={error} /><Link to="/" className="mt-4 inline-block text-cream-dim hover:text-cream">← Zurück zur Übersicht</Link></Shell>;
  if (!s) return <Shell><Spinner label="Liga wird geladen …" /></Shell>;
  const counts = (c: string) => s.files.filter((f) => f.category === c).length;
  return (
    <Shell>
      <Link to="/" className="mb-3 inline-block text-cream-dim hover:text-cream">← Alle Ligen</Link>
      <Card className="mx-auto max-w-2xl space-y-6" >
        <div data-testid="league-start">
          <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Liga</p>
          <h1 className="display text-5xl font-extrabold uppercase leading-none">{s.world.name}</h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill tone="good">{STATUS[s.world.status] ?? s.world.status}</Pill>
            <Pill>{s.is_host ? 'Du bist Host' : 'Manager'}</Pill>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button className="min-h-16 text-2xl" data-testid="enter-league" onClick={() => navigate(`/w/${worldId}`)}>Liga betreten</Button>
          {s.is_host && (
            <Button variant="secondary" className="min-h-16 text-2xl" data-testid="open-league-settings" onClick={() => navigate(`/w/${worldId}/einstellungen`)}>
              Liga-Einstellungen
            </Button>
          )}
        </div>
        <p className="text-sm text-cream-dim">
          KI-Stadionatmosphäre dieser Liga: {counts('chant')} Fangesänge · {counts('boo')} Pfiffe/Buhrufe · {counts('goal')} Torjubel
          {s.is_host ? '' : ' (verwaltet vom Liga-Host)'}
        </p>
      </Card>
    </Shell>
  );
}
