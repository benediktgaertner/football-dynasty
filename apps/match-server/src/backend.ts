import type { SupabaseClient } from '@supabase/supabase-js';
import { TICK_SECONDS, type MatchResult } from '@fd/engine';
import type { DbSetup } from './setup.js';
import { verifyAccessToken } from './auth.js';

/** Alles, was der Match-Server von außen braucht – austauschbar für Tests. */
export interface Backend {
  verifyToken(token: string): Promise<string | null>;
  role(fixtureId: string, userId: string): Promise<'home' | 'away' | 'spectator' | null>;
  setup(fixtureId: string): Promise<DbSetup>;
  checkpoint(fixtureId: string, tick: number, data: unknown): Promise<void>;
  finish(fixtureId: string, result: MatchResult): Promise<void>;
}

/**
 * admin_finish_match (Migration 0013) rechnet match_second = tick × 0,75 (altes Tick-Raster).
 * Die Engine tickt jetzt mit 0,1 s; damit keine SQL-Änderung nötig ist, werden die Ticks hier
 * in dieses Raster umgerechnet. Die exakte Sekunde steht zusätzlich in „second“.
 */
export function toDbResult(result: MatchResult): MatchResult {
  return {
    ...result,
    events: result.events.map((e) => {
      const second = Math.round(e.tick * TICK_SECONDS);
      return { ...e, tick: Math.round(second / 0.75), second } as typeof e;
    }),
  };
}

export function supabaseBackend(admin: SupabaseClient): Backend {
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`);
    return data as T;
  };
  return {
    async verifyToken(token) { return (await verifyAccessToken(admin, token))?.userId ?? null; },
    async role(fixtureId, userId) { return rpc('admin_match_role', { p_fixture: fixtureId, p_user: userId }); },
    async setup(fixtureId) { return rpc('admin_match_setup', { p_fixture: fixtureId }); },
    async checkpoint(fixtureId, tick, data) { await rpc('admin_match_checkpoint', { p_fixture: fixtureId, p_tick: tick, p_checkpoint: data }); },
    async finish(fixtureId, result) { await rpc('admin_finish_match', { p_fixture: fixtureId, p_result: toDbResult(result) }); },
  };
}
