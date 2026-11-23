import { GAP, L, W, stadiumLayout, standTiers, type Seat, type StadiumArtOptions } from '../stadiumArt';
import type { StadiumDesign } from '../matchClient';
import { CORNER_SIDES, SIDES, type Region, type StandSide, type Tier } from './model';

/**
 * Stadiongeometrie für Choreografien – dieselbe Quelle (stadiumLayout) wie die Matchansicht, daher identisch im Editor und im Spiel.
 * Seiten: N = Gegengerade (oben), S = Haupttribüne (unten), W = Heimkurve (links), E = Osttribüne (rechts; dort liegt der Gästeblock).
 * Ecken gibt es nur bei geschlossenen Stadionstilen (modern, arena).
 */
export interface StandSeat { seat: Seat; side: StandSide; tier: Tier; tierIndex: number; /** Anteil entlang der Tribüne 0…1 */ u: number }
export interface Cell { key: string; side: StandSide; index: number; count: number; tier: Tier; seats: StandSeat[]; x0: number; y0: number; x1: number; y1: number; away: boolean }
export interface StadiumGeo {
  capacity: number; tiers: number; closed: boolean; style: NonNullable<StadiumDesign['style']>;
  sides: StandSide[]; seats: StandSeat[]; tierNames: Tier[];
  /** Außenmaß der Tribünen (Meter ab Spielfeldkante) */
  total: number;
}

export const AWAY_X0 = L + GAP * 0.5;
export const AWAY_Y1 = W * 0.42;
/** Gästeblock als Rechteck in Metern: rechts, obere 42 % der Seitenlinie (nach außen offen) */
export const isAwayPoint = (x: number, y: number) => x > AWAY_X0 && y < AWAY_Y1;

export function tierNames(tiers: number): Tier[] { return tiers <= 1 ? ['lower'] : tiers === 2 ? ['lower', 'upper'] : ['lower', 'middle', 'upper']; }

const sizeOpts = (capacity: number, design: StadiumDesign | null | undefined): StadiumArtOptions => ({ capacity, attendance: capacity * 0.6, design, homeColors: ['#000000', '#ffffff'], awayColor: '#888888', s: 1, ox: 0, oy: 0, width: 1, height: 1, seed: 1 });

