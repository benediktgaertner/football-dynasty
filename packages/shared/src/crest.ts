import { z } from 'zod';
import { HEX_COLOR_RE, contrastRatio, readableTextColor } from './color.js';

/**
 * B3: SVG-Wappen.
 * Ein Wappen wird ausschließlich als strukturierte Konfiguration gespeichert,
 * niemals als frei übermitteltes SVG. Gerendert wird immer aus dieser Konfiguration.
 * Dadurch kann kein Benutzer Skripte oder fremde Inhalte einschleusen.
 */
export const CREST_SHAPES = ['shield', 'classic', 'round', 'diamond', 'hexagon', 'banner'] as const;
export const CREST_PATTERNS = ['solid', 'halves', 'stripes', 'hoops', 'sash', 'quarters', 'chevron'] as const;
export const CREST_SYMBOLS = ['none', 'ball', 'lion', 'eagle', 'crown', 'star', 'lightning'] as const;

export const crestConfigSchema = z.object({
  shape: z.enum(CREST_SHAPES),
  pattern: z.enum(CREST_PATTERNS),
  symbol: z.enum(CREST_SYMBOLS),
  primary: z.string().regex(HEX_COLOR_RE),
  secondary: z.string().regex(HEX_COLOR_RE),
  accent: z.string().regex(HEX_COLOR_RE),
  borderWidth: z.number().int().min(0).max(6),
  initials: z
    .string()
    .regex(/^[A-ZÄÖÜ0-9.&]{1,4}$/u, 'Initialen: 1–4 Großbuchstaben oder Ziffern'),
  foundedYear: z.number().int().min(1850).max(2100).nullable(),
});
export type CrestConfig = z.infer<typeof crestConfigSchema>;

const SHAPE_PATHS: Record<CrestConfig['shape'], string> = {
  shield: 'M50 4 L94 16 L94 58 C94 88 72 106 50 116 C28 106 6 88 6 58 L6 16 Z',
  classic: 'M8 8 H92 V60 C92 92 70 108 50 116 C30 108 8 92 8 60 Z',
  round: 'M50 14 A46 46 0 1 1 49.99 14 Z',
  diamond: 'M50 4 L96 60 L50 116 L4 60 Z',
  hexagon: 'M50 4 L94 30 L94 90 L50 116 L6 90 L6 30 Z',
  banner: 'M10 6 H90 V112 L50 94 L10 112 Z',
};

function patternMarkup(pattern: CrestConfig['pattern'], secondary: string): string {
  switch (pattern) {
    case 'solid':
      return '';
    case 'halves':
      return `<rect x="50" y="0" width="50" height="120" fill="${secondary}"/>`;
    case 'stripes':
      return [10, 30, 50, 70, 90].map((x) => `<rect x="${x}" y="0" width="10" height="120" fill="${secondary}"/>`).join('');
    case 'hoops':
      return [20, 50, 80].map((y) => `<rect x="0" y="${y}" width="100" height="14" fill="${secondary}"/>`).join('');
    case 'sash':
      return `<polygon points="0,20 20,0 100,100 80,120" fill="${secondary}"/>`;
    case 'quarters':
      return `<rect x="50" y="0" width="50" height="60" fill="${secondary}"/><rect x="0" y="60" width="50" height="60" fill="${secondary}"/>`;
    case 'chevron':
      return `<polygon points="0,40 50,70 100,40 100,62 50,92 0,62" fill="${secondary}"/>`;
  }
}

/** Eigene, stark vereinfachte geometrische Symbole (keine Nachbildung realer Wappen). */
function symbolMarkup(symbol: CrestConfig['symbol'], color: string, outline: string): string {
  const stroke = `stroke="${outline}" stroke-width="1.5" stroke-linejoin="round"`;
  switch (symbol) {
    case 'none':
      return '';
    case 'ball':
      return `<g ${stroke}><circle cx="50" cy="54" r="17" fill="#FFFFFF"/><polygon points="50,46 57,51 54.5,59.5 45.5,59.5 43,51" fill="${outline}"/>` +
        `<path d="M50 46 V37 M57 51 L66 48 M54.5 59.5 L60 67 M45.5 59.5 L40 67 M43 51 L34 48" fill="none"/></g>`;
    case 'star':
      return `<polygon ${stroke} fill="${color}" points="50,33 55.9,47.9 72,48.6 59.5,58.6 63.8,74 50,65.2 36.2,74 40.5,58.6 28,48.6 44.1,47.9"/>`;
    case 'crown':
      return `<path ${stroke} fill="${color}" d="M30 68 L28 42 L39 54 L50 36 L61 54 L72 42 L70 68 Z"/><rect ${stroke} x="30" y="68" width="40" height="6" fill="${color}"/>`;
    case 'lightning':
      return `<polygon ${stroke} fill="${color}" points="56,30 36,58 48,58 42,80 64,50 52,50"/>`;
    case 'lion': {
      // Mähne als Zackenkranz, Gesicht als Kreis
      const spikes: string[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const r = i % 2 === 0 ? 22 : 16;
        spikes.push(`${(50 + r * Math.cos(a)).toFixed(1)},${(55 + r * Math.sin(a)).toFixed(1)}`);
      }
      return `<polygon ${stroke} fill="${color}" points="${spikes.join(' ')}"/>` +
        `<circle ${stroke} cx="50" cy="55" r="11" fill="#F4EBD0"/>` +
        `<circle cx="46" cy="53" r="1.6" fill="${outline}"/><circle cx="54" cy="53" r="1.6" fill="${outline}"/>` +
        `<path d="M47 59 Q50 62 53 59" fill="none" stroke="${outline}" stroke-width="1.4"/>`;
    }
    case 'eagle':
      return `<path ${stroke} fill="${color}" d="M50 40 L54 46 L74 38 L68 50 L78 50 L64 58 L58 58 L56 72 L50 78 L44 72 L42 58 L36 58 L22 50 L32 50 L26 38 L46 46 Z"/>` +
        `<circle cx="50" cy="44" r="1.5" fill="${outline}"/>`;
  }
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string);
}

