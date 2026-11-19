import { ApiError } from './api';
import { matchServerUrl } from './matchApi';
import { requireSupabase } from './supabase';

/** Datenzugriff Saison, Spieltag, Liga, Pokal, Transfers und Finanzen (Phase 7 + 8). */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export interface SlotInfo { id: string; ordinal: number; key: string; kind: 'league' | 'cup' | 'relegation' | 'season_end'; label: string; date: string; state: 'pending' | 'live' | 'released'; started_at: string | null; matchday: number | null }
export interface ClubRef { id: string; name: string; short_name: string; control: 'human' | 'ai'; color: string | null }
export interface SlotFixture { id: string; competition: string; kind: string; status: string; neutral: boolean; leg: number | null; home: ClubRef; away: ClubRef; mine: boolean; decisions: Record<string, 'live' | 'skip'>; result: { home: number; away: number; hp: number | null; ap: number | null } | null }
export interface WindowInfo { open: boolean; window_no: number | null; until_matchday: number | null; signings: number; sales: number; max_signings: number; max_sales: number; min_squad: number; max_squad: number }
export interface MatchdayState {
  status: 'lobby' | 'draft' | 'preseason' | 'season' | 'season_end';
  is_host: boolean;
  my_club: string | null;
  date: string | null;
  season: { id: string; year: number } | null;
  slot: SlotInfo | null;
  readiness: Array<{ user_id: string; club: string; username: string; ready: boolean }>;
  fixtures: SlotFixture[];
  last_slot: { label: string; key: string } | null;
  next_slots: Array<{ label: string; date: string; kind: string }>;
  window: WindowInfo;
}

export interface TableRow { club_id: string; name: string; short_name: string; control: 'human' | 'ai'; color: string | null; played: number; won: number; drawn: number; lost: number; goals_for: number; goals_against: number; points: number; home: SplitRecord; away: SplitRecord }
export interface SplitRecord { p: number; w: number; d: number; l: number; gf: number; ga: number }
export interface Competition { id: string; kind: string; tier: number | null; name: string }
export interface FixtureRow { id: string; matchday: number | null; slot_key: string; status: string; scheduled_date: string; home: ClubRef; away: ClubRef; result: { home_goals: number; away_goals: number; home_penalties: number | null; away_penalties: number | null; attendance: number | null } | null; stage: string | null; leg: number | null; neutral_venue: boolean }

export interface TransferOffer {
  id: string; status: string; fee: number; salary: number; years: number; counter_fee: number | null; counter_salary: number | null; created_at: string;
  direction: 'in' | 'out';
  player: { id: string; name: string; position: string; overall: number; age: number; value: number };
  from: { id: string | null; name: string | null }; to: { id: string; name: string };
}
export interface MarketPlayer {
  id: string; first_name: string; last_name: string; age: number; main_position: string; overall: number; market_value: number; nationality: string;
  club: { id: string; name: string; short_name: string; control: 'human' | 'ai'; association_code?: string; color?: string | null } | null; salary: number | null;
  league_name?: string | null; secondary_positions?: string[];
}

/** Filter des europaweiten Transfermarkts (alle optional) */
export interface MarketFilters {
  country?: string; league?: string; club?: string; position?: string; nationality?: string;
  min_age?: number; max_age?: number; min_overall?: number; max_overall?: number; min_value?: number; max_value?: number;
  search?: string; free_agents?: boolean; sort?: 'overall' | 'value' | 'age' | 'name'; dir?: 'asc' | 'desc';
}
export interface MarketOptions {
  countries: Array<{ code: string; name: string; strength: number }>;
  leagues: Array<{ key: string; name: string; country: string }>;
  clubs: Array<{ id: string; name: string; short_name: string; country: string; league: string }>;
}

const CLUB_SEL = 'id, name, short_name, control, club_branding(primary_color)';
const toRef = (c: { id: string; name: string; short_name: string; control: 'human' | 'ai'; club_branding?: { primary_color: string } | Array<{ primary_color: string }> | null }): ClubRef => ({
  id: c.id, name: c.name, short_name: c.short_name, control: c.control,
  color: Array.isArray(c.club_branding) ? (c.club_branding[0]?.primary_color ?? null) : (c.club_branding?.primary_color ?? null),
});

