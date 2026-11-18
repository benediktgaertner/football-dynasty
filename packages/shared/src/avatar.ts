import { HEX_COLOR_RE } from './color.js';
import type { Region } from './domain.js';
import { createRng, type Rng } from './rng.js';

/**
 * Spielerporträts als SVG.
 * Fiktive Spieler bekommen ein gezeichnetes, eigenes Gesicht – keine Fotos realer Personen.
 * Das Porträt wird deterministisch aus der Spieler-ID erzeugt: Derselbe Spieler sieht auf
 * jedem Gerät und in jeder Saison gleich aus; nur das Alter (graue Haare, Geheimratsecken)
 * und die Trikotfarbe des aktuellen Vereins verändern es.
 */

export interface AvatarOptions {
  /** Stabile Grundlage, in der Regel die Spieler-ID */
  seed: string;
  region: Region;
  age: number;
  /** Trikotfarben (Hex). Ohne Verein: neutrales Trainingsshirt. */
  shirt?: string;
  collar?: string;
  /** Hintergrund des runden Rahmens */
  background?: string;
}

const SKIN = ['#F6D7C3', '#EFC3A4', '#E3B08E', '#CC9470', '#AD7550', '#8D5A3B', '#6E4329', '#4F2E1C'] as const;

/** Verteilung der Hauttöne (Indizes in SKIN) je Herkunftsregion – bewusst breit gestreut. */
const SKIN_WEIGHTS: Record<Region, readonly number[]> = {
  europe: [3, 4, 3, 2, 1, 0.8, 0.6, 0.5],
  south_america: [1, 2, 3, 3, 2.5, 1.5, 1, 0.6],
  africa: [0, 0.2, 0.5, 1, 2, 3, 3.5, 3],
  asia: [2, 3, 3, 2, 1, 0.5, 0.2, 0.1],
  north_central_america: [1.5, 2, 2.5, 2.5, 2, 1.5, 1.2, 1],
  oceania: [3, 3, 2, 1.5, 1, 1, 0.8, 0.5],
};

const HAIR_COLORS = {
  black: '#1C1712',
  darkBrown: '#3B2719',
  brown: '#5E3B22',
  lightBrown: '#8A5E36',
  blond: '#C9A15A',
  red: '#9C4A23',
} as const;
type HairColor = keyof typeof HAIR_COLORS;

const HAIR_WEIGHTS: Record<Region, Partial<Record<HairColor, number>>> = {
  europe: { black: 1.5, darkBrown: 3, brown: 3, lightBrown: 1.5, blond: 1.5, red: 0.3 },
  south_america: { black: 4, darkBrown: 3, brown: 1.5, lightBrown: 0.4, blond: 0.2 },
  africa: { black: 6, darkBrown: 1 },
  asia: { black: 6, darkBrown: 1.5 },
  north_central_america: { black: 3, darkBrown: 2.5, brown: 2, lightBrown: 0.8, blond: 0.6, red: 0.1 },
  oceania: { black: 1, darkBrown: 2, brown: 2.5, lightBrown: 1.5, blond: 2, red: 0.3 },
};

const STYLES = ['buzz', 'short', 'sidepart', 'quiff', 'curly', 'coils', 'long', 'bun', 'bald'] as const;
type Style = (typeof STYLES)[number];

function weighted<T>(rng: Rng, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.next() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1]![0];
}

function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * factor)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const safeColor = (c: string | undefined, fallback: string) => (c && HEX_COLOR_RE.test(c) ? c : fallback);

