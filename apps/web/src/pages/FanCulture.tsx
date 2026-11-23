import { CLASH_THRESHOLD, KIT_PATTERNS, colorDistance, type KitConfig } from '@fd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { KitPreview } from '../components/KitPreview';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Shell, Spinner, TextInput } from '../components/ui';
import { AWAY_BLOCK, INFIELD, areaInCurve, blockArea, drawFlag, flagSpots, overlaps, renderChoreoDesign, renderUltrasLayer, ultraArea } from '../lib/fanArt';
import { fanApi, type ClubAudio, type FanCulture as FanData, type KitSet } from '../lib/fanApi';
import type { ChoreoDesign, FlagDesign, StadiumDesign, StandArea, UltraGroup } from '../lib/matchClient';
import { L, W, renderFanLayers, renderStadiumLayer, stadiumMargin, type StadiumArtOptions } from '../lib/stadiumArt';
import { SITUATIONS, stadiumSound, type PlayHandle } from '../lib/stadiumSound';

type Club = FanData['club'];

const SHAPES: Array<[FlagDesign['shape'], string]> = [['rect', 'Rechteck'], ['square', 'Quadrat'], ['triangle', 'Wimpel'], ['swallow', 'Schwalbenschwanz'], ['banner', 'Langfahne']];
const SIZES: Array<[FlagDesign['size'], string]> = [['s', 'Klein'], ['m', 'Mittel'], ['l', 'Groß']];
const FLAG_PATTERNS: Array<[FlagDesign['pattern'], string]> = [['solid', 'Einfarbig'], ['stripes_h', 'Querstreifen'], ['stripes_v', 'Längsstreifen'], ['diagonal', 'Diagonal'], ['halves', 'Halbiert'], ['cross', 'Kreuz'], ['checker', 'Karo'], ['star', 'Stern']];
const CHOREO_PATTERNS: Array<[ChoreoDesign['pattern'], string]> = [['stripes', 'Streifen'], ['blocks', 'Blöcke'], ['checker', 'Schachbrett'], ['wave', 'Welle'], ['gradient', 'Verlauf'], ['rays', 'Strahlen'], ['mosaic', 'Mosaik']];
const MOTIFS: Array<[NonNullable<ChoreoDesign['motif']>, string]> = [['none', 'Kein Motiv'], ['star', 'Stern'], ['heart', 'Herz'], ['crown', 'Krone'], ['crest', 'Wappen'], ['lion', 'Löwe'], ['eagle', 'Adler'], ['anchor', 'Anker'], ['castle', 'Burg']];
const CHOREO_BLOCKS: Array<[NonNullable<ChoreoDesign['block']>, string]> = [['home_curve', 'Heimkurve'], ['main_stand', 'Haupttribüne'], ['back_stand', 'Gegengerade'], ['all', 'Ganzes Stadion']];
const KIT_LABEL: Record<string, string> = { solid: 'Uni', stripes: 'Streifen', hoops: 'Ringel', halves: 'Hälften', sash: 'Schärpe' };
const KIT_NAMES: Array<[keyof KitSet, string]> = [['home', 'Heimtrikot'], ['away', 'Auswärtstrikot'], ['special', 'Spezialtrikot']];

export const sel = 'min-h-11 w-full rounded-lg border border-olive-600 bg-olive-900 px-2 text-cream';

