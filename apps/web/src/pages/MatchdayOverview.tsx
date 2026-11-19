import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClubLink, ClubLogo, PlayerLink } from '../components/links';
import { Button, Card, ErrorBanner, Shell, Spinner } from '../components/ui';
import { seasonApi, type MatchdayReport } from '../lib/seasonApi';

/** Pflicht-Spieltagsübersicht nach jeder gemeinsamen Ergebnisfreigabe (übersteht Neuladen; erst „Weiter“ führt zum Dashboard) */
export function MatchdayOverview() {
  const { worldId = '', slotId = '' } = useParams();
  const navigate = useNavigate();
  const [rep, setRep] = useState<MatchdayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void seasonApi.report(worldId, slotId).then(setRep).catch((e) => setError((e as Error).message)); }, [worldId, slotId]);

  const next = async () => {
    setBusy(true);
    try { await seasonApi.markReviewSeen(worldId, slotId); navigate(`/w/${worldId}/spieltag`, { replace: true }); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };

  if (!rep) return <Shell>{error ? <ErrorBanner error={error} /> : <Spinner label="Spieltagsübersicht wird geladen …" />}</Shell>;
  return (
    <Shell>
      <Card className="pitch-stripes mb-4">
        <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Spieltagsübersicht · {new Date(rep.slot.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</p>
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="display text-4xl font-extrabold uppercase leading-none">{rep.slot.label}</h1>
          <Button className="ml-auto" busy={busy} onClick={() => void next()}>Weiter zum Dashboard</Button>
        </div>
      </Card>
      <ErrorBanner error={error} />
      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="space-y-4">
          {rep.competitions.map((c) => (
            <Card key={c.id}>
              <h2 className="display mb-2 text-2xl font-bold uppercase">{c.name}</h2>
              <ul className="divide-y divide-olive-700/60">
                {c.games.map((g) => (
                  <li key={g.id} className={`py-2 ${g.mine ? 'rounded-lg bg-gold/10 px-2' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right"><ClubLink club={g.home} className={`truncate ${g.hg > g.ag ? 'font-bold' : ''}`} /><ClubLogo club={g.home} size={24} /></span>
                      <span className="display w-16 shrink-0 text-center text-2xl font-extrabold tabular-nums">{g.hg}:{g.ag}
                        {g.hp !== null && <span className="block text-[11px] font-normal text-cream-dim">i. E. {g.hp}:{g.ap}</span>}</span>
                      <span className="flex min-w-0 flex-1 items-center gap-2"><ClubLogo club={g.away} size={24} /><ClubLink club={g.away} className={`truncate ${g.ag > g.hg ? 'font-bold' : ''}`} /></span>
                    </div>
                    {g.events.length > 0 && (
                      <div className="mt-1 grid grid-cols-2 gap-x-6 text-xs text-cream-dim">
                        <div className="text-right">{g.events.filter((e) => e.home).map((e, i) => <div key={i}>{e.type === 'goal' ? '⚽' : '🟥'} <PlayerLink id={e.player_id}>{e.name}</PlayerLink> {e.minute}'</div>)}</div>
                        <div>{g.events.filter((e) => !e.home).map((e, i) => <div key={i}>{e.minute}' <PlayerLink id={e.player_id}>{e.name}</PlayerLink> {e.type === 'goal' ? '⚽' : '🟥'}</div>)}</div>
                      </div>
                    )}
                    {g.attendance !== null && <p className="mt-0.5 text-center text-[11px] text-cream-dim">{g.attendance.toLocaleString('de-DE')} Zuschauer</p>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {rep.competitions.length === 0 && <Card><p className="text-cream-dim">Keine Pflichtspiele an diesem Termin.</p></Card>}
        </div>
        <div className="space-y-4">
          {rep.table && (
            <Card>
              <h2 className="display mb-2 text-xl font-bold uppercase">{rep.table.name}</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase text-cream-dim"><tr><th>#</th><th /><th>Verein</th><th className="text-right">Sp</th><th className="text-right">Diff</th><th className="text-right">Pkt</th></tr></thead>
                <tbody>
                  {rep.table.rows.map((r) => {
                    const ch = r.prev ? r.prev - r.pos : 0;
                    return (
                      <tr key={r.club.id} className={`border-t border-olive-700/50 ${r.mine ? 'bg-gold/15 font-bold text-gold' : ''}`}>
                        <td className="py-1 tabular-nums">{r.pos}</td>
                        <td className={`w-7 text-xs ${ch > 0 ? 'text-emerald-300' : ch < 0 ? 'text-danger' : 'text-cream-dim'}`} title={r.prev ? `vorher ${r.prev}.` : ''}>{ch > 0 ? `▲${ch}` : ch < 0 ? `▼${-ch}` : '•'}</td>
                        <td className="max-w-0"><span className="flex items-center gap-1.5"><ClubLogo club={r.club} size={18} /><ClubLink club={r.club} className="truncate" /></span></td>
                        <td className="text-right tabular-nums">{r.played}</td>
                        <td className="text-right tabular-nums">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                        <td className="display text-right tabular-nums">{r.points}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          )}
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase">Spieler des Spieltags</h2>
            <ol className="space-y-1 text-sm">
              {rep.top_ratings.map((p) => (
                <li key={p.player_id} className="flex items-center gap-2 rounded-lg bg-olive-800/70 px-2 py-1.5">
                  <ClubLogo club={p.club} size={18} />
                  <PlayerLink id={p.player_id} className="min-w-0 flex-1 truncate font-semibold">{p.name}</PlayerLink>
                  <span className="text-xs text-cream-dim">{p.goals ? `${p.goals} T ` : ''}{p.assists ? `${p.assists} V` : ''}</span>
                  <span className="display w-10 text-right font-bold tabular-nums">{Number(p.rating).toLocaleString('de-DE', { minimumFractionDigits: 1 })}</span>
                </li>
              ))}
              {rep.top_ratings.length === 0 && <li className="text-cream-dim">Keine Spielerdaten.</li>}
            </ol>
            {rep.top_scorers.length > 0 && (
              <>
                <h3 className="display mb-1 mt-3 text-base font-bold uppercase text-gold">Torschützen</h3>
                <ul className="space-y-0.5 text-sm">{rep.top_scorers.map((p) => <li key={p.player_id} className="flex justify-between gap-2"><PlayerLink id={p.player_id}>{p.name}</PlayerLink><span className="text-cream-dim">{p.goals} ⚽</span></li>)}</ul>
              </>
            )}
          </Card>
          <Button className="w-full" busy={busy} onClick={() => void next()}>Weiter zum Dashboard</Button>
        </div>
      </div>
    </Shell>
  );
}
