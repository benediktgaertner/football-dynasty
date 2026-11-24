import { PlayerLink } from '../links';
import { StatusBadges } from './PlayerStatus';
import {
  CORNER_ROUTINES,
  DEFENSIVE_SET_PIECES,
  MAX_SET_PIECE_PRIORITY,
  MAX_TRAINEES_PER_WEEK,
  POSITIONS,
  SET_PIECE_ATTRIBUTE,
  SET_PIECE_KINDS,
  TRAINING_FOCI,
  effectiveRating,
  fitnessPerformanceMultiplier,
  devAgeFactor,
  type Position,
  type SetPieceKind,
} from '@fd/shared';
import { useMemo, useState } from 'react';
import { formatEuro } from '../../lib/api';
import type { ClubTactics, SponsorOffer, SquadPlayer, TeamContext } from '../../lib/teamApi';
import { PlayerAvatar } from '../PlayerAvatar';
import { Button, Card, ErrorBanner, Pill } from '../ui';
import { POS_LABEL, ratingTone } from './PitchEditor';

export const ATTR_LABEL: Record<string, string> = {
  pace: 'Tempo', shooting: 'Schießen', passing: 'Passen', dribbling: 'Dribbling', defending: 'Verteidigung', physical: 'Physis',
  stamina: 'Ausdauer', gameIntelligence: 'Spielintelligenz', heading: 'Kopfball', mentality: 'Mentalität', freeKicks: 'Freistöße',
  penalties: 'Elfmeter', corners: 'Eckbälle', crossing: 'Flanken', throwIns: 'Einwürfe', reflexes: 'Reflexe', handling: 'Fangen',
  positioning: 'Stellungsspiel', oneOnOne: 'Eins gegen eins', commandOfArea: 'Strafraumbeherrschung', distribution: 'Spieleröffnung',
  kicking: 'Abschläge', reactionSpeed: 'Reaktion',
};

