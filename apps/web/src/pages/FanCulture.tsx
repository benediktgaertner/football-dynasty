import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Shell, Spinner, TextInput } from '../components/ui';
import { BLOCK_LABEL, drawFlag, flagSpots, renderChoreoDesign, renderUltrasLayer } from '../lib/fanArt';
import { fanApi, type ClubAudio, type FanCulture as FanData } from '../lib/fanApi';
import type { ChoreoDesign, FlagDesign, StadiumDesign, StandBlock, UltraGroup } from '../lib/matchClient';
import { L, W, renderFanLayers, renderStadiumLayer, stadiumMargin } from '../lib/stadiumArt';
import {
  ANTHEM_STYLES, CHANT_STYLES, MOODS, SITUATIONS, VOICES, generateLyrics, makeRecipe, stadiumSound,
  type Mood, type PlayHandle, type Recipe, type Voice,
} from '../lib/stadiumSound';

type Club = { name: string; short: string; primary: string; secondary: string; capacity: number; design: StadiumDesign | null; attendance: number | null };

const SHAPES: Array<[FlagDesign['shape'], string]> = [['rect', 'Rechteck'], ['square', 'Quadrat'], ['triangle', 'Wimpel'], ['swallow', 'Schwalbenschwanz'], ['banner', 'Langfahne']];
const SIZES: Array<[FlagDesign['size'], string]> = [['s', 'Klein'], ['m', 'Mittel'], ['l', 'Groß']];
const FLAG_PATTERNS: Array<[FlagDesign['pattern'], string]> = [['solid', 'Einfarbig'], ['stripes_h', 'Querstreifen'], ['stripes_v', 'Längsstreifen'], ['diagonal', 'Diagonal'], ['halves', 'Halbiert'], ['cross', 'Kreuz'], ['checker', 'Karo'], ['star', 'Stern']];
const CHOREO_PATTERNS: Array<[ChoreoDesign['pattern'], string]> = [['stripes', 'Streifen'], ['blocks', 'Blöcke'], ['checker', 'Schachbrett'], ['wave', 'Welle'], ['gradient', 'Verlauf'], ['rays', 'Strahlen'], ['mosaic', 'Mosaik']];
const MOTIFS: Array<[NonNullable<ChoreoDesign['motif']>, string]> = [['none', 'Kein Motiv'], ['star', 'Stern'], ['heart', 'Herz'], ['crown', 'Krone'], ['crest', 'Wappen'], ['lion', 'Löwe'], ['eagle', 'Adler'], ['anchor', 'Anker'], ['castle', 'Burg']];
const CHOREO_BLOCKS: Array<[NonNullable<ChoreoDesign['block']>, string]> = [['home_curve', 'Heimkurve'], ['main_stand', 'Haupttribüne'], ['back_stand', 'Gegengerade'], ['all', 'Ganzes Stadion']];

const sel = 'min-h-11 w-full rounded-lg border border-olive-600 bg-olive-900 px-2 text-cream';

