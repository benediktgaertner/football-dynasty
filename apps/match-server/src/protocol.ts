import { z } from 'zod';
import { TACTICAL_PROFILE_NAMES } from '@fd/shared';

/** Client → Server. Alles wird validiert; der Server vertraut keiner Client-Angabe außer dem Token. */
const profileName = z.enum(TACTICAL_PROFILE_NAMES as unknown as [string, ...string[]]);
const uuidish = z.string().min(1).max(64);

export const engineCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), name: profileName }),
  z.object({ kind: z.literal('settings'), team_instructions: z.record(z.union([z.number(), z.string()])) }),
  z.object({ kind: z.literal('sub'), outId: uuidish, inId: uuidish }),
  z.object({ kind: z.literal('move'), playerId: uuidish, x: z.number().finite(), y: z.number().finite() }),
  z.object({ kind: z.literal('instructions'), playerId: uuidish, codes: z.array(z.string().max(40)).max(5) }),
  z.object({ kind: z.literal('set_piece'), role: z.enum(['free_kick', 'penalty', 'corner', 'throw_in']), playerId: uuidish }),
]);

export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().min(10).max(4096), fixtureId: uuidish }),
  z.object({ t: z.literal('start') }),
  /** Einlauf: gemeinsam überspringen (jeder anwesende Manager muss zustimmen) */
  z.object({ t: z.literal('skip_walkout') }),
  /** Einlauf: gemessene Länge der Heimhymne (nur Heim-Manager, nur falls nicht gespeichert) */
  z.object({ t: z.literal('anthem'), durationMs: z.number().int().min(1000).max(900_000) }),
  z.object({ t: z.literal('cmd'), id: z.number().int().nonnegative(), cmd: engineCommandSchema }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
