import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { checkMp3, worldAudioApi, WORLD_AUDIO_MAX_MB, type AudioCategory, type WorldAudioFile, type WorldAudioSettings } from '../lib/worldAudioApi';

const CATEGORIES: Array<{ key: AudioCategory; title: string; when: string }> = [
  { key: 'chant', title: 'Fangesänge',
    when: 'Gemeinsamer Fangesangpool aller KI-Vereine. Zu Beginn jeder Partie bekommt jedes KI-Fanlager zufällig 2–4 verschiedene Gesänge daraus (Heim und Gäste möglichst ohne Überschneidung, keine direkte Wiederholung). Wann und wie oft gesungen wird, richtet sich wie bisher nach Spielstand, Minute und Spielgeschehen.' },
  { key: 'boo', title: 'Buhrufe & Pfeifkonzerte',
    when: 'Unmut der Heimfans: hartes Foul des Gegners, Karte oder Elfmeter gegen die Heimmannschaft, deutlicher Rückstand, mehrere Gegentore, anhaltend schwache Leistung, Ballverluste bei Rückstand. Kurze Anlässe spielen einen kurzen Ausschnitt, Dateien ab 6 s dienen bei großem Frust auch als langes Pfeifkonzert. In einem normalen Spiel etwa 0–3 Mal.' },
  { key: 'goal', title: 'Torjubel',
    when: 'Nach jedem Tor eine zufällige Datei: beim Heimtor laut aus der ganzen Kurve, beim Auswärtstor nur aus dem kleineren Gästeblock. Fangesänge pausieren währenddessen; der Jubel endet spätestens beim Wiederanstoß (nach etwa 4–5 Sekunden).' },
];

