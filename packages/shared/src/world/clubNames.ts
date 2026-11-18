import { normalizeName } from '../naming.js';
import type { Rng } from '../rng.js';
import { CLUB_NAME_BLOCKLIST } from './clubBlocklist.js';

/**
 * C7: Landestypische, fiktive Vereinsnamen. Datengetrieben je Namensprofil.
 * Phase 3 nutzt das deutsche Profil (54 Vereine der drei Ligen); weitere Profile
 * (en, es, it, …) folgen mit den ausländischen Ligen in Phase 7 im selben Format.
 */
export interface NamingProfileData {
  /** Ortsnamen; optional mit Adjektivform ("Bielefeld/Bielefelder") für Muster wie "Karlsruher SC" */
  places: readonly string[];
  prefixes: readonly string[];
  /** Eigennamen vor dem Ort ("Eintracht", "Union", …) */
  traditionNames: readonly string[];
  /** Zusätze nach der Adjektivform ("SC", "FV", "Kickers", …) */
  adjectiveSuffixes: readonly string[];
  stadiumPatterns: readonly string[];
  stadiumFeatures: readonly string[];
}

export const GERMAN_NAMING: NamingProfileData = {
  places: [
    'Aschaffenburg/Aschaffenburger', 'Bamberg/Bamberger', 'Bayreuth/Bayreuther', 'Bocholt/Bocholter', 'Bonn/Bonner', 'Bruchsal/Bruchsaler',
    'Celle/Celler', 'Coburg/Coburger', 'Cuxhaven/Cuxhavener', 'Delmenhorst/Delmenhorster', 'Detmold/Detmolder', 'Dinslaken/Dinslakener',
    'Düren/Dürener', 'Emden/Emder', 'Erfurt/Erfurter', 'Erlangen/Erlanger', 'Eschweiler/Eschweiler', 'Esslingen/Esslinger',
    'Flensburg/Flensburger', 'Freising/Freisinger', 'Fulda/Fuldaer', 'Gießen/Gießener', 'Göttingen/Göttinger', 'Goslar/Goslarer',
    'Gütersloh/Gütersloher', 'Hagen/Hagener', 'Hameln/Hamelner', 'Hamm/Hammer', 'Hanau/Hanauer', 'Heilbronn/Heilbronner',
    'Herford/Herforder', 'Hildesheim/Hildesheimer', 'Homburg/Homburger', 'Iserlohn/Iserlohner', 'Kassel/Kasseler', 'Kempten/Kemptener',
    'Kleve/Klever', 'Koblenz/Koblenzer', 'Konstanz/Konstanzer', 'Krefeld/Krefelder', 'Landshut/Landshuter', 'Lingen/Lingener',
    'Lippstadt/Lippstädter', 'Lübeck/Lübecker', 'Lüneburg/Lüneburger', 'Marburg/Marburger', 'Memmingen/Memminger', 'Minden/Mindener',
    'Neumünster/Neumünsteraner', 'Neuss/Neusser', 'Oldenburg/Oldenburger', 'Paderborn', 'Passau/Passauer', 'Pforzheim/Pforzheimer',
    'Plauen/Plauener', 'Potsdam/Potsdamer', 'Ravensburg/Ravensburger', 'Recklinghausen/Recklinghäuser', 'Reutlingen/Reutlinger',
    'Rosenheim/Rosenheimer', 'Saalfeld/Saalfelder', 'Salzgitter', 'Schweinfurt/Schweinfurter', 'Schwerin/Schweriner', 'Siegen/Siegener',
    'Solingen/Solinger', 'Speyer/Speyerer', 'Stralsund/Stralsunder', 'Trier/Trierer', 'Tübingen/Tübinger', 'Ulm', 'Velbert/Velberter',
    'Villingen/Villinger', 'Weimar/Weimarer', 'Wetzlar/Wetzlarer', 'Wilhelmshaven/Wilhelmshavener', 'Witten/Wittener', 'Worms/Wormser',
    'Würzburg/Würzburger', 'Zwickau/Zwickauer', 'Bad Kreuznach', 'Neubrandenburg', 'Frankfurt (Oder)', 'Gera/Geraer', 'Görlitz/Görlitzer',
    'Greifswald/Greifswalder', 'Ingolstadt', 'Kaiserswerth', 'Landau/Landauer', 'Lörrach/Lörracher', 'Meppen/Meppener', 'Nordhorn/Nordhorner',
    'Offenburg/Offenburger', 'Osnabrück', 'Rheine/Rheiner', 'Rottweil/Rottweiler', 'Singen/Singener', 'Sindelfingen/Sindelfinger',
    'Straubing/Straubinger', 'Waldkirch', 'Weiden/Weidener', 'Wolfenbüttel/Wolfenbütteler', 'Gladbeck/Gladbecker', 'Herne/Herner',
    'Ludwigsburg/Ludwigsburger', 'Hemmingen', 'Grünwald', 'Hohenwalde', 'Bergheim', 'Lindenau', 'Talheim', 'Rheinfelden',
  ],
  prefixes: ['FC', 'SV', 'SC', 'TSV', 'VfB', 'VfL', 'SpVgg', 'FSV', 'TuS', 'SG', '1. FC', 'FV', 'BSC', 'SSV', 'ASV', 'MTV', 'VfR', 'SpVg', 'TSG', 'SC Germania'],
  traditionNames: ['Eintracht', 'Union', 'Fortuna', 'Viktoria', 'Germania', 'Concordia', 'Borussia', 'Preußen', 'Arminia', 'Teutonia', 'Rot-Weiß', 'Blau-Weiß', 'Schwarz-Weiß', 'Sportfreunde', 'Olympia', 'Phönix', 'Wacker', 'Rasensport'],
  adjectiveSuffixes: ['SC', 'SV', 'FC', 'FV', 'BC', 'Kickers', 'TV', 'SpVgg', 'Sportclub'],
  stadiumPatterns: ['{adj} Stadion', 'Stadion am {feature}', 'Sportpark {place}', '{place}-Arena', 'Waldstadion {place}', 'Stadion {place}', 'Arena am {feature}', 'Stadion im Volkspark {place}'],
  stadiumFeatures: ['Schlossberg', 'Mühlbach', 'Stadtwald', 'Bahndamm', 'Lindenhof', 'Hafen', 'Burgberg', 'Wiesengrund', 'Kanal', 'Ziegelfeld', 'Rosengarten', 'Sonnenhang', 'Eichenhain', 'Flussufer', 'Steinbruch'],
};