function hairMarkup(style: Style, color: string, receding: boolean): string {
  const top = receding ? 27 : 24;
  switch (style) {
    case 'bald':
      return '';
    case 'buzz':
      return `<path d="M27 ${top + 14} Q27 ${top - 2} 50 ${top - 3} Q73 ${top - 2} 73 ${top + 14} Q66 ${top + 5} 50 ${top + 5} Q34 ${top + 5} 27 ${top + 14} Z" fill="${color}" opacity="0.75"/>`;
    case 'short':
      return `<path d="M26 ${top + 16} Q24 ${top - 4} 50 ${top - 6} Q76 ${top - 4} 74 ${top + 16} Q70 ${top + 4} 58 ${top + 4} Q50 ${top + 1} 40 ${top + 4} Q30 ${top + 5} 26 ${top + 16} Z" fill="${color}"/>`;
    case 'sidepart':
      return `<path d="M26 ${top + 18} Q22 ${top - 6} 48 ${top - 7} Q78 ${top - 6} 75 ${top + 17} Q72 ${top + 3} 62 ${top + 2} L40 ${top + 3} Q30 ${top + 6} 26 ${top + 18} Z" fill="${color}"/><path d="M40 ${top - 5} Q42 ${top} 41 ${top + 3}" stroke="${shade(color, 0.6)}" stroke-width="1" fill="none"/>`;
    case 'quiff':
      return `<path d="M26 ${top + 16} Q24 ${top - 2} 36 ${top - 8} Q50 ${top - 16} 66 ${top - 9} Q77 ${top - 3} 74 ${top + 16} Q70 ${top + 3} 56 ${top + 2} Q40 ${top + 2} 26 ${top + 16} Z" fill="${color}"/>`;
    case 'curly': {
      const c: string[] = [];
      for (let i = 0; i < 9; i++) {
        const x = 28 + i * 5.5;
        const y = top + 2 - Math.sin((i / 8) * Math.PI) * 7;
        c.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${color}"/>`);
      }
      return c.join('') + `<rect x="26" y="${top}" width="48" height="8" rx="4" fill="${color}"/>`;
    }
    case 'coils':
      return `<path d="M24 ${top + 16} Q20 ${top - 10} 50 ${top - 12} Q80 ${top - 10} 76 ${top + 16} Q72 ${top + 4} 50 ${top + 3} Q28 ${top + 4} 24 ${top + 16} Z" fill="${color}"/>` +
        `<path d="M30 ${top - 2} q4 -3 8 0 q4 -3 8 0 q4 -3 8 0 q4 -3 8 0 q4 -3 8 0" stroke="${shade(color, 1.6)}" stroke-width="0.8" fill="none" opacity="0.5"/>`;
    case 'long':
      return `<path d="M24 ${top + 30} Q18 ${top - 6} 50 ${top - 7} Q82 ${top - 6} 76 ${top + 30} L74 ${top + 34} Q74 ${top + 6} 60 ${top + 3} Q50 ${top + 1} 40 ${top + 3} Q26 ${top + 6} 26 ${top + 34} Z" fill="${color}"/>`;
    case 'bun':
      return `<circle cx="50" cy="${top - 9}" r="7" fill="${color}"/><path d="M26 ${top + 15} Q24 ${top - 5} 50 ${top - 6} Q76 ${top - 5} 74 ${top + 15} Q70 ${top + 3} 50 ${top + 2} Q30 ${top + 3} 26 ${top + 15} Z" fill="${color}"/>`;
  }
}

