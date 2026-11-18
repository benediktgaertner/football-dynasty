import { z } from 'zod';
import { HEX_COLOR_RE } from './color.js';
import {
  CLUB_NAME_MAX,
  CLUB_NAME_MIN,
  CLUB_SHORT_NAME_MAX,
  CLUB_SHORT_NAME_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
} from './constants.js';
import { crestConfigSchema } from './crest.js';
import { isValidStadiumCapacity } from './rules/economy.js';

/**
 * Eingabeschemas. Der Client validiert damit für schnelle Rückmeldungen;
 * verbindlich sind die identischen Prüfungen in den SQL-RPCs (supabase/migrations).
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN, `Mindestens ${USERNAME_MIN} Zeichen`)
  .max(USERNAME_MAX, `Höchstens ${USERNAME_MAX} Zeichen`)
  .regex(/^[\p{L}\p{N}_.\- ]+$/u, 'Nur Buchstaben, Ziffern, Leerzeichen, Punkt, Binde- und Unterstrich');

export const KIT_PATTERNS = ['solid', 'stripes', 'hoops', 'halves', 'sash'] as const;

export const kitSchema = z.object({
  pattern: z.enum(KIT_PATTERNS),
  primary: z.string().regex(HEX_COLOR_RE),
  secondary: z.string().regex(HEX_COLOR_RE),
});
export type KitConfig = z.infer<typeof kitSchema>;

export const clubCreationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(CLUB_NAME_MIN, `Vereinsname: mindestens ${CLUB_NAME_MIN} Zeichen`)
    .max(CLUB_NAME_MAX, `Vereinsname: höchstens ${CLUB_NAME_MAX} Zeichen`)
    .regex(/^[\p{L}\p{N} .'&\-]+$/u, 'Vereinsname enthält unzulässige Zeichen'),
  shortName: z
    .string()
    .trim()
    .regex(new RegExp(`^[A-ZÄÖÜ0-9]{${CLUB_SHORT_NAME_MIN},${CLUB_SHORT_NAME_MAX}}$`, 'u'), 'Kurzname: 3–4 Großbuchstaben oder Ziffern'),
  primaryColor: z.string().regex(HEX_COLOR_RE),
  secondaryColor: z.string().regex(HEX_COLOR_RE),
  accentColor: z.string().regex(HEX_COLOR_RE),
  crest: crestConfigSchema,
  kit: kitSchema,
  stadiumName: z
    .string()
    .trim()
    .min(3, 'Stadionname: mindestens 3 Zeichen')
    .max(40, 'Stadionname: höchstens 40 Zeichen')
    .regex(/^[\p{L}\p{N} .'&\-]+$/u, 'Stadionname enthält unzulässige Zeichen'),
  stadiumCapacity: z.number().int().refine(isValidStadiumCapacity, 'Kapazität: 10.000–50.000 in 5.000er-Schritten'),
});
export type ClubCreationInput = z.infer<typeof clubCreationSchema>;

export const difficultySchema = z.enum(['easy', 'medium', 'hard']);
