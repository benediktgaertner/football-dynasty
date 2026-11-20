import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ClubLink } from '../components/links';
import { WorldNav } from '../components/WorldNav';
import { Card, ErrorBanner, Shell, Spinner } from '../components/ui';
import { fanApi, type EuropeCompetition, type EuropeFixture } from '../lib/fanApi';
import { STAGE_LABEL, seasonApi } from '../lib/seasonApi';
import { competitionTheme } from '../lib/theme';

const KO = ['quarter_final', 'semi_final', 'final'];

/** Champions League und Europa League: Gruppen, K.-o.-Runden, Torschützen */
export function Europe() {
  const { worldId = '' } = useParams();
  const [comps, setComps] = useState<EuropeCompetition[] | null>(null);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const [e, st] = await Promise.all([fanApi.europe(worldId), seasonApi.matchday(worldId)]);
        setComps(e.competitions); setMyClub(st.my_club);
      } catch (err) { setError((err as Error).message); }
    })();
  }, [worldId]);
  if (!comps) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Europapokal wird geladen …" />}</Shell>;
  const c = comps[tab];
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <h1 className="display mb-3 text-4xl font-extrabold uppercase">Europapokal</h1>
      {comps.length === 0 && (
        <Card><p className="text-cream-dim">Die europäischen Wettbewerbe starten mit der nächsten Saison. Teilnehmer: die ersten sechs der Bundesliga und der Pokalsieger; aus den übrigen Ländern die stärksten Vereine (mit etwas Losglück).</p></Card>
      )}
      {comps.length > 0 && (
        <div className="mb-3 flex gap-1">
          {comps.map((x, i) => {
            const th = competitionTheme({ kind: x.kind });
            return (
              <button key={x.id} type="button" onClick={() => setTab(i)} className="display min-h-11 flex-1 rounded-xl px-4 text-lg font-bold uppercase"
                style={tab === i ? { background: `linear-gradient(100deg, ${th.board.from}, ${th.board.to})`, color: th.board.label, border: `1px solid ${th.board.edge}` } : { background: '#26302a', color: '#b9c2b2' }}>
                {x.name}
              </button>
            );
          })}
        </div>
      )}
      {c && (
        <div className="space-y-4">
          {c.winner && <Card><p className="display text-2xl font-bold uppercase text-gold">Sieger: <ClubLink club={c.winner} /></p></Card>}
          <div className="grid gap-4 md:grid-cols-2">
            {c.groups.map((g) => (
              <Card key={g.label}>
                <h2 className="display mb-2 text-2xl font-bold uppercase">Gruppe {g.label}</h2>
                <table className="w-full text-sm tabular-nums">
                  <thead><tr className="text-left text-cream-dim"><th className="w-6">#</th><th>Verein</th><th className="text-right">Sp</th><th className="text-right">Tore</th><th className="text-right">Pkt</th></tr></thead>
                  <tbody>
                    {g.table.map((r) => (
                      <tr key={r.club_id} className={`${r.club_id === myClub ? 'text-gold' : ''} ${r.pos <= 2 ? 'font-semibold' : 'text-cream-dim'}`}>
                        <td>{r.pos}</td>
                        <td className="truncate"><ClubLink club={{ id: r.club_id, name: r.name }} /> <span className="text-xs text-cream-dim">{r.association}</span></td>
                        <td className="text-right">{r.played}</td>
                        <td className="text-right">{r.gf}:{r.gf - r.gd}</td>
                        <td className="text-right">{r.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Fixtures fixtures={c.fixtures.filter((f) => f.group === g.label)} myClub={myClub} worldId={worldId} />
              </Card>
            ))}
          </div>
          {KO.some((k) => c.fixtures.some((f) => f.stage === k)) && (
            <div className="grid gap-4 md:grid-cols-3">
              {KO.filter((k) => c.fixtures.some((f) => f.stage === k)).map((k) => (
                <Card key={k}>
                  <h2 className="display mb-2 text-2xl font-bold uppercase">{STAGE_LABEL[k] ?? k}</h2>
                  <Fixtures fixtures={c.fixtures.filter((f) => f.stage === k)} myClub={myClub} worldId={worldId} />
                </Card>
              ))}
            </div>
          )}
          {c.leaders?.scorers?.length > 0 && (
            <Card>
              <h2 className="display mb-2 text-2xl font-bold uppercase">Torschützen</h2>
              <ol className="grid gap-x-6 text-sm sm:grid-cols-2">
                {c.leaders.scorers.slice(0, 10).map((s, i) => (
                  <li key={s.player_id} className="flex gap-2 py-0.5"><span className="w-5 text-cream-dim">{i + 1}.</span>
                    <Link to={`/w/${worldId}/spieler/${s.player_id}`} className="flex-1 hover:text-gold">{s.player}</Link>
                    <span className="text-cream-dim">{s.club}</span><span className="w-6 text-right font-bold tabular-nums">{s.goals}</span></li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      )}
    </Shell>
  );
}

function Fixtures({ fixtures, myClub, worldId }: { fixtures: EuropeFixture[]; myClub: string | null; worldId: string }) {
  return (
    <ul className="mt-2 divide-y divide-olive-700/50 text-sm">
      {fixtures.map((f) => {
        const mine = f.home.id === myClub || f.away.id === myClub;
        return (
          <li key={f.id} className={`flex items-center gap-2 py-1 ${mine ? 'text-gold' : ''}`}>
            {f.leg && <span className="w-5 text-xs text-cream-dim">{f.leg === 1 ? 'H' : 'R'}</span>}
            <span className="flex-1 truncate text-right">{f.home.short}</span>
            <span className="display w-14 text-center font-bold tabular-nums">
              {f.result ? `${f.result.home}:${f.result.away}` : mine && f.status !== 'released' ? <Link to={`/w/${worldId}/spieltag`} className="underline">–:–</Link> : '–:–'}
              {f.result && f.result.hp !== null && <span className="block text-[10px] font-normal text-cream-dim">i. E. {f.result.hp}:{f.result.ap}</span>}
            </span>
            <span className="flex-1 truncate">{f.away.short}</span>
          </li>
        );
      })}
    </ul>
  );
}
