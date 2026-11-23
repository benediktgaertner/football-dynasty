/** Menüstruktur der Karrierewelt (reine Daten und Hilfsfunktion, auch in Tests verwendet) */
export interface Entry { to: string; label: string; hint: string }
export interface Group {
  key: string; label: string;
  /** direkter Link (kein Untermenü) */
  to?: string;
  items?: Entry[];
  /** weitere Pfadanfänge, die zu diesem Bereich gehören (z. B. Unterseiten) */
  also?: string[];
}

export const NAV: Group[] = [
  { key: 'dashboard', label: 'Dashboard', to: 'spieltag', also: ['uebersicht', 'match'] },
  { key: 'mannschaft', label: 'Mannschaft', also: ['spieler'], items: [
    { to: 'team', label: 'Team', hint: 'Aufstellung, Taktik, Training' },
    { to: 'entwicklung', label: 'Entwicklung', hint: 'Spielerentwicklung und Bilanz' },
    { to: 'jugend', label: 'Jugend', hint: 'Jugendabteilung und Talente' },
    { to: 'vertraege', label: 'Verträge', hint: 'Verlängerungen, Gehälter, Abgänge' },
  ] },
  { key: 'wettbewerbe', label: 'Wettbewerbe', also: ['club'], items: [
    { to: 'liga', label: 'Liga', hint: 'Tabelle, Spielplan, Statistiken' },
    { to: 'pokal', label: 'Pokal', hint: 'Pokalwettbewerb' },
    { to: 'europa', label: 'Europa', hint: 'Champions League und Europa League' },
    { to: 'kalender', label: 'Kalender', hint: 'Alle Termine und Begegnungen' },
  ] },
  { key: 'transfers', label: 'Transfers', to: 'transfers' },
  { key: 'verein', label: 'Verein', also: ['verein', 'choreo'], items: [
    { to: 'finanzen', label: 'Finanzen & Stadion', hint: 'Konto, Buchungen, Stadionausbau' },
    { to: 'fankultur', label: 'Fankultur & Musik', hint: 'Fahnen, Ultras, Hymnen, Gesänge' },
    { to: 'choreo', label: 'Choreo-Designer', hint: 'Choreografien für das ganze Stadion' },
  ] },
  { key: 'liga', label: 'Liga-Menü', to: 'start', also: ['einstellungen'] },
];

/** Welche Gruppe gehört zu dieser Seite? (erstes Pfadsegment nach /w/:id/) */
export function activeGroup(pathname: string, worldId: string): string | null {
  const rest = pathname.replace(new RegExp(`^/w/${worldId}/?`), '').split('/')[0] ?? '';
  for (const g of NAV) {
    if (g.to === rest || g.also?.includes(rest) || g.items?.some((i) => i.to === rest)) return g.key;
  }
  return null;
}

