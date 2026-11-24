import {
  DEFAULT_ADVANCED_OPTIONS,
  DEFAULT_TEAM_INSTRUCTIONS,
  type AdvancedOptions,
  type CrestConfig,
  type KitConfig,
  type LineupSlot,
  type Position,
  type TacticalProfileName,
  type TeamInstructions,
} from '@fd/shared';
import { ApiError } from './api';
import { requireSupabase } from './supabase';

/** Datenzugriff für das Team-Management (Phase 4). Schreiben nur über geprüfte RPCs. */

export interface SquadPlayer {
  id: string;
  first_name: string;
  last_name: string;
  nationality: string;
  age: number;
  main_position: Position;
  secondary_positions: Position[];
  overall: number;
  fitness: number;
  market_value: number;
  shirt_number: number | null;
  kind: 'outfield' | 'goalkeeper';
  attributes: Record<string, number>;
  contract_end: number | null;
  salary: number | null;
  /** Verletzung/Sperren/Einsatzberechtigung aus Supabase (fd_player_availability) */
  status?: PlayerStatus;
}

export interface PlayerStatus {
  injury: { kind: string; until: string; days: number; matches: number } | null;
  suspensions: Array<{ scope: 'league' | 'domestic_cup' | 'uefa'; card: 'yellow' | 'second_yellow' | 'red' | null; remaining: number }>;
  unavailable: boolean;
  next_scope: string | null;
  next_date: string | null;
}

export async function loadAvailability(clubId: string): Promise<Record<string, PlayerStatus>> {
  const { data, error } = await requireSupabase().rpc('squad_availability', { p_club: clubId });
  if (error) return {};
  return (data ?? {}) as Record<string, PlayerStatus>;
}

export interface ProfileState {
  id: string;
  name: TacticalProfileName;
  formation_code: string;
  team_instructions: TeamInstructions;
  advanced_options: AdvancedOptions;
  slots: LineupSlot[];
  instructions: Record<string, string[]>;
}

export interface ClubTactics {
  active_profile: TacticalProfileName;
  auto_substitutions: boolean;
  auto_switch_enabled: boolean;
  auto_switch_minute: number | null;
  auto_switch_when_trailing: TacticalProfileName | null;
  auto_switch_when_leading: TacticalProfileName | null;
  corner_routine: 'short' | 'near_post' | 'far_post' | 'penalty_spot';
  defensive_set_piece: 'zonal' | 'man' | 'mixed';
}

export interface SponsorOffer {
  id: number;
  tier: number;
  code: string;
  name: string;
  kind: string;
  amount: number;
  threshold: number | null;
}

export interface TeamContext {
  world_status: string;
  club_id: string;
  tier: number;
  league: string;
  season_year: number;
  week: number;
  balance: number;
  trainees_this_week: Array<{ player_id: string; focus: string }>;
  sponsor_offer_id: number | null;
  sponsor_offers: SponsorOffer[];
  readiness: Array<{ user_id: string; username: string; club: string | null; ready: boolean }>;
}

