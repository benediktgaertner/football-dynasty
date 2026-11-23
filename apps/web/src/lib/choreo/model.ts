import type { ChoreoDesign, FlagDesign } from '../matchClient';

/**
 * Choreografie v2 (rein optisch): Szenen (aufeinanderfolgende Zustände) mit Elementen auf Tribünenbereichen.
 * Abwärtskompatibel: ein v2-Design trägt zusätzlich die Felder des alten Designs (pattern/colors/text/motif/block),
 * ältere Clients zeigen dann die einfache Blockchoreografie. Dieselbe Struktur validiert die Datenbank (fd_valid_choreo).
 */
export type StandSide = 'N' | 'S' | 'W' | 'E' | 'NW' | 'NE' | 'SW' | 'SE';
/** N = Gegengerade (oben), S = Haupttribüne (unten), W = Heimkurve (links), E = Osttribüne (rechts, mit Gästeblock) */
export const SIDE_LABEL: Record<StandSide, string> = { N: 'Nordtribüne', S: 'Südtribüne', W: 'Westtribüne (Heimkurve)', E: 'Osttribüne', NW: 'Ecke Nordwest', NE: 'Ecke Nordost', SW: 'Ecke Südwest', SE: 'Ecke Südost' };
export const SIDES: StandSide[] = ['N', 'S', 'W', 'E', 'NW', 'NE', 'SW', 'SE'];
export const CORNER_SIDES: StandSide[] = ['NW', 'NE', 'SW', 'SE'];
/** Ränge: lower = am Spielfeld, upper = außen (bei zwei Rängen), middle nur bei drei Rängen */
export type Tier = 'lower' | 'middle' | 'upper';
export const TIERS: Tier[] = ['lower', 'middle', 'upper'];
export const TIER_LABEL: Record<Tier, string> = { lower: 'Unterrang', middle: 'Mittelrang', upper: 'Oberrang' };

/** Tribünenbereich: Seite, Anteil entlang der Tribüne (0…1), Ränge (null = alle vorhandenen) */
export interface Region { side: StandSide; from?: number; to?: number; tiers?: Tier[] | null }

export type Pattern = 'solid' | 'stripes' | 'stripes_v' | 'checker' | 'blocks' | 'wave' | 'gradient' | 'rays' | 'mosaic' | 'diagonal';
export const PATTERNS: Array<[Pattern, string]> = [['solid', 'Einfarbig'], ['stripes', 'Streifen'], ['stripes_v', 'Streifen quer'], ['checker', 'Schachbrett'], ['blocks', 'Blöcke'], ['diagonal', 'Diagonal'], ['wave', 'Welle'], ['gradient', 'Verlauf'], ['rays', 'Strahlen'], ['mosaic', 'Mosaik']];
export type Motif = 'none' | 'star' | 'heart' | 'crown' | 'crest' | 'lion' | 'eagle' | 'anchor' | 'castle' | 'ball' | 'bolt';
export const MOTIFS: Array<[Motif, string]> = [['none', 'Kein Symbol'], ['star', 'Stern'], ['heart', 'Herz'], ['crown', 'Krone'], ['crest', 'Wappen'], ['lion', 'Löwe'], ['eagle', 'Adler'], ['anchor', 'Anker'], ['castle', 'Burg'], ['ball', 'Ball'], ['bolt', 'Blitz']];
export type Reveal = 'fade' | 'sweep' | 'down' | 'up' | 'none';

export type ElementKind = 'cards' | 'blockflag' | 'banner' | 'fence' | 'flags' | 'confetti' | 'streamers' | 'smoke' | 'wave';
export const KIND_LABEL: Record<ElementKind, string> = {
  cards: 'Pappkarten', blockflag: 'Blockfahne', banner: 'Spruchband', fence: 'Zaunbanner', flags: 'Schwenkfahnen',
  confetti: 'Konfetti', streamers: 'Luftschlangen', smoke: 'Farbrauch', wave: 'Welle',
};
/** Elemente mit freier Position (Meter im Stadion) bzw. an Tribünenbereiche gebunden */
export const FREE_KINDS: ElementKind[] = ['banner', 'fence'];

interface Base {
  id: string;
  kind: ElementKind;
  name?: string;
  /** sichtbar in den Szenen a…b (Index, einschließlich) */
  s0: number; s1: number;
  /** bleibt nach dem Einlauf während des Spiels sichtbar (Fahnen, Banner) */
  persist?: boolean;
}
export interface CardsEl extends Base { kind: 'cards'; regions: Region[]; pattern: Pattern; colors: string[]; text?: string; motif?: Motif; reveal?: Reveal;
  /** Muster wechselt alle N Sekunden zwischen Farbgruppe 1 und 2 (Wechselmuster) */
  flip?: number; colors2?: string[]; pattern2?: Pattern }
