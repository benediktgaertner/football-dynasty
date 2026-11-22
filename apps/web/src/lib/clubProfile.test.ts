import { describe, expect, it } from 'vitest';
import { normalizeClubProfile } from './clubProfile';

const club = { id: 'c1', name: 'FC Test', short_name: 'FCT', control: 'ai', color: '#fff', color2: '#000', crest: null };
const base = { club, founded: 1900, reputation: 50, amateur: false, country: { code: 'GER', name: 'Deutschland' }, league: 'Bundesliga', manager: null,
  stadium: { name: 'Arena', capacity: 30000 }, position: 1, table_size: 18, strength: 87.9, squad_avg: 84.4,
  squad: [{ id: 'p1', name: 'A B', last_name: 'B', shirt: 1, position: 'GK', age: 25, overall: 93, nationality: 'GER', fitness: 100, rating: null, apps: 0, goals: 0, assists: 0, status: null }],
  results: [{ id: 'f1', date: '2026-10-20', competition: 'CL', home: true, opponent: club, gf: 1, ga: 0, pf: null, pa: null }] };

describe('normalizeClubProfile', () => {
  it('Kompakt-Simulation: formation.slots = null ⇒ keine Formation statt Absturz', () => {
    const d = normalizeClubProfile({ ...base, formation: { date: '2026-10-20', code: null, slots: null } });
    expect(d.formation).toBeNull();
  });
  it('Aufstellung nur als ID-Liste ⇒ keine Formation', () => {
    expect(normalizeClubProfile({ ...base, formation: { date: '2026-10-20', code: '4-3-3', slots: ['p1', 'p2'] } }).formation).toBeNull();
  });
  it('vollständige Aufstellung bleibt erhalten, kaputte/doppelte Slots fallen weg', () => {
    const d = normalizeClubProfile({ ...base, formation: { date: '2026-10-20', code: '4-3-3', slots: [
      { player_id: 'p1', position: 'GK', x: 50, y: 5, name: 'B', shirt: 1, overall: 93 },
      { player_id: 'p1', position: 'CB', x: 30, y: 20, name: 'B', shirt: 1, overall: 93 },
      { player_id: null, position: 'CB', x: 30, y: 20 }, { player_id: 'p3', position: 'CB', x: null, y: 20 }] } });
    expect(d.formation?.slots.map((s) => s.player_id)).toEqual(['p1']);
  });
  it('fehlende Listen, Gegner und Stadion führen nicht zum Absturz', () => {
    const d = normalizeClubProfile({ ...base, squad: null, results: [{ id: 'x', opponent: null }], stadium: { name: 'S', capacity: null }, formation: null });
    expect(d.squad).toEqual([]);
    expect(d.results).toEqual([]);
    expect(d.stadium?.capacity).toBe(0);
  });
  it('keine Vereinsdaten ⇒ verständlicher Fehler (Fehlerbanner statt schwarzer Seite)', () => {
    expect(() => normalizeClubProfile(null)).toThrow(/Vereinsprofil/);
  });
});
