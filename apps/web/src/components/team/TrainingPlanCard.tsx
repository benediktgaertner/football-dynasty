import { TRAINING_FOCI } from '@fd/shared';
import { useEffect, useState } from 'react';
import { seasonApi, type TrainingPlan } from '../../lib/seasonApi';
import type { SquadPlayer } from '../../lib/teamApi';
import { ATTR_LABEL } from './OtherTabs';
import { Button, Card, ErrorBanner, Pill } from '../ui';

const REASON: Record<string, string> = { injured: 'verletzt', not_in_club: 'nicht mehr im Verein', training_limit: 'Wochenlimit erreicht', already_trained: 'bereits trainiert' };

/**
 * Dauerhafter Trainingsplan (max. 5 Spieler): wird jede neue Spielwoche serverseitig automatisch
 * ausgeführt – gleiche Regeln wie das manuelle Training (1 Einheit je Spieler, −20 Fitness).
 */
export function TrainingPlanCard({ worldId, squad, onChanged }: { worldId: string; squad: SquadPlayer[]; onChanged?: () => void }) {
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [draft, setDraft] = useState<Array<{ player_id: string; focus: string; paused: boolean }>>([]);
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState('');
  const load = (p: TrainingPlan) => { setPlan(p); setDraft(p.entries.map(({ player_id, focus, paused }) => ({ player_id, focus, paused }))); setActive(p.active || p.entries.length === 0); };
  useEffect(() => { void seasonApi.trainingPlan(worldId).then(load).catch((e) => setError((e as Error).message)); }, [worldId]);
  const name = (id: string) => { const p = squad.find((x) => x.id === id); return p ? `${p.first_name} ${p.last_name}` : plan?.entries.find((e) => e.player_id === id)?.name ?? '—'; };
  const save = async (entries = draft, act = active) => {
    setBusy(true); setError(null);
    try { load(await seasonApi.saveTrainingPlan(worldId, act, entries)); onChanged?.(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const dirty = plan ? JSON.stringify(plan.entries.map(({ player_id, focus, paused }) => ({ player_id, focus, paused }))) !== JSON.stringify(draft) || plan.active !== active : false;
  const free = squad.filter((p) => !draft.some((d) => d.player_id === p.id));
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="display text-2xl font-bold uppercase">Wöchentlicher Trainingsplan</h2>
        <Pill tone={plan?.active ? 'good' : 'neutral'}>{plan?.active ? 'aktiv' : 'inaktiv'}</Pill>
        <Pill>{draft.length}/5 Spieler</Pill>
        <label className="ml-auto flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--fd-accent)]" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Plan automatisch ausführen
        </label>
      </div>
      <p className="mt-1 text-sm text-cream-dim">Jede neue Spielwoche trainieren die eingeplanten Spieler automatisch. Verletzte, abgegebene oder bereits trainierte Spieler werden übersprungen.</p>
      <ErrorBanner error={error} />
      <ul className="mt-3 space-y-2">
        {draft.map((d, i) => (
          <li key={d.player_id} className={`flex flex-wrap items-center gap-2 rounded-lg bg-olive-800/60 px-3 py-2 ${d.paused ? 'opacity-60' : ''}`}>
            <span className="min-w-0 flex-1 truncate font-semibold">{name(d.player_id)}</span>
            <select value={d.focus} aria-label="Trainingsart" onChange={(e) => setDraft(draft.map((x, k) => (k === i ? { ...x, focus: e.target.value } : x)))}
              className="min-h-10 rounded-lg border border-olive-600 bg-anthracite px-2 text-sm text-cream">
              {TRAINING_FOCI.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <Button variant="secondary" onClick={() => setDraft(draft.map((x, k) => (k === i ? { ...x, paused: !x.paused } : x)))}>{d.paused ? 'Fortsetzen' : 'Pausieren'}</Button>
            <Button variant="ghost" aria-label="Aus dem Plan entfernen" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>✕</Button>
          </li>
        ))}
      </ul>
      {draft.length < 5 && (
        <div className="mt-2 flex flex-wrap gap-2">
          <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Spieler hinzufügen" className="min-h-11 min-w-0 flex-1 rounded-lg border border-olive-600 bg-anthracite px-2 text-cream">
            <option value="">Spieler zum Plan hinzufügen …</option>
            {free.map((p) => <option key={p.id} value={p.id}>{p.first_name} {p.last_name} · {p.age} J. · OVR {p.overall}</option>)}
          </select>
          <Button variant="secondary" disabled={!add} onClick={() => { setDraft([...draft, { player_id: add, focus: 'technique', paused: false }]); setAdd(''); }}>Hinzufügen</Button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button busy={busy} disabled={!dirty} onClick={() => void save()}>Plan speichern</Button>
        {plan && plan.entries.length > 0 && <Button variant="ghost" onClick={() => void save([], false)}>Plan leeren</Button>}
        {plan?.this_week_done && <span className="text-sm text-cream-dim">Diese Woche bereits ausgeführt.</span>}
      </div>
      {plan?.last_run && (
        <div className="mt-4 rounded-xl bg-anthracite p-3 text-sm">
          <p className="font-semibold">Letzte Durchführung: Woche {plan.last_run.week} · {plan.last_run.executed} Einheiten</p>
          <ul className="mt-1 space-y-1">
            {plan.last_run.sessions.map((s) => (
              <li key={s.player_id} className="flex flex-wrap items-center gap-1">
                <span className="mr-1">{s.name}</span>
                <span className="text-cream-dim">+{Number(s.xp ?? 0).toLocaleString('de-DE', { maximumFractionDigits: 2 })} XP</span>
                {Object.entries(s.gains ?? {}).map(([k, v]) => <span key={k} className="rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-300">{ATTR_LABEL[k] ?? k} +{v}</span>)}
              </li>
            ))}
            {plan.last_run.skipped.map((s) => <li key={s.player_id} className="text-cream-dim">{name(s.player_id)}: übersprungen ({REASON[s.reason] ?? s.reason})</li>)}
          </ul>
        </div>
      )}
    </Card>
  );
}
