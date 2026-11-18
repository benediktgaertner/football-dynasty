/**
 * C5/C7: Die 55 UEFA-Mitgliedsverbände der Spielwelt.
 * `strength` ist der fiktive Start-Stärkeindikator (0–100) einer Karrierewelt; er
 * entwickelt sich pro Welt jährlich weiter (Tabelle association_strength_history).
 * `naming` verweist auf das Namensprofil für die landestypische Vereinsnamen-Generierung (C7).
 * `leagueSize` ist die Größe der simulierten Erstliga.
 */
export type NamingProfile =
  | 'de'
  | 'en'
  | 'es'
  | 'it'
  | 'fr'
  | 'nl'
  | 'pt'
  | 'nordic'
  | 'slavic_balkan'
  | 'east_slavic'
  | 'baltic'
  | 'hu'
  | 'ro'
  | 'tr'
  | 'gr'
  | 'caucasus'
  | 'he'
  | 'sq'
  | 'mt'
  | 'other_latin';

export interface Association {
  code: string;
  name: string;
  naming: NamingProfile;
  strength: number;
  leagueSize: number;
}

export const ASSOCIATIONS: readonly Association[] = [
  { code: 'ENG', name: 'England', naming: 'en', strength: 100, leagueSize: 20 },
  { code: 'ESP', name: 'Spanien', naming: 'es', strength: 96, leagueSize: 20 },
  { code: 'ITA', name: 'Italien', naming: 'it', strength: 93, leagueSize: 20 },
  { code: 'GER', name: 'Deutschland', naming: 'de', strength: 92, leagueSize: 18 },
  { code: 'FRA', name: 'Frankreich', naming: 'fr', strength: 87, leagueSize: 18 },
  { code: 'POR', name: 'Portugal', naming: 'pt', strength: 81, leagueSize: 18 },
  { code: 'NED', name: 'Niederlande', naming: 'nl', strength: 79, leagueSize: 18 },
  { code: 'BEL', name: 'Belgien', naming: 'nl', strength: 75, leagueSize: 16 },
  { code: 'TUR', name: 'Türkei', naming: 'tr', strength: 71, leagueSize: 18 },
  { code: 'CZE', name: 'Tschechien', naming: 'slavic_balkan', strength: 67, leagueSize: 16 },
  { code: 'SCO', name: 'Schottland', naming: 'en', strength: 66, leagueSize: 12 },
  { code: 'AUT', name: 'Österreich', naming: 'de', strength: 66, leagueSize: 12 },
  { code: 'SUI', name: 'Schweiz', naming: 'de', strength: 64, leagueSize: 12 },
  { code: 'GRE', name: 'Griechenland', naming: 'gr', strength: 63, leagueSize: 14 },
  { code: 'NOR', name: 'Norwegen', naming: 'nordic', strength: 62, leagueSize: 16 },
  { code: 'DEN', name: 'Dänemark', naming: 'nordic', strength: 62, leagueSize: 12 },
  { code: 'ISR', name: 'Israel', naming: 'he', strength: 58, leagueSize: 14 },
  { code: 'POL', name: 'Polen', naming: 'slavic_balkan', strength: 58, leagueSize: 18 },
  { code: 'UKR', name: 'Ukraine', naming: 'east_slavic', strength: 58, leagueSize: 16 },
  { code: 'SRB', name: 'Serbien', naming: 'slavic_balkan', strength: 57, leagueSize: 16 },
  { code: 'CRO', name: 'Kroatien', naming: 'slavic_balkan', strength: 57, leagueSize: 10 },
  { code: 'SWE', name: 'Schweden', naming: 'nordic', strength: 55, leagueSize: 16 },
  { code: 'CYP', name: 'Zypern', naming: 'gr', strength: 55, leagueSize: 14 },
  { code: 'RUS', name: 'Russland', naming: 'east_slavic', strength: 54, leagueSize: 16 },
  { code: 'HUN', name: 'Ungarn', naming: 'hu', strength: 52, leagueSize: 12 },
  { code: 'ROU', name: 'Rumänien', naming: 'ro', strength: 51, leagueSize: 16 },
  { code: 'SVK', name: 'Slowakei', naming: 'slavic_balkan', strength: 50, leagueSize: 12 },
  { code: 'SVN', name: 'Slowenien', naming: 'slavic_balkan', strength: 48, leagueSize: 10 },
  { code: 'BUL', name: 'Bulgarien', naming: 'slavic_balkan', strength: 48, leagueSize: 16 },
  { code: 'AZE', name: 'Aserbaidschan', naming: 'caucasus', strength: 47, leagueSize: 10 },
  { code: 'KAZ', name: 'Kasachstan', naming: 'east_slavic', strength: 45, leagueSize: 14 },
  { code: 'BIH', name: 'Bosnien und Herzegowina', naming: 'slavic_balkan', strength: 43, leagueSize: 12 },
  { code: 'MDA', name: 'Moldau', naming: 'ro', strength: 40, leagueSize: 10 },
  { code: 'ISL', name: 'Island', naming: 'nordic', strength: 40, leagueSize: 12 },
  { code: 'FIN', name: 'Finnland', naming: 'nordic', strength: 40, leagueSize: 12 },
  { code: 'IRL', name: 'Irland', naming: 'en', strength: 40, leagueSize: 10 },
  { code: 'ARM', name: 'Armenien', naming: 'caucasus', strength: 38, leagueSize: 10 },
  { code: 'LVA', name: 'Lettland', naming: 'baltic', strength: 38, leagueSize: 10 },
  { code: 'GEO', name: 'Georgien', naming: 'caucasus', strength: 37, leagueSize: 10 },
  { code: 'BLR', name: 'Belarus', naming: 'east_slavic', strength: 37, leagueSize: 16 },
  { code: 'ALB', name: 'Albanien', naming: 'sq', strength: 36, leagueSize: 10 },
  { code: 'MKD', name: 'Nordmazedonien', naming: 'slavic_balkan', strength: 35, leagueSize: 12 },
  { code: 'KOS', name: 'Kosovo', naming: 'sq', strength: 35, leagueSize: 10 },
  { code: 'LTU', name: 'Litauen', naming: 'baltic', strength: 34, leagueSize: 10 },
  { code: 'LUX', name: 'Luxemburg', naming: 'fr', strength: 33, leagueSize: 16 },
  { code: 'FRO', name: 'Färöer', naming: 'nordic', strength: 32, leagueSize: 10 },
  { code: 'MNE', name: 'Montenegro', naming: 'slavic_balkan', strength: 32, leagueSize: 10 },
  { code: 'NIR', name: 'Nordirland', naming: 'en', strength: 31, leagueSize: 12 },
  { code: 'WAL', name: 'Wales', naming: 'en', strength: 30, leagueSize: 12 },
  { code: 'EST', name: 'Estland', naming: 'baltic', strength: 30, leagueSize: 10 },
  { code: 'MLT', name: 'Malta', naming: 'mt', strength: 28, leagueSize: 12 },
  { code: 'GIB', name: 'Gibraltar', naming: 'en', strength: 22, leagueSize: 10 },
  { code: 'AND', name: 'Andorra', naming: 'other_latin', strength: 21, leagueSize: 10 },
  { code: 'LIE', name: 'Liechtenstein', naming: 'de', strength: 21, leagueSize: 10 },
  { code: 'SMR', name: 'San Marino', naming: 'it', strength: 20, leagueSize: 10 },
];
