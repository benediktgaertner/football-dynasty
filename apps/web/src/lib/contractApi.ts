import type { ContractInputs } from '@fd/shared';
import { ApiError } from './api';
import { requireSupabase } from './supabase';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export interface ContractPlan { action: 'renew' | 'leave'; salary: number | null; years: number | null; end_year: number | null; barometer: number | null }
export interface ContractPlayer {
  player_id: string; name: string; position: string; age: number; overall: number; overall_change: number;
  appearances: number; minutes: number; rating: number | null; minutes_share: number | null;
  salary: number; contract_years: number; remaining: number; end_year: number; expiring: boolean;
  market_value: number; market_salary: number; elite: boolean; termination_fee: number;
  inputs: Omit<ContractInputs, 'offeredSalary' | 'years'>; plan: ContractPlan | null;
}
export interface ContractOverview {
  phase: { active: boolean; can_edit: boolean; season_year: number; slot_state: string; status: string };
  balance: number; squad_size: number; min_squad: number; wage_now: number; wage_next: number;
  players: ContractPlayer[];
}
export interface NegotiateResult { accepted: boolean; barometer: number; message: string; player: ContractPlayer }

export const contractApi = {
  overview: (worldId: string) => rpc<ContractOverview>('contract_overview', { p_world: worldId }),
  negotiate: (playerId: string, salary: number, years: number) => rpc<NegotiateResult>('contract_negotiate', { p_player: playerId, p_salary: salary, p_years: years }),
  setLeave: (playerId: string, leave: boolean) => rpc<{ status: string; player: ContractPlayer }>('contract_set_leave', { p_player: playerId, p_leave: leave }),
  terminate: (playerId: string) => rpc<{ status: string; compensation: number; message: string }>('contract_terminate', { p_player: playerId }),
};
