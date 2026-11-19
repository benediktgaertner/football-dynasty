import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { ClubLink, ClubLogo } from '../components/links';
import { Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type MatchdayState } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';
import { FixtureLine, fixtureStatus } from './Matchday';

interface MyFixture { id: string; date: string; status: string; competition: string; label: string | null; home: boolean; opponent: { id: string; name: string; short_name: string; color: string | null }; gf: number | null; ga: number | null }

/** Alle Begegnungen des aktuellen Termins (der Monatskalender befindet sich ausschließlich auf dem Dashboard) */
export function Calendar() {
  const { worldId = '' } = useParams();
  const [state, setState] = useState<MatchdayState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await seasonApi.matchday(worldId);
        setState(s);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [worldId]);

  if (!state) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Kalender wird geladen …" />}</Shell>;
  const slot = state.slot;
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <ErrorBanner error={error} />
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        <Card>
          <h1 className="display mb-1 text-3xl font-extrabold uppercase">{slot?.label ?? 'Aktueller Termin'}</h1>
          <p className="mb-3 text-sm text-cream-dim">Alle Begegnungen des Termins. Ergebnisse erscheinen gemeinsam, sobald alle Manager fertig sind.</p>
          <ul className="divide-y divide-olive-700/60">
            {state.fixtures.map((f) => (
              <li key={f.id} className={`flex flex-wrap items-center gap-2 py-2 ${f.mine ? 'font-semibold' : ''}`}>
                <span className="w-28 shrink-0 text-xs text-cream-dim">{f.competition}</span>
                <div className="min-w-0 flex-1"><FixtureLine f={f} /></div>
                <Pill tone={f.status === 'live' ? 'good' : 'neutral'}>{fixtureStatus(f)}</Pill>
                {slot?.state === 'live' && f.status === 'live' && <Link className="text-sm text-gold underline" to={`/w/${worldId}/match/${f.id}`}>Zuschauen</Link>}
              </li>
            ))}
            {state.fixtures.length === 0 && <li className="py-2 text-cream-dim">Keine Spiele an diesem Termin.</li>}
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
