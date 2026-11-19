import { StatusIcon } from './PlayerStatus';
import {
  POSITIONS,
  clampSlotCoordinates,
  effectiveRating,
  matchReadyRating,
  positionFromCoordinates,
  readableTextColor,
  type LineupSlot,
  type Position,
} from '@fd/shared';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SquadPlayer } from '../../lib/teamApi';
import { PlayerAvatar } from '../PlayerAvatar';

export const POS_LABEL: Record<string, string> = {
  GK: 'TW', CB: 'IV', LB: 'LV', RB: 'RV', LWB: 'LAV', RWB: 'RAV', CDM: 'DM', CM: 'ZM', CAM: 'OM', LM: 'LM', RM: 'RM', LW: 'LA', RW: 'RA', CF: 'HS', ST: 'ST',
};

export function ratingTone(penalty: number): string {
  if (penalty === 0) return 'bg-pitch text-cream';
  if (penalty >= -2) return 'bg-gold text-ink';
  if (penalty >= -5) return 'bg-sunset text-ink';
  return 'bg-danger text-cream';
}

/**
 * E1: 2D-Taktikfeld. Spieler werden per Drag-and-drop (Maus und Touch über Pointer Events)
 * frei positioniert; die Rolle ergibt sich aus der Feldposition. Tippen wählt eine Position aus.
 * Koordinaten: x 0 (links) … 100 (rechts), y 0 (eigenes Tor, unten) … 100 (gegnerisches Tor, oben).
 */
