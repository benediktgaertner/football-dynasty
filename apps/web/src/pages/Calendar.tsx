import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { ClubLink, ClubLogo } from '../components/links';
import { Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type MatchdayState } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';
import { FixtureLine, fixtureStatus } from './Matchday';

interface MyFixture { id: string; date: string; status: string; competition: string; label: string | null; home: boolean; opponent: { id: string; name: string; short_name: string; color: string | null }; gf: number | null; ga: number | null }

/** Kalender: alle Begegnungen des aktuellen Termins und der eigene Saisonspielplan */
export function Calendar() {
  const { worldId = '' } = useParams();
  const [state, setState] = useState<MatchdayState | null>(null);
  const [mine, setMine] = useState<MyFixture[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await seasonApi.matchday(worldId);
        setState(s);
        if (!s.season || !s.my_club) return;
        const { data } = await requireSupabase().from('fixtures')
          .select('id, scheduled_date, status, slot_key, home_club_id, competitions!inner(name, kind), home:clubs!fixtures_home_club_id_fkey(id, name, short_name), away:clubs!fixtures_away_club_id_fkey(id, name, short_name), fixture_results(home_goals, away_goals)')
          .eq('season_id', s.season.id).or(`home_club_id.eq.${s.my_club},away_club_id.eq.${s.my_club}`).neq('competitions.kind', 'friendly').order('scheduled_date');
        setMine((data ?? []).map((f: any) => {
          const home = f.home_club_id === s.my_club;
          const r = Array.isArray(f.fixture_results) ? f.fixture_results[0] : f.fixture_results;
          return { id: f.id, date: f.scheduled_date, status: f.status, competition: f.competitions.name, label: null, home,
            opponent: { ...(home ? f.away : f.home), color: null },
            gf: r && f.status === 'released' ? (home ? r.home_goals : r.away_goals) : null, ga: r && f.status === 'released' ? (home ? r.away_goals : r.home_goals) : null };
        }));
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
        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Mein Spielplan</h2>
          <ul className="space-y-1 text-sm">
            {mine.map((f) => (
              <li key={f.id} className="flex items-center gap-2 border-b border-olive-800 py-1">
                <span className="w-20 shrink-0 text-xs text-cream-dim">{new Date(f.date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
                <span className="w-5 text-xs font-bold text-cream-dim">{f.home ? 'H' : 'A'}</span>
                <ClubLogo club={f.opponent} size={18} />
                <ClubLink club={f.opponent} className="min-w-0 flex-1 truncate" />
                <span className="w-24 truncate text-[11px] text-cream-dim">{f.competition}</span>
                <span className={`display w-12 text-right font-bold tabular-nums ${f.gf === null ? 'text-cream-dim' : f.gf > f.ga! ? 'text-emerald-300' : f.gf < f.ga! ? 'text-danger' : ''}`}>{f.gf === null ? '–:–' : `${f.gf}:${f.ga}`}</span>
              </li>
            ))}
            {mine.length === 0 && <li className="text-cream-dim">Noch kein Spielplan.</li>}
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
