import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { StadiumDesign } from '../lib/matchClient';
import { DEFAULT_DESIGN, L, STADIUM_STYLES, W, renderFanLayers, renderStadiumLayer, stadiumMargin, standTiers, withDefaults } from '../lib/stadiumArt';
import { Button, Card, TextInput } from './ui';

/** Vorschau: Stadion mit der zuletzt bekannten (oder angenommenen) Auslastung */
export function StadiumPreview({ capacity, attendance, design, homeColors, awayColor = '#e5e7eb' }: {
  capacity: number; attendance: number; design: StadiumDesign; homeColors: [string, string]; awayColor?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
    const ctx = cv.getContext('2d')!;
    const M = stadiumMargin(capacity);
    const s = Math.min(cv.width / (L + 2 * M), cv.height / (W + 2 * M));
    const ox = (cv.width - (L + 2 * M) * s) / 2 + M * s, oy = (cv.height - (W + 2 * M) * s) / 2 + M * s;
    ctx.fillStyle = '#15191a'; ctx.fillRect(0, 0, cv.width, cv.height);
    const o = { capacity, attendance, design, homeColors, awayColor, s, ox, oy, width: cv.width, height: cv.height };
    ctx.drawImage(renderStadiumLayer(o), 0, 0);
    ctx.drawImage(renderFanLayers(o)[0], 0, 0);
    for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? '#2f6c3a' : '#2a6234'; ctx.fillRect(ox + (i * L / 18) * s, oy - 1.5 * s, (L / 18) * s + 1, (W + 3) * s); }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = Math.max(1, 0.22 * s);
    ctx.strokeRect(ox, oy, L * s, W * s);
    ctx.beginPath(); ctx.moveTo(ox + (L / 2) * s, oy); ctx.lineTo(ox + (L / 2) * s, oy + W * s); ctx.stroke();
    ctx.beginPath(); ctx.arc(ox + (L / 2) * s, oy + (W / 2) * s, 9.15 * s, 0, Math.PI * 2); ctx.stroke();
  }, [capacity, attendance, design, homeColors, awayColor]);
  const m = stadiumMargin(capacity);
  const tiers = standTiers(capacity);
  return (
    <div>
      <canvas ref={ref} className="block w-full rounded-xl" style={{ aspectRatio: `${L + 2 * m} / ${W + 2 * m}` }} aria-label="Stadionvorschau" />
      {/* Legende: Sitzplätze vs. Zuschauer */}
      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-cream-dim">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-3 rounded-[2px] bg-[#eef1f4]" />freier Sitzplatz</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border border-black/40" style={{ background: homeColors[0] }} />Zuschauer (Heim)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-full border border-black/40" style={{ background: awayColor }} />Gästeblock</span>
        <span>{capacity.toLocaleString('de-DE')} Plätze · {tiers} {tiers === 1 ? 'Rang' : 'Ränge'} · {Math.round((attendance / Math.max(1, capacity)) * 100)} % Auslastung</span>
      </div>
    </div>
  );
}

/** Kostenloser Stadion-Editor (rein optisch) */
export function StadiumDesigner({ name, capacity, attendance, design, homeColors, onSave, worldId }: {
  name: string; capacity: number; attendance: number | null; design: StadiumDesign; homeColors: [string, string];
  onSave: (name: string, design: StadiumDesign) => Promise<void>;
  worldId?: string;
}) {
  const [n, setN] = useState(name);
  const [d, setD] = useState<Required<StadiumDesign>>(withDefaults(design));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState(attendance ? Math.min(1, attendance / capacity) : 0.75);
  useEffect(() => { setN(name); setD(withDefaults(design)); }, [name, design]);
  const set = (p: Partial<StadiumDesign>) => setD((x) => ({ ...x, ...p }));
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="display text-2xl font-bold uppercase">Stadiondesign</h2>
        <span className="text-sm text-cream-dim">kostenlos · rein optisch (kein Einfluss auf Kosten, Stärke oder Heimvorteil)</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <StadiumPreview capacity={capacity} attendance={capacity * preview} design={d} homeColors={homeColors} />
          <label className="mt-2 flex items-center gap-3 text-sm text-cream-dim">Vorschau-Auslastung
            <input type="range" min={0.1} max={1} step={0.05} value={preview} onChange={(e) => setPreview(Number(e.target.value))} className="flex-1 accent-[var(--fd-accent)]" />
            <span className="w-12 text-right tabular-nums">{Math.round(preview * 100)} %</span>
          </label>
          <p className="text-xs text-cream-dim">Im Spiel entspricht die Fanmenge der echten Zuschauerzahl ({capacity.toLocaleString('de-DE')} Plätze){attendance ? `, zuletzt ${attendance.toLocaleString('de-DE')} Zuschauer` : ''}.</p>
        </div>
        <div className="space-y-3">
          <label className="block text-sm">Stadionname<TextInput value={n} maxLength={40} onChange={(e) => setN(e.target.value)} /></label>
          <div>
            <p className="mb-1 text-sm">Stil</p>
            <div className="grid grid-cols-2 gap-1">
              {STADIUM_STYLES.map((st) => (
                <button key={st.key} type="button" onClick={() => set({ style: st.key })} title={st.hint}
                  className={`min-h-11 rounded-lg px-2 text-sm font-semibold ${d.style === st.key ? 'bg-gold text-ink' : 'bg-olive-800 text-cream-dim hover:text-cream'}`}>{st.label}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            {([['stand', 'Tribünen'], ['seat', 'Brüstungen'], ['accent', 'Banden']] as const).map(([k, label]) => (
              <label key={k} className="flex flex-col gap-1">{label}
                <input type="color" value={d[k]} onChange={(e) => set({ [k]: e.target.value })} className="h-10 w-full cursor-pointer rounded-lg border border-olive-600 bg-transparent disabled:opacity-40" />
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.club_colors} onChange={(e) => set({ club_colors: e.target.checked })} className="h-5 w-5 accent-[var(--fd-accent)]" />Fans in Vereinsfarben (freie Sitze sind immer weiß)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={d.roof} onChange={(e) => set({ roof: e.target.checked })} className="h-5 w-5 accent-[var(--fd-accent)]" />Dach</label>
          <div className="flex gap-2">
            <Button className="flex-1" busy={busy} onClick={() => void (async () => {
              setBusy(true); setMsg(null);
              try { await onSave(n, d); setMsg('Gespeichert – gilt ab dem nächsten Spiel.'); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
            })()}>Design speichern</Button>
            <Button variant="ghost" onClick={() => setD({ ...DEFAULT_DESIGN })}>Standard</Button>
          </div>
          {msg && <p className="text-sm text-cream-dim">{msg}</p>}
          {worldId && <Link to={`/w/${worldId}/fankultur`} className="block rounded-lg border border-olive-600 px-3 py-2 text-sm font-semibold text-gold hover:bg-olive-800">Fankultur & Musik: Fahnen, Choreos, Ultras, Hymnen →</Link>}
        </div>
      </div>
    </Card>
  );
}