export interface BlockflagEl extends Base { kind: 'blockflag'; regions: Region[]; pattern: Pattern; colors: string[]; text?: string; motif?: Motif; reveal?: Reveal }
export interface BannerEl extends Base { kind: 'banner'; x: number; y: number; w: number; h: number; rot: number; text: string; colors: string[]; orient?: 'h' | 'v' }
export interface FenceEl extends Base { kind: 'fence'; side: 'N' | 'S' | 'W' | 'E'; from: number; to: number; h: number; text: string; colors: string[] }
export interface FlagsEl extends Base { kind: 'flags'; regions: Region[]; flag: Pick<FlagDesign, 'shape' | 'pattern' | 'colors' | 'text'>; size: 'swing_s' | 'swing_l' | 'double'; count: number;
  /** freie Platzierung (Meter); ohne Angabe verteilt sich die Anzahl auf die gewählten Bereiche */
  points?: Array<{ x: number; y: number }> }
export interface ConfettiEl extends Base { kind: 'confetti'; regions: Region[]; colors: string[]; density: number }
export interface StreamersEl extends Base { kind: 'streamers'; regions: Region[]; colors: string[]; density: number }
export interface SmokeEl extends Base { kind: 'smoke'; regions: Region[]; colors: string[]; density: number }
export interface WaveEl extends Base { kind: 'wave'; regions: Region[]; colors: string[]; speed: number }
export type ChoreoElement = CardsEl | BlockflagEl | BannerEl | FenceEl | FlagsEl | ConfettiEl | StreamersEl | SmokeEl | WaveEl;

export interface ChoreoScene { dur: number; label?: string }
export interface ChoreoV2 extends ChoreoDesign { v: 2; scenes: ChoreoScene[]; elements: ChoreoElement[]; template?: string }

export type AnyChoreo = ChoreoDesign | ChoreoV2;
export const isV2 = (d: AnyChoreo | null | undefined): d is ChoreoV2 => !!d && (d as ChoreoV2).v === 2 && Array.isArray((d as ChoreoV2).elements);

/** Grenzen (identisch in der Datenbank-Prüfung) */
export const LIMITS = { scenes: 4, elements: 40, regions: 24, colors: 4, text: 40, flags: 40, sceneMin: 2, sceneMax: 30, json: 24000 };

/** Komplexität nach Stadiongröße: kleine Stadien einfache Choreos, große komplexere Tribünenmuster */
export function complexityLimits(capacity: number): { elements: number; scenes: number; label: string } {
  if (capacity <= 20000) return { elements: 12, scenes: 2, label: 'Kleines Stadion: bis 12 Elemente, 2 Szenen' };
  if (capacity <= 40000) return { elements: 24, scenes: 3, label: 'Mittleres Stadion: bis 24 Elemente, 3 Szenen' };
  return { elements: 40, scenes: 4, label: 'Großes Stadion: bis 40 Elemente, 4 Szenen' };
}

let uid = 0;
export const newId = () => `e${Date.now().toString(36)}${(uid++).toString(36)}`;

export const sceneCount = (d: ChoreoV2) => Math.max(1, d.scenes.length);
export const totalDuration = (d: ChoreoV2) => d.scenes.reduce((a, s) => a + s.dur, 0);

/** Älteres einfaches Design → v2 (eine Szene, ein Kartenelement); v2 bleibt unverändert */
export function normalizeChoreo(d: AnyChoreo): ChoreoV2 {
  if (isV2(d)) return d;
  const block = d.block ?? 'home_curve';
  const regions: Region[] = block === 'all' ? [{ side: 'W' }, { side: 'S' }, { side: 'N' }]
    : block === 'home_curve' ? [{ side: 'W' }] : block === 'main_stand' ? [{ side: 'S', from: 0.22, to: 0.78 }] : [{ side: 'N' }];
  return {
    ...d, v: 2, scenes: [{ dur: 8 }],
    elements: [{ id: 'legacy', kind: 'cards', s0: 0, s1: 0, regions, pattern: d.pattern === 'stripes' ? 'stripes' : d.pattern, colors: d.colors.slice(0, 4), text: d.text, motif: d.motif ?? 'none', reveal: 'none' }],
  };
}

