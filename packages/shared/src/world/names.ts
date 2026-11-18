import type { Region } from '../domain.js';

/**
 * D2: Namensdaten je Nationalität. Vor- und Nachnamen sind gängige Namen des
 * jeweiligen Landes und werden zufällig kombiniert (fiktive Spieler).
 * `weight` steuert die Häufigkeit innerhalb der Region.
 */
export interface NationalityNames {
  code: string;
  region: Region;
  weight: number;
  first: readonly string[];
  last: readonly string[];
}

const n = (code: string, region: Region, weight: number, first: string, last: string): NationalityNames => ({
  code,
  region,
  weight,
  first: first.split(' '),
  last: last.split(' '),
});

export const NATIONALITIES: readonly NationalityNames[] = [
  // ---------------- Europa ----------------
  n('GER', 'europe', 5, 'Lukas Jonas Leon Finn Niklas Tim Jan Felix Moritz Paul Max Elias Noah Ben Julian Tobias Florian Marvin Dennis Kevin Sebastian Philipp Fabian Malte Lennart Jannik Robin Timo Sven Nico',
    'Becker Hoffmann Schäfer Koch Richter Klein Wolf Schröder Neumann Schwarz Zimmermann Braun Krüger Hofmann Hartmann Lange Werner Krause Lehmann Köhler Herrmann Walter Kaiser Fuchs Peters Möller Jung Vogel Busch Brandt Kühn Pohl Arnold Lorenz Seidel Engel Ludwig Kramer Voigt Sauer'),
  n('ENG', 'europe', 3, 'Jack Harry Oliver George Charlie Jacob Alfie Thomas James Joshua Callum Ryan Lewis Kieran Connor Mason Reece Jordan Luke Danny',
    'Smith Jones Taylor Brown Wilson Evans Walker Wright Robinson Thompson Hughes Edwards Green Hall Wood Harris Clarke Turner Hill Cooper Ward Morris Baker Collins Mitchell Barnes Fletcher Holmes'),
  n('ESP', 'europe', 3, 'Alejandro Pablo Daniel Adrián Álvaro Javier Sergio Diego Iván Marcos Rubén Hugo Mario Raúl Carlos Iker Unai Borja Gonzalo Íñigo',
    'García Fernández González Rodríguez López Martínez Sánchez Pérez Gómez Martín Jiménez Ruiz Hernández Díaz Moreno Álvarez Romero Navarro Torres Domínguez Gil Vázquez Serrano Blanco Molina Ortega Castro Rubio'),
  n('ITA', 'europe', 3, 'Lorenzo Matteo Alessandro Andrea Gabriele Riccardo Tommaso Federico Davide Simone Luca Marco Nicolò Francesco Stefano Giacomo Edoardo Pietro Daniele Emanuele',
    'Rossi Russo Ferrari Esposito Bianchi Romano Colombo Ricci Marino Greco Bruno Gallo Conti De Luca Costa Giordano Mancini Rizzo Lombardi Moretti Barbieri Fontana Santoro Mariani Rinaldi Caruso Ferrara Galli'),
  n('FRA', 'europe', 3, 'Lucas Hugo Louis Théo Mathis Nathan Enzo Clément Maxime Antoine Baptiste Quentin Romain Julien Alexandre Bastien Kylian Yanis Mathéo Rayan',
    'Martin Bernard Dubois Thomas Robert Richard Petit Durand Leroy Moreau Simon Laurent Lefebvre Michel Garcia David Bertrand Roux Vincent Fournier Morel Girard André Mercier Dupont Lambert Bonnet François'),
  n('POR', 'europe', 2, 'João Rodrigo Martim Tomás Duarte Gonçalo Afonso Diogo Rafael Tiago Pedro Bruno Nuno Rui Hugo Vítor André Ricardo',
    'Silva Santos Ferreira Pereira Oliveira Costa Rodrigues Martins Jesus Sousa Fernandes Gonçalves Gomes Lopes Marques Alves Almeida Ribeiro Pinto Carvalho Teixeira Moreira Correia Mendes'),
  n('NED', 'europe', 2, 'Daan Sem Lucas Milan Levi Luuk Thijs Jesse Bram Stijn Ruben Joris Teun Sven Niels Jasper Wout Thomas',
    'de Jong Jansen de Vries van den Berg van Dijk Bakker Visser Smit Meijer de Boer Mulder de Groot Bos Vos Peters Hendriks van Leeuwen Dekker Brouwer de Wit Dijkstra Smits de Graaf'),
  n('BEL', 'europe', 1.5, 'Arthur Louis Jules Victor Mathis Lars Seppe Wout Robbe Arne Siebe Thibault Maxime Cédric',
    'Peeters Janssens Maes Jacobs Mertens Willems Claes Goossens Wouters De Smet Dubois Lambert Dupont Hermans Vermeulen Michiels Lemmens Leclercq'),
  n('AUT', 'europe', 1.5, 'Lukas David Tobias Simon Florian Elias Jakob Fabian Maximilian Raphael Stefan Dominik Manuel Christoph',
    'Gruber Huber Bauer Wagner Pichler Steiner Moser Mayer Hofer Leitner Berger Fuchs Eder Fischer Schmid Winkler Weber Schwarz Lang Reiter'),
  n('SUI', 'europe', 1, 'Noah Luca Leon Nico Gian Jan Levin Silvan Fabian Cédric Yannick Remo Dario Marco',
    'Müller Meier Schmid Keller Weber Huber Schneider Meyer Steiner Fischer Gerber Brunner Baumann Frei Zimmermann Moser Widmer Graf'),
  n('CRO', 'europe', 1.5, 'Luka Ivan Josip Marko Mateo Ante Petar Filip Karlo Dario Nikola Domagoj Tin Bruno',
    'Horvat Kovačević Babić Marić Jurić Novak Kovačić Knežević Vuković Marković Petrović Matić Tomić Pavlović Božić Perić Blažević Grgić'),
  n('SRB', 'europe', 1.5, 'Nikola Stefan Lazar Luka Marko Aleksa Filip Uroš Miloš Dušan Nemanja Vuk Strahinja Đorđe',
    'Jovanović Petrović Nikolić Marković Đorđević Stojanović Ilić Stanković Pavlović Milošević Popović Živković Todorović Ristić Lukić Savić'),
  n('POL', 'europe', 1.5, 'Jakub Kacper Szymon Filip Mateusz Bartosz Michał Kamil Piotr Paweł Dawid Krzysztof Tomasz Łukasz',
    'Nowak Kowalski Wiśniewski Wójcik Kowalczyk Kamiński Lewandowicz Zieliński Szymański Woźniak Dąbrowski Kozłowski Jankowski Mazur Krawczyk Piotrowski Grabowski Pawlak'),
  n('CZE', 'europe', 1, 'Jakub Jan Tomáš Matěj Adam Ondřej Lukáš Vojtěch Filip David Petr Martin',
    'Novák Svoboda Novotný Dvořák Černý Procházka Kučera Veselý Horák Němec Pokorný Marek Pospíšil Hájek Král Jelínek'),
  n('DEN', 'europe', 1, 'William Noah Oscar Lucas Victor Malthe Emil Frederik Mads Rasmus Mikkel Kasper Jonas Anders',
    'Jensen Nielsen Hansen Pedersen Andersen Christensen Larsen Sørensen Rasmussen Jørgensen Petersen Madsen Kristensen Olsen Thomsen Poulsen'),
  n('SWE', 'europe', 1, 'Oscar Elias Hugo William Liam Viktor Axel Filip Erik Anton Gustav Isak Ludvig Albin',
    'Andersson Johansson Karlsson Nilsson Eriksson Larsson Olsson Persson Svensson Gustafsson Pettersson Lindberg Lindqvist Berglund Holm Sandberg'),
  n('NOR', 'europe', 1, 'Jakob Emil Noah Oliver Filip William Lucas Henrik Sander Magnus Sindre Tobias Eirik Vegard',
    'Hansen Johansen Olsen Larsen Andersen Pedersen Nilsen Kristiansen Jensen Karlsen Haugen Bakken Solberg Moen Berg Lund'),
  n('TUR', 'europe', 1.5, 'Yusuf Emir Mehmet Mustafa Ahmet Ali Burak Emre Kerem Arda Kaan Berk Oğuz Hakan Cenk Serkan',
    'Yılmaz Kaya Demir Şahin Çelik Yıldız Yıldırım Öztürk Aydın Özdemir Arslan Doğan Kılıç Aslan Çetin Kara Koç Kurt Özkan Şimşek'),
  n('GRE', 'europe', 1, 'Giorgos Dimitris Nikos Kostas Giannis Christos Panagiotis Vasilis Thanasis Michalis Stelios Alexandros',
    'Papadopoulos Papadakis Georgiou Nikolaidis Dimitriou Konstantinidis Ioannou Vasileiou Karagiannis Antoniou Christodoulou Pappas Oikonomou Makris'),
  n('SCO', 'europe', 1, 'Callum Lewis Ross Euan Fraser Craig Scott Kyle Jamie Stuart Calum Grant Murray Blair',
    'Campbell Stewart MacDonald Robertson Thomson Anderson Scott Murray Reid Clark Ross Paterson Fraser McLean Hamilton Graham Kerr Duncan'),
  n('UKR', 'europe', 1, 'Oleksandr Andriy Dmytro Maksym Artem Mykola Bohdan Vladyslav Taras Yaroslav Denys Serhiy',
    'Shevchenko Kovalenko Bondarenko Tkachenko Kravchenko Oliynyk Shevchuk Polishchuk Boyko Melnyk Lysenko Marchenko Rudenko Savchenko'),
  n('HUN', 'europe', 1, 'Bence Máté Levente Dominik Ádám Dániel Márk Balázs Gergő Péter Zsolt Norbert',
    'Nagy Kovács Tóth Szabó Horváth Varga Kiss Molnár Németh Farkas Balogh Papp Takács Juhász Lakatos Mészáros'),
  n('IRL', 'europe', 0.7, 'Conor Seán Cian Darragh Oisín Fionn Eoin Rory Ciarán Aidan Shane Niall',
    'Murphy Kelly Byrne Ryan O’Brien Walsh O’Connor McCarthy Doyle Gallagher Kennedy Lynch Murray Quinn Moore Brennan'),
  // ---------------- Südamerika ----------------
  n('BRA', 'south_america', 4, 'Gabriel Lucas Mateus Gustavo Felipe Rafael Thiago Vinícius Matheus Leonardo Bruno Caio Diego Rodrigo Igor Renan Wesley Danilo Éverton Douglas',
    'Silva Santos Oliveira Souza Lima Pereira Ferreira Costa Rodrigues Almeida Nascimento Carvalho Araújo Ribeiro Gomes Martins Barbosa Rocha Moura Cardoso Teixeira Cavalcanti Monteiro Freitas'),
  n('ARG', 'south_america', 3, 'Santiago Mateo Joaquín Tomás Facundo Nicolás Lautaro Agustín Franco Matías Gonzalo Ezequiel Leandro Maximiliano Thiago Julián',
    'González Rodríguez Gómez Fernández López Díaz Martínez Pérez Romero Sosa Álvarez Torres Ruiz Ramírez Flores Benítez Acosta Medina Herrera Suárez Aguirre Giménez'),
  n('URU', 'south_america', 1.5, 'Santiago Mateo Facundo Nicolás Agustín Rodrigo Federico Martín Gastón Diego Sebastián Matías',
    'Rodríguez González Fernández Pereira López Martínez Silva Sosa Suárez Díaz Cabrera Núñez Olivera Méndez Píriz Correa'),
  n('COL', 'south_america', 1.5, 'Juan Santiago Andrés Sebastián Camilo Daniel Felipe Luis Carlos Jorge Mateo Esteban Óscar Diego',
    'Rodríguez Gómez González Martínez García López Hernández Sánchez Ramírez Díaz Moreno Muñoz Rojas Valencia Ortiz Castro Vargas Arango'),
  n('CHI', 'south_america', 1, 'Benjamín Vicente Martín Matías Joaquín Agustín Cristóbal Diego Felipe Ignacio Claudio Esteban',
    'González Muñoz Rojas Díaz Pérez Soto Contreras Silva Martínez Sepúlveda Morales Rodríguez Fuentes Araya Valenzuela Tapia'),
  n('ECU', 'south_america', 1, 'Kevin Jordy Ángel Christian Byron Jeremy Gonzalo Alan Carlos Luis Wilmer Édison Fernando Jonathan',
    'Valencia Caicedo Quiñónez Preciado Castillo Cortez Arboleda Mina Ortiz Vera Bravo Zambrano Cedeño Salazar Ponce Andrade'),
  n('PAR', 'south_america', 1, 'Miguel Julio Ángel Gustavo Antonio Ramón Óscar Hernán Matías Fabián Rodrigo Diego',
    'Benítez Giménez Martínez González Romero Cáceres Ortiz Cardozo Villalba Ayala Duarte Ferreira Báez Ruiz'),
  n('PER', 'south_america', 0.5, 'Renato Christian Luis André Pedro Sergio Diego Miguel Jorge Bruno',
    'Flores Quispe Huamán Ramos Rojas Chávez Vargas Mendoza Castillo Paredes Salazar Córdova'),
  n('VEN', 'south_america', 0.5, 'José Luis Carlos Daniel Andrés Ronald Jesús Miguel Ricardo Eduardo',
    'Rodríguez Hernández Pérez García Martínez Silva Rojas Méndez Blanco Suárez Medina Castillo'),
  // ---------------- Afrika ----------------
  n('NGA', 'africa', 2, 'Chidi Emeka Victor Samuel Kelechi Moses Ikechukwu Tochukwu Chukwuemeka Uche Femi Ademola Babatunde Tunde Segun Obinna',
    'Okafor Okonkwo Adeyemi Eze Nwosu Obi Balogun Ogunleye Chukwu Onyekachi Ibrahim Akinola Olatunji Nwankwo Adebayo Okeke Uzor Bello'),
  n('SEN', 'africa', 2, 'Moussa Ibrahima Cheikh Mamadou Abdoulaye Pape Youssouf Lamine Habib Ousmane Modou Alioune Babacar Serigne',
    'Diallo Ndiaye Diop Sarr Fall Faye Gueye Sow Mbaye Cissé Ba Thiam Camara Dieng Seck Niang Diouf Kane'),
  n('CIV', 'africa', 2, 'Yao Kouassi Serge Franck Simon Eric Nicolas Ibrahim Sébastien Arnaud Christian Ange Hervé',
    'Koné Kouamé Traoré Bamba Coulibaly Touré Konan Kouadio N’Guessan Yao Diomandé Yapi Ouattara Soro Kacou Gnagne'),
  n('GHA', 'africa', 1.5, 'Kwame Kofi Kwabena Yaw Kwesi Kojo Daniel Joseph Emmanuel Samuel Richard Isaac Prince Ebenezer',
    'Mensah Owusu Boateng Asante Agyemang Osei Addo Danso Amoah Appiah Darko Ofori Quaye Badu Antwi Frimpong'),
  n('CMR', 'africa', 1.5, 'Samuel Vincent Joël Christian Georges Pierre Martin Jean Paul Serge Hervé Fabrice Landry',
    'Mbarga Nkoulou Fotso Tchoumi Ngono Essomba Abena Mvondo Ngassa Talla Kamga Djoumessi Essama Owona Atangana Ndzana'),
  n('MAR', 'africa', 2, 'Youssef Achraf Hakim Sofiane Ilias Amine Bilal Zakaria Ayoub Hamza Anass Mehdi Reda Omar',
    'El Amrani Benali Alaoui Idrissi Bennani Tazi Berrada Chraibi El Idrissi Ouazzani Lahlou Fassi Tahiri Benjelloun Sebti Kettani'),
  n('ALG', 'africa', 1.5, 'Ismaël Sofiane Yacine Islam Rachid Karim Adem Ramy Houssem Nabil Walid Anis',
    'Belkacem Benali Bouziane Haddad Mansouri Saidi Brahimi Cherif Hamidi Meziane Boudiaf Khelifi Rahmani Larbi Zitouni Djebbar'),
  n('EGY', 'africa', 1, 'Mohamed Ahmed Mahmoud Omar Mostafa Karim Amr Tarek Hossam Youssef Khaled Hany',
    'Hassan Ibrahim Abdelaziz Mostafa El Sayed Fathy Mahmoud Abdallah Salem Farouk Nasser Shawky Ragab Saad'),
  n('MLI', 'africa', 1.5, 'Amadou Moussa Yves Adama Mohamed Kalifa Boubakar Ibrahim Lassana Abdoulaye Oumar Seydou',
    'Traoré Keïta Diarra Coulibaly Sissoko Haïdara Doumbia Koné Diakité Dembélé Sangaré Touré Maïga Sidibé'),
  // ---------------- Asien ----------------
  n('JPN', 'asia', 3, 'Haruto Sota Yuto Kaito Ren Yuki Riku Hayato Kenta Shota Takumi Kazuki Ryota Sho Naoki Hiroto',
    'Tanaka Suzuki Takahashi Watanabe Ito Yamamoto Nakamura Kobayashi Kato Yoshida Yamada Sasaki Yamaguchi Matsumoto Inoue Kimura Hayashi Shimizu Mori Ikeda'),
  n('KOR', 'asia', 3, 'Min-jun Seo-jun Do-yoon Ji-ho Jun-seo Hyun-woo Ji-hoon Sung-min Tae-yang Dong-hyun Jae-won Young-ho',
    'Kim Lee Park Choi Jung Kang Cho Yoon Jang Lim Han Oh Seo Shin Kwon Hwang Ahn Song'),
  n('IRN', 'asia', 1.5, 'Mehdi Ali Saman Alireza Milad Ehsan Karim Morteza Saeid Ramin Hossein Reza',
    'Hosseini Karimi Rezaei Mohammadi Ahmadi Moradi Jafari Rahimi Sadeghi Ghasemi Kazemi Bagheri Heidari Akbari'),
  n('KSA', 'asia', 1, 'Salem Mohammed Firas Abdullah Saud Sultan Yasser Hassan Nawaf Riyadh Ali Saleh',
    'Al-Harbi Al-Qahtani Al-Otaibi Al-Ghamdi Al-Zahrani Al-Shamrani Al-Mutairi Al-Dosari Al-Anazi Al-Juhani Al-Subaie Al-Rashidi'),
  n('CHN', 'asia', 1, 'Wei Lei Hao Jun Yang Tao Bin Long Peng Xin Chao Zhen',
    'Wang Li Zhang Liu Chen Yang Huang Zhao Wu Zhou Xu Sun Ma Zhu Hu Guo'),
  n('UZB', 'asia', 1, 'Otabek Rustam Jasur Sherzod Ulugbek Bekzod Sardor Akmal Dilshod Aziz Bobur Javlon',
    'Karimov Rakhimov Tursunov Yusupov Abdullaev Saidov Nazarov Ismoilov Kholmatov Ergashev Mirzaev Sobirov'),
  // ---------------- Nord- und Mittelamerika ----------------
  n('USA', 'north_central_america', 3, 'Tyler Christian Chris Josh Matt Zack Caden Jordan Brandon Cole Ethan Austin Logan Ryan Dylan Kyle',
    'Johnson Williams Miller Davis Anderson Jackson White Harris Martin Thompson Moore Allen Young King Robinson Carter Mitchell Parker Reed Hayes'),
  n('MEX', 'north_central_america', 3, 'Raúl Héctor Alexis Santiago César Jesús Luis Uriel Erick Julián Diego Jorge Alan Rodrigo',
    'Hernández García Martínez López González Pérez Sánchez Ramírez Flores Rivera Gutiérrez Vega Álvarez Ochoa Reyes Chávez Mendoza Aguilar'),
  n('CAN', 'north_central_america', 1.5, 'Jonathan Stephen Liam Jacob Owen Noah Ethan Lucas Connor Nathan Ryan Tristan',
    'Tremblay Gagnon Roy Côté Bouchard Gauthier Morin Lavoie Fortin Wilson Campbell Stewart MacDonald Clarke'),
  n('CRC', 'north_central_america', 1, 'Joel Bryan Francisco Kendall Óscar Andrés José Luis Daniel Esteban',
    'Ruiz Calvo Duarte Vargas Mora Jiménez Rojas Solano Araya Chaves Alfaro Quesada'),
  n('JAM', 'north_central_america', 1, 'Leon Damion Shamar Kasey Ethan Dexter Andre Kemar Romario Tyrone',
    'Brown Williams Campbell Thompson Clarke Grant Henry Morgan Reid Wright Bennett Gordon'),
  // ---------------- Ozeanien ----------------
  n('AUS', 'oceania', 3, 'Jack Lachlan Mitchell Riley Connor Cameron Liam Josh Lucas Hayden Brodie Tom',
    'Smith Jones Williams Brown Wilson Taylor Johnson White Martin Anderson Thompson Walker Kelly Ryan'),
  n('NZL', 'oceania', 1, 'Liam Jack Oliver James Ben Sam Tama Nikau Callum Hamish',
    'Smith Wilson Williams Brown Taylor Anderson Thompson Walker Ngata Parata Tane Wiremu'),
];

