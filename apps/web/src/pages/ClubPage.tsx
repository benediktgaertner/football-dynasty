import { readableTextColor } from '@fd/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { ClubLink, ClubLogo, PlayerLink } from '../components/links';
import { OvrBadge } from '../components/team/OtherTabs';
import { POS_LABEL } from '../components/team/PitchEditor';
import { StatusIcon } from '../components/team/PlayerStatus';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type ClubProfileData } from '../lib/seasonApi';

/** Vereinsprofil (Scouting): Kader, Stärke, zuletzt bekannte Formation, Ergebnisse – ohne geheime Taktikdaten */
export function ClubPage() {
  const { worldId = '', clubId = '' } = useParams();
  const navigate = useNavigate();
  const [c, setC] = useState<ClubProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setC(null); void seasonApi.clubProfile(clubId).then(setC).catch((e) => setError((e as Error).message)); }, [clubId]);
  if (!c) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Vereinsprofil wird geladen …" />}</Shell>;
  const gf = c.results.reduce((s, r) => s + r.gf, 0), ga = c.results.reduce((s, r) => s + r.ga, 0);
  const w = c.results.filter((r) => r.gf > r.ga).length, d = c.results.filter((r) => r.gf === r.ga).length, l = c.results.length - w - d;
  const kit = c.club.color ?? '#1d4ed8';
  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <Button variant="ghost" className="mb-2" onClick={() => navigate(-1)}>← Zurück</Button>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-5">
          <ClubLogo club={c.club} size={96} />
          <div className="min-w-0 flex-1">
            <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">{c.country?.name}{c.league ? ` · ${c.league}` : ''}</p>
            <h1 className="display text-4xl font-extrabold uppercase leading-none">{c.club.name}</h1>
            <p className="mt-1 text-cream-dim">{c.founded ? `gegr. ${c.founded} · ` : ''}{c.stadium ? `${c.stadium.name} (${c.stadium.capacity.toLocaleString('de-DE')} Plätze)` : ''}{c.manager ? ` · Manager: ${c.manager}` : ' · KI-Verein'}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-olive-800 p-3"><p className="text-[11px] uppercase text-cream-dim">Tabelle</p><p className="display text-3xl font-bold">{c.position ? `${c.position}.` : '–'}</p></div>
            <div className="rounded-xl bg-olive-800 p-3"><p className="text-[11px] uppercase text-cream-dim">Stärke Top-11</p><p className="display text-3xl font-bold">{c.strength ?? '–'}</p></div>
            <div className="rounded-xl bg-olive-800 p-3"><p className="text-[11px] uppercase text-cream-dim">Tore</p><p className="display text-3xl font-bold">{gf}:{ga}</p></div>
          </div>
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card className="overflow-x-auto p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-olive-700 p-4"><h2 className="display text-2xl font-bold uppercase">Kader</h2><Pill>{c.squad.length} Spieler</Pill><Pill tone="gold">Ø {c.squad_avg}</Pill></div>
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-[11px] uppercase text-cream-dim"><tr><th className="px-3 py-2">#</th><th>Pos</th><th>Name</th><th>Alter</th><th>Stärke</th><th className="text-right">Sp</th><th className="text-right">T</th><th className="text-right">V</th><th className="px-3 text-right">Ø Note</th></tr></thead>
            <tbody>
              {c.squad.map((p) => (
                <tr key={p.id} className="border-t border-olive-800">
                  <td className="px-3 py-1.5 text-cream-dim">{p.shirt ?? ''}</td>
                  <td><span className="display rounded bg-olive-700 px-1.5 text-xs font-semibold">{POS_LABEL[p.position] ?? p.position}</span></td>
                  <td><PlayerLink id={p.id} className="font-semibold">{p.name}</PlayerLink> <StatusIcon s={p.status ?? undefined} /></td>
                  <td className="tabular-nums">{p.age}</td>
                  <td><OvrBadge value={p.overall} size="sm" /></td>
                  <td className="text-right tabular-nums">{p.apps}</td>
                  <td className="text-right tabular-nums">{p.goals}</td>
                  <td className="text-right tabular-nums">{p.assists}</td>
                  <td className="px-3 text-right tabular-nums">{p.rating ? Number(p.rating).toLocaleString('de-DE', { minimumFractionDigits: 2 }) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="space-y-4">
          <Card>
            <h2 className="display mb-1 text-xl font-bold uppercase">Zuletzt bekannte Formation</h2>
            {c.formation ? (
              <>
                <p className="mb-2 text-sm text-cream-dim">{c.formation.code} · Startelf vom {new Date(c.formation.date + 'T12:00:00').toLocaleDateString('de-DE')}</p>
                <div className="pitch-stripes relative mx-auto w-full max-w-[340px] overflow-hidden rounded-2xl border-2 border-cream/50" style={{ aspectRatio: '68 / 100' }}>
                  <div className="absolute inset-x-[20%] bottom-0 h-[16%] border-2 border-b-0 border-cream/40" />
                  <div className="absolute inset-x-[20%] top-0 h-[16%] border-2 border-t-0 border-cream/40" />
                  <div className="absolute left-0 right-0 top-1/2 border-t-2 border-cream/40" />
                  {c.formation.slots.map((s) => (
                    <div key={s.player_id} className="absolute flex w-[22%] -translate-x-1/2 -translate-y-1/2 flex-col items-center" style={{ left: `${s.x}%`, top: `${100 - s.y}%` }}>
                      <PlayerLink id={s.player_id} className="flex flex-col items-center">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-bold shadow" style={{ background: kit, borderColor: c.club.color2 ?? '#fff', color: readableTextColor(kit) }}>{s.shirt ?? ''}</span>
                        <span className="mt-0.5 rounded bg-ink/70 px-1 text-[10px] font-semibold uppercase text-gold">{POS_LABEL[s.position] ?? s.position}</span>
                        <span className="max-w-full truncate rounded bg-ink/60 px-1 text-[11px] text-cream">{s.name ?? '–'}</span>
                      </PlayerLink>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-cream-dim">Öffentlich nur die Startelf aus freigegebenen Spielen – Taktikeinstellungen und Anweisungen bleiben geheim.</p>
              </>
            ) : <p className="text-sm text-cream-dim">Noch keine bekannte Formation (erst nach einem freigegebenen Pflichtspiel).</p>}
          </Card>
          <Card>
            <h2 className="display mb-1 text-xl font-bold uppercase">Ergebnisse</h2>
            <p className="mb-2 text-sm text-cream-dim">{w} S · {d} U · {l} N · Tore {gf}:{ga}</p>
            <ul className="space-y-1 text-sm">
              {c.results.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className="w-12 text-xs text-cream-dim">{new Date(r.date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</span>
                  <span className="w-4 text-xs font-bold text-cream-dim">{r.home ? 'H' : 'A'}</span>
                  <ClubLogo club={r.opponent} size={18} /><ClubLink club={r.opponent} className="min-w-0 flex-1 truncate" />
                  <span className={`display w-14 text-right font-bold tabular-nums ${r.gf > r.ga ? 'text-emerald-300' : r.gf < r.ga ? 'text-danger' : ''}`}>{r.gf}:{r.ga}{r.pf !== null ? '*' : ''}</span>
                </li>
              ))}
              {c.results.length === 0 && <li className="text-cream-dim">Noch keine Pflichtspiele in dieser Saison.</li>}
            </ul>
          </Card>
        </div>
      </div>
    </Shell>
  );
}