type Embedded<T> = T | T[] | null;
const one = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
const many = <T,>(v: Embedded<T>): T[] => (Array.isArray(v) ? v : v ? [v] : []);

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export async function loadTeam(worldId: string) {
  const sb = requireSupabase();
  const ctx = await rpc<TeamContext>('team_context', { p_world: worldId });
  const [squadRes, profilesRes, tacticsRes, setPiecesRes, brandingRes, clubRes] = await Promise.all([
    sb
      .from('players')
      .select('id, first_name, last_name, nationality, age, main_position, secondary_positions, overall, fitness, market_value, shirt_number, player_attributes(kind, attributes), player_contracts(end_season_year, annual_salary, active)')
      .eq('club_id', ctx.club_id),
    sb
      .from('tactical_profiles')
      .select('id, name, formation_code, team_instructions, advanced_options, tactical_profile_slots(slot_index, player_id, position, x, y), player_instructions(player_id, instructions)')
      .eq('club_id', ctx.club_id),
    sb.from('tactics').select('*').eq('club_id', ctx.club_id).single(),
    sb.from('set_piece_assignments').select('kind, priority, player_id').eq('club_id', ctx.club_id),
    sb.from('club_branding').select('primary_color, secondary_color, accent_color, crest, kit').eq('club_id', ctx.club_id).single(),
    sb.from('clubs').select('name, short_name').eq('id', ctx.club_id).single(),
  ]);
  for (const r of [squadRes, profilesRes, tacticsRes, setPiecesRes, brandingRes, clubRes]) {
    if (r.error) throw new ApiError(r.error.message, r.error.code);
  }

  const availability = await loadAvailability(ctx.club_id);
  const squad: SquadPlayer[] = (squadRes.data ?? []).map((row) => {
    const r = row as unknown as SquadPlayer & {
      player_attributes: Embedded<{ kind: 'outfield' | 'goalkeeper'; attributes: Record<string, number> }>;
      player_contracts: Embedded<{ end_season_year: number; annual_salary: number; active: boolean }>;
    };
    const attrs = one(r.player_attributes);
    const contract = many(r.player_contracts).find((c) => c.active) ?? null;
    return {
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      nationality: r.nationality,
      age: r.age,
      main_position: r.main_position,
      secondary_positions: r.secondary_positions ?? [],
      overall: r.overall,
      fitness: Number(r.fitness),
      market_value: r.market_value,
      shirt_number: r.shirt_number,
      kind: attrs?.kind ?? 'outfield',
      attributes: attrs?.attributes ?? {},
      contract_end: contract?.end_season_year ?? null,
      salary: contract?.annual_salary ?? null,
      status: availability[r.id],
    };
  });
  squad.sort((a, b) => (a.shirt_number ?? 99) - (b.shirt_number ?? 99));

  const profiles = (profilesRes.data ?? []).map((row) => {
    const r = row as unknown as {
      id: string;
      name: TacticalProfileName;
      formation_code: string;
      team_instructions: TeamInstructions;
      advanced_options: Partial<AdvancedOptions>;
      tactical_profile_slots: Array<{ slot_index: number; player_id: string | null; position: Position; x: number; y: number }>;
      player_instructions: Array<{ player_id: string; instructions: string[] }>;
    };
    return {
      id: r.id,
      name: r.name,
      formation_code: r.formation_code,
      team_instructions: { ...DEFAULT_TEAM_INSTRUCTIONS, ...r.team_instructions },
      advanced_options: { ...DEFAULT_ADVANCED_OPTIONS, ...r.advanced_options },
      slots: many(r.tactical_profile_slots)
        .map((s) => ({ slotIndex: s.slot_index, playerId: s.player_id, position: s.position, x: Number(s.x), y: Number(s.y) }))
        .sort((a, b) => a.slotIndex - b.slotIndex),
      instructions: Object.fromEntries(many(r.player_instructions).map((i) => [i.player_id, i.instructions])),
    } satisfies ProfileState;
  });

  const setPieces: Record<string, string[]> = {};
  for (const sp of (setPiecesRes.data ?? []) as Array<{ kind: string; priority: number; player_id: string }>) {
    (setPieces[sp.kind] ??= [])[sp.priority - 1] = sp.player_id;
  }

  const branding = brandingRes.data as { primary_color: string; secondary_color: string; accent_color: string; crest: CrestConfig; kit: KitConfig };
  const club = clubRes.data as { name: string; short_name: string };
  return { ctx, squad, profiles, tactics: tacticsRes.data as ClubTactics, setPieces, branding, club };
}

export const teamApi = {
  setShirtNumber: (worldId: string, playerId: string, number: number) =>
    rpc<void>('set_shirt_number', { p_world: worldId, p_player: playerId, p_number: number }),
  saveProfile(worldId: string, profile: ProfileState) {
    const lineupIds = new Set(profile.slots.map((s) => s.playerId));
    return rpc<void>('save_tactical_profile', {
      p_world: worldId,
      p_profile: profile.name,
      p_data: {
        formation_code: profile.formation_code,
        team_instructions: profile.team_instructions,
        advanced_options: profile.advanced_options,
        slots: profile.slots.map((s) => ({ slot_index: s.slotIndex, position: s.position, x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, player_id: s.playerId })),
        // nur Anweisungen für aufgestellte Spieler übertragen
        player_instructions: Object.fromEntries(Object.entries(profile.instructions).filter(([id, codes]) => lineupIds.has(id) && codes.length > 0)),
      },
    });
  },
  saveClubTactics: (worldId: string, t: ClubTactics) => rpc<void>('save_club_tactics', { p_world: worldId, p_data: t }),
  saveSetPieces: (worldId: string, sp: Record<string, string[]>) =>
    rpc<void>('save_set_pieces', { p_world: worldId, p_data: Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, v.filter(Boolean)])) }),
  train: (worldId: string, playerId: string, focus: string) => rpc<{ fitness: number; points?: number; total_points?: number; gains?: Record<string, number>; ovr_before?: number; ovr_after?: number }>('schedule_training', { p_world: worldId, p_player: playerId, p_focus: focus }),
  chooseSponsor: (worldId: string, offerId: number) => rpc<void>('choose_sponsor', { p_world: worldId, p_offer: offerId }),
  setReady: (worldId: string, ready: boolean) => rpc<void>('set_preseason_ready', { p_world: worldId, p_ready: ready }),
};