interface QueueItem { key: string; name: string; progress: number; error: string | null; done: boolean }
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** Liga-Einstellungen (nur Host): zentrale KI-Stadionatmosphäre mit drei MP3-Kategorien */
export function LeagueSettings() {
  const { worldId = '' } = useParams();
  const [s, setS] = useState<WorldAudioSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try { setS(await worldAudioApi.settings(worldId)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  // Seite verlassen ⇒ Probehören beenden
  useEffect(() => () => { audio.current?.pause(); audio.current = null; }, []);

  const stop = () => { audio.current?.pause(); audio.current = null; setPlaying(null); };
  async function preview(f: WorldAudioFile) {
    if (playing === f.id) return stop();
    stop();
    try {
      const url = (await worldAudioApi.signedUrls([f.path], 600)).get(f.path);
      if (!url) throw new Error('Die Datei konnte nicht geladen werden.');
      const a = new Audio(url);
      audio.current = a; setPlaying(f.id);
      a.onended = () => { if (audio.current === a) stop(); };
      await a.play();
    } catch (e) { stop(); setError(`Probehören nicht möglich: ${(e as Error).message}`); }
  }

  if (!s && !error) return <Shell><Spinner label="Liga-Einstellungen werden geladen …" /></Shell>;
  if (s && !s.is_host) {
    return (
      <Shell>
        <Card className="mx-auto max-w-lg space-y-3" >
          <h1 className="display text-3xl font-bold uppercase" data-testid="not-host">Nur für den Liga-Host</h1>
          <p className="text-cream-dim">Die Liga-Einstellungen kann ausschließlich der Host dieser Liga öffnen und ändern.</p>
          <Link to={`/w/${worldId}/start`} className="text-gold hover:underline">← Zum Liga-Menü</Link>
        </Card>
      </Shell>
    );
  }
  return (
    <Shell>
      <Link to={`/w/${worldId}/start`} className="mb-3 inline-block text-cream-dim hover:text-cream">← Liga-Menü</Link>
      <h1 className="display text-4xl font-extrabold uppercase leading-none" data-testid="league-settings">Liga-Einstellungen{s ? ` · ${s.world.name}` : ''}</h1>
      <div className="mt-3"><ErrorBanner error={error} /></div>
      {s && (
        <>
          <section className="mt-6">
            <h2 className="display text-2xl font-bold uppercase">KI-Stadionatmosphäre</h2>
            <p className="mt-1 max-w-3xl text-cream-dim">
              Diese MP3-Dateien gelten für alle KI-Vereine der Liga und sind für alle Mitglieder gleich. Vereine mit menschlichem Manager
              behalten ihre eigenen Hymnen und Gesänge. Ohne Dateien läuft die normale Stadion-Grundatmosphäre.
            </p>
          </section>
          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            {CATEGORIES.map((c) => (
              <CategoryCard key={c.key} worldId={worldId} cat={c} limit={s.limit} files={s.files.filter((f) => f.category === c.key)}
                playing={playing} onPreview={preview} onChanged={load} onError={setError} />
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}

function CategoryCard({ worldId, cat, files, limit, playing, onPreview, onChanged, onError }: {
  worldId: string; cat: (typeof CATEGORIES)[number]; files: WorldAudioFile[]; limit: number; playing: string | null;
  onPreview: (f: WorldAudioFile) => void; onChanged: () => Promise<void>; onError: (e: string | null) => void;
}) {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = queue.some((q) => !q.done && !q.error);

  async function upload(list: FileList | File[]) {
    const all = Array.from(list);
    if (!all.length) return;
    onError(null);
    const items = all.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, progress: 0, error: checkMp3(f), done: false }));
    setQueue((q) => [...q.filter((x) => !x.done), ...items]);
    // nacheinander hochladen (stabil auch bei schwacher Verbindung), Fortschritt je Datei
    for (let i = 0; i < all.length; i++) {
      const it = items[i]!;
      if (it.error) continue;
      if (files.length + i >= limit) { setQueue((q) => q.map((x) => x.key === it.key ? { ...x, error: `Höchstens ${limit} Dateien je Kategorie.` } : x)); continue; }
      try {
        await worldAudioApi.upload(worldId, cat.key, all[i]!, (p) => setQueue((q) => q.map((x) => x.key === it.key ? { ...x, progress: p } : x)));
        setQueue((q) => q.map((x) => x.key === it.key ? { ...x, progress: 1, done: true } : x));
      } catch (e) {
        setQueue((q) => q.map((x) => x.key === it.key ? { ...x, error: (e as Error).message } : x));
      }
    }
    await onChanged();
    setQueue((q) => q.filter((x) => !x.done)); // erledigte ausblenden, Fehler bleiben sichtbar
  }

  async function remove(f: WorldAudioFile) {
    setBusy(f.id);
    try { await worldAudioApi.remove(f.id); await onChanged(); } catch (e) { onError((e as Error).message); }
    setBusy(null); setConfirm(null);
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2" data-testid={`cat-${cat.key}`}>
        <h3 className="display text-2xl font-bold uppercase">{cat.title}</h3>
        <span className="ml-auto" data-testid={`count-${cat.key}`}><Pill tone={files.length ? 'good' : 'warn'}>{files.length} {files.length === 1 ? 'Datei' : 'Dateien'}</Pill></span>
      </div>
      <p className="text-sm text-cream-dim">{cat.when}</p>
      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={`flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center transition ${drag ? 'border-gold bg-gold/10' : 'border-olive-600 hover:border-gold/60'}`}>
        <span className="display text-lg font-semibold uppercase">MP3 hierher ziehen oder auswählen</span>
        <span className="text-xs text-cream-dim">mehrere Dateien möglich · je höchstens {WORLD_AUDIO_MAX_MB} MB</span>
        <input ref={input} type="file" accept=".mp3,audio/mpeg" multiple className="sr-only" data-testid={`upload-${cat.key}`} disabled={uploading}
          onChange={(e) => { const fl = e.target.files; if (fl) void upload(Array.from(fl)); e.target.value = ''; }} />
      </label>
      {queue.length > 0 && (
        <ul className="space-y-1" data-testid={`queue-${cat.key}`}>
          {queue.map((q) => (
            <li key={q.key} className="text-sm">
              <div className="flex justify-between gap-2"><span className="truncate">{q.name}</span><span className="text-cream-dim">{q.error ? 'Fehler' : `${Math.round(q.progress * 100)} %`}</span></div>
              {q.error ? <p className="text-xs text-danger" data-testid="upload-error">{q.error}</p>
                : <div className="h-1.5 overflow-hidden rounded bg-olive-800"><div className="h-full bg-gold transition-all" style={{ width: `${Math.round(q.progress * 100)}%` }} /></div>}
            </li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-olive-800" data-testid={`list-${cat.key}`}>
        {files.length === 0 && <li className="py-2 text-sm text-cream-dim">Noch keine Dateien.</li>}
        {files.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2 py-2" data-testid="audio-item">
            <button type="button" onClick={() => onPreview(f)} data-testid="preview" aria-label={playing === f.id ? 'Stopp' : 'Probehören'}
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-full border ${playing === f.id ? 'border-gold bg-gold text-ink' : 'border-olive-600 hover:border-gold'}`}>
              {playing === f.id ? '■' : '▶'}
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold" data-testid="audio-name">{f.name}</p>
              <p className="text-xs text-cream-dim" data-testid="audio-duration">{fmt(Number(f.duration))}</p>
            </div>
            {confirm === f.id ? (
              <span className="flex gap-1">
                <Button variant="danger" className="min-h-9 px-3 text-sm" busy={busy === f.id} data-testid="confirm-delete" onClick={() => void remove(f)}>Löschen</Button>
                <Button variant="ghost" className="min-h-9 px-3 text-sm" onClick={() => setConfirm(null)}>Abbrechen</Button>
              </span>
            ) : (
              <Button variant="ghost" className="min-h-9 px-3 text-sm" data-testid="delete" onClick={() => setConfirm(f.id)}>Entfernen</Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
