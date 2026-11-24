import type { StadiumDesign } from './matchClient';

/**
 * Stadion rund um das Spielfeld (Canvas, Pitch-Koordinaten in Metern). Rein optisch.
 *
 * Größe: Kleine Stadien (10–20 Tsd.) haben einen Rang, mittlere (25–35 Tsd.) zwei, große (40 Tsd.: zwei,
 * ab 45 Tsd.: drei). Je größer, desto tiefer und höher wirken die Tribünen – das Spielfeld wird in der
 * Ansicht entsprechend etwas kleiner, bleibt aber vollständig sichtbar (Seitenverhältnis aus stadiumMargin).
 *
 * Sitzplätze vs. Zuschauer: Leere Sitze sind grundsätzlich weiß (kleine Rechtecke), Fans sind dunklere,
 * gut erkennbare Punkte in Vereinsfarben – auch wenn Weiß eine Vereinsfarbe ist. Die Zahl der Fans
 * entspricht der echten Auslastung.
 *
 * Ebenen: Bau + Sitze einmal je Größe; Fans in zwei Bewegungsphasen (dezentes Wippen) und optional
 * eine Choreografie-Ebene. Pro Frame werden nur fertige Bitmaps kopiert.
 */

export const L = 105;
export const W = 68;
/** Abstand Seitenlinie → erste Sitzreihe (Bande und Laufweg) */
export const GAP = 2.6;
/** Umlauf zwischen zwei Rängen */
const CONCOURSE = 0.7;

export const STADIUM_STYLES: ReadonlyArray<{ key: NonNullable<StadiumDesign['style']>; label: string; hint: string }> = [
  { key: 'classic', label: 'Klassisch', hint: 'Vier einzelne Tribünen, offene Ecken' },
  { key: 'modern', label: 'Modern', hint: 'Geschlossenes Rechteck mit Dach' },
  { key: 'arena', label: 'Arena', hint: 'Abgerundete Schüssel, steile Ränge' },
  { key: 'traditional', label: 'Traditionell', hint: 'Große Haupttribüne, Stehränge' },
];

export const DEFAULT_DESIGN: Required<StadiumDesign> = { style: 'modern', stand: '#3b3f46', seat: '#7d8590', accent: '#f2c14e', club_colors: true, roof: true };

export function withDefaults(d: StadiumDesign | null | undefined): Required<StadiumDesign> {
  return { ...DEFAULT_DESIGN, ...(d ?? {}) } as Required<StadiumDesign>;
}

/** Gezeichnete Ränge: bis 20.000 → 1, bis 40.000 → 2, bis 60.000 → 3, darüber 4 (Zusatzrang für Großarenen bis 80.000) */
export function visualTiers(capacity: number): 1 | 2 | 3 | 4 {
  if (capacity <= 20000) return 1;
  if (capacity <= 40000) return 2;
  if (capacity <= 60000) return 3;
  return 4;
}

/** Logische Ränge (Choreografie, Fanblöcke): höchstens drei; der Zusatzrang zählt zum Oberrang */
export function standTiers(capacity: number): 1 | 2 | 3 {
  return Math.min(3, visualTiers(capacity)) as 1 | 2 | 3;
}

/** Tribünentiefe in Metern (ohne Umläufe): 10.000 Plätze ≈ 3,4 m, 50.000 ≈ 10 m, 80.000 ≈ 15 m */
export function standDepth(capacity: number): number {
  return 3.4 + Math.max(0, capacity - 10000) / 40000 * 6.6;
}

function totalDepth(capacity: number): number {
  return standDepth(capacity) + (visualTiers(capacity) - 1) * CONCOURSE;
}

