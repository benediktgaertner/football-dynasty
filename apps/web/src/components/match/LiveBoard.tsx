import { TEAM_SETTINGS, readableTextColor, type TeamSettingKey } from '@fd/shared';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { startDrag } from '../../lib/dragDrop';
import type { Command, ProfileName, RosterTeam, TeamView } from '../../lib/matchClient';
import { Button } from '../ui';
import { POS_LABEL } from '../team/PitchEditor';

const PROFILE_LABEL: Record<ProfileName, string> = { offensive: 'Offensiv', neutral: 'Neutral', defensive: 'Defensiv' };
const ORDER = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

function fitnessTone(f: number) { return f >= 75 ? 'bg-emerald-400' : f >= 55 ? 'bg-gold' : 'bg-danger'; }

/**
 * F11: Team-Management während der Partie – dasselbe große Fenster wie das Taktikfenster,
 * aber nur Aufstellung und Taktik. Das Spiel läuft weiter.
 * - Bankspieler auf einen Feldspieler ziehen ⇒ Wechsel (beim nächsten Halt)
 * - Feldspieler ziehen ⇒ neue Position/Rolle
 */
export function LiveBoard({ view, team, activeProfile, onClose, send }: {
  view: TeamView;
  team: RosterTeam;
  activeProfile: ProfileName | null;
  onClose: () => void;
  send: (c: Command) => Promise<boolean>;
}) {
  const pitchRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const kit = team.kit ?? { primary: team.color, secondary: team.colorAlt };
  const numColor = readableTextColor(kit.primary);
  const field = view.players.filter((p) => p.onPitch);
  const bench = view.players.filter((p) => !p.onPitch && !p.subbedOff && !p.sentOff && !p.unavailable && !p.injured)
    .sort((a, b) => ORDER.indexOf(a.main) - ORDER.indexOf(b.main) || b.overall - a.overall);
  const pendingOut = new Set(view.pendingSubs.map((s) => s.outId));
  const pendingIn = new Set(view.pendingSubs.map((s) => s.inId));
  const subsLeft = 5 - view.subsUsed - view.pendingSubs.length;

  const toPitch = (cx: number, cy: number) => {
    const r = pitchRef.current!.getBoundingClientRect();
    return { x: Math.max(4, Math.min(96, ((cx - r.left) / r.width) * 100)), y: Math.max(2, Math.min(95, 100 - ((cy - r.top) / r.height) * 100)) };
  };
  const onFieldDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      moved = true;
      setDrag({ id, ...toPitch(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        const p = toPitch(ev.clientX, ev.clientY);
        void send({ kind: 'move', playerId: id, x: Math.round(p.x), y: Math.round(p.y) }).finally(() => setDrag(null));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-ink/90 p-3 backdrop-blur-sm sm:p-5" aria-label="Team-Management">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="display mr-auto text-3xl font-extrabold uppercase">Aufstellung & Taktik</h2>
        <span className="text-sm text-cream-dim">Wechsel {view.subsUsed}/5 · Fenster {view.subWindowsUsed}/3 · Das Spiel läuft weiter</span>
        <Button variant="secondary" onClick={onClose}>Zurück zum Spiel</Button>
      </div>
      <div className="fd-board-grid fd-board-live">
        {/* Spielfeld */}
        <div
          ref={pitchRef}
          className="relative mx-auto touch-none select-none overflow-hidden rounded-2xl border-2 border-cream/30 bg-pitch"
          style={{ width: '100%', maxWidth: 'calc(min(80vh, 880px) * 0.68)', aspectRatio: '68 / 100' }}
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 68 100" preserveAspectRatio="none" aria-hidden>
            <g fill="none" stroke="rgba(244,235,208,0.55)" strokeWidth="0.35">
              <rect x="1" y="1" width="66" height="98" /><line x1="1" y1="50" x2="67" y2="50" /><circle cx="34" cy="50" r="8.7" />
              <rect x="13.85" y="1" width="40.3" height="15.7" /><rect x="13.85" y="83.3" width="40.3" height="15.7" />
            </g>
          </svg>
          {field.map((p) => {
            const x = drag?.id === p.id ? drag.x : p.x;
            const y = drag?.id === p.id ? drag.y : p.y;
            return (
              <button key={p.id} type="button" data-drop={p.id} onPointerDown={(e) => onFieldDown(e, p.id)} style={{ left: `${x}%`, top: `${100 - y}%`, touchAction: 'none' }}
                className="absolute z-10 flex w-[18%] -translate-x-1/2 -translate-y-1/2 cursor-grab flex-col items-center"
                aria-label={`${POS_LABEL[p.position] ?? p.position} ${p.name}`}>
                <span className={`relative flex aspect-square w-[min(56px,72%)] items-center justify-center rounded-full border-2 shadow-lg ${pendingOut.has(p.id) ? 'opacity-50' : ''}`}
                  style={{ background: kit.primary, borderColor: kit.secondary, color: numColor }}>
                  <span className="display text-lg font-extrabold">{p.shirt}</span>
                  {p.yellow > 0 && <span className="absolute -left-1 -top-1 h-3.5 w-2.5 rounded-sm bg-yellow-300" />}
                </span>
                <span className="display mt-0.5 rounded bg-ink/70 px-1 text-[10px] font-semibold uppercase leading-4 text-gold">{POS_LABEL[p.position] ?? p.position}</span>
                <span className="max-w-full truncate rounded bg-ink/60 px-1 text-[11px] leading-4 text-cream">{p.name}{pendingOut.has(p.id) ? ' ⇄' : ''}</span>
                <span className="mt-0.5 h-1 w-10 overflow-hidden rounded bg-ink/60"><span className={`block h-full ${fitnessTone(p.fitness)}`} style={{ width: `${p.fitness}%` }} /></span>
              </button>
            );
          })}
        </div>

        {/* Ersatzbank */}
        <div className="rounded-2xl border border-olive-700 bg-olive-900/80 p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="display text-xl font-bold uppercase">Ersatzbank</h3>
            <span className="text-xs text-cream-dim">{subsLeft > 0 ? `${subsLeft} Wechsel frei` : 'keine Wechsel mehr'}</span>
          </div>
          <p className="mb-2 text-xs text-cream-dim">Auf einen Feldspieler ziehen, um ihn auszuwechseln.</p>
          <ul className="space-y-1">
            {bench.map((p) => (
              <li key={p.id}>
                <button type="button" disabled={pendingIn.has(p.id) || subsLeft <= 0} style={{ touchAction: 'none' }}
                  onPointerDown={(e) => startDrag(e, `${p.shirt} ${p.name}`, { onDrop: (outId) => void send({ kind: 'sub', outId, inId: p.id }) })}
                  className="flex w-full cursor-grab items-center gap-2 rounded-xl bg-olive-800 px-3 py-2 text-left hover:bg-olive-700 disabled:cursor-not-allowed disabled:opacity-50">
                  <span className="display w-9 shrink-0 rounded bg-ink/60 text-center text-xs font-bold text-gold">{POS_LABEL[p.main] ?? p.main}</span>
                  <span className="w-6 text-right tabular-nums text-cream-dim">{p.shirt}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold">{p.name}{pendingIn.has(p.id) ? ' (kommt)' : ''}</span>
                  <span className="text-xs tabular-nums text-cream-dim">{p.fitness}%</span>
                  <span className="display w-7 text-right text-lg font-bold">{p.overall}</span>
                </button>
              </li>
            ))}
            {bench.length === 0 && <li className="text-sm text-cream-dim">Keine Spieler verfügbar.</li>}
          </ul>
        </div>

        {/* Taktik */}
        <div className="rounded-2xl border border-olive-700 bg-olive-900/80 p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            {(['offensive', 'neutral', 'defensive'] as const).map((n) => (
              <button key={n} type="button" onClick={() => void send({ kind: 'profile', name: n })}
                className={`display min-h-11 flex-1 rounded-xl px-3 font-bold uppercase ${activeProfile === n ? 'bg-gold text-ink' : 'bg-olive-800 text-cream'}`}>{PROFILE_LABEL[n]}</button>
            ))}
          </div>
          <div className="grid gap-3 2xl:grid-cols-2">
            {(Object.keys(TEAM_SETTINGS) as TeamSettingKey[]).map((key) => {
              const def = TEAM_SETTINGS[key];
              return (
                <div key={key}>
                  <div className="mb-1 text-xs uppercase tracking-wider text-cream-dim">{def.label}</div>
                  <div className="flex flex-wrap gap-1">
                    {def.values.map((v, i) => (
                      <button key={String(v)} type="button" onClick={() => void send({ kind: 'settings', team_instructions: { [key]: v } })}
                        className={`min-h-10 rounded-lg px-2 text-sm ${view.team_instructions[key] === v ? 'bg-gold font-semibold text-ink' : 'bg-anthracite text-cream-dim hover:text-cream'}`}>
                        {def.valueLabels[i]}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