export const seasonApi = {
  matchday: (worldId: string) => rpc<MatchdayState>('matchday_state', { p_world: worldId }),
  setReady: (worldId: string, ready: boolean) => rpc<MatchdayState>('set_matchday_ready', { p_world: worldId, p_ready: ready }),
  forceStart: (worldId: string) => rpc<MatchdayState>('force_start_slot', { p_world: worldId }),
  forceStartSeason: (worldId: string) => rpc<void>('force_start_season', { p_world: worldId }),
  decide: (fixtureId: string, decision: 'live' | 'skip') => rpc<MatchdayState>('set_fixture_decision', { p_fixture: fixtureId, p_decision: decision }),

  /** Match-Server: offene Spiele des Termins headless berechnen lassen */
  async simulate(worldId: string): Promise<void> {
    const base = matchServerUrl();
    if (!base) return;
    const http = base.replace(/^ws/, 'http').replace(/\/match$/, '');
    const { data } = await requireSupabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch(`${http}/world/simulate?world=${encodeURIComponent(worldId)}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => undefined);
  },

  async competitions(seasonId: string): Promise<Competition[]> {
    const { data, error } = await requireSupabase().from('competitions').select('id, kind, tier, name').eq('season_id', seasonId).order('tier');
    if (error) throw new ApiError(error.message, error.code ?? null);
    return (data ?? []) as Competition[];
  },

  async table(compId: string): Promise<TableRow[]> {
    const { data, error } = await requireSupabase().from('standings')
      .select(`club_id, played, won, drawn, lost, goals_for, goals_against, points, home, away, clubs!inner(${CLUB_SEL})`)
      .eq('competition_id', compId).is('group_id', null);
    if (error) throw new ApiError(error.message, error.code ?? null);
    const rows = (data ?? []).map((r: any) => ({ ...r, ...toRef(r.clubs), club_id: r.club_id }));
    return rows.sort((a, b) => b.points - a.points || (b.goals_for - b.goals_against) - (a.goals_for - a.goals_against) || b.goals_for - a.goals_for || a.name.localeCompare(b.name));
  },

  async fixtures(compId: string, filter: { matchday?: number } = {}): Promise<FixtureRow[]> {
    let q = requireSupabase().from('fixtures')
      .select(`id, matchday, slot_key, status, scheduled_date, leg, neutral_venue, competition_stages(kind),
               home:clubs!fixtures_home_club_id_fkey(${CLUB_SEL}), away:clubs!fixtures_away_club_id_fkey(${CLUB_SEL}),
               fixture_results(home_goals, away_goals, home_penalties, away_penalties, attendance)`)
      .eq('competition_id', compId).order('scheduled_date').order('id');
    if (filter.matchday) q = q.eq('matchday', filter.matchday);
    const { data, error } = await q;
    if (error) throw new ApiError(error.message, error.code ?? null);
    return (data ?? []).map((f: any) => ({
      id: f.id, matchday: f.matchday, slot_key: f.slot_key, status: f.status, scheduled_date: f.scheduled_date, leg: f.leg, neutral_venue: f.neutral_venue,
      stage: f.competition_stages?.kind ?? null, home: toRef(f.home), away: toRef(f.away),
      result: Array.isArray(f.fixture_results) ? (f.fixture_results[0] ?? null) : (f.fixture_results ?? null),
    }));
  },

  leaders: (compId: string) => rpc<{ scorers: Array<{ player: string; club: string; goals: number; assists: number; games: number }>; assists: Array<{ player: string; club: string; assists: number; games: number }>; ratings: Array<{ player: string; club: string; rating: number; games: number }> }>('league_leaders', { p_comp: compId }),

  // Transfers
  myOffers: (worldId: string) => rpc<TransferOffer[]>('my_transfer_offers', { p_world: worldId }),
  offer: (playerId: string, fee: number, salary: number, years: number) => rpc<{ status: string; message?: string; counter_fee?: number; counter_salary?: number }>('make_transfer_offer', { p_player: playerId, p_fee: fee, p_salary: salary, p_years: years }),
  acceptCounter: (offerId: string) => rpc<{ status: string; message?: string }>('accept_counter_offer', { p_offer: offerId }),
  respond: (offerId: string, action: 'accept' | 'reject' | 'counter', counterFee?: number) => rpc<{ status: string; message?: string }>('respond_transfer_offer', { p_offer: offerId, p_action: action, p_counter_fee: counterFee ?? null }),
  withdraw: (offerId: string) => rpc<void>('withdraw_transfer_offer', { p_offer: offerId }),
  sellToAi: (playerId: string) => rpc<{ status: string; message?: string }>('sell_to_ai', { p_player: playerId }),
  signFreeAgent: (playerId: string, years: number) => rpc<{ status: string; message?: string }>('sign_free_agent', { p_player: playerId, p_years: years }),
  release: (playerId: string) => rpc<{ status: string; compensation: number }>('release_player', { p_player: playerId }),

  retryRelease: (worldId: string) => rpc<{ released: boolean }>('retry_slot_release', { p_world: worldId }),
  marketSearch: (worldId: string, filters: MarketFilters, limit = 50, offset = 0) =>
    rpc<{ total: number; rows: MarketPlayer[] }>('transfer_market_search', { p_world: worldId, p_filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== 0 && v !== false)), p_limit: limit, p_offset: offset }),
  marketOptions: (worldId: string) => rpc<MarketOptions>('transfer_market_options', { p_world: worldId }),
  europeStatus: (worldId: string) => rpc<{ associations: number; total: number; world_status: string } | null>('europe_market_status', { p_world: worldId }),
  /** Ergänzt fehlende ausländische Ligen (Netlify-Function, schrittweise) */
  async ensureEurope(worldId: string): Promise<{ done: number; total: number; finished: boolean }> {
    const sb = requireSupabase();
    let { data } = await sb.auth.getSession();
    if (data.session && (data.session.expires_at ?? 0) * 1000 < Date.now() + 60_000) {
      const refreshed = await sb.auth.refreshSession();
      if (refreshed.data.session) data = { session: refreshed.data.session };
    }
    const token = data.session?.access_token;
    if (!token) throw new ApiError('Nicht angemeldet.', 'not_authenticated');
    const res = await fetch('/api/ensure-europe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ worldId }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; done?: number; total?: number; finished?: boolean };
    if (!res.ok) throw new ApiError(body.message ?? `Fehler ${res.status}`, body.error ?? null);
    return { done: body.done ?? 0, total: body.total ?? 0, finished: !!body.finished };
  },

  async market(worldId: string, f: { position?: string; minOverall?: number; maxValue?: number; search?: string; freeAgents?: boolean; excludeClub?: string | null }): Promise<MarketPlayer[]> {
    const sb = requireSupabase();
    let q = sb.from('players')
      .select(f.freeAgents
        ? 'id, first_name, last_name, age, main_position, overall, market_value, nationality, club_id, free_agents!inner(annual_salary)'
        : 'id, first_name, last_name, age, main_position, overall, market_value, nationality, club_id, clubs!inner(id, name, short_name, control, amateur)')
      .eq('world_id', worldId).eq('retired', false).order('overall', { ascending: false }).limit(80);
    if (f.freeAgents) q = q.is('club_id', null);
    else q = q.eq('clubs.amateur', false);
    if (f.position) q = q.eq('main_position', f.position);
    if (f.minOverall) q = q.gte('overall', f.minOverall);
    if (f.maxValue) q = q.lte('market_value', f.maxValue);
    if (f.search) q = q.ilike('last_name', `%${f.search.replace(/[%_]/g, '')}%`);
    if (f.excludeClub) q = q.neq('club_id', f.excludeClub);
    const { data, error } = await q;
    if (error) throw new ApiError(error.message, error.code ?? null);
    return (data ?? []).filter((p: any) => !p.clubs?.amateur).map((p: any) => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name, age: p.age, main_position: p.main_position, overall: p.overall,
      market_value: p.market_value, nationality: p.nationality, club: p.clubs ? { id: p.clubs.id, name: p.clubs.name, short_name: p.clubs.short_name, control: p.clubs.control } : null,
      salary: (Array.isArray(p.free_agents) ? p.free_agents[0]?.annual_salary : p.free_agents?.annual_salary) ?? null,
    }));
  },

  // Finanzen & Stadion
  finance: (worldId: string) => rpc<{
    balance: number; salaries: number; status: string;
    stadium: { club_id: string; name: string; capacity: number; ticket_price_league: number; ticket_price_cup: number; ticket_price_international: number };
    season_totals: Record<string, number>;
    transactions: Array<{ id: number; kind: string; amount: number; balance_after: number; description: string; created_at: string }>;
    last_attendance: { attendance: number; label: string } | null;
  }>('finance_overview', { p_world: worldId }),
  setTickets: (worldId: string, league: number, cup: number, intl: number) => rpc<void>('set_ticket_prices', { p_world: worldId, p_league: league, p_cup: cup, p_international: intl }),
  expandStadium: (worldId: string) => rpc<{ capacity: number }>('expand_stadium', { p_world: worldId }),
};

/** H5: geschätzte Gehaltsforderung (Marktwert × 12 % × Altersfaktor) als Startwert für Angebote */
export function estimateSalary(value: number, age: number): number {
  const f = age <= 20 ? 0.75 : age <= 24 ? 0.85 : age <= 28 ? 1 : age <= 32 ? 1.1 : age <= 35 ? 1.2 : 1.25;
  return Math.max(50000, Math.round((value * 0.12 * f) / 10000) * 10000);
}

export const STAGE_LABEL: Record<string, string> = {
  round_of_64: '1. Runde', round_of_32: '2. Runde', round_of_16: 'Achtelfinale', quarter_final: 'Viertelfinale', semi_final: 'Halbfinale', final: 'Finale', relegation: 'Relegation',
};
export const TX_LABEL: Record<string, string> = {
  starting_capital: 'Startkapital', stadium_build: 'Stadionbau', stadium_expansion: 'Stadionausbau', draft_purchase: 'Draft', transfer_fee_paid: 'Ablöse gezahlt',
  transfer_fee_received: 'Ablöse erhalten', salary: 'Gehälter', ticket_income: 'Zuschauer', match_bonus: 'Spielprämien', placement_prize: 'Platzierungsprämie',
  sponsor: 'Sponsor', competition_prize: 'Wettbewerbsprämien', stadium_running_cost: 'Stadionbetrieb', adjustment: 'Sonstiges',
};
