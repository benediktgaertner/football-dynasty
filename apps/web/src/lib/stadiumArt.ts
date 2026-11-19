import type { StadiumDesign } from './matchClient';

/**
 * Stadion rund um das Spielfeld (Canvas, Pitch-Koordinaten in Metern).
 * Rein optisch: Tribünentiefe wächst mit der Kapazität, die Fanmenge entspricht der echten Auslastung
 * (Zuschauerzahl aus dem Ticket-/Nachfragesystem), Heimfans tragen die Vereinsfarben.
 * Die Tribünen werden einmal je Größe in eine Offscreen-Ebene gezeichnet (keine Kosten pro Frame).
 */

export const L = 105;
export const W = 68;
/** Abstand Seitenlinie → erste Sitzreihe (Bande und Laufweg) */
const GAP = 2.6;

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

/** Tribünentiefe in Metern: 10.000 Plätze ≈ 3 m, 50.000 Plätze ≈ 7,5 m */
export function standDepth(capacity: number): number {
  return 3 + Math.max(0, Math.min(1, (capacity - 10000) / 40000)) * 4.5;
}

/** Rand um das Spielfeld (Platz für Tore, Namen und Tribünen) */
export function stadiumMargin(capacity: number | null | undefined): number {
  return capacity ? GAP + standDepth(capacity) + 0.6 : 4;
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

function shade(hex: string, f: number): string {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

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
}

/** Zeichnet Tribünen, Sitze, Fans und Werbebanden in eine eigene Ebene */
export function renderStadiumLayer(o: StadiumArtOptions): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = o.width; cv.height = o.height;
  const ctx = cv.getContext('2d')!;
  const d = withDefaults(o.design);
  const depth = standDepth(o.capacity);
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;
  const fill = Math.max(0, Math.min(1, o.attendance / Math.max(1, o.capacity)));
  const rand = rng(o.seed ?? 1337);
  const seatColor = d.club_colors ? o.homeColors[0] : d.seat;
  const seatAlt = d.club_colors ? o.homeColors[1] : shade(d.seat, -0.25);

  // Tribünenflächen je Stil (Rechtecke in Metern: x0, y0, x1, y1, Tiefe-Faktor)
  type Stand = { x0: number; y0: number; x1: number; y1: number; side: 'top' | 'bottom' | 'left' | 'right'; f: number };
  const ext = d.style === 'classic' || d.style === 'traditional' ? 0 : depth;
  const fTop = d.style === 'traditional' ? 0.7 : 1;
  const fBottom = d.style === 'traditional' ? 1.25 : 1;
  const fEnds = d.style === 'traditional' ? 0.6 : d.style === 'arena' ? 1.05 : 1;
  const stands: Stand[] = [
    { side: 'top', x0: -GAP - ext, x1: L + GAP + ext, y0: -GAP - depth * fTop, y1: -GAP, f: fTop },
    { side: 'bottom', x0: -GAP - ext, x1: L + GAP + ext, y0: W + GAP, y1: W + GAP + depth * fBottom, f: fBottom },
    { side: 'left', x0: -GAP - depth * fEnds, x1: -GAP, y0: -GAP, y1: W + GAP, f: fEnds },
    { side: 'right', x0: L + GAP, x1: L + GAP + depth * fEnds, y0: -GAP, y1: W + GAP, f: fEnds },
  ];

  // Unterbau
  ctx.save();
  if (d.style === 'arena') {
    const r = (depth + GAP) * o.s;
    ctx.fillStyle = d.stand;
    ctx.beginPath();
    ctx.roundRect(X(-GAP - depth), Y(-GAP - depth), (L + 2 * (GAP + depth)) * o.s, (W + 2 * (GAP + depth)) * o.s, r);
    ctx.fill();
  } else {
    ctx.fillStyle = d.stand;
    for (const st of stands) ctx.fillRect(X(st.x0), Y(st.y0), (st.x1 - st.x0) * o.s, (st.y1 - st.y0) * o.s);
  }
  ctx.restore();

  // Sitzreihen und Fans: Reihen alle 0,9 m, Plätze alle 0,8 m
  const rowGap = 0.9, seatGap = 0.8;
  const dot = Math.max(1, Math.min(3.2, o.s * 0.5));
  const awayEnd = (x: number, y: number) => x > L + GAP && y < W * 0.42; // Gästeblock in der rechten Kurve
  const neutral = ['#e8d9c0', '#c9a27e', '#8a6a52', '#f2f2f2', '#2b2b2b', '#5a6b7d'];
  const inArena = (x: number, y: number) => {
    if (d.style !== 'arena') return true;
    // nur innerhalb der abgerundeten Form zeichnen
    const R = GAP + depth;
    const cx = x < 0 ? 0 : x > L ? L : x, cy = y < 0 ? 0 : y > W ? W : y;
    return Math.hypot(x - cx, y - cy) <= R - 0.3;
  };
  const seats = (x0: number, y0: number, x1: number, y1: number, horizontal: boolean) => {
    const a0 = horizontal ? x0 : y0, a1 = horizontal ? x1 : y1;
    const b0 = horizontal ? y0 : x0, b1 = horizontal ? y1 : x1;
    for (let b = b0 + rowGap / 2; b < b1; b += rowGap) {
      for (let a = a0 + seatGap / 2; a < a1; a += seatGap) {
        const x = horizontal ? a : b, y = horizontal ? b : a;
        if (!inArena(x, y)) continue;
        const taken = rand() < fill;
        let c: string;
        if (!taken) c = (Math.floor(a / seatGap) + Math.floor(b / rowGap)) % 7 === 0 ? seatAlt : seatColor;
        else if (awayEnd(x, y)) c = rand() < 0.75 ? o.awayColor : neutral[Math.floor(rand() * neutral.length)]!;
        else { const r = rand(); c = r < 0.55 ? o.homeColors[0] : r < 0.75 ? o.homeColors[1] : neutral[Math.floor(rand() * neutral.length)]!; }
        ctx.fillStyle = taken ? c : shade(c, -0.35);
        const px = X(x) - dot / 2, py = Y(y) - dot / 2;
        if (taken) { ctx.beginPath(); ctx.arc(X(x), Y(y), dot * 0.62, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(px, py, dot * 0.9, dot * 0.7);
      }
    }
  };
  for (const st of stands) {
    const horizontal = st.side === 'top' || st.side === 'bottom';
    seats(st.x0, st.y0, st.x1, st.y1, horizontal);
  }
  if (d.style === 'modern' || d.style === 'arena') {
    // Ecken füllen
    for (const [x0, y0] of [[-GAP - depth, -GAP - depth], [L + GAP, -GAP - depth], [-GAP - depth, W + GAP], [L + GAP, W + GAP]] as const) seats(x0, y0, x0 + depth, y0 + depth, true);
  }

  // Dachkante
  if (d.roof) {
    ctx.strokeStyle = shade(d.stand, -0.45);
    ctx.lineWidth = Math.max(2, o.s * 0.6);
    if (d.style === 'arena') {
      ctx.beginPath();
      ctx.roundRect(X(-GAP - depth) + ctx.lineWidth / 2, Y(-GAP - depth) + ctx.lineWidth / 2, (L + 2 * (GAP + depth)) * o.s - ctx.lineWidth, (W + 2 * (GAP + depth)) * o.s - ctx.lineWidth, (depth + GAP) * o.s);
      ctx.stroke();
    } else {
      for (const st of stands) {
        if (d.style === 'traditional' && st.side !== 'bottom') continue;
        const horizontal = st.side === 'top' || st.side === 'bottom';
        const outer = st.side === 'top' ? st.y0 : st.side === 'bottom' ? st.y1 : st.side === 'left' ? st.x0 : st.x1;
        ctx.beginPath();
        if (horizontal) { ctx.moveTo(X(st.x0), Y(outer)); ctx.lineTo(X(st.x1), Y(outer)); }
        else { ctx.moveTo(X(outer), Y(st.y0)); ctx.lineTo(X(outer), Y(st.y1)); }
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
  return cv;
}
