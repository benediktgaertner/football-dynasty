-- =====================================================================
-- 0023: Dynamische Spielerentwicklung (G3–G6) – ein serverseitiges System für alle Vereine
--
--  * Entwicklungspunkte (XP) je Attribut aus Zusatztraining und Pflichtspielleistung
--    (Note, Tore, Vorlagen, Zweikämpfe, Ballgewinne, Paraden). Multiplikatoren: Alter,
--    verborgenes Potenzial und Spielintelligenz – identisch für menschliche und KI-Vereine.
--  * Erreicht die XP eines Attributs dessen Kosten, steigt es sofort um 1; die Gesamtstärke
--    (OVR) und der Marktwert werden neu berechnet. Die Match Engine liest dieselben Attribute.
--  * KI-Vereine trainieren jede Woche bis zu 5 Spieler (eine Einheit je Spieler, −20 Fitness).
--  * Verschlechterungen nur beim Saisonwechsel (Alterung), getrennt dokumentiert.
--  * Jahresbericht je Verein und Saison (player_season_development), auch für KI-Vereine.
--  * Schutz vor doppelter XP-Vergabe: match_player_stats.dev_xp und training_sessions.dev_xp
--    werden atomar gesetzt; nur der erste Aufruf schreibt XP gut.
-- Referenzmodell und Kalibrierung: packages/shared/src/rules/development.ts, docs/DEVELOPMENT.md
-- =====================================================================

