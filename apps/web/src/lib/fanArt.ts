import type { ChoreoDesign, FlagDesign, StandBlock, UltraGroup } from './matchClient';
import { GAP, L, W, stadiumLayout, type Seat, type StadiumArtOptions } from './stadiumArt';

/**
 * Fankultur im Stadion (rein optisch): Choreografien als Blockfahnen aus Sitzplätzen, Ultragruppen
 * mit Zaunfahne in ihrem Block und Schwenkfahnen. Choreo/Ultras werden einmal je Größe vorberechnet,
 * Schwenkfahnen pro Frame gezeichnet (wenige Pfade, kein Bild-Upload) – ressourcenschonend auf dem iPad.
 */
export type BlockKey = StandBlock | 'all';

export const BLOCK_LABEL: Record<StandBlock, string> = {
  home_curve: 'Heimkurve', main_stand: 'Haupttribüne', back_stand: 'Gegengerade', corner_left: 'Ecke links', corner_right: 'Ecke rechts',
};

export function inBlock(st: Seat, block: BlockKey): boolean {
  if (st.away) return false;
  switch (block) {
    case 'home_curve': return st.x < -GAP * 0.5;
    case 'main_stand': return st.side === 'bottom' && st.x >= L * 0.22 && st.x <= L * 0.78;
    case 'back_stand': return st.side === 'top' && st.x >= 0 && st.x <= L;
    case 'corner_left': return st.side === 'bottom' && st.x >= -GAP && st.x < L * 0.22;
    case 'corner_right': return st.side === 'bottom' && st.x > L * 0.78 && st.x <= L + GAP;
    default: return true;
  }
}

/** Lokale Koordinaten im Block: u entlang der Tribüne, v = Abstand vom Spielfeld (Meter) */
function local(st: Seat): [number, number] {
  if (st.x < -GAP * 0.5) return [st.y, -st.x];
  if (st.x > L + GAP * 0.5) return [st.y, st.x - L];
  if (st.side === 'bottom') return [st.x, st.y - W];
  return [st.x, -st.y];
}

