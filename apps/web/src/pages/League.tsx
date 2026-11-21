import { ClubLink, PlayerLink } from '../components/links';
import { readableTextColor } from '@fd/shared';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type Competition, type EuropePlaces, type FixtureRow, type TableRow } from '../lib/seasonApi';
import { requireSupabase } from '../lib/supabase';

/** C1: Ligen – Tabelle (gesamt/heim/auswärts), Spieltage, Torschützen, Vorlagen, Noten */
export function League() {
  const { worldId = '' } = useParams();
  const [comps, setComps] = useState<Competition[]>([]);
  const [compId, setCompId] = useState<string | null>(null);
  const [table, setTable] = useState<TableRow[]>([]);
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [md, setMd] = useState<number>(1);
  const [view, setView] = useState<'all' | 'home' | 'away'>('all');
  const [leaders, setLeaders] = useState<Awaited<ReturnType<typeof seasonApi.leaders>> | null>(null);
  const [myClub, setMyClub] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<EuropePlaces | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const state = await seasonApi.matchday(worldId);
        setMyClub(state.my_club);
        seasonApi.europePlaces(worldId).then(setPlaces, () => setPlaces(null));
        if (!state.season) return;
        const all = (await seasonApi.competitions(state.season.id)).filter((c) => c.kind === 'league');
        setComps(all);
        // eigene Liga vorauswählen
        const { data } = await requireSupabase().from('competition_entries').select('competition_id').eq('club_id', state.my_club ?? '').in('competition_id', all.map((c) => c.id));
        setCompId(data?.[0]?.competition_id ?? all[0]?.id ?? null);
        setMd(Math.max(1, Math.min(34, (state.slot?.matchday ?? 1) - (state.slot?.state === 'released' ? 0 : 1)) || 1));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [worldId]);

  useEffect(() => {
    if (!compId) return;
    void (async () => {
      try {
        const [t, f, l] = await Promise.all([seasonApi.table(compId), seasonApi.fixtures(compId), seasonApi.leaders(compId)]);
        setTable(t); setFixtures(f); setLeaders(l);
        const lastPlayed = Math.max(0, ...f.filter((x) => x.status === 'released').map((x) => x.matchday ?? 0));
        setMd(Math.max(1, lastPlayed || 1));
      } catch (e) { setError((e as Error).message); }
    })();
  }, [compId]);

  const comp = comps.find((c) => c.id === compId);
  const rows = useMemo(() => {
    if (view === 'all') return table;
    return [...table].map((r) => {
      const s = view === 'home' ? r.home : r.away;
      return { ...r, played: s.p, won: s.w, drawn: s.d, lost: s.l, goals_for: s.gf, goals_against: s.ga, points: s.w * 3 + s.d };
    }).sort((a, b) => b.points - a.points || (b.goals_for - b.goals_against) - (a.goals_for - a.goals_against) || b.goals_for - a.goals_for);
  }, [table, view]);
  // Europapokal-Plätze nur in der nationalen 1. Liga: CL (violett), EL (orange), EL* = Nachrücker für den Pokalsieger
  const ec = places && comp?.tier === 1 && places.competition_id === comp.id ? places : null;
  const ecZone = (pos: number, clubId: string): { cls: string; label: string | null } => {
    if (!ec || view !== 'all') return { cls: '', label: null };
    if (pos <= ec.cl) return { cls: 'border-l-4 border-l-[#b8a6ff]', label: 'CL' };
    if (pos <= ec.cl + ec.el) return { cls: 'border-l-4 border-l-[#ff8a1f]', label: 'EL' };
    if (ec.extra_el_pos === pos) return { cls: 'border-l-4 border-l-[#ffbf80]', label: 'EL*' };
    if (ec.cup_winner === clubId) return { cls: 'border-l-4 border-l-[#ff8a1f]', label: 'EL (Pokal)' };
    return { cls: '', label: null };
  };
  const zone = (pos: number, clubId = '') => {
    const t = comp?.tier ?? 2;
    if (view !== 'all') return '';
    const e = ecZone(pos, clubId);
    if (e.cls && pos < 16) return e.cls;
    if (t > 1 && pos <= 2) return 'border-l-4 border-l-emerald-400';
    if (t > 1 && pos === 3) return 'border-l-4 border-l-emerald-700';
    if (t === 1 && pos === 1) return 'border-l-4 border-l-gold';
    if (pos === 16) return 'border-l-4 border-l-sunset';
    if (pos >= 17) return 'border-l-4 border-l-danger';
    return 'border-l-4 border-l-transparent';
  };
  const mdFixtures = fixtures.filter((f) => f.matchday === md);

  if (!comps.length && !error) return <Shell><WorldNav worldId={worldId} /><Spinner label="Ligen werden geladen …" /></Shell>;

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <ErrorBanner error={error} />
      {!comps.length ? <Card><p className="text-cream-dim">Die Saison hat noch nicht begonnen.</p></Card> : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {comps.map((c) => (
              <button key={c.id} type="button" onClick={() => setCompId(c.id)} className={`display min-h-11 rounded-full px-5 font-semibold uppercase ${c.id === compId ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>{c.name}</button>
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
            <Card className="overflow-x-auto">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h1 className="display mr-auto text-3xl font-bold uppercase">{comp?.name}</h1>
                {(['all', 'home', 'away'] as const).map((v) => (
                  <button key={v} type="button" onClick={() => setView(v)} className={`rounded-full px-3 py-1 text-sm ${view === v ? 'bg-olive-600 text-cream' : 'text-cream-dim'}`}>{v === 'all' ? 'Gesamt' : v === 'home' ? 'Heim' : 'Auswärts'}</button>
                ))}
              </div>
              <table className="w-full min-w-[520px] text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-cream-dim">
                  <tr><th className="w-8 py-1 pl-2">#</th><th>Verein</th><th className="text-right">Sp</th><th className="text-right">S</th><th className="text-right">U</th><th className="text-right">N</th><th className="text-right">Tore</th><th className="text-right">Diff</th><th className="pr-2 text-right">Pkt</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.club_id} className={`border-t border-olive-700/50 ${zone(i + 1, r.club_id)} ${r.club_id === myClub ? 'bg-gold/10 font-semibold' : ''}`}>
                      <td className="py-1.5 pl-2 tabular-nums">{i + 1}</td>
                      <td className="py-1.5">
                        <span className="flex items-center gap-2">
                          <span className="display grid h-6 min-w-9 place-items-center rounded px-1 text-[11px] font-bold" style={{ background: r.color ?? '#3a4a3a', color: readableTextColor(r.color ?? '#3a4a3a') }}>{r.short_name}</span>
                          <ClubLink club={{ id: r.club_id, name: r.name }} className="truncate" />
                          {r.control === 'human' && <Pill tone="gold">Manager</Pill>}
                          {ecZone(i + 1, r.club_id).label && (
                            <span className={`rounded px-1.5 text-[10px] font-bold ${ecZone(i + 1, r.club_id).label === 'CL' ? 'bg-[#b8a6ff]/20 text-[#d9d0ff]' : 'bg-[#ff8a1f]/20 text-[#ffd2a6]'}`}>{ecZone(i + 1, r.club_id).label}</span>
                          )}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{r.played}</td><td className="text-right tabular-nums">{r.won}</td><td className="text-right tabular-nums">{r.drawn}</td><td className="text-right tabular-nums">{r.lost}</td>
                      <td className="text-right tabular-nums">{r.goals_for}:{r.goals_against}</td><td className="text-right tabular-nums">{r.goals_for - r.goals_against > 0 ? '+' : ''}{r.goals_for - r.goals_against}</td>
                      <td className="display pr-2 text-right text-lg font-bold tabular-nums">{r.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-cream-dim">
                {ec ? (
                  <>
                    <span className="text-[#d9d0ff]">Violett: Champions League (Platz 1–{ec.cl})</span> · <span className="text-[#ffd2a6]">Orange: Europa League (Platz {ec.cl + 1}–{ec.cl + ec.el} + Pokalsieger)</span>
                    {ec.extra_el_pos ? ` · EL*: Platz ${ec.extra_el_pos} rückt nach, weil der Pokalsieger bereits qualifiziert ist` : !ec.cup_decided ? ' · Pokalsieger noch offen (ist er schon qualifiziert, rückt der Nächstplatzierte nach)' : ''}
                    {' · Länderrang '}{ec.association_rank ?? '–'} · gilt für die nächste Saison · Rot: Abstieg, Orange am Rand: Relegation
                  </>
                ) : (
                  <>Grün: Aufstieg (Platz 3: Relegation) · Orange: Relegation · Rot: Abstieg{comp?.tier === 3 ? ' in die abstrakte 4. Liga' : ''}</>
                )}
              </p>
            </Card>
            <div className="space-y-4">
              <Card>
                <div className="mb-2 flex items-center gap-2">
                  <h2 className="display mr-auto text-2xl font-bold uppercase">{md}. Spieltag</h2>
                  <button type="button" className="min-h-10 rounded-lg bg-olive-800 px-3" disabled={md <= 1} onClick={() => setMd(md - 1)} aria-label="Vorheriger Spieltag">‹</button>
                  <button type="button" className="min-h-10 rounded-lg bg-olive-800 px-3" disabled={md >= 34} onClick={() => setMd(md + 1)} aria-label="Nächster Spieltag">›</button>
                </div>
                <ul className="divide-y divide-olive-700/50 text-sm">
                  {mdFixtures.map((f) => (
                    <li key={f.id} className={`flex items-center gap-2 py-1.5 ${f.home.id === myClub || f.away.id === myClub ? 'font-semibold text-gold' : ''}`}>
                      <ClubLink club={f.home} className="flex-1 truncate text-right" />
                      <span className="display w-14 text-center text-lg font-bold tabular-nums">{f.result ? `${f.result.home_goals}:${f.result.away_goals}` : '–:–'}</span>
                      <ClubLink club={f.away} className="flex-1 truncate" />
                    </li>
                  ))}
                </ul>
              </Card>
              <Card>
                <h2 className="display mb-2 text-2xl font-bold uppercase">Torschützen</h2>
                <ol className="space-y-1 text-sm">
                  {(leaders?.scorers ?? []).slice(0, 10).map((s, i) => (
                    <li key={s.player + i} className="flex gap-2"><span className="w-5 text-cream-dim">{i + 1}.</span><span className="flex-1 truncate"><PlayerLink id={s.player_id}>{s.player}</PlayerLink> <span className="text-cream-dim">({s.club})</span></span><span className="tabular-nums">{s.goals}</span></li>
                  ))}
                  {!leaders?.scorers.length && <li className="text-cream-dim">Noch keine Tore.</li>}
                </ol>
                <h3 className="display mb-1 mt-4 text-lg font-bold uppercase text-gold">Vorlagen</h3>
                <ol className="space-y-1 text-sm">
                  {(leaders?.assists ?? []).slice(0, 5).map((s, i) => (
                    <li key={s.player + i} className="flex gap-2"><span className="w-5 text-cream-dim">{i + 1}.</span><span className="flex-1 truncate"><PlayerLink id={s.player_id}>{s.player}</PlayerLink> <span className="text-cream-dim">({s.club})</span></span><span className="tabular-nums">{s.assists}</span></li>
                  ))}
                </ol>
                <h3 className="display mb-1 mt-4 text-lg font-bold uppercase text-gold">Beste Noten</h3>
                <ol className="space-y-1 text-sm">
                  {(leaders?.ratings ?? []).slice(0, 5).map((s, i) => (
                    <li key={s.player + i} className="flex gap-2"><span className="w-5 text-cream-dim">{i + 1}.</span><span className="flex-1 truncate"><PlayerLink id={s.player_id}>{s.player}</PlayerLink> <span className="text-cream-dim">({s.club})</span></span><span className="tabular-nums">{Number(s.rating).toFixed(2).replace('.', ',')}</span></li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
