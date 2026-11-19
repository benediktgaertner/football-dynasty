import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { ClubLink, ClubLogo, PlayerLink } from '../components/links';
import { ATTR_LABEL, OvrBadge } from '../components/team/OtherTabs';
import { POS_LABEL } from '../components/team/PitchEditor';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { seasonApi, type DevelopmentReport, type DevelopmentRow } from '../lib/seasonApi';

const fmt = (n: number) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1 });
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** Attributänderungen kompakt: „Passen +2 · Dribbling +1“ */
export function AttrChanges({ values, tone }: { values: Record<string, number>; tone: 'good' | 'bad' }) {
  const entries = Object.entries(values ?? {}).filter(([, v]) => v !== 0).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (entries.length === 0) return <span className="text-cream-dim">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tone === 'good' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-danger/15 text-danger'}`}>
          {ATTR_LABEL[k] ?? k} {signed(v)}
        </span>
      ))}
    </span>
  );
}

function DeltaChip({ value }: { value: number }) {
  const cls = value > 0 ? 'bg-emerald-500/20 text-emerald-300' : value < 0 ? 'bg-danger/20 text-danger' : 'bg-olive-800 text-cream-dim';
  return <span className={`display inline-block min-w-12 rounded-lg px-2 py-0.5 text-center text-lg font-bold tabular-nums ${cls}`}>{value > 0 ? `+${value}` : value === 0 ? '±0' : value}</span>;
}

/**
 * Jährlicher Entwicklungsbericht (G6): OVR zu Saisonbeginn und -ende, Verbesserungen aus Training und
 * Spielen (in der Saison) getrennt von altersbedingten Verschlechterungen (Saisonwechsel).
 * Für jeden Verein der Welt einsehbar – auch für KI-Vereine. Das Potenzial bleibt verborgen.
 */