const cache = new Map<string, StadiumGeo>();
export function stadiumGeo(capacity: number, design: StadiumDesign | null | undefined): StadiumGeo {
  const key = `${capacity}|${design?.style ?? 'modern'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lay = stadiumLayout(sizeOpts(capacity, design));
  const names = tierNames(lay.tiers);
  const seats: StandSeat[] = lay.seats.map((seat) => {
    let side: StandSide; let u: number;
    if (seat.side === 'top' || seat.side === 'bottom') {
      const top = seat.side === 'top';
      if (seat.x < 0) { side = top ? 'NW' : 'SW'; u = Math.min(1, Math.max(0, (seat.x + (GAP + lay.total)) / (GAP + lay.total))); }
      else if (seat.x > L) { side = top ? 'NE' : 'SE'; u = Math.min(1, Math.max(0, (seat.x - L) / (GAP + lay.total))); }
      else { side = top ? 'N' : 'S'; u = seat.x / L; }
    } else {
      side = seat.side === 'left' ? 'W' : 'E';
      u = Math.min(1, Math.max(0, (seat.y + GAP) / (W + 2 * GAP)));
    }
    return { seat, side, tier: names[seat.tier] ?? 'lower', tierIndex: seat.tier, u };
  });
  const closed = lay.closed;
  const geo: StadiumGeo = { capacity, tiers: lay.tiers, closed, style: lay.d.style, sides: closed ? [...SIDES] : SIDES.filter((s) => !CORNER_SIDES.includes(s)), seats, tierNames: names, total: lay.total };
  if (cache.size > 12) cache.clear();
  cache.set(key, geo);
  return geo;
}

/** Sitzplätze eines Bereichs – Gästeblock-Sitze sind nie enthalten (Heimchoreografien überschreiben ihn nicht) */
export function regionSeats(geo: StadiumGeo, regions: Region[]): StandSeat[] {
  const out = new Set<StandSeat>();
  for (const r of regions) {
    if (!geo.sides.includes(r.side)) continue; // Ecken bei offenen Stadien existieren nicht
    const from = r.from ?? 0, to = r.to ?? 1;
    const tiers = r.tiers && r.tiers.length ? r.tiers.filter((t) => geo.tierNames.includes(t)) : null;
    if (r.tiers && r.tiers.length && !tiers!.length) continue; // Rang existiert nicht (z. B. Oberrang im kleinen Stadion)
    for (const s of geo.seats) {
      if (s.side !== r.side || s.seat.away) continue;
      if (tiers && !tiers.includes(s.tier)) continue;
      if (s.u < from - 1e-9 || s.u > to + 1e-9) continue;
      out.add(s);
    }
  }
  return [...out];
}

/** Kachelraster für den Editor: Seiten in Blöcke teilen (N/S 6, W/E 4, Ecken 1), je Rang */
export function blockCount(side: StandSide): number { return side === 'N' || side === 'S' ? 6 : side === 'W' || side === 'E' ? 4 : 1; }
export function cellKey(side: StandSide, index: number, tier: Tier) { return `${side}:${index}:${tier}`; }
export function stadiumCells(geo: StadiumGeo): Cell[] {
  const cells = new Map<string, Cell>();
  for (const s of geo.seats) {
    if (!geo.sides.includes(s.side)) continue;
    const n = blockCount(s.side);
    const idx = Math.min(n - 1, Math.floor(s.u * n));
    const key = cellKey(s.side, idx, s.tier);
    let c = cells.get(key);
    if (!c) { c = { key, side: s.side, index: idx, count: n, tier: s.tier, seats: [], x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, away: true }; cells.set(key, c); }
    c.seats.push(s);
    c.x0 = Math.min(c.x0, s.seat.x); c.x1 = Math.max(c.x1, s.seat.x); c.y0 = Math.min(c.y0, s.seat.y); c.y1 = Math.max(c.y1, s.seat.y);
    if (!s.seat.away) c.away = false;
  }
  return [...cells.values()];
}

/** Zellenauswahl → Bereiche (benachbarte Blöcke mit gleichen Rängen werden zusammengefasst) */
export function regionsFromCells(geo: StadiumGeo, keys: Set<string>): Region[] {
  const out: Region[] = [];
  for (const side of geo.sides) {
    const n = blockCount(side);
    // je Block: gewählte Ränge
    const per: Tier[][] = Array.from({ length: n }, (_, i) => geo.tierNames.filter((t) => keys.has(cellKey(side, i, t))));
    let i = 0;
    while (i < n) {
      if (!per[i]!.length) { i++; continue; }
      let j = i;
      const sig = per[i]!.join(',');
      while (j + 1 < n && per[j + 1]!.join(',') === sig) j++;
      const all = per[i]!.length === geo.tierNames.length;
      out.push({ side, from: Math.round((i / n) * 1000) / 1000, to: Math.round(((j + 1) / n) * 1000) / 1000, tiers: all ? null : per[i]! });
      i = j + 1;
    }
  }
  return out;
}
export function cellsFromRegions(geo: StadiumGeo, regions: Region[]): Set<string> {
  const keys = new Set<string>();
  for (const r of regions) {
    if (!geo.sides.includes(r.side)) continue;
    const n = blockCount(r.side), from = r.from ?? 0, to = r.to ?? 1;
    const tiers = r.tiers && r.tiers.length ? r.tiers.filter((t) => geo.tierNames.includes(t)) : geo.tierNames;
    for (let i = 0; i < n; i++) {
      const mid = (i + 0.5) / n;
      if (mid >= from - 1e-9 && mid <= to + 1e-9) for (const t of tiers) keys.add(cellKey(r.side, i, t));
    }
  }
  return keys;
}

export type PlacementProblem = 'pitch' | 'away' | 'outside' | null;
/** Eckpunkte eines gedrehten Rechtecks (Mittelpunkt, Breite, Höhe, Grad) */
export function rectCorners(x: number, y: number, w: number, h: number, rotDeg: number): Array<[number, number]> {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const).map(([dx, dy]) => [x + dx * c - dy * s, y + dx * s + dy * c]);
}
/** Darf ein freies Element (Spruchband, Fahne) dort stehen? Nicht auf dem Spielfeld, nicht im Gästeblock, innerhalb der Tribünen */
export function placementProblem(geo: StadiumGeo, pts: Array<[number, number]>): PlacementProblem {
  const out = GAP + geo.total;
  for (const [x, y] of pts) {
    if (x > -0.2 && x < L + 0.2 && y > -0.2 && y < W + 0.2) return 'pitch';
    if (isAwayPoint(x, y)) return 'away';
    if (x < -out || x > L + out || y < -out || y > W + out) return 'outside';
  }
  return null;
}

/** Zaunbanner-Streifen entlang der Spielfeldkante: Rechteck in Metern (Mittelpunkt, Breite, Höhe, Drehung) */
export function fenceRect(side: 'N' | 'S' | 'W' | 'E', from: number, to: number, h: number): { x: number; y: number; w: number; h: number; rot: number } | null {
  const a = Math.min(from, to), b = Math.max(from, to);
  const y0 = side === 'E' ? Math.max(a, AWAY_Y1 / W + 0.02) : a; // am Gästeblock endet das Zaunbanner
  if (b - y0 < 0.02 && (side === 'E')) return null;
  const off = GAP - 0.3 - h / 2; // zwischen Spielfeld und erster Sitzreihe
  if (side === 'N') return { x: ((a + b) / 2) * L, y: -off - h / 2 + 0.2, w: (b - a) * L, h, rot: 0 };
  if (side === 'S') return { x: ((a + b) / 2) * L, y: W + off + h / 2 - 0.2, w: (b - a) * L, h, rot: 0 };
  if (side === 'W') return { x: -off - h / 2 + 0.2, y: ((a + b) / 2) * W, w: (b - a) * W, h, rot: 90 };
  return { x: L + off + h / 2 - 0.2, y: ((y0 + b) / 2) * W, w: (b - y0) * W, h, rot: 90 };
}

/** Anzahl von Tribünenrängen, die ein Stadion dieser Größe hat */
export const tiersOf = standTiers;
