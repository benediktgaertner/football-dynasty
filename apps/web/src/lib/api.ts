import type { ClubCreationInput, CrestConfig, Difficulty, KitConfig } from '@fd/shared';
import { requireSupabase } from './supabase';

/**
 * Typisierte Wrapper um die Supabase-RPCs (supabase/migrations/…_rpc_lobby.sql).
 * Der Server ist die verbindliche Instanz; der Client validiert nur für schnelle Rückmeldungen.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message || 'Unbekannter Fehler', error.hint || error.code || null);
  return data as T;
}

export interface Profile {
  id: string;
  username: string;
}

export interface WorldSummary {
  world_id: string;
  name: string;
  status: string;
  role: 'host' | 'manager';
  invite_code: string;
  member_count: number;
}

export interface LobbyClub {
  id: string;
  name: string;
  short_name: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  crest: CrestConfig;
  kit: KitConfig;
  stadium_name: string;
  stadium_capacity: number;
  stadium_cost: number;
}

export interface LobbyMember {
  user_id: string;
  username: string;
  role: 'host' | 'manager';
  ready: boolean;
  last_seen_at: string;
  club: LobbyClub | null;
}

export interface LobbyState {
  world: {
    id: string;
    name: string;
    invite_code: string;
    status: string;
    difficulty: Difficulty;
    host_user_id: string;
    starting_capital: number;
    /** Spielland und Startliga (ältere Welten: Deutschland, 2. Liga) */
    country_code?: string;
    country_name?: string;
    start_tier?: 1 | 2 | 3;
    league_names?: { '1': string; '2': string; '3': string; cup: string } | null;
    capital_factor?: number;
    economy_factor?: number;
  };
  me: { user_id: string; role: 'host' | 'manager' };
  members: LobbyMember[];
  all_ready: boolean;
}

export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await requireSupabase().from('profiles').select('id, username').eq('id', userId).maybeSingle();
  if (error) throw new ApiError(error.message, error.code);
  return data;
}

export const api = {
  setUsername: (username: string) => rpc<Profile>('set_username', { p_username: username }),
  createWorld: (name: string, country = 'GER', startTier: 1 | 2 | 3 = 2) =>
    rpc<{ world_id: string; invite_code: string }>('create_world', { p_name: name, p_country: country, p_start_tier: startTier }),
  setWorldSetup: (worldId: string, country: string, startTier: 1 | 2 | 3) =>
    rpc<void>('set_world_setup', { p_world: worldId, p_country: country, p_start_tier: startTier }),
  async joinWorld(code: string): Promise<string> {
    const r = await rpc<{ world_id?: string; error?: string; message?: string }>('join_world', { p_code: code });
    if (!r.world_id) throw new ApiError(r.message ?? 'Beitritt fehlgeschlagen.', r.error ?? null);
    return r.world_id;
  },
  leaveWorld: (worldId: string) => rpc<void>('leave_world', { p_world: worldId }),
  myWorlds: () => rpc<WorldSummary[]>('my_worlds'),
  lobbyState: (worldId: string) => rpc<LobbyState>('lobby_state', { p_world: worldId }),
  setDifficulty: (worldId: string, difficulty: Difficulty) =>
    rpc<void>('set_world_difficulty', { p_world: worldId, p_difficulty: difficulty }),
  upsertMyClub: (worldId: string, club: ClubCreationInput) => rpc<string>('upsert_my_club', { p_world: worldId, p_club: club }),
  setReady: (worldId: string, ready: boolean) => rpc<void>('set_ready', { p_world: worldId, p_ready: ready }),
  touchPresence: (worldId: string) => rpc<void>('touch_presence', { p_world: worldId }),
};

export function formatEuro(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    return `${(amount / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mio. €`;
  }
  return `${amount.toLocaleString('de-DE')} €`;
}

