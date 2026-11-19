import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PlayerAvatar } from '../components/PlayerAvatar';
import { WorldNav } from '../components/WorldNav';
import { ClubLink, ClubLogo } from '../components/links';
import { ATTR_LABEL, OvrBadge } from '../components/team/OtherTabs';
import { POS_LABEL } from '../components/team/PitchEditor';
import { StatusBadges } from '../components/team/PlayerStatus';
import { Button, Card, ErrorBanner, Shell, Spinner } from '../components/ui';
import { formatEuro } from '../lib/api';
import { seasonApi, type PlayerDevelopmentSeason, type PlayerProfileData } from '../lib/seasonApi';
import { AttrChanges } from './Development';

const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));

/** Spielerprofil: öffentliche Werte, Fitness, Status, Saisonstatistik, Entwicklung (eigene Spieler) */
export function PlayerPage() {
  const { worldId = '', playerId = '' } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState<PlayerProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dev, setDev] = useState<PlayerDevelopmentSeason[]>([]);
  useEffect(() => { setP(null); void seasonApi.playerProfile(playerId).then(setP).catch((e) => setError((e as Error).message)); }, [playerId]);
  useEffect(() => { void seasonApi.playerDevelopment(playerId).then(setDev).catch(() => setDev([])); }, [playerId]);
  if (!p) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Spielerprofil wird geladen …" />}</Shell>;
  const color = p.club?.color ?? '#3a4a3a';
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <Button variant="ghost" className="mb-2" onClick={() => navigate(-1)}>← Zurück</Button>
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Card>
          <div className="flex flex-wrap items-start gap-5">
            <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={120} shirt={color} collar={p.club?.color2 ?? '#ffffff'} />
            <div className="min-w-0 flex-1">
              <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">{p.shirt ? `#${p.shirt} · ` : ''}{POS_LABEL[p.main_position] ?? p.main_position}{p.secondary_positions.length ? ` · auch ${p.secondary_positions.map((x) => POS_LABEL[x] ?? x).join(', ')}` : ''}</p>
              <h1 className="display text-4xl font-extrabold uppercase leading-none">{p.first_name} {p.last_name}</h1>
              <p className="mt-1 text-cream-dim">{p.nationality} · {p.age} Jahre</p>
              <div className="mt-2 flex items-center gap-2">
                {p.club ? <><ClubLogo club={p.club} size={24} /><ClubLink club={p.club} className="font-semibold" /></> : <span className="text-cream-dim">vereinslos{p.free_agent ? ` · Forderung ${formatEuro(p.free_agent.salary)}/Jahr` : ''}</span>}
              </div>
              <StatusBadges s={p.status ?? undefined} />
            </div>
            <div className="text-center"><OvrBadge value={p.overall} /><p className="mt-1 text-xs uppercase text-cream-dim">Gesamt</p></div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-anthracite p-4 text-center text-sm sm:grid-cols-4">
            <div><dt className="text-xs uppercase text-cream-dim">Marktwert</dt><dd className="display text-lg font-bold">{formatEuro(p.market_value)}</dd></div>
            <div><dt className="text-xs uppercase text-cream-dim">Vertrag</dt><dd className="display text-lg font-bold">{p.contract ? `${p.contract.start}–${p.contract.end}` : '–'}</dd></div>
            <div><dt className="text-xs uppercase text-cream-dim">Gehalt / Jahr</dt><dd className="display text-lg font-bold">{p.contract?.salary ? formatEuro(p.contract.salary) : p.own ? '–' : 'nicht einsehbar'}</dd></div>
            <div><dt className="text-xs uppercase text-cream-dim">Fitness</dt><dd className={`display text-lg font-bold ${p.fitness < 60 ? 'text-danger' : p.fitness < 80 ? 'text-gold' : 'text-emerald-300'}`}>{Math.round(p.fitness)} %</dd></div>
          </dl>
          {p.attributes && (
            <>
              <h2 className="display mb-2 mt-5 text-xl font-bold uppercase">Attribute</h2>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                {Object.entries(p.attributes.values).map(([k, v]) => (
                  <div key={k}>
                    <div className="flex justify-between text-xs"><span className="text-cream-dim">{ATTR_LABEL[k] ?? k}</span><span className="font-semibold tabular-nums">{v}</span></div>
                    <div className="h-1.5 rounded bg-anthracite"><div className={`h-1.5 rounded ${v >= 75 ? 'bg-emerald-400' : v >= 60 ? 'bg-gold' : 'bg-danger'}`} style={{ width: `${v}%` }} /></div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
        <div className="space-y-4">
          {dev.length > 0 && (
            <Card>
              <h2 className="display mb-2 text-xl font-bold uppercase">Entwicklung</h2>
              <ul className="space-y-3 text-sm">
                {dev.map((d) => (
                  <li key={d.season_year} className="rounded-lg bg-olive-800/60 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">Saison {d.season_year}/{String((d.season_year + 1) % 100).padStart(2, '0')}{d.live ? ' (läuft)' : ''}</span>
                      <span className="tabular-nums">OVR {d.ovr_start} → {d.ovr_end ?? d.ovr_start}{d.ovr_after_aging != null && d.ovr_after_aging !== d.ovr_end ? ` → ${d.ovr_after_aging} (Alter)` : ''}</span>
                    </div>
                    <div className="mt-1"><AttrChanges values={d.gains} tone="good" /></div>
                    {Object.keys(d.declines ?? {}).length > 0 && <div className="mt-1"><AttrChanges values={d.declines} tone="bad" /></div>}
                    <p className="mt-1 text-xs text-cream-dim">XP: {fmt(d.training_xp, 1)} aus {d.training_sessions} Trainingseinheiten · {fmt(d.match_xp, 1)} aus {d.matches} Pflichtspielen</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase">Saison</h2>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[['Spiele', p.season.apps], ['Tore', p.season.goals], ['Vorlagen', p.season.assists], ['Ø Note', fmt(p.season.rating)]].map(([k, v]) => (
                <div key={k as string} className="rounded-lg bg-olive-800/70 p-2"><p className="text-[11px] uppercase text-cream-dim">{k}</p><p className="display text-2xl font-bold">{v}</p></div>
              ))}
            </div>
            {p.by_competition.length > 0 && (
              <table className="mt-3 w-full text-sm"><tbody>
                {p.by_competition.map((c) => <tr key={c.competition} className="border-t border-olive-800"><td className="py-1">{c.competition}</td><td className="text-right">{c.apps} Sp.</td><td className="text-right">{c.goals} T</td><td className="text-right">{c.assists} V</td><td className="text-right">{fmt(c.rating)}</td></tr>)}
              </tbody></table>
            )}
          </Card>
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase">Letzte Spiele</h2>
            <ul className="space-y-1 text-sm">
              {p.recent.map((r, i) => (
                <li key={i} className="flex items-center gap-2"><span className="w-14 text-xs text-cream-dim">{new Date(r.date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
                  <ClubLogo club={r.opponent} size={18} /><ClubLink club={r.opponent} className="min-w-0 flex-1 truncate" />
                  <span className="text-xs text-cream-dim">{r.minutes}'{r.goals ? ` · ${r.goals} T` : ''}{r.assists ? ` · ${r.assists} V` : ''}</span>
                  <span className="display w-9 text-right font-bold">{fmt(r.rating, 1)}</span></li>
              ))}
              {p.recent.length === 0 && <li className="text-cream-dim">Noch keine Einsätze in freigegebenen Spielen.</li>}
            </ul>
          </Card>
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase">Entwicklung</h2>
            {p.history.length > 0 ? (
              <table className="w-full text-sm"><thead className="text-left text-[11px] uppercase text-cream-dim"><tr><th>Saison</th><th className="text-right">Sp</th><th className="text-right">T</th><th className="text-right">V</th><th className="text-right">Ø</th></tr></thead><tbody>
                {p.history.map((h) => <tr key={h.season} className="border-t border-olive-800"><td className="py-1">{h.season}/{String(h.season + 1).slice(2)}</td><td className="text-right">{h.apps}</td><td className="text-right">{h.goals}</td><td className="text-right">{h.assists}</td><td className="text-right">{fmt(h.rating)}</td></tr>)}
              </tbody></table>
            ) : <p className="text-sm text-cream-dim">Noch keine Saisonbilanz.</p>}
            {p.development && <p className="mt-2 text-sm text-cream-dim">Zusatztraining diese Saison: {p.development.trainings} · Entwicklungspunkte: {fmt(p.development.points)}</p>}
          </Card>
        </div>
      </div>
    </Shell>
  );
}
