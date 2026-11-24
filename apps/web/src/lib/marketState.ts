/** Transfermarkt: Filter, Sortierung, Suche, Seite und Scrollposition über Seitenwechsel (z. B. Spielerprofil) hinweg erhalten. */
export interface MarketViewState<F> { tab: string; filters: F; page: number; scrollY: number }
const key = (worldId: string) => `fd:market:${worldId}`;

export function loadMarketState<F>(worldId: string, storage: Pick<Storage, 'getItem'> | undefined = safe()): MarketViewState<F> | null {
  try {
    const raw = storage?.getItem(key(worldId));
    if (!raw) return null;
    const s = JSON.parse(raw) as MarketViewState<F>;
    if (!s || typeof s !== 'object' || !s.filters || typeof s.page !== 'number') return null;
    return { tab: String(s.tab ?? 'market'), filters: s.filters, page: Math.max(0, Math.floor(s.page)), scrollY: Math.max(0, Number(s.scrollY) || 0) };
  } catch { return null; }
}
export function saveMarketState<F>(worldId: string, s: MarketViewState<F>, storage: Pick<Storage, 'setItem'> | undefined = safe()): void {
  try { storage?.setItem(key(worldId), JSON.stringify(s)); } catch { /* privater Modus: ohne Speicher weiterarbeiten */ }
}
export function clearMarketState(worldId: string, storage: Pick<Storage, 'removeItem'> | undefined = safe()): void {
  try { storage?.removeItem(key(worldId)); } catch { /* ignorieren */ }
}
function safe(): Storage | undefined { try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; } catch { return undefined; } }
