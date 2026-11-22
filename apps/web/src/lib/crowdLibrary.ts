/**
 * Bibliothek echter Stadionaufnahmen für die KI-Fans (statische Dateien unter /audio/crowd/, kein Supabase-Verkehr).
 *
 * Die Dateien werden mit `node scripts/crowd-audio.mjs` aus Rohaufnahmen erzeugt (Lautheit normalisiert,
 * Stille entfernt, Ein-/Ausblendung, MP3) und in manifest.json eingetragen – inklusive Lizenz und Urheber.
 * Fehlt eine Kategorie, wird sie NICHT synthetisch ersetzt, sondern als fehlend gemeldet (crowdStatus).
 * Bewusst KEINE Fangesänge in der Bibliothek: Gesänge kommen ausschließlich aus den MP3-Uploads der Vereine.
 */
export type CrowdCategory =
  | 'ambience' | 'clap' | 'attack' | 'chance' | 'whistle' | 'concede' | 'goal' | 'aah' | 'ooh' | 'uuh';

export interface CrowdFile {
  id: string;
  category: CrowdCategory;
  /** relativ zum Manifest */
  file: string;
  duration: number;
  /** Lautheitsfaktor (aus der Aufbereitung, Standard 1) */
  gain?: number;
  credit?: string;
  license?: string;
  source?: string;
}

export interface CrowdLibrary {
  base: string;
  files: CrowdFile[];
  byCategory: Map<CrowdCategory, CrowdFile[]>;
}

/** Kategorien, Bedeutung, empfohlene Länge und Mindestanzahl (für Abwechslung) */
export const CROWD_CATEGORIES: Array<{ key: CrowdCategory; label: string; min: number; seconds: [number, number]; hint: string }> = [
  { key: 'ambience', label: 'Allgemeines Stadionrauschen', min: 3, seconds: [30, 240], hint: 'volles Stadion, Gemurmel, vereinzelte Rufe, keine Durchsagen/Musik' },
  { key: 'clap', label: 'Rhythmisches Klatschen', min: 3, seconds: [6, 30], hint: 'gemeinsames Klatschen der Kurve, gern mit Rufen' },
  { key: 'attack', label: 'Anfeuerung bei Angriffen', min: 3, seconds: [2, 8], hint: 'anschwellendes Rufen/Antreiben' },
  { key: 'chance', label: 'Aufschrei bei Großchancen', min: 3, seconds: [2, 5], hint: '„Ooooh“, Aufschrei nach knapp vorbei/Parade' },
  { key: 'whistle', label: 'Pfiffe gegen den Gegner', min: 3, seconds: [2, 8], hint: 'gellendes Pfeifkonzert, Buhrufe' },
  { key: 'concede', label: 'Enttäuschung (Gegentor, vergebene Chance)', min: 2, seconds: [2, 6], hint: 'Stöhnen, kurzes Raunen, dann Stille' },
  { key: 'goal', label: 'Torjubel', min: 3, seconds: [4, 10], hint: 'explosiver Jubel direkt ab dem Tor' },
  { key: 'aah', label: 'Kollektives „Ah“', min: 2, seconds: [0.6, 2], hint: 'kurzes gespanntes Ah (Angriff, Flanke)' },
  { key: 'ooh', label: 'Kollektives „Oh“', min: 2, seconds: [0.6, 2], hint: 'Oh nach knapp vorbei / Parade' },
  { key: 'uuh', label: 'Tiefes „Uh“ / Raunen', min: 2, seconds: [0.6, 2], hint: 'tiefes Raunen, Erschrecken' },
];

/** Crowd-Reaktionen der Matrix V2 → Kategorien (bei fehlender Datei nächstverwandte echte Aufnahme) */
export const REACTION_SOURCES: Record<'clap' | 'whistle' | 'aah' | 'ooh' | 'uuh', CrowdCategory[]> = {
  clap: ['clap'], whistle: ['whistle'], aah: ['aah', 'attack'], ooh: ['ooh', 'chance'], uuh: ['uuh', 'concede'],
};

