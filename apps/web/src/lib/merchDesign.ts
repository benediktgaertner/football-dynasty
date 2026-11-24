/** Fanartikel-Designs (Migration 0050): Muster, Farben, Vereinslogo und Aufdruck. Rein kosmetisch – ohne Wirkung auf Nachfrage, Preis oder Erlös. */
export type MerchFamily = 'jersey' | 'scarf' | 'cap' | 'flag';
export interface MerchDesign { pattern: string; c1: string; c2: string; c3: string; crest: boolean; text: string }

export const MERCH_PATTERNS: Record<MerchFamily, Array<{ key: string; label: string }>> = {
  jersey: [
    { key: 'solid', label: 'Einfarbig' }, { key: 'stripes', label: 'Längsstreifen' }, { key: 'hoops', label: 'Ringel' }, { key: 'halves', label: 'Halbiert' },
    { key: 'quarters', label: 'Geviertelt' }, { key: 'sash', label: 'Schärpe' }, { key: 'chevron', label: 'Winkel' }, { key: 'pinstripe', label: 'Nadelstreifen' }, { key: 'diagonal', label: 'Diagonal' },
  ],
  scarf: [{ key: 'stripes', label: 'Streifen' }, { key: 'bands', label: 'Bänder' }, { key: 'solid', label: 'Einfarbig' }, { key: 'checker', label: 'Karo' }, { key: 'bar', label: 'Mittelbalken' }],
  cap: [{ key: 'solid', label: 'Einfarbig' }, { key: 'panels', label: 'Segmente' }, { key: 'stripe', label: 'Streifen' }, { key: 'twotone', label: 'Zweifarbig' }, { key: 'bill', label: 'Kontrastschirm' }],
  flag: [{ key: 'horizontal', label: 'Waagerecht' }, { key: 'vertical', label: 'Senkrecht' }, { key: 'diagonal', label: 'Diagonal' }, { key: 'cross', label: 'Kreuz' }, { key: 'border', label: 'Rahmen' }, { key: 'solid', label: 'Einfarbig' }],
};

export const PRODUCT_FAMILY: Record<string, MerchFamily> = { home_jersey: 'jersey', away_jersey: 'jersey', special_jersey: 'jersey', scarf: 'scarf', cap: 'cap', flag: 'flag' };

/** Farbvorschläge zusätzlich zu den Vereinsfarben */
export const MERCH_PALETTE = ['#ffffff', '#111111', '#c8102e', '#003b95', '#0a8f3c', '#f2c14e', '#f28c28', '#6a1b9a', '#00a3e0', '#7d8590'];

const HEX = /^#[0-9a-fA-F]{6}$/;
export function isHex(v: unknown): v is string { return typeof v === 'string' && HEX.test(v); }

export interface ClubColors { primary: string; secondary: string; accent: string; kitPattern?: string }

/** Standarddesign aus den Vereinsfarben (Heim: Vereinstrikot, Auswärts: getauscht, Sondertrikot: dunkel mit Akzent) */
export function defaultDesign(product: string, club: ClubColors): MerchDesign {
  const fam = PRODUCT_FAMILY[product] ?? 'jersey';
  const base = { crest: true, text: '' };
  switch (product) {
    case 'home_jersey': return { ...base, pattern: ['stripes', 'hoops', 'halves', 'sash', 'solid'].includes(club.kitPattern ?? '') ? club.kitPattern! : 'stripes', c1: club.primary, c2: club.secondary, c3: club.accent };
    case 'away_jersey': return { ...base, pattern: 'solid', c1: club.secondary, c2: club.primary, c3: club.accent };
    case 'special_jersey': return { ...base, pattern: 'pinstripe', c1: '#111111', c2: club.accent, c3: club.primary };
    default:
      return { ...base, pattern: MERCH_PATTERNS[fam][0]!.key, c1: club.primary, c2: club.secondary, c3: club.accent, crest: fam !== 'scarf' };
  }
}

/** Gespeichertes Design mit Standard auffüllen; ungültige Felder fallen auf den Standard zurück */
export function effectiveDesign(product: string, stored: Partial<MerchDesign> | null | undefined, club: ClubColors): MerchDesign {
  const d = defaultDesign(product, club);
  const fam = PRODUCT_FAMILY[product] ?? 'jersey';
  const s = stored ?? {};
  return {
    pattern: MERCH_PATTERNS[fam].some((p) => p.key === s.pattern) ? s.pattern! : d.pattern,
    c1: isHex(s.c1) ? s.c1 : d.c1, c2: isHex(s.c2) ? s.c2 : d.c2, c3: isHex(s.c3) ? s.c3 : d.c3,
    crest: typeof s.crest === 'boolean' ? s.crest : d.crest,
    text: typeof s.text === 'string' && /^[A-Za-zÄÖÜäöüß0-9 .!&-]{0,16}$/.test(s.text) ? s.text : d.text,
  };
}

/** Prüfung wie in der Datenbank (fd_valid_merch_design) */
export function validMerchDesign(family: MerchFamily, d: Partial<MerchDesign>): boolean {
  if (!d || typeof d !== 'object') return false;
  const keys = Object.keys(d);
  if (keys.some((k) => !['pattern', 'c1', 'c2', 'c3', 'crest', 'text'].includes(k))) return false;
  if (d.pattern !== undefined && !MERCH_PATTERNS[family].some((p) => p.key === d.pattern)) return false;
  for (const c of [d.c1, d.c2, d.c3]) if (c !== undefined && !isHex(c)) return false;
  if (d.crest !== undefined && typeof d.crest !== 'boolean') return false;
  if (d.text !== undefined && !(typeof d.text === 'string' && /^[A-Za-zÄÖÜäöüß0-9 .!&-]{0,16}$/.test(d.text))) return false;
  return true;
}