/** Rand um das Spielfeld (Platz für Tore, Namen und Tribünen) */
export function stadiumMargin(capacity: number | null | undefined): number {
  return capacity ? GAP + totalDepth(capacity) + 0.6 : 4;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(hex: string, f: number): string {
  const [r, g, b] = rgbOf(hex);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

/** Fanfarbe: dunkler als der Vereinston; sehr helle Farben (Weiß) werden deutlich abgedunkelt */
export function fanColor(hex: string): string {
  const [r, g, b] = rgbOf(hex);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return shade(hex, lum > 0.75 ? -0.58 : lum > 0.5 ? -0.32 : -0.12);
}

const SEAT_EMPTY = '#eef1f4';
const SEAT_EMPTY_ALT = '#d9dee4';
const NEUTRAL_FANS = ['#3d4652', '#5b4636', '#2b2f36', '#6b5a4a', '#44505e', '#6e3434', '#2f4a3a'];

export interface StadiumArtOptions {
  capacity: number;
  attendance: number;
  design: StadiumDesign | null | undefined;
  homeColors: [string, string];
  awayColor: string;
  /** Pixel pro Meter und Ursprung der Spielfeldecke (0,0) in Pixeln */
  s: number;
  ox: number;
  oy: number;
  width: number;
  height: number;
  seed?: number;
  /** Kurzname für Banner/Choreografie */
  homeShort?: string;
  banners?: boolean;
}

type Side = 'top' | 'bottom' | 'left' | 'right';
interface Band { side: Side; x0: number; y0: number; x1: number; y1: number; tier: number; vt: number }
export interface Seat { x: number; y: number; taken: boolean; away: boolean; home: boolean; tier: number; side: Side; corner: boolean }

/** Geometrie: Ränge je Seite und alle Sitzplätze (deterministisch je Größe/Stil/Auslastung) */
export function stadiumLayout(o: StadiumArtOptions) { return layout(o); }
function layout(o: StadiumArtOptions) {
  const d = withDefaults(o.design);
  const tiers = standTiers(o.capacity);
  const vt = visualTiers(o.capacity);
  const depth = standDepth(o.capacity);
  const tierDepth = depth / vt;
  const total = totalDepth(o.capacity);
  const f = (side: Side) => (d.style === 'traditional' ? (side === 'bottom' ? 1.2 : side === 'top' ? 0.75 : 0.6) : d.style === 'arena' && (side === 'left' || side === 'right') ? 1.05 : 1);
  const bands: Band[] = [];
  const closed = d.style === 'modern' || d.style === 'arena';
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const sf = f(side);
    for (let t = 0; t < vt; t++) {
      const lt = Math.min(t, tiers - 1);
      const a = GAP + (t * (tierDepth + CONCOURSE)) * sf;
      const b = a + tierDepth * sf;
      const ext = closed ? GAP + total : 0;
      if (side === 'top') bands.push({ side, tier: lt, vt: t, x0: -ext, x1: L + ext, y0: -b, y1: -a });
      if (side === 'bottom') bands.push({ side, tier: lt, vt: t, x0: -ext, x1: L + ext, y0: W + a, y1: W + b });
      if (side === 'left') bands.push({ side, tier: lt, vt: t, x0: -b, x1: -a, y0: -GAP, y1: W + GAP });
      if (side === 'right') bands.push({ side, tier: lt, vt: t, x0: L + a, x1: L + b, y0: -GAP, y1: W + GAP });
    }
  }
  const inArena = (x: number, y: number) => {
    if (d.style !== 'arena') return true;
    const R = GAP + total;
    const cx = x < 0 ? 0 : x > L ? L : x, cy = y < 0 ? 0 : y > W ? W : y;
    return Math.hypot(x - cx, y - cy) <= R - 0.3;
  };
  const rand = rng(o.seed ?? 1337);
  const fill = Math.max(0, Math.min(1, o.attendance / Math.max(1, o.capacity)));
  const rowGap = 0.9, seatGap = 0.8;
  const seats: Seat[] = [];
  for (const bd of bands) {
    const horizontal = bd.side === 'top' || bd.side === 'bottom';
    const a0 = horizontal ? bd.x0 : bd.y0, a1 = horizontal ? bd.x1 : bd.y1;
    const b0 = horizontal ? bd.y0 : bd.x0, b1 = horizontal ? bd.y1 : bd.x1;
    for (let b = b0 + rowGap / 2; b < b1; b += rowGap) {
      for (let a = a0 + seatGap / 2; a < a1; a += seatGap) {
        const x = horizontal ? a : b, y = horizontal ? b : a;
        // Ecken bei offenen Stilen leer lassen, bei geschlossenen nur einmal (oben/unten) zeichnen
        const corner = x < 0 || x > L;
        if (horizontal && corner && !closed) continue;
        if (!inArena(x, y)) continue;
        // Unterste Ränge füllen sich zuerst (Fans sitzen nah am Feld)
        const pref = fill + (tiers > 1 ? (bd.tier === 0 ? 0.12 : bd.tier === tiers - 1 ? -0.12 : 0) : 0);
        const taken = rand() < pref;
        const away = x > L + GAP * 0.5 && y < W * 0.42;
        const home = x < -GAP * 0.5; // Heimkurve hinter dem linken Tor
        seats.push({ x, y, taken, away, home, tier: bd.tier, side: bd.side, corner });
      }
    }
  }
  return { d, tiers, vt, depth, total, bands, seats, closed };
}

/** Bau, Ränge, leere (weiße) Sitze, Dach, Banden und Banner */
export function renderStadiumLayer(o: StadiumArtOptions): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = o.width; cv.height = o.height;
  const ctx = cv.getContext('2d')!;
  const { d, vt, total, bands, seats, closed } = layout(o);
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;

  // Unterbau mit Höheneindruck: obere Ränge heller (näher an der „Kamera“)
  const outerR = (GAP + total) * o.s;
  if (d.style === 'arena') {
    ctx.fillStyle = shade(d.stand, -0.25);
    ctx.beginPath(); ctx.roundRect(X(-GAP - total), Y(-GAP - total), (L + 2 * (GAP + total)) * o.s, (W + 2 * (GAP + total)) * o.s, outerR); ctx.fill();
    // Ränge nur innerhalb der Schüssel zeichnen
    ctx.save();
    ctx.clip();
  }
  for (const bd of bands) {
    const lift = vt === 1 ? 0 : bd.vt / (vt - 1);
    ctx.fillStyle = shade(d.stand, -0.12 + lift * 0.18);
    ctx.fillRect(X(bd.x0), Y(bd.y0), (bd.x1 - bd.x0) * o.s, (bd.y1 - bd.y0) * o.s);
    // Ränge-Kante (Brüstung) in der Akzentfarbe des Designs
    ctx.fillStyle = shade(d.seat, -0.1);
    const lw = Math.max(1, o.s * 0.18);
    if (bd.side === 'top') ctx.fillRect(X(bd.x0), Y(bd.y1) - lw, (bd.x1 - bd.x0) * o.s, lw);
    if (bd.side === 'bottom') ctx.fillRect(X(bd.x0), Y(bd.y0), (bd.x1 - bd.x0) * o.s, lw);
    if (bd.side === 'left') ctx.fillRect(X(bd.x1) - lw, Y(bd.y0), lw, (bd.y1 - bd.y0) * o.s);
    if (bd.side === 'right') ctx.fillRect(X(bd.x0), Y(bd.y0), lw, (bd.y1 - bd.y0) * o.s);
  }
  // Umläufe zwischen den Rängen
  if (vt > 1) {
    ctx.fillStyle = shade(d.stand, -0.45);
    for (const bd of bands) {
      if (bd.vt === 0) continue;
      const c = CONCOURSE * o.s;
      if (bd.side === 'top') ctx.fillRect(X(bd.x0), Y(bd.y1), (bd.x1 - bd.x0) * o.s, c);
      if (bd.side === 'bottom') ctx.fillRect(X(bd.x0), Y(bd.y0) - c, (bd.x1 - bd.x0) * o.s, c);
      if (bd.side === 'left') ctx.fillRect(X(bd.x1), Y(bd.y0), c, (bd.y1 - bd.y0) * o.s);
      if (bd.side === 'right') ctx.fillRect(X(bd.x0) - c, Y(bd.y0), c, (bd.y1 - bd.y0) * o.s);
    }
  }
  // Leere Sitze: weiße Rechtecke (unabhängig von den Vereinsfarben)
  const dot = Math.max(1, Math.min(3.2, o.s * 0.5));
  for (const st of seats) {
    if (st.taken) continue;
    ctx.fillStyle = ((Math.round(st.x / 0.8) + Math.round(st.y / 0.9)) % 5 === 0) ? SEAT_EMPTY_ALT : SEAT_EMPTY;
    ctx.fillRect(X(st.x) - dot * 0.45, Y(st.y) - dot * 0.35, dot * 0.9, dot * 0.7);
  }
  if (d.style === 'arena') ctx.restore();
  // Dach: Kante außen, leichter Schatten auf dem obersten Rang
  if (d.roof) {
    ctx.strokeStyle = shade(d.stand, -0.55);
    ctx.lineWidth = Math.max(2, o.s * 0.7);
    if (d.style === 'arena') {
      ctx.beginPath();
      ctx.roundRect(X(-GAP - total) + ctx.lineWidth / 2, Y(-GAP - total) + ctx.lineWidth / 2, (L + 2 * (GAP + total)) * o.s - ctx.lineWidth, (W + 2 * (GAP + total)) * o.s - ctx.lineWidth, outerR);
      ctx.stroke();
    } else {
      for (const bd of bands) {
        if (bd.vt !== vt - 1 || (d.style === 'traditional' && bd.side !== 'bottom')) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        const sh = (bd.side === 'top' || bd.side === 'bottom' ? bd.y1 - bd.y0 : bd.x1 - bd.x0) * 0.35 * o.s;
        if (bd.side === 'top') ctx.fillRect(X(bd.x0), Y(bd.y0), (bd.x1 - bd.x0) * o.s, sh);
        if (bd.side === 'bottom') ctx.fillRect(X(bd.x0), Y(bd.y1) - sh, (bd.x1 - bd.x0) * o.s, sh);
        if (bd.side === 'left') ctx.fillRect(X(bd.x0), Y(bd.y0), sh, (bd.y1 - bd.y0) * o.s);
        if (bd.side === 'right') ctx.fillRect(X(bd.x1) - sh, Y(bd.y0), sh, (bd.y1 - bd.y0) * o.s);
        ctx.beginPath();
        if (bd.side === 'top') { ctx.moveTo(X(bd.x0), Y(bd.y0)); ctx.lineTo(X(bd.x1), Y(bd.y0)); }
        if (bd.side === 'bottom') { ctx.moveTo(X(bd.x0), Y(bd.y1)); ctx.lineTo(X(bd.x1), Y(bd.y1)); }
        if (bd.side === 'left') { ctx.moveTo(X(bd.x0), Y(bd.y0)); ctx.lineTo(X(bd.x0), Y(bd.y1)); }
        if (bd.side === 'right') { ctx.moveTo(X(bd.x1), Y(bd.y0)); ctx.lineTo(X(bd.x1), Y(bd.y1)); }
        ctx.stroke();
      }
    }
  }
  // Werbebande in Akzentfarbe
  ctx.fillStyle = d.accent;
  const bw = 0.45;
  ctx.fillRect(X(-1.6), Y(-1.6 - bw), (L + 3.2) * o.s, bw * o.s);
  ctx.fillRect(X(-1.6), Y(W + 1.6), (L + 3.2) * o.s, bw * o.s);
  ctx.globalAlpha = 0.85;
  ctx.fillRect(X(-2.6 - bw), Y(-1.6), bw * o.s, (W + 3.2) * o.s);
  ctx.fillRect(X(L + 2.6), Y(-1.6), bw * o.s, (W + 3.2) * o.s);
  ctx.globalAlpha = 1;
  // Fanbanner an der Brüstung der Heimkurve und Haupttribüne
  if (o.banners) {
    const rand = rng((o.seed ?? 1) + 99);
    const [c1, c2] = o.homeColors;
    const n = 4 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const onEnd = i % 2 === 0;
      const len = 5 + rand() * 6;
      ctx.fillStyle = i % 3 === 0 ? c2 : c1;
      if (onEnd) {
        const y = 6 + rand() * (W - 12 - len);
        ctx.fillRect(X(-GAP - 0.9), Y(y), 0.8 * o.s, len * o.s);
        ctx.fillStyle = i % 3 === 0 ? c1 : c2; ctx.fillRect(X(-GAP - 0.62), Y(y + 0.6), 0.24 * o.s, (len - 1.2) * o.s);
      } else {
        const x = 8 + rand() * (L - 16 - len);
        ctx.fillRect(X(x), Y(W + GAP + 0.1), len * o.s, 0.8 * o.s);
        ctx.fillStyle = i % 3 === 0 ? c1 : c2; ctx.fillRect(X(x + 0.6), Y(W + GAP + 0.38), (len - 1.2) * o.s, 0.24 * o.s);
      }
    }
  }
  void closed;
  return cv;
}