/** Plausible Vereinsfarben (Primär, Sekundär, Akzent). */
export const CLUB_COLOR_SETS: ReadonlyArray<readonly [string, string, string]> = [
  ['#C0392B', '#FFFFFF', '#1B1B1B'],
  ['#1F5FA8', '#FFFFFF', '#F2C14E'],
  ['#1E7A46', '#FFFFFF', '#1B1B1B'],
  ['#1B1B1B', '#FFFFFF', '#C0392B'],
  ['#F2C14E', '#1B1B1B', '#FFFFFF'],
  ['#7A2E8F', '#FFFFFF', '#F2C14E'],
  ['#0E6E6E', '#F4EBD0', '#1B1B1B'],
  ['#8C1C13', '#F2C14E', '#FFFFFF'],
  ['#1F5FA8', '#C0392B', '#FFFFFF'],
  ['#FFFFFF', '#1F5FA8', '#1B1B1B'],
  ['#FFFFFF', '#C0392B', '#1B1B1B'],
  ['#FFFFFF', '#1E7A46', '#1B1B1B'],
  ['#E2582B', '#1B1B1B', '#FFFFFF'],
  ['#2B2D42', '#87CEEB', '#FFFFFF'],
  ['#87CEEB', '#FFFFFF', '#1B1B1B'],
  ['#1E7A46', '#F2C14E', '#1B1B1B'],
  ['#C0392B', '#1F5FA8', '#F2C14E'],
  ['#5B2C1F', '#F4EBD0', '#F2C14E'],
  ['#2E4A9E', '#F2C14E', '#FFFFFF'],
  ['#1B1B1B', '#F2C14E', '#FFFFFF'],
  ['#9E1B32', '#FFFFFF', '#F2C14E'],
  ['#006D5B', '#FFFFFF', '#E2582B'],
];

const BLOCKED = new Set(Object.values(CLUB_NAME_BLOCKLIST).flat().map(normalizeName));

export function isBlockedClubName(name: string): boolean {
  return BLOCKED.has(normalizeName(name));
}

function splitPlace(entry: string): { place: string; adjective: string | null } {
  const [place, adjective] = entry.split('/');
  return { place: place!, adjective: adjective ?? null };
}

/** Registry für Eindeutigkeit innerhalb einer Welt (C7.1), menschliche Vereine inklusive. */
export class NameRegistry {
  private readonly names = new Set<string>();
  private readonly shorts = new Set<string>();
  private readonly colorKeys = new Map<number, Set<string>>();
  private readonly places = new Set<string>();

  usePlace(place: string): void {
    this.places.add(place);
  }
  placeUsed(place: string): boolean {
    return this.places.has(place);
  }