export function PitchEditor({
  slots,
  squad,
  selectedSlot,
  onSelectSlot,
  onMoveSlot,
  kit,
  big = false,
}: {
  slots: LineupSlot[];
  squad: SquadPlayer[];
  selectedSlot: number | null;
  onSelectSlot: (slotIndex: number | null) => void;
  onMoveSlot: (slotIndex: number, x: number, y: number, position: Position) => void;
  kit: { primary: string; secondary: string };
  /** großes Taktikfenster */
  big?: boolean;
}) {
  const pitchRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ slot: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const byId = new Map(squad.map((p) => [p.id, p]));
  const numberColor = readableTextColor(kit.primary);

  function toPitch(clientX: number, clientY: number, isGk: boolean) {
    const rect = pitchRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = 100 - ((clientY - rect.top) / rect.height) * 100;
    return clampSlotCoordinates(x, y, isGk);
  }

  function onPointerDown(e: ReactPointerEvent, slot: LineupSlot) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { slot: slot.slotIndex, startX: e.clientX, startY: e.clientY, moved: false };
  }
  function onPointerMove(e: ReactPointerEvent, slot: LineupSlot) {
    const d = drag.current;
    if (!d || d.slot !== slot.slotIndex) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    d.moved = true;
    setDragging(slot.slotIndex);
    const isGk = slot.position === 'GK';
    const { x, y } = toPitch(e.clientX, e.clientY, isGk);
    onMoveSlot(slot.slotIndex, x, y, positionFromCoordinates(x, y, isGk));
  }
  function onPointerUp(slot: LineupSlot) {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d && !d.moved) onSelectSlot(selectedSlot === slot.slotIndex ? null : slot.slotIndex);
  }

  return (
    <div
      ref={pitchRef}
      className="relative mx-auto touch-none select-none overflow-hidden rounded-2xl border-2 border-cream/30 bg-pitch shadow-inner"
      style={{ width: '100%', maxWidth: big ? 'calc(min(82vh, 900px) * 0.68)' : 'calc(min(58vh, 680px) * 0.68)', aspectRatio: '68 / 100' }}
      onClick={(e) => e.target === pitchRef.current && onSelectSlot(null)}
    >
      {/* Rasenstreifen und Markierungen */}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0 10%, transparent 10% 20%)' }} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 68 100" preserveAspectRatio="none" aria-hidden>
        <g fill="none" stroke="rgba(244,235,208,0.55)" strokeWidth="0.35">
          <rect x="1" y="1" width="66" height="98" />
          <line x1="1" y1="50" x2="67" y2="50" />
          <circle cx="34" cy="50" r="8.7" />
          <rect x="13.85" y="1" width="40.3" height="15.7" />
          <rect x="24.85" y="1" width="18.3" height="5.2" />
          <rect x="13.85" y="83.3" width="40.3" height="15.7" />
          <rect x="24.85" y="93.8" width="18.3" height="5.2" />
          <rect x="30.3" y="-1" width="7.4" height="2" />
          <rect x="30.3" y="99" width="7.4" height="2" />
        </g>
      </svg>
      <span className="pointer-events-none absolute bottom-1 left-2 text-[10px] uppercase tracking-wider text-cream/50">Eigenes Tor</span>
      <span className="pointer-events-none absolute left-2 top-1 text-[10px] uppercase tracking-wider text-cream/50">Angriffsrichtung ↑</span>

      {slots.map((slot) => {
        const p = slot.playerId ? byId.get(slot.playerId) : undefined;
        const penalty = p ? effectiveRating(p, slot.position) - p.overall : 0;
        const selected = selectedSlot === slot.slotIndex;
        return (
          <button
            key={slot.slotIndex}
            type="button"
            data-drop={slot.slotIndex}
            onPointerDown={(e) => onPointerDown(e, slot)}
            onPointerMove={(e) => onPointerMove(e, slot)}
            onPointerUp={() => onPointerUp(slot)}
            onPointerCancel={() => { drag.current = null; setDragging(null); }}
            className={`absolute flex w-[18%] -translate-x-1/2 -translate-y-1/2 cursor-grab flex-col items-center ${dragging === slot.slotIndex ? 'z-20 cursor-grabbing' : 'z-10'}`}
            style={{ left: `${slot.x}%`, top: `${100 - slot.y}%`, touchAction: 'none' }}
            aria-label={`${POS_LABEL[slot.position]}: ${p ? `${p.first_name} ${p.last_name}` : 'frei'}`}
          >
            <span
              className={`relative flex aspect-square ${big ? 'w-[min(58px,72%)]' : 'w-[min(44px,70%)]'} items-center justify-center rounded-full border-2 text-sm font-extrabold shadow-lg transition ${selected ? 'ring-4 ring-gold' : ''} ${p ? '' : 'border-dashed'}`}
              style={{ background: p ? kit.primary : 'rgba(0,0,0,0.25)', borderColor: p ? kit.secondary : 'rgba(244,235,208,0.7)', color: numberColor }}
            >
              <span className="display text-base">{p ? (p.shirt_number ?? '') : '+'}</span>
              {p && (
                <span className={`display absolute -right-2 -top-2 rounded-full px-1 text-[10px] font-bold leading-4 ${ratingTone(penalty)}`}>
                  {matchReadyRating(p, slot.position)}
                </span>
              )}
              {p?.status && (p.status.injury || p.status.suspensions.length > 0) && <span className="absolute -bottom-1 -left-2"><StatusIcon s={p.status} /></span>}
            </span>
            <span className="display mt-0.5 rounded bg-ink/70 px-1 text-[10px] font-semibold uppercase leading-4 text-gold">{POS_LABEL[slot.position]}</span>
            <span className="max-w-full truncate rounded bg-ink/60 px-1 text-[11px] leading-4 text-cream">{p ? p.last_name : 'frei'}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Auswahlliste für eine Position: Spieler nach aktueller Leistungsfähigkeit auf dieser Position. */
export function SlotPicker({
  slot,
  squad,
  lineupIds,
  onAssign,
  onChangeRole,
  kit,
}: {
  slot: LineupSlot;
  squad: SquadPlayer[];
  lineupIds: Set<string>;
  onAssign: (playerId: string) => void;
  onChangeRole: (position: Position) => void;
  kit: { primary: string; secondary: string };
}) {
  const sorted = [...squad].sort((a, b) => matchReadyRating(b, slot.position) - matchReadyRating(a, slot.position));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="display text-lg font-bold uppercase">Position {POS_LABEL[slot.position]}</span>
        <label className="flex items-center gap-2 text-sm text-cream-dim">
          Rolle
          <select
            value={slot.position}
            onChange={(e) => onChangeRole(e.target.value as Position)}
            disabled={slot.position === 'GK'}
            className="min-h-9 rounded-lg border border-olive-600 bg-anthracite px-2 text-cream"
          >
            {POSITIONS.filter((p) => p !== 'GK').map((p) => (
              <option key={p} value={p}>{POS_LABEL[p]}</option>
            ))}
            {slot.position === 'GK' && <option value="GK">TW</option>}
          </select>
        </label>
      </div>
      <ul className="max-h-[46vh] divide-y divide-olive-800 overflow-auto rounded-xl border border-olive-700">
        {sorted.map((p) => {
          const penalty = effectiveRating(p, slot.position) - p.overall;
          const inLineup = lineupIds.has(p.id);
          const current = slot.playerId === p.id;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onAssign(p.id)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-olive-800 ${current ? 'bg-gold/10' : ''}`}
              >
                <PlayerAvatar id={p.id} nationality={p.nationality} age={p.age} size={32} shirt={kit.primary} collar={kit.secondary} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{p.first_name} {p.last_name}</span>
                  <span className="block text-xs text-cream-dim">
                    {POS_LABEL[p.main_position]}{p.secondary_positions.length > 0 && ` (${p.secondary_positions.map((x) => POS_LABEL[x]).join(', ')})`} · Fitness {Math.round(p.fitness)}
                    {inLineup && !current && ' · in der Elf (wird getauscht)'}
                  </span>
                </span>
                <span className={`display rounded px-2 py-0.5 text-sm font-bold ${ratingTone(penalty)}`}>{matchReadyRating(p, slot.position)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-cream-dim">Zahl = aktuelle Leistungsfähigkeit auf dieser Position (Stärke, Positionsmalus, Fitness). Grün: Hauptposition, gelb: Nebenposition, orange/rot: positionsfremd.</p>
    </div>
  );
}
