import { matchReadyRating, type LineupSlot } from '@fd/shared';
import { startDrag } from '../../lib/dragDrop';
import type { SquadPlayer } from '../../lib/teamApi';
import { POS_LABEL } from './PitchEditor';

const ORDER = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'CF', 'ST'];

/** Ersatzbank mit Positionen: per Drag-and-drop auf eine Position ziehen (oder antippen, wenn eine Position gewählt ist) */
export function BenchList({ squad, slots, selectedSlot, onPlace }: {
  squad: SquadPlayer[];
  slots: LineupSlot[];
  selectedSlot: number | null;
  onPlace: (slotIndex: number, playerId: string) => void;
}) {
  const inLineup = new Set(slots.map((s) => s.playerId).filter(Boolean));
  const bench = squad.filter((p) => !inLineup.has(p.id)).sort((a, b) => ORDER.indexOf(a.main_position) - ORDER.indexOf(b.main_position) || b.overall - a.overall);
  const selected = slots.find((s) => s.slotIndex === selectedSlot);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="display text-xl font-bold uppercase">Ersatzbank</h3>
        <span className="text-xs text-cream-dim">{bench.length} Spieler · ziehen auf eine Position</span>
      </div>
      <ul className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
        {bench.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onPointerDown={(e) => startDrag(e, `${p.shirt_number ?? ''} ${p.last_name}`, {
                onDrop: (t) => onPlace(Number(t), p.id),
                onTap: () => { if (selected) onPlace(selected.slotIndex, p.id); },
              })}
              style={{ touchAction: 'none' }}
              className="flex w-full cursor-grab items-center gap-2 rounded-xl bg-olive-800 px-3 py-2 text-left hover:bg-olive-700"
            >
              <span className="display w-9 shrink-0 rounded bg-ink/60 text-center text-xs font-bold text-gold">{POS_LABEL[p.main_position]}</span>
              <span className="w-6 text-right tabular-nums text-cream-dim">{p.shirt_number ?? ''}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{p.last_name}
                {p.secondary_positions.length > 0 && <span className="ml-1 text-xs font-normal text-cream-dim">({p.secondary_positions.map((x) => POS_LABEL[x]).join(', ')})</span>}
              </span>
              <span className="text-xs tabular-nums text-cream-dim">{Math.round(p.fitness)}%</span>
              <span className="display w-8 text-right text-lg font-bold">{selected ? matchReadyRating(p, selected.position) : p.overall}</span>
            </button>
          </li>
        ))}
        {bench.length === 0 && <li className="text-sm text-cream-dim">Alle Spieler stehen in der Startelf.</li>}
      </ul>
      {selected && <p className="mt-2 text-xs text-cream-dim">Position {POS_LABEL[selected.position]} gewählt: Spieler antippen, um ihn dort einzusetzen. Die Zahl rechts ist seine Stärke auf dieser Position.</p>}
    </div>
  );
}