  reserve(name: string, short: string): void {
    this.names.add(normalizeName(name));
    this.shorts.add(normalizeName(short));
  }
  hasName(name: string): boolean {
    return this.names.has(normalizeName(name));
  }
  hasShort(short: string): boolean {
    return this.shorts.has(normalizeName(short));
  }
  reserveColors(tier: number, primary: string, secondary: string): void {
    if (!this.colorKeys.has(tier)) this.colorKeys.set(tier, new Set());
    this.colorKeys.get(tier)!.add(`${primary}|${secondary}`);
  }
  colorsTaken(tier: number, primary: string, secondary: string): boolean {
    return this.colorKeys.get(tier)?.has(`${primary}|${secondary}`) ?? false;
  }
}

export function generateClubName(rng: Rng, profile: NamingProfileData, registry: NameRegistry): { name: string; place: string; adjective: string | null; foundedYear: number } {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { place, adjective } = splitPlace(rng.pick(profile.places));
    // jeder Ort höchstens einmal je Welt (Abwechslung), solange genug Orte frei sind
    if (registry.placeUsed(place) && attempt < 400) continue;
    const foundedYear = rng.int(1880, 1965);
    const roll = rng.next();
    let name: string;
    if (roll < 0.42) name = `${rng.pick(profile.prefixes)} ${place}`;
    else if (roll < 0.62) name = `${rng.pick(profile.prefixes)} ${place} ${String(foundedYear).slice(rng.next() < 0.7 ? 0 : 2)}`;
    else if (roll < 0.84) name = `${rng.pick(profile.traditionNames)} ${place}`;
    else if (adjective) name = `${adjective} ${rng.pick(profile.adjectiveSuffixes)}`;
    else continue;
    name = name.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    if (name.length > 32 || isBlockedClubName(name) || registry.hasName(name)) continue;
    registry.usePlace(place);
    return { name, place, adjective, foundedYear };
  }
  throw new Error('Kein freier Vereinsname gefunden');
}

const SHORT_ALLOWED = /[^A-ZÄÖÜ0-9]/gu;

function upperLetters(s: string): string {
  return s
    .toUpperCase()
    .replace(/ß/g, 'SS')
    .normalize('NFD')
    .replace(/Ä/g, 'Ä')
    .replace(/Ö/g, 'Ö')
    .replace(/Ü/g, 'Ü')
    .replace(/[̀-ͯ]/g, '')
    .replace(SHORT_ALLOWED, '');
}

/** Kurzname mit 3–4 Zeichen, eindeutig in der Welt. */
export function generateShortName(rng: Rng, name: string, place: string, registry: NameRegistry): string {
  const words = name.split(/[\s-]+/).filter((w) => !/^\d+\.?$/.test(w));
  const initials = upperLetters(words.map((w) => w[0] ?? '').join(''));
  const p = upperLetters(place);
  const first = upperLetters(words[0] ?? '');
  const consonants = p.slice(1).replace(/[AEIOUÄÖÜ]/g, '');
  const candidates = [
    initials.length >= 3 ? initials.slice(0, 4) : '',
    (first[0] ?? '') + p.slice(0, 2),
    p.slice(0, 3),
    (p[0] ?? '') + consonants.slice(0, 2),
    initials.slice(0, 2) + (p[1] ?? ''),
    (first[0] ?? '') + (p[0] ?? '') + consonants.slice(0, 1),
    p.slice(0, 4),
  ];
  for (const c of candidates) {
    if (/^[A-ZÄÖÜ0-9]{3,4}$/u.test(c) && !registry.hasShort(c)) return c;
  }
  for (let i = 0; i < 200; i++) {
    const c = (p.slice(0, 2) || 'FC') + String(rng.int(1, 99));
    const s = c.slice(0, 4);
    if (/^[A-ZÄÖÜ0-9]{3,4}$/u.test(s) && !registry.hasShort(s)) return s;
  }
  throw new Error('Kein freier Kurzname gefunden');
}

export function generateStadiumName(rng: Rng, profile: NamingProfileData, place: string, adjective: string | null): string {
  for (let i = 0; i < 20; i++) {
    const pattern = rng.pick(profile.stadiumPatterns);
    if (pattern.includes('{adj}') && !adjective) continue;
    const s = pattern
      .replace('{adj}', adjective ?? '')
      .replace('{place}', place.replace(/[()]/g, ''))
      .replace('{feature}', rng.pick(profile.stadiumFeatures));
    if (s.length >= 3 && s.length <= 40) return s;
  }
  return `Stadion ${place.replace(/[()]/g, '')}`.slice(0, 40);
}