const cache = new Map<string, Promise<CrowdLibrary>>();

export function emptyLibrary(base = '/audio/crowd/'): CrowdLibrary {
  return { base, files: [], byCategory: new Map() };
}

export function buildLibrary(base: string, files: CrowdFile[]): CrowdLibrary {
  const byCategory = new Map<CrowdCategory, CrowdFile[]>();
  for (const f of files) {
    if (!CROWD_CATEGORIES.some((c) => c.key === f.category) || !(f.duration > 0)) continue;
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  return { base, files: [...byCategory.values()].flat(), byCategory };
}

/** Manifest einmal je Seite laden (statische Datei, vom CDN zwischengespeichert) */
export function loadCrowdLibrary(manifestUrl = '/audio/crowd/manifest.json'): Promise<CrowdLibrary> {
  let p = cache.get(manifestUrl);
  if (!p) {
    const base = manifestUrl.replace(/[^/]*$/, '');
    p = fetch(manifestUrl, { cache: 'force-cache' })
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((m: { files?: CrowdFile[] }) => buildLibrary(base, Array.isArray(m.files) ? m.files : []))
      .catch(() => emptyLibrary(base));
    cache.set(manifestUrl, p);
  }
  return p;
}

export function urlOf(lib: CrowdLibrary, f: CrowdFile): string {
  return /^https?:|^\//.test(f.file) ? f.file : lib.base + f.file;
}

/** Vollständigkeit: welche Kategorien fehlen / zu wenig Abwechslung haben */
export function crowdStatus(lib: CrowdLibrary) {
  return CROWD_CATEGORIES.map((c) => {
    const n = lib.byCategory.get(c.key)?.length ?? 0;
    return { ...c, count: n, missing: n === 0, thin: n > 0 && n < c.min };
  });
}

/**
 * Zufallsauswahl ohne direkte Wiederholung: die zuletzt gespielten Dateien (bis zu Anzahl − 1, höchstens 3)
 * sind gesperrt. `avoid`: Dateien, die gerade auf der anderen Spur laufen.
 */
export class Picker {
  private recent = new Map<string, string[]>();
  constructor(private rnd: () => number = Math.random) {}

  pick(lib: CrowdLibrary, cats: CrowdCategory[] | Array<[CrowdCategory, number]>, key: string, avoid: string[] = []): CrowdFile | null {
    const weighted = (cats as Array<CrowdCategory | [CrowdCategory, number]>).map((c) => (Array.isArray(c) ? c : [c, 1] as [CrowdCategory, number]));
    const pool: Array<[CrowdFile, number]> = [];
    for (const [c, w] of weighted) {
      const list = lib.byCategory.get(c) ?? [];
      for (const f of list) pool.push([f, w / list.length]);
    }
    if (!pool.length) return null;
    const recent = this.recent.get(key) ?? [];
    const block = Math.min(3, pool.length - 1);
    const blocked = recent.slice(-block);
    let cand = pool.filter(([f]) => !blocked.includes(f.id) && !avoid.includes(f.id));
    // Vorrang: nicht gleichzeitig auf der anderen Spur, dann nicht direkt wiederholen
    if (!cand.length) cand = pool.filter(([f]) => !avoid.includes(f.id) && f.id !== recent[recent.length - 1]);
    if (!cand.length) cand = pool.filter(([f]) => !avoid.includes(f.id));
    if (!cand.length) cand = pool.filter(([f]) => !blocked.includes(f.id));
    if (!cand.length) cand = pool;
    const total = cand.reduce((a, [, w]) => a + w, 0);
    let x = this.rnd() * total;
    let chosen = cand[cand.length - 1]![0];
    for (const [f, w] of cand) { x -= w; if (x <= 0) { chosen = f; break; } }
    this.recent.set(key, [...recent, chosen.id].slice(-6));
    return chosen;
  }
}