function FitnessBar({ value }: { value: number }) {
  const color = value >= 80 ? 'bg-pitch-light' : value >= 60 ? 'bg-gold' : value >= 40 ? 'bg-sunset' : 'bg-danger';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 rounded bg-anthracite"><div className={`h-2 rounded ${color}`} style={{ width: `${value}%` }} /></div>
      <span className="w-8 text-right text-xs tabular-nums text-cream-dim">{Math.round(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spielerprofil
// ---------------------------------------------------------------------------
export function PlayerProfile({ player, kit, onClose, onShirtNumber }: { player: SquadPlayer; kit: { primary: string; secondary: string }; onClose: () => void; onShirtNumber: (number: number) => Promise<void> }) {
  const [number, setNumber] = useState(String(player.shirt_number ?? ''));
  const [numberError, setNumberError] = useState<string | null>(null);
  const [savingNumber, setSavingNumber] = useState(false);
  const positions = POSITIONS.filter((p) => (player.main_position === 'GK') === (p === 'GK')) as Position[];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4" onClick={onClose} role="dialog" aria-modal>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl border border-olive-600 bg-olive-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-5">
          <PlayerAvatar id={player.id} nationality={player.nationality} age={player.age} size={110} shirt={kit.primary} collar={kit.secondary} />
          <div className="flex-1">
            <div className="display text-sm font-semibold uppercase tracking-[0.2em] text-gold">#{player.shirt_number} · {POS_LABEL[player.main_position]}</div>
            <h2 className="display text-4xl font-extrabold uppercase leading-none">{player.first_name} {player.last_name}</h2>
            <div className="mt-1 text-cream-dim">{player.nationality} · {player.age} Jahre</div>
            <div className="mt-3"><FitnessBar value={player.fitness} /></div>
          </div>
          <div className="display text-6xl font-extrabold text-gold">{player.overall}</div>
        </div>
        <form className="mt-5 flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          const value = Number(number);
          if (!Number.isInteger(value) || value < 1 || value > 99) { setNumberError('Bitte eine Nummer von 1 bis 99 eingeben.'); return; }
          setSavingNumber(true);
          setNumberError(null);
          void onShirtNumber(value).catch((error: unknown) => setNumberError(error instanceof Error ? error.message : 'Nummer konnte nicht gespeichert werden.')).finally(() => setSavingNumber(false));
        }}>
          <label className="text-sm">Trikotnummer
            <input className="ml-2 w-20 rounded-lg border border-olive-600 bg-anthracite px-3 py-2 text-cream" type="number" min="1" max="99" required value={number} onChange={(event) => setNumber(event.target.value)} />
          </label>
          <Button type="submit" busy={savingNumber}>Nummer speichern</Button>
          {numberError && <p role="alert" className="w-full text-sm text-danger">{numberError}</p>}
        </form>
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
          {Object.entries(player.attributes).map(([k, v]) => (
            <div key={k}>
              <div className="flex justify-between text-xs"><span className="text-cream-dim">{ATTR_LABEL[k] ?? k}</span><span className="tabular-nums">{v}</span></div>
              <div className="h-1.5 rounded bg-anthracite"><div className="h-1.5 rounded bg-pitch-light" style={{ width: `${v}%` }} /></div>
            </div>
          ))}
        </div>
        <div className="mt-5">
          <div className="display mb-2 text-sm font-semibold uppercase tracking-wider text-cream-dim">Stärke auf anderen Positionen</div>
          <div className="flex flex-wrap gap-1.5">
            {positions.map((p) => {
              const r = effectiveRating(player, p);
              return (
                <span key={p} className={`display rounded px-2 py-0.5 text-sm font-semibold ${ratingTone(r - player.overall)}`}>
                  {POS_LABEL[p]} {r}
                </span>
              );
            })}
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-3 rounded-xl bg-anthracite p-4 text-center text-sm">
          <div><dt className="text-xs uppercase text-cream-dim">Marktwert</dt><dd className="display text-lg font-bold">{formatEuro(player.market_value)}</dd></div>
          <div><dt className="text-xs uppercase text-cream-dim">Gehalt / Jahr</dt><dd className="display text-lg font-bold">{player.salary ? formatEuro(player.salary) : '–'}</dd></div>
          <div><dt className="text-xs uppercase text-cream-dim">Vertrag bis</dt><dd className="display text-lg font-bold">{player.contract_end ?? '–'}</dd></div>
        </dl>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <PlayerLink id={player.id} className="display flex min-h-11 items-center justify-center rounded-xl bg-gold px-4 font-semibold uppercase text-ink !no-underline">Vollständiges Profil</PlayerLink>
          <Button variant="secondary" onClick={onClose}>Schließen</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kader
// ---------------------------------------------------------------------------
export function SquadTab({ squad, kit, onOpen }: { squad: SquadPlayer[]; kit: { primary: string; secondary: string }; onOpen: (p: SquadPlayer) => void }) {
  const avg = squad.length ? squad.reduce((s, p) => s + p.overall, 0) / squad.length : 0;
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-olive-700 p-4">
        <h2 className="display text-2xl font-bold uppercase">Kader</h2>
        <Pill>{squad.length} Spieler</Pill>
        <Pill tone="gold">Ø Stärke {avg.toLocaleString('de-DE', { maximumFractionDigits: 1 })}</Pill>
        <Pill>Gehälter {formatEuro(squad.reduce((s, p) => s + (p.salary ?? 0), 0))} / Jahr</Pill>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-left">
          <thead className="text-xs uppercase tracking-wider text-cream-dim">
            <tr>
              {['#', 'Pos', 'Name', 'Alter', 'Stärke', 'Fitness', 'Marktwert', 'Gehalt', 'Vertrag'].map((h) => (
                <th key={h} className="display px-3 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {squad.map((p) => (
              <tr key={p.id} onClick={() => onOpen(p)} className="cursor-pointer border-t border-olive-800 hover:bg-olive-800/60">
                <td className="display px-3 py-2 text-lg font-bold text-cream-dim">{p.shirt_number}</td>
                <td className="px-3 py-2"><span className="display rounded bg-olive-700 px-2 py-0.5 text-sm font-semibold">{POS_LABEL[p.main_position]}</span></td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-3">
                    <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={36} shirt={kit.primary} collar={kit.secondary} />
                    <div>
                      <div className="font-semibold">{p.first_name} {p.last_name}</div>
                      <div className="text-xs text-cream-dim">{p.nationality}{p.secondary_positions.length > 0 && ` · auch ${p.secondary_positions.map((x) => POS_LABEL[x]).join(', ')}`}</div>
                      <StatusBadges s={p.status} />
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2 tabular-nums">{p.age}</td>
                <td className="display px-3 py-2 text-2xl font-extrabold text-gold">{p.overall}</td>
                <td className="px-3 py-2"><FitnessBar value={p.fitness} /></td>
                <td className="px-3 py-2 tabular-nums">{formatEuro(p.market_value)}</td>
                <td className="px-3 py-2 text-sm tabular-nums text-cream-dim">{p.salary ? formatEuro(p.salary) : '–'}</td>
                <td className="px-3 py-2 tabular-nums text-cream-dim">{p.contract_end ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Standards (F9)
// ---------------------------------------------------------------------------
export function SetPiecesTab({
  squad,
  setPieces,
  setSetPieces,
  clubTactics,
  setClubTactics,
  onSave,
}: {
  squad: SquadPlayer[];
  setPieces: Record<string, string[]>;
  setSetPieces: (sp: Record<string, string[]>) => void;
  clubTactics: ClubTactics;
  setClubTactics: (t: ClubTactics) => void;
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function setTaker(kind: SetPieceKind, priority: number, playerId: string) {
    const list = [...(setPieces[kind] ?? [])];
    list[priority] = playerId;
    // doppelte Einträge innerhalb einer Art entfernen
    const cleaned = list.map((id, i) => (id && list.indexOf(id) === i ? id : ''));
    setSetPieces({ ...setPieces, [kind]: cleaned });
    setNotice(null);
  }

  function suggest() {
    const next: Record<string, string[]> = {};
    for (const { kind } of SET_PIECE_KINDS) {
      const attr = SET_PIECE_ATTRIBUTE[kind];
      next[kind] = [...squad]
        .filter((p) => p.kind === 'outfield')
        .sort((a, b) => (b.attributes[attr] ?? 0) - (a.attributes[attr] ?? 0))
        .slice(0, MAX_SET_PIECE_PRIORITY)
        .map((p) => p.id);
    }
    setSetPieces(next);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-2xl font-bold uppercase">Standardschützen</h2>
          <Button variant="secondary" onClick={suggest}>Beste vorschlagen</Button>
        </div>
        <div className="space-y-4">
          {SET_PIECE_KINDS.map(({ kind, label }) => {
            const attr = SET_PIECE_ATTRIBUTE[kind];
            const options = [...squad].sort((a, b) => (b.attributes[attr] ?? 0) - (a.attributes[attr] ?? 0));
            return (
              <div key={kind}>
                <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">{label} <span className="normal-case">(nach {ATTR_LABEL[attr]})</span></div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {Array.from({ length: MAX_SET_PIECE_PRIORITY }, (_, i) => (
                    <select
                      key={i}
                      value={setPieces[kind]?.[i] ?? ''}
                      onChange={(e) => setTaker(kind, i, e.target.value)}
                      className="min-h-10 rounded-lg border border-olive-600 bg-anthracite px-2 text-sm text-cream"
                      aria-label={`${label} ${i + 1}. Wahl`}
                    >
                      <option value="">{i === 0 ? '1. Schütze' : `${i + 1}. Ersatz`}</option>
                      {options.map((p) => (
                        <option key={p.id} value={p.id}>{p.last_name} ({p.attributes[attr] ?? '–'})</option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <Card className="space-y-4">
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">Eckballvariante</div>
          <div className="flex flex-wrap gap-1">
            {CORNER_ROUTINES.map((c) => (
              <button key={c.value} type="button" onClick={() => setClubTactics({ ...clubTactics, corner_routine: c.value })} className={`min-h-9 rounded-lg px-3 text-sm ${clubTactics.corner_routine === c.value ? 'bg-gold font-semibold text-ink' : 'bg-anthracite text-cream-dim'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">Defensive Standards</div>
          <div className="flex flex-wrap gap-1">
            {DEFENSIVE_SET_PIECES.map((c) => (
              <button key={c.value} type="button" onClick={() => setClubTactics({ ...clubTactics, defensive_set_piece: c.value })} className={`min-h-9 rounded-lg px-3 text-sm ${clubTactics.defensive_set_piece === c.value ? 'bg-gold font-semibold text-ink' : 'bg-anthracite text-cream-dim'}`}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <Button
          className="w-full"
          busy={busy}
          onClick={() => void (async () => { setBusy(true); setError(null); try { await onSave(); setNotice('Standards gespeichert.'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } })()}
        >
          Standards speichern
        </Button>
        {notice && <p className="text-sm text-pitch-light">{notice}</p>}
        <ErrorBanner error={error} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Training (G1/G4)
// ---------------------------------------------------------------------------
/** OVR-Badge: grün ≥ 75, gelb 65–74, rot < 65 */
export function OvrBadge({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' }) {
  const tone = value >= 75 ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200' : value >= 65 ? 'border-gold/60 bg-gold/15 text-gold' : 'border-danger/60 bg-danger/15 text-red-200';
  return (
    <span className={`display inline-flex items-center justify-center rounded-md border font-bold tabular-nums ${tone} ${size === 'sm' ? 'h-6 min-w-8 px-1 text-sm' : 'h-8 min-w-10 px-1.5 text-lg'}`} title="Gesamtstärke (OVR)">
      {value}
    </span>
  );
}

type TrainSort = 'overall' | 'age' | 'dev' | 'fitness';
const TRAIN_SORT: Array<{ key: TrainSort; label: string }> = [
  { key: 'overall', label: 'Stärke' }, { key: 'age', label: 'Alter' }, { key: 'dev', label: 'Entwicklung' }, { key: 'fitness', label: 'Fitness' },
];

type TrainResult = { points?: number; total?: number; gains?: Record<string, number>; ovrBefore?: number; ovrAfter?: number };

export function TrainingTab({ squad, ctx, kit, onTrain }: { squad: SquadPlayer[]; ctx: TeamContext; kit: { primary: string; secondary: string }; onTrain: (playerId: string, focus: string) => Promise<TrainResult | void> }) {
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<TrainSort>('overall');
  const [gain, setGain] = useState<Record<string, { points: number; total: number; gains: Record<string, number>; ovrBefore?: number; ovrAfter?: number }>>({});
  const trained = new Map(ctx.trainees_this_week.map((t) => [t.player_id, t.focus]));
  const used = ctx.trainees_this_week.length;
  const focusLabel = (v: string) => TRAINING_FOCI.find((f) => f.value === v)?.label ?? v;
  const sorted = [...squad].sort((x, y) =>
    sort === 'overall' ? y.overall - x.overall
      : sort === 'age' ? x.age - y.age
        : sort === 'dev' ? devAgeFactor(y.age) - devAgeFactor(x.age) || y.overall - x.overall
          : y.fitness - x.fitness);
  const fmt = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-olive-700 p-4">
        <h2 className="display text-2xl font-bold uppercase">Zusatztraining</h2>
        <Pill tone={used >= MAX_TRAINEES_PER_WEEK ? 'warn' : 'gold'}>{used}/{MAX_TRAINEES_PER_WEEK} diese Woche</Pill>
        <span className="text-sm text-cream-dim">{ctx.week === 0 ? 'Saisonvorbereitung' : `Woche ${ctx.week}`} · jede Einheit kostet 20 Fitness · XP steigern sofort die passenden Attribute</span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Sortierung">
          <span className="mr-1 text-xs uppercase text-cream-dim">Sortieren</span>
          {TRAIN_SORT.map((o) => (
            <button key={o.key} type="button" onClick={() => setSort(o.key)} aria-pressed={sort === o.key}
              className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${sort === o.key ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}>{o.label}</button>
          ))}
        </div>
      </div>
      <div className="px-4 pt-3"><ErrorBanner error={error} /></div>
      <div className="hidden grid-cols-[minmax(0,2.4fr)_70px_110px_150px_minmax(0,2fr)] gap-3 px-4 pb-1 pt-3 text-[11px] uppercase tracking-wide text-cream-dim lg:grid">
        <span>Spieler</span><span>Alter</span><span>Entwicklung</span><span>Fitness</span><span>Training</span>
      </div>
      <ul className="divide-y divide-olive-800">
        {sorted.map((p) => {
          const done = trained.get(p.id);
          const g = gain[p.id];
          const mult = devAgeFactor(p.age);
          return (
            <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-2 lg:grid-cols-[minmax(0,2.4fr)_70px_110px_150px_minmax(0,2fr)]">
              <div className="flex min-w-0 items-center gap-3">
                <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={34} shirt={kit.primary} collar={kit.secondary} />
                <OvrBadge value={p.overall} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{p.first_name} {p.last_name}</div>
                  <div className="text-xs text-cream-dim">{POS_LABEL[p.main_position]}<span className="lg:hidden"> · {p.age} J. · ×{fmt(mult)}</span></div>
                </div>
              </div>
              <span className="hidden text-sm tabular-nums lg:block">{p.age} J.</span>
              <span className={`hidden w-fit rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums lg:block ${mult >= 1.3 ? 'bg-emerald-500/15 text-emerald-300' : mult >= 1 ? 'bg-olive-800 text-cream' : 'bg-olive-800 text-cream-dim'}`} title="Entwicklungstempo nach Alter">×{fmt(mult)}</span>
              <div className="col-span-2 lg:col-span-1"><FitnessBar value={p.fitness} /></div>
              <div className="col-span-2 flex flex-wrap items-center gap-2 lg:col-span-1">
                {done ? (
                  <>
                    <Pill tone="good">Trainiert: {focusLabel(done)}</Pill>
                    {g && <span className="text-sm font-semibold text-emerald-300" title="Entwicklungspunkte (XP)">+{fmt(g.points)} XP
                      {Object.entries(g.gains).map(([k, v]) => <span key={k} className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs">{ATTR_LABEL[k] ?? k} +{v}</span>)}
                      {g.ovrAfter != null && g.ovrBefore != null && g.ovrAfter > g.ovrBefore && <span className="ml-1 rounded bg-gold px-1.5 py-0.5 text-xs text-ink">OVR {g.ovrBefore} → {g.ovrAfter}</span>}
                    </span>}
                  </>
                ) : (
                  <>
                    <select value={focus[p.id] ?? 'technique'} onChange={(e) => setFocus({ ...focus, [p.id]: e.target.value })} className="min-h-9 min-w-0 flex-1 rounded-lg border border-olive-600 bg-anthracite px-2 text-sm text-cream" aria-label={`Schwerpunkt für ${p.last_name}`}>
                      {TRAINING_FOCI.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      className="!min-h-9 !px-3 !text-sm"
                      disabled={used >= MAX_TRAINEES_PER_WEEK}
                      busy={busy === p.id}
                      onClick={() => void (async () => {
                        if (p.fitness < 40 && !window.confirm(`${p.last_name} hat nur noch ${Math.round(p.fitness)} Fitness. Trotzdem trainieren?`)) return;
                        setBusy(p.id); setError(null);
                        try {
                          const r = await onTrain(p.id, focus[p.id] ?? 'technique');
                          if (r && typeof r.points === 'number') setGain((x) => ({ ...x, [p.id]: { points: r.points!, total: r.total ?? r.points!, gains: r.gains ?? {}, ovrBefore: r.ovrBefore, ovrAfter: r.ovrAfter } }));
                        } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
                      })()}
                    >
                      Trainieren
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="p-4 text-xs text-cream-dim">Training sammelt Entwicklungspunkte (junge Spieler schneller). Die Gesamtstärke wird immer aus der Datenbank geladen und nach Training und Spieltagsfreigabe sofort aktualisiert. Leistung bei niedriger Fitness: z. B. 60 Fitness → ×{fitnessPerformanceMultiplier(60).toLocaleString('de-DE')}.</p>
    </Card>
  );
}

export function describeSponsor(o: SponsorOffer): string {
  const m = formatEuro(o.amount);
  switch (o.kind) {
    case 'per_league_match': return `${m} pro Ligaspiel`;
    case 'per_league_win': return `${m} pro Ligasieg`;
    case 'per_league_point': return `${m} pro Ligapunkt`;
    case 'per_league_goal': return `${m} pro erzieltem Ligator`;
    case 'max_goals_against': return `${m} bei höchstens ${o.threshold} Gegentoren`;
    case 'placement_at_most': return `${m} für Platz 1–${o.threshold}`;
    case 'promotion': return `${m} bei Aufstieg`;
    case 'champion': return `${m} nur bei Platz 1`;
    default: return m;
  }
}

export function SeasonTab({ ctx, onChoose, onReady, myUserId }: { ctx: TeamContext; onChoose: (id: number) => Promise<void>; onReady: (ready: boolean) => Promise<void>; myUserId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = ctx.readiness.find((r) => r.user_id === myUserId);
  const run = (key: string, fn: () => Promise<void>) =>
    void (async () => { setBusy(key); setError(null); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } })();
  const sorted = useMemo(() => [...ctx.sponsor_offers].sort((a, b) => a.id - b.id), [ctx.sponsor_offers]);
  const locked = ctx.world_status !== 'preseason';

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <h2 className="display mb-1 text-2xl font-bold uppercase">Sponsor {ctx.season_year}/{String(ctx.season_year + 1).slice(2)}</h2>
        <p className="mb-4 text-sm text-cream-dim">Genau ein Vertrag pro Saison ({ctx.league}). Nicht erreichte Ziele bringen kein Geld, kosten aber auch nichts.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {sorted.map((o) => {
            const chosen = ctx.sponsor_offer_id === o.id;
            return (
              <button
                key={o.id}
                type="button"
                disabled={locked || busy !== null}
                onClick={() => run(`s${o.id}`, () => onChoose(o.id))}
                className={`rounded-xl border p-4 text-left transition ${chosen ? 'border-gold bg-gold/10' : 'border-olive-600 bg-anthracite hover:border-gold/60'}`}
              >
                <div className="display text-xl font-bold">{o.name}</div>
                <div className="text-cream-dim">{describeSponsor(o)}</div>
                {chosen && <div className="mt-2"><Pill tone="gold">Gewählt</Pill></div>}
              </button>
            );
          })}
        </div>
      </Card>
      <Card className="space-y-3">
        <h2 className="display text-2xl font-bold uppercase">Saisonstart</h2>
        <p className="text-sm text-cream-dim">Bestätige, wenn Sponsor und Aufstellung deines aktiven Taktikprofils stehen.</p>
        <ul className="space-y-2">
          {ctx.readiness.map((r) => (
            <li key={r.user_id} className="flex items-center justify-between gap-2">
              <span className="truncate">{r.club ?? r.username} <span className="text-xs text-cream-dim">({r.username})</span></span>
              <Pill tone={r.ready ? 'good' : 'warn'}>{r.ready ? 'Bereit' : 'Wartet'}</Pill>
            </li>
          ))}
        </ul>
        <Button className="w-full" variant={me?.ready ? 'secondary' : 'primary'} disabled={locked} busy={busy === 'ready'} onClick={() => run('ready', () => onReady(!me?.ready))}>
          {me?.ready ? 'Bereitschaft zurückziehen' : 'Bereit für den Saisonstart'}
        </Button>
        <ErrorBanner error={error} />
        <p className="text-xs text-cream-dim">Sind alle bereit, werden Spielplan und Pokal ausgelost. Danach geht es im Menü unter „Spieltag“ weiter. Testspiele gibt es jederzeit im Reiter „Spiele“.</p>
      </Card>
    </div>
  );
}