/**
 * Fans (besetzte Plätze) in zwei Bewegungsphasen: In Phase B heben einzelne Fans die Arme
 * (leicht versetzt und heller) – im Wechsel entsteht dezente Bewegung.
 */
export function renderFanLayers(o: StadiumArtOptions): [HTMLCanvasElement, HTMLCanvasElement] {
  const { d, seats } = layout(o);
  const mk = () => { const c = document.createElement('canvas'); c.width = o.width; c.height = o.height; return c; };
  const a = mk(), b = mk();
  const ca = a.getContext('2d')!, cb = b.getContext('2d')!;
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;
  const dot = Math.max(1, Math.min(3.2, o.s * 0.5));
  const rand = rng((o.seed ?? 1337) + 7);
  const home = [fanColor(o.homeColors[0]), fanColor(o.homeColors[1])];
  const away = fanColor(o.awayColor);
  for (const st of seats) {
    if (!st.taken) continue;
    const r = rand();
    const c = st.away ? (r < 0.75 ? away : NEUTRAL_FANS[Math.floor(rand() * NEUTRAL_FANS.length)]!)
      : d.club_colors ? (r < 0.55 ? home[0]! : r < 0.75 ? home[1]! : NEUTRAL_FANS[Math.floor(rand() * NEUTRAL_FANS.length)]!)
        : NEUTRAL_FANS[Math.floor(rand() * NEUTRAL_FANS.length)]!;
    const moves = rand() < (st.home || st.away ? 0.45 : 0.2);
    for (const [ctx, alt] of [[ca, false], [cb, true]] as const) {
      const lift = alt && moves ? 0.18 * o.s : 0;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(X(st.x), Y(st.y) - lift, dot * 0.62, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(0.5, dot * 0.12); ctx.stroke();
    }
  }
  return [a, b];
}

/** Choreografie in der Heimkurve: Blockfahne in Vereinsfarben mit Kürzel (bei wichtigen Spielen) */
export function renderChoreoLayer(o: StadiumArtOptions): HTMLCanvasElement {
  const { seats } = layout(o);
  const cv = document.createElement('canvas');
  cv.width = o.width; cv.height = o.height;
  const ctx = cv.getContext('2d')!;
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;
  const dot = Math.max(1, Math.min(3.2, o.s * 0.5));
  const [c1, c2] = o.homeColors;
  for (const st of seats) {
    if (!st.home) continue;
    const band = Math.floor((st.y + st.x * 0.4) / 4) % 2 === 0;
    ctx.fillStyle = band ? c1 : c2;
    ctx.fillRect(X(st.x) - dot * 0.55, Y(st.y) - dot * 0.5, dot * 1.1, dot * 1.0);
  }
  // Schriftzug über die Kurve (um 90° gedreht)
  const minX = Math.min(...seats.filter((s) => s.home).map((s) => s.x), -GAP - 2);
  const cx = X((minX + -GAP) / 2), cy = Y(W / 2);
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-Math.PI / 2);
  ctx.font = `800 ${Math.max(10, Math.round(o.s * Math.min(4.5, (-GAP - minX) * 0.7)))}px "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = c2.toLowerCase() === c1.toLowerCase() ? '#ffffff' : c2;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(1, o.s * 0.15);
  const text = (o.homeShort ?? 'HEIM').toUpperCase();
  ctx.strokeText(text, 0, 0); ctx.fillText(text, 0, 0);
  ctx.restore();
  return cv;
}