export function renderPlayerAvatarSvg(opts: AvatarOptions): string {
  const rng = createRng(`avatar:${opts.seed}`);
  const skin = SKIN[weighted(rng, SKIN.map((_, i) => [i, SKIN_WEIGHTS[opts.region][i] ?? 1] as const))]!;
  const skinShadow = shade(skin, 0.86);
  const skinDark = shade(skin, 0.7);

  let hairColorKey = weighted(rng, Object.entries(HAIR_WEIGHTS[opts.region]) as Array<[HairColor, number]>);
  let hair: string = HAIR_COLORS[hairColorKey];
  const greyChance = opts.age >= 33 ? 0.45 : opts.age >= 30 ? 0.18 : 0;
  const grey = rng.next() < greyChance;
  if (grey) hair = rng.next() < 0.5 ? '#8E8A84' : '#6F6A64';

  const styleWeights: Array<readonly [Style, number]> =
    opts.region === 'africa'
      ? [['buzz', 4], ['coils', 3], ['short', 1.5], ['bald', 1], ['curly', 1]]
      : [['buzz', 2], ['short', 3], ['sidepart', 2], ['quiff', 2], ['curly', 1], ['long', 0.8], ['bun', 0.5], ['bald', 0.4], ['coils', 0.3]];
  const style = weighted(rng, styleWeights);
  const receding = opts.age >= 31 && rng.next() < 0.4;

  const beard = weighted(rng, [['none', 5], ['stubble', 3], ['full', 1.5], ['moustache', 0.6]] as const);
  const faceRx = 21 + rng.next() * 3;
  const faceRy = 26 + rng.next() * 3;
  const eyeY = 47 + rng.next() * 2;
  const eyeGap = 8 + rng.next() * 1.5;
  const browTilt = (rng.next() - 0.5) * 2.5;
  const smile = rng.next() < 0.55;

  const shirt = safeColor(opts.shirt, '#4A523D');
  const collar = safeColor(opts.collar, '#2D3224');
  const bg = safeColor(opts.background, '#2D3224');

  const beardMarkup =
    beard === 'stubble'
      ? `<path d="M${50 - faceRx + 3} 56 Q${50 - faceRx + 4} 76 50 ${50 + faceRy - 2} Q${50 + faceRx - 4} 76 ${50 + faceRx - 3} 56 Q50 70 ${50 - faceRx + 3} 56 Z" fill="${hair}" opacity="0.28"/>`
      : beard === 'full'
        ? `<path d="M${50 - faceRx + 2} 54 Q${50 - faceRx + 3} 78 50 ${50 + faceRy + 2} Q${50 + faceRx - 3} 78 ${50 + faceRx - 2} 54 Q${50 + faceRx - 6} 66 58 66 Q50 63 42 66 Q${50 - faceRx + 6} 66 ${50 - faceRx + 2} 54 Z" fill="${hair}" opacity="0.92"/>`
        : beard === 'moustache'
          ? `<path d="M42 63 Q50 59 58 63 Q50 62 42 63 Z" fill="${hair}" stroke="${hair}" stroke-width="2" stroke-linejoin="round"/>`
          : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 10 76 76" role="img" aria-hidden="true">`,
    `<circle cx="50" cy="48" r="38" fill="${bg}"/>`,
    `<clipPath id="av-${opts.seed.replace(/[^a-zA-Z0-9]/g, '')}"><circle cx="50" cy="48" r="38"/></clipPath>`,
    `<g clip-path="url(#av-${opts.seed.replace(/[^a-zA-Z0-9]/g, '')})">`,
    // Schultern und Trikot
    `<path d="M8 104 Q10 82 32 78 L68 78 Q90 82 92 104 Z" fill="${shirt}"/>`,
    `<path d="M38 78 L50 90 L62 78 Z" fill="${collar}"/>`,
    // Hals
    `<rect x="42" y="66" width="16" height="16" rx="5" fill="${skinShadow}"/>`,
    style === 'long' ? hairMarkup('long', hair, receding).replace('<path', '<path opacity="0.95"') : '',
    // Ohren
    `<ellipse cx="${50 - faceRx}" cy="51" rx="3.5" ry="5.5" fill="${skinShadow}"/>`,
    `<ellipse cx="${50 + faceRx}" cy="51" rx="3.5" ry="5.5" fill="${skinShadow}"/>`,
    // Gesicht
    `<ellipse cx="50" cy="48" rx="${faceRx.toFixed(1)}" ry="${faceRy.toFixed(1)}" fill="${skin}"/>`,
    beardMarkup,
    style !== 'long' ? hairMarkup(style, hair, receding) : `<path d="M28 ${receding ? 40 : 38} Q30 22 50 21 Q70 22 72 ${receding ? 40 : 38} Q66 28 50 28 Q34 28 28 ${receding ? 40 : 38} Z" fill="${hair}"/>`,
    // Augenbrauen
    `<path d="M${50 - eyeGap - 5} ${eyeY - 5 + browTilt} L${50 - eyeGap + 4} ${eyeY - 6}" stroke="${grey ? '#5A5550' : shade(hair, 0.9)}" stroke-width="2.2" stroke-linecap="round"/>`,
    `<path d="M${50 + eyeGap - 4} ${eyeY - 6} L${50 + eyeGap + 5} ${eyeY - 5 + browTilt}" stroke="${grey ? '#5A5550' : shade(hair, 0.9)}" stroke-width="2.2" stroke-linecap="round"/>`,
    // Augen
    `<ellipse cx="${50 - eyeGap}" cy="${eyeY}" rx="2.6" ry="2.2" fill="#FFFFFF"/>`,
    `<ellipse cx="${50 + eyeGap}" cy="${eyeY}" rx="2.6" ry="2.2" fill="#FFFFFF"/>`,
    `<circle cx="${50 - eyeGap + 0.3}" cy="${eyeY + 0.2}" r="1.5" fill="#2A1E16"/>`,
    `<circle cx="${50 + eyeGap + 0.3}" cy="${eyeY + 0.2}" r="1.5" fill="#2A1E16"/>`,
    // Nase und Mund
    `<path d="M50 ${eyeY + 3} Q48 ${eyeY + 9} 47 ${eyeY + 10} Q50 ${eyeY + 11.5} 53 ${eyeY + 10}" fill="none" stroke="${skinDark}" stroke-width="1.3" stroke-linecap="round"/>`,
    smile
      ? `<path d="M44 ${eyeY + 15} Q50 ${eyeY + 19} 56 ${eyeY + 15}" fill="none" stroke="${shade(skinDark, 0.85)}" stroke-width="1.6" stroke-linecap="round"/>`
      : `<path d="M45 ${eyeY + 16} L55 ${eyeY + 16}" stroke="${shade(skinDark, 0.85)}" stroke-width="1.6" stroke-linecap="round"/>`,
    `</g>`,
    `</svg>`,
  ].join('');
}
