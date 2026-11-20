import { ApiError } from './api';
import type { ChoreoDesign, FlagDesign, UltraGroup } from './matchClient';
import type { Recipe } from './stadiumSound';
import { requireSupabase } from './supabase';

/** Fankultur (Fahnen, Choreografien, Ultras), Stadionsound und Europapokal */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export interface ClubAudio {
  id: string; club_id: string; kind: 'anthem' | 'chant'; ultra_id: string | null; name: string; style: string | null; mood: string | null; voice: string | null;
  lyrics: string | null; source: 'synth' | 'upload'; recipe: Recipe | null; storage_path: string | null; situation: string | null;
  is_official: boolean; is_signature: boolean; volume: number; enabled: boolean; created_at: string;
}
export interface FanCulture {
  club_id: string;
  club: { name: string; short: string; primary: string; secondary: string; capacity: number; design: import('./matchClient').StadiumDesign | null; attendance: number | null };
  flags: FlagDesign[];
  ultras: UltraGroup[];
  default_choreo_id: string | null;
  auto_choreo: boolean;
  choreos: Array<{ id: string; name: string; design: ChoreoDesign }>;
  audio: ClubAudio[];
  next_home: { fixture_id: string; date: string; label: string; opponent: string; kind: string; choreo_id: string | null } | null;
}
export interface EuropeTableRow { club_id: string; name: string; short: string; association: string; pos: number; points: number; gd: number; gf: number; played: number; won: number; drawn: number; lost: number }
export interface EuropeFixture {
  id: string; stage: string; group: string | null; leg: number | null; slot_key: string; date: string; status: string;
  home: { id: string; name: string; short: string; association: string }; away: { id: string; name: string; short: string; association: string };
  result: { home: number; away: number; hp: number | null; ap: number | null } | null;
}
export interface EuropeCompetition {
  id: string; kind: 'champions_league' | 'europa_league'; name: string;
  groups: Array<{ label: string; table: EuropeTableRow[] }>;
  fixtures: EuropeFixture[];
  winner: { id: string; name: string } | null;
  leaders: { scorers: Array<{ player: string; player_id: string; club: string; club_id: string; goals: number; assists: number; games: number }> };
}

const BUCKET = 'club-audio';

export const fanApi = {
  culture: (worldId: string) => rpc<FanCulture>('fan_culture', { p_world: worldId }),
  save: (worldId: string, flags: FlagDesign[], ultras: UltraGroup[], defaultChoreo: string | null, auto: boolean) =>
    rpc<FanCulture>('save_fan_culture', { p_world: worldId, p_flags: flags, p_ultras: ultras, p_default_choreo: defaultChoreo, p_auto: auto }),
  saveChoreo: (worldId: string, id: string | null, name: string, design: ChoreoDesign) => rpc<string>('save_choreo', { p_world: worldId, p_id: id, p_name: name, p_design: design }),
  deleteChoreo: (worldId: string, id: string) => rpc<void>('delete_choreo', { p_world: worldId, p_id: id }),
  setFixtureChoreo: (worldId: string, fixtureId: string, choreoId: string | null) => rpc<void>('set_fixture_choreo', { p_world: worldId, p_fixture: fixtureId, p_choreo: choreoId }),
  saveAudio: (worldId: string, id: string | null, payload: Record<string, unknown>) => rpc<string>('save_club_audio', { p_world: worldId, p_id: id, p_payload: payload }),
  setAudioRole: (worldId: string, id: string, role: 'official' | 'signature') => rpc<void>('set_audio_role', { p_world: worldId, p_id: id, p_role: role }),
  async deleteAudio(worldId: string, id: string): Promise<void> {
    const path = await rpc<string | null>('delete_club_audio', { p_world: worldId, p_id: id });
    if (path) await requireSupabase().storage.from(BUCKET).remove([path]).catch(() => undefined);
  },
  /** MP3 hochladen (max. 10 MB) – Pfad: <welt>/<verein>/<zufall>.mp3 */
  async upload(worldId: string, clubId: string, file: File): Promise<string> {
    if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') throw new ApiError('Bitte eine MP3-Datei wählen.', 'invalid_file');
    if (file.size > 10 * 1024 * 1024) throw new ApiError('Die Datei ist größer als 10 MB.', 'invalid_file');
    const path = `${worldId}/${clubId}/${crypto.randomUUID()}.mp3`;
    const { error } = await requireSupabase().storage.from(BUCKET).upload(path, file, { contentType: 'audio/mpeg', upsert: false });
    if (error) throw new ApiError(`Upload fehlgeschlagen: ${error.message}`, 'upload_failed');
    return path;
  },
  publicUrl: (path: string) => requireSupabase().storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
  europe: (worldId: string) => rpc<{ season_id: string | null; competitions: EuropeCompetition[] }>('europe_overview', { p_world: worldId }),
};
