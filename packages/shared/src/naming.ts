import { INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH } from './constants.js';

/**
 * C7.1: Normalisierung für die Eindeutigkeitsprüfung von Vereinsnamen.
 * Muss identisch zur SQL-Funktion `fd.normalize_name()` arbeiten (siehe Migration 0001).
 * Groß-/Kleinschreibung, Akzente, Leerzeichen und Satzzeichen werden ignoriert.
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/œ/g, 'oe')
    .replace(/ł/g, 'l')
    .replace(/đ/g, 'd')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '');
}

export function isValidInviteCode(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false;
  for (const ch of code) if (!INVITE_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Eingaben wie " ab3 k7q " tolerant in das kanonische Format bringen. */
export function canonicalInviteCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}
