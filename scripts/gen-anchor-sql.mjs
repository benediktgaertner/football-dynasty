// Erzeugt Migration 0025 (Orientierungsvereine für bestehende Welten) aus packages/shared/src/world/anchors.ts
import { ANCHOR_CLUBS, LEAGUE_SIZE } from '../packages/shared/dist/index.js';
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const rows = [];
for (const [code, list] of Object.entries(ANCHOR_CLUBS)) {
  list.forEach((a, i) => {
    // Deutschland: Rang je Spielklasse (18 je Liga), sonst Gesamtrang
    const tier = code === 'GER' ? Math.min(3, Math.floor(i / LEAGUE_SIZE) + 1) : null;
    const rank = code === 'GER' ? i - (tier - 1) * LEAGUE_SIZE + 1 : i + 1;
    rows.push(`  (${q(code)}, ${tier ?? 'null'}, ${rank}, ${q(a.name)}, ${q(a.short)}, ${q(a.place)}, ${q(a.colors[0])}, ${q(a.colors[1])}, ${q(a.colors[2])})`);
  });
}
process.stdout.write(`-- =====================================================================
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
${rows.join(',\n')};

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
`);