/** Betrag mit Vorzeichen für Buchungen: „+412.500 €“ / „−1,2 Mio. €“ */
export function formatEuroSigned(amount: number): string {
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${formatEuro(Math.abs(amount))}`;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Einfach', medium: 'Mittel', hard: 'Schwer' };

// ---------------------------------------------------------------------------
// Phase 3: Draft
// ---------------------------------------------------------------------------

export interface DraftClub {
  club_id: string;
  name: string;
  short_name: string;
  order: number;
  primary_color: string;
  secondary_color: string;
  crest: CrestConfig;
  manager: string | null;
  manager_user_id: string | null;
  last_seen_at: string | null;
  balance: number;
  picks: number;
}

export interface DraftPickInfo {
  pick_index: number;
  club_id: string;
  player_id: string;
  price: number;
  name: string;
  position: string;
  overall: number;
  age: number;
  nationality: string;
  shirt_number: number | null;
}

export interface DraftState {
  status: 'none' | 'pending' | 'running' | 'finished';
  draft_id: string;
  current_pick: number;
  total_picks: number;
  picks_per_club: number;
  round: number;
  current_club_id: string | null;
  my_club_id: string | null;
  is_host: boolean;
  upcoming: Array<{ pick_index: number; club_id: string }>;
  clubs: DraftClub[];
  picks: DraftPickInfo[];
}

export interface PoolPlayer {
  id: string;
  first_name: string;
  last_name: string;
  nationality: string;
  age: number;
  main_position: string;
  secondary_positions: string[];
  overall: number;
  market_value: number;
  salary: number | null;
  kind: 'outfield' | 'goalkeeper';
  attributes: Record<string, number>;
}

type Embedded<T> = T | T[] | null;
const one = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

export async function fetchPool(worldId: string): Promise<PoolPlayer[]> {
  const { data, error } = await requireSupabase()
    .from('players')
    .select('id, first_name, last_name, nationality, age, main_position, secondary_positions, overall, market_value, player_attributes(kind, attributes), free_agents(annual_salary)')
    .eq('world_id', worldId)
    .eq('in_draft_pool', true)
    .limit(1000);
  if (error) throw new ApiError(error.message, error.code);
  return (data ?? []).map((row) => {
    const r = row as unknown as Omit<PoolPlayer, 'salary' | 'kind' | 'attributes'> & {
      player_attributes: Embedded<{ kind: 'outfield' | 'goalkeeper'; attributes: Record<string, number> }>;
      free_agents: Embedded<{ annual_salary: number }>;
    };
    const attrs = one(r.player_attributes);
    return {
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      nationality: r.nationality,
      age: r.age,
      main_position: r.main_position,
      secondary_positions: r.secondary_positions ?? [],
      overall: r.overall,
      market_value: r.market_value,
      salary: one(r.free_agents)?.annual_salary ?? null,
      kind: attrs?.kind ?? 'outfield',
      attributes: attrs?.attributes ?? {},
    };
  });
}

export async function fetchSquad(clubId: string): Promise<Array<{ id: string; first_name: string; last_name: string; main_position: string; overall: number; age: number; shirt_number: number | null; nationality: string; market_value: number }>> {
  const { data, error } = await requireSupabase()
    .from('players')
    .select('id, first_name, last_name, main_position, overall, age, shirt_number, nationality, market_value')
    .eq('club_id', clubId)
    .order('shirt_number');
  if (error) throw new ApiError(error.message, error.code);
  return data ?? [];
}

export const draftApi = {
  state: (worldId: string) => rpc<DraftState>('draft_state', { p_world: worldId }),
  pick: (worldId: string, playerId: string) => rpc<{ pick_index: number; finished: boolean }>('make_draft_pick', { p_world: worldId, p_player: playerId }),
  autoPick: (worldId: string) => rpc<{ pick_index: number }>('auto_pick_current', { p_world: worldId }),
  /** Startet den Draft über die Netlify-Function (erzeugt KI-Vereine, Kader und Draft-Pool serverseitig). */
  async start(worldId: string): Promise<void> {
    const sb = requireSupabase();
    let { data } = await sb.auth.getSession();
    // Token erneuern, wenn es abgelaufen ist oder in der nächsten Minute abläuft
    if (data.session && (data.session.expires_at ?? 0) * 1000 < Date.now() + 60_000) {
      const refreshed = await sb.auth.refreshSession();
      if (refreshed.data.session) data = { session: refreshed.data.session };
    }
    const token = data.session?.access_token;
    if (!token) throw new ApiError('Nicht angemeldet.', 'not_authenticated');
    let res: Response;
    try {
      res = await fetch('/api/start-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ worldId }),
      });
    } catch {
      throw new ApiError('Der Server ist nicht erreichbar.', 'network');
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(body.message ?? `Fehler ${res.status}`, body.error ?? null);
  },
};