-- ---------------------------------------------------------------------
-- Datenmodell
-- ---------------------------------------------------------------------
create table if not exists public.player_xp (
  player_id uuid primary key references public.players(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  xp jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.player_xp enable row level security;

create table if not exists public.player_season_development (
  player_id uuid not null references public.players(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  club_id uuid references public.clubs(id) on delete set null,
  age smallint not null,
  position text not null,
  ovr_start smallint not null,
  attrs_start jsonb not null,
  ovr_end smallint,
  ovr_after_aging smallint,
  training_xp numeric(10, 2) not null default 0,
  match_xp numeric(10, 2) not null default 0,
  training_sessions integer not null default 0,
  matches integer not null default 0,
  gains jsonb not null default '{}'::jsonb,
  declines jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (player_id, season_id)
);
create index if not exists psd_club_season on public.player_season_development(club_id, season_id);
alter table public.player_season_development enable row level security;

create table if not exists public.ai_training_log (
  club_id uuid not null references public.clubs(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  week_no smallint not null,
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  trainees integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (club_id, season_id, week_no)
);
alter table public.ai_training_log enable row level security;

-- Alterung beim Saisonwechsel: in Häppchen (große Europa-Welten), jeder Spieler genau einmal
alter table public.player_season_development add column if not exists aging_done boolean not null default false;
create table if not exists public.dev_aging_jobs (
  world_id uuid not null references public.career_worlds(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  primary key (world_id, season_id)
);
alter table public.dev_aging_jobs enable row level security;

-- Idempotenz: einmal gutgeschriebene XP sind markiert
alter table public.match_player_stats add column if not exists dev_xp numeric(8, 3);
alter table public.training_sessions add column if not exists dev_xp numeric(8, 3);

-- ---------------------------------------------------------------------
-- Formeln (identisch zu packages/shared/src/rules/development.ts)
-- ---------------------------------------------------------------------
create or replace function public.fd_dev_weights(p_kind text, p_pos text, out keys text[], out ws float8[])
language sql immutable set search_path = '' as $$
  select k, w from (values

    ('GK', array['reflexes', 'handling', 'positioning', 'oneOnOne', 'commandOfArea', 'reactionSpeed', 'distribution', 'kicking', 'gameIntelligence', 'mentality']::text[], array[0.2, 0.15, 0.17, 0.12, 0.1, 0.1, 0.06, 0.04, 0.03, 0.03]::float8[]),
    ('CB', array['defending', 'physical', 'heading', 'gameIntelligence', 'pace', 'passing', 'mentality', 'stamina']::text[], array[0.3, 0.17, 0.15, 0.12, 0.08, 0.08, 0.06, 0.04]::float8[]),
    ('LB', array['defending', 'pace', 'stamina', 'crossing', 'passing', 'physical', 'gameIntelligence', 'dribbling', 'mentality']::text[], array[0.22, 0.17, 0.12, 0.12, 0.1, 0.08, 0.1, 0.05, 0.04]::float8[]),
    ('RB', array['defending', 'pace', 'stamina', 'crossing', 'passing', 'physical', 'gameIntelligence', 'dribbling', 'mentality']::text[], array[0.22, 0.17, 0.12, 0.12, 0.1, 0.08, 0.1, 0.05, 0.04]::float8[]),
    ('LWB', array['pace', 'crossing', 'stamina', 'defending', 'dribbling', 'passing', 'gameIntelligence', 'physical', 'mentality']::text[], array[0.18, 0.15, 0.14, 0.15, 0.1, 0.1, 0.1, 0.04, 0.04]::float8[]),
    ('RWB', array['pace', 'crossing', 'stamina', 'defending', 'dribbling', 'passing', 'gameIntelligence', 'physical', 'mentality']::text[], array[0.18, 0.15, 0.14, 0.15, 0.1, 0.1, 0.1, 0.04, 0.04]::float8[]),
    ('CDM', array['defending', 'passing', 'gameIntelligence', 'physical', 'stamina', 'mentality', 'heading', 'dribbling']::text[], array[0.24, 0.18, 0.18, 0.12, 0.1, 0.08, 0.05, 0.05]::float8[]),
    ('CM', array['passing', 'gameIntelligence', 'dribbling', 'stamina', 'defending', 'shooting', 'physical', 'mentality', 'pace']::text[], array[0.24, 0.18, 0.12, 0.12, 0.08, 0.08, 0.08, 0.06, 0.04]::float8[]),
    ('CAM', array['passing', 'dribbling', 'gameIntelligence', 'shooting', 'pace', 'mentality', 'freeKicks', 'stamina']::text[], array[0.24, 0.2, 0.18, 0.16, 0.08, 0.06, 0.04, 0.04]::float8[]),
    ('LM', array['pace', 'crossing', 'dribbling', 'passing', 'stamina', 'gameIntelligence', 'shooting', 'defending', 'mentality']::text[], array[0.16, 0.16, 0.16, 0.15, 0.1, 0.1, 0.08, 0.05, 0.04]::float8[]),
    ('RM', array['pace', 'crossing', 'dribbling', 'passing', 'stamina', 'gameIntelligence', 'shooting', 'defending', 'mentality']::text[], array[0.16, 0.16, 0.16, 0.15, 0.1, 0.1, 0.08, 0.05, 0.04]::float8[]),
    ('LW', array['pace', 'dribbling', 'shooting', 'crossing', 'passing', 'gameIntelligence', 'mentality', 'stamina']::text[], array[0.22, 0.22, 0.15, 0.12, 0.1, 0.1, 0.05, 0.04]::float8[]),
    ('RW', array['pace', 'dribbling', 'shooting', 'crossing', 'passing', 'gameIntelligence', 'mentality', 'stamina']::text[], array[0.22, 0.22, 0.15, 0.12, 0.1, 0.1, 0.05, 0.04]::float8[]),
    ('CF', array['shooting', 'dribbling', 'passing', 'gameIntelligence', 'pace', 'heading', 'physical', 'mentality']::text[], array[0.24, 0.16, 0.14, 0.16, 0.12, 0.06, 0.06, 0.06]::float8[]),
    ('ST', array['shooting', 'pace', 'heading', 'physical', 'gameIntelligence', 'dribbling', 'mentality']::text[], array[0.3, 0.15, 0.13, 0.12, 0.12, 0.1, 0.08]::float8[])
  ) t(pos, k, w) where t.pos = case when p_kind = 'goalkeeper' then 'GK' else p_pos end;
$$;

create or replace function public.fd_dev_training_shares(p_kind text, p_pos text, p_focus text)
returns jsonb language sql immutable set search_path = '' as $$
  select s from (values

    ('GK', 'offense', '{"distribution":0.5333333333333332,"kicking":0.4666666666666666}'::jsonb),
    ('GK', 'defense', '{"reflexes":0.339622641509434,"positioning":0.30566037735849055,"oneOnOne":0.16603773584905662,"handling":0.18867924528301888}'::jsonb),
    ('GK', 'technique', '{"handling":0.5263157894736842,"distribution":0.2526315789473684,"kicking":0.22105263157894733}'::jsonb),
    ('GK', 'physical', '{"reactionSpeed":0.5555555555555556,"commandOfArea":0.3333333333333333,"stamina":0.11111111111111113}'::jsonb),
    ('GK', 'tactics', '{"positioning":0.5806451612903226,"gameIntelligence":0.2096774193548387,"mentality":0.2096774193548387}'::jsonb),
    ('GK', 'set_pieces', '{"penalties":0.25000000000000006,"commandOfArea":0.75}'::jsonb),
    ('CB', 'offense', '{"shooting":0.2692307692307692,"dribbling":0.19230769230769232,"crossing":0.15384615384615388,"heading":0.38461538461538464}'::jsonb),
    ('CB', 'defense', '{"defending":0.5678233438485804,"heading":0.15772870662460567,"physical":0.17034700315457413,"gameIntelligence":0.10410094637223974}'::jsonb),
    ('CB', 'technique', '{"passing":0.4921875,"dribbling":0.234375,"shooting":0.15625000000000003,"crossing":0.1171875}'::jsonb),
    ('CB', 'physical', '{"pace":0.3157894736842105,"physical":0.47368421052631576,"stamina":0.21052631578947367}'::jsonb),
    ('CB', 'tactics', '{"gameIntelligence":0.6142131979695432,"mentality":0.20304568527918782,"passing":0.182741116751269}'::jsonb),
    ('CB', 'set_pieces', '{"freeKicks":0.3,"corners":0.25,"penalties":0.25,"crossing":0.20000000000000004}'::jsonb),
    ('LB', 'offense', '{"shooting":0.2564102564102564,"dribbling":0.27472527472527475,"crossing":0.32234432234432236,"heading":0.14652014652014653}'::jsonb),
    ('LB', 'defense', '{"defending":0.6260869565217391,"heading":0.08695652173913043,"physical":0.15652173913043474,"gameIntelligence":0.13043478260869562}'::jsonb),
    ('LB', 'technique', '{"passing":0.4166666666666666,"dribbling":0.26785714285714285,"shooting":0.11904761904761907,"crossing":0.19642857142857142}'::jsonb),
    ('LB', 'physical', '{"pace":0.4228187919463087,"physical":0.28187919463087246,"stamina":0.2953020134228188}'::jsonb),
    ('LB', 'tactics', '{"gameIntelligence":0.5945945945945946,"mentality":0.18918918918918917,"passing":0.21621621621621623}'::jsonb),
    ('LB', 'set_pieces', '{"freeKicks":0.24193548387096772,"corners":0.20161290322580647,"penalties":0.20161290322580647,"crossing":0.3548387096774194}'::jsonb),
    ('RB', 'offense', '{"shooting":0.2564102564102564,"dribbling":0.27472527472527475,"crossing":0.32234432234432236,"heading":0.14652014652014653}'::jsonb),
    ('RB', 'defense', '{"defending":0.6260869565217391,"heading":0.08695652173913043,"physical":0.15652173913043474,"gameIntelligence":0.13043478260869562}'::jsonb),
    ('RB', 'technique', '{"passing":0.4166666666666666,"dribbling":0.26785714285714285,"shooting":0.11904761904761907,"crossing":0.19642857142857142}'::jsonb),
    ('RB', 'physical', '{"pace":0.4228187919463087,"physical":0.28187919463087246,"stamina":0.2953020134228188}'::jsonb),
    ('RB', 'tactics', '{"gameIntelligence":0.5945945945945946,"mentality":0.18918918918918917,"passing":0.21621621621621623}'::jsonb),
    ('RB', 'set_pieces', '{"freeKicks":0.24193548387096772,"corners":0.20161290322580647,"penalties":0.20161290322580647,"crossing":0.3548387096774194}'::jsonb),
    ('LWB', 'offense', '{"shooting":0.22580645161290316,"dribbling":0.32258064516129026,"crossing":0.32258064516129026,"heading":0.12903225806451613}'::jsonb),
    ('LWB', 'defense', '{"defending":0.5905511811023623,"heading":0.10498687664041996,"physical":0.14698162729658795,"gameIntelligence":0.15748031496062992}'::jsonb),
    ('LWB', 'technique', '{"passing":0.37333333333333324,"dribbling":0.31999999999999995,"shooting":0.10666666666666667,"crossing":0.19999999999999996}'::jsonb),
    ('LWB', 'physical', '{"pace":0.4474885844748858,"physical":0.2237442922374429,"stamina":0.3287671232876712}'::jsonb),
    ('LWB', 'tactics', '{"gameIntelligence":0.5945945945945946,"mentality":0.18918918918918917,"passing":0.21621621621621623}'::jsonb),
    ('LWB', 'set_pieces', '{"freeKicks":0.23076923076923075,"corners":0.19230769230769232,"penalties":0.19230769230769232,"crossing":0.38461538461538464}'::jsonb),
    ('RWB', 'offense', '{"shooting":0.22580645161290316,"dribbling":0.32258064516129026,"crossing":0.32258064516129026,"heading":0.12903225806451613}'::jsonb),
    ('RWB', 'defense', '{"defending":0.5905511811023623,"heading":0.10498687664041996,"physical":0.14698162729658795,"gameIntelligence":0.15748031496062992}'::jsonb),
    ('RWB', 'technique', '{"passing":0.37333333333333324,"dribbling":0.31999999999999995,"shooting":0.10666666666666667,"crossing":0.19999999999999996}'::jsonb),
    ('RWB', 'physical', '{"pace":0.4474885844748858,"physical":0.2237442922374429,"stamina":0.3287671232876712}'::jsonb),
    ('RWB', 'tactics', '{"gameIntelligence":0.5945945945945946,"mentality":0.18918918918918917,"passing":0.21621621621621623}'::jsonb),
    ('RWB', 'set_pieces', '{"freeKicks":0.23076923076923075,"corners":0.19230769230769232,"penalties":0.19230769230769232,"crossing":0.38461538461538464}'::jsonb),
    ('CDM', 'offense', '{"shooting":0.28571428571428564,"dribbling":0.30612244897959184,"crossing":0.16326530612244897,"heading":0.24489795918367346}'::jsonb),
    ('CDM', 'defense', '{"defending":0.5687732342007434,"heading":0.11152416356877325,"physical":0.16356877323420074,"gameIntelligence":0.15613382899628253}'::jsonb),
    ('CDM', 'technique', '{"passing":0.5505617977528089,"dribbling":0.2528089887640449,"shooting":0.11235955056179775,"crossing":0.08426966292134828}'::jsonb),
    ('CDM', 'physical', '{"pace":0.20348837209302326,"physical":0.4476744186046512,"stamina":0.3488372093023256}'::jsonb),
    ('CDM', 'tactics', '{"gameIntelligence":0.603921568627451,"mentality":0.1764705882352941,"passing":0.21960784313725493}'::jsonb),
    ('CDM', 'set_pieces', '{"freeKicks":0.3,"corners":0.25,"penalties":0.25,"crossing":0.20000000000000004}'::jsonb),
    ('CM', 'offense', '{"shooting":0.3987341772151898,"dribbling":0.3481012658227847,"crossing":0.12658227848101267,"heading":0.12658227848101267}'::jsonb),
    ('CM', 'defense', '{"defending":0.4525139664804469,"heading":0.111731843575419,"physical":0.20111731843575414,"gameIntelligence":0.23463687150837986}'::jsonb),
    ('CM', 'technique', '{"passing":0.5042372881355932,"dribbling":0.2796610169491526,"shooting":0.15254237288135594,"crossing":0.0635593220338983}'::jsonb),
    ('CM', 'physical', '{"pace":0.2752808988764045,"physical":0.35393258426966295,"stamina":0.3707865168539326}'::jsonb),
    ('CM', 'tactics', '{"gameIntelligence":0.5877862595419848,"mentality":0.15267175572519084,"passing":0.25954198473282436}'::jsonb),
    ('CM', 'set_pieces', '{"freeKicks":0.3,"corners":0.25,"penalties":0.25,"crossing":0.20000000000000004}'::jsonb),
    ('CAM', 'offense', '{"shooting":0.44174757281553395,"dribbling":0.3640776699029126,"crossing":0.09708737864077671,"heading":0.09708737864077671}'::jsonb),
    ('CAM', 'defense', '{"defending":0.35433070866141736,"heading":0.15748031496062995,"physical":0.15748031496062995,"gameIntelligence":0.33070866141732286}'::jsonb),
    ('CAM', 'technique', '{"passing":0.431159420289855,"dribbling":0.32608695652173914,"shooting":0.18840579710144928,"crossing":0.05434782608695651}'::jsonb),
    ('CAM', 'physical', '{"pace":0.44999999999999996,"physical":0.24999999999999994,"stamina":0.3}'::jsonb),
    ('CAM', 'tactics', '{"gameIntelligence":0.5877862595419848,"mentality":0.15267175572519084,"passing":0.25954198473282436}'::jsonb),
    ('CAM', 'set_pieces', '{"freeKicks":0.375,"corners":0.22321428571428573,"penalties":0.22321428571428573,"crossing":0.1785714285714286}'::jsonb),
    ('LM', 'offense', '{"shooting":0.315,"dribbling":0.325,"crossing":0.26,"heading":0.10000000000000002}'::jsonb),
    ('LM', 'defense', '{"defending":0.490909090909091,"heading":0.14545454545454548,"physical":0.14545454545454548,"gameIntelligence":0.21818181818181814}'::jsonb),
    ('LM', 'technique', '{"passing":0.3638253638253638,"dribbling":0.32432432432432434,"shooting":0.14968814968814967,"crossing":0.16216216216216217}'::jsonb),
    ('LM', 'physical', '{"pace":0.489247311827957,"physical":0.18817204301075266,"stamina":0.3225806451612903}'::jsonb),
    ('LM', 'tactics', '{"gameIntelligence":0.5641025641025642,"mentality":0.1794871794871795,"passing":0.25641025641025644}'::jsonb),
    ('LM', 'set_pieces', '{"freeKicks":0.22727272727272727,"corners":0.1893939393939394,"penalties":0.1893939393939394,"crossing":0.393939393939394}'::jsonb),
    ('RM', 'offense', '{"shooting":0.315,"dribbling":0.325,"crossing":0.26,"heading":0.10000000000000002}'::jsonb),
    ('RM', 'defense', '{"defending":0.490909090909091,"heading":0.14545454545454548,"physical":0.14545454545454548,"gameIntelligence":0.21818181818181814}'::jsonb),
    ('RM', 'technique', '{"passing":0.3638253638253638,"dribbling":0.32432432432432434,"shooting":0.14968814968814967,"crossing":0.16216216216216217}'::jsonb),
    ('RM', 'physical', '{"pace":0.489247311827957,"physical":0.18817204301075266,"stamina":0.3225806451612903}'::jsonb),
    ('RM', 'tactics', '{"gameIntelligence":0.5641025641025642,"mentality":0.1794871794871795,"passing":0.25641025641025644}'::jsonb),
    ('RM', 'set_pieces', '{"freeKicks":0.22727272727272727,"corners":0.1893939393939394,"penalties":0.1893939393939394,"crossing":0.393939393939394}'::jsonb),
    ('LW', 'offense', '{"shooting":0.3779697624190065,"dribbling":0.3455723542116631,"crossing":0.19006479481641472,"heading":0.08639308855291579}'::jsonb),
    ('LW', 'defense', '{"defending":0.391304347826087,"heading":0.1739130434782609,"physical":0.1739130434782609,"gameIntelligence":0.2608695652173913}'::jsonb),
    ('LW', 'technique', '{"passing":0.28112449799196787,"dribbling":0.38554216867469887,"shooting":0.20080321285140565,"crossing":0.13253012048192772}'::jsonb),
    ('LW', 'physical', '{"pace":0.5925925925925926,"physical":0.18518518518518517,"stamina":0.22222222222222224}'::jsonb),
    ('LW', 'tactics', '{"gameIntelligence":0.5866666666666667,"mentality":0.2,"passing":0.21333333333333335}'::jsonb),
    ('LW', 'set_pieces', '{"freeKicks":0.24193548387096772,"corners":0.20161290322580647,"penalties":0.20161290322580647,"crossing":0.3548387096774194}'::jsonb),
    ('RW', 'offense', '{"shooting":0.3779697624190065,"dribbling":0.3455723542116631,"crossing":0.19006479481641472,"heading":0.08639308855291579}'::jsonb),
    ('RW', 'defense', '{"defending":0.391304347826087,"heading":0.1739130434782609,"physical":0.1739130434782609,"gameIntelligence":0.2608695652173913}'::jsonb),
    ('RW', 'technique', '{"passing":0.28112449799196787,"dribbling":0.38554216867469887,"shooting":0.20080321285140565,"crossing":0.13253012048192772}'::jsonb),
    ('RW', 'physical', '{"pace":0.5925925925925926,"physical":0.18518518518518517,"stamina":0.22222222222222224}'::jsonb),
    ('RW', 'tactics', '{"gameIntelligence":0.5866666666666667,"mentality":0.2,"passing":0.21333333333333335}'::jsonb),
    ('RW', 'set_pieces', '{"freeKicks":0.24193548387096772,"corners":0.20161290322580647,"penalties":0.20161290322580647,"crossing":0.3548387096774194}'::jsonb),
    ('CF', 'offense', '{"shooting":0.5042372881355931,"dribbling":0.2754237288135593,"crossing":0.08474576271186442,"heading":0.13559322033898305}'::jsonb),
    ('CF', 'defense', '{"defending":0.30405405405405406,"heading":0.2162162162162162,"physical":0.2162162162162162,"gameIntelligence":0.2635135135135135}'::jsonb),
    ('CF', 'technique', '{"passing":0.34285714285714286,"dribbling":0.3183673469387755,"shooting":0.2775510204081632,"crossing":0.061224489795918366}'::jsonb),
    ('CF', 'physical', '{"pace":0.4723926380368098,"physical":0.3435582822085889,"stamina":0.18404907975460122}'::jsonb),
    ('CF', 'tactics', '{"gameIntelligence":0.6190476190476191,"mentality":0.17316017316017313,"passing":0.20779220779220778}'::jsonb),
    ('CF', 'set_pieces', '{"freeKicks":0.3,"corners":0.25,"penalties":0.25,"crossing":0.20000000000000004}'::jsonb),
    ('ST', 'offense', '{"shooting":0.5468749999999999,"dribbling":0.1953125,"crossing":0.07812500000000001,"heading":0.17968750000000003}'::jsonb),
    ('ST', 'defense', '{"defending":0.26785714285714285,"heading":0.27380952380952384,"physical":0.2619047619047619,"gameIntelligence":0.19642857142857142}'::jsonb),
    ('ST', 'technique', '{"passing":0.18421052631578946,"dribbling":0.3157894736842105,"shooting":0.42105263157894746,"crossing":0.07894736842105263}'::jsonb),
    ('ST', 'physical', '{"pace":0.4498714652956298,"physical":0.39588688946015427,"stamina":0.15424164524421594}'::jsonb),
    ('ST', 'tactics', '{"gameIntelligence":0.6505376344086022,"mentality":0.24193548387096772,"passing":0.10752688172043012}'::jsonb),
    ('ST', 'set_pieces', '{"freeKicks":0.3,"corners":0.25,"penalties":0.25,"crossing":0.20000000000000004}'::jsonb)
  ) t(pos, focus, s) where t.pos = case when p_kind = 'goalkeeper' then 'GK' else p_pos end and t.focus = p_focus;
$$;

create or replace function public.fd_dev_decline_weight(p_key text)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce(('{"pace":1.7,"stamina":1.5,"physical":1.3,"reactionSpeed":1.3,"reflexes":1.2,"dribbling":0.8,"shooting":0.7,"heading":0.8,"defending":0.7,"crossing":0.6,"passing":0.5,"oneOnOne":0.8,"handling":0.7,"commandOfArea":0.6,"kicking":0.5,"distribution":0.4,"positioning":0.4,"freeKicks":0.3,"corners":0.3,"penalties":0.3,"throwIns":0.4,"gameIntelligence":0.15,"mentality":0.15}'::jsonb ->> p_key)::numeric, 0.5);
$$;

create or replace function public.fd_dev_age_factor(p_age integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_age <= 19 then 1.6 when p_age <= 21 then 1.4 when p_age <= 23 then 1.2 when p_age <= 26 then 1.0
              when p_age <= 29 then 0.6 when p_age <= 32 then 0.3 else 0.15 end;
$$;

create or replace function public.fd_dev_headroom_factor(p_overall integer, p_potential integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_potential - p_overall >= 5 then 1.0 when p_potential - p_overall >= 1 then 0.4 + 0.12 * (p_potential - p_overall) else 0.1 end;
$$;

create or replace function public.fd_dev_intelligence_factor(p_gi numeric)
returns numeric language sql immutable set search_path = '' as $$
  select greatest(0.8, least(1.15, 0.9 + (coalesce(p_gi, 60) - 60) * 0.006));
$$;

create or replace function public.fd_dev_multiplier(p_age integer, p_overall integer, p_potential integer, p_gi numeric)
returns numeric language sql immutable set search_path = '' as $$
  select public.fd_dev_age_factor(p_age) * public.fd_dev_headroom_factor(p_overall, p_potential) * public.fd_dev_intelligence_factor(p_gi);
$$;

create or replace function public.fd_dev_cost(p_value integer)
returns numeric language sql immutable set search_path = '' as $$
  select 3 + greatest(0, p_value - 50) * 0.1;
$$;

-- Gesamtstärke aus Attributen – gleiche Reihenfolge und Gleitkommarechnung wie outfieldOverall/goalkeeperOverall
create or replace function public.fd_overall(p_kind text, p_pos text, p_attrs jsonb)
returns integer language sql immutable set search_path = '' as $$
  -- Summe in derselben Reihenfolge wie in TypeScript (Gleitkomma), dann Math.round = floor(x + 0,5)
  select floor(sum((p_attrs ->> u.k)::float8 * u.w order by u.i) / sum(u.w order by u.i) + 0.5)::integer
  from public.fd_dev_weights(p_kind, p_pos) d, unnest(d.keys, d.ws) with ordinality as u(k, w, i);
$$;

-- Marktwert (wie marketValue in economy.ts): Stützpunkte logarithmisch interpoliert × Altersfaktor
create or replace function public.fd_market_value(p_overall integer, p_age integer)
returns bigint language plpgsql immutable set search_path = '' as $$
declare
  a integer[] := array[65, 70, 74, 76, 78, 80, 83];
  m float8[] := array[0.8, 2.6, 5.8, 8.4, 12.6, 20.5, 39.2];
  i integer := 1;
  t float8;
  v_mio float8;
  v_base float8;
  v_f float8;
begin
  if p_overall <= a[1] then i := 1;
  elsif p_overall >= a[7] then i := 6;
  else
    while p_overall > a[i + 1] loop i := i + 1; end loop;
  end if;
  t := (p_overall - a[i])::float8 / (a[i + 1] - a[i]);
  v_mio := exp(ln(m[i]) + t * (ln(m[i + 1]) - ln(m[i])));
  v_base := floor(v_mio * 1000000 / 10000 + 0.5) * 10000;
  v_f := case when p_age <= 22 then 1.07 when p_age <= 27 then 1.0 when p_age <= 31 then 0.93 else 0.85 end;
  return (floor(v_base * v_f / 10000 + 0.5) * 10000)::bigint;
end;
$$;

-- jsonb-Werte addieren / skalieren
create or replace function public.fd_jsonb_add(a jsonb, b jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select k, sum(v) as v from (
      select key k, value::numeric v from jsonb_each_text(coalesce(a, '{}'::jsonb))
      union all select key, value::numeric from jsonb_each_text(coalesce(b, '{}'::jsonb))) x
    group by k) y;
$$;

create or replace function public.fd_jsonb_scale(a jsonb, f numeric)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, round(value::numeric * f, 4)), '{}'::jsonb) from jsonb_each_text(coalesce(a, '{}'::jsonb));
$$;

-- XP aus einer Pflichtspielleistung je Attribut (vor Multiplikatoren), siehe matchXp
create or replace function public.fd_dev_match_xp(p_kind text, p_pos text, p_minutes integer, p_rating numeric,
  p_goals integer, p_assists integer, p_tackles integer, p_interceptions integer, p_saves integer)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  w record;
  v_perf numeric;
  v_out jsonb := '{}'::jsonb;
  i integer;
begin
  if coalesce(p_minutes, 0) <= 0 then return v_out; end if;
  v_perf := least(1, p_minutes / 90.0) * (0.25 + 1.2 * greatest(0, coalesce(p_rating, 6) - 6));
  select * into w from public.fd_dev_weights(p_kind, p_pos);
  for i in 1 .. cardinality(w.keys) loop
    v_out := v_out || jsonb_build_object(w.keys[i], v_perf * w.ws[i]::numeric);
  end loop;
  if p_kind = 'goalkeeper' then
    v_out := public.fd_jsonb_add(v_out, jsonb_build_object('reflexes', coalesce(p_saves, 0) * 0.15 * 0.5,
      'positioning', coalesce(p_saves, 0) * 0.15 * 0.3, 'handling', coalesce(p_saves, 0) * 0.15 * 0.2));
  else
    v_out := public.fd_jsonb_add(v_out, jsonb_build_object('shooting', coalesce(p_goals, 0) * 0.6, 'passing', coalesce(p_assists, 0) * 0.5,
      'defending', coalesce(p_tackles, 0) * 0.08, 'gameIntelligence', coalesce(p_interceptions, 0) * 0.08));
  end if;
  return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(v_out) where value::text::numeric > 0);
end;
$$;

-- ---------------------------------------------------------------------
-- XP gutschreiben und in Attribute umwandeln (einziger Schreibpfad für Verbesserungen)
-- ---------------------------------------------------------------------
create or replace function public.fd_dev_grant(p_player uuid, p_gain jsonb, p_kind text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_p public.players;
  v_pa public.player_attributes;
  v_season uuid;
  v_xp jsonb;
  v_attrs jsonb;
  v_gains jsonb := '{}'::jsonb;
  v_total numeric := 0;
  v_new integer;
  k text;
  v numeric;
  x numeric;
  cur integer;
begin
  select * into v_p from public.players where id = p_player for update;
  if not found or v_p.retired then return null; end if;
  select * into v_pa from public.player_attributes where player_id = p_player for update;
  if not found then return null; end if;
  select current_season_id into v_season from public.career_worlds where id = v_p.world_id;
  if v_season is not null then
    insert into public.player_season_development(player_id, season_id, world_id, club_id, age, position, ovr_start, attrs_start)
    values (p_player, v_season, v_p.world_id, v_p.club_id, v_p.age, v_p.main_position, v_p.overall, v_pa.attributes)
    on conflict (player_id, season_id) do nothing;
  end if;
  select xp into v_xp from public.player_xp where player_id = p_player for update;
  v_xp := coalesce(v_xp, '{}'::jsonb);
  v_attrs := v_pa.attributes;
  for k, v in select key, value::numeric from jsonb_each_text(coalesce(p_gain, '{}'::jsonb)) loop
    if not (v_attrs ? k) or v <= 0 then continue; end if;
    v_total := v_total + v;
    x := coalesce((v_xp ->> k)::numeric, 0) + v;
    cur := (v_attrs ->> k)::integer;
    while cur < 99 and x >= public.fd_dev_cost(cur) loop
      x := x - public.fd_dev_cost(cur);
      cur := cur + 1;
      v_gains := v_gains || jsonb_build_object(k, coalesce((v_gains ->> k)::integer, 0) + 1);
    end loop;
    if cur >= 99 then x := 0; end if;
    v_xp := v_xp || jsonb_build_object(k, round(x, 4));
    v_attrs := v_attrs || jsonb_build_object(k, cur);
  end loop;
  insert into public.player_xp(player_id, world_id, xp) values (p_player, v_p.world_id, v_xp)
  on conflict (player_id) do update set xp = excluded.xp, updated_at = now();
  v_new := v_p.overall;
  if v_gains <> '{}'::jsonb then
    update public.player_attributes set attributes = v_attrs, updated_at = now() where player_id = p_player;
    v_new := coalesce(public.fd_overall(v_pa.kind, v_p.main_position::text, v_attrs), v_p.overall);
    if v_new > v_p.overall then
      update public.players set overall = v_new, market_value = public.fd_market_value(v_new, v_p.age) where id = p_player;
      if v_season is not null then
        insert into public.player_development(world_id, player_id, season_id, kind, overall_before, overall_after, attribute_changes)
        values (v_p.world_id, p_player, v_season, 'in_season_improvement', v_p.overall, v_new, v_gains);
      end if;
    else
      v_new := v_p.overall; -- Gesamtstärke sinkt in der Saison nie (G5)
    end if;
  end if;
  if v_season is not null then
    update public.player_season_development set
      training_xp = training_xp + case when p_kind = 'training' then v_total else 0 end,
      match_xp = match_xp + case when p_kind = 'match' then v_total else 0 end,
      training_sessions = training_sessions + (p_kind = 'training')::int,
      matches = matches + (p_kind = 'match')::int,
      gains = public.fd_jsonb_add(gains, v_gains),
      club_id = coalesce(v_p.club_id, club_id),
      updated_at = now()
    where player_id = p_player and season_id = v_season;
  end if;
  return jsonb_build_object('xp', round(v_total, 2), 'gains', v_gains, 'ovr_before', v_p.overall, 'ovr_after', v_new);
end;
$$;

-- Zusatztraining auswerten (einmalig je Einheit)
create or replace function public.fd_dev_train(p_session bigint)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  s public.training_sessions;
  v_p public.players;
  v_pa public.player_attributes;
  v_pot integer;
  v_m numeric;
  v_gain jsonb;
  v_res jsonb;
begin
  select * into s from public.training_sessions where id = p_session and dev_xp is null for update;
  if not found then return null; end if;
  select * into v_p from public.players where id = s.player_id;
  select * into v_pa from public.player_attributes where player_id = s.player_id;
  select coalesce(h.potential, v_p.overall) into v_pot from public.player_hidden h where h.player_id = s.player_id;
  v_m := public.fd_dev_multiplier(v_p.age, v_p.overall, coalesce(v_pot, v_p.overall), (v_pa.attributes ->> 'gameIntelligence')::numeric);
  v_gain := public.fd_jsonb_scale(public.fd_dev_training_shares(v_pa.kind, v_p.main_position::text, s.focus), 1.6 * v_m);
  v_res := public.fd_dev_grant(s.player_id, v_gain, 'training');
  update public.training_sessions set dev_xp = coalesce((v_res ->> 'xp')::numeric, 0) where id = p_session;
  return v_res;
end;
$$;

-- Pflichtspiel auswerten (einmalig je Spieler und Partie; Testspiele zählen nicht)
create or replace function public.fd_dev_after_match(p_fixture uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_res jsonb;
  v_n integer := 0;
begin
  if (select c.kind::text from public.fixtures f join public.competitions c on c.id = f.competition_id where f.id = p_fixture) = 'friendly' then
    return 0;
  end if;
  for r in
    select ms.player_id, ms.minutes, ms.rating, ms.goals, ms.assists, ms.tackles_won, ms.interceptions, ms.saves,
           p.age, p.overall, p.main_position, pa.kind, pa.attributes, coalesce(h.potential, p.overall) as pot
    from public.match_player_stats ms
    join public.players p on p.id = ms.player_id
    join public.player_attributes pa on pa.player_id = p.id
    left join public.player_hidden h on h.player_id = p.id
    where ms.fixture_id = p_fixture and ms.dev_xp is null and coalesce(ms.minutes, 0) > 0
    order by ms.player_id
    for update of ms
  loop
    v_res := public.fd_dev_grant(r.player_id,
      public.fd_jsonb_scale(public.fd_dev_match_xp(r.kind, r.main_position::text, r.minutes, r.rating, r.goals, r.assists, r.tackles_won, r.interceptions, r.saves),
        public.fd_dev_multiplier(r.age, r.overall, r.pot, (r.attributes ->> 'gameIntelligence')::numeric)),
      'match');
    update public.match_player_stats set dev_xp = coalesce((v_res ->> 'xp')::numeric, 0) where fixture_id = p_fixture and player_id = r.player_id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- KI-Vereine: gleiche Trainingsregeln (max. 5 Spieler je Woche, 1 Einheit je Spieler, −20 Fitness)
-- ---------------------------------------------------------------------
create or replace function public.fd_ai_focus(p_pos text)
returns text language sql immutable set search_path = '' as $$
  select case when p_pos in ('GK', 'CB', 'CDM') then 'defense'
              when p_pos in ('LB', 'RB', 'LWB', 'RWB') then 'physical'
              when p_pos in ('CM', 'CAM', 'LM', 'RM') then 'technique'
              else 'offense' end;
$$;

-- Bearbeitet bis zu p_limit KI-Vereine der laufenden Woche; gibt die Zahl der noch offenen Vereine zurück
create or replace function public.fd_ai_training_batch(p_world uuid, p_limit integer default 40)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  c record;
  pl record;
  v_n integer;
  v_sid bigint;
  v_date date;
begin
  select * into v_w from public.career_worlds where id = p_world;
  if v_w.status::text not in ('preseason', 'season') or v_w.current_season_id is null then return 0; end if;
  v_date := coalesce(v_w.current_date_in_world, current_date);
  for c in
    select cl.id from public.clubs cl
    where cl.world_id = p_world and cl.control = 'ai'
      and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week)
    -- Vereine im laufenden Spielbetrieb zuerst
    order by exists (select 1 from public.competition_entries e join public.competitions co on co.id = e.competition_id
                     where e.club_id = cl.id and co.season_id = v_w.current_season_id) desc, cl.id
    limit p_limit
  loop
    v_n := 0;
    for pl in
      select p.id, p.main_position from public.players p
      join public.player_attributes pa on pa.player_id = p.id
      left join public.player_hidden h on h.player_id = p.id
      where p.club_id = c.id and not p.retired and p.fitness >= 80
        and not exists (select 1 from public.injuries i where i.player_id = p.id and v_date between i.starts_on and i.ends_on)
        and not exists (select 1 from public.training_sessions t where t.player_id = p.id and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week)
      -- Wer am meisten profitiert (jung, Luft zum Potenzial, lernfähig), trainiert zuerst
      order by public.fd_dev_multiplier(p.age, p.overall, coalesce(h.potential, p.overall), (pa.attributes ->> 'gameIntelligence')::numeric) desc, p.id
      limit greatest(0, 5 - (select count(*) from public.training_sessions t where t.club_id = c.id and t.season_id = v_w.current_season_id and t.week_no = v_w.current_week))
    loop
      insert into public.training_sessions(world_id, club_id, season_id, week_no, player_id, focus, training_date)
      values (p_world, c.id, v_w.current_season_id, v_w.current_week, pl.id, public.fd_ai_focus(pl.main_position::text), v_date)
      on conflict do nothing
      returning id into v_sid;
      if v_sid is null then continue; end if;
      perform public.fd_dev_train(v_sid);
      update public.players set fitness = greatest(0, fitness - 20) where id = pl.id;
      update public.player_hidden set development_points = development_points + coalesce((select dev_xp from public.training_sessions where id = v_sid), 0) where player_id = pl.id;
      v_n := v_n + 1;
      v_sid := null;
    end loop;
    insert into public.ai_training_log(club_id, season_id, week_no, world_id, trainees) values (c.id, v_w.current_season_id, v_w.current_week, p_world, v_n)
    on conflict do nothing;
  end loop;
  return (select count(*) from public.clubs cl where cl.world_id = p_world and cl.control = 'ai'
          and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = v_w.current_season_id and l.week_no = v_w.current_week));
end;
$$;

-- ---------------------------------------------------------------------
-- Saisonwechsel: Bilanz schließen, danach Alterung (nur hier sinken Attribute)
-- ---------------------------------------------------------------------
create or replace function public.fd_dev_decline_base(p_age integer)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_age <= 28 then 0 when p_age = 29 then 0.3 when p_age = 30 then 0.6 when p_age = 31 then 1.0
              when p_age = 32 then 1.4 when p_age = 33 then 1.9 when p_age = 34 then 2.4 else 3 + 0.5 * (p_age - 35) end;
$$;

-- Verlust je Attribut (negative Werte); u ∈ [0,1) = individueller Faktor, Rundung je Attribut über den Hash
-- (gleicher Hash wie fd_hash01, hier eingebettet: die Funktion läuft beim Saisonwechsel für tausende Spieler)
create or replace function public.fd_dev_decline(p_attrs jsonb, p_age integer, p_u numeric, p_seed text)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, -loss) filter (where loss > 0), '{}'::jsonb) from (
    select k, least(v - 1, floor(raw)::integer
             + (((('x' || substr(md5(p_seed || ':' || k), 1, 8))::bit(32)::bigint & 2147483647)::float8 / 2147483647) < raw - floor(raw))::integer) as loss
    from (
      select e.key as k, e.value::integer as v,
             (case when p_age <= 28 then 0 when p_age = 29 then 0.3 when p_age = 30 then 0.6 when p_age = 31 then 1.0
                   when p_age = 32 then 1.4 when p_age = 33 then 1.9 when p_age = 34 then 2.4 else 3 + 0.5 * (p_age - 35) end)
             * (0.5 + p_u) * coalesce(w.f, 0.5) as raw
      from jsonb_each_text(p_attrs) e
      left join (values ('pace', 1.7), ('stamina', 1.5), ('physical', 1.3), ('reactionSpeed', 1.3), ('reflexes', 1.2), ('dribbling', 0.8), ('shooting', 0.7), ('heading', 0.8), ('defending', 0.7), ('crossing', 0.6), ('passing', 0.5), ('oneOnOne', 0.8), ('handling', 0.7), ('commandOfArea', 0.6), ('kicking', 0.5), ('distribution', 0.4), ('positioning', 0.4), ('freeKicks', 0.3), ('corners', 0.3), ('penalties', 0.3), ('throwIns', 0.4), ('gameIntelligence', 0.15), ('mentality', 0.15)) w(n, f) on w.n = e.key
    ) x
  ) y;
$$;

create or replace function public.fd_dev_season_close(p_world uuid, p_season uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.player_season_development(player_id, season_id, world_id, club_id, age, position, ovr_start, attrs_start)
  select p.id, p_season, p_world, p.club_id, p.age, p.main_position, p.overall, pa.attributes
  from public.players p join public.player_attributes pa on pa.player_id = p.id
  where p.world_id = p_world and p.club_id is not null and not p.retired
  on conflict (player_id, season_id) do nothing;
  update public.player_season_development d set ovr_end = p.overall, club_id = p.club_id, position = p.main_position, updated_at = now()
  from public.players p where p.id = d.player_id and d.season_id = p_season and d.world_id = p_world;
$$;

-- Erwartet das bereits erhöhte Alter (neue Saison). Bearbeitet bis zu p_limit Spieler der abgeschlossenen
-- Saison (jeden genau einmal) und gibt die Zahl der noch offenen zurück.
create or replace function public.fd_dev_season_aging(p_world uuid, p_season uuid, p_limit integer default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_left integer;
begin
  create temporary table if not exists fd_tmp_aging (player_id uuid primary key, kind text, pos text, age integer, ovr integer, attrs jsonb, dec jsonb) on commit drop;
  truncate fd_tmp_aging;
  insert into fd_tmp_aging
  select p.id, pa.kind, p.main_position::text, p.age, p.overall, pa.attributes,
         case when p.age >= 29 and p.club_id is not null and not p.retired
              then public.fd_dev_decline(pa.attributes, p.age, public.fd_hash01(p.id::text || ':' || p_season::text || ':age')::numeric, p.id::text || ':' || p_season::text)
              else '{}'::jsonb end
  from public.player_season_development d
  join public.players p on p.id = d.player_id
  join public.player_attributes pa on pa.player_id = p.id
  where d.world_id = p_world and d.season_id = p_season and not d.aging_done
  order by d.player_id
  limit coalesce(p_limit, 2147483647);

  update fd_tmp_aging set attrs = public.fd_jsonb_add(attrs, dec) where dec <> '{}'::jsonb;
  update public.player_attributes pa set attributes = t.attrs, updated_at = now() from fd_tmp_aging t where pa.player_id = t.player_id and t.dec <> '{}'::jsonb;
  -- Gesamtstärke mengenbasiert (wie fd_overall, aber ohne Funktionsaufruf je Zeile)
  update public.players p set overall = least(p.overall, coalesce(o.v, p.overall))
  from fd_tmp_aging t
  cross join lateral (
    select floor(sum((t.attrs ->> u.k)::float8 * u.w order by u.i) / sum(u.w order by u.i) + 0.5)::integer as v
    from public.fd_dev_weights(t.kind, t.pos) d, unnest(d.keys, d.ws) with ordinality as u(k, w, i)) o
  where p.id = t.player_id and t.dec <> '{}'::jsonb;
  update public.players p set market_value = public.fd_market_value(p.overall, p.age)
  from fd_tmp_aging t where p.id = t.player_id and t.dec <> '{}'::jsonb and p.overall < t.ovr;
  insert into public.player_development(world_id, player_id, season_id, kind, overall_before, overall_after, attribute_changes)
  select p_world, t.player_id, p_season, 'season_change_age', t.ovr, p.overall, t.dec
  from fd_tmp_aging t join public.players p on p.id = t.player_id where t.dec <> '{}'::jsonb;
  update public.player_season_development d set declines = t.dec, ovr_after_aging = p.overall, aging_done = true
  from fd_tmp_aging t join public.players p on p.id = t.player_id
  where d.player_id = t.player_id and d.season_id = p_season;

  select count(*) into v_left from public.player_season_development where world_id = p_world and season_id = p_season and not aging_done;
  if v_left = 0 then
    update public.dev_aging_jobs set done_at = coalesce(done_at, now()) where world_id = p_world and season_id = p_season;
  end if;
  return v_left;
end;
$$;

-- Offene Alterung einer Welt fortsetzen (Match-Server-Sweep); gibt die Zahl offener Spieler zurück
create or replace function public.fd_dev_aging_batch(p_world uuid, p_limit integer default 4000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  j record;
  v_left integer := 0;
begin
  for j in select * from public.dev_aging_jobs where world_id = p_world and done_at is null loop
    v_left := v_left + public.fd_dev_season_aging(p_world, j.season_id, p_limit);
  end loop;
  return v_left;
end;
$$;

-- ---------------------------------------------------------------------
-- Einbindung in bestehende Abläufe (Funktionstext wird exakt ersetzt; Abbruch, falls nicht gefunden)
-- ---------------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_old text;
begin
  -- 1) Pflichtspiele: XP direkt nach dem Speichern der Spielerstatistiken
  select pg_get_functiondef('public.admin_finish_match(uuid, jsonb)'::regprocedure) into v_def;
  if position('fd_dev_after_match' in v_def) = 0 then
    v_old := $a$  if v_kind <> 'friendly' then
    -- Fitness übernehmen$a$;
    if position(v_old in v_def) = 0 then raise exception 'Patch admin_finish_match (Entwicklung) fehlgeschlagen'; end if;
    v_def := replace(v_def, v_old, $b$  if v_kind <> 'friendly' then
    -- Spielerentwicklung: XP aus der Leistung (einmalig je Spieler und Partie)
    perform public.fd_dev_after_match(p_fixture);
    -- Fitness übernehmen$b$);
    execute v_def;
  end if;

  -- 2) Zusatztraining: XP sofort in Attribute umwandeln
  select pg_get_functiondef('public.schedule_training(uuid, uuid, text)'::regprocedure) into v_def;
  if position('fd_dev_train' in v_def) = 0 then
    v_def := replace(v_def, $a$  v_points numeric;
begin$a$, $b$  v_points numeric;
  v_sid bigint;
  v_dev jsonb;
begin$b$);
    v_def := replace(v_def, $a$            coalesce(v_world.current_date_in_world, current_date));$a$,
                            $b$            coalesce(v_world.current_date_in_world, current_date)) returning id into v_sid;$b$);
    v_def := replace(v_def, $a$  select * into v_hidden from public.player_hidden where player_id = p_player for update;
  v_points := public.fd_training_points(v_player.age, v_player.overall, v_hidden.potential);
  update public.player_hidden set development_points = development_points + v_points where player_id = p_player;$a$,
      $b$  v_dev := public.fd_dev_train(v_sid);
  v_points := coalesce((v_dev ->> 'xp')::numeric, 0);
  update public.player_hidden set development_points = development_points + v_points where player_id = p_player
  returning * into v_hidden;$b$);
    v_def := replace(v_def, $a$'total_points', coalesce(v_hidden.development_points, 0) + v_points);$a$,
      $b$'total_points', coalesce(v_hidden.development_points, v_points),
    'ovr_before', v_dev -> 'ovr_before', 'ovr_after', v_dev -> 'ovr_after', 'gains', coalesce(v_dev -> 'gains', '{}'::jsonb));$b$);
    if position('returning id into v_sid' in v_def) = 0 or position('fd_dev_train(v_sid)' in v_def) = 0 or position('''gains''' in v_def) = 0 then
      raise exception 'Patch schedule_training fehlgeschlagen';
    end if;
    execute v_def;
  end if;

  -- 3) Saisonwechsel: Bilanz schließen, dann altern
  select pg_get_functiondef('public.fd_end_season(uuid)'::regprocedure) into v_def;
  if position('fd_dev_season_aging' in v_def) = 0 then
    v_old := $a$  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;$a$;
    if position(v_old in v_def) = 0 then raise exception 'Patch fd_end_season fehlgeschlagen'; end if;
    v_def := replace(v_def, v_old, $b$  -- Entwicklungsbericht: Stand am Saisonende festhalten, danach Alterung (nur hier sinken Attribute)
  perform public.fd_dev_season_close(p_world, v_old.id);
  update public.players set age = least(45, age + 1) where world_id = p_world and club_id is not null;
  insert into public.dev_aging_jobs(world_id, season_id) values (p_world, v_old.id) on conflict do nothing;
  perform public.fd_dev_season_aging(p_world, v_old.id, 2000); -- große Welten: Rest übernimmt der Server-Sweep$b$);
    execute v_def;
  end if;
