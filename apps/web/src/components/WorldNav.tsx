import { NavLink } from 'react-router-dom';

const ITEMS = [
  { to: 'spieltag', label: 'Dashboard' },
  { to: 'kalender', label: 'Kalender' },
  { to: 'team', label: 'Team' },
  { to: 'liga', label: 'Liga' },
  { to: 'pokal', label: 'Pokal' },
  { to: 'transfers', label: 'Transfers' },
  { to: 'finanzen', label: 'Finanzen' },
];

/** Hauptmenü innerhalb einer Karrierewelt (auf dem iPad gut mit dem Finger erreichbar) */
export function WorldNav({ worldId }: { worldId: string }) {
  return (
    <nav className="-mx-1 mb-4 flex gap-1 overflow-x-auto pb-1" aria-label="Hauptmenü">
      {ITEMS.map((i) => (
        <NavLink key={i.to} to={`/w/${worldId}/${i.to}`}
          className={({ isActive }) => `display min-h-11 shrink-0 rounded-xl px-4 py-2 text-lg font-semibold uppercase tracking-wide ${isActive ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}
