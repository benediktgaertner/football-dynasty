import { useEffect } from 'react';
import { requireSupabase } from './supabase';

/**
 * Zentrales Theme-System für alle Wettbewerbe. Eine Akzentfarbe je Wettbewerb (keine Farbflut),
 * neutrale Grundflächen. Anleihen an TV-Übertragungen ohne offizielle Grafiken oder Logos.
 */
export interface CompetitionRef { kind?: string | null; tier?: number | null; association?: string | null; name?: string | null }
export interface CompetitionTheme {
  key: string;
  label: string;
  /** Akzentfarbe (Buttons, Markierungen) */
  accent: string;
  accent2: string;
  /** RGB-Tripel für Lichteffekte */
  glow: string;
  /** Ergebnisanzeige: Hintergrund-Verlauf, Rand, Schrift der Wettbewerbszeile */
  board: { from: string; to: string; edge: string; label: string; text: string };
}

const T = (key: string, label: string, accent: string, accent2: string, glow: string, board: CompetitionTheme['board']): CompetitionTheme => ({ key, label, accent, accent2, glow, board });

export const THEMES: Record<string, CompetitionTheme> = {
  // Deutschland: rot (1. Liga), Koralle (2. Liga), Petrol (3. Liga)
  ger1: T('ger1', 'Bundesliga', '#ff4d5e', '#ff8a8a', '255 77 94', { from: '#1a0d10', to: '#3a1118', edge: '#ff4d5e', label: '#ff4d5e', text: '#ffffff' }),
  ger2: T('ger2', '2. Liga', '#ff7a59', '#ffb199', '255 122 89', { from: '#170f0c', to: '#35190f', edge: '#ff7a59', label: '#ffb199', text: '#ffffff' }),
  ger3: T('ger3', '3. Liga', '#2dd4bf', '#99f6e4', '45 212 191', { from: '#0b1615', to: '#0f2b28', edge: '#2dd4bf', label: '#99f6e4', text: '#ffffff' }),
  cup: T('cup', 'Pokal', '#e8b14a', '#f6d48f', '232 177 74', { from: '#15110a', to: '#33260d', edge: '#e8b14a', label: '#f6d48f', text: '#ffffff' }),
  // Europa: Königsklasse dunkelblau/violett/silber, zweiter Wettbewerb orange/schwarz
  cl: T('cl', 'Champions-Wettbewerb', '#b8a6ff', '#d9dee8', '184 166 255', { from: '#070b24', to: '#241a55', edge: '#c9cfdb', label: '#d9dee8', text: '#ffffff' }),
  el: T('el', 'Europa-Wettbewerb', '#ff8a1f', '#ffd2a6', '255 138 31', { from: '#0b0b0b', to: '#2a1606', edge: '#ff8a1f', label: '#ffd2a6', text: '#ffffff' }),
  friendly: T('friendly', 'Testspiel', '#9fb3c8', '#d6e0ea', '159 179 200', { from: '#101419', to: '#1d2630', edge: '#9fb3c8', label: '#d6e0ea', text: '#ffffff' }),
};

// Weitere Länder: je Verband eine eigene, ruhige Akzentfarbe
const COUNTRY: Record<string, string> = {
  ENG: '#a78bfa', ESP: '#ff6b6b', ITA: '#38bdf8', FRA: '#60a5fa', NED: '#fb923c', POR: '#34d399', BEL: '#facc15', TUR: '#f87171',
  SCO: '#818cf8', AUT: '#f43f5e', SUI: '#ef4444', GRE: '#3b82f6',
};

export function competitionTheme(c: CompetitionRef | null | undefined): CompetitionTheme {
  const kind = String(c?.kind ?? 'league');
  if (kind === 'friendly') return THEMES.friendly!;
  if (/champions/.test(kind)) return THEMES.cl!;
  if (/europa|continental/.test(kind)) return THEMES.el!;
  if (kind !== 'league') return THEMES.cup!;
  const assoc = c?.association ?? 'GER';
  // Nationale Ligen des Spiellands (haben eine Spielklasse): rot / Koralle / Petrol
  if (assoc === 'GER' || !assoc || c?.tier != null) {
    const base = THEMES[`ger${Math.min(3, Math.max(1, c?.tier ?? 1))}`] ?? THEMES.ger1!;
    return c?.name ? { ...base, label: c.name } : base;
  }
  const accent = COUNTRY[assoc] ?? '#9fb3c8';
  const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)).join(' ');
  return T(assoc, c?.name ?? assoc, accent, accent, rgb, { from: '#0f1216', to: '#1f2630', edge: accent, label: accent, text: '#ffffff' });
}

export function applyTheme(t: CompetitionTheme): void {
  const r = document.documentElement.style;
  r.setProperty('--fd-accent', t.accent);
  r.setProperty('--fd-accent-2', t.accent2);
  r.setProperty('--fd-glow', t.glow);
}

const cache = new Map<string, CompetitionTheme>();

/** Setzt die Farbwelt passend zur eigenen Liga (einmal je Welt, danach aus dem Zwischenspeicher) */
export function useWorldTheme(worldId: string | undefined): void {
  useEffect(() => {
    if (!worldId) return;
    const hit = cache.get(worldId);
    if (hit) { applyTheme(hit); return; }
    let stored: CompetitionRef | null = null;
    try { stored = JSON.parse(sessionStorage.getItem(`fd-theme:${worldId}`) ?? 'null') as CompetitionRef | null; } catch { stored = null; }
    if (stored) applyTheme(competitionTheme(stored));
    void (async () => {
      try {
        const { data } = await requireSupabase().rpc('world_theme', { p_world: worldId });
        const t = competitionTheme((data as CompetitionRef | null) ?? null);
        cache.set(worldId, t);
        applyTheme(t);
        try { sessionStorage.setItem(`fd-theme:${worldId}`, JSON.stringify(data ?? null)); } catch { /* privater Modus */ }
      } catch { /* Standardfarben behalten */ }
    })();
  }, [worldId]);
}