/** Stadioneditor „Fankultur & Musik“: Trikots, Choreografien, Fahnen, Ultragruppen, Hymnen und Fangesänge (MP3) */
export function FanCulture() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<FanData | null>(null);
  const [flags, setFlags] = useState<FlagDesign[]>([]);
  const [ultras, setUltras] = useState<UltraGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [defChoreo, setDefChoreo] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [kits, setKits] = useState<KitSet | null>(null);
  const [draft, setDraft] = useState<{ id: string | null; name: string; design: ChoreoDesign }>({ id: null, name: '', design: { pattern: 'stripes', colors: ['#c8102e', '#ffffff'], text: '', motif: 'star', block: 'home_curve' } });
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fanApi.culture(worldId);
      setData(d); setFlags(d.flags); setUltras(d.ultras); setDefChoreo(d.default_choreo_id); setAuto(d.auto_choreo); setKits(d.kits);
      setDraft((x) => (x.design.colors[0] === '#c8102e' && d.club.primary ? { ...x, design: { ...x.design, colors: [d.club.primary, d.club.secondary], text: d.club.short } } : x));
    } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => stadiumSound.stopAll(), []);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setError(null); setMsg(null);
    try { await fn(); await load(); setMsg(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  if (!data || !kits) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Fankultur wird geladen …" />}</Shell>;
  const club = data.club;
  const preview = draft.name || draft.id ? draft.design : (data.choreos.find((c) => c.id === defChoreo)?.design ?? draft.design);
  const homeAwayClash = colorDistance(kits.home.primary, kits.away.primary) < CLASH_THRESHOLD;

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
          <h2 className="display mb-1 text-2xl font-bold uppercase">Stadion & Ultragruppen</h2>
          <p className="mb-2 text-xs text-cream-dim">Ultragruppen per Drag-and-drop auf den Heimtribünen platzieren, am Ziehpunkt (unten rechts) vergrößern oder verkleinern. Der schraffierte Gästeblock ist gesperrt, Gruppen überlappen nicht.</p>
          <StadiumEditor club={club} flags={flags} ultras={ultras} choreo={preview} selected={selected} onSelect={setSelected}
            onMove={(id, area) => setUltras((all) => all.map((u) => (u.id === id ? { ...u, area } : u)))} />
          <p className="mt-2 text-xs text-cream-dim">Fans entsprechen der echten Auslastung ({club.capacity.toLocaleString('de-DE')} Plätze{club.attendance ? `, zuletzt ${club.attendance.toLocaleString('de-DE')}` : ''}). Mehr Zuschauer und wichtige Spiele ⇒ mehr Fahnen.</p>
        </Card>

        <Card>
          <h2 className="display mb-2 text-2xl font-bold uppercase">Choreografie</h2>
          <Link to={`/w/${worldId}/choreo`} className="mb-3 block rounded-lg border border-gold/60 bg-gold/10 px-3 py-2 text-sm font-semibold text-gold hover:bg-gold/20" data-testid="open-choreo-designer">Choreo-Designer öffnen: ganzes Stadion, Szenen, Banner, Fahnen, Konfetti →</Link>
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
          <p className="mt-2 text-xs text-cream-dim">Die Choreo für ein bestimmtes Heimspiel wählst du in der Spielvorbereitung direkt vor dem Anpfiff.</p>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="display text-2xl font-bold uppercase">Schwenkfahnen (Heimkurve)</h2>
            <Button variant="secondary" disabled={flags.length >= 8} onClick={() => setFlags((f) => [...f, { shape: 'rect', size: 'm', pattern: 'stripes_h', colors: [club.primary, club.secondary], text: '', count: 4, from: 0, to: 1 }])}>+ Fahne</Button>
          </div>
          <p className="mb-2 text-xs text-cream-dim">Eigene große Schwenkfahnen erscheinen ausschließlich in der Heimkurve. Ohne eigene Fahnen schwenken die Fans automatisch Fahnen in Vereinsfarben. Insgesamt höchstens 40 Fahnen.</p>
          <div className="space-y-3">
            {flags.map((f, i) => (
              <FlagEditor key={i} flag={f} withCount onChange={(nf) => setFlags((all) => all.map((x, k) => (k === i ? nf : x)))} onRemove={() => setFlags((all) => all.filter((_, k) => k !== i))} />
            ))}
          </div>
          <p className="mt-2 text-xs text-cream-dim">Fahnen gesamt: {flags.reduce((n, f) => n + (f.count ?? 3), 0)} / 40</p>
        </Card>
        <Card>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="display text-2xl font-bold uppercase">Ultragruppen</h2>
            <Button variant="secondary" disabled={ultras.length >= 4} onClick={() => {
              const id = `u-${crypto.randomUUID().slice(0, 8)}`;
              const area = freeSpot(club.capacity, ultras);
              setUltras((u) => [...u, { id, name: '', colors: [club.primary, '#111111'], banner: '', block: 'home_curve', area, flags: 6, flag: null }]);
              setSelected(id);
            }}>+ Gruppe</Button>
          </div>
          {ultras.length === 0 && <p className="text-sm text-cream-dim">Fiktive Fangruppen mit Namen, Farben, Zaunfahne und frei wählbarem Bereich.</p>}
          <div className="space-y-3">
            {ultras.map((u, i) => (
              <UltraEditor key={u.id} ultra={u} capacity={club.capacity} others={ultras.filter((x) => x.id !== u.id)} selected={selected === u.id} onSelect={() => setSelected(u.id)}
                onChange={(nu) => setUltras((all) => all.map((x, k) => (k === i ? nu : x)))} onRemove={() => setUltras((all) => all.filter((_, k) => k !== i))} />
            ))}
          </div>
        </Card>
      </div>
      <div className="mt-3">
        <Button busy={busy === 'save'} onClick={() => void act('save', () => fanApi.save(worldId, flags, ultras.map((u) => ({ ...u, name: u.name.trim() })), defChoreo, auto), 'Fahnen, Ultragruppen und Standard gespeichert – gilt ab dem nächsten Heimspiel.')}>
          Fahnen, Ultras & Standard speichern
        </Button>
      </div>

      <Card className="mt-4">
        <h2 className="display mb-1 text-2xl font-bold uppercase">Trikots</h2>
        <p className="mb-3 text-xs text-cream-dim">Drei Trikots. Die Wahl für eine Partie triffst du in der Spielvorbereitung; KI-Vereine wählen automatisch ein Trikot ohne Farbkonflikt.</p>
        <div className="grid gap-4 md:grid-cols-3">
          {KIT_NAMES.map(([key, label]) => (
            <div key={key} className="rounded-xl border border-olive-700 p-3">
              <p className="display mb-2 text-lg font-bold uppercase">{label}</p>
              <KitPreview kit={kits[key]} size={110} />
              <label className="mt-2 block text-sm">Muster
                <select className={sel} value={kits[key].pattern} onChange={(e) => setKits({ ...kits, [key]: { ...kits[key], pattern: e.target.value as KitConfig['pattern'] } })}>
                  {KIT_PATTERNS.map((p) => <option key={p} value={p}>{KIT_LABEL[p] ?? p}</option>)}
                </select>
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <label>Hauptfarbe<input type="color" value={kits[key].primary} onChange={(e) => setKits({ ...kits, [key]: { ...kits[key], primary: e.target.value.toUpperCase() } })} className="h-10 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent" /></label>
                <label>Zweitfarbe<input type="color" value={kits[key].secondary} onChange={(e) => setKits({ ...kits, [key]: { ...kits[key], secondary: e.target.value.toUpperCase() } })} className="h-10 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent" /></label>
              </div>
            </div>
          ))}
        </div>
        {homeAwayClash && <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">Heim- und Auswärtstrikot sind sehr ähnlich – bei gleichfarbigen Gegnern kann es zu Farbkonflikten kommen.</p>}
        <Button className="mt-3" busy={busy === 'kits'} onClick={() => void act('kits', () => fanApi.saveKits(worldId, kits), 'Trikots gespeichert.')}>Trikots speichern</Button>
      </Card>

      <AudioLibrary worldId={worldId} clubId={data.club_id} audio={data.audio} ultras={data.ultras} onChange={load} />
    </Shell>
  );
}

/** Freien Platz für eine neue Gruppe suchen (Heimkurve zuerst, dann Haupttribüne/Gegengerade) */
function freeSpot(capacity: number, ultras: UltraGroup[]): StandArea {
  const m = stadiumMargin(capacity);
  const cands: StandArea[] = [];
  for (let y = 0; y <= W - 18; y += 6) cands.push({ x: -m + 1, y, w: Math.max(4, m - 3), h: 18 });
  for (let x = 10; x <= L - 22; x += 8) { cands.push({ x, y: W + 2.6, w: 20, h: Math.max(4, m - 4) }); cands.push({ x, y: -m + 1.5, w: 20, h: Math.max(4, m - 4) }); }
  const taken = ultras.map((u) => u.area).filter((a): a is StandArea => !!a);
  return cands.find((c) => !taken.some((t) => overlaps(c, t))) ?? cands[0]!;
}

export function validArea(a: StandArea, others: StandArea[], capacity: number): boolean {
  const m = stadiumMargin(capacity);
  if (a.w < 2 || a.h < 2) return false;
  if (a.x < -m || a.y < -m || a.x + a.w > L + m || a.y + a.h > W + m) return false;
  if (overlaps(a, INFIELD) || overlaps(a, AWAY_BLOCK)) return false;
  return !others.some((o) => overlaps(a, o));
}

export function ColorList({ colors, max, onChange }: { colors: string[]; max: number; onChange: (c: string[]) => void }) {
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

function FlagCanvas({ flag }: { flag: FlagDesign }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    let raf = 0, last = 0;
    const t0 = performance.now();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 40) return;
      last = now;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== cv.clientWidth * dpr) { cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; }
      ctx.clearRect(0, 0, cv.width, cv.height);
      drawFlag(ctx, cv.width * 0.18, cv.height * 0.95, cv.height / 6.2, flag, (now - t0) / 1000);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [flag]);
  return <canvas ref={ref} className="h-24 w-32 rounded-lg bg-olive-900" aria-label="Fahnenvorschau" />;
}

