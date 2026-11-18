import { DRAFT_PICKS_PER_MANAGER, DRAFT_POOL_SIZE } from '../constants.js';

/**
 * D3: Snake-Draft. Runde 1: A–B–C, Runde 2: C–B–A, Runde 3: A–B–C …
 * `pickIndex` ist 0-basiert über den gesamten Draft.
 */
export function snakeDraftManagerIndex(managerCount: number, pickIndex: number): number {
  if (managerCount < 1) throw new RangeError('Mindestens ein Manager erforderlich');
  if (pickIndex < 0 || pickIndex >= totalDraftPicks(managerCount)) {
    throw new RangeError(`Pick ${pickIndex} liegt außerhalb des Drafts`);
  }
  const round = Math.floor(pickIndex / managerCount);
  const pos = pickIndex % managerCount;
  return round % 2 === 0 ? pos : managerCount - 1 - pos;
}

export function draftRound(managerCount: number, pickIndex: number): number {
  return Math.floor(pickIndex / managerCount) + 1;
}

export function totalDraftPicks(managerCount: number): number {
  return managerCount * DRAFT_PICKS_PER_MANAGER;
}

/** D3: Verbleibende Free Agents ergeben sich aus der tatsächlichen Teilnehmerzahl. */
export function remainingFreeAgentsAfterDraft(managerCount: number, poolSize = DRAFT_POOL_SIZE): number {
  const remaining = poolSize - totalDraftPicks(managerCount);
  if (remaining < 0) throw new RangeError('Draft-Pool zu klein für diese Teilnehmerzahl');
  return remaining;
}

/** Größte Teilnehmerzahl, die der Pool mit 22 Picks je Manager trägt (400 / 22 → 18). */
export const MAX_DRAFT_MANAGERS = Math.floor(DRAFT_POOL_SIZE / DRAFT_PICKS_PER_MANAGER);
