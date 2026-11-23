import type { KitConfig } from '@fd/shared';
import { ApiError } from './api';
import type { ChoreoDesign, FlagDesign, UltraGroup } from './matchClient';
import type { ChoreoV2 } from './choreo/model';
import { requireSupabase } from './supabase';

/** Fankultur (Fahnen, Choreografien, Ultras), Stadionsound und Europapokal */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

export interface ClubAudio {
  id: string; club_id: string; kind: 'anthem' | 'chant'; ultra_id: string | null; name: string;
  source: 'synth' | 'upload'; storage_path: string | null; situation: string | null;
  is_official: boolean; is_signature: boolean; volume: number; enabled: boolean; created_at: string;
}
export type Kit = KitConfig;
export interface KitSet { home: Kit; away: Kit; special: Kit }
export interface FanCulture {
  club_id: string;
  kits: KitSet;
  club: { name: string; short: string; primary: string; secondary: string; capacity: number; design: import('./matchClient').StadiumDesign | null; attendance: number | null };
  flags: FlagDesign[];
  ultras: UltraGroup[];
  default_choreo_id: string | null;
  auto_choreo: boolean;
  choreos: Array<{ id: string; name: string; design: ChoreoDesign }>;
  audio: ClubAudio[];
  next_home: { fixture_id: string; date: string; label: string; opponent: string; kind: string; choreo_id: string | null } | null;
}
export interface EuropeTableRow { club_id: string; name: string; short: string; association: string; pos: number; reason?: string | null; points: number; gd: number; gf: number; played: number; won: number; drawn: number; lost: number }
export interface EuropeFixture {
  id: string; stage: string; group: string | null; leg: number | null; slot_key: string; date: string; status: string;
  home: { id: string; name: string; short: string; association: string }; away: { id: string; name: string; short: string; association: string };
  result: { home: number; away: number; hp: number | null; ap: number | null } | null;
}
export interface EuropeCompetition {
  id: string; kind: 'champions_league' | 'europa_league'; name: string;
  /** 8 Gruppen (ab Saison 2 mit 32 Teams); ältere Saisons: 4 */
  group_count?: number;
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
  choreoPrefs: (worldId: string) => rpc<{ random: boolean; saved: number }>('choreo_prefs', { p_world: worldId }),
  setChoreoRandom: (worldId: string, on: boolean) => rpc<void>('set_choreo_random', { p_world: worldId, p_on: on }),
  saveChoreo: (worldId: string, id: string | null, name: string, design: ChoreoDesign | ChoreoV2) => rpc<string>('save_choreo', { p_world: worldId, p_id: id, p_name: name, p_design: design }),
  deleteChoreo: (worldId: string, id: string) => rpc<void>('delete_choreo', { p_world: worldId, p_id: id }),
  setFixtureChoreo: (worldId: string, fixtureId: string, choreoId: string | null) => rpc<void>('set_fixture_choreo', { p_world: worldId, p_fixture: fixtureId, p_choreo: choreoId }),
  saveAudio: (worldId: string, id: string | null, payload: Record<string, unknown>) => rpc<string>('save_club_audio', { p_world: worldId, p_id: id, p_payload: payload }),
  setAudioRole: (worldId: string, id: string, role: 'official' | 'signature') => rpc<void>('set_audio_role', { p_world: worldId, p_id: id, p_role: role }),
  async deleteAudio(worldId: string, id: string): Promise<void> {
    const path = await rpc<string | null>('delete_club_audio', { p_world: worldId, p_id: id });
    if (path) await requireSupabase().storage.from(BUCKET).remove([path]).catch(() => undefined);
  },
  /** MP3 hochladen (max. 10 MB) – Pfad: <welt>/<verein>/<zufall>.mp3; verständliche Fehlermeldungen */
  async upload(worldId: string, clubId: string, file: File): Promise<string> {
    if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') throw new ApiError('Bitte eine MP3-Datei wählen (andere Formate werden nicht unterstützt).', 'invalid_file');
    if (file.size > 10 * 1024 * 1024) throw new ApiError(`Die Datei ist ${(file.size / 1048576).toFixed(1)} MB groß – erlaubt sind höchstens 10 MB.`, 'invalid_file');
    if (file.size < 1000) throw new ApiError('Die Datei ist leer oder beschädigt.', 'invalid_file');
    const sb = requireSupabase();
    const { data: sess } = await sb.auth.getSession();
    if (!sess.session) throw new ApiError('Du bist nicht angemeldet – bitte Seite neu laden und erneut anmelden.', 'not_signed_in');
    if (sess.session.expires_at && sess.session.expires_at * 1000 < Date.now() + 30_000) await sb.auth.refreshSession();
    const path = `${worldId}/${clubId}/${crypto.randomUUID()}.mp3`;
    const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: 'audio/mpeg', upsert: false, cacheControl: '31536000' });
    if (error) {
      const m = error.message || '';
      const status = (error as { statusCode?: string | number }).statusCode;
      if (/row-level security|unauthorized|403/i.test(m) || String(status) === '403')
        throw new ApiError('Keine Berechtigung für den Upload: Nur der Manager darf Dateien für seinen eigenen Verein hochladen. Falls du Manager bist: Seite neu laden (Sitzung erneuern) und das Datenbank-Update 0031 prüfen.', 'upload_forbidden');
      if (/bucket not found/i.test(m)) throw new ApiError('Der Speicher „club-audio“ fehlt – bitte das Datenbank-Update 0031 ausführen.', 'bucket_missing');
      if (/payload too large|exceeded|413/i.test(m)) throw new ApiError('Die Datei ist zu groß (höchstens 10 MB).', 'invalid_file');
      if (/mime|content type/i.test(m)) throw new ApiError('Nur MP3-Dateien (audio/mpeg) sind erlaubt.', 'invalid_file');
      throw new ApiError(`Upload fehlgeschlagen: ${m || 'unbekannter Fehler'}`, 'upload_failed');
    }
    return path;
  },
  /** Hochladen und speichern; schlägt das Speichern fehl, wird die Datei wieder entfernt (keine Leichen) */
  async uploadAndSave(worldId: string, clubId: string, file: File, payload: Record<string, unknown>): Promise<string> {
    const path = await fanApi.upload(worldId, clubId, file);
    try {
      return await rpc<string>('save_club_audio', { p_world: worldId, p_id: null, p_payload: { ...payload, storage_path: path } });
    } catch (e) {
      await requireSupabase().storage.from(BUCKET).remove([path]).catch(() => undefined);
      throw e;
    }
  },
  /** Länge einer Audiodatei speichern (bestimmt die Dauer des Einlaufs bei Hymnen) */
  setAudioDuration: (id: string, seconds: number) => rpc<void>('set_club_audio_duration', { p_id: id, p_seconds: Math.round(seconds * 100) / 100 }),
  /** Länge einer MP3 aus den Metadaten (ohne vollständiges Dekodieren) */
  mp3Duration: (file: File) => new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    a.src = url;
  }),
  publicUrl: (path: string) => requireSupabase().storage.from(BUCKET).getPublicUrl(path).data.publicUrl,
  saveKits: (worldId: string, kits: KitSet) => rpc<KitSet>('save_kits', { p_world: worldId, p_kits: kits }),
  prep: (worldId: string) => rpc<PrepState>('prep_state', { p_world: worldId }),
  prepChoice: (worldId: string, fixtureId: string, variant: 'home' | 'away' | 'special' | null, choreoId: string | null, setChoreo: boolean, confirm: boolean | null) =>
    rpc<PrepState>('set_prep_choice', { p_world: worldId, p_fixture: fixtureId, p_variant: variant, p_choreo: choreoId, p_set_choreo: setChoreo, p_confirm: confirm }),
  prepTick: (worldId: string) => rpc<unknown>('prep_tick', { p_world: worldId }),
  europe: (worldId: string) => rpc<{ season_id: string | null; first_season?: boolean; competitions: EuropeCompetition[] }>('europe_overview', { p_world: worldId }),
};

export interface PrepTeam { id: string; name: string; short: string; control: 'human' | 'ai'; kits: KitSet; kit: Kit & { variant: 'home' | 'away' | 'special' }; confirmed: boolean }
export interface PrepState {
  active: boolean;
  seconds_left?: number;
  label?: string;
  managers?: Array<{ club: string; username: string | null; confirmed: boolean }>;
  fixture?: {
    id: string; is_home: boolean; neutral: boolean;
    competition: { kind: string; tier: number | null; association: string | null; name: string } | null;
    home: PrepTeam; away: PrepTeam;
    stadium: { capacity: number; design: import('./matchClient').StadiumDesign | null } | null;
    choreo: (import('./matchClient').ChoreoDesign & { id: string; name: string }) | null;
    choreos: Array<{ id: string; name: string; design: import('./matchClient').ChoreoDesign }> | null;
    home_colors: [string, string];
  } | null;
}
