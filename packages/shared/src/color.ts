/**
 * Farbhilfen für Vereinsfarben, lesbare Trikotnummern und die
 * Kontrastregel bei ähnlichen Vereinsfarben (F2).
 */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

export function hexToRgb(hex: string): [number, number, number] {
  if (!isHexColor(hex)) throw new TypeError(`Keine gültige Hex-Farbe: ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Lesbare Schriftfarbe (Trikotnummer) auf einer Hintergrundfarbe. */
export function readableTextColor(background: string): '#111111' | '#FFFFFF' {
  return contrastRatio(background, '#111111') >= contrastRatio(background, '#FFFFFF') ? '#111111' : '#FFFFFF';
}

/**
 * Wahrgenommener Farbabstand (Redmean-Näherung), 0 … ~765.
 * Unterhalb von CLASH_THRESHOLD gelten zwei Farben auf dem Spielfeld als verwechselbar.
 */
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

export const CLASH_THRESHOLD = 150;
/** Mindestabstand zum Rasengrün, damit Spielerkreise sichtbar bleiben. */
const PITCH_GREEN = '#3C7A3A';

/**
 * F2: Wählt die Darstellungsfarbe der Gastmannschaft.
 * Reihenfolge: Primärfarbe → Sekundärfarbe → Ausweichfarben, bis sie sich klar von
 * der Heimfarbe und vom Rasen unterscheidet.
 */
export function resolveAwayDisplayColor(homePrimary: string, awayPrimary: string, awaySecondary: string): string {
  const fallbacks = ['#F4EBD0', '#1B1B1B', '#F2A93B', '#7A2E8F', '#1F5FA8', '#C0392B'];
  const candidates = [awayPrimary, awaySecondary, ...fallbacks];
  for (const c of candidates) {
    if (colorDistance(c, homePrimary) >= CLASH_THRESHOLD && colorDistance(c, PITCH_GREEN) >= CLASH_THRESHOLD * 0.8) {
      return c;
    }
  }
  return readableTextColor(homePrimary) === '#FFFFFF' ? '#F4EBD0' : '#1B1B1B';
}
