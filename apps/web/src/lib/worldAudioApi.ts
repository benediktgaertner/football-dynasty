import { ApiError } from './api';
import { fanApi } from './fanApi';
import type { HostAudioFile } from './fanAudio';
import { requireSupabase, supabaseAnonKey, supabaseUrl } from './supabase';

/**
 * Liga-Einstellungen: KI-Stadionatmosphäre (Migration 0041).
 * Dateien liegen im privaten Bucket „world-audio“ unter <welt>/<kategorie>/<id>.mp3; Schreiben nur der Liga-Host
 * (geprüft in der Datenbank und per Storage-Policy), Lesen alle Mitglieder über kurzlebige signierte URLs.
 */
export const WORLD_AUDIO_BUCKET = 'world-audio';
export const WORLD_AUDIO_MAX_MB = 15;
export type AudioCategory = 'chant' | 'boo' | 'goal';

export interface WorldAudioFile { id: string; category: AudioCategory; name: string; path: string; duration: number; size: number | null; created_at: string }
export interface WorldAudioSettings { world: { id: string; name: string; status: string }; is_host: boolean; limit: number; files: WorldAudioFile[] }

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await requireSupabase().rpc(fn, args);
  if (error) throw new ApiError(error.message, error.hint || error.code || null);
  return data as T;
}

/** Datei prüfen, bevor etwas hochgeladen wird (verständliche Meldungen) */
export function checkMp3(file: File): string | null {
  if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') return `„${file.name}“ ist keine MP3-Datei.`;
  if (file.size > WORLD_AUDIO_MAX_MB * 1048576) return `„${file.name}“ ist ${(file.size / 1048576).toFixed(1)} MB groß – erlaubt sind höchstens ${WORLD_AUDIO_MAX_MB} MB.`;
  if (file.size < 1000) return `„${file.name}“ ist leer oder beschädigt.`;
  return null;
}

/** Upload mit Fortschritt (XMLHttpRequest an die Storage-REST-API, mit dem Benutzer-Token – kein Service-Role-Key) */
function putObject(path: string, file: File, token: string, onProgress?: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${supabaseUrl}/storage/v1/object/${WORLD_AUDIO_BUCKET}/${path}`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', supabaseAnonKey);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('content-type', 'audio/mpeg');
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError('Netzwerkfehler beim Hochladen – bitte Verbindung prüfen und erneut versuchen.', 'upload_failed'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); return resolve(); }
      let m = '';
      try { const j = JSON.parse(xhr.responseText || '{}') as { message?: string; error?: string }; m = j.message || j.error || ''; } catch { m = xhr.responseText; }
      if (xhr.status === 403 || /row-level security|unauthorized/i.test(m)) return reject(new ApiError('Keine Berechtigung: Nur der Liga-Host darf KI-Audiodateien hochladen.', 'upload_forbidden'));
      if (/bucket not found/i.test(m)) return reject(new ApiError('Der Speicher „world-audio“ fehlt – bitte das Datenbank-Update 0041 ausführen.', 'bucket_missing'));
      if (xhr.status === 413 || /too large|exceeded/i.test(m)) return reject(new ApiError(`Die Datei ist zu groß (höchstens ${WORLD_AUDIO_MAX_MB} MB).`, 'invalid_file'));
      if (/mime|content type/i.test(m)) return reject(new ApiError('Nur MP3-Dateien (audio/mpeg) sind erlaubt.', 'invalid_file'));
      reject(new ApiError(`Upload fehlgeschlagen: ${m || `Status ${xhr.status}`}`, 'upload_failed'));
    };
    xhr.send(file);
  });
}

export const worldAudioApi = {
  settings: (worldId: string) => rpc<WorldAudioSettings>('world_ai_audio_settings', { p_world: worldId }),

  /** eine MP3 hochladen und eintragen; misslingt das Eintragen, wird die Datei wieder entfernt */
  async upload(worldId: string, category: AudioCategory, file: File, onProgress?: (p: number) => void): Promise<WorldAudioFile> {
    const bad = checkMp3(file);
    if (bad) throw new ApiError(bad, 'invalid_file');
    const duration = await fanApi.mp3Duration(file);
    if (!duration) throw new ApiError(`„${file.name}“ lässt sich nicht abspielen (Dauer unbekannt) – bitte eine gültige MP3 wählen.`, 'invalid_file');
    const sb = requireSupabase();
    let { data: sess } = await sb.auth.getSession();
    if (!sess.session) throw new ApiError('Du bist nicht angemeldet – bitte Seite neu laden.', 'not_signed_in');
    if (sess.session.expires_at && sess.session.expires_at * 1000 < Date.now() + 60_000) ({ data: sess } = await sb.auth.refreshSession());
    const path = `${worldId}/${category}/${crypto.randomUUID()}.mp3`;
    await putObject(path, file, sess.session!.access_token, onProgress);
    try {
      return await rpc<WorldAudioFile>('add_world_ai_audio', { p_world: worldId, p_category: category, p_name: file.name.slice(0, 80), p_path: path, p_duration: Math.round(duration * 100) / 100, p_size: file.size });
    } catch (e) {
      await sb.storage.from(WORLD_AUDIO_BUCKET).remove([path]).catch(() => undefined);
      throw e;
    }
  },

  /** Eintrag löschen (prüft Host-Recht), danach die Datei im Storage */
  async remove(id: string): Promise<void> {
    const path = await rpc<string>('delete_world_ai_audio', { p_id: id });
    if (path) await requireSupabase().storage.from(WORLD_AUDIO_BUCKET).remove([path]).catch(() => undefined);
  },

  /** kurzlebige Abspiel-URLs (ein Aufruf für alle Dateien) */
  async signedUrls(paths: string[], seconds = 6 * 3600): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    if (!paths.length) return m;
    const { data, error } = await requireSupabase().storage.from(WORLD_AUDIO_BUCKET).createSignedUrls(paths, seconds);
    if (error) throw new ApiError(error.message, 'signed_url');
    for (const d of data ?? []) if (d.signedUrl && d.path) m.set(d.path, d.signedUrl);
    return m;
  },

  /** alle KI-Audiodateien der Liga für ein Spiel (einmal je Partie; gleiche Liste für alle Mitglieder) */
  async forMatch(worldId: string): Promise<HostAudioFile[]> {
    const s = await worldAudioApi.settings(worldId);
    const urls = await worldAudioApi.signedUrls(s.files.map((f) => f.path));
    return s.files.filter((f) => urls.has(f.path)).map((f) => ({ id: f.id, category: f.category, name: f.name, url: urls.get(f.path)!, duration: Number(f.duration) }));
  },
};