end
$patch$;

-- Spieltagssteuerung (0022) erweitert: offene KI-Trainingswoche zählt ebenfalls als Arbeit für den Server
create or replace function public.admin_due_worlds()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select w.id from public.career_worlds w
  join public.season_slots s on s.world_id = w.id and s.season_id = w.current_season_id and s.ordinal = w.current_slot
  where s.state = 'live'
  union
  select w.id from public.career_worlds w
  where w.status::text in ('preseason', 'season') and w.current_season_id is not null
    and exists (select 1 from public.clubs cl where cl.world_id = w.id and cl.control = 'ai'
                and not exists (select 1 from public.ai_training_log l where l.club_id = cl.id and l.season_id = w.current_season_id and l.week_no = w.current_week))
  union
  select j.world_id from public.dev_aging_jobs j where j.done_at is null;
$$;

create or replace function public.admin_sweep_world(p_world uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending uuid[];
  v_left integer;
  v_aging integer;
begin
  if (public.fd_current_slot(p_world)).state = 'live' then
    perform public.fd_try_release(p_world);
  end if;
  -- Hintergrundarbeit in Häppchen: zuerst offene Alterung des Saisonwechsels, dann KI-Zusatztraining
  v_aging := public.fd_dev_aging_batch(p_world, 4000);
  v_left := public.fd_ai_training_batch(p_world, 40);
  select coalesce(array_agg(x), '{}') into v_pending from public.admin_pending_fixtures(p_world) x;
  return jsonb_build_object('pending', to_jsonb(v_pending), 'slot_state', (public.fd_current_slot(p_world)).state, 'training_left', v_left, 'aging_left', v_aging);
end;
$$;

-- ---------------------------------------------------------------------
-- Berichte (für alle Vereine der Welt einsehbar; Potenzial bleibt verborgen)
-- ---------------------------------------------------------------------
create or replace function public.development_report(p_world uuid, p_club uuid, p_season uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w public.career_worlds;
  v_season uuid;
  v_live boolean;
  v_rows jsonb;
begin
  perform public.fd_require_member(p_world);
  select * into v_w from public.career_worlds where id = p_world;
  if not exists (select 1 from public.clubs where id = p_club and world_id = p_world) then
    raise exception 'Verein nicht gefunden.' using errcode = 'P0001', hint = 'not_found';
  end if;
  -- Standard: in der Vorbereitung die abgeschlossene Vorsaison, sonst die laufende Saison
  v_season := coalesce(p_season, case when v_w.status::text = 'preseason'
      then (select s.id from public.seasons s where s.world_id = p_world and s.status::text = 'closed' order by s.year desc limit 1) end,
    v_w.current_season_id);
  v_live := v_season = v_w.current_season_id;
  if v_live then
    select coalesce(jsonb_agg(r order by (r ->> 'delta')::int desc, r ->> 'name'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('player_id', p.id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name), 'age', p.age, 'position', p.main_position,
        'ovr_start', coalesce(d.ovr_start, p.overall), 'ovr_end', p.overall, 'ovr_after_aging', null,
        'delta', p.overall - coalesce(d.ovr_start, p.overall),
        'gains', coalesce(d.gains, '{}'::jsonb), 'declines', '{}'::jsonb,
        'training_xp', coalesce(d.training_xp, 0), 'match_xp', coalesce(d.match_xp, 0),
        'training_sessions', coalesce(d.training_sessions, 0), 'matches', coalesce(d.matches, 0)) r
      from public.players p
      left join public.player_season_development d on d.player_id = p.id and d.season_id = v_season
      where p.club_id = p_club and not p.retired) x;
  else
    select coalesce(jsonb_agg(r order by (r ->> 'delta')::int desc, r ->> 'name'), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('player_id', p.id, 'name', trim(coalesce(p.first_name, '') || ' ' || p.last_name), 'age', d.age, 'position', d.position,
        'ovr_start', d.ovr_start, 'ovr_end', coalesce(d.ovr_end, d.ovr_start), 'ovr_after_aging', d.ovr_after_aging,
        'delta', coalesce(d.ovr_after_aging, d.ovr_end, d.ovr_start) - d.ovr_start,
        'gains', d.gains, 'declines', d.declines, 'training_xp', d.training_xp, 'match_xp', d.match_xp,
        'training_sessions', d.training_sessions, 'matches', d.matches) r
      from public.player_season_development d join public.players p on p.id = d.player_id
      where d.club_id = p_club and d.season_id = v_season) x;
  end if;
  return jsonb_build_object(
    'season', (select jsonb_build_object('id', s.id, 'year', s.year, 'live', v_live) from public.seasons s where s.id = v_season),
    'club', public.fd_club_ref(p_club),
    'seasons', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'year', s.year) order by s.year desc) from public.seasons s
                         where s.world_id = p_world and (s.id = v_w.current_season_id or s.status::text = 'closed')), '[]'::jsonb),
    'players', v_rows);
