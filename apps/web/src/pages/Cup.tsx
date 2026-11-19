import { ClubLink } from '../components/links';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Card, ErrorBanner, Shell, Spinner } from '../components/ui';
import { STAGE_LABEL, seasonApi, type FixtureRow } from '../lib/seasonApi';

const ORDER = ['round_of_64', 'round_of_32', 'round_of_16', 'quarter_final', 'semi_final', 'final'];

/** C4: Pokal (64 Teilnehmer, K.-o., Elfmeterschießen) und C3: Relegation */
export function Cup() {
  const { worldId = '' } = useParams();
  const [cup, setCup] = useState<FixtureRow[] | null>(null);
  const [rel, setRel] = useState<Array<{ name: string; fixtures: FixtureRow[] }>>([]);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const state = await seasonApi.matchday(worldId);
        setMyClub(state.my_club);
        if (!state.season) { setCup([]); return; }
        const comps = await seasonApi.competitions(state.season.id);
        const c = comps.find((x) => x.kind === 'domestic_cup');
        setCup(c ? await seasonApi.fixtures(c.id) : []);
        setRel(await Promise.all(comps.filter((x) => x.kind === 'relegation').map(async (x) => ({ name: x.name, fixtures: await seasonApi.fixtures(x.id) }))));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [worldId]);
  if (!cup) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Pokal wird geladen …" />}</Shell>;
  const stages = ORDER.filter((s) => cup.some((f) => f.stage === s)).reverse();
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <ErrorBanner error={error} />
      <h1 className="display mb-3 text-4xl font-extrabold uppercase">DFB-Pokal</h1>
      {stages.length === 0 && <Card><p className="text-cream-dim">Die Auslosung erfolgt zum Saisonstart.</p></Card>}
      <div className="grid gap-4 md:grid-cols-2">
        {rel.map((r) => r.fixtures.length > 0 && (
          <Card key={r.name}>
            <h2 className="display mb-2 text-2xl font-bold uppercase text-sunset">{r.name}</h2>
            <FixtureList fixtures={r.fixtures} myClub={myClub} />
          </Card>
        ))}
        {stages.map((s) => (
          <Card key={s}>
            <h2 className="display mb-2 text-2xl font-bold uppercase">{STAGE_LABEL[s]}</h2>
            <FixtureList fixtures={cup.filter((f) => f.stage === s)} myClub={myClub} />
          </Card>
        ))}
      </div>
    </Shell>
  );
}

function FixtureList({ fixtures, myClub }: { fixtures: FixtureRow[]; myClub: string | null }) {
  return (
    <ul className="divide-y divide-olive-700/50 text-sm">
      {fixtures.map((f) => {
        const r = f.result;
        const homeWon = r && (r.home_goals > r.away_goals || (r.home_goals === r.away_goals && (r.home_penalties ?? 0) > (r.away_penalties ?? 0)));
        const awayWon = r && !homeWon && (r.away_goals !== r.home_goals || r.away_penalties !== null);
        return (
          <li key={f.id} className={`flex items-center gap-2 py-1.5 ${f.home.id === myClub || f.away.id === myClub ? 'text-gold' : ''}`}>
            {f.leg && <span className="w-6 text-xs text-cream-dim">{f.leg === 1 ? 'H' : 'R'}</span>}
            <span className={`flex-1 truncate text-right ${homeWon && !f.leg ? 'font-bold' : ''}`}><ClubLink club={f.home} /></span>
            <span className="display w-16 text-center text-lg font-bold tabular-nums">
              {r ? `${r.home_goals}:${r.away_goals}` : '–:–'}
              {r && r.home_penalties !== null && <span className="block text-[11px] font-normal text-cream-dim">i. E. {r.home_penalties}:{r.away_penalties}</span>}
            </span>
            <span className={`flex-1 truncate ${awayWon && !f.leg ? 'font-bold' : ''}`}><ClubLink club={f.away} /></span>
          </li>
        );
      })}
    </ul>
  );
}
