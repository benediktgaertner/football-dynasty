import {
  DEFAULT_ADVANCED_OPTIONS,
  DEFAULT_TEAM_INSTRUCTIONS,
  TACTICAL_PROFILE_NAMES,
  getFormation,
  type Position,
  type TacticalProfileName,
} from '@fd/shared';
import type { EnginePlayerInput, MatchSetup, ProfileInput, TeamInput } from '@fd/engine';

/** Form, die admin_match_setup (Migration 0013) liefert */
export interface DbTeam {
  clubId: string;
  name: string;
  shortName: string;
  control: 'human' | 'ai';
  managerUserId: string | null;
  color: string;
  colorAlt: string;
  kit?: { pattern: string; primary: string; secondary: string } | null;
  capacity?: number | null;
  squad: Array<{
    id: string; shirt: number; name: string; first_name?: string; main_position: Position; secondary_positions: Position[];
    overall: number; fitness: number | string; kind: 'outfield' | 'goalkeeper'; attributes: Record<string, number>;
    unavailable: boolean; nationality?: string; region?: string; age?: number;
  }>;
  settings: Partial<TeamInput['settings']> | null;
  profiles: Partial<Record<TacticalProfileName, {
    formation_code: string; team_instructions: ProfileInput['team_instructions']; advanced_options: Partial<ProfileInput['advanced_options']>;
    slots: Array<{ slotIndex: number; position: Position; x: number | string; y: number | string; playerId: string | null }>;
    instructions: Record<string, string[]>;
  }>>;
  setPieces: TeamInput['setPieces'];
}

export interface DbSetup {
  fixtureId: string;
  worldId: string;
  seed: string;
  kind: string;
  neutral: boolean;
  home: DbTeam;
  away: DbTeam;
  checkpoint: { tick: number; log: unknown[] } | null;
}

function profileFrom(raw: DbTeam['profiles'][TacticalProfileName] | undefined): ProfileInput {
  const formation = getFormation(raw?.formation_code ?? '4-4-2') ?? getFormation('4-4-2')!;
  return {
    formation_code: formation.code,
    slots: raw?.slots?.length === 11
      ? raw.slots.map((s) => ({ slotIndex: s.slotIndex, position: s.position, x: Number(s.x), y: Number(s.y), playerId: s.playerId }))
      : formation.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y, playerId: null })),
    team_instructions: { ...DEFAULT_TEAM_INSTRUCTIONS, ...(raw?.team_instructions ?? {}) },
    advanced_options: { ...DEFAULT_ADVANCED_OPTIONS, ...(raw?.advanced_options ?? {}) },
    instructions: raw?.instructions ?? {},
  };
}

export function toTeamInput(t: DbTeam): TeamInput {
  const squad: EnginePlayerInput[] = t.squad.map((p) => ({
    id: p.id, shirt: p.shirt, name: p.name, main_position: p.main_position, secondary_positions: p.secondary_positions ?? [],
    overall: p.overall, fitness: Number(p.fitness), kind: p.kind, attributes: p.attributes, unavailable: p.unavailable,
  }));
  const profiles = Object.fromEntries(TACTICAL_PROFILE_NAMES.map((n) => [n, profileFrom(t.profiles?.[n] ?? t.profiles?.neutral)])) as Record<TacticalProfileName, ProfileInput>;
  const s = t.settings ?? {};
  return {
    clubId: t.clubId, name: t.name, shortName: t.shortName, color: t.color, colorAlt: t.colorAlt, control: t.control, squad, profiles,
    settings: {
      active_profile: s.active_profile ?? 'neutral',
      auto_substitutions: s.auto_substitutions ?? false,
      auto_switch_enabled: s.auto_switch_enabled ?? false,
      auto_switch_minute: s.auto_switch_minute ?? null,
      auto_switch_when_trailing: s.auto_switch_when_trailing ?? null,
      auto_switch_when_leading: s.auto_switch_when_leading ?? null,
      corner_routine: s.corner_routine ?? 'far_post',
      defensive_set_piece: s.defensive_set_piece ?? 'mixed',
    },
    setPieces: t.setPieces ?? {},
  };
}

/** I5: Heimvorteil steigt leicht mit der Stadiongröße (10.000 → 0, 50.000 → 0,02). Neutraler Platz: 0. */
export function toEngineSetup(db: DbSetup): MatchSetup {
  const cap = db.home.capacity ?? 10000;
  return {
    seed: db.seed,
    home: toTeamInput(db.home),
    away: toTeamInput(db.away),
    homeAdvantage: db.neutral ? -0.04 : Math.max(0, Math.min(0.02, ((cap - 10000) / 40000) * 0.02)),
  };
}
