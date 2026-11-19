-- =====================================================================
-- 0025: Authentische Fußballwelt – fiktive Orientierungsvereine an den großen Standorten
-- (München, Dortmund, Hamburg, Gelsenkirchen, Madrid, Mailand …). Neue Welten erhalten sie bei der
-- Erstellung; bestehende Welten werden einmalig umbenannt: nur Name, Kürzel und Farben von KI-Vereinen,
-- nach Spielklasse und Reputation. IDs, Spieler, Tabellen und Spielstände bleiben unverändert.
-- Erzeugt mit: node scripts/gen-anchor-sql.mjs > supabase/migrations/20261123000025_club_names.sql
-- =====================================================================
create table if not exists public.fd_anchor_clubs (
  association_code char(3) not null,
  tier smallint,
  rank smallint not null,
  name text not null,
  short_name text not null,
  place text not null,
  primary_color text not null,
  secondary_color text not null,
  accent_color text not null
);
create unique index if not exists fd_anchor_clubs_key on public.fd_anchor_clubs(association_code, coalesce(tier, 0), rank);
alter table public.fd_anchor_clubs enable row level security;
delete from public.fd_anchor_clubs;
insert into public.fd_anchor_clubs(association_code, tier, rank, name, short_name, place, primary_color, secondary_color, accent_color) values
  ('GER', 1, 1, 'SC Isar München', 'ISM', 'München', '#C8102E', '#FFFFFF', '#0B2D5B'),
  ('GER', 1, 2, 'Westfalia Dortmund', 'WFD', 'Dortmund', '#F5C400', '#1B1B1B', '#FFFFFF'),
  ('GER', 1, 3, 'SV Rheinwerk Leverkusen', 'RWL', 'Leverkusen', '#E30613', '#1B1B1B', '#FFFFFF'),
  ('GER', 1, 4, 'FC Pleiße Leipzig', 'FPL', 'Leipzig', '#E4002B', '#FFFFFF', '#0A2240'),
  ('GER', 1, 5, 'Neckar SC Stuttgart', 'NSC', 'Stuttgart', '#FFFFFF', '#E32219', '#1B1B1B'),
  ('GER', 1, 6, 'SG Mainufer Frankfurt', 'SGM', 'Frankfurt', '#1B1B1B', '#E1000F', '#FFFFFF'),
  ('GER', 1, 7, 'SV Glückauf Gelsenkirchen', 'SVG', 'Gelsenkirchen', '#004D9D', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 8, 'Hanse SV Hamburg', 'HSH', 'Hamburg', '#0A3F8F', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 9, 'SC Weser Bremen', 'SCW', 'Bremen', '#1D9053', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 10, 'FC Niederrhein Mönchengladbach', 'FNM', 'Mönchengladbach', '#FFFFFF', '#1B1B1B', '#1E8C3A'),
  ('GER', 1, 11, 'SV Domstadt Köln', 'SDK', 'Köln', '#ED1C24', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 12, 'Spree SC Berlin', 'SSB', 'Berlin', '#005CA9', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 13, 'VfR Mittelland Wolfsburg', 'VMW', 'Wolfsburg', '#65B32E', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 14, 'FV Breisgau Freiburg', 'FVB', 'Freiburg', '#E2001A', '#1B1B1B', '#FFFFFF'),
  ('GER', 1, 15, 'SV Kraichgau Sinsheim', 'SVK', 'Sinsheim', '#1C63B7', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 16, 'SC Rheinhessen Mainz', 'SRM', 'Mainz', '#C3141E', '#FFFFFF', '#1B1B1B'),
  ('GER', 1, 17, 'FC Lech Augsburg', 'FLA', 'Augsburg', '#BA3733', '#46714D', '#FFFFFF'),
  ('GER', 1, 18, 'SV Wuhlheide Berlin', 'SWB', 'Berlin', '#D4011D', '#FFFFFF', '#F2C14E'),
  ('GER', 2, 1, 'SV Leine Hannover', 'SLH', 'Hannover', '#C8102E', '#1B1B1B', '#1E7A46'),
  ('GER', 2, 2, 'FC Rheinbogen Düsseldorf', 'FRD', 'Düsseldorf', '#DA251D', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 3, 'SV Betzenberg Kaiserslautern', 'SBK', 'Kaiserslautern', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 4, 'FC Pegnitz Nürnberg', 'FPN', 'Nürnberg', '#8C1C13', '#1B1B1B', '#FFFFFF'),
  ('GER', 2, 5, 'SV Hardtwald Karlsruhe', 'SHK', 'Karlsruhe', '#0A57A4', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 6, 'SC Ruhrtal Bochum', 'SRB', 'Bochum', '#005CA9', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 7, 'SC Kiez Hamburg', 'SKH', 'Hamburg', '#5A3A22', '#FFFFFF', '#C8102E'),
  ('GER', 2, 8, 'SV Förde Kiel', 'SFK', 'Kiel', '#0A3F8F', '#FFFFFF', '#C8102E'),
  ('GER', 2, 9, 'SC Woog Darmstadt', 'SWD', 'Darmstadt', '#004E9E', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 10, 'SC Senne Paderborn', 'SSP', 'Paderborn', '#003C8F', '#1B1B1B', '#FFFFFF'),
  ('GER', 2, 11, 'FC Rednitz Fürth', 'FRF', 'Fürth', '#1E7A46', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 12, 'SC Elbe Magdeburg', 'SEM', 'Magdeburg', '#0A57A4', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 13, 'SV Oker Braunschweig', 'SOB', 'Braunschweig', '#F5C400', '#0A3F8F', '#FFFFFF'),
  ('GER', 2, 14, 'FC Warnow Rostock', 'FWR', 'Rostock', '#0A3F8F', '#FFFFFF', '#C8102E'),
  ('GER', 2, 15, 'SG Elbflorenz Dresden', 'SED', 'Dresden', '#F5C400', '#1B1B1B', '#FFFFFF'),
  ('GER', 2, 16, 'SC Teutoburg Bielefeld', 'STB', 'Bielefeld', '#0A3F8F', '#FFFFFF', '#1B1B1B'),
  ('GER', 2, 17, 'SC Aasee Münster', 'SAM', 'Münster', '#1B1B1B', '#FFFFFF', '#1E7A46'),
  ('GER', 2, 18, 'SV Donau Regensburg', 'SDR', 'Regensburg', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 1, 'FC Saar Saarbrücken', 'FSS', 'Saarbrücken', '#0A3F8F', '#1B1B1B', '#FFFFFF'),
  ('GER', 3, 2, 'FC Kaiserstadt Aachen', 'FKA', 'Aachen', '#F5C400', '#1B1B1B', '#FFFFFF'),
  ('GER', 3, 3, 'SV Ruhrstahl Essen', 'SRE', 'Essen', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 4, 'FC Rheinhafen Duisburg', 'FRH', 'Duisburg', '#0A57A4', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 5, 'SV Quadrate Mannheim', 'SQM', 'Mannheim', '#0A3F8F', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 6, 'VfB Hase Osnabrück', 'VHO', 'Osnabrück', '#5B2C83', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 7, 'SV Taunus Wiesbaden', 'STW', 'Wiesbaden', '#C8102E', '#1B1B1B', '#FFFFFF'),
  ('GER', 3, 8, 'SC Donautor Ingolstadt', 'SDI', 'Ingolstadt', '#C8102E', '#1B1B1B', '#FFFFFF'),
  ('GER', 3, 9, 'FC Lausitz Cottbus', 'FLC', 'Cottbus', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 10, 'FV Donautal Ulm', 'FDU', 'Ulm', '#1B1B1B', '#FFFFFF', '#C8102E'),
  ('GER', 3, 11, 'SpVgg Hachinger Tal', 'SHT', 'Unterhaching', '#C8102E', '#0A3F8F', '#FFFFFF'),
  ('GER', 3, 12, 'FC Saale Halle', 'FSH', 'Halle', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 13, 'SV Domberg Erfurt', 'SDE', 'Erfurt', '#0A3F8F', '#FFFFFF', '#C8102E'),
  ('GER', 3, 14, 'SV Kernberge Jena', 'SKJ', 'Jena', '#0A3F8F', '#F5C400', '#FFFFFF'),
  ('GER', 3, 15, 'FC Chemnitztal', 'FCC', 'Chemnitz', '#6CACE4', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 16, 'FSV Mulde Zwickau', 'FMZ', 'Zwickau', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 17, 'VfB Hunte Oldenburg', 'VHU', 'Oldenburg', '#0A3F8F', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 18, 'SC Trave Lübeck', 'STL', 'Lübeck', '#1E7A46', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 19, 'FC Mainfranken Würzburg', 'FMW', 'Würzburg', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 20, 'SC Mainbogen Offenbach', 'SMO', 'Offenbach', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GER', 3, 21, 'SV Schacht Aue', 'SSA', 'Aue', '#5B2C83', '#FFFFFF', '#1B1B1B'),
  ('ENG', null, 1, 'Manchester Mariners', 'MMA', 'Manchester', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('ENG', null, 2, 'Liverpool Ramblers', 'LRA', 'Liverpool', '#C8102E', '#F5C400', '#FFFFFF'),
  ('ENG', null, 3, 'North London Corinthians', 'NLC', 'London', '#E30613', '#FFFFFF', '#0A3F8F'),
  ('ENG', null, 4, 'Manchester Victoria', 'MVI', 'Manchester', '#6CABDD', '#FFFFFF', '#1B1B1B'),
  ('ENG', null, 5, 'West London Swifts', 'WLS', 'London', '#034694', '#FFFFFF', '#1B1B1B'),
  ('ENG', null, 6, 'Newcastle Wayfarers', 'NWA', 'Newcastle', '#1B1B1B', '#FFFFFF', '#9AA0A6'),
  ('ENG', null, 7, 'Birmingham Lions', 'BLI', 'Birmingham', '#670E36', '#95BFE5', '#FFFFFF'),
  ('ESP', null, 1, 'Unión Castellana Madrid', 'UCM', 'Madrid', '#FFFFFF', '#1B1B1B', '#F2C14E'),
  ('ESP', null, 2, 'Mediterrani Barcelona', 'MDB', 'Barcelona', '#A50044', '#004D98', '#F5C400'),
  ('ESP', null, 3, 'Deportivo Manzanares Madrid', 'DMM', 'Madrid', '#CB3524', '#FFFFFF', '#272E61'),
  ('ESP', null, 4, 'Unión Giralda Sevilla', 'UGS', 'Sevilla', '#D71920', '#FFFFFF', '#1B1B1B'),
  ('ESP', null, 5, 'Deportivo Turia Valencia', 'DTV', 'Valencia', '#FFFFFF', '#EE3524', '#1B1B1B'),
  ('ESP', null, 6, 'Club Nervión Bilbao', 'CNB', 'Bilbao', '#EE2523', '#FFFFFF', '#1B1B1B'),
  ('ITA', null, 1, 'Virtus Navigli Milano', 'VMN', 'Milano', '#FB090B', '#1B1B1B', '#FFFFFF'),
  ('ITA', null, 2, 'Sforzesca Milano', 'SFM', 'Milano', '#0068A8', '#1B1B1B', '#FFFFFF'),
  ('ITA', null, 3, 'Polisportiva Mole Torino', 'PMT', 'Torino', '#1B1B1B', '#FFFFFF', '#F2C14E'),
  ('ITA', null, 4, 'Capitolina Roma', 'CPR', 'Roma', '#8E1F2F', '#F0BC42', '#FFFFFF'),
  ('ITA', null, 5, 'Unione Tevere Roma', 'UTR', 'Roma', '#87D8F7', '#FFFFFF', '#1B1B1B'),
  ('ITA', null, 6, 'Vesuvio Napoli', 'VEN', 'Napoli', '#12A0D7', '#FFFFFF', '#1B1B1B'),
  ('FRA', null, 1, 'Racing Seine Paris', 'RSP', 'Paris', '#004170', '#DA291C', '#FFFFFF'),
  ('FRA', null, 2, 'Union Vieux-Port Marseille', 'UVM', 'Marseille', '#2FAEE0', '#FFFFFF', '#1B1B1B'),
  ('FRA', null, 3, 'Lyon Confluence', 'LYC', 'Lyon', '#FFFFFF', '#DA001A', '#14387F'),
  ('FRA', null, 4, 'Lille Métropole SC', 'LMS', 'Lille', '#E01E13', '#FFFFFF', '#0A3F8F'),
  ('NED', null, 1, 'Amstel Sport Amsterdam', 'ASA', 'Amsterdam', '#D2122E', '#FFFFFF', '#1B1B1B'),
  ('NED', null, 2, 'Maasstad Rotterdam', 'MAR', 'Rotterdam', '#FFFFFF', '#E10600', '#1B1B1B'),
  ('NED', null, 3, 'Lichtstad Eindhoven', 'LIE', 'Eindhoven', '#ED1C24', '#FFFFFF', '#1B1B1B'),
  ('POR', null, 1, 'Desportivo Tejo Lisboa', 'DTL', 'Lisboa', '#E83030', '#FFFFFF', '#1B1B1B'),
  ('POR', null, 2, 'Alfama Lisboa', 'ALI', 'Lisboa', '#008057', '#FFFFFF', '#1B1B1B'),
  ('POR', null, 3, 'Ribeira Porto', 'RPO', 'Porto', '#00428C', '#FFFFFF', '#1B1B1B'),
  ('BEL', null, 1, 'Sporting Reien Brugge', 'SRG', 'Brugge', '#0A3F8F', '#1B1B1B', '#FFFFFF'),
  ('BEL', null, 2, 'Royal Zenne Bruxelles', 'RZB', 'Bruxelles', '#5B2C83', '#FFFFFF', '#1B1B1B'),
  ('TUR', null, 1, 'Boğaz İstanbul', 'BOI', 'İstanbul', '#A90432', '#FDB912', '#FFFFFF'),
  ('TUR', null, 2, 'Moda İstanbul Spor', 'MIS', 'İstanbul', '#FFED00', '#163962', '#FFFFFF'),
  ('TUR', null, 3, 'Ortaköy İstanbul', 'ORI', 'İstanbul', '#1B1B1B', '#FFFFFF', '#C8102E'),
  ('SCO', null, 1, 'Glasgow Clydesdale', 'GCL', 'Glasgow', '#16973B', '#FFFFFF', '#1B1B1B'),
  ('SCO', null, 2, 'Glasgow Wayfarers', 'GWA', 'Glasgow', '#1B458F', '#FFFFFF', '#C8102E'),
  ('AUT', null, 1, 'Wiener Donau SC', 'WDS', 'Wien', '#00663D', '#FFFFFF', '#1B1B1B'),
  ('AUT', null, 2, 'SV Prater Wien', 'SPW', 'Wien', '#5B2C83', '#FFFFFF', '#1B1B1B'),
  ('AUT', null, 3, 'Salzach Salzburg', 'SSZ', 'Salzburg', '#C8102E', '#FFFFFF', '#0A3F8F'),
  ('AUT', null, 4, 'SK Murinsel Graz', 'SMG', 'Graz', '#1B1B1B', '#FFFFFF', '#1E7A46'),
  ('SUI', null, 1, 'FC Rheinknie Basel', 'FRB', 'Basel', '#C8102E', '#0A3F8F', '#FFFFFF'),
  ('SUI', null, 2, 'SC Aare Bern', 'SAB', 'Bern', '#F5C400', '#1B1B1B', '#FFFFFF'),
  ('SUI', null, 3, 'Limmat Zürich', 'LZU', 'Zürich', '#FFFFFF', '#0A3F8F', '#1B1B1B'),
  ('GRE', null, 1, 'Attiki Athína', 'ATH', 'Athína', '#0A57A4', '#FFFFFF', '#1B1B1B'),
  ('GRE', null, 2, 'Limani Peiraiá', 'LMP', 'Peiraiá', '#C8102E', '#FFFFFF', '#1B1B1B'),
  ('GRE', null, 3, 'Thermaikos Thessaloníki', 'TTH', 'Thessaloníki', '#1B1B1B', '#FFFFFF', '#9AA0A6');

do $$
declare
  w record;
  r record;
  v_n integer := 0;
begin
  if exists (select 1 from public.fd_data_migrations where key = '0025_club_names') then return; end if;
  for w in select id, current_season_id from public.career_worlds loop
    for r in
      with ranked as (
        select c.id, c.association_code,
               case when c.association_code = 'GER' then public.fd_tier_of(c.id, w.current_season_id) end as tier,
               row_number() over (partition by c.association_code,
                 case when c.association_code = 'GER' then public.fd_tier_of(c.id, w.current_season_id) end
                 order by case when c.association_code = 'GER' then 0 else coalesce(c.level, 4) end, c.reputation desc, c.id) as rnk
        from public.clubs c
        where c.world_id = w.id and c.control = 'ai' and not coalesce(c.amateur, false)
      )
      select k.id, a.name, a.short_name, a.primary_color, a.secondary_color, a.accent_color
      from ranked k join public.fd_anchor_clubs a
        on a.association_code = k.association_code and a.rank = k.rnk and coalesce(a.tier, 0) = coalesce(case when k.association_code = 'GER' then k.tier end, 0)
      order by k.association_code, a.tier nulls first, a.rank
    loop
      -- nur wenn Name und Kürzel in der Welt frei sind (menschliche Vereine behalten ihre Namen)
      continue when exists (select 1 from public.clubs x where x.world_id = w.id and x.id <> r.id
                            and (x.name_normalized = public.normalize_name(r.name) or x.short_name_normalized = public.normalize_name(r.short_name)));
      update public.clubs set name = r.name, name_normalized = public.normalize_name(r.name),
        short_name = r.short_name, short_name_normalized = public.normalize_name(r.short_name) where id = r.id;
      update public.club_branding set primary_color = r.primary_color, secondary_color = r.secondary_color, accent_color = r.accent_color,
        crest = crest || jsonb_build_object('primary', r.primary_color, 'secondary', r.secondary_color, 'accent', r.accent_color, 'initials', r.short_name),
        kit = kit || jsonb_build_object('primary', r.primary_color, 'secondary', r.secondary_color)
      where club_id = r.id;
      v_n := v_n + 1;
    end loop;
  end loop;
  insert into public.fd_data_migrations(key, info) values ('0025_club_names', jsonb_build_object('renamed', v_n));
  raise notice 'Orientierungsvereine: % Vereine umbenannt', v_n;
end $$;
