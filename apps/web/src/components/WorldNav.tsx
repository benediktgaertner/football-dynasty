import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useWorldTheme } from '../lib/theme';
import { NAV } from '../lib/nav';

export { NAV, activeGroup } from '../lib/nav';
import { activeGroup } from '../lib/nav';

/**
 * Hauptmenü einer Karrierewelt: sechs Hauptpunkte statt zwölf. Häufig genutzte Seiten sind direkt erreichbar
 * (Dashboard, Transfers, Liga-Menü), zusammengehörige Funktionen stehen in Untermenüs:
 *   Dashboard · Mannschaft ▾ (Team, Entwicklung, Jugend, Verträge) · Wettbewerbe ▾ (Liga, Pokal, Europa, Kalender)
 *   Transfers · Verein ▾ (Finanzen & Stadion, Fankultur & Musik, Choreo-Designer) · Liga-Menü
 * Der aktive Bereich ist hervorgehoben (auch bei Unterseiten wie Spielerprofil oder Vereinsseite); Bedienung per Maus, Touch und Tastatur.
 */
const base = 'display flex min-h-11 items-center gap-1 rounded-xl px-4 py-2 text-lg font-semibold uppercase tracking-wide transition-colors';
const idle = 'bg-olive-800 text-cream-dim hover:bg-olive-700 hover:text-cream';
const on = 'bg-gold text-ink';

export function WorldNav({ worldId }: { worldId: string }) {
  // Farbwelt der eigenen Liga (zentrales Theme)
  useWorldTheme(worldId);
  const { pathname } = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const born = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = activeGroup(pathname, worldId);
  const activeItem = pathname.replace(new RegExp(`^/w/${worldId}/?`), '').split('/')[0] ?? '';

  useEffect(() => setOpen(null), [pathname]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(null); (root.current?.querySelector(`[data-nav-trigger="${open}"]`) as HTMLElement | null)?.focus(); } };
    document.addEventListener('pointerdown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  return (
    <nav ref={root} className="relative z-30 mb-4 flex flex-wrap items-center gap-1" aria-label="Hauptmenü" data-testid="world-nav">
      {NAV.map((g, idx) => {
        if (g.to) {
          return (
            <NavLink key={g.key} to={`/w/${worldId}/${g.to}`} data-testid={`nav-${g.key}`} aria-current={active === g.key ? 'page' : undefined}
              className={() => `${base} ${active === g.key ? on : idle}`}>{g.label}</NavLink>
          );
        }
        const isOpen = open === g.key;
        const right = idx >= NAV.length - 2;
        return (
          <div key={g.key} className="relative"
            // Hover öffnet das Untermenü (Maus); direkt nach einem Seitenwechsel bleibt es zu, auch wenn der Zeiger still über dem neu aufgebauten Menü steht
            onPointerEnter={(e) => { if (e.pointerType === 'mouse' && Date.now() - born.current > 700) { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(g.key), 120); } }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse') { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen((o) => (o === g.key ? null : o)), 220); } }}>
            <button type="button" data-nav-trigger={g.key} data-testid={`nav-${g.key}`} aria-haspopup="menu" aria-expanded={isOpen} aria-current={active === g.key ? 'page' : undefined}
              onClick={() => setOpen(isOpen ? null : g.key)}
              onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(g.key); setTimeout(() => (root.current?.querySelector(`[data-nav-panel="${g.key}"] a`) as HTMLElement | null)?.focus(), 0); } }}
              className={`${base} ${active === g.key ? on : isOpen ? 'bg-olive-700 text-cream' : idle}`}>
              {g.label}
              <svg viewBox="0 0 12 12" className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            {isOpen && (
              <div role="menu" data-nav-panel={g.key} data-testid={`nav-panel-${g.key}`}
                className={`absolute top-full z-40 mt-1 min-w-[17rem] rounded-xl border border-olive-600 bg-olive-900 p-1 shadow-2xl ${right ? 'right-0' : 'left-0'}`}>
                {g.items!.map((i) => {
                  const here = activeItem === i.to;
                  return (
                    <Link key={i.to} to={`/w/${worldId}/${i.to}`} role="menuitem" onClick={() => setOpen(null)} data-testid={`nav-item-${i.to}`} aria-current={here ? 'page' : undefined}
                      onKeyDown={(e) => {
                        const links = [...(root.current?.querySelectorAll(`[data-nav-panel="${g.key}"] a`) ?? [])] as HTMLElement[];
                        const k = links.indexOf(e.currentTarget);
                        if (e.key === 'ArrowDown') { e.preventDefault(); links[(k + 1) % links.length]?.focus(); }
                        if (e.key === 'ArrowUp') { e.preventDefault(); links[(k - 1 + links.length) % links.length]?.focus(); }
                      }}
                      className={`flex min-h-12 flex-col justify-center rounded-lg px-3 py-1.5 ${here ? 'bg-gold/15 text-gold' : 'text-cream hover:bg-olive-800'}`}>
                      <span className="display text-lg font-semibold uppercase tracking-wide">{i.label}</span>
                      <span className="text-xs text-cream-dim">{i.hint}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
