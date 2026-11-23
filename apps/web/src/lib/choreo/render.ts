import { drawFlag, motifPath } from '../fanArt';
import { GAP, L, W, type StadiumArtOptions } from '../stadiumArt';
import type { FlagDesign } from '../matchClient';
import { fenceRect, isAwayPoint, placementProblem, rectCorners, regionSeats, stadiumGeo, type StadiumGeo, type StandSeat } from './geometry';
import { isV2, normalizeChoreo, totalDuration, type AnyChoreo, type BannerEl, type CardsEl, type ChoreoElement, type ChoreoV2, type ConfettiEl, type FenceEl, type FlagsEl, type Pattern, type Reveal, type SmokeEl, type StreamersEl, type WaveEl, type BlockflagEl } from './model';

/**
 * Darstellung einer Choreografie (Canvas 2D). Derselbe Code läuft im Editor (Vorschau) und in der Matchansicht, mit derselben
 * Stadiongeometrie. Statische Elemente (Karten, Blockfahnen) werden einmal je Größe in zugeschnittene Bitmaps gezeichnet,
 * pro Frame werden nur Bitmaps kopiert, wenige Fahnen gezeichnet und begrenzte Partikel bewegt (kein Einfluss auf die Matchsimulation).
 */
export interface PlayCtx {
  /** Zeitstempel (ms) der Darstellung */
  now: number;
  /** Einlauf läuft: vergangene und Gesamtdauer in ms; sonst null */
  walkout: { elapsedMs: number; totalMs: number } | null;
  /** Spielminute (nach dem Einlauf bleiben nur beständige Elemente) */
  minute: number;
}

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const strHash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** Farbe eines Sitzes nach Muster; u = Meter entlang der Tribüne, v = Meter ab Spielfeldkante, ext = Ausdehnung des Bereichs */
export function patternColor(p: Pattern, cs: string[], u: number, v: number, ext: { u0: number; u1: number; v1: number }): string {
  const n = cs.length || 1, c = cs.length ? cs : ['#ffffff'];
  const span = Math.max(1, ext.u1 - ext.u0), fu = (u - ext.u0) / span, fv = v / Math.max(1, ext.v1);
  switch (p) {
    case 'solid': return c[0]!;
    case 'stripes': return c[Math.floor(fu * n * 3) % n]!;
    case 'stripes_v': return c[Math.floor(fv * n * 3) % n]!;
    case 'blocks': return c[(Math.floor(fu * 2) + Math.floor(fv * 2) * 2) % n]!;
    case 'checker': return c[(Math.floor(u / 2.4) + Math.floor(v / 2.4)) % n]!;
    case 'diagonal': return c[Math.floor((fu + fv) * n * 2.5) % n]!;
    case 'wave': return c[Math.floor(fv * n + Math.sin(fu * Math.PI * 4) * 0.8 + n) % n]!;
    case 'gradient': return c[Math.min(n - 1, Math.floor(fv * n))]!;
    case 'rays': return c[Math.floor((Math.atan2(v + 2, (fu - 0.5) * span) / Math.PI) * 12 + 24) % n]!;
    case 'mosaic': return c[Math.floor(hash(Math.floor(u / 3) * 31 + Math.floor(v / 3) * 7) * n)]!;
    default: return c[0]!;
  }
}

interface Bounds { x0: number; y0: number; x1: number; y1: number }
const boundsOf = (seats: StandSeat[]): Bounds => {
  const b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  for (const s of seats) { b.x0 = Math.min(b.x0, s.seat.x); b.x1 = Math.max(b.x1, s.seat.x); b.y0 = Math.min(b.y0, s.seat.y); b.y1 = Math.max(b.y1, s.seat.y); }
  return b;
};
/** Lokale Koordinaten im Bereich: u entlang der Tribüne (Meter), v = Abstand zur Spielfeldkante */
const localOf = (st: StandSeat): [number, number] => {
  const { x, y } = st.seat;
  if (st.side === 'W') return [y, -x];
  if (st.side === 'E') return [y, x - L];
  if (st.side === 'N' || st.side === 'NW' || st.side === 'NE') return [x, -y];
  return [x, y - W];
};