function FlagEditor({ flag, onChange, onRemove, withCount = false }: { flag: FlagDesign; onChange: (f: FlagDesign) => void; onRemove?: () => void; withCount?: boolean }) {
  const set = (p: Partial<FlagDesign>) => onChange({ ...flag, ...p });
  const from = flag.from ?? 0, to = flag.to ?? 1;
  return (
    <div className="flex flex-wrap gap-3 rounded-xl border border-olive-700 p-2">
      <FlagCanvas flag={flag} />
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 text-sm sm:grid-cols-3">
        <label>Form<select className={sel} value={flag.shape} onChange={(e) => set({ shape: e.target.value as FlagDesign['shape'] })}>{SHAPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Größe<select className={sel} value={flag.size} onChange={(e) => set({ size: e.target.value as FlagDesign['size'] })}>{SIZES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Muster<select className={sel} value={flag.pattern} onChange={(e) => set({ pattern: e.target.value as FlagDesign['pattern'] })}>{FLAG_PATTERNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <div className="col-span-2"><span>Farben</span><ColorList colors={flag.colors} max={3} onChange={(colors) => set({ colors })} /></div>
        <label>Aufschrift<TextInput value={flag.text ?? ''} maxLength={16} onChange={(e) => set({ text: e.target.value })} /></label>
        {withCount && (
          <>
            <label className="col-span-1">Anzahl: {flag.count ?? 3}
              <input type="range" min={1} max={12} value={flag.count ?? 3} onChange={(e) => set({ count: Number(e.target.value) })} className="w-full accent-[var(--fd-accent)]" />
            </label>
            <div className="col-span-2">
              <span>Verteilung in der Kurve: {Math.round(from * 100)}–{Math.round(to * 100)} %</span>
              <div className="flex gap-2">
                <input type="range" min={0} max={1} step={0.05} value={from} aria-label="Bereich von" onChange={(e) => set({ from: Math.min(Number(e.target.value), to) })} className="w-full accent-[var(--fd-accent)]" />
                <input type="range" min={0} max={1} step={0.05} value={to} aria-label="Bereich bis" onChange={(e) => set({ to: Math.max(Number(e.target.value), from) })} className="w-full accent-[var(--fd-accent)]" />
              </div>
            </div>
          </>
        )}
      </div>
      {onRemove && <button type="button" onClick={onRemove} className="self-start text-sm text-red-300 underline">Entfernen</button>}
    </div>
  );
}

export function ChoreoEditor({ draft, setDraft }: { draft: { id: string | null; name: string; design: ChoreoDesign }; setDraft: (f: (d: { id: string | null; name: string; design: ChoreoDesign }) => { id: string | null; name: string; design: ChoreoDesign }) => void }) {
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

function UltraEditor({ ultra, capacity, others, selected, onSelect, onChange, onRemove }: {
  ultra: UltraGroup; capacity: number; others: UltraGroup[]; selected: boolean; onSelect: () => void; onChange: (u: UltraGroup) => void; onRemove: () => void;
}) {
  const set = (p: Partial<UltraGroup>) => onChange({ ...ultra, ...p });
  const a = ultra.area;
  const resize = (dw: number, dh: number) => {
    if (!a) return;
    const next = { ...a, w: Math.max(2, a.w + dw), h: Math.max(2, a.h + dh) };
    if (validArea(next, others.map((o) => o.area).filter((x): x is StandArea => !!x), capacity)) set({ area: next });
  };
  return (
    <div className={`rounded-xl border p-2 text-sm ${selected ? 'border-gold' : 'border-olive-700'}`} onClick={onSelect}>
      <div className="grid grid-cols-2 gap-2">
        <label>Name<TextInput value={ultra.name} maxLength={32} placeholder="z. B. Nordkurve 1990" onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Zaunfahne (Text)<TextInput value={ultra.banner ?? ''} maxLength={28} placeholder={ultra.name.toUpperCase()} onChange={(e) => set({ banner: e.target.value })} /></label>
        <div><span>Farben</span><ColorList colors={ultra.colors} max={3} onChange={(colors) => set({ colors })} /></div>
        <label>Fahnen der Gruppe: {ultra.flags ?? 'automatisch'}
          <input type="range" min={0} max={16} value={ultra.flags ?? 6} onChange={(e) => set({ flags: Number(e.target.value) })} className="w-full accent-[var(--fd-accent)]" />
        </label>
      </div>
      {a && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cream-dim">
          <span>Bereich {Math.round(a.w)} × {Math.round(a.h)} m {areaInCurve(a) ? '· Heimkurve' : ''}</span>
          <Button variant="ghost" className="min-h-9 !px-2 !text-xs" onClick={() => resize(-2, 0)}>Breite −</Button>
          <Button variant="ghost" className="min-h-9 !px-2 !text-xs" onClick={() => resize(2, 0)}>Breite +</Button>
          <Button variant="ghost" className="min-h-9 !px-2 !text-xs" onClick={() => resize(0, -2)}>Höhe −</Button>
          <Button variant="ghost" className="min-h-9 !px-2 !text-xs" onClick={() => resize(0, 2)}>Höhe +</Button>
        </div>
      )}
      <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={!!ultra.flag} className="h-5 w-5 accent-[var(--fd-accent)]"
        onChange={(e) => set({ flag: e.target.checked ? { shape: 'swallow', size: 'm', pattern: 'halves', colors: ultra.colors.slice(0, 2), text: '' } : null })} />Eigene Gruppenfahne {a && !areaInCurve(a) ? '(groß nur in der Heimkurve)' : ''}</label>
      {ultra.flag && <div className="mt-2"><FlagEditor flag={ultra.flag} onChange={(flag) => set({ flag })} /></div>}
      {ultra.name.trim().length > 0 && ultra.name.trim().length < 3 && <p className="mt-1 text-xs text-red-300">Der Name braucht mindestens 3 Zeichen.</p>}
      <button type="button" onClick={onRemove} className="mt-2 text-red-300 underline">Gruppe entfernen</button>
    </div>
  );
}

/**
 * Interaktive Stadionvorschau: Ultragruppen verschieben (Ziehen) und skalieren (Ziehpunkt unten rechts).
 * Ungültige Positionen (Spielfeld, Gästeblock, Überlappung) werden nicht übernommen.
 */
function StadiumEditor({ club, flags, ultras, choreo, selected, onSelect, onMove }: {
  club: Club; flags: FlagDesign[]; ultras: UltraGroup[]; choreo: ChoreoDesign | null; selected: string | null;
  onSelect: (id: string | null) => void; onMove: (id: string, area: StandArea) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geo = useRef<StadiumArtOptions | null>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'size'; start: [number, number]; area: StandArea } | null>(null);
  const live = useRef<{ ultras: UltraGroup[]; selected: string | null }>({ ultras, selected });
  live.current = { ultras, selected };
  const toM = (e: React.PointerEvent): [number, number] => {
    const o = geo.current!, cv = ref.current!;
    const r = cv.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * cv.width, py = ((e.clientY - r.top) / r.height) * cv.height;
    return [(px - o.ox) / o.s, (py - o.oy) / o.s];
  };
  // statische Ebenen nur bei Größen-/Designänderung neu berechnen
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
    const M = stadiumMargin(club.capacity);
    const s = Math.min(cv.width / (L + 2 * M), cv.height / (W + 2 * M));
    const ox = (cv.width - (L + 2 * M) * s) / 2 + M * s, oy = (cv.height - (W + 2 * M) * s) / 2 + M * s;
    const o: StadiumArtOptions = { capacity: club.capacity, attendance: club.attendance ?? club.capacity * 0.8, design: club.design as StadiumDesign | null, homeColors: [club.primary, club.secondary], awayColor: '#e5e7eb', s, ox, oy, width: cv.width, height: cv.height, homeShort: club.short };
    geo.current = o;
    const base = renderStadiumLayer(o);
    const fans = renderFanLayers(o)[0];
    const ch = choreo && choreo.colors.length ? renderChoreoDesign(o, choreo) : null;
    let ul: HTMLCanvasElement | null = null, ulKey = '';
    let spots = flagSpots(o, flags, ultras, 0.8), spotsKey = '';
    let raf = 0, last = 0;
    const t0 = performance.now();
    const X = (x: number) => o.ox + x * o.s, Y = (y: number) => o.oy + y * o.s;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;
      const { ultras: us, selected: sel } = live.current;
      const key = JSON.stringify(us.map((u) => [u.area, u.colors, u.name, u.banner]));
      if (key !== ulKey) { ul = us.length ? renderUltrasLayer(o, us.filter((u) => u.name.trim().length >= 3 || u.area), 1) : null; ulKey = key; }
      const sk = key + JSON.stringify(flags) + JSON.stringify(us.map((u) => [u.flags, u.flag]));
      if (sk !== spotsKey) { spots = flagSpots(o, flags, us, 0.8); spotsKey = sk; }
      ctx.fillStyle = '#15191a'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(base, 0, 0); ctx.drawImage(fans, 0, 0);
      if (ch) ctx.drawImage(ch, 0, 0);
      if (ul) ctx.drawImage(ul, 0, 0);
      for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? '#2f6c3a' : '#2a6234'; ctx.fillRect(X((i * L) / 18), Y(0), (L / 18) * s + 1, W * s); }
      // Gästeblock schraffiert (gesperrt)
      ctx.save();
      ctx.beginPath(); ctx.rect(X(AWAY_BLOCK.x), Y(Math.max(AWAY_BLOCK.y, -M)), (M + 1) * s, (AWAY_BLOCK.y + AWAY_BLOCK.h - Math.max(AWAY_BLOCK.y, -M)) * s); ctx.clip();
      ctx.strokeStyle = 'rgba(255,90,90,0.55)'; ctx.lineWidth = Math.max(1, s * 0.25);
      for (let k = -40; k < 80; k += 2.5) { ctx.beginPath(); ctx.moveTo(X(L + k * 0.5), Y(-M)); ctx.lineTo(X(L + k * 0.5 + M), Y(W * 0.42)); ctx.stroke(); }
      ctx.restore();
      ctx.font = `700 ${Math.round(s * 1.6)}px "Barlow Condensed", system-ui, sans-serif`; ctx.fillStyle = 'rgba(255,170,170,0.95)'; ctx.textAlign = 'center';
      ctx.save(); ctx.translate(X(L + M * 0.55), Y(W * 0.2)); ctx.rotate(Math.PI / 2); ctx.fillText('GÄSTEBLOCK – GESPERRT', 0, 0); ctx.restore();
      // Fahnen
      const t = (now - t0) / 1000;
      for (const sp of spots) drawFlag(ctx, sp.x, sp.y, sp.scale * 0.85, sp.flag, t + sp.phase, sp.side);
      // Bereiche + Ziehpunkte
      for (const u of us) {
        const a = ultraArea(o, u);
        const isSel = u.id === sel;
        ctx.strokeStyle = isSel ? '#ffd24a' : 'rgba(255,255,255,0.7)'; ctx.lineWidth = Math.max(1.5, s * (isSel ? 0.35 : 0.2));
        ctx.setLineDash(isSel ? [] : [s * 0.8, s * 0.6]);
        ctx.strokeRect(X(a.x), Y(a.y), a.w * s, a.h * s);
        ctx.setLineDash([]);
        ctx.fillStyle = isSel ? '#ffd24a' : '#ffffff';
        ctx.fillRect(X(a.x + a.w) - s * 1.6, Y(a.y + a.h) - s * 1.6, s * 2.2, s * 2.2);
        ctx.font = `700 ${Math.round(s * 1.4)}px "Barlow Condensed", system-ui, sans-serif`; ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff'; ctx.fillText(u.name || 'Neue Gruppe', X(a.x) + s * 0.4, Y(a.y) - s * 0.4);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [club, flags, choreo]); // eslint-disable-line react-hooks/exhaustive-deps

  const others = (id: string) => live.current.ultras.filter((u) => u.id !== id).map((u) => ultraArea(geo.current!, u));
  return (
    <canvas ref={ref} className="block w-full touch-none rounded-xl" style={{ aspectRatio: `${L + 2 * stadiumMargin(club.capacity)} / ${W + 2 * stadiumMargin(club.capacity)}`, cursor: 'grab' }}
      aria-label="Stadion: Ultragruppen platzieren"
      onPointerDown={(e) => {
        if (!geo.current) return;
        const [mx, my] = toM(e);
        // Ziehpunkt hat Vorrang, danach Fläche (oberste zuerst)
        for (const u of [...live.current.ultras].reverse()) {
          const a = ultraArea(geo.current, u);
          const onHandle = Math.abs(mx - (a.x + a.w)) < 2.2 && Math.abs(my - (a.y + a.h)) < 2.2;
          if (onHandle || (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h)) {
            drag.current = { id: u.id, mode: onHandle ? 'size' : 'move', start: [mx, my], area: { ...a } };
            onSelect(u.id);
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            return;
          }
        }
        onSelect(null);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !geo.current) return;
        const [mx, my] = toM(e);
        const dx = mx - d.start[0], dy = my - d.start[1];
        const next = d.mode === 'move' ? { ...d.area, x: Math.round((d.area.x + dx) * 2) / 2, y: Math.round((d.area.y + dy) * 2) / 2 }
          : { ...d.area, w: Math.max(2, Math.round((d.area.w + dx) * 2) / 2), h: Math.max(2, Math.round((d.area.h + dy) * 2) / 2) };
        if (validArea(next, others(d.id), club.capacity)) onMove(d.id, next);
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    />
  );
}
void blockArea;

// -------------------------------------------------------------------------------------------
// Hymnen und Fangesänge (ausschließlich MP3)
// -------------------------------------------------------------------------------------------
function AudioLibrary({ worldId, clubId, audio, ultras, onChange }: { worldId: string; clubId: string; audio: ClubAudio[]; ultras: UltraGroup[]; onChange: () => Promise<void> }) {
  const [kind, setKind] = useState<'anthem' | 'chant'>('anthem');
  const [name, setName] = useState('');
  const [situation, setSituation] = useState('');
  const [ultra, setUltra] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [playing, setPlaying] = useState<{ id: string; h: PlayHandle } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploads = audio.filter((a) => a.source === 'upload');

  const stop = () => { playing?.h.stop(); setPlaying(null); };
  const play = async (a: ClubAudio) => {
    stop();
    if (!a.storage_path) return;
    await stadiumSound.unlock();
    setError(null);
    const h = stadiumSound.playUrl(fanApi.publicUrl(a.storage_path), a.volume, 60, (m) => { setError(m); setPlaying(null); });
    setPlaying({ id: a.id, h });
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setError(null); setMsg(null);
    try { await fn(); await onChange(); setMsg(ok); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const label = kind === 'anthem' ? 'Hymne' : 'Fangesang';

  return (
    <Card className="mt-4">
      <h2 className="display text-2xl font-bold uppercase">Hymnen & Fangesänge</h2>
      <p className="mb-3 text-sm text-cream-dim">Lade MP3-Dateien hoch (höchstens 10 MB), z. B. selbst erstellte Songs. Die offizielle Hymne läuft beim Einlauf, danach der Signatur-Fangesang; weitere Gesänge erklingen je Spielsituation.</p>
      <ErrorBanner error={error} />
      {msg && <p className="mb-2 text-sm text-emerald-300">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2 text-sm">
          <div className="flex gap-1">
            {(['anthem', 'chant'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setKind(k)} className={`display min-h-11 flex-1 rounded-lg font-bold uppercase ${kind === k ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim'}`}>{k === 'anthem' ? 'Hymne' : 'Fangesang'}</button>
            ))}
          </div>
          <label className="block">Name<TextInput value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={kind === 'anthem' ? 'z. B. Für die Ewigkeit' : 'z. B. Torgesang'} /></label>
          {kind === 'chant' && (
            <div className="grid grid-cols-2 gap-2">
              <label>Spielsituation<select className={sel} value={situation} onChange={(e) => setSituation(e.target.value)}>{SITUATIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
              <label>Ultragruppe<select className={sel} value={ultra} onChange={(e) => setUltra(e.target.value)}><option value="">Verein</option>{ultras.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            </div>
          )}
          <div className="rounded-xl border border-dashed border-olive-600 p-3">
            <input ref={fileRef} type="file" accept="audio/mpeg,.mp3" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name.replace(/\.mp3$/i, '').slice(0, 40)); }} className="block w-full text-sm" />
            {file && <p className="mt-1 text-xs text-cream-dim">{file.name} · {(file.size / 1048576).toFixed(1)} MB</p>}
            <Button className="mt-2" busy={busy === 'up'} disabled={!file || name.trim().length < 2} onClick={() => void run('up', async () => {
              const id = await fanApi.uploadAndSave(worldId, clubId, file!, { kind, name, situation, ultra_id: kind === 'chant' && ultra ? ultra : null, volume: 0.85 });
              // Länge merken: die Hymne läuft beim Einlauf in voller Länge
              const sec = await fanApi.mp3Duration(file!);
              if (sec && id) await fanApi.setAudioDuration(id, sec).catch(() => undefined);
              setFile(null); setName(''); if (fileRef.current) fileRef.current.value = '';
            }, `${label} hochgeladen und gespeichert.`)}>Als {label} hochladen</Button>
          </div>
        </div>
        <div className="space-y-4">
          <AudioList title="Hymnen" items={uploads.filter((a) => a.kind === 'anthem')} role="official" roleLabel="Offizielle Hymne" playing={playing?.id ?? null} onPlay={play} onStop={stop} worldId={worldId} run={run} ultras={ultras} />
          <AudioList title="Fangesänge" items={uploads.filter((a) => a.kind === 'chant')} role="signature" roleLabel="Signatur-Fangesang" playing={playing?.id ?? null} onPlay={play} onStop={stop} worldId={worldId} run={run} ultras={ultras} />
        </div>
      </div>
    </Card>
  );
}

function AudioList({ title, items, role, roleLabel, playing, onPlay, onStop, worldId, run, ultras }: {
  title: string; items: ClubAudio[]; role: 'official' | 'signature'; roleLabel: string; playing: string | null; worldId: string; ultras: UltraGroup[];
  onPlay: (a: ClubAudio) => Promise<void>; onStop: () => void; run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const save = (a: ClubAudio, p: Record<string, unknown>) => fanApi.saveAudio(worldId, a.id, { kind: a.kind, name: a.name, situation: a.situation ?? '', ultra_id: a.ultra_id, volume: a.volume, enabled: a.enabled, ...p });
  return (
    <div>
      <h3 className="display mb-1 text-xl font-bold uppercase">{title}</h3>
      {items.length === 0 && <p className="text-sm text-cream-dim">Noch nichts hochgeladen.</p>}
      <ul className="divide-y divide-olive-700/50 text-sm">
        {items.map((a) => {
          const isRole = role === 'official' ? a.is_official : a.is_signature;
          return (
            <li key={a.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                {playing === a.id ? <button type="button" onClick={onStop} className="h-9 w-9 rounded-full bg-gold text-ink" aria-label="Stopp">■</button>
                  : <button type="button" onClick={() => void onPlay(a)} className="h-9 w-9 rounded-full bg-olive-700 text-cream" aria-label="Abspielen">▶</button>}
                <span className="flex-1 font-semibold">{a.name}
                  <span className="ml-2 text-xs font-normal text-cream-dim">MP3{a.situation ? ` · ${SITUATIONS.find((s) => s.key === a.situation)?.label}` : ''}{a.ultra_id ? ` · ${ultras.find((u) => u.id === a.ultra_id)?.name ?? 'Ultras'}` : ''}</span>
                  {isRole && <span className="ml-2 rounded bg-gold px-1.5 text-xs text-ink">{roleLabel}</span>}
                </span>
                {!isRole && <button type="button" className="text-gold underline" onClick={() => void run('r' + a.id, () => fanApi.setAudioRole(worldId, a.id, role), `${roleLabel} festgelegt.`)}>Als {roleLabel}</button>}
                <button type="button" className="text-red-300 underline" onClick={() => { if (confirm(`„${a.name}“ löschen?`)) void run('d' + a.id, () => fanApi.deleteAudio(worldId, a.id), 'Gelöscht.'); }}>Löschen</button>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-cream-dim">
                {a.kind === 'chant' && (
                  <select className="rounded border border-olive-600 bg-olive-900 px-1 py-1" value={a.situation ?? ''} onChange={(e) => void run('s' + a.id, () => save(a, { situation: e.target.value }), 'Spielsituation gespeichert.')}>
                    {SITUATIONS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                )}
                <label className="flex items-center gap-2">Lautstärke
                  <input type="range" min={0} max={1} step={0.05} defaultValue={a.volume} className="accent-[var(--fd-accent)]"
                    onPointerUp={(e) => void run('v' + a.id, () => save(a, { volume: Number((e.target as HTMLInputElement).value) }), 'Lautstärke gespeichert.')} />
                </label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={a.enabled} className="h-4 w-4 accent-[var(--fd-accent)]"
                  onChange={(e) => void run('e' + a.id, () => save(a, { enabled: e.target.checked }), e.target.checked ? 'Aktiviert.' : 'Deaktiviert.')} />aktiv</label>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
