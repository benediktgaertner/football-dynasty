import type { ClubProfileData } from './seasonApi';

type Slot = NonNullable<ClubProfileData['formation']>['slots'][number];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Macht die Antwort von club_profile robust gegen unvollständige Daten, damit ein einzelner fehlerhafter
 * Datensatz die Vereinsseite nicht zum Absturz bringt:
 * - Kader/Ergebnisse immer Arrays, Einträge ohne id bzw. ohne Gegner werden ausgelassen
 * - Formation nur, wenn eine Aufstellung mit Positionen vorliegt (Kompakt-Simulationen speichern nur Spieler-IDs)
 */
export function normalizeClubProfile(raw: unknown): ClubProfileData {
  if (!isObj(raw) || !isObj(raw.club)) throw new Error('Vereinsprofil konnte nicht geladen werden.');
  const r = raw as unknown as ClubProfileData;
  const squad = (Array.isArray(r.squad) ? r.squad : []).filter((p) => isObj(p) && typeof p.id === 'string')
    .map((p) => ({ ...p, name: p.name ?? '–', position: p.position ?? '', apps: p.apps ?? 0, goals: p.goals ?? 0, assists: p.assists ?? 0 }));
  const results = (Array.isArray(r.results) ? r.results : []).filter((x) => isObj(x) && typeof x.id === 'string' && isObj(x.opponent) && typeof x.opponent.id === 'string')
    .map((x) => ({ ...x, gf: num(x.gf) ?? 0, ga: num(x.ga) ?? 0 }));
  let formation: ClubProfileData['formation'] = null;
  if (isObj(r.formation) && Array.isArray(r.formation.slots)) {
    const slots: Slot[] = [];
    const seen = new Set<string>();
    for (const s of r.formation.slots as unknown[]) {
      if (!isObj(s) || typeof s.player_id !== 'string' || seen.has(s.player_id)) continue;
      const x = num(s.x), y = num(s.y);
      if (x === null || y === null) continue;
      seen.add(s.player_id);
      slots.push({ ...(s as unknown as Slot), x, y, position: typeof s.position === 'string' ? s.position : '' });
    }
    if (slots.length) formation = { date: r.formation.date, code: r.formation.code ?? '', slots };
  }
  const stadium = isObj(r.stadium) ? { name: String(r.stadium.name ?? ''), capacity: num(r.stadium.capacity) ?? 0 } : null;
  return { ...r, squad, results, formation, stadium, strength: num(r.strength), squad_avg: num(r.squad_avg) };
}
