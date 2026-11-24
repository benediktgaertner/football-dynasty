-- =====================================================================
-- Migration 0050: Fanartikel-Designs (Farben, Muster, Vereinslogo, Aufdruck)
--   * club_merch.design: individuelles Design je Produkt ('{}' = Vereinsfarben-Standard).
--   * fd_valid_merch_design(): Allowlist für Muster je Produktfamilie, Hex-Farben, Logo ja/nein, kurzer Aufdruck.
--   * merch_set_design(): nur eigener Verein, kostenlos – und OHNE Wirkung auf Nachfrage, Preis, Kosten oder Erlöse
--     (die Abrechnung fd_slot_economy liest das Design nie; Test G13 prüft das).
--   * merch_overview liefert Design und Familie mit.
-- Idempotent, ohne Datenverlust.
-- =====================================================================

alter table public.merch_products add column if not exists family text;
update public.merch_products set family = case when key in ('home_jersey', 'away_jersey', 'special_jersey') then 'jersey' else key end where family is null;
alter table public.club_merch add column if not exists design jsonb not null default '{}'::jsonb;

create or replace function public.fd_valid_merch_design(p_family text, p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('pattern', 'c1', 'c2', 'c3', 'crest', 'text'))
    and (p ->> 'pattern' is null or p ->> 'pattern' = any (case p_family
         when 'jersey' then array['solid', 'stripes', 'hoops', 'halves', 'quarters', 'sash', 'chevron', 'pinstripe', 'diagonal']
         when 'scarf' then array['stripes', 'bands', 'solid', 'checker', 'bar']
         when 'cap' then array['solid', 'panels', 'stripe', 'twotone', 'bill']
         when 'flag' then array['horizontal', 'vertical', 'diagonal', 'cross', 'border', 'solid']
         else array[]::text[] end))
    and (p ->> 'c1' is null or public.is_hex_color(p ->> 'c1'))
    and (p ->> 'c2' is null or public.is_hex_color(p ->> 'c2'))
    and (p ->> 'c3' is null or public.is_hex_color(p ->> 'c3'))
    and (p -> 'crest' is null or jsonb_typeof(p -> 'crest') = 'boolean')
    and (p ->> 'text' is null or (jsonb_typeof(p -> 'text') = 'string' and p ->> 'text' ~ '^[A-Za-zÄÖÜäöüß0-9 .!&-]{0,16}$'));
$$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'club_merch_design_size') then
    alter table public.club_merch add constraint club_merch_design_size check (octet_length(design::text) <= 400);
  end if;
end $$;

create or replace function public.merch_set_design(p_world uuid, p_product text, p_design jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_club uuid := public.fd_require_team(p_world);
  v_family text;
begin
  select family into v_family from public.merch_products where key = p_product;
  if v_family is null then raise exception 'Unbekanntes Produkt.' using errcode = 'P0001', hint = 'merch_product'; end if;
  if p_design is null or not public.fd_valid_merch_design(v_family, p_design) then
    raise exception 'Ungültiges Design.' using errcode = 'P0001', hint = 'merch_design';
  end if;
  insert into public.club_merch(club_id, product_key, price, stock, design)
  select v_club, p_product, base_price, 400, p_design from public.merch_products where key = p_product
  on conflict (club_id, product_key) do update set design = excluded.design, updated_at = now();
end;
$$;

-- merch_overview: Design und Familie je Produkt ergänzen (Rest unverändert)
do $$
declare v_def text; v_new text;
  v_old constant text := E'jsonb_build_object(''key'', mp.key, ''label'', mp.label,';
  v_rep constant text := E'jsonb_build_object(''key'', mp.key, ''family'', mp.family, ''design'', cm.design, ''label'', mp.label,';
begin
  select pg_get_functiondef('public.merch_overview(uuid)'::regprocedure) into v_def;
  if position('''family'', mp.family' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then raise exception 'Patch merch_overview fehlgeschlagen'; end if;
  v_new := replace(v_def, v_old, v_rep);
  execute v_new;
end $$;

revoke execute on function public.merch_set_design(uuid, text, jsonb) from public, anon;
grant execute on function public.merch_set_design(uuid, text, jsonb) to authenticated;
revoke execute on function public.fd_valid_merch_design(text, jsonb) from public, anon;
grant execute on function public.fd_valid_merch_design(text, jsonb) to authenticated;
notify pgrst, 'reload schema';
