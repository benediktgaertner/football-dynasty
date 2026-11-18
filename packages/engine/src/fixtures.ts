import { DEFAULT_ADVANCED_OPTIONS, DEFAULT_TEAM_INSTRUCTIONS, autoLineup, createRng, generateAiSquad, getFormation, type TacticalProfileName } from '@fd/shared';
import type { EnginePlayerInput, ProfileInput, TeamInput } from './types.js';

/** Testteam aus dem Weltgenerator (für Tests, Kalibrierung und KI-Testspiele). */
export function buildTestTeam(seed: string, target: number, opts: { formation?: string; name?: string; control?: 'human' | 'ai' } = {}): TeamInput {
  const rng = createRng(`team:${seed}`);
  const raw = generateAiSquad(rng, target, target >= 74 ? 1 : target >= 66 ? 2 : 3, new Set());
  const squad: EnginePlayerInput[] = raw.map((p, i) => ({
    id: `${seed}-${i}`,
    shirt: p.shirt,
    name: p.last,
    main_position: p.pos,
    secondary_positions: [...p.sec],
    overall: p.overall,
    fitness: 100,
    kind: p.kind,
    attributes: { ...(p.attrs as unknown as Record<string, number>) },
  }));
  const formation = getFormation(opts.formation ?? '4-4-2')!;
  const slots = autoLineup(formation.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y })), squad);
  const profile = (): ProfileInput => ({
    formation_code: formation.code,
    slots,
    team_instructions: { ...DEFAULT_TEAM_INSTRUCTIONS },
    advanced_options: { ...DEFAULT_ADVANCED_OPTIONS },
    instructions: {},
  });
  const profiles = { offensive: profile(), neutral: profile(), defensive: profile() } as Record<TacticalProfileName, ProfileInput>;
  profiles.offensive.team_instructions = { ...DEFAULT_TEAM_INSTRUCTIONS, mentality: 4, pressingIntensity: 4, defensiveLine: 4, tempo: 4 };
  profiles.defensive.team_instructions = { ...DEFAULT_TEAM_INSTRUCTIONS, mentality: 2, pressingIntensity: 2, defensiveLine: 2, tempo: 2 };
  const name = opts.name ?? `Team ${seed}`;
  return {
    clubId: seed,
    name,
    shortName: name.slice(0, 12),
    color: '#1d4ed8',
    colorAlt: '#ffffff',
    control: opts.control ?? 'ai',
    squad,
    profiles,
    settings: {
      active_profile: 'neutral', auto_substitutions: false, auto_switch_enabled: false, auto_switch_minute: null,
      auto_switch_when_trailing: null, auto_switch_when_leading: null, corner_routine: 'far_post', defensive_set_piece: 'zonal',
    },
    setPieces: {},
  };
}
