/**
 * C7.1: Sperrliste bekannter realer Profi- und Traditionsvereine (Auszug, erweiterbar).
 * Generierte KI-Vereinsnamen dürfen keinem dieser Namen (normalisiert) entsprechen.
 * Dieselbe Liste wird als Tabelle club_name_blocklist in die Datenbank geschrieben.
 */
export const CLUB_NAME_BLOCKLIST: Readonly<Record<string, readonly string[]>> = {
  GER: ['FC Bayern München', 'Bayern München', 'Borussia Dortmund', 'Bayer 04 Leverkusen', 'Bayer Leverkusen', 'RB Leipzig', 'VfB Stuttgart', 'Eintracht Frankfurt', 'SC Freiburg', 'VfL Wolfsburg', 'Borussia Mönchengladbach', '1. FC Union Berlin', 'Union Berlin', 'SV Werder Bremen', 'Werder Bremen', 'TSG Hoffenheim', 'TSG 1899 Hoffenheim', 'FC Augsburg', '1. FSV Mainz 05', 'Mainz 05', '1. FC Heidenheim', 'FC St. Pauli', 'Hamburger SV', '1. FC Köln', 'Hertha BSC', 'FC Schalke 04', 'Schalke 04', 'Hannover 96', '1. FC Kaiserslautern', 'Fortuna Düsseldorf', '1. FC Nürnberg', 'Karlsruher SC', 'VfL Bochum', 'SV Darmstadt 98', 'Holstein Kiel', 'SC Paderborn 07', 'Eintracht Braunschweig', 'Arminia Bielefeld', 'Dynamo Dresden', 'Hansa Rostock', '1. FC Magdeburg', 'SpVgg Greuther Fürth', 'SV Elversberg', 'Preußen Münster', 'SSV Ulm 1846', 'Jahn Regensburg', 'TSV 1860 München', 'MSV Duisburg', 'Alemannia Aachen', 'Rot-Weiss Essen', 'Energie Cottbus', 'Erzgebirge Aue', 'Waldhof Mannheim', 'Kickers Offenbach', 'SV Wehen Wiesbaden', 'SV Sandhausen', 'VfL Osnabrück', 'Hallescher FC', 'SC Verl', '1. FC Saarbrücken', 'Viktoria Köln', 'Stuttgarter Kickers', 'Wuppertaler SV', 'SG Wattenscheid 09', 'Rot-Weiß Oberhausen', 'Tennis Borussia Berlin', 'Carl Zeiss Jena', 'Chemnitzer FC', 'FC Ingolstadt 04', 'SpVgg Unterhaching'],
  AUT: ['Red Bull Salzburg', 'FC Red Bull Salzburg', 'SK Rapid Wien', 'Rapid Wien', 'FK Austria Wien', 'Austria Wien', 'SK Sturm Graz', 'Sturm Graz', 'LASK', 'Wolfsberger AC'],
  SUI: ['FC Basel', 'BSC Young Boys', 'Young Boys', 'FC Zürich', 'Grasshopper Club Zürich', 'FC St. Gallen', 'FC Luzern', 'Servette FC'],
  ENG: ['Manchester United', 'Manchester City', 'Liverpool FC', 'Liverpool', 'Arsenal FC', 'Arsenal', 'Chelsea FC', 'Chelsea', 'Tottenham Hotspur', 'Newcastle United', 'Aston Villa', 'West Ham United', 'Everton FC', 'Everton', 'Leeds United', 'Leicester City', 'Nottingham Forest', 'Wolverhampton Wanderers', 'Brighton & Hove Albion', 'Crystal Palace', 'Fulham FC', 'Southampton FC', 'Sunderland AFC', 'Ipswich Town', 'Norwich City', 'Sheffield United', 'Sheffield Wednesday', 'Blackburn Rovers', 'Bolton Wanderers', 'Derby County', 'West Bromwich Albion', 'Burnley FC', 'Brentford FC', 'AFC Bournemouth', 'Middlesbrough FC', 'Stoke City', 'Coventry City', 'Queens Park Rangers', 'Preston North End', 'Cardiff City', 'Swansea City'],
  SCO: ['Celtic FC', 'Celtic', 'Rangers FC', 'Rangers', 'Aberdeen FC', 'Heart of Midlothian', 'Hibernian FC', 'Dundee United'],
  ESP: ['Real Madrid', 'FC Barcelona', 'Atlético Madrid', 'Atlético de Madrid', 'Sevilla FC', 'Real Betis', 'Valencia CF', 'Villarreal CF', 'Athletic Club', 'Athletic Bilbao', 'Real Sociedad', 'RC Celta de Vigo', 'Celta Vigo', 'RCD Espanyol', 'Getafe CF', 'CA Osasuna', 'RCD Mallorca', 'UD Las Palmas', 'Deportivo Alavés', 'Rayo Vallecano', 'Real Valladolid', 'Deportivo La Coruña', 'Real Zaragoza', 'Málaga CF', 'Real Oviedo', 'Sporting Gijón', 'Racing Santander', 'Granada CF', 'Cádiz CF', 'Elche CF', 'Levante UD', 'Girona FC'],
  ITA: ['Juventus', 'Juventus FC', 'AC Milan', 'Inter Mailand', 'FC Internazionale', 'Inter', 'AS Roma', 'SS Lazio', 'SSC Napoli', 'Napoli', 'ACF Fiorentina', 'Atalanta BC', 'Atalanta', 'Torino FC', 'Bologna FC', 'Genoa CFC', 'UC Sampdoria', 'Udinese Calcio', 'US Sassuolo', 'Cagliari Calcio', 'Hellas Verona', 'Parma Calcio', 'US Lecce', 'Como 1907', 'Empoli FC', 'Venezia FC', 'AC Monza', 'Palermo FC', 'US Salernitana'],
  FRA: ['Paris Saint-Germain', 'Olympique de Marseille', 'Olympique Marseille', 'Olympique Lyonnais', 'Olympique Lyon', 'AS Monaco', 'LOSC Lille', 'OGC Nice', 'Stade Rennais', 'RC Lens', 'FC Nantes', 'Girondins de Bordeaux', 'AS Saint-Étienne', 'Stade de Reims', 'Montpellier HSC', 'RC Strasbourg', 'Toulouse FC', 'Stade Brestois', 'AJ Auxerre', 'Le Havre AC', 'FC Lorient', 'Angers SCO', 'FC Metz'],
  NED: ['Ajax Amsterdam', 'AFC Ajax', 'Ajax', 'PSV Eindhoven', 'PSV', 'Feyenoord', 'Feyenoord Rotterdam', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'SC Heerenveen', 'Vitesse Arnhem', 'FC Groningen', 'Sparta Rotterdam', 'Go Ahead Eagles', 'NEC Nijmegen', 'Willem II', 'RKC Waalwijk', 'NAC Breda', 'Fortuna Sittard', 'PEC Zwolle', 'Heracles Almelo'],
  BEL: ['Club Brugge', 'RSC Anderlecht', 'Anderlecht', 'Standard Lüttich', 'Standard Liège', 'KRC Genk', 'KAA Gent', 'Royal Antwerp FC', 'Union Saint-Gilloise', 'Cercle Brugge'],
  POR: ['SL Benfica', 'Benfica', 'FC Porto', 'Sporting CP', 'Sporting Lissabon', 'SC Braga', 'Vitória Guimarães', 'Boavista FC'],
  TUR: ['Galatasaray', 'Fenerbahçe', 'Beşiktaş', 'Trabzonspor', 'Başakşehir', 'İstanbul Başakşehir'],
  GRE: ['Olympiakos Piräus', 'Olympiacos', 'Panathinaikos', 'AEK Athen', 'PAOK Saloniki', 'PAOK', 'Aris Thessaloniki'],
  CRO: ['Dinamo Zagreb', 'GNK Dinamo Zagreb', 'HNK Hajduk Split', 'Hajduk Split', 'HNK Rijeka'],
  SRB: ['Roter Stern Belgrad', 'Crvena Zvezda', 'FK Crvena Zvezda', 'Partizan Belgrad', 'FK Partizan'],
  UKR: ['Schachtar Donezk', 'Shakhtar Donetsk', 'Dynamo Kiew', 'Dynamo Kyiv'],
  RUS: ['Zenit St. Petersburg', 'Spartak Moskau', 'Spartak Moscow', 'ZSKA Moskau', 'CSKA Moscow', 'Lokomotive Moskau', 'Lokomotiv Moscow', 'Dynamo Moskau'],
  CZE: ['Sparta Prag', 'AC Sparta Praha', 'Slavia Prag', 'SK Slavia Praha', 'Viktoria Pilsen', 'FC Viktoria Plzeň'],
  DEN: ['FC Kopenhagen', 'FC København', 'Brøndby IF', 'FC Midtjylland'],
  SWE: ['Malmö FF', 'AIK', 'Djurgårdens IF', 'IFK Göteborg', 'Hammarby IF'],
  NOR: ['Rosenborg BK', 'FK Bodø/Glimt', 'Molde FK'],
  POL: ['Legia Warschau', 'Legia Warszawa', 'Lech Posen', 'Lech Poznań', 'Wisła Kraków'],
  HUN: ['Ferencváros', 'Ferencvárosi TC'],
  ROU: ['FCSB', 'Steaua Bukarest', 'Dinamo Bukarest', 'CFR Cluj'],
  BUL: ['Ludogorez Rasgrad', 'Ludogorets Razgrad', 'ZSKA Sofia', 'Lewski Sofia'],
  ISR: ['Maccabi Tel Aviv', 'Maccabi Haifa', 'Hapoel Be’er Sheva'],
  CYP: ['APOEL Nikosia', 'APOEL', 'AC Omonia', 'Omonia Nikosia'],
};