/**
 * Rendert ein Wappen als eigenständiges SVG.
 * `idSuffix` macht clipPath-IDs eindeutig, wenn mehrere Wappen auf einer Seite stehen.
 */
export function renderCrestSvg(input: CrestConfig, idSuffix = 'c'): string {
  const cfg = crestConfigSchema.parse(input);
  const clipId = `crest-clip-${idSuffix.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const path = SHAPE_PATHS[cfg.shape];
  const initials = escapeXml(cfg.initials);
  const fontSize = cfg.initials.length <= 2 ? 18 : cfg.initials.length === 3 ? 15 : 12;
  const hasSymbol = cfg.symbol !== 'none';
  const initialsY = hasSymbol ? 96 : 68;
  // Initialen und Jahr liegen auf einem dunklen Band, damit sie auf jedem Muster lesbar bleiben.
  const BAND = '#1B1B1B';
  const textColor = readableTextColor(cfg.accent) === '#FFFFFF' && contrastRatio(cfg.accent, BAND) < 3 ? '#F4EBD0' : cfg.accent;
  const bandWidth = 22 + cfg.initials.length * (fontSize * 0.72);
  const initialsBand = `<rect x="${(50 - bandWidth / 2).toFixed(1)}" y="${initialsY - fontSize + 1}" width="${bandWidth.toFixed(1)}" height="${fontSize + 6}" rx="3" fill="${BAND}" fill-opacity="0.82" stroke="${cfg.accent}" stroke-width="0.8"/>`;
  const yearY = hasSymbol ? 30 : 92;
  const year = cfg.foundedYear !== null
    ? `<rect x="36" y="${yearY - 7.5}" width="28" height="10" rx="2" fill="${BAND}" fill-opacity="0.75"/>` +
      `<text x="50" y="${yearY}" text-anchor="middle" font-family="Georgia, serif" font-size="7.5" font-weight="700" fill="${textColor}">${cfg.foundedYear}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" role="img" aria-label="Wappen ${initials}">`,
    `<defs><clipPath id="${clipId}"><path d="${path}"/></clipPath></defs>`,
    `<g clip-path="url(#${clipId})"><rect x="0" y="0" width="100" height="120" fill="${cfg.primary}"/>${patternMarkup(cfg.pattern, cfg.secondary)}</g>`,
    symbolMarkup(cfg.symbol, cfg.accent, '#1B1B1B'),
    initialsBand,
    `<text x="50" y="${initialsY}" text-anchor="middle" font-family="'Arial Black', Arial, sans-serif" font-size="${fontSize}" font-weight="900" fill="${textColor}">${initials}</text>`,
    year,
    cfg.borderWidth > 0 ? `<path d="${path}" fill="none" stroke="${cfg.accent}" stroke-width="${cfg.borderWidth}"/>` : '',
    `<path d="${path}" fill="none" stroke="#1B1B1B" stroke-width="1"/>`,
    `</svg>`,
  ].join('');
}

/** B3: Zufallsgenerator für Wappen. `rand` liefert Werte in [0,1). */
export function randomCrest(rand: () => number, initials: string): CrestConfig {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const palette = ['#1F5FA8', '#C0392B', '#1E7A46', '#F2A93B', '#1B1B1B', '#F4EBD0', '#7A2E8F', '#0E6E6E', '#E2582B', '#2B2D42', '#FFFFFF', '#8C1C13'];
  const primary = pick(palette);
  let secondary = pick(palette);
  while (secondary === primary) secondary = pick(palette);
  let accent = pick(['#F2C14E', '#FFFFFF', '#F4EBD0', '#1B1B1B', '#E2582B']);
  if (accent === primary) accent = '#F2C14E';
  return {
    shape: pick(CREST_SHAPES),
    pattern: pick(CREST_PATTERNS),
    symbol: pick(CREST_SYMBOLS.filter((s) => s !== 'none')),
    primary,
    secondary,
    accent,
    borderWidth: pick([0, 2, 3, 4]),
    initials: initials.toUpperCase().replace(/[^A-ZÄÖÜ0-9.&]/gu, '').slice(0, 4) || 'FC',
    foundedYear: rand() < 0.6 ? 1880 + Math.floor(rand() * 140) : null,
  };
}