interface Layer {
  el: ChoreoElement;
  /** Bitmaps (bei Wechselmuster zwei) und Lage in Pixeln */
  img: HTMLCanvasElement[];
  px: number; py: number; pw: number; ph: number;
  /** Aufdeckrichtung: Achse der längeren Ausdehnung */
  axisX: boolean;
}
interface Particle { x: number; y: number; vx: number; vy: number; r: number; c: string; ph: number; a: number }
interface Spot { x: number; y: number; dir: 'left' | 'top' | 'bottom' | 'right'; phase: number }

const FLAG_SIZE = { swing_s: 's', swing_l: 'l', double: 'm' } as const;

export class ChoreoPlayer {
  readonly design: ChoreoV2;
  readonly geo: StadiumGeo;
  private o: StadiumArtOptions;
  private layers = new Map<string, Layer>();
  private spots = new Map<string, Spot[]>();
  private parts = new Map<string, Particle[]>();
  private bounds = new Map<string, Bounds>();
  private wave = new Map<string, { img: HTMLCanvasElement; axisX: boolean; px: number; py: number; pw: number; ph: number }>();
  private sprites = new Map<string, HTMLCanvasElement>();
  private lastNow = 0;
  /** Adaptive Qualität (1 = voll): bei zu langen Frames werden Fahnen und Partikel schrittweise reduziert, bei Entspannung wieder erhöht */
  private q = 1;
  private ema = 16;
  private lastQ = 0;
  get quality(): number { return this.q; }
  private reduced: boolean;
  private seed: number;
  /** Diagnose: gezeichnete Elemente im letzten Frame (Tests) */
  lastDrawn: string[] = [];

  constructor(o: StadiumArtOptions, design: AnyChoreo, opts: { reduced?: boolean } = {}) {
    this.o = o; this.design = normalizeChoreo(design); this.reduced = !!opts.reduced;
    this.geo = stadiumGeo(o.capacity, o.design);
    this.seed = strHash(JSON.stringify(this.design.elements.map((e) => e.id)));
    for (const el of this.design.elements) this.prepare(el);
  }

  private X = (x: number) => this.o.ox + x * this.o.s;
  private Y = (y: number) => this.o.oy + y * this.o.s;

  private prepare(el: ChoreoElement) {
    const o = this.o;
    if (el.kind === 'cards' || el.kind === 'blockflag') {
      const seats = regionSeats(this.geo, el.regions);
      if (!seats.length) return; // keine Choreografie auf nicht vorhandenen Tribünen
      const b = boundsOf(seats); this.bounds.set(el.id, b);
      const pad = 0.6;
      const px = Math.floor(this.X(b.x0 - pad)), py = Math.floor(this.Y(b.y0 - pad));
      const pw = Math.ceil((b.x1 - b.x0 + 2 * pad) * o.s) + 1, ph = Math.ceil((b.y1 - b.y0 + 2 * pad) * o.s) + 1;
      const variants: Array<{ p: Pattern; cs: string[] }> = [{ p: el.pattern, cs: el.colors }];
      if (el.kind === 'cards' && el.flip && el.colors2?.length) variants.push({ p: el.pattern2 ?? el.pattern, cs: el.colors2 });
      const img = variants.map((v) => this.paintSeats(el, seats, b, px, py, pw, ph, v.p, v.cs));
      this.layers.set(el.id, { el, img, px, py, pw, ph, axisX: b.x1 - b.x0 >= b.y1 - b.y0 });
    } else if (el.kind === 'flags') {
      this.spots.set(el.id, this.flagSpots(el));
    } else if (el.kind === 'confetti' || el.kind === 'streamers' || el.kind === 'smoke') {
      const seats = regionSeats(this.geo, el.regions);
      if (!seats.length) return;
      this.bounds.set(el.id, boundsOf(seats));
      this.parts.set(el.id, this.spawn(el, seats));
    } else if (el.kind === 'wave') {
      const seats = regionSeats(this.geo, el.regions);
      if (!seats.length) return;
      const b = boundsOf(seats); this.bounds.set(el.id, b);
      const pad = 0.6;
      const px = Math.floor(this.X(b.x0 - pad)), py = Math.floor(this.Y(b.y0 - pad));
      const pw = Math.ceil((b.x1 - b.x0 + 2 * pad) * o.s) + 1, ph = Math.ceil((b.y1 - b.y0 + 2 * pad) * o.s) + 1;
      const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
      const c = cv.getContext('2d')!;
      const dot = Math.max(1.5, Math.min(4, o.s * 0.62));
      c.fillStyle = el.colors[0] ?? '#ffffff';
      for (const s of seats) { c.beginPath(); c.arc(this.X(s.seat.x) - px, this.Y(s.seat.y) - py, dot * 0.62, 0, Math.PI * 2); c.fill(); }
      this.wave.set(el.id, { img: cv, axisX: b.x1 - b.x0 >= b.y1 - b.y0, px, py, pw, ph });
    }
  }