/**
 * Bekannte reale Profis, die durch zufällige Kombination häufiger Namen entstehen könnten.
 * Der Generator würfelt neu, wenn ein Name hier steht (D1: fiktive Spieler).
 */
export const FAMOUS_PLAYER_NAMES: ReadonlySet<string> = new Set([
  'Timo Werner', 'Julian Brandt', 'Robin Koch', 'Jonas Hofmann', 'Callum Wilson', 'Harry Wilson', 'Danny Ward',
  'Raúl García', 'Javier Martínez', 'Sergio Gómez', 'Andrea Conti', 'Lorenzo Colombo', 'Diogo Costa', 'Bruno Fernandes',
  'Nuno Mendes', 'Pedro Gonçalves', 'Rafael Silva', 'André Silva', 'Ricardo Pereira', 'Luuk de Jong', 'Mateo Kovačić',
  'Piotr Zieliński', 'Jakub Kamiński', 'Burak Yılmaz', 'Oğuz Aydın', 'Andriy Shevchenko', 'Silvan Widmer', 'Ross Stewart',
  'Thiago Silva', 'Danilo Pereira', 'Diego Costa', 'Douglas Costa', 'Lucas Lima', 'Éverton Ribeiro', 'Gabriel Barbosa',
  'Lautaro Martínez', 'Julián Álvarez', 'Nicolás González', 'Facundo Medina', 'Luis Chávez', 'Jorge Sánchez', 'Alexis Vega',
  'Erick Gutiérrez', 'Hiroki Ito', 'Junya Ito', 'Thomas Müller', 'Lucas Hernández', 'Matías Fernández', 'Gonzalo Martínez',
]);

/** Häufige deutsche Vornamen für KI-Trainer (K1: jeder KI-Verein hat einen eigenen Manager). */
export const MANAGER_FIRST = 'Thomas Michael Andreas Stefan Frank Markus Jürgen Uwe Ralf Dirk Holger Matthias Bernd Torsten Carsten Olaf Jens Sascha Rainer Heiko'.split(' ');
export const MANAGER_LAST = 'Brenner Wendt Kessler Lindner Vogt Haas Seifert Böhm Ziegler Kuhn Sommer Graf Beck Frank Albrecht Winter Thiele Pfeiffer Reuter Kruse Martens Schenk Ebert Böttcher'.split(' ');

export function nationalitiesByRegion(region: Region): NationalityNames[] {
  return NATIONALITIES.filter((x) => x.region === region);
}