export function Development() {
  const { worldId = '', clubId: clubParam } = useParams();
  const navigate = useNavigate();
  const [clubId, setClubId] = useState<string | null>(clubParam ?? null);
  const [season, setSeason] = useState<string | null>(null);
  const [rep, setRep] = useState<DevelopmentReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (clubParam) { setClubId(clubParam); return; }
    void seasonApi.matchday(worldId).then((s) => setClubId(s.my_club ?? null)).catch((e) => setError((e as Error).message));
  }, [worldId, clubParam]);
  useEffect(() => {
    if (!clubId) return;
    setRep(null);
    void seasonApi.developmentReport(worldId, clubId, season).then(setRep).catch((e) => setError((e as Error).message));
  }, [worldId, clubId, season]);

  const rows = rep?.players ?? [];
  const winners = useMemo(() => rows.filter((r) => r.delta > 0).slice(0, 3), [rows]);
  const losers = useMemo(() => [...rows].filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3), [rows]);
  const sum = (f: (r: DevelopmentRow) => number) => rows.reduce((s, r) => s + f(r), 0);

  if (!rep) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Entwicklungsbericht wird geladen …" />}</Shell>;
  const live = rep.season?.live ?? true;
  const avgStart = rows.length ? sum((r) => r.ovr_start) / rows.length : 0;
  const avgEnd = rows.length ? sum((r) => r.ovr_after_aging ?? r.ovr_end) / rows.length : 0;

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      {clubParam && <Button variant="ghost" className="mb-2" onClick={() => navigate(-1)}>← Zurück</Button>}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <ClubLogo club={rep.club} size={64} />
          <div className="min-w-0 flex-1">
            <p className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">Entwicklungsbericht{live ? ' · laufende Saison' : ''}</p>
            <h1 className="display text-3xl font-extrabold uppercase leading-none"><ClubLink club={rep.club} /> · Saison {rep.season ? `${rep.season.year}/${String((rep.season.year + 1) % 100).padStart(2, '0')}` : ''}</h1>
            <p className="mt-1 text-sm text-cream-dim">
              Verbesserungen entstehen während der Saison durch Zusatztraining und gute Leistungen in Pflichtspielen.
              Altersbedingte Verschlechterungen gibt es nur beim Saisonwechsel.
            </p>
          </div>
          {rep.seasons.length > 1 && (
            <select value={season ?? rep.season?.id ?? ''} onChange={(e) => setSeason(e.target.value)} aria-label="Saison wählen"
              className="min-h-11 rounded-lg border border-olive-600 bg-anthracite px-3 text-cream">
              {rep.seasons.map((s) => <option key={s.id} value={s.id}>Saison {s.year}/{String((s.year + 1) % 100).padStart(2, '0')}</option>)}
            </select>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-anthracite p-4 text-center text-sm sm:grid-cols-4">
          <div><dt className="text-xs uppercase text-cream-dim">Ø OVR Beginn → {live ? 'jetzt' : 'Ende'}</dt><dd className="display text-lg font-bold">{fmt(avgStart)} → {fmt(avgEnd)}</dd></div>
          <div><dt className="text-xs uppercase text-cream-dim">Verbesserte Spieler</dt><dd className="display text-lg font-bold text-emerald-300">{rows.filter((r) => r.ovr_end > r.ovr_start).length}</dd></div>
          <div><dt className="text-xs uppercase text-cream-dim">XP Training / Spiele</dt><dd className="display text-lg font-bold">{fmt(sum((r) => Number(r.training_xp)))} / {fmt(sum((r) => Number(r.match_xp)))}</dd></div>
          <div><dt className="text-xs uppercase text-cream-dim">Trainingseinheiten</dt><dd className="display text-lg font-bold">{sum((r) => r.training_sessions)}</dd></div>
        </dl>
      </Card>

      {(winners.length > 0 || losers.length > 0) && (
        <div className="mb-4 grid gap-4 md:grid-cols-2">
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase text-emerald-300">Größte Gewinner</h2>
            {winners.length === 0 ? <p className="text-cream-dim">Noch keine Verbesserungen.</p> : winners.map((r) => (
              <div key={r.player_id} className="flex items-center gap-3 py-1.5">
                <DeltaChip value={r.delta} />
                <div className="min-w-0 flex-1"><PlayerLink id={r.player_id} className="font-semibold">{r.name}</PlayerLink><div className="text-xs text-cream-dim">{r.age} J. · {POS_LABEL[r.position] ?? r.position} · OVR {r.ovr_start} → {r.ovr_after_aging ?? r.ovr_end}</div></div>
              </div>
            ))}
          </Card>
          <Card>
            <h2 className="display mb-2 text-xl font-bold uppercase text-danger">Größte Verlierer</h2>
            {losers.length === 0 ? <p className="text-cream-dim">{live ? 'Verschlechterungen gibt es erst beim Saisonwechsel.' : 'Niemand hat an Stärke verloren.'}</p> : losers.map((r) => (
              <div key={r.player_id} className="flex items-center gap-3 py-1.5">
                <DeltaChip value={r.delta} />
                <div className="min-w-0 flex-1"><PlayerLink id={r.player_id} className="font-semibold">{r.name}</PlayerLink><div className="text-xs text-cream-dim">{r.age} J. · {POS_LABEL[r.position] ?? r.position} · OVR {r.ovr_start} → {r.ovr_after_aging ?? r.ovr_end}</div></div>
              </div>
            ))}
          </Card>
        </div>
      )}

      <Card className="overflow-x-auto p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-olive-700 p-4">
          <h2 className="display text-2xl font-bold uppercase">Alle Kaderspieler</h2><Pill>{rows.length} Spieler</Pill>
        </div>
        <table className="w-full min-w-[980px] text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-cream-dim">
            <tr>
              <th className="px-4 py-2">Spieler</th><th>Alter</th><th>Pos.</th><th>OVR Beginn</th><th>{live ? 'OVR jetzt' : 'Saisonende'}</th>
              {!live && <th>nach Alterung</th>}<th>±</th><th>Verbessert (Saison)</th><th>Verschlechtert (Saisonwechsel)</th><th className="pr-4 text-right">XP Training · Spiele</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-olive-800">
            {rows.map((r) => (
              <tr key={r.player_id} className="align-top">
                <td className="px-4 py-2"><PlayerLink id={r.player_id} className="font-semibold">{r.name}</PlayerLink></td>
                <td className="py-2 tabular-nums">{r.age}</td>
                <td className="py-2">{POS_LABEL[r.position] ?? r.position}</td>
                <td className="py-2"><OvrBadge value={r.ovr_start} /></td>
                <td className="py-2"><OvrBadge value={r.ovr_end} /></td>
                {!live && <td className="py-2">{r.ovr_after_aging != null ? <OvrBadge value={r.ovr_after_aging} /> : '–'}</td>}
                <td className="py-2"><DeltaChip value={r.delta} /></td>
                <td className="max-w-[260px] py-2"><AttrChanges values={r.gains} tone="good" /></td>
                <td className="max-w-[220px] py-2"><AttrChanges values={r.declines} tone="bad" /></td>
                <td className="py-2 pr-4 text-right tabular-nums text-cream-dim">
                  {fmt(Number(r.training_xp))} <span className="text-xs">({r.training_sessions}×)</span> · {fmt(Number(r.match_xp))} <span className="text-xs">({r.matches} Sp.)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Shell>
  );
}