  private paintSeats(el: CardsEl | BlockflagEl, seats: StandSeat[], b: Bounds, px: number, py: number, pw: number, ph: number, pattern: Pattern, cs: string[]): HTMLCanvasElement {
    const o = this.o;
    const cv = document.createElement('canvas'); cv.width = pw; cv.height = ph;
    const ctx = cv.getContext('2d')!;
    const loc = seats.map(localOf);
    const ext = { u0: Math.min(...loc.map((l) => l[0])), u1: Math.max(...loc.map((l) => l[0])), v1: Math.max(...loc.map((l) => l[1])) };
    const cell = el.kind === 'blockflag' ? 1 : 0; // Blockfahne: lückenloses Tuch, Karten: einzelne Quadrate
    seats.forEach((st, i) => {
      const [u, v] = loc[i]!;
      ctx.fillStyle = patternColor(pattern, cs, u, v, ext);
      const w = (cell ? 1.0 : 0.84) * o.s, h = (cell ? 1.0 : 0.94) * o.s;
      ctx.fillRect(this.X(st.seat.x) - px - w / 2, this.Y(st.seat.y) - py - h / 2, w + 0.5, h + 0.5);
    });
    if (el.kind === 'blockflag') { // Stofffalten: dezente Schattenlinien
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let k = 0; k < 14; k++) { const t = (k + 0.5) / 14; ctx.fillRect(k % 2 ? t * pw : 0, k % 2 ? 0 : t * ph, k % 2 ? Math.max(1, o.s * 0.3) : pw, k % 2 ? ph : Math.max(1, o.s * 0.3)); }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Symbol und Schriftzug in der Mitte (über die gesamte Ausdehnung des Bereichs, auch über mehrere Blöcke)
    const text = (el.text ?? '').toUpperCase(), motif = el.motif ?? 'none';
    if (text || motif !== 'none') {
      const vertical = b.y1 - b.y0 > (b.x1 - b.x0) * 1.15 && seats[0]!.side !== 'N' && seats[0]!.side !== 'S';
      const dom = seats[0]!.side;
      const thick = (vertical ? b.x1 - b.x0 : b.y1 - b.y0) * o.s, len = (vertical ? b.y1 - b.y0 : b.x1 - b.x0) * o.s;
      ctx.save();
      ctx.translate(this.X((b.x0 + b.x1) / 2) - px, this.Y((b.y0 + b.y1) / 2) - py);
      if (vertical) ctx.rotate(dom === 'E' ? Math.PI / 2 : -Math.PI / 2);
      const fg = cs[cs.length - 1] ?? '#ffffff', bg = cs[0] ?? '#000000';
      const col = fg === bg ? '#ffffff' : fg;
      if (motif !== 'none') { const r = Math.min(thick * 0.42, len * 0.12); ctx.fillStyle = col; ctx.strokeStyle = col; motifPath(ctx, motif === 'ball' ? 'star' : motif === 'bolt' ? 'crown' : motif, text ? -len * 0.3 : 0, 0, r); if (text) motifPath(ctx, motif === 'ball' ? 'star' : motif === 'bolt' ? 'crown' : motif, len * 0.3, 0, r); }
      if (text) {
        const size = Math.max(9, Math.min(thick * 0.62, (len * (motif !== 'none' ? 0.5 : 0.85)) / Math.max(3, text.length * 0.62)));
        ctx.font = `800 ${Math.round(size)}px "Barlow Condensed", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(1, size * 0.12); ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.strokeText(text, 0, 0); ctx.fillStyle = col; ctx.fillText(text, 0, 0);
      }
      ctx.restore();
    }
    return cv;
  }

  private flagSpots(el: FlagsEl): Spot[] {
    const out: Spot[] = [];
    const dirOf = (side: StandSeat['side']): Spot['dir'] => (side === 'W' || side === 'NW' || side === 'SW' ? 'left' : side === 'E' || side === 'NE' || side === 'SE' ? 'right' : side === 'N' ? 'top' : 'bottom');
    if (el.points?.length) {
      for (const [i, p] of el.points.entries()) {
        if (placementProblem(this.geo, [[p.x, p.y]])) continue; // nicht auf dem Spielfeld, nicht im Gästeblock
        const dir: Spot['dir'] = p.x < -GAP * 0.5 ? 'left' : p.x > L + GAP * 0.5 ? 'right' : p.y < 0 ? 'top' : 'bottom';
        out.push({ x: p.x, y: p.y, dir, phase: hash(i * 3.1 + this.seed) * 6.28 });
      }
      return out;
    }
    const seats = regionSeats(this.geo, el.regions).sort((a, b) => a.side.localeCompare(b.side) || a.u - b.u || a.tierIndex - b.tierIndex);
    const n = seats.length;
    if (!n) return out;
    const count = Math.min(el.count, 40);
    for (let i = 0; i < count; i++) {
      const s = seats[Math.min(n - 1, Math.floor(((i + 0.5) / count) * n))]!;
      out.push({ x: s.seat.x, y: s.seat.y, dir: dirOf(s.side), phase: hash(i * 3.1 + this.seed) * 6.28 });
    }
    return out;
  }

  private spawn(el: ConfettiEl | StreamersEl | SmokeEl, seats: StandSeat[]): Particle[] {
    const r = rng(this.seed ^ strHash(el.id));
    const n = el.kind === 'confetti' ? Math.min(150, el.density * 30) : el.kind === 'streamers' ? Math.min(25, el.density * 5) : Math.min(30, el.density * 6);
    const b = boundsOf(seats);
    const cs = el.colors.length ? el.colors : ['#ffffff'];
    const out: Particle[] = [];
    for (let i = 0; i < n; i++) {
      const s = seats[Math.floor(r() * seats.length)]!;
      out.push({ x: s.seat.x, y: el.kind === 'confetti' ? b.y0 + r() * (b.y1 - b.y0) : s.seat.y, vx: (r() - 0.5) * 0.6, vy: 0.8 + r() * 1.0, r: 0.25 + r() * 0.3, c: cs[Math.floor(r() * cs.length)]!, ph: r() * 6.28, a: r() });
    }
    return out;
  }

  private sprite(color: string): HTMLCanvasElement {
    let s = this.sprites.get(color);
    if (!s) {
      s = document.createElement('canvas'); s.width = s.height = 48;
      const c = s.getContext('2d')!; const g = c.createRadialGradient(24, 24, 2, 24, 24, 24);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.globalAlpha = 0.9; c.fillRect(0, 0, 48, 48);
      this.sprites.set(color, s);
    }
    return s;
  }

  /** Gesamtdauer der Szenen (s) */
  get duration(): number { return totalDuration(this.design); }
  /** Zeit (s) auf der Szenenzeitachse, an der die Szene i beginnt */
  sceneStart(i: number): number { let t = 0; for (let k = 0; k < i; k++) t += this.design.scenes[k]!.dur; return t; }
  sceneAt(t: number): { index: number; local: number } {
    let acc = 0;
    for (let i = 0; i < this.design.scenes.length; i++) { const d = this.design.scenes[i]!.dur; if (t < acc + d) return { index: i, local: t - acc }; acc += d; }
    const last = this.design.scenes.length - 1;
    return { index: last, local: this.design.scenes[last]!.dur };
  }

  /**
   * Zeichnet die Choreografie zum Zeitpunkt t (Sekunden auf der Szenenzeitachse).
   * persistOnly: nur beständige Elemente (während des Spiels). alpha: Gesamttransparenz (Ausblenden nach dem Einlauf).
   */
  drawTimeline(ctx: CanvasRenderingContext2D, t: number, now: number, o: { persistOnly?: boolean; alpha?: number; staticFrame?: boolean } = {}) {
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0.016;
    if (this.lastNow && now > this.lastNow) {
      this.ema = this.ema * 0.92 + Math.min(100, now - this.lastNow) * 0.08;
      if (this.ema > 21 && now - this.lastQ > 700 && this.q > 0.25) { this.q = Math.max(0.25, this.q * 0.7); this.lastQ = now; }
      else if (this.ema < 17.6 && now - this.lastQ > 5000 && this.q < 1) { this.q = Math.min(1, this.q / 0.8); this.lastQ = now; }
    }
    this.lastNow = now;
    const { index, local } = this.sceneAt(Math.max(0, t));
    const n = this.design.scenes.length;
    const drawn: string[] = [];
    const baseAlpha = o.alpha ?? 1;
    for (const el of this.design.elements) {
      const active = el.s0 <= index && index <= el.s1;
      if (!active && !(el.persist && o.persistOnly)) continue;
      if (o.persistOnly && !el.persist) continue;
      // Ein- und Ausblenden an den Szenengrenzen
      let a = baseAlpha;
      if (!o.persistOnly && !o.staticFrame) { // statische Ansicht (Editor, Vorbereitung): Endzustand der Szene ohne Überblendung
        const into = index - el.s0 === 0 ? clamp(local / 0.7) : 1;
        const left = el.s1 === index && !el.persist && index < n - 1 ? clamp((this.design.scenes[index]!.dur - local) / 0.7) : 1;
        a *= Math.min(into, left);
      }
      if (a <= 0.01) continue;
      this.drawElement(ctx, el, index, local, a, dt, now, !!o.staticFrame);
      drawn.push(el.id);
    }
    this.lastDrawn = drawn;
  }

  private revealClip(ctx: CanvasRenderingContext2D, ly: Layer, reveal: Reveal, p: number): boolean {
    // liefert true, wenn (teilweise) etwas zu zeichnen ist; setzt ggf. Clipping
    if (reveal === 'none' || reveal === 'fade' || p >= 1) return true;
    if (p <= 0) return false;
    ctx.beginPath();
    const dirDown = reveal === 'down' || (reveal === 'sweep' && ly.axisX);
    if (reveal === 'up') ctx.rect(ly.px, ly.py + ly.ph * (1 - p), ly.pw, ly.ph * p);
    else if (reveal === 'down') ctx.rect(ly.px, ly.py, ly.pw, ly.ph * p);
    else if (dirDown) ctx.rect(ly.px, ly.py, ly.pw * p, ly.ph);
    else ctx.rect(ly.px, ly.py, ly.pw, ly.ph * p);
    ctx.clip();
    return true;
  }

  private drawElement(ctx: CanvasRenderingContext2D, el: ChoreoElement, scene: number, local: number, alpha: number, dt: number, now: number, still: boolean) {
    const o = this.o;
    const secs = now / 1000;
    switch (el.kind) {
      case 'cards': case 'blockflag': {
        const ly = this.layers.get(el.id); if (!ly) return;
        const reveal = el.reveal ?? (el.kind === 'blockflag' ? 'down' : 'fade');
        const p = still ? 1 : clamp(local / Math.max(1.2, this.design.scenes[scene]!.dur * 0.55));
        const ready = el.s0 === scene ? p : 1;
        const variant = el.kind === 'cards' && el.flip && ly.img.length > 1 && !still ? Math.floor(secs / el.flip) % 2 : 0;
        ctx.save();
        if (!this.revealClip(ctx, ly, reveal, ready)) { ctx.restore(); return; }
        ctx.globalAlpha = alpha * (reveal === 'fade' ? ready : 1);
        ctx.drawImage(ly.img[variant]!, ly.px, ly.py);
        // Blockfahne: aufgerollte Kante während des Ausrollens
        if (el.kind === 'blockflag' && ready < 1) {
          ctx.globalAlpha = alpha; ctx.fillStyle = 'rgba(0,0,0,0.35)';
          if (reveal === 'down') ctx.fillRect(ly.px, ly.py + ly.ph * ready - o.s * 0.5, ly.pw, o.s * 0.5);
          else if (reveal === 'up') ctx.fillRect(ly.px, ly.py + ly.ph * (1 - ready), ly.pw, o.s * 0.5);
        }
        ctx.restore();
        break;
      }
      case 'banner': this.drawBanner(ctx, el, alpha); break;
      case 'fence': this.drawFence(ctx, el, alpha); break;
      case 'flags': {
        const sp = this.spots.get(el.id); if (!sp) return;
        const f: FlagDesign = { shape: el.flag.shape, size: FLAG_SIZE[el.size], pattern: el.flag.pattern, colors: el.flag.colors, text: el.flag.text };
        ctx.save(); ctx.globalAlpha = alpha;
        const wt = this.reduced || still ? 0 : secs * 1.3;
        const nFlags = Math.max(1, Math.ceil(sp.length * this.q));
        for (let fi = 0; fi < nFlags; fi++) {
          const s = sp[fi]!;
          drawFlag(ctx, this.X(s.x), this.Y(s.y), o.s * 0.85, f, wt + s.phase, s.dir);
          if (el.size === 'double') drawFlag(ctx, this.X(s.x) + (s.dir === 'top' || s.dir === 'bottom' ? o.s * 1.1 : 0), this.Y(s.y) + (s.dir === 'left' || s.dir === 'right' ? o.s * 1.1 : 0), o.s * 0.85, f, wt + s.phase + 1.6, s.dir);
        }
        ctx.restore();
        break;
      }
      case 'confetti': case 'streamers': case 'smoke': this.drawParticles(ctx, el, alpha, dt, secs, still); break;
      case 'wave': {
        const w = this.wave.get(el.id); if (!w) return;
        const period = 5 / Math.max(0.3, el.speed);
        const ph = still ? 0.5 : (secs % period) / period;
        const band = 0.22;
        ctx.save(); ctx.globalAlpha = alpha * 0.8;
        if (w.axisX) { const sw = w.pw * band, sx = (ph * (1 + band) - band) * w.pw; const x0 = Math.max(0, sx), x1 = Math.min(w.pw, sx + sw); if (x1 > x0) ctx.drawImage(w.img, x0, 0, x1 - x0, w.ph, w.px + x0, w.py, x1 - x0, w.ph); }
        else { const sh = w.ph * band, sy = (ph * (1 + band) - band) * w.ph; const y0 = Math.max(0, sy), y1 = Math.min(w.ph, sy + sh); if (y1 > y0) ctx.drawImage(w.img, 0, y0, w.pw, y1 - y0, w.px, w.py + y0, w.pw, y1 - y0); }
        ctx.restore();
        break;
      }
    }
  }

  private fitText(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
    const size = Math.max(6, Math.min(h * 0.78, w / Math.max(3, text.length * 0.6)));
    ctx.font = `800 ${Math.round(size)}px "Barlow Condensed", system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    return size;
  }

  private drawBanner(ctx: CanvasRenderingContext2D, el: BannerEl, alpha: number) {
    const o = this.o;
    const corners = rectCorners(el.x, el.y, el.w, el.h, el.rot);
    if (placementProblem(this.geo, corners)) return; // nie auf dem Spielfeld oder im Gästeblock
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(this.X(el.x), this.Y(el.y)); ctx.rotate(((el.rot + (el.orient === 'v' ? 90 : 0)) * Math.PI) / 180);
    const w = (el.orient === 'v' ? el.h : el.w) * o.s, h = (el.orient === 'v' ? el.w : el.h) * o.s;
    ctx.fillStyle = el.colors[0] ?? '#c8102e'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = el.colors[1] ?? '#ffffff'; ctx.lineWidth = Math.max(1, h * 0.08); ctx.strokeRect(-w / 2 + ctx.lineWidth / 2, -h / 2 + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
    const text = el.text.toUpperCase();
    if (text) { this.fitText(ctx, text, w * 0.94, h); ctx.fillStyle = el.colors[1] ?? '#ffffff'; ctx.fillText(text, 0, 0); }
    ctx.restore();
  }

  private drawFence(ctx: CanvasRenderingContext2D, el: FenceEl, alpha: number) {
    const r = fenceRect(el.side, el.from, el.to, el.h); if (!r) return;
    const o = this.o;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(this.X(r.x), this.Y(r.y)); ctx.rotate((r.rot * Math.PI) / 180);
    const w = r.w * o.s, h = r.h * o.s;
    ctx.fillStyle = el.colors[0] ?? '#c8102e'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = el.colors[1] ?? '#ffffff'; ctx.fillRect(-w / 2, -h / 2, w, Math.max(1, h * 0.08)); ctx.fillRect(-w / 2, h / 2 - Math.max(1, h * 0.08), w, Math.max(1, h * 0.08));
    const text = el.text.toUpperCase();
    if (text) { this.fitText(ctx, text, w * 0.92, h); ctx.fillStyle = el.colors[1] ?? '#ffffff'; ctx.fillText(text, 0, 0); }
    ctx.restore();
  }

  private drawParticles(ctx: CanvasRenderingContext2D, el: ConfettiEl | StreamersEl | SmokeEl, alpha: number, dt: number, secs: number, still: boolean) {
    const ps = this.parts.get(el.id), b = this.bounds.get(el.id); if (!ps || !b) return;
    const o = this.o;
    ctx.save(); ctx.globalAlpha = alpha;
    const nDraw = Math.max(1, Math.ceil(ps.length * this.q));
    for (let pi = 0; pi < ps.length; pi++) {
      const p = ps[pi]!;
      if (!still && !this.reduced) {
        if (el.kind === 'confetti') { p.y += p.vy * dt; p.x += (p.vx + Math.sin(secs * 1.7 + p.ph) * 0.35) * dt; if (p.y > b.y1 + 1) { p.y = b.y0 - 0.5; } }
        else if (el.kind === 'smoke') { p.a += dt * 0.22; if (p.a > 1) p.a = 0; }
        else { p.a += dt * 0.35; if (p.a > 1) p.a = 0; }
      }
      if (pi >= nDraw) continue; // Qualitätsstufe: nur ein Teil der Partikel wird gezeichnet (alle bewegen sich weiter)
      const X = this.X(p.x), Y = this.Y(p.y);
      if (el.kind === 'confetti') {
        const a = secs * 2 + p.ph, cs = Math.cos(a), sn = Math.sin(a);
        ctx.setTransform(cs, sn, -sn, cs, X, Y); ctx.fillStyle = p.c; // ohne save/restore
        ctx.fillRect(-p.r * o.s * 0.5, -p.r * o.s * 0.25, p.r * o.s, p.r * o.s * 0.5);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else if (el.kind === 'smoke') {
        const k = still ? 0.5 : p.a, size = (3 + k * 9) * o.s;
        ctx.globalAlpha = alpha * (1 - k) * 0.8;
        ctx.drawImage(this.sprite(p.c), X - size / 2 + Math.sin(secs + p.ph) * o.s, Y - k * 8 * o.s - size / 2, size, size);
      } else {
        const k = still ? 0.6 : p.a, len = (2 + k * 7) * o.s, sway = Math.sin(secs * 2.2 + p.ph) * 1.8 * o.s;
        ctx.strokeStyle = p.c; ctx.lineWidth = Math.max(1, o.s * 0.22);
        ctx.beginPath(); ctx.moveTo(X, Y); ctx.quadraticCurveTo(X + sway, Y - len * 0.55, X + sway * 0.4 + (p.vx * 8) * o.s, Y - len); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Matchansicht: während des Einlaufs läuft die Szenenfolge (bei kurzem Einlauf gestaucht, bei langem hält der Schlusszustand),
   * danach bleiben beständige Elemente; Blockchoreografien des letzten Zustands nur bis Minute 5 (und kurz zur Halbzeit).
   */
  draw(ctx: CanvasRenderingContext2D, pc: PlayCtx) {
    const D = this.duration;
    if (pc.walkout) {
      const total = Math.max(1000, pc.walkout.totalMs);
      const scale = D * 1000 > total ? (D * 1000) / total : 1;
      const t = Math.min(D - 0.001, (pc.walkout.elapsedMs / 1000) * scale);
      this.drawTimeline(ctx, t, pc.now);
      return;
    }
    const show = pc.minute < 5 || (pc.minute >= 45 && pc.minute < 47);
    const fade = pc.minute < 5 ? clamp(5.8 - pc.minute) : pc.minute >= 45 && pc.minute < 47 ? clamp(47.6 - pc.minute) : 0;
    // Schlusszustand: letzte Szene; beständige Elemente immer, übrige solange sie ausgewählt sind (show)
    if (show) this.drawTimeline(ctx, D - 0.001, pc.now, { alpha: fade, staticFrame: false });
    // beständige Elemente (Fahnen, Banner) nach dem Ausblenden dauerhaft; Überlagerung vermeiden: nur wenn die Szene sie sonst nicht zeigt
    if (!show || fade < 1) this.drawTimeline(ctx, D - 0.001, pc.now, { persistOnly: true });
  }

  dispose() { this.layers.clear(); this.spots.clear(); this.parts.clear(); this.wave.clear(); this.sprites.clear(); }
}

/** Anzahl der in diesem Stadion tatsächlich sichtbaren Elemente (Tribünen vorhanden, nicht ausschließlich im Gästeblock) – für Hinweise im Editor */
export function visibleElements(o: StadiumArtOptions, design: AnyChoreo): number {
  const d = isV2(design) ? design : normalizeChoreo(design);
  const geo = stadiumGeo(o.capacity, o.design);
  let n = 0;
  for (const el of d.elements) {
    if ('regions' in el) { if (regionSeats(geo, el.regions).length) n++; }
    else if (el.kind === 'banner') { if (!placementProblem(geo, rectCorners(el.x, el.y, el.w, el.h, el.rot))) n++; }
    else if (el.kind === 'fence') { if (fenceRect(el.side, el.from, el.to, el.h)) n++; }
  }
  void isAwayPoint;
  return n;
}