/** Kopf der Legacy-Felder aus dem ersten Kartenelement (ältere Clients zeigen damit eine einfache Blockchoreo) */
export function withLegacyFields(d: ChoreoV2, fallback: { primary: string; secondary: string; short: string }): ChoreoV2 {
  const c = d.elements.find((e): e is CardsEl | BlockflagEl => e.kind === 'cards' || e.kind === 'blockflag');
  const colors = (c?.colors?.length ? c.colors : [fallback.primary, fallback.secondary]).slice(0, 4);
  const pattern = (['stripes', 'blocks', 'checker', 'wave', 'gradient', 'rays', 'mosaic'] as const).find((p) => p === c?.pattern) ?? 'stripes';
  const motif = (['none', 'star', 'heart', 'crown', 'crest', 'lion', 'eagle', 'anchor', 'castle'] as const).find((m) => m === c?.motif) ?? 'none';
  return { ...d, pattern, colors, text: (c?.text ?? fallback.short).slice(0, 24), motif, block: 'home_curve' };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Prüfung eines v2-Designs (Spiegel von fd_valid_choreo in der Datenbank); liefert Fehlertexte, leer = gültig */
export function validateChoreo(d: unknown): string[] {
  const err: string[] = [];
  const o = d as Partial<ChoreoV2>;
  if (!o || typeof o !== 'object') return ['kein Objekt'];
  if (o.v !== 2) return ['keine v2-Choreografie'];
  if (!Array.isArray(o.scenes) || o.scenes.length < 1 || o.scenes.length > LIMITS.scenes) err.push('1–4 Szenen');
  else for (const s of o.scenes) if (!num(s?.dur, LIMITS.sceneMin, LIMITS.sceneMax)) err.push('Szenendauer 2–30 s');
  if (!Array.isArray(o.elements) || o.elements.length > LIMITS.elements) { err.push('höchstens 40 Elemente'); return err; }
  const n = sceneCount(o as ChoreoV2);
  const colorsOk = (c: unknown) => Array.isArray(c) && c.length >= 1 && c.length <= LIMITS.colors && c.every((x) => typeof x === 'string' && HEX.test(x));
  const regionsOk = (r: unknown) => Array.isArray(r) && r.length >= 1 && r.length <= LIMITS.regions && r.every((x: Region) => SIDES.includes(x?.side)
    && (x.from === undefined || num(x.from, 0, 1)) && (x.to === undefined || num(x.to, 0, 1)) && (x.tiers == null || (Array.isArray(x.tiers) && x.tiers.every((t) => TIERS.includes(t)))));
  const KINDS = Object.keys(KIND_LABEL);
  for (const e of o.elements) {
    if (!e || !KINDS.includes(e.kind)) { err.push('unbekanntes Element'); continue; }
    if (typeof e.id !== 'string' || e.id.length > 24) err.push('Element-ID');
    if (!Number.isInteger(e.s0) || !Number.isInteger(e.s1) || e.s0 < 0 || e.s1 < e.s0 || e.s1 >= n) err.push('Szenenbereich');
    if ('colors' in e && !colorsOk((e as { colors: unknown }).colors)) err.push(`${e.kind}: Farben`);
    if ('text' in e && e.text !== undefined && (typeof e.text !== 'string' || e.text.length > LIMITS.text)) err.push(`${e.kind}: Text`);
    if ('regions' in e && !regionsOk((e as { regions: unknown }).regions)) err.push(`${e.kind}: Bereiche`);
    if (e.kind === 'banner' && !(num(e.x, -80, 190) && num(e.y, -80, 150) && num(e.w, 2, 60) && num(e.h, 0.5, 20) && num(e.rot, -360, 360))) err.push('Spruchband: Maße');
    if (e.kind === 'fence' && !(['N', 'S', 'W', 'E'].includes(e.side) && num(e.from, 0, 1) && num(e.to, 0, 1) && num(e.h, 0.4, 3))) err.push('Zaunbanner: Maße');
    if (e.kind === 'flags') {
      if (!(Number.isInteger(e.count) && e.count >= 1 && e.count <= LIMITS.flags)) err.push('Fahnen: Anzahl');
      if (e.points && (!Array.isArray(e.points) || e.points.length > LIMITS.flags || !e.points.every((p) => num(p?.x, -80, 190) && num(p?.y, -80, 150)))) err.push('Fahnen: Positionen');
      if (!e.flag || !colorsOk(e.flag.colors)) err.push('Fahnen: Farben');
    }
    if ((e.kind === 'confetti' || e.kind === 'streamers' || e.kind === 'smoke') && !(Number.isInteger(e.density) && e.density >= 1 && e.density <= 5)) err.push(`${e.kind}: Dichte`);
    if (e.kind === 'wave' && !num(e.speed, 0.3, 3)) err.push('Welle: Tempo');
  }
  if (JSON.stringify(d).length > LIMITS.json) err.push('zu groß');
  return err;
}

// ---------------------------------------------------------------- Bearbeitungsverlauf (Rückgängig/Wiederholen)
export interface History<T> { past: T[]; present: T; future: T[] }
export const historyOf = <T,>(x: T): History<T> => ({ past: [], present: x, future: [] });
export function commit<T>(h: History<T>, next: T, max = 80): History<T> {
  if (JSON.stringify(next) === JSON.stringify(h.present)) return h;
  return { past: [...h.past, h.present].slice(-max), present: next, future: [] };
}
export const undo = <T,>(h: History<T>): History<T> => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] } : h);
export const redo = <T,>(h: History<T>): History<T> => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) } : h);