/** Fankultur & Musik: Schwenkfahnen, Choreografien, Ultragruppen, Hymnen und Fangesänge (kostenlos, rein optisch/akustisch) */
export function FanCulture() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<FanData | null>(null);
  const [flags, setFlags] = useState<FlagDesign[]>([]);
  const [ultras, setUltras] = useState<UltraGroup[]>([]);
  const [defChoreo, setDefChoreo] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [draft, setDraft] = useState<{ id: string | null; name: string; design: ChoreoDesign }>({ id: null, name: '', design: { pattern: 'stripes', colors: ['#c8102e', '#ffffff'], text: '', motif: 'star', block: 'home_curve' } });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fanApi.culture(worldId);
      setData(d); setFlags(d.flags); setUltras(d.ultras); setDefChoreo(d.default_choreo_id); setAuto(d.auto_choreo);
      setDraft((x) => (x.design.colors[0] === '#c8102e' && d.club.primary ? { ...x, design: { ...x.design, colors: [d.club.primary, d.club.secondary], text: d.club.short } } : x));
    } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => stadiumSound.stopAll(), []);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setError(null); setMsg(null);
    try { await fn(); await load(); setMsg(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!data) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Fankultur wird geladen …" />}</Shell>;
  const club = data.club;
  const preview = draft.name || draft.id ? draft.design : (data.choreos.find((c) => c.id === defChoreo)?.design ?? draft.design);

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h1 className="display text-4xl font-extrabold uppercase">Fankultur & Musik</h1>
        <span className="text-sm text-cream-dim">kostenlos · rein optisch und akustisch – keine Stadionkosten, keine sportlichen Boni</span>
      </div>
      <ErrorBanner error={error} />
      {msg && <p className="mb-2 text-sm text-emerald-300">{msg}</p>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Vorschau</h2>
          <FanPreview club={club} flags={flags} ultras={ultras} choreo={preview} />
          <p className="mt-2 text-xs text-cream-dim">Die Zuschauerzahl im Spiel entspricht der echten Auslastung ({club.capacity.toLocaleString('de-DE')} Plätze{club.attendance ? `, zuletzt ${club.attendance.toLocaleString('de-DE')}` : ''}). Choreografien zeigen sich beim Einlauf und vor dem Anpfiff.</p>
        </Card>

        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Choreografie</h2>
          <ChoreoEditor draft={draft} setDraft={setDraft} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button busy={busy === 'ch'} disabled={draft.name.trim().length < 2} onClick={() => void act('ch', async () => {
              const id = await fanApi.saveChoreo(worldId, draft.id, draft.name, draft.design);
              setDraft((d) => ({ ...d, id }));
            }, 'Choreografie gespeichert.')}>{draft.id ? 'Änderungen speichern' : 'Als neue Choreo speichern'}</Button>
            {draft.id && <Button variant="ghost" onClick={() => setDraft({ id: null, name: '', design: { ...draft.design } })}>Als Kopie neu</Button>}
          </div>
          {data.choreos.length > 0 && (
            <ul className="mt-3 divide-y divide-olive-700/50 text-sm">
              {data.choreos.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <span className="flex gap-0.5">{c.design.colors.map((x, i) => <span key={i} className="h-4 w-4 rounded-sm border border-black/40" style={{ background: x }} />)}</span>
                  <span className="flex-1 font-semibold">{c.name}{defChoreo === c.id && <span className="ml-2 text-xs text-gold">Standard</span>}</span>
                  <button type="button" className="text-gold underline" onClick={() => setDraft({ id: c.id, name: c.name, design: c.design })}>Bearbeiten</button>
                  <button type="button" className="text-cream-dim underline" onClick={() => setDefChoreo(c.id)}>Als Standard</button>
                  <button type="button" className="text-red-300 underline" onClick={() => { if (confirm(`„${c.name}“ löschen?`)) void act('del' + c.id, () => fanApi.deleteChoreo(worldId, c.id), 'Choreografie gelöscht.'); }}>Löschen</button>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-5 w-5 accent-[var(--fd-accent)]" />
            Automatische Standardchoreografie, wenn für ein Heimspiel keine gewählt wurde</label>
          {data.next_home && (
            <div className="mt-3 rounded-xl border border-olive-600 p-3">
              <p className="text-sm">Nächstes Heimspiel: <span className="font-semibold">{data.next_home.label}</span> gegen {data.next_home.opponent}</p>
              <select className={`${sel} mt-2`} value={data.next_home.choreo_id ?? ''} onChange={(e) => void act('fx', () => fanApi.setFixtureChoreo(worldId, data.next_home!.fixture_id, e.target.value || null), 'Choreografie für das Heimspiel gewählt.')}>
                <option value="">{auto ? 'Standard / automatisch' : 'Keine Choreografie'}</option>
                {data.choreos.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="display text-2xl font-bold uppercase">Schwenkfahnen</h2>
            <Button variant="secondary" disabled={flags.length >= 8} onClick={() => setFlags((f) => [...f, { shape: 'rect', size: 'm', pattern: 'stripes_h', colors: [club.primary, club.secondary], text: '' }])}>+ Fahne</Button>
          </div>
          {flags.length === 0 && <p className="text-sm text-cream-dim">Noch keine Fahnen – ohne eigene Fahnen schwenken die Fans neutrale Vereinsfahnen.</p>}
          <div className="space-y-3">
            {flags.map((f, i) => (
              <FlagEditor key={i} flag={f} onChange={(nf) => setFlags((all) => all.map((x, k) => (k === i ? nf : x)))} onRemove={() => setFlags((all) => all.filter((_, k) => k !== i))} />
            ))}
          </div>
        </Card>
        <Card>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="display text-2xl font-bold uppercase">Ultragruppen</h2>
            <Button variant="secondary" disabled={ultras.length >= 4} onClick={() => setUltras((u) => [...u, { id: `u-${crypto.randomUUID().slice(0, 8)}`, name: '', colors: [club.primary, '#111111'], banner: '', block: 'home_curve', flag: null }])}>+ Gruppe</Button>
          </div>
          {ultras.length === 0 && <p className="text-sm text-cream-dim">Fiktive Fangruppen mit eigenem Namen, Farben, Zaunfahne und Block.</p>}
          <div className="space-y-3">
            {ultras.map((u, i) => (
              <UltraEditor key={u.id} ultra={u} onChange={(nu) => setUltras((all) => all.map((x, k) => (k === i ? nu : x)))} onRemove={() => setUltras((all) => all.filter((_, k) => k !== i))} />
            ))}
          </div>
        </Card>
      </div>
      <div className="mt-3">
        <Button busy={busy === 'save'} onClick={() => void act('save', () => fanApi.save(worldId, flags, ultras.map((u) => ({ ...u, name: u.name.trim() })), defChoreo, auto), 'Fahnen, Ultragruppen und Standard gespeichert – gilt ab dem nächsten Heimspiel.')}>
          Fahnen, Ultras & Standard speichern
        </Button>
      </div>

      <AudioLibrary worldId={worldId} club={club} clubId={data.club_id} audio={data.audio} ultras={data.ultras} onChange={load} />
    </Shell>
  );
}

function ColorList({ colors, max, onChange }: { colors: string[]; max: number; onChange: (c: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {colors.map((c, i) => (
        <span key={i} className="relative">
          <input type="color" value={c} onChange={(e) => onChange(colors.map((x, k) => (k === i ? e.target.value : x)))} className="h-10 w-12 cursor-pointer rounded-lg border border-olive-600 bg-transparent" aria-label={`Farbe ${i + 1}`} />
          {colors.length > 1 && <button type="button" onClick={() => onChange(colors.filter((_, k) => k !== i))} className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-ink text-xs text-cream" aria-label="Farbe entfernen">×</button>}
        </span>
      ))}
      {colors.length < max && <button type="button" onClick={() => onChange([...colors, '#ffffff'])} className="h-10 rounded-lg border border-dashed border-olive-600 px-2 text-sm text-cream-dim">+ Farbe</button>}
    </div>
  );
}

function FlagCanvas({ flag, animate = true }: { flag: FlagDesign; animate?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    const t0 = performance.now();
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawFlag(ctx, cv.width * 0.18, cv.height * 0.95, cv.height / 6.2, flag, animate ? (performance.now() - t0) / 1000 : 0);
      if (animate) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [flag, animate]);
  return <canvas ref={ref} className="h-24 w-32 rounded-lg bg-olive-900" aria-label="Fahnenvorschau" />;
}

function FlagEditor({ flag, onChange, onRemove }: { flag: FlagDesign; onChange: (f: FlagDesign) => void; onRemove?: () => void }) {
  const set = (p: Partial<FlagDesign>) => onChange({ ...flag, ...p });
  return (
    <div className="flex flex-wrap gap-3 rounded-xl border border-olive-700 p-2">
      <FlagCanvas flag={flag} />
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <label>Form<select className={sel} value={flag.shape} onChange={(e) => set({ shape: e.target.value as FlagDesign['shape'] })}>{SHAPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Größe<select className={sel} value={flag.size} onChange={(e) => set({ size: e.target.value as FlagDesign['size'] })}>{SIZES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Muster<select className={sel} value={flag.pattern} onChange={(e) => set({ pattern: e.target.value as FlagDesign['pattern'] })}>{FLAG_PATTERNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <div className="col-span-2"><span>Farben</span><ColorList colors={flag.colors} max={3} onChange={(colors) => set({ colors })} /></div>
        <label>Aufschrift<TextInput value={flag.text ?? ''} maxLength={16} onChange={(e) => set({ text: e.target.value })} /></label>
      </div>
      {onRemove && <button type="button" onClick={onRemove} className="self-start text-sm text-red-300 underline">Entfernen</button>}
    </div>
  );
}

function ChoreoEditor({ draft, setDraft }: { draft: { id: string | null; name: string; design: ChoreoDesign }; setDraft: (f: (d: typeof draft) => typeof draft) => void }) {
  const set = (p: Partial<ChoreoDesign>) => setDraft((d) => ({ ...d, design: { ...d.design, ...p } }));
  const d = draft.design;
  return (
    <div className="grid grid-cols-2 gap-2 text-sm">
      <label className="col-span-2">Name<TextInput value={draft.name} maxLength={40} placeholder="z. B. Derby-Blockfahne" onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))} /></label>
      <label>Muster<select className={sel} value={d.pattern} onChange={(e) => set({ pattern: e.target.value as ChoreoDesign['pattern'] })}>{CHOREO_PATTERNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label>Bereich<select className={sel} value={d.block ?? 'home_curve'} onChange={(e) => set({ block: e.target.value as ChoreoDesign['block'] })}>{CHOREO_BLOCKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label>Motiv<select className={sel} value={d.motif ?? 'none'} onChange={(e) => set({ motif: e.target.value as ChoreoDesign['motif'] })}>{MOTIFS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label>Schriftzug<TextInput value={d.text ?? ''} maxLength={24} onChange={(e) => set({ text: e.target.value })} /></label>
      <div className="col-span-2"><span>Farben (die letzte ist die Schriftfarbe)</span><ColorList colors={d.colors} max={4} onChange={(colors) => set({ colors })} /></div>
    </div>
  );
}

function UltraEditor({ ultra, onChange, onRemove }: { ultra: UltraGroup; onChange: (u: UltraGroup) => void; onRemove: () => void }) {
  const set = (p: Partial<UltraGroup>) => onChange({ ...ultra, ...p });
  return (
    <div className="rounded-xl border border-olive-700 p-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <label>Name<TextInput value={ultra.name} maxLength={32} placeholder="z. B. Nordkurve 1990" onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Block<select className={sel} value={ultra.block} onChange={(e) => set({ block: e.target.value as StandBlock })}>{(Object.keys(BLOCK_LABEL) as StandBlock[]).map((k) => <option key={k} value={k}>{BLOCK_LABEL[k]}</option>)}</select></label>
        <label>Zaunfahne (Text)<TextInput value={ultra.banner ?? ''} maxLength={28} placeholder={ultra.name.toUpperCase()} onChange={(e) => set({ banner: e.target.value })} /></label>
        <div><span>Farben</span><ColorList colors={ultra.colors} max={3} onChange={(colors) => set({ colors })} /></div>
      </div>
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={!!ultra.flag} className="h-5 w-5 accent-[var(--fd-accent)]"
        onChange={(e) => set({ flag: e.target.checked ? { shape: 'swallow', size: 'l', pattern: 'halves', colors: ultra.colors.slice(0, 2), text: '' } : null })} />Eigene Gruppenfahne</label>
      {ultra.flag && <div className="mt-2"><FlagEditor flag={ultra.flag} onChange={(flag) => set({ flag })} /></div>}
      {ultra.name.trim().length > 0 && ultra.name.trim().length < 3 && <p className="mt-1 text-xs text-red-300">Der Name braucht mindestens 3 Zeichen.</p>}
      <button type="button" onClick={onRemove} className="mt-2 text-red-300 underline">Gruppe entfernen</button>
    </div>
  );
}

/** Stadionvorschau mit Choreo, Ultras und animierten Fahnen (≈30 fps, nur solange sichtbar) */
function FanPreview({ club, flags, ultras, choreo }: { club: Club; flags: FlagDesign[]; ultras: UltraGroup[]; choreo: ChoreoDesign | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
    const M = stadiumMargin(club.capacity);
    const s = Math.min(cv.width / (L + 2 * M), cv.height / (W + 2 * M));
    const ox = (cv.width - (L + 2 * M) * s) / 2 + M * s, oy = (cv.height - (W + 2 * M) * s) / 2 + M * s;
    const o = { capacity: club.capacity, attendance: club.attendance ?? club.capacity * 0.8, design: club.design, homeColors: [club.primary, club.secondary] as [string, string], awayColor: '#e5e7eb', s, ox, oy, width: cv.width, height: cv.height, homeShort: club.short };
    const base = renderStadiumLayer(o);
    const fans = renderFanLayers(o)[0];
    const ul = ultras.length ? renderUltrasLayer(o, ultras.filter((u) => u.name.trim().length >= 3), 1) : null;
    const ch = choreo && choreo.colors.length ? renderChoreoDesign(o, choreo) : null;
    const spots = flagSpots(o, flags, ultras, 0.8);
    let raf = 0, last = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      ctx.fillStyle = '#15191a'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(base, 0, 0); ctx.drawImage(fans, 0, 0);
      if (ul) ctx.drawImage(ul, 0, 0);
      if (ch) ctx.drawImage(ch, 0, 0);
      for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? '#2f6c3a' : '#2a6234'; ctx.fillRect(ox + (i * L / 18) * s, oy, (L / 18) * s + 1, W * s); }
      const t = (now - t0) / 1000;
      for (const sp of spots) drawFlag(ctx, sp.x, sp.y, sp.scale * 0.85, sp.flag, t + sp.phase, sp.side);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [club, flags, ultras, choreo]);
  const m = stadiumMargin(club.capacity);
  return <canvas ref={ref} className="block w-full rounded-xl" style={{ aspectRatio: `${L + 2 * m} / ${W + 2 * m}` }} aria-label="Vorschau der Fankultur" />;
}

// -------------------------------------------------------------------------------------------
// Hymnen und Fangesänge
// -------------------------------------------------------------------------------------------
function AudioLibrary({ worldId, club, clubId, audio, ultras, onChange }: { worldId: string; club: Club; clubId: string; audio: ClubAudio[]; ultras: UltraGroup[]; onChange: () => Promise<void> }) {
  const [kind, setKind] = useState<'anthem' | 'chant'>('anthem');
  const [name, setName] = useState('');
  const [style, setStyle] = useState<string>('stadium');
  const [mood, setMood] = useState<Mood>('proud');
  const [voice, setVoice] = useState<Voice>('choir');
  const [situation, setSituation] = useState('');
  const [ultra, setUltra] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [recipe, setRecipe] = useState<Recipe>(() => makeRecipe('stadium', 'proud', 'choir'));
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<{ id: string; h: PlayHandle } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { setRecipe(makeRecipe(style as Recipe['style'], mood, voice)); }, [style, mood, voice]);
  useEffect(() => { setStyle(kind === 'anthem' ? 'stadium' : 'chant'); }, [kind]);
  // Mitsingtext synchron zur Melodie
  useEffect(() => {
    if (!playing) { setLine(null); return; }
    const id = setInterval(() => {
      const t = (performance.now() - playing.h.startedAt) / 1000;
      const cur = [...playing.h.lines].reverse().find((l) => l.t <= t);
      setLine(cur?.text ?? null);
      if (t > playing.h.duration + 0.5) setPlaying(null);
    }, 200);
    return () => clearInterval(id);
  }, [playing]);

  const stop = () => { playing?.h.stop(); setPlaying(null); };
  const play = async (id: string, a: { source: 'synth' | 'upload'; recipe: Recipe | null; storage_path: string | null; lyrics: string | null; volume: number }) => {
    stop();
    if (!(await stadiumSound.unlock())) { setError('Der Browser erlaubt gerade keine Wiedergabe.'); return; }
    const h = a.source === 'upload' && a.storage_path ? stadiumSound.playUrl(fanApi.publicUrl(a.storage_path), a.volume, 60)
      : a.recipe ? stadiumSound.playRecipe(a.recipe, { volume: a.volume, maxSec: 40, lyrics: a.lyrics }) : null;
    if (h) setPlaying({ id, h });
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setError(null); setMsg(null);
    try { await fn(); await onChange(); setMsg(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const styles = kind === 'anthem' ? ANTHEM_STYLES : CHANT_STYLES;
  const anthems = audio.filter((a) => a.kind === 'anthem');
  const chants = audio.filter((a) => a.kind === 'chant');

  return (
    <Card className="mt-4">
      <h2 className="display text-2xl font-bold uppercase">Hymnen & Fangesänge</h2>
      <p className="mb-3 text-sm text-cream-dim">Der Stadion-Synthesizer komponiert kostenlos im Browser (Chor, Instrumente, Trommeln, Sprechchor mit der deutschen Sprachausgabe deines Geräts). Für echten Gesang kannst du Songs z. B. auf der Suno-Website erstellen und hier als MP3 hochladen.</p>
      <ErrorBanner error={error} />
      {msg && <p className="mb-2 text-sm text-emerald-300">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 text-sm">
          <div className="flex gap-1">
            {(['anthem', 'chant'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={`display min-h-11 flex-1 rounded-lg font-bold uppercase ${kind === k ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>{k === 'anthem' ? 'Hymne' : 'Fangesang'}</button>
            ))}
          </div>
          <label className="block">Name<TextInput value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={kind === 'anthem' ? `Hymne ${club.short}` : 'z. B. Torgesang'} /></label>
          <div className="grid grid-cols-3 gap-2">
            <label>Stil<select className={sel} value={style} onChange={(e) => setStyle(e.target.value)}>{styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
            <label>Stimmung<select className={sel} value={mood} onChange={(e) => setMood(e.target.value as Mood)}>{MOODS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
            <label>Gesang<select className={sel} value={voice} onChange={(e) => setVoice(e.target.value as Voice)}>{VOICES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          </div>
          {kind === 'chant' && (
            <div className="grid grid-cols-2 gap-2">
              <label>Spielsituation<select className={sel} value={situation} onChange={(e) => setSituation(e.target.value)}>{SITUATIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
              <label>Ultragruppe<select className={sel} value={ultra} onChange={(e) => setUltra(e.target.value)}><option value="">Verein</option>{ultras.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            </div>
          )}
          <label className="block">Text
            <textarea value={lyrics} maxLength={1200} rows={6} onChange={(e) => setLyrics(e.target.value)} className="mt-1 w-full rounded-lg border border-olive-600 bg-olive-900 p-2 text-cream" placeholder="Eigenen Text schreiben oder generieren lassen" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setLyrics(generateLyrics({ club: club.name, short: club.short, kind, style, mood, situation }))}>Text generieren</Button>
            <Button variant="secondary" onClick={() => setRecipe(makeRecipe(style as Recipe['style'], mood, voice))}>Neu komponieren</Button>
            {playing?.id === 'draft' ? <Button variant="ghost" onClick={stop}>■ Stopp</Button>
              : <Button variant="ghost" onClick={() => void play('draft', { source: 'synth', recipe, storage_path: null, lyrics, volume: 0.85 })}>▶ Anhören</Button>}
            <Button busy={busy === 'synth'} disabled={name.trim().length < 2} onClick={() => void run('synth', () => fanApi.saveAudio(worldId, null, {
              kind, source: 'synth', name, style, mood, voice, lyrics, recipe, situation, ultra_id: kind === 'chant' && ultra ? ultra : null, volume: 0.85,
            }), 'Gespeichert.')}>Speichern</Button>
          </div>
          {playing && line && <p className="display rounded-lg bg-ink/60 px-3 py-2 text-center text-xl font-bold uppercase text-gold">{line}</p>}
          <div className="rounded-xl border border-dashed border-olive-600 p-2">
            <p className="mb-1 font-semibold">MP3 hochladen (max. 10 MB)</p>
            <input type="file" accept="audio/mpeg,.mp3" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            <Button className="mt-2" variant="secondary" busy={busy === 'up'} disabled={!file || name.trim().length < 2} onClick={() => void run('up', async () => {
              const path = await fanApi.upload(worldId, clubId, file!);
              await fanApi.saveAudio(worldId, null, { kind, source: 'upload', name, style, mood, voice, lyrics, storage_path: path, situation, ultra_id: kind === 'chant' && ultra ? ultra : null, volume: 0.85 });
              setFile(null);
            }, 'Hochgeladen.')}>Als {kind === 'anthem' ? 'Hymne' : 'Fangesang'} hochladen</Button>
          </div>
        </div>
        <div className="space-y-4">
          <AudioList title="Hymnen" items={anthems} role="official" roleLabel="Offizielle Hymne" playing={playing?.id ?? null} onPlay={play} onStop={stop} worldId={worldId} run={run} ultras={ultras} />
          <AudioList title="Fangesänge" items={chants} role="signature" roleLabel="Signatur-Fangesang" playing={playing?.id ?? null} onPlay={play} onStop={stop} worldId={worldId} run={run} ultras={ultras} />
        </div>
      </div>
    </Card>
  );
}

function AudioList({ title, items, role, roleLabel, playing, onPlay, onStop, worldId, run, ultras }: {
  title: string; items: ClubAudio[]; role: 'official' | 'signature'; roleLabel: string; playing: string | null; worldId: string; ultras: UltraGroup[];
  onPlay: (id: string, a: ClubAudio) => Promise<void>; onStop: () => void; run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  return (
    <div>
      <h3 className="display mb-1 text-xl font-bold uppercase">{title}</h3>
      {items.length === 0 && <p className="text-sm text-cream-dim">Noch nichts gespeichert.</p>}
      <ul className="divide-y divide-olive-700/50 text-sm">
        {items.map((a) => {
          const isRole = role === 'official' ? a.is_official : a.is_signature;
          return (
            <li key={a.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                {playing === a.id ? <button type="button" onClick={onStop} className="h-9 w-9 rounded-full bg-gold text-ink" aria-label="Stopp">■</button>
                  : <button type="button" onClick={() => void onPlay(a.id, a)} className="h-9 w-9 rounded-full bg-olive-700 text-cream" aria-label="Abspielen">▶</button>}
                <span className="flex-1 font-semibold">{a.name}
                  <span className="ml-2 text-xs font-normal text-cream-dim">{a.source === 'upload' ? 'MP3' : 'Synthesizer'}{a.situation ? ` · ${SITUATIONS.find((s) => s.key === a.situation)?.label}` : ''}{a.ultra_id ? ` · ${ultras.find((u) => u.id === a.ultra_id)?.name ?? 'Ultras'}` : ''}</span>
                  {isRole && <span className="ml-2 rounded bg-gold px-1.5 text-xs text-ink">{roleLabel}</span>}
                </span>
                {!isRole && <button type="button" className="text-gold underline" onClick={() => void run('r' + a.id, () => fanApi.setAudioRole(worldId, a.id, role), `${roleLabel} festgelegt.`)}>Als {roleLabel}</button>}
                <button type="button" className="text-red-300 underline" onClick={() => { if (confirm(`„${a.name}“ löschen?`)) void run('d' + a.id, () => fanApi.deleteAudio(worldId, a.id), 'Gelöscht.'); }}>Löschen</button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-cream-dim">
                <label className="flex items-center gap-2">Lautstärke
                  <input type="range" min={0} max={1} step={0.05} defaultValue={a.volume} className="accent-[var(--fd-accent)]"
                    onMouseUp={(e) => void run('v' + a.id, () => fanApi.saveAudio(worldId, a.id, { ...a, kind: a.kind, source: a.source, volume: Number((e.target as HTMLInputElement).value) }), 'Lautstärke gespeichert.')}
                    onTouchEnd={(e) => void run('v' + a.id, () => fanApi.saveAudio(worldId, a.id, { ...a, kind: a.kind, source: a.source, volume: Number((e.target as HTMLInputElement).value) }), 'Lautstärke gespeichert.')} />
                </label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={a.enabled} className="h-4 w-4 accent-[var(--fd-accent)]"
                  onChange={(e) => void run('e' + a.id, () => fanApi.saveAudio(worldId, a.id, { ...a, kind: a.kind, source: a.source, enabled: e.target.checked }), e.target.checked ? 'Aktiviert.' : 'Deaktiviert.')} />aktiv</label>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
