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
  createWorld: (name: string) => rpc<{ world_id: string; invite_code: string }>('create_world', { p_name: name }),
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

export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Einfach', medium: 'Mittel', hard: 'Schwer' };