function hash(n: number): number { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

function choreoColor(d: ChoreoDesign, u: number, v: number, umin: number, umax: number, vmax: number): string {
  const cs = d.colors.length ? d.colors : ['#ffffff'];
  const n = cs.length;
  const span = Math.max(1, umax - umin);
  const fu = (u - umin) / span;
  switch (d.pattern) {
    case 'stripes': return cs[Math.floor(fu * n * 3) % n]!;
    case 'blocks': return cs[(Math.floor(fu * 2) + Math.floor((v / Math.max(1, vmax)) * 2) * 2) % n]!;
    case 'checker': return cs[(Math.floor(u / 2.4) + Math.floor(v / 2.4)) % n]!;
    case 'wave': return cs[Math.floor((v / Math.max(1, vmax)) * n + Math.sin(fu * Math.PI * 4) * 0.8 + n) % n]!;
    case 'gradient': return cs[Math.min(n - 1, Math.floor((v / Math.max(1, vmax)) * n))]!;
    case 'rays': {
      const a = Math.atan2(v + 2, (fu - 0.5) * span);
      return cs[Math.floor((a / Math.PI) * 12) % n]!;
    }
    case 'mosaic': return cs[Math.floor(hash(Math.floor(u / 3) * 31 + Math.floor(v / 3) * 7) * n)]!;
    default: return cs[0]!;
  }
}

/** Einfache Motive als Pfad (Einheitskreis −1…1) */
function motifPath(ctx: CanvasRenderingContext2D, motif: string, cx: number, cy: number, r: number) {
  ctx.beginPath();
  if (motif === 'star') {
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.45 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  } else if (motif === 'heart') {
    ctx.moveTo(cx, cy + r * 0.8);
    ctx.bezierCurveTo(cx - r * 1.3, cy - r * 0.1, cx - r * 0.6, cy - r, cx, cy - r * 0.35);
    ctx.bezierCurveTo(cx + r * 0.6, cy - r, cx + r * 1.3, cy - r * 0.1, cx, cy + r * 0.8);
  } else if (motif === 'crown') {
    ctx.moveTo(cx - r, cy + r * 0.6); ctx.lineTo(cx - r, cy - r * 0.4); ctx.lineTo(cx - r * 0.5, cy + r * 0.05); ctx.lineTo(cx, cy - r * 0.7);
    ctx.lineTo(cx + r * 0.5, cy + r * 0.05); ctx.lineTo(cx + r, cy - r * 0.4); ctx.lineTo(cx + r, cy + r * 0.6);
  } else if (motif === 'crest') {
    ctx.moveTo(cx - r * 0.8, cy - r * 0.8); ctx.lineTo(cx + r * 0.8, cy - r * 0.8); ctx.lineTo(cx + r * 0.8, cy);
    ctx.quadraticCurveTo(cx + r * 0.7, cy + r * 0.7, cx, cy + r); ctx.quadraticCurveTo(cx - r * 0.7, cy + r * 0.7, cx - r * 0.8, cy);
  } else if (motif === 'lion') {
    // stilisierter Löwenkopf: Mähne (Zacken) + Gesicht
    for (let i = 0; i < 16; i++) { const a = (i * Math.PI) / 8; const rr = i % 2 ? r * 0.78 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    ctx.closePath(); ctx.moveTo(cx + r * 0.5, cy); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  } else if (motif === 'eagle') {
    ctx.moveTo(cx, cy - r * 0.5); ctx.lineTo(cx - r, cy - r * 0.8); ctx.lineTo(cx - r * 0.7, cy - r * 0.1); ctx.lineTo(cx - r * 0.95, cy + r * 0.1);
    ctx.lineTo(cx - r * 0.3, cy + r * 0.2); ctx.lineTo(cx, cy + r); ctx.lineTo(cx + r * 0.3, cy + r * 0.2); ctx.lineTo(cx + r * 0.95, cy + r * 0.1);
    ctx.lineTo(cx + r * 0.7, cy - r * 0.1); ctx.lineTo(cx + r, cy - r * 0.8);
  } else if (motif === 'anchor') {
    ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r * 0.8);
    ctx.moveTo(cx - r * 0.5, cy - r * 0.5); ctx.lineTo(cx + r * 0.5, cy - r * 0.5);
    ctx.moveTo(cx - r * 0.8, cy + r * 0.2); ctx.quadraticCurveTo(cx - r * 0.6, cy + r, cx, cy + r * 0.8); ctx.quadraticCurveTo(cx + r * 0.6, cy + r, cx + r * 0.8, cy + r * 0.2);
    ctx.lineWidth = r * 0.22; ctx.stroke(); return;
  } else if (motif === 'castle') {
    ctx.moveTo(cx - r, cy + r * 0.8); ctx.lineTo(cx - r, cy - r * 0.6);
    for (let i = 0; i < 5; i++) { const x0 = cx - r + (i * 2 * r) / 5; ctx.lineTo(x0, cy - r * 0.9); ctx.lineTo(x0 + (r * 2) / 10, cy - r * 0.9); ctx.lineTo(x0 + (r * 2) / 10, cy - r * 0.6); ctx.lineTo(x0 + (r * 4) / 10, cy - r * 0.6); }
    ctx.lineTo(cx + r, cy + r * 0.8); ctx.closePath();
    ctx.moveTo(cx + r * 0.25, cy + r * 0.8); ctx.arc(cx, cy + r * 0.45, r * 0.25, 0, Math.PI, true);
  } else return;
  ctx.closePath();
  ctx.fill('evenodd');
}

/** Choreografie (Blockfahne aus allen Sitzen des Blocks, auch leere – wie bei echten Choreos) */
export function renderChoreoDesign(o: StadiumArtOptions, d: ChoreoDesign): HTMLCanvasElement {
  const { seats } = stadiumLayout(o);
  const cv = document.createElement('canvas');
  cv.width = o.width; cv.height = o.height;
  const ctx = cv.getContext('2d')!;
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;
  const blocks: BlockKey[] = d.block === 'all' ? ['home_curve', 'main_stand', 'back_stand'] : [d.block ?? 'home_curve'];
  for (const b of blocks) {
    const mine = seats.filter((st) => inBlock(st, b));
    if (!mine.length) continue;
    const loc = mine.map(local);
    const umin = Math.min(...loc.map((l) => l[0])), umax = Math.max(...loc.map((l) => l[0]));
    const vmax = Math.max(...loc.map((l) => l[1]));
    mine.forEach((st, i) => {
      const [u, v] = loc[i]!;
      // ganze Sitzfläche füllen: aus der Nähe einzelne Fahnen, aus der Ferne ein geschlossenes Bild
      ctx.fillStyle = choreoColor(d, u, v, umin, umax, vmax);
      ctx.fillRect(X(st.x) - 0.42 * o.s, Y(st.y) - 0.47 * o.s, 0.84 * o.s + 0.5, 0.94 * o.s + 0.5);
    });
    // Mitte des Blocks: Motiv und Schriftzug
    const xs = mine.map((st) => st.x), ys = mine.map((st) => st.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const vertical = b === 'home_curve';
    const cx = X((x0 + x1) / 2), cy = Y((y0 + y1) / 2);
    const thick = (vertical ? x1 - x0 : y1 - y0) * o.s;
    const len = (vertical ? y1 - y0 : x1 - x0) * o.s;
    const fg = d.colors[d.colors.length - 1] ?? '#ffffff';
    const bg = d.colors[0] ?? '#000000';
    ctx.save();
    ctx.translate(cx, cy);
    if (vertical) ctx.rotate(-Math.PI / 2);
    const motif = d.motif ?? 'none';
    const text = (d.text ?? '').toUpperCase();
    if (motif !== 'none') {
      const r = Math.min(thick * 0.42, len * 0.12);
      ctx.fillStyle = fg === bg ? '#ffffff' : fg; ctx.strokeStyle = ctx.fillStyle;
      motifPath(ctx, motif, text ? -len * 0.3 : 0, 0, r);
      if (text) motifPath(ctx, motif, len * 0.3, 0, r);
    }
    if (text) {
      const size = Math.max(9, Math.min(thick * 0.62, (len * (motif !== 'none' ? 0.5 : 0.85)) / Math.max(3, text.length * 0.62)));
      ctx.font = `800 ${Math.round(size)}px "Barlow Condensed", system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(1, size * 0.12); ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = fg === bg ? '#ffffff' : fg;
      ctx.fillText(text, 0, 0);
    }
    ctx.restore();
  }
  return cv;
}

/** Ultragruppen: Fans in Gruppenfarben im zugewiesenen Block + Zaunfahne mit Gruppennamen */
export function renderUltrasLayer(o: StadiumArtOptions, ultras: UltraGroup[], intensity: number): HTMLCanvasElement {
  const { seats } = stadiumLayout(o);
  const cv = document.createElement('canvas');
  cv.width = o.width; cv.height = o.height;
  const ctx = cv.getContext('2d')!;
  const X = (x: number) => o.ox + x * o.s;
  const Y = (y: number) => o.oy + y * o.s;
  const dot = Math.max(1, Math.min(3.2, o.s * 0.5));
  ultras.forEach((g, gi) => {
    const mine = seats.filter((st) => inBlock(st, g.block));
    if (!mine.length) return;
    const loc = mine.map(local);
    const umin = Math.min(...loc.map((l) => l[0])), umax = Math.max(...loc.map((l) => l[0]));
    // mehrere Gruppen im selben Block teilen sich den Block
    const sameBlock = ultras.filter((x) => x.block === g.block);
    const k = sameBlock.indexOf(g), parts = sameBlock.length;
    const a = umin + ((umax - umin) * k) / parts, b = umin + ((umax - umin) * (k + 1)) / parts;
    const share = 0.55 + 0.35 * intensity;
    mine.forEach((st, i) => {
      const [u, v] = loc[i]!;
      if (u < a || u > b || !st.taken) return;
      if (hash(i * 13 + gi) > share) return;
      ctx.fillStyle = g.colors[(Math.floor(v / 1.8) + i) % g.colors.length]!;
      ctx.beginPath(); ctx.arc(X(st.x), Y(st.y), dot * 0.62, 0, Math.PI * 2); ctx.fill();
    });
    // Zaunfahne am vorderen Rand des Blocks
    const text = (g.banner || g.name).toUpperCase();
    const vertical = g.block === 'home_curve';
    const mid = (a + b) / 2;
    const lenM = Math.max(6, (b - a) * 0.8);
    ctx.save();
    if (vertical) { ctx.translate(X(-GAP * 0.55), Y(mid)); ctx.rotate(-Math.PI / 2); }
    else if (g.block === 'back_stand') ctx.translate(X(mid), Y(-GAP * 0.55));
    else ctx.translate(X(mid), Y(W + GAP * 0.55));
    const h = Math.max(9, o.s * 1.8), w = lenM * o.s;
    ctx.fillStyle = g.colors[0]!;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = g.colors[1] ?? '#ffffff';
    ctx.fillRect(-w / 2, -h / 2, w, Math.max(1, h * 0.14)); ctx.fillRect(-w / 2, h / 2 - Math.max(1, h * 0.14), w, Math.max(1, h * 0.14));
    ctx.font = `800 ${Math.round(h * 0.7)}px "Barlow Condensed", system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = g.colors[1] ?? '#ffffff';
    ctx.fillText(text, 0, h * 0.04, w * 0.94);
    ctx.restore();
  });
  return cv;
}

export interface FlagSpot { x: number; y: number; flag: FlagDesign; phase: number; scale: number; side: 'left' | 'top' | 'bottom' }

/** Positionen der Schwenkfahnen (Pixel): Heimkurve + Ultra-Blöcke, Anzahl nach Stimmung und Auslastung */
export function flagSpots(o: StadiumArtOptions, flags: FlagDesign[], ultras: UltraGroup[], intensity: number): FlagSpot[] {
  const { seats } = stadiumLayout(o);
  const pool: Array<{ block: BlockKey; flag: FlagDesign }> = [];
  for (const f of flags) pool.push({ block: 'home_curve', flag: f });
  for (const g of ultras) pool.push({ block: g.block, flag: g.flag ?? { shape: 'rect', size: 'm', pattern: 'halves', colors: g.colors.slice(0, 2) } });
  if (!pool.length) return [];
  const fill = Math.min(1, o.attendance / Math.max(1, o.capacity));
  const total = Math.round(Math.min(26, 6 + 14 * intensity) * (0.4 + 0.6 * fill));
  const out: FlagSpot[] = [];
  for (let i = 0; i < total; i++) {
    const pick = pool[i % pool.length]!;
    const cand = seats.filter((st) => st.taken && inBlock(st, pick.block));
    if (!cand.length) continue;
    const st = cand[Math.floor(hash(i * 7.3 + 1) * cand.length)]!;
    const side: FlagSpot['side'] = st.x < -GAP * 0.5 ? 'left' : st.side === 'top' ? 'top' : 'bottom';
    out.push({ x: o.ox + st.x * o.s, y: o.oy + st.y * o.s, flag: pick.flag, phase: hash(i * 3.1) * Math.PI * 2, scale: o.s, side });
  }
  return out;
}

const SIZE: Record<FlagDesign['size'], number> = { s: 1.6, m: 2.3, l: 3.2 };

/** Eine Fahne zeichnen (wave = Zeit in Sekunden; 0 = ruhend, z. B. im Editor) */
export function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, unit: number, f: FlagDesign, wave: number, dir: 'left' | 'top' | 'bottom' = 'bottom') {
  const w = SIZE[f.size] * unit * (f.shape === 'banner' ? 1.7 : f.shape === 'square' ? 0.8 : 1);
  const h = f.shape === 'square' ? w : f.shape === 'banner' ? w * 0.38 : w * 0.66;
  const swing = Math.sin(wave * 2.6) * 0.55; // Schwenkbewegung des Stabs
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((dir === 'left' ? Math.PI / 2 : dir === 'top' ? Math.PI : 0) + swing);
  // Stab
  ctx.strokeStyle = '#d9d2c2'; ctx.lineWidth = Math.max(1, unit * 0.12);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -h * 1.5); ctx.stroke();
  // Tuch in Streifen mit Welle (günstig: 10 Segmente)
  const segs = 10;
  const top = -h * 1.5;
  ctx.save();
  const yOff = (t: number) => Math.sin(wave * 6 + t * 5) * h * 0.09 * t;
  const taper = (t: number) => (f.shape === 'triangle' ? t * h * 0.5 : 0);
  ctx.beginPath();
  // Oberkante
  for (let i = 0; i <= segs; i++) { const t = i / segs; ctx.lineTo(t * w, top + yOff(t) + taper(t)); }
  // Ende (Schwalbenschwanz: Kerbe in der Mitte)
  if (f.shape === 'swallow') ctx.lineTo(w * 0.8, top + h / 2 + yOff(1));
  // Unterkante zurück
  for (let i = segs; i >= 0; i--) { const t = i / segs; ctx.lineTo(t * w, top + h + yOff(t) - taper(t)); }
  ctx.closePath();
  ctx.clip();
  paintPattern(ctx, f, 0, top - h * 0.2, w, h * 1.4);
  ctx.restore();
  if (f.text) {
    ctx.font = `800 ${Math.max(6, Math.round(h * 0.42))}px "Barlow Condensed", system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = f.colors[f.colors.length - 1] === f.colors[0] ? '#ffffff' : (f.colors[1] ?? '#ffffff');
    ctx.fillText(f.text.toUpperCase(), w * 0.48, top + h / 2, w * 0.9);
  }
  ctx.restore();
}

export function paintPattern(ctx: CanvasRenderingContext2D, f: FlagDesign, x: number, y: number, w: number, h: number) {
  const c = f.colors.length ? f.colors : ['#ffffff'];
  const c0 = c[0]!, c1 = c[1] ?? c0, c2 = c[2] ?? c1;
  ctx.fillStyle = c0; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = c1;
  switch (f.pattern) {
    case 'stripes_h': for (let i = 1; i < 5; i += 2) ctx.fillRect(x, y + (h * i) / 5, w, h / 5); if (c.length > 2) { ctx.fillStyle = c2; ctx.fillRect(x, y + (h * 2) / 5, w, h / 5); } break;
    case 'stripes_v': for (let i = 1; i < 5; i += 2) ctx.fillRect(x + (w * i) / 5, y, w / 5, h); break;
    case 'diagonal': ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h * 0.35); ctx.lineTo(x + w * 0.35, y + h); ctx.closePath(); ctx.fill(); break;
    case 'halves': ctx.fillRect(x + w / 2, y, w / 2, h); break;
    case 'cross': ctx.fillRect(x + w * 0.3, y, w * 0.14, h); ctx.fillRect(x, y + h * 0.43, w, h * 0.14); break;
    case 'checker': for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) ctx.fillRect(x + (w * i) / 6, y + (h * j) / 4, w / 6 + 0.5, h / 4 + 0.5); break;
    case 'star': {
      const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) * 0.3;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.45 : r; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill(); break;
    }
    default: break;
  }
}
