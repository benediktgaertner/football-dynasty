import { CLASH_THRESHOLD, colorDistance, readableTextColor } from '@fd/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChoreoEditor } from '../../pages/FanCulture';
import { renderChoreoDesign } from '../../lib/fanArt';
import { fanApi, type Kit, type PrepState, type PrepTeam } from '../../lib/fanApi';
import type { ChoreoDesign } from '../../lib/matchClient';
import { L, W, renderFanLayers, renderStadiumLayer, stadiumMargin } from '../../lib/stadiumArt';
import { competitionTheme } from '../../lib/theme';
import { KitPreview } from '../KitPreview';
import { Button, ErrorBanner, Pill } from '../ui';

const VARIANTS: Array<['home' | 'away' | 'special', string]> = [['home', 'Heim'], ['away', 'Auswärts'], ['special', 'Spezial']];

/**
 * Spielvorbereitung zwischen „Ich bin bereit“ und Anpfiff: Trikot wählen (jeder Manager), Choreografie
 * (nur Heimverein), Vorschau, Bestätigen. Läuft die Frist ab, startet der Termin mit den aktuellen Werten.
 * Hier lassen sich ausschließlich Trikots und Choreografien bearbeiten.
 */
export function PrepMask({ worldId, onDone }: { worldId: string; onDone: () => void }) {
  const [st, setSt] = useState<PrepState | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; name: string; design: ChoreoDesign } | null>(null);
  const ticked = useRef(false);

  const load = useCallback(async () => {
    try {
      const s = await fanApi.prep(worldId);
      if (!s.active) { onDone(); return; }
      setSt(s); setLeft(s.seconds_left ?? 0);
    } catch (e) { setError((e as Error).message); }
  }, [worldId, onDone]);
  useEffect(() => {
    void load();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 2500);
    return () => clearInterval(poll);
  }, [load]);
  // Countdown; bei 0 den Start auslösen (jeder Manager darf – blockiert nie)
  useEffect(() => {
    const t = setInterval(() => setLeft((x) => (x === null ? x : Math.max(0, x - 1))), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left === 0 && !ticked.current) {
      ticked.current = true;
      void fanApi.prepTick(worldId).catch(() => undefined).finally(() => { void load(); });
    }
  }, [left, worldId, load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'active' in (r as PrepState)) { const s = r as PrepState; if (!s.active) onDone(); else setSt(s); } else await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const fx = st?.fixture ?? null;
  if (!st || !fx) {
    return (
      <Overlay><p className="text-cream-dim">{error ?? 'Spielvorbereitung wird geladen …'}</p></Overlay>
    );
  }
  const mine: PrepTeam = fx.is_home ? fx.home : fx.away;
  const other: PrepTeam = fx.is_home ? fx.away : fx.home;
  const clash = colorDistance(fx.home.kit.primary, fx.away.kit.primary) < CLASH_THRESHOLD;
  const th = competitionTheme(fx.competition);
  const canChoreo = fx.is_home && !fx.neutral;

  return (
    <Overlay>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <p className="display text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: th.board.label }}>{fx.competition?.name} · {st.label}</p>
          <h2 className="display text-3xl font-extrabold uppercase leading-none">Spielvorbereitung</h2>
          <p className="text-sm text-cream-dim">{fx.home.name} – {fx.away.name}</p>
        </div>
        <div className="text-right">
          <p className="display text-4xl font-extrabold tabular-nums">{left ?? '–'} s</p>
          <p className="text-xs text-cream-dim">danach Anpfiff mit der aktuellen Auswahl</p>
        </div>
      </div>
      <ErrorBanner error={error} />

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div>
          <PrepPreview fx={fx} />
          {clash && <p className="mt-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">Farbkonflikt: Beide Trikots sind sehr ähnlich. Bitte ein anderes Trikot wählen.</p>}
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {(st.managers ?? []).map((m) => <li key={m.club}><Pill tone={m.confirmed ? 'good' : 'warn'}>{m.club}: {m.confirmed ? 'bestätigt' : 'wählt …'}</Pill></li>)}
            {other.control === 'ai' && <li><Pill tone="good">{other.short}: KI (automatisch)</Pill></li>}
          </ul>
        </div>
        <div className="space-y-3">
          <div>
            <p className="mb-1 font-semibold">Dein Trikot</p>
            <div className="grid grid-cols-3 gap-2">
              {VARIANTS.map(([v, label]) => {
                const kit = mine.kits[v];
                const bad = colorDistance(kit.primary, other.kit.primary) < CLASH_THRESHOLD;
                const active = mine.kit.variant === v;
                return (
                  <button key={v} type="button" disabled={busy !== null || mine.confirmed}
                    onClick={() => void act('k' + v, () => fanApi.prepChoice(worldId, fx.id, v, null, false, null))}
                    className={`rounded-xl border p-2 text-center ${active ? 'border-gold bg-olive-800' : 'border-olive-700 hover:border-olive-500'}`}>
                    <div className="flex justify-center"><MiniKit kit={kit} /></div>
                    <p className="text-sm font-semibold">{label}</p>
                    {bad && <p className="text-[11px] text-amber-300">Farbkonflikt</p>}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-cream-dim">Gegner: {other.name} im {VARIANTS.find(([v]) => v === other.kit.variant)?.[1]}trikot</p>
          </div>

          {canChoreo ? (
            <div>
              <p className="mb-1 font-semibold">Choreografie (Heimkurve)</p>
              <select className="min-h-11 w-full rounded-lg border border-olive-600 bg-olive-900 px-2 text-cream" disabled={mine.confirmed || busy !== null}
                value={fx.choreo?.id ?? ''} onChange={(e) => void act('ch', () => fanApi.prepChoice(worldId, fx.id, null, e.target.value || null, true, null))}>
                <option value="">Standard / automatisch</option>
                {(fx.choreos ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!mine.confirmed && !edit && (
                <button type="button" className="mt-1 text-sm text-gold underline" onClick={() => {
                  const cur = fx.choreos?.find((c) => c.id === fx.choreo?.id);
                  setEdit(cur ? { id: cur.id, name: cur.name, design: cur.design } : { id: null, name: 'Spieltags-Choreo', design: { pattern: 'stripes', colors: fx.home_colors, text: fx.home.short, motif: 'star', block: 'home_curve' } });
                }}>Choreografie anpassen …</button>
              )}
              {edit && (
                <div className="mt-2 rounded-xl border border-olive-700 p-2">
                  <ChoreoEditor draft={edit} setDraft={(f) => setEdit((d) => (d ? f(d) : d))} />
                  <div className="mt-2 flex gap-2">
                    <Button busy={busy === 'save'} disabled={edit.name.trim().length < 2} onClick={() => void act('save', async () => {
                      const id = await fanApi.saveChoreo(worldId, edit.id, edit.name, edit.design);
                      setEdit(null);
                      return fanApi.prepChoice(worldId, fx.id, null, id, true, null);
                    })}>Speichern & verwenden</Button>
                    <Button variant="ghost" onClick={() => setEdit(null)}>Abbrechen</Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-cream-dim">{fx.neutral ? 'Neutraler Spielort – keine Vereinschoreografie.' : `Die Choreografie bestimmt der Heimverein (${fx.home.name}).`}</p>
          )}

          <Button className="w-full" busy={busy === 'ok'} disabled={mine.confirmed} onClick={() => void act('ok', () => fanApi.prepChoice(worldId, fx.id, null, null, false, true))}>
            {mine.confirmed ? 'Bestätigt – warte auf die anderen Manager' : 'Auswahl bestätigen'}
          </Button>
          <p className="text-xs text-cream-dim">Ultragruppen, Fahnen, Stadion und Hymnen bearbeitest du im Stadioneditor („Fankultur“).</p>
        </div>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-ink/80 p-3" role="dialog" aria-modal="true" aria-label="Spielvorbereitung">
      <div className="w-full max-w-5xl rounded-2xl border border-olive-600 bg-olive-900 p-4 shadow-2xl">{children}</div>
    </div>
  );
}

function MiniKit({ kit }: { kit: Kit }) {
  return <div className="pointer-events-none origin-center scale-90"><KitPreview kit={kit} size={64} /></div>;
}

/** Vorschau: Heimstadion mit Choreo, beide Teams in ihren Trikots aufgereiht */
function PrepPreview({ fx }: { fx: NonNullable<PrepState['fixture']> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cap = fx.stadium?.capacity ?? 20000;
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
    const M = stadiumMargin(cap);
    const s = Math.min(cv.width / (L + 2 * M), cv.height / (W + 2 * M));
    const ox = (cv.width - (L + 2 * M) * s) / 2 + M * s, oy = (cv.height - (W + 2 * M) * s) / 2 + M * s;
    const o = { capacity: cap, attendance: cap * 0.85, design: fx.stadium?.design ?? null, homeColors: fx.home_colors, awayColor: fx.away.kit.primary, s, ox, oy, width: cv.width, height: cv.height, homeShort: fx.home.short };
    ctx.fillStyle = '#15191a'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(renderStadiumLayer(o), 0, 0);
    ctx.drawImage(renderFanLayers(o)[0], 0, 0);
    const choreo: ChoreoDesign = fx.choreo ?? { pattern: 'stripes', colors: fx.home_colors, text: fx.home.short, motif: 'crest', block: 'home_curve' };
    if (!fx.neutral) ctx.drawImage(renderChoreoDesign(o, choreo), 0, 0);
    for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? '#327440' : '#2c6838'; ctx.fillRect(ox + (i * L / 18) * s, oy, (L / 18) * s + 1, W * s); }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = Math.max(1, 0.22 * s); ctx.strokeRect(ox, oy, L * s, W * s);
    ctx.beginPath(); ctx.moveTo(ox + (L / 2) * s, oy); ctx.lineTo(ox + (L / 2) * s, oy + W * s); ctx.stroke();
    // Aufstellung vor der Haupttribüne wie beim Einlauf
    const r = 1.6 * s;
    const draw = (kit: Kit, x: number, y: number, n: number) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = kit.primary; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle = kit.secondary;
      if (kit.pattern === 'stripes') for (let k = -2; k <= 2; k += 2) ctx.fillRect(x + (k * r) / 3 - r / 7, y - r, (2 * r) / 7, 2 * r);
      else if (kit.pattern === 'hoops') for (let k = -1; k <= 1; k++) ctx.fillRect(x - r, y + (k * r) / 1.7 - r / 7, 2 * r, (2 * r) / 7);
      else if (kit.pattern === 'halves') ctx.fillRect(x, y - r, r, 2 * r);
      else if (kit.pattern === 'sash') { ctx.beginPath(); ctx.moveTo(x - r, y - r * 0.6); ctx.lineTo(x - r * 0.6, y - r); ctx.lineTo(x + r, y + r * 0.6); ctx.lineTo(x + r * 0.6, y + r); ctx.closePath(); ctx.fill(); }
      ctx.restore();
      ctx.lineWidth = 0.3 * s; ctx.strokeStyle = kit.secondary; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = readableTextColor(kit.primary); ctx.font = `800 ${Math.round(1.6 * s)}px "Barlow Condensed", system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y + 0.1 * s);
    };
    for (let i = 0; i < 11; i++) {
      draw(fx.home.kit, ox + (L / 2 - 2.4 - i * 3.6) * s, oy + (W - 4) * s, i + 1);
      draw(fx.away.kit, ox + (L / 2 + 2.4 + i * 3.6) * s, oy + (W - 4) * s, i + 1);
    }
  }, [fx, cap]);
  return <canvas ref={ref} className="block w-full rounded-xl" style={{ aspectRatio: `${L + 2 * stadiumMargin(cap)} / ${W + 2 * stadiumMargin(cap)}` }} aria-label="Vorschau: Trikots und Choreografie" />;
}
