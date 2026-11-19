import type { SupabaseClient } from '@supabase/supabase-js';
import { CLOCK_SECONDS_PER_TICK, type MatchResult } from '@fd/engine';
import type { DbSetup } from './setup.js';
import { verifyAccessToken } from './auth.js';

/** Alles, was der Match-Server von außen braucht – austauschbar für Tests. */
export interface Backend {
  verifyToken(token: string): Promise<string | null>;
  role(fixtureId: string, userId: string): Promise<'home' | 'away' | 'spectator' | null>;
  setup(fixtureId: string): Promise<DbSetup>;
  checkpoint(fixtureId: string, tick: number, data: unknown): Promise<void>;
  finish(fixtureId: string, result: MatchResult): Promise<void>;
  /** Spiele des laufenden Termins, die headless berechnet werden sollen */
  pendingFixtures(worldId: string): Promise<string[]>;
  isMember(worldId: string, userId: string): Promise<boolean>;
  /** Sperre gegen doppelte Simulation; attempts = Anzahl Versuche inkl. diesem */
  claim(fixtureId: string, worker: string): Promise<{ ok: boolean; attempts: number; reason?: string }>;
  failed(fixtureId: string, error: string): Promise<void>;
  /** Ersatzergebnis nach wiederholten Fehlschlägen (Saisonfortschritt darf nie blockieren) */
  fallback(fixtureId: string): Promise<void>;
  /** Welten mit laufendem Spieltag oder offenem KI-Training */
  dueWorlds(): Promise<string[]>;
  /** Freigabe nachholen, KI-Training in Häppchen, offene Partien liefern */
  sweep(worldId: string): Promise<{ pending: string[]; trainingLeft?: number }>;
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
      const second = Math.round(e.tick * CLOCK_SECONDS_PER_TICK);
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
    async pendingFixtures(worldId) { return (await rpc<string[] | null>('admin_pending_fixtures', { p_world: worldId })) ?? []; },
    async isMember(worldId, userId) { return rpc<boolean>('admin_world_member', { p_world: worldId, p_user: userId }); },
    async claim(fixtureId, worker) {
      const r = await rpc<{ ok: boolean; attempts?: number; reason?: string }>('admin_claim_fixture', { p_fixture: fixtureId, p_worker: worker });
      return { ok: r.ok, attempts: r.attempts ?? 0, reason: r.reason };
    },
    async failed(fixtureId, error) { await rpc('admin_fixture_failed', { p_fixture: fixtureId, p_error: error }); },
    async fallback(fixtureId) { await rpc('admin_fallback_result', { p_fixture: fixtureId }); },
    async dueWorlds() { return (await rpc<string[] | null>('admin_due_worlds', {})) ?? []; },
    async sweep(worldId) {
      const r = await rpc<{ pending: string[] | null; training_left?: number; aging_left?: number }>('admin_sweep_world', { p_world: worldId });
      // Offene Hintergrundarbeit: KI-Training der Woche und Alterung nach dem Saisonwechsel
      return { pending: r.pending ?? [], trainingLeft: (r.training_left ?? 0) + (r.aging_left ?? 0) };
    },
    async finish(fixtureId, result) { await rpc('admin_finish_match', { p_fixture: fixtureId, p_result: toDbResult(result) }); },
  };
}
