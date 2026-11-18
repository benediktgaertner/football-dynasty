import { describe, expect, it } from 'vitest';
import {
  ADVANCED_OPTIONS,
  DEFAULT_ADVANCED_OPTIONS,
  DEFAULT_TEAM_INSTRUCTIONS,
  FORMATIONS,
  PLAYER_INSTRUCTIONS,
  TEAM_SETTINGS,
  advancedOptionsSchema,
  autoLineup,
  buildWorldInitialization,
  clampSlotCoordinates,
  effectiveRating,
  getFormation,
  matchReadyRating,
  positionFromCoordinates,
  roleGroup,
  teamInstructionsSchema,
  trainingAgeMultiplier,
  trainingDevelopmentPoints,
  validateLineup,
  validatePlayerInstructions,
  type Position,
  type SquadPlayerForLineup,
} from '../src/index.js';

describe('E2: Mannschaftstaktik', () => {
  it('genau zwölf Grundeinstellungen mit Beschriftung je Wert', () => {
    expect(Object.keys(TEAM_SETTINGS)).toHaveLength(12);
    for (const s of Object.values(TEAM_SETTINGS)) expect(s.valueLabels.length).toBe(s.values.length);
    for (const s of Object.values(ADVANCED_OPTIONS)) expect(s.valueLabels.length).toBe(s.values.length);
  });
  it('Standardwerte sind gültig, fremde Schlüssel und falsche Werte nicht', () => {
    expect(teamInstructionsSchema.safeParse(DEFAULT_TEAM_INSTRUCTIONS).success).toBe(true);
    expect(advancedOptionsSchema.safeParse(DEFAULT_ADVANCED_OPTIONS).success).toBe(true);
    expect(teamInstructionsSchema.safeParse({ ...DEFAULT_TEAM_INSTRUCTIONS, secretBonus: 5 }).success).toBe(false);
    expect(teamInstructionsSchema.safeParse({ ...DEFAULT_TEAM_INSTRUCTIONS, tempo: 6 }).success).toBe(false);
    expect(advancedOptionsSchema.safeParse({ ...DEFAULT_ADVANCED_OPTIONS, restDefense: 5 }).success).toBe(false);
  });
});

describe('E3: Spieleranweisungen', () => {
  it('jede Position hat passende Anweisungen', () => {
    expect(roleGroup('ST')).toBe('FWD');
    expect(roleGroup('LWB')).toBe('FB');
    expect(PLAYER_INSTRUCTIONS.GK.map((i) => i.code)).toContain('sweeper_keeper');
  });
  it('lehnt unpassende und widersprüchliche Anweisungen ab', () => {
    expect(validatePlayerInstructions('ST', ['run_in_behind', 'shoot_more'])).toBeNull();
    expect(validatePlayerInstructions('ST', ['overlap'])).not.toBeNull();
    expect(validatePlayerInstructions('CM', ['safe_passes', 'risky_passes'])).not.toBeNull();
    expect(validatePlayerInstructions('GK', ['long_kicks', 'long_kicks'])).not.toBeNull();
  });
});

describe('E1: Freie Positionierung', () => {
  it('leitet die Rolle aus der Feldposition ab', () => {
    expect(positionFromCoordinates(50, 20, false)).toBe('CB');
    expect(positionFromCoordinates(12, 20, false)).toBe('LB');
    expect(positionFromCoordinates(50, 36, false)).toBe('CDM');
    expect(positionFromCoordinates(88, 50, false)).toBe('RM');
    expect(positionFromCoordinates(50, 64, false)).toBe('CAM');
    expect(positionFromCoordinates(50, 85, false)).toBe('ST');
    expect(positionFromCoordinates(50, 85, true)).toBe('GK');
  });
  it('hält Torwart im Strafraum und Feldspieler aus dem Tor', () => {
    expect(clampSlotCoordinates(50, 60, true)).toEqual({ x: 50, y: 14 });
    expect(clampSlotCoordinates(-10, 2, false)).toEqual({ x: 4, y: 12 });
  });
});

const world = buildWorldInitialization('tactics', [{ id: 'h', name: 'Test', short_name: 'TES' }]);
const squad: SquadPlayerForLineup[] = world.players
  .filter((p) => p.club_key === 'ai20')
  .map((p, i) => ({ id: `p${i}`, main_position: p.pos as Position, secondary_positions: p.sec as Position[], overall: p.overall, fitness: 100 }));

describe('Aufstellung', () => {
  it('Auto-Aufstellung füllt alle 30 Formationen gültig, mit genau einem Torwart', () => {
    const ids = new Set(squad.map((p) => p.id));
    for (const f of FORMATIONS) {
      const lineup = autoLineup(f.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y })), squad);
      expect(validateLineup(lineup, ids), f.code).toBeNull();
      const gk = lineup.find((s) => s.position === 'GK')!;
      expect(squad.find((p) => p.id === gk.playerId)!.main_position).toBe('GK');
    }
  });
  it('überspringt verletzte Spieler und bevorzugt fitte', () => {
    const f = getFormation('4-4-2')!;
    const slots = f.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y }));
    const bestGk = [...squad].filter((p) => p.main_position === 'GK').sort((a, b) => b.overall - a.overall)[0]!;
    const lineup = autoLineup(slots, squad.map((p) => (p.id === bestGk.id ? { ...p, unavailable: true } : p)));
    expect(lineup.map((s) => s.playerId)).not.toContain(bestGk.id);
  });
  it('erkennt ungültige Aufstellungen', () => {
    const f = getFormation('4-3-3')!;
    const lineup = autoLineup(f.slots.map((s) => ({ slotIndex: s.index, position: s.position, x: s.x, y: s.y })), squad);
    const ids = new Set(squad.map((p) => p.id));
    expect(validateLineup(lineup.slice(0, 10), ids)).not.toBeNull();
    expect(validateLineup(lineup.map((s, i) => (i === 1 ? { ...s, playerId: lineup[2]!.playerId } : s)), ids)).toContain('doppelt');
    expect(validateLineup(lineup.map((s, i) => (i === 1 ? { ...s, position: 'GK' as const } : s)), ids)).toContain('Torwart');
    expect(validateLineup(lineup.map((s, i) => (i === 1 ? { ...s, playerId: 'fremd' } : s)), ids)).toContain('Kader');
  });
  it('effektive Stärke berücksichtigt Position und Fitness', () => {
    const st = { main_position: 'ST' as const, secondary_positions: [] as Position[], overall: 80, fitness: 100 };
    expect(effectiveRating(st, 'ST')).toBe(80);
    expect(effectiveRating(st, 'CB')).toBeLessThan(70);
    expect(matchReadyRating({ ...st, fitness: 50 }, 'ST')).toBeLessThan(70);
  });
});

describe('G1/G4: Training', () => {
  it('Altersmultiplikatoren', () => {
    expect([18, 22, 25, 29, 32, 35].map(trainingAgeMultiplier)).toEqual([1.5, 1.3, 1, 0.75, 0.5, 0.25]);
  });
  it('Spieler ohne Luft nach oben profitieren kaum', () => {
    expect(trainingDevelopmentPoints(19, 70, 85)).toBe(1.5);
    expect(trainingDevelopmentPoints(19, 85, 85)).toBe(0.3);
  });
});