end;
$$;

create or replace function public.player_development(p_player uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.players;
begin
  select * into v_p from public.players where id = p_player;
  if not found then raise exception 'Spieler nicht gefunden.' using errcode = 'P0001', hint = 'not_found'; end if;
  perform public.fd_require_member(v_p.world_id);
  return coalesce((select jsonb_agg(jsonb_build_object('season_year', s.year, 'live', s.id = w.current_season_id, 'age', d.age,
      'ovr_start', d.ovr_start, 'ovr_end', case when s.id = w.current_season_id then v_p.overall else d.ovr_end end, 'ovr_after_aging', d.ovr_after_aging,
      'gains', d.gains, 'declines', d.declines, 'training_xp', d.training_xp, 'match_xp', d.match_xp,
      'training_sessions', d.training_sessions, 'matches', d.matches) order by s.year desc)
    from public.player_season_development d join public.seasons s on s.id = d.season_id join public.career_worlds w on w.id = d.world_id
    where d.player_id = p_player), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public.fd_dev_weights(text, text)', 'public.fd_dev_training_shares(text, text, text)', 'public.fd_dev_decline_weight(text)',
    'public.fd_dev_age_factor(integer)', 'public.fd_dev_headroom_factor(integer, integer)', 'public.fd_dev_intelligence_factor(numeric)',
    'public.fd_dev_multiplier(integer, integer, integer, numeric)', 'public.fd_dev_cost(integer)', 'public.fd_overall(text, text, jsonb)',
    'public.fd_market_value(integer, integer)', 'public.fd_jsonb_add(jsonb, jsonb)', 'public.fd_jsonb_scale(jsonb, numeric)',
    'public.fd_dev_match_xp(text, text, integer, numeric, integer, integer, integer, integer, integer)',
    'public.fd_dev_grant(uuid, jsonb, text)', 'public.fd_dev_train(bigint)', 'public.fd_dev_after_match(uuid)', 'public.fd_ai_focus(text)',
    'public.fd_ai_training_batch(uuid, integer)', 'public.fd_dev_decline_base(integer)', 'public.fd_dev_decline(jsonb, integer, numeric, text)',
    'public.fd_dev_season_close(uuid, uuid)', 'public.fd_dev_season_aging(uuid, uuid, integer)', 'public.fd_dev_aging_batch(uuid, integer)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$grants$;
revoke execute on function public.admin_due_worlds() from public, anon, authenticated;
revoke execute on function public.admin_sweep_world(uuid) from public, anon, authenticated;
grant execute on function public.admin_due_worlds() to service_role;
grant execute on function public.admin_sweep_world(uuid) to service_role;
revoke execute on function public.development_report(uuid, uuid, uuid) from public, anon;
grant execute on function public.development_report(uuid, uuid, uuid) to authenticated;
revoke execute on function public.player_development(uuid) from public, anon;
grant execute on function public.player_development(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Einmalige Datenmigration: Training und Pflichtspiele der laufenden Saison nachträglich auswerten,
-- damit bestehende Karrieren nichts verlieren (bisher wurden Punkte nur gesammelt, nie umgesetzt).
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_t integer := 0;
  v_m integer := 0;
begin
  if exists (select 1 from public.fd_data_migrations where key = '0023_development') then return; end if;
  for r in
    select t.id from public.training_sessions t join public.career_worlds w on w.id = t.world_id and w.current_season_id = t.season_id
    where t.dev_xp is null order by t.training_date, t.id
  loop
    perform public.fd_dev_train(r.id);
    v_t := v_t + 1;
  end loop;
  for r in
    select f.id from public.fixtures f join public.career_worlds w on w.id = f.world_id and w.current_season_id = f.season_id
    join public.competitions c on c.id = f.competition_id
    where c.kind::text <> 'friendly' and f.status in ('finished', 'released') order by f.scheduled_date, f.id
  loop
    v_m := v_m + public.fd_dev_after_match(r.id);
  end loop;
  insert into public.fd_data_migrations(key, info) values ('0023_development', jsonb_build_object('training_sessions', v_t, 'match_lines', v_m));
  raise notice 'Entwicklung nachgetragen: % Trainingseinheiten, % Spielerleistungen', v_t, v_m;
end $$;