// ---------------------------------------------------------------- Vorlagen
export interface ChoreoTemplate { key: string; label: string; hint: string; build: (c: { primary: string; secondary: string; short: string; tiers: number; closed: boolean }) => ChoreoV2 }
const base = (scenes: ChoreoScene[], elements: ChoreoElement[], template: string, c: { primary: string; secondary: string; short: string }): ChoreoV2 =>
  withLegacyFields({ v: 2, template, scenes, elements, pattern: 'stripes', colors: [c.primary, c.secondary] }, c);
const el = <T extends ChoreoElement>(e: Omit<T, 'id'>): T => ({ id: newId(), ...e } as T);

export const TEMPLATES: ChoreoTemplate[] = [
  { key: 'classic', label: 'Klassische Heimkurve', hint: 'Streifen in Vereinsfarben, Wappen und Kürzel', build: (c) => base([{ dur: 8 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'W' }], pattern: 'stripes', colors: [c.primary, c.secondary], text: c.short, motif: 'crest', reveal: 'sweep' }),
    el<FlagsEl>({ kind: 'flags', s0: 0, s1: 0, persist: true, regions: [{ side: 'W', tiers: ['lower'] }], flag: { shape: 'rect', pattern: 'stripes_h', colors: [c.primary, c.secondary] }, size: 'swing_s', count: 10 }),
  ], 'classic', c) },
  { key: 'derby', label: 'Derby', hint: 'Heimkurve in Vereinsfarben, großes Spruchband, Rauch und Konfetti', build: (c) => base([{ dur: 7 }, { dur: 7 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'W' }], pattern: 'checker', colors: [c.primary, c.secondary], text: 'DERBY', motif: 'lion', reveal: 'sweep' }),
    el<BlockflagEl>({ kind: 'blockflag', s0: 1, s1: 1, regions: [{ side: 'W' }], pattern: 'diagonal', colors: [c.primary, c.secondary], text: c.short, motif: 'crest', reveal: 'down' }),
    el<FenceEl>({ kind: 'fence', s0: 0, s1: 1, persist: true, side: 'N', from: 0.15, to: 0.85, h: 1.1, text: 'UNSERE STADT · UNSER DERBY', colors: [c.primary, c.secondary] }),
    el<SmokeEl>({ kind: 'smoke', s0: 1, s1: 1, regions: [{ side: 'W', tiers: ['lower'] }], colors: [c.primary, c.secondary], density: 3 }),
    el<ConfettiEl>({ kind: 'confetti', s0: 1, s1: 1, regions: [{ side: 'W' }], colors: [c.primary, c.secondary, '#ffffff'], density: 3 }),
  ], 'derby', c) },
  { key: 'top', label: 'Spitzenspiel', hint: 'Zwei Tribünen in Farbkarten, Wellen und Schwenkfahnen', build: (c) => base([{ dur: 6 }, { dur: 8 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 1, regions: [{ side: 'W' }, { side: 'S', from: 0.2, to: 0.8 }], pattern: 'stripes', colors: [c.primary, '#ffffff', c.secondary], text: c.short, motif: 'star', reveal: 'sweep', flip: 4, colors2: [c.secondary, '#ffffff', c.primary], pattern2: 'stripes' }),
    el<WaveEl>({ kind: 'wave', s0: 1, s1: 1, regions: [{ side: 'N' }, { side: 'S' }], colors: ['#ffffff'], speed: 1 }),
    el<FlagsEl>({ kind: 'flags', s0: 1, s1: 1, persist: true, regions: [{ side: 'W' }, { side: 'S', from: 0.25, to: 0.75 }], flag: { shape: 'swallow', pattern: 'halves', colors: [c.primary, c.secondary] }, size: 'swing_l', count: 14 }),
  ], 'top', c) },
  { key: 'final', label: 'Pokalfinale', hint: 'Dreiteilige Show: Karten, Blockfahne, Schwenkfahnen, Konfetti', build: (c) => base([{ dur: 6 }, { dur: 7 }, { dur: 7 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'W' }, { side: 'N', from: 0, to: 0.4 }, { side: 'S', from: 0, to: 0.4 }], pattern: 'stripes', colors: [c.primary, c.secondary], reveal: 'sweep' }),
    el<BlockflagEl>({ kind: 'blockflag', s0: 1, s1: 1, regions: [{ side: 'W' }], pattern: 'gradient', colors: [c.primary, c.secondary], text: c.short, motif: 'crown', reveal: 'down' }),
    el<FlagsEl>({ kind: 'flags', s0: 2, s1: 2, persist: true, regions: [{ side: 'W' }, { side: 'N', from: 0, to: 0.4 }, { side: 'S', from: 0, to: 0.4 }], flag: { shape: 'rect', pattern: 'cross', colors: [c.primary, c.secondary] }, size: 'double', count: 16 }),
    el<ConfettiEl>({ kind: 'confetti', s0: 2, s1: 2, regions: [{ side: 'W' }, { side: 'N' }, { side: 'S' }], colors: [c.primary, c.secondary, '#f2c14e'], density: 4 }),
    el<StreamersEl>({ kind: 'streamers', s0: 2, s1: 2, regions: [{ side: 'W' }], colors: [c.primary, c.secondary], density: 3 }),
  ], 'final', c) },
  { key: 'europe', label: 'Internationales Spiel', hint: 'Große Blockfahne und Schriftzug über mehrere Blöcke', build: (c) => base([{ dur: 8 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 0, regions: [{ side: 'S', from: 0.2, to: 0.8 }, { side: 'W' }], pattern: 'blocks', colors: [c.primary, c.secondary], text: c.short, motif: 'star', reveal: 'sweep' }),
    el<BannerEl>({ kind: 'banner', s0: 0, s1: 0, persist: true, x: 40, y: 74, w: 24, h: 2.2, rot: 0, text: 'EUROPA RUFT', colors: [c.secondary, c.primary] }),
  ], 'europe', c) },
  { key: 'title', label: 'Meisterschaftsentscheidung', hint: 'Ganzes Stadion: Karten, Welle, Konfetti, Rauch', build: (c) => base([{ dur: 6 }, { dur: 8 }], [
    el<CardsEl>({ kind: 'cards', s0: 0, s1: 1, regions: [{ side: 'N' }, { side: 'S' }, { side: 'W' }, { side: 'E' }, { side: 'NW' }, { side: 'NE' }, { side: 'SW' }, { side: 'SE' }], pattern: 'stripes_v', colors: [c.primary, c.secondary], reveal: 'sweep' }),
    el<WaveEl>({ kind: 'wave', s0: 1, s1: 1, regions: [{ side: 'N' }, { side: 'S' }, { side: 'W' }, { side: 'E' }], colors: ['#ffffff'], speed: 1.4 }),
    el<ConfettiEl>({ kind: 'confetti', s0: 1, s1: 1, regions: [{ side: 'N' }, { side: 'S' }, { side: 'W' }], colors: [c.primary, c.secondary, '#f2c14e', '#ffffff'], density: 5 }),
    el<SmokeEl>({ kind: 'smoke', s0: 1, s1: 1, regions: [{ side: 'W', tiers: ['lower'] }], colors: [c.primary], density: 4 }),
  ], 'title', c) },
  { key: 'banners', label: 'Banner & Fahnen (leicht)', hint: 'Nur Zaunbanner und Schwenkfahnen – dezent, für jedes Heimspiel', build: (c) => base([{ dur: 6 }], [
    el<FenceEl>({ kind: 'fence', s0: 0, s1: 0, persist: true, side: 'S', from: 0.2, to: 0.8, h: 1, text: c.short, colors: [c.primary, c.secondary] }),
    el<FlagsEl>({ kind: 'flags', s0: 0, s1: 0, persist: true, regions: [{ side: 'W', tiers: ['lower'] }], flag: { shape: 'rect', pattern: 'stripes_h', colors: [c.primary, c.secondary] }, size: 'swing_s', count: 8 }),
  ], 'banners', c) },
];
