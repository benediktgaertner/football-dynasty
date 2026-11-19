/**
 * Orientierungsvereine: fiktive, rechtlich eigenständige Vereine an den großen Fußballstandorten Europas.
 * Die Spielwelt erinnert so an die reale Struktur (München, Dortmund, Hamburg, Gelsenkirchen, Madrid, Mailand …),
 * ohne reale Vereinsnamen, Wappen oder Marken zu verwenden: eigene Namensbestandteile aus Landschaft, Fluss,
 * Stadtteil oder Tradition statt bloß veränderter Buchstaben. Reihenfolge = Stärke (Top-Vereine zuerst).
 * Die Sperrliste (clubBlocklist.ts) gilt zusätzlich.
 */
export interface AnchorClub {
  name: string;
  short: string;
  place: string;
  colors: readonly [string, string, string];
}

const A = (name: string, short: string, place: string, c1: string, c2: string, c3: string): AnchorClub => ({ name, short, place, colors: [c1, c2, c3] });
const W = '#FFFFFF', K = '#1B1B1B';

export const ANCHOR_CLUBS: Readonly<Record<string, readonly AnchorClub[]>> = {
  GER: [
    // 1. Liga
    A('SC Isar München', 'ISM', 'München', '#C8102E', W, '#0B2D5B'),
    A('Westfalia Dortmund', 'WFD', 'Dortmund', '#F5C400', K, W),
    A('SV Rheinwerk Leverkusen', 'RWL', 'Leverkusen', '#E30613', K, W),
    A('FC Pleiße Leipzig', 'FPL', 'Leipzig', '#E4002B', W, '#0A2240'),
    A('Neckar SC Stuttgart', 'NSC', 'Stuttgart', W, '#E32219', K),
    A('SG Mainufer Frankfurt', 'SGM', 'Frankfurt', K, '#E1000F', W),
    A('SV Glückauf Gelsenkirchen', 'SVG', 'Gelsenkirchen', '#004D9D', W, K),
    A('Hanse SV Hamburg', 'HSH', 'Hamburg', '#0A3F8F', W, K),
    A('SC Weser Bremen', 'SCW', 'Bremen', '#1D9053', W, K),
    A('FC Niederrhein Mönchengladbach', 'FNM', 'Mönchengladbach', W, K, '#1E8C3A'),
    A('SV Domstadt Köln', 'SDK', 'Köln', '#ED1C24', W, K),
    A('Spree SC Berlin', 'SSB', 'Berlin', '#005CA9', W, K),
    A('VfR Mittelland Wolfsburg', 'VMW', 'Wolfsburg', '#65B32E', W, K),
    A('FV Breisgau Freiburg', 'FVB', 'Freiburg', '#E2001A', K, W),
    A('SV Kraichgau Sinsheim', 'SVK', 'Sinsheim', '#1C63B7', W, K),
    A('SC Rheinhessen Mainz', 'SRM', 'Mainz', '#C3141E', W, K),
    A('FC Lech Augsburg', 'FLA', 'Augsburg', '#BA3733', '#46714D', W),
    A('SV Wuhlheide Berlin', 'SWB', 'Berlin', '#D4011D', W, '#F2C14E'),
    // 2. Liga
    A('SV Leine Hannover', 'SLH', 'Hannover', '#C8102E', K, '#1E7A46'),
    A('FC Rheinbogen Düsseldorf', 'FRD', 'Düsseldorf', '#DA251D', W, K),
    A('SV Betzenberg Kaiserslautern', 'SBK', 'Kaiserslautern', '#C8102E', W, K),
    A('FC Pegnitz Nürnberg', 'FPN', 'Nürnberg', '#8C1C13', K, W),
    A('SV Hardtwald Karlsruhe', 'SHK', 'Karlsruhe', '#0A57A4', W, K),
    A('SC Ruhrtal Bochum', 'SRB', 'Bochum', '#005CA9', W, K),
    A('SC Kiez Hamburg', 'SKH', 'Hamburg', '#5A3A22', W, '#C8102E'),
    A('SV Förde Kiel', 'SFK', 'Kiel', '#0A3F8F', W, '#C8102E'),
    A('SC Woog Darmstadt', 'SWD', 'Darmstadt', '#004E9E', W, K),
    A('SC Senne Paderborn', 'SSP', 'Paderborn', '#003C8F', K, W),
    A('FC Rednitz Fürth', 'FRF', 'Fürth', '#1E7A46', W, K),
    A('SC Elbe Magdeburg', 'SEM', 'Magdeburg', '#0A57A4', W, K),
    A('SV Oker Braunschweig', 'SOB', 'Braunschweig', '#F5C400', '#0A3F8F', W),
    A('FC Warnow Rostock', 'FWR', 'Rostock', '#0A3F8F', W, '#C8102E'),
    A('SG Elbflorenz Dresden', 'SED', 'Dresden', '#F5C400', K, W),
    A('SC Teutoburg Bielefeld', 'STB', 'Bielefeld', '#0A3F8F', W, K),
    A('SC Aasee Münster', 'SAM', 'Münster', K, W, '#1E7A46'),
    A('SV Donau Regensburg', 'SDR', 'Regensburg', '#C8102E', W, K),
    // 3. Liga
    A('FC Saar Saarbrücken', 'FSS', 'Saarbrücken', '#0A3F8F', K, W),
    A('FC Kaiserstadt Aachen', 'FKA', 'Aachen', '#F5C400', K, W),
    A('SV Ruhrstahl Essen', 'SRE', 'Essen', '#C8102E', W, K),
    A('FC Rheinhafen Duisburg', 'FRH', 'Duisburg', '#0A57A4', W, K),
    A('SV Quadrate Mannheim', 'SQM', 'Mannheim', '#0A3F8F', W, K),
    A('VfB Hase Osnabrück', 'VHO', 'Osnabrück', '#5B2C83', W, K),
    A('SV Taunus Wiesbaden', 'STW', 'Wiesbaden', '#C8102E', K, W),
    A('SC Donautor Ingolstadt', 'SDI', 'Ingolstadt', '#C8102E', K, W),
    A('FC Lausitz Cottbus', 'FLC', 'Cottbus', '#C8102E', W, K),
    A('FV Donautal Ulm', 'FDU', 'Ulm', K, W, '#C8102E'),
    A('SpVgg Hachinger Tal', 'SHT', 'Unterhaching', '#C8102E', '#0A3F8F', W),
    A('FC Saale Halle', 'FSH', 'Halle', '#C8102E', W, K),
    A('SV Domberg Erfurt', 'SDE', 'Erfurt', '#0A3F8F', W, '#C8102E'),
    A('SV Kernberge Jena', 'SKJ', 'Jena', '#0A3F8F', '#F5C400', W),
    A('FC Chemnitztal', 'FCC', 'Chemnitz', '#6CACE4', W, K),
    A('FSV Mulde Zwickau', 'FMZ', 'Zwickau', '#C8102E', W, K),
    A('VfB Hunte Oldenburg', 'VHU', 'Oldenburg', '#0A3F8F', W, K),
    A('SC Trave Lübeck', 'STL', 'Lübeck', '#1E7A46', W, K),
    A('FC Mainfranken Würzburg', 'FMW', 'Würzburg', '#C8102E', W, K),
    A('SC Mainbogen Offenbach', 'SMO', 'Offenbach', '#C8102E', W, K),
    A('SV Schacht Aue', 'SSA', 'Aue', '#5B2C83', W, K),
  ],
  ENG: [
    A('Manchester Mariners', 'MMA', 'Manchester', '#C8102E', W, K),
    A('Liverpool Ramblers', 'LRA', 'Liverpool', '#C8102E', '#F5C400', W),
    A('North London Corinthians', 'NLC', 'London', '#E30613', W, '#0A3F8F'),
    A('Manchester Victoria', 'MVI', 'Manchester', '#6CABDD', W, K),
    A('West London Swifts', 'WLS', 'London', '#034694', W, K),
    A('Newcastle Wayfarers', 'NWA', 'Newcastle', K, W, '#9AA0A6'),
    A('Birmingham Lions', 'BLI', 'Birmingham', '#670E36', '#95BFE5', W),
  ],
  ESP: [
    A('Unión Castellana Madrid', 'UCM', 'Madrid', W, K, '#F2C14E'),
    A('Mediterrani Barcelona', 'MDB', 'Barcelona', '#A50044', '#004D98', '#F5C400'),
    A('Deportivo Manzanares Madrid', 'DMM', 'Madrid', '#CB3524', W, '#272E61'),
    A('Unión Giralda Sevilla', 'UGS', 'Sevilla', '#D71920', W, K),
    A('Deportivo Turia Valencia', 'DTV', 'Valencia', W, '#EE3524', K),
    A('Club Nervión Bilbao', 'CNB', 'Bilbao', '#EE2523', W, K),
  ],
  ITA: [
    A('Virtus Navigli Milano', 'VMN', 'Milano', '#FB090B', K, W),
    A('Sforzesca Milano', 'SFM', 'Milano', '#0068A8', K, W),
    A('Polisportiva Mole Torino', 'PMT', 'Torino', K, W, '#F2C14E'),
    A('Capitolina Roma', 'CPR', 'Roma', '#8E1F2F', '#F0BC42', W),
    A('Unione Tevere Roma', 'UTR', 'Roma', '#87D8F7', W, K),
    A('Vesuvio Napoli', 'VEN', 'Napoli', '#12A0D7', W, K),
  ],
  FRA: [
    A('Racing Seine Paris', 'RSP', 'Paris', '#004170', '#DA291C', W),
    A('Union Vieux-Port Marseille', 'UVM', 'Marseille', '#2FAEE0', W, K),
    A('Lyon Confluence', 'LYC', 'Lyon', W, '#DA001A', '#14387F'),
    A('Lille Métropole SC', 'LMS', 'Lille', '#E01E13', W, '#0A3F8F'),
  ],
  NED: [
    A('Amstel Sport Amsterdam', 'ASA', 'Amsterdam', '#D2122E', W, K),
    A('Maasstad Rotterdam', 'MAR', 'Rotterdam', W, '#E10600', K),
    A('Lichtstad Eindhoven', 'LIE', 'Eindhoven', '#ED1C24', W, K),
  ],
  POR: [
    A('Desportivo Tejo Lisboa', 'DTL', 'Lisboa', '#E83030', W, K),
    A('Alfama Lisboa', 'ALI', 'Lisboa', '#008057', W, K),
    A('Ribeira Porto', 'RPO', 'Porto', '#00428C', W, K),
  ],
  BEL: [
    A('Sporting Reien Brugge', 'SRG', 'Brugge', '#0A3F8F', K, W),
    A('Royal Zenne Bruxelles', 'RZB', 'Bruxelles', '#5B2C83', W, K),
  ],
  TUR: [
    A('Boğaz İstanbul', 'BOI', 'İstanbul', '#A90432', '#FDB912', W),
    A('Moda İstanbul Spor', 'MIS', 'İstanbul', '#FFED00', '#163962', W),
    A('Ortaköy İstanbul', 'ORI', 'İstanbul', K, W, '#C8102E'),
  ],
  SCO: [
    A('Glasgow Clydesdale', 'GCL', 'Glasgow', '#16973B', W, K),
    A('Glasgow Wayfarers', 'GWA', 'Glasgow', '#1B458F', W, '#C8102E'),
  ],
  AUT: [
    A('Wiener Donau SC', 'WDS', 'Wien', '#00663D', W, K),
    A('SV Prater Wien', 'SPW', 'Wien', '#5B2C83', W, K),
    A('Salzach Salzburg', 'SSZ', 'Salzburg', '#C8102E', W, '#0A3F8F'),
    A('SK Murinsel Graz', 'SMG', 'Graz', K, W, '#1E7A46'),
  ],
  SUI: [
    A('FC Rheinknie Basel', 'FRB', 'Basel', '#C8102E', '#0A3F8F', W),
    A('SC Aare Bern', 'SAB', 'Bern', '#F5C400', K, W),
    A('Limmat Zürich', 'LZU', 'Zürich', W, '#0A3F8F', K),
  ],
  GRE: [
    A('Attiki Athína', 'ATH', 'Athína', '#0A57A4', W, K),
    A('Limani Peiraiá', 'LMP', 'Peiraiá', '#C8102E', W, K),
    A('Thermaikos Thessaloníki', 'TTH', 'Thessaloníki', K, W, '#9AA0A6'),
  ],
};

function darken(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.round(v * (1 - f))).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`.toUpperCase();
}

/** Vereinsfarben des Orientierungsvereins; bei Gleichheit in derselben Liga leicht abgewandelt */
export function anchorColors(a: AnchorClub, taken: (p: string, s: string) => boolean): [string, string, string] {
  const [p, s, x] = a.colors;
  const options: Array<[string, string, string]> = [[p, s, x], [p, x, s], [s, p, x], [darken(p, 0.18), s, x], [darken(p, 0.32), s, x], [p, darken(s, 0.25), x]];
  return options.find(([c1, c2]) => !taken(c1, c2)) ?? options[options.length - 1]!;
}
