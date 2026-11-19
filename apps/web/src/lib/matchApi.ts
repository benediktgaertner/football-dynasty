import { ApiError } from './api';
import { requireSupabase } from './supabase';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export interface FixtureSummary {
  id: string;
  kind: string;
  status: 'scheduled' | 'live' | 'finished' | 'released' | 'cancelled';
  scheduled_date: string;
  created_at: string;
  home: { id: string; name: string; short_name: string; control: 'human' | 'ai'; color: string | null };
  away: { id: string; name: string; short_name: string; control: 'human' | 'ai'; color: string | null };
  mine: boolean;
  result: { home: number; away: number } | null;
}

export interface OpponentClub { id: string; name: string; short_name: string; control: 'human' | 'ai'; association_code: string }

export const matchApi = {
  myFixtures: (worldId: string) => rpc<FixtureSummary[]>('my_fixtures', { p_world: worldId }),
  createFriendly: (worldId: string, opponent: string) => rpc<string>('create_friendly', { p_world: worldId, p_opponent: opponent }),
  cancelFriendly: (fixtureId: string) => rpc<void>('cancel_friendly', { p_fixture: fixtureId }),
  async opponents(worldId: string): Promise<OpponentClub[]> {
    const { data, error } = await requireSupabase().from('clubs').select('id, name, short_name, control, association_code').eq('world_id', worldId).eq('association_code', 'GER').order('control').order('name');
    if (error) throw new ApiError(error.message, error.code ?? null);
    return (data ?? []) as OpponentClub[];
  },
};

/** Basis-URL des Match-Servers (Fly.io). http(s) → ws(s). */
export function matchServerUrl(): string | null {
  const raw = (import.meta.env.VITE_MATCH_SERVER_URL as string | undefined)?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '').replace(/^http/, 'ws') + '/match';
}
