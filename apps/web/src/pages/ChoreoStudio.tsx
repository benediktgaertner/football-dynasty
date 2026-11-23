import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WorldNav } from '../components/WorldNav';
import { Button, Card, ErrorBanner, Pill, Shell, Spinner } from '../components/ui';
import { fanApi, type FanCulture } from '../lib/fanApi';
import { renderFanLayers, renderStadiumLayer, stadiumMargin, L, W, GAP, type StadiumArtOptions } from '../lib/stadiumArt';
import { ChoreoPlayer, visibleElements } from '../lib/choreo/render';
import { AWAY_Y1, AWAY_X0, blockCount, cellsFromRegions, fenceRect, placementProblem, rectCorners, regionsFromCells, stadiumCells, stadiumGeo, type Cell } from '../lib/choreo/geometry';
import {
  FREE_KINDS, KIND_LABEL, MOTIFS, PATTERNS, SIDES, SIDE_LABEL, TEMPLATES, commit, complexityLimits, historyOf, isV2, newId, normalizeChoreo, redo, sceneCount, undo, validateChoreo, withLegacyFields,
  type BannerEl, type ChoreoElement, type ChoreoV2, type ElementKind, type FenceEl, type FlagsEl, type History, type Region,
} from '../lib/choreo/model';

const sel = 'min-h-11 w-full rounded-lg border border-olive-600 bg-olive-900 px-2 text-cream';
const num = 'min-h-11 w-full rounded-lg border border-olive-600 bg-olive-900 px-2 text-cream';
const ADD_KINDS: ElementKind[] = ['cards', 'blockflag', 'banner', 'fence', 'flags', 'confetti', 'streamers', 'smoke', 'wave'];
const AREA_KINDS = new Set<ElementKind>(['cards', 'blockflag', 'flags', 'confetti', 'streamers', 'smoke', 'wave']);
const round1 = (v: number) => Math.round(v * 10) / 10;

type Drag = { mode: 'move' | 'resize' | 'rotate' | 'point' | 'paint'; id: string; idx?: number; ox: number; oy: number; start: ChoreoElement | null; paintOn?: boolean } | null;

/** Visueller Choreografie-Designer: Stadion-Draufsicht, Tribünen/Blöcke anklicken, Elemente per Drag-and-drop, Szenen, Vorschau, Vorlagen */
export function ChoreoStudio() {
  const { worldId = '' } = useParams();
  const [data, setData] = useState<FanCulture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hist, setHist] = useState<History<ChoreoV2> | null>(null);
  const [live, setLive] = useState<ChoreoV2 | null>(null); // während des Ziehens (noch nicht im Verlauf)
  const [name, setName] = useState('Neue Choreografie');
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [multi, setMulti] = useState(false);
  const [scene, setScene] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<'select' | 'areas'>('select');
  const [pointMode, setPointMode] = useState(false);
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [prefs, setPrefs] = useState<{ random: boolean; saved: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag>(null);
  const layers = useRef<{ key: string; base: HTMLCanvasElement; fans: HTMLCanvasElement } | null>(null);
  const playerRef = useRef<{ key: string; player: ChoreoPlayer } | null>(null);
  const tick = useRef(0);

  const load = useCallback(async () => {
    try {
      const d = await fanApi.culture(worldId);
      setData(d);
      setPrefs(await fanApi.choreoPrefs(worldId).catch(() => null));
      setHist((h) => h ?? historyOf(fromClub(d)));
    } catch (e) { setError((e as Error).message); }
  }, [worldId]);
  useEffect(() => { void load(); }, [load]);

  const design = live ?? hist?.present ?? null;
  const club = data?.club;
  const geo = useMemo(() => (club ? stadiumGeo(club.capacity, club.design) : null), [club]);
  const allCells = useMemo(() => (geo ? stadiumCells(geo) : []), [geo]);
  const limits = club ? complexityLimits(club.capacity) : { elements: 12, scenes: 2, label: '' };
  const selEl = design && selected.length === 1 ? design.elements.find((e) => e.id === selected[0]) ?? null : null;

  const apply = (fn: (d: ChoreoV2) => ChoreoV2) => setHist((h) => (h ? commit(h, fn(h.present)) : h));
  const patchEl = (id: string, p: Partial<ChoreoElement>) => apply((d) => ({ ...d, elements: d.elements.map((e) => (e.id === id ? ({ ...e, ...p } as ChoreoElement) : e)) }));

  // Auswahl von Blöcken spiegelt den gewählten Bereichs-Element
  useEffect(() => {
    if (geo && selEl && 'regions' in selEl) setCells(cellsFromRegions(geo, selEl.regions));
  }, [selEl?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function fromClub(d: FanCulture): ChoreoV2 {
    const g = stadiumGeo(d.club.capacity, d.club.design);
    const t = TEMPLATES[0]!.build({ primary: d.club.primary, secondary: d.club.secondary, short: d.club.short, tiers: g.tiers, closed: g.closed });
    return t;
  }

  // ------------------------------------------------------------------ Zeichnen
  const o = useRef<StadiumArtOptions | null>(null);
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !club || !design || !geo) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); layers.current = null; playerRef.current = null; }
    const M = stadiumMargin(club.capacity);
    const s = Math.min(cw / (L + 2 * M), ch / (W + 2 * M)) * dpr;
    const ox = (canvas.width - (L + 2 * M) * s) / 2 + M * s, oy = (canvas.height - (W + 2 * M) * s) / 2 + M * s;
    const opts: StadiumArtOptions = { capacity: club.capacity, attendance: club.attendance ?? club.capacity * 0.6, design: club.design, homeColors: [club.primary, club.secondary], awayColor: '#7a8794', s, ox, oy, width: canvas.width, height: canvas.height, homeShort: club.short };
    o.current = opts;
    canvas.dataset.view = JSON.stringify({ s, ox, oy, dpr }); // Zuordnung Meter → Bildschirm (für Tests und Diagnose)
    const lk = `${canvas.width}x${canvas.height}|${club.capacity}|${club.design?.style}`;
    if (!layers.current || layers.current.key !== lk) { const [f] = renderFanLayers(opts); layers.current = { key: lk, base: renderStadiumLayer(opts), fans: f }; playerRef.current = null; }
    const pk = `${lk}|${JSON.stringify(design.elements)}|${JSON.stringify(design.scenes)}`;
    if (!playerRef.current || playerRef.current.key !== pk) { playerRef.current?.player.dispose(); playerRef.current = { key: pk, player: new ChoreoPlayer(opts, design) }; }
    const pl = playerRef.current.player;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#121519'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layers.current.base, 0, 0);
    ctx.drawImage(layers.current.fans, 0, 0);
    // Choreografie der gewählten Szene (Wiedergabe: Szenenfolge; sonst Endzustand der Szene)
    const now = performance.now();
    if (playing) pl.drawTimeline(ctx, ((now / 1000) * 1) % pl.duration, now);
    else pl.drawTimeline(ctx, pl.sceneStart(scene) + design.scenes[scene]!.dur * 0.999, now, { staticFrame: true });
    // Spielfeld
    const X = (x: number) => ox + x * s, Y = (y: number) => oy + y * s;
    ctx.fillStyle = '#1f4626'; ctx.fillRect(X(-2.4), Y(-1.5), (L + 4.8) * s, (W + 3) * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = Math.max(1, 0.22 * s); ctx.strokeRect(X(0), Y(0), L * s, W * s);
    ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(W)); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 9.15 * s, 0, Math.PI * 2); ctx.stroke();
    // Gästeblock (gesperrt): schraffiert
    ctx.save(); ctx.beginPath(); ctx.rect(X(AWAY_X0), Y(-GAP - geo.total - 1), (geo.total + GAP + 1) * s, (AWAY_Y1 + GAP + geo.total + 1) * s); ctx.clip();
    ctx.fillStyle = 'rgba(30,40,60,0.55)'; ctx.fillRect(X(AWAY_X0), Y(-60), 80 * s, 120 * s);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    for (let k = -80; k < 160; k += 1.6) { ctx.beginPath(); ctx.moveTo(X(AWAY_X0 + k * 0.4), Y(-30)); ctx.lineTo(X(AWAY_X0 + k * 0.4 + 40), Y(30)); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `${Math.max(10, Math.round(s * 1.4))}px system-ui`; ctx.textAlign = 'center';
    ctx.fillText('Gästeblock', X(AWAY_X0 + geo.total / 2 + 1), Y(AWAY_Y1 / 2));
    // Block-Raster (Bereichswerkzeug)
    if (mode === 'areas') {
      for (const c of allCells) {
        ctx.strokeStyle = c.away ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
        ctx.strokeRect(X(c.x0 - 0.4), Y(c.y0 - 0.45), (c.x1 - c.x0 + 0.8) * s, (c.y1 - c.y0 + 0.9) * s);
        if (cells.has(c.key) && !c.away) { ctx.fillStyle = 'rgba(242,193,78,0.38)'; ctx.fillRect(X(c.x0 - 0.4), Y(c.y0 - 0.45), (c.x1 - c.x0 + 0.8) * s, (c.y1 - c.y0 + 0.9) * s); }
      }
    }
    // Auswahlrahmen freier Elemente
    ctx.lineWidth = Math.max(1.5, s * 0.18); ctx.strokeStyle = '#f2c14e';
    for (const id of selected) {
      const e = design.elements.find((x) => x.id === id); if (!e) continue;
      if (e.kind === 'banner') {
        const c = rectCorners(e.x, e.y, e.w, e.h, e.rot);
        ctx.beginPath(); c.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); ctx.stroke();
        const h = handles(e); ctx.fillStyle = '#f2c14e';
        ctx.fillRect(X(h.resize[0]) - 5, Y(h.resize[1]) - 5, 10, 10); ctx.beginPath(); ctx.arc(X(h.rotate[0]), Y(h.rotate[1]), 6, 0, Math.PI * 2); ctx.fill();
      } else if (e.kind === 'fence') {
        const r = fenceRect(e.side, e.from, e.to, e.h);
        if (r) { const c = rectCorners(r.x, r.y, r.w, r.h, r.rot); ctx.beginPath(); c.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath(); ctx.stroke(); }
      } else if (e.kind === 'flags' && e.points) {
        ctx.fillStyle = '#f2c14e'; e.points.forEach((p) => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), Math.max(4, s * 0.8), 0, Math.PI * 2); ctx.fill(); });
      }
    }
    ctx.textAlign = 'start';
  }, [club, design, geo, scene, playing, mode, cells, selected, allCells]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0; const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop); return () => cancelAnimationFrame(raf);
  }, [playing, draw]);
  useEffect(() => { const r = () => { layers.current = null; draw(); }; window.addEventListener('resize', r); return () => window.removeEventListener('resize', r); }, [draw]);

  // ------------------------------------------------------------------ Zeigerbedienung (Maus und Touch)
  const toMeters = (ev: { clientX: number; clientY: number }): [number, number] | null => {
    const c = canvasRef.current, op = o.current; if (!c || !op) return null;
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    return [((ev.clientX - r.left) * dpr - op.ox) / op.s, ((ev.clientY - r.top) * dpr - op.oy) / op.s];
  };
  const cellAt = (x: number, y: number): Cell | null => allCells.find((c) => !c.away && x >= c.x0 - 0.4 && x <= c.x1 + 0.4 && y >= c.y0 - 0.45 && y <= c.y1 + 0.45) ?? null;

  function handles(e: BannerEl) {
    const c = Math.cos((e.rot * Math.PI) / 180), s = Math.sin((e.rot * Math.PI) / 180);
    return { resize: [e.x + (e.w / 2) * c - (e.h / 2) * s, e.y + (e.w / 2) * s + (e.h / 2) * c] as [number, number], rotate: [e.x + (e.h / 2 + 2.4) * s, e.y - (e.h / 2 + 2.4) * c] as [number, number] };
  }
  const hit = (d: ChoreoV2, x: number, y: number): { id: string; part: 'body' | 'resize' | 'rotate' | 'point'; idx?: number } | null => {
    for (const e of [...d.elements].reverse()) {
      if (e.s0 > scene || e.s1 < scene) continue;
      if (e.kind === 'banner') {
        const h = handles(e);
        if (selected.includes(e.id) && Math.hypot(h.resize[0] - x, h.resize[1] - y) < 1.6) return { id: e.id, part: 'resize' };
        if (selected.includes(e.id) && Math.hypot(h.rotate[0] - x, h.rotate[1] - y) < 1.8) return { id: e.id, part: 'rotate' };
        const a = (-e.rot * Math.PI) / 180, dx = x - e.x, dy = y - e.y;
        const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= e.w / 2 && Math.abs(ly) <= e.h / 2) return { id: e.id, part: 'body' };
      } else if (e.kind === 'fence') {
        const r = fenceRect(e.side, e.from, e.to, e.h);
        if (r) { const a = (-r.rot * Math.PI) / 180, dx = x - r.x, dy = y - r.y; const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) return { id: e.id, part: 'body' }; }
      } else if (e.kind === 'flags' && e.points) {
        const i = e.points.findIndex((p) => Math.hypot(p.x - x, p.y - y) < 1.8);
        if (i >= 0) return { id: e.id, part: 'point', idx: i };
      }
    }
    return null;
  };

  const onDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!design || !geo) return;
    const m = toMeters(ev); if (!m) return;
    const [x, y] = m;
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    // Bereichswerkzeug: Blöcke an-/abwählen (Ziehen malt weiter)
    if (mode === 'areas') {
      const c = cellAt(x, y); if (!c) return;
      const on = !cells.has(c.key);
      drag.current = { mode: 'paint', id: '', ox: x, oy: y, start: null, paintOn: on };
      toggleCell(c.key, on);
      return;
    }
    // Fahnenpunkte setzen
    if (pointMode && selEl?.kind === 'flags') {
      const near = (selEl.points ?? []).findIndex((p) => Math.hypot(p.x - x, p.y - y) < 1.8);
      if (near >= 0) { drag.current = { mode: 'point', id: selEl.id, idx: near, ox: x, oy: y, start: selEl }; return; }
      if (!placementProblem(geo, [[x, y]]) && (selEl.points ?? []).length < selEl.count) {
        patchEl(selEl.id, { points: [...(selEl.points ?? []), { x: round1(x), y: round1(y) }] } as Partial<FlagsEl>);
      }
      return;
    }
    const h = hit(design, x, y);
    if (!h) { if (!multi) setSelected([]); return; }
    setSelected((s) => (multi ? (s.includes(h.id) ? s.filter((i) => i !== h.id) : [...s, h.id]) : [h.id]));
    const el = design.elements.find((e) => e.id === h.id)!;
    drag.current = { mode: h.part === 'resize' ? 'resize' : h.part === 'rotate' ? 'rotate' : h.part === 'point' ? 'point' : 'move', id: h.id, idx: h.idx, ox: x, oy: y, start: JSON.parse(JSON.stringify(el)) };
  };
  const onMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const dg = drag.current; if (!dg || !design || !geo) return;
    const m = toMeters(ev); if (!m) return;
    const [x, y] = m;
    if (dg.mode === 'paint') { const c = cellAt(x, y); if (c) toggleCell(c.key, dg.paintOn!); return; }
    const st = dg.start as ChoreoElement; if (!st) return;
    let next: ChoreoElement | null = null;
    if (st.kind === 'banner') {
      if (dg.mode === 'move') next = { ...st, x: round1(st.x + x - dg.ox), y: round1(st.y + y - dg.oy) };
      else if (dg.mode === 'resize') { const a = (-st.rot * Math.PI) / 180, dx = x - st.x, dy = y - st.y; next = { ...st, w: Math.max(2, Math.min(60, round1(2 * (dx * Math.cos(a) - dy * Math.sin(a))))), h: Math.max(0.5, Math.min(20, round1(2 * (dx * Math.sin(a) + dy * Math.cos(a))))) }; }
      else if (dg.mode === 'rotate') next = { ...st, rot: Math.round((Math.atan2(y - st.y, x - st.x) * 180) / Math.PI + 90) };
      if (next && next.kind === 'banner' && placementProblem(geo, rectCorners(next.x, next.y, next.w, next.h, next.rot))) next = null; // nicht auf dem Spielfeld / im Gästeblock
    } else if (st.kind === 'fence' && dg.mode === 'move') {
      const along = st.side === 'N' || st.side === 'S' ? (x - dg.ox) / L : (y - dg.oy) / W;
      const span = st.to - st.from; const f0 = Math.max(0, Math.min(1 - span, st.from + along));
      next = { ...st, from: Math.round(f0 * 100) / 100, to: Math.round((f0 + span) * 100) / 100 };
    } else if (st.kind === 'flags' && dg.mode === 'point' && dg.idx !== undefined && st.points) {
      if (!placementProblem(geo, [[x, y]])) { const pts = st.points.map((p, i) => (i === dg.idx ? { x: round1(x), y: round1(y) } : p)); next = { ...st, points: pts }; }
    }
    if (next) { const e = next; setLive({ ...design, elements: design.elements.map((q) => (q.id === e.id ? e : q)) }); }
  };
  const onUp = () => {
    const dg = drag.current; drag.current = null;
    if (!dg) return;
    if (live) { setHist((h) => (h ? commit(h, live) : h)); setLive(null); }
  };

  function toggleCell(key: string, on: boolean) {
    setCells((prev) => {
      const nx = new Set(prev); if (on) nx.add(key); else nx.delete(key);
      if (selEl && 'regions' in selEl && geo) {
        const regions = regionsFromCells(geo, nx);
        if (regions.length) patchEl(selEl.id, { regions } as Partial<ChoreoElement>);
      }
      return nx;
    });
  }

  // ------------------------------------------------------------------ Aktionen
  const addElement = (kind: ElementKind) => {
    if (!design || !geo || !club) return;
    if (design.elements.length >= limits.elements) { setError(`${limits.label} – weitere Elemente sind in diesem Stadion nicht möglich.`); return; }
    setError(null);
    const regions: Region[] = cells.size && geo ? regionsFromCells(geo, cells) : [{ side: 'W' }];
    const c = [club.primary, club.secondary];
    const base = { id: newId(), s0: scene, s1: scene } as const;
    let el: ChoreoElement;
    switch (kind) {
      case 'cards': el = { ...base, kind, regions, pattern: 'stripes', colors: c, text: '', motif: 'none', reveal: 'sweep' }; break;
      case 'blockflag': el = { ...base, kind, regions, pattern: 'gradient', colors: c, text: club.short, motif: 'crest', reveal: 'down' }; break;
      case 'banner': el = { ...base, kind, persist: true, x: geo.sides.includes('S') ? L / 2 : 20, y: W + GAP + 2.4, w: 18, h: 2, rot: 0, text: 'UNSER VEREIN', colors: [c[0]!, c[1]!] }; break;
      case 'fence': el = { ...base, kind, persist: true, side: 'S', from: 0.25, to: 0.75, h: 1, text: club.short, colors: [c[0]!, c[1]!] }; break;
      case 'flags': el = { ...base, kind, persist: true, regions, flag: { shape: 'rect', pattern: 'stripes_h', colors: c }, size: 'swing_s', count: 8 }; break;
      case 'confetti': el = { ...base, kind, regions, colors: [...c, '#f2c14e'], density: 3 }; break;
      case 'streamers': el = { ...base, kind, regions, colors: c, density: 3 }; break;
      case 'smoke': el = { ...base, kind, regions, colors: [c[0]!], density: 3 }; break;
      default: el = { ...base, kind: 'wave', regions, colors: ['#ffffff'], speed: 1 };
    }
    apply((d) => ({ ...d, elements: [...d.elements, el] }));
    setSelected([el.id]);
  };
  const duplicate = () => apply((d) => ({ ...d, elements: [...d.elements, ...d.elements.filter((e) => selected.includes(e.id)).map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: newId(), ...(e.kind === 'banner' ? { x: e.x + 2, y: e.y + 2 } : {}) } as ChoreoElement))].slice(0, limits.elements) }));
  const remove = () => { apply((d) => ({ ...d, elements: d.elements.filter((e) => !selected.includes(e.id)) })); setSelected([]); };
  const addScene = () => { if (design && design.scenes.length < limits.scenes) { apply((d) => ({ ...d, scenes: [...d.scenes, { dur: 6 }] })); setScene(design.scenes.length); } else setError(`${limits.label}`); };
  const removeScene = () => {
    if (!design || design.scenes.length <= 1) return;
    apply((d) => ({ ...d, scenes: d.scenes.filter((_, i) => i !== scene), elements: d.elements.filter((e) => !(e.s0 === scene && e.s1 === scene)).map((e) => ({ ...e, s0: e.s0 > scene ? e.s0 - 1 : e.s0, s1: Math.min(d.scenes.length - 2, e.s1 >= scene ? Math.max(e.s0 > scene ? e.s0 - 1 : e.s0, e.s1 - 1) : e.s1) })) }));
    setScene(Math.max(0, scene - 1));
  };
  const applyTemplate = (key: string) => {
    if (!club || !geo) return;
    const t = TEMPLATES.find((x) => x.key === key)!.build({ primary: club.primary, secondary: club.secondary, short: club.short, tiers: geo.tiers, closed: geo.closed });
    // an das Stadion anpassen: nicht vorhandene Szenen/Elemente kürzen
    const fitted: ChoreoV2 = { ...t, scenes: t.scenes.slice(0, limits.scenes), elements: t.elements.filter((e) => e.s0 < limits.scenes).map((e) => ({ ...e, s1: Math.min(e.s1, limits.scenes - 1) })).slice(0, limits.elements) };
    setHist((h) => (h ? commit(h, fitted) : historyOf(fitted)));
    setScene(0); setSelected([]); setName(TEMPLATES.find((x) => x.key === key)!.label); setCurrent(null);
  };
  const save = async () => {
    if (!design || !club) return;
    const full = withLegacyFields(design, { primary: club.primary, secondary: club.secondary, short: club.short });
    const errs = validateChoreo(full);
    if (errs.length) { setError(`Nicht speicherbar: ${[...new Set(errs)].join(', ')}`); return; }
    setBusy('save'); setError(null);
    try { const id = await fanApi.saveChoreo(worldId, current, name.trim() || 'Choreografie', full); setCurrent(id); setMsg('Choreografie gespeichert.'); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  const loadSaved = (c: FanCulture['choreos'][number]) => { setHist(historyOf(normalizeChoreo(c.design))); setName(c.name); setCurrent(c.id); setSelected([]); setScene(0); setMsg(null); };

  // Tastatur: Rückgängig/Wiederholen, Entf
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); setHist((h) => (h ? (e.shiftKey ? redo(h) : undo(h)) : h)); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); setHist((h) => (h ? redo(h) : h)); }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (selected.length) { e.preventDefault(); remove(); } }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !hist || !design || !club || !geo) return <Shell><WorldNav worldId={worldId} />{error ? <ErrorBanner error={error} /> : <Spinner label="Choreo-Designer wird geladen …" />}</Shell>;
  const visible = o.current ? visibleElements(o.current, design) : design.elements.length;
  const hidden = design.elements.length - visible;

  return (
    <Shell>
      <WorldNav worldId={worldId} />
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h1 className="display text-4xl font-extrabold uppercase">Choreo-Designer</h1>
        <span className="text-sm text-cream-dim">kostenlos · rein optisch · {limits.label}</span>
        <Link to={`/w/${worldId}/fankultur`} className="ml-auto text-sm text-gold underline">Fankultur & Musik</Link>
      </div>
      <ErrorBanner error={error} />
      {msg && <p className="mb-2 text-sm text-emerald-300" data-testid="choreo-msg">{msg}</p>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="choreo-toolbar">
            <Button variant="secondary" className="!px-3" disabled={!hist.past.length} onClick={() => setHist((h) => (h ? undo(h) : h))} data-testid="choreo-undo">↶ Rückgängig</Button>
            <Button variant="secondary" className="!px-3" disabled={!hist.future.length} onClick={() => setHist((h) => (h ? redo(h) : h))} data-testid="choreo-redo">↷ Wiederholen</Button>
            <Button variant={mode === 'select' ? 'primary' : 'secondary'} className="!px-3" onClick={() => { setMode('select'); setPointMode(false); }} data-testid="choreo-tool-select">Auswählen / Verschieben</Button>
            <Button variant={mode === 'areas' ? 'primary' : 'secondary'} className="!px-3" onClick={() => setMode('areas')} data-testid="choreo-tool-areas">Tribünen & Blöcke wählen</Button>
            <Button variant={playing ? 'primary' : 'secondary'} className="!px-3" onClick={() => setPlaying((p) => !p)} data-testid="choreo-play">{playing ? '■ Vorschau stoppen' : '▶ Vorschau'}</Button>
            <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} data-testid="choreo-multi" /> Mehrfachauswahl</label>
          </div>
          <canvas ref={canvasRef} data-testid="choreo-canvas" className="h-[52vh] min-h-[320px] w-full touch-none rounded-xl bg-ink" style={{ touchAction: 'none' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
          <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="choreo-scenes">
            {design.scenes.map((s, i) => (
              <button key={i} type="button" onClick={() => setScene(i)} className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${scene === i ? 'border-gold bg-gold/15 text-gold' : 'border-olive-600'}`} data-testid={`choreo-scene-${i}`}>Szene {i + 1} · {s.dur} s</button>
            ))}
            <Button variant="secondary" className="!px-3" onClick={addScene} data-testid="choreo-add-scene">+ Szene</Button>
            <Button variant="ghost" className="!px-3" disabled={design.scenes.length <= 1} onClick={removeScene}>Szene löschen</Button>
            <label className="flex items-center gap-1 text-sm">Dauer<input type="number" min={2} max={30} className={`${num} !w-20`} value={design.scenes[scene]!.dur} data-testid="choreo-scene-dur"
              onChange={(e) => apply((d) => ({ ...d, scenes: d.scenes.map((s, i) => (i === scene ? { ...s, dur: Math.max(2, Math.min(30, Number(e.target.value) || 6)) } : s)) }))} /></label>
          </div>
          <p className="mt-2 text-xs text-cream-dim">Der schraffierte Gästeblock bleibt immer frei. Banner und Fahnen lassen sich nicht auf dem Spielfeld oder im Gästeblock platzieren. {hidden > 0 && <span className="text-amber-300" data-testid="choreo-hidden">{hidden} Element(e) liegen auf Tribünen, die dieses Stadion nicht hat, und werden nicht angezeigt.</span>}</p>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <input className={`${num} !w-64`} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Name der Choreografie" data-testid="choreo-name" />
              <Button busy={busy === 'save'} onClick={() => void save()} data-testid="choreo-save">{current ? 'Änderungen speichern' : 'Speichern'}</Button>
              {current && <Button variant="secondary" onClick={() => { setCurrent(null); setName(`${name} (Kopie)`.slice(0, 40)); }} data-testid="choreo-saveas">Als Kopie</Button>}
            </div>
            <h3 className="display mt-3 text-lg font-bold uppercase">Elemente hinzufügen</h3>
            <div className="mt-1 flex flex-wrap gap-2" data-testid="choreo-add">
              {ADD_KINDS.map((k) => <Button key={k} variant="secondary" className="!px-3 !text-base" onClick={() => addElement(k)} data-testid={`choreo-add-${k}`}>{KIND_LABEL[k]}</Button>)}
            </div>
            <h3 className="display mt-3 text-lg font-bold uppercase">Tribünen für neue Elemente</h3>
            <div className="mt-1 flex flex-wrap gap-2">
              {geo.sides.map((s) => <Button key={s} variant="secondary" className="!px-2 !text-sm" onClick={() => { setMode('areas'); const keys = allCells.filter((c) => c.side === s && !c.away).map((c) => c.key); setCells((p) => { const nx = new Set(p); keys.forEach((k) => nx.add(k)); return nx; }); }} data-testid={`choreo-side-${s}`}>{SIDE_LABEL[s]}</Button>)}
              <Button variant="secondary" className="!px-2 !text-sm" onClick={() => { setMode('areas'); setCells(new Set(allCells.filter((c) => !c.away).map((c) => c.key))); }} data-testid="choreo-side-all">Ganzes Stadion</Button>
              <Button variant="ghost" className="!px-2 !text-sm" onClick={() => setCells(new Set())}>Auswahl leeren</Button>
            </div>
            <p className="mt-1 text-xs text-cream-dim">{geo.tiers > 1 ? `${geo.tiers} Ränge (Unterrang am Spielfeld)` : '1 Rang'} · {geo.closed ? 'mit Eckbereichen' : 'offene Ecken'} · {cells.size} Blöcke gewählt</p>
          </Card>

          <Card>
            <h3 className="display text-lg font-bold uppercase">Elemente ({design.elements.length}/{limits.elements})</h3>
            <ul className="mt-1 max-h-44 space-y-1 overflow-y-auto" data-testid="choreo-list">
              {design.elements.map((e) => (
                <li key={e.id}>
                  <button type="button" onClick={() => setSelected((s) => (multi ? (s.includes(e.id) ? s.filter((i) => i !== e.id) : [...s, e.id]) : [e.id]))}
                    className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-2 text-left text-sm ${selected.includes(e.id) ? 'border-gold bg-gold/10' : 'border-olive-600'}`} data-testid={`choreo-el-${e.kind}`}>
                    <span className="font-semibold">{KIND_LABEL[e.kind]}</span>
                    <span className="text-xs text-cream-dim">Szene {e.s0 + 1}{e.s1 !== e.s0 ? `–${e.s1 + 1}` : ''}{e.persist ? ' · bleibt im Spiel' : ''}</span>
                  </button>
                </li>
              ))}
              {!design.elements.length && <li className="text-sm text-cream-dim">Noch keine Elemente – oben hinzufügen oder eine Vorlage wählen.</li>}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" className="!px-3" disabled={!selected.length} onClick={duplicate} data-testid="choreo-duplicate">Duplizieren</Button>
              <Button variant="danger" className="!px-3" disabled={!selected.length} onClick={remove} data-testid="choreo-delete">Löschen</Button>
            </div>
            {selected.length > 1 && <p className="mt-2 text-xs text-cream-dim" data-testid="choreo-multi-info">{selected.length} Elemente gewählt</p>}
            {selEl && <Props el={selEl} scenes={sceneCount(design)} patch={(p) => patchEl(selEl.id, p)} pointMode={pointMode} setPointMode={(v) => { setPointMode(v); if (v) setMode('select'); }} />}
          </Card>

          <Card>
            <h3 className="display text-lg font-bold uppercase">Vorlagen</h3>
            <div className="mt-1 grid gap-2 sm:grid-cols-2" data-testid="choreo-templates">
              {TEMPLATES.map((t) => (
                <button key={t.key} type="button" onClick={() => applyTemplate(t.key)} className="rounded-lg border border-olive-600 p-2 text-left hover:border-gold" data-testid={`choreo-tpl-${t.key}`}>
                  <span className="block font-semibold">{t.label}</span><span className="text-xs text-cream-dim">{t.hint}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <h3 className="display text-lg font-bold uppercase">Gespeicherte Choreografien ({data.choreos.length}/12)</h3>
            <ul className="mt-1 space-y-1" data-testid="choreo-saved">
              {data.choreos.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-lg border border-olive-600 px-2 py-1">
                  <span className="flex-1 truncate font-semibold">{c.name}{isV2(c.design) ? <Pill tone="gold">{c.design.scenes.length} Szenen</Pill> : <Pill>einfach</Pill>}</span>
                  <Button variant="secondary" className="!min-h-9 !px-3 !text-sm" onClick={() => loadSaved(c)} data-testid="choreo-load">Bearbeiten</Button>
                  <Button variant="ghost" className="!min-h-9 !px-3 !text-sm" onClick={() => { if (confirm(`„${c.name}“ löschen?`)) { setBusy('del'); void fanApi.deleteChoreo(worldId, c.id).then(load).catch((e) => setError((e as Error).message)).finally(() => setBusy(null)); } }}>Löschen</Button>
                </li>
              ))}
              {!data.choreos.length && <li className="text-sm text-cream-dim">Noch nichts gespeichert (z. B. Standard-Heimspiel, Derby, Spitzenspiel, Pokalfinale).</li>}
            </ul>
            <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={prefs?.random ?? false} disabled={!prefs} data-testid="choreo-random"
              onChange={(e) => { const on = e.target.checked; setPrefs((p) => (p ? { ...p, random: on } : p)); void fanApi.setChoreoRandom(worldId, on).catch((er) => { setPrefs((p) => (p ? { ...p, random: !on } : p)); setError((er as Error).message); }); }} />
              <span>Bei Heimspielen ohne eigene Wahl eine zufällige gespeicherte Choreografie verwenden (je Partie fest, für alle Spieler gleich)</span></label>
            <p className="mt-1 text-xs text-cream-dim">Die Choreografie für ein bestimmtes Heimspiel wählst du in der Spielvorbereitung – das ändert dein Stadion nicht dauerhaft.</p>
          </Card>
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------- Eigenschaften
function Props({ el, scenes, patch, pointMode, setPointMode }: { el: ChoreoElement; scenes: number; patch: (p: Partial<ChoreoElement>) => void; pointMode: boolean; setPointMode: (v: boolean) => void }) {
  const colors = 'colors' in el ? el.colors : el.kind === 'flags' ? el.flag.colors : [];
  const setColors = (cs: string[]) => (el.kind === 'flags' ? patch({ flag: { ...el.flag, colors: cs } } as Partial<ChoreoElement>) : patch({ colors: cs } as Partial<ChoreoElement>));
  const free = FREE_KINDS.includes(el.kind);
  return (
    <div className="mt-3 border-t border-olive-600 pt-3" data-testid="choreo-props">
      <h3 className="display text-lg font-bold uppercase">{KIND_LABEL[el.kind]} bearbeiten</h3>
      <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
        <label>Farben (bis 4)<div className="flex flex-wrap gap-1" data-testid="choreo-colors">
          {colors.map((c, i) => <input key={i} type="color" value={c} className="h-11 w-11 rounded border border-olive-600 bg-transparent" aria-label={`Farbe ${i + 1}`} onChange={(e) => setColors(colors.map((x, j) => (j === i ? e.target.value : x)))} />)}
          {colors.length < 4 && <button type="button" className="h-11 w-11 rounded border border-olive-600" onClick={() => setColors([...colors, '#ffffff'])} aria-label="Farbe hinzufügen">+</button>}
          {colors.length > 1 && <button type="button" className="h-11 w-11 rounded border border-olive-600" onClick={() => setColors(colors.slice(0, -1))} aria-label="Farbe entfernen">−</button>}
        </div></label>
        {(el.kind === 'cards' || el.kind === 'blockflag') && <label>Muster<select className={sel} value={el.pattern} onChange={(e) => patch({ pattern: e.target.value } as Partial<ChoreoElement>)} data-testid="choreo-pattern">{PATTERNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        {(el.kind === 'cards' || el.kind === 'blockflag') && <label>Symbol / Wappen<select className={sel} value={el.motif ?? 'none'} onChange={(e) => patch({ motif: e.target.value } as Partial<ChoreoElement>)}>{MOTIFS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        {(el.kind === 'cards' || el.kind === 'blockflag') && <label>Erscheinen<select className={sel} value={el.reveal ?? 'fade'} onChange={(e) => patch({ reveal: e.target.value } as Partial<ChoreoElement>)}>{[['fade', 'Einblenden'], ['sweep', 'Aufdecken (seitlich)'], ['down', 'Ausrollen (nach unten)'], ['up', 'Ausrollen (nach oben)'], ['none', 'Sofort']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        {'text' in el && <label className="col-span-2">Text / Schriftzug<input className={num} value={el.text ?? ''} maxLength={40} onChange={(e) => patch({ text: e.target.value } as Partial<ChoreoElement>)} data-testid="choreo-text" /></label>}
        {el.kind === 'cards' && <label>Wechselmuster alle … s (0 = aus)<input type="number" min={0} max={30} className={num} value={el.flip ?? 0}
          onChange={(e) => { const v = Number(e.target.value); patch(v >= 1 ? { flip: v, colors2: el.colors2 ?? [...el.colors].reverse(), pattern2: el.pattern2 ?? el.pattern } as Partial<ChoreoElement> : { flip: undefined } as Partial<ChoreoElement>); }} /></label>}
        {el.kind === 'banner' && <>
          <label>Breite (m)<input type="number" className={num} min={2} max={60} value={el.w} onChange={(e) => patch({ w: Math.max(2, Math.min(60, Number(e.target.value) || 2)) } as Partial<BannerEl>)} data-testid="choreo-w" /></label>
          <label>Höhe (m)<input type="number" className={num} min={0.5} max={20} step={0.5} value={el.h} onChange={(e) => patch({ h: Math.max(0.5, Math.min(20, Number(e.target.value) || 1)) } as Partial<BannerEl>)} /></label>
          <label>Drehung (°)<input type="number" className={num} min={-180} max={180} value={el.rot} onChange={(e) => patch({ rot: Number(e.target.value) || 0 } as Partial<BannerEl>)} data-testid="choreo-rot" /></label>
          <label>Ausrichtung<select className={sel} value={el.orient ?? 'h'} onChange={(e) => patch({ orient: e.target.value } as Partial<BannerEl>)}><option value="h">Horizontal</option><option value="v">Vertikal</option></select></label>
          <label>Position x / y (m)<span className="flex gap-1"><input type="number" className={num} value={el.x} onChange={(e) => patch({ x: Number(e.target.value) || 0 } as Partial<BannerEl>)} data-testid="choreo-x" /><input type="number" className={num} value={el.y} onChange={(e) => patch({ y: Number(e.target.value) || 0 } as Partial<BannerEl>)} /></span></label>
        </>}
        {el.kind === 'fence' && <>
          <label>Seite<select className={sel} value={el.side} onChange={(e) => patch({ side: e.target.value } as Partial<FenceEl>)}>{[['N', 'Nord'], ['S', 'Süd'], ['W', 'West'], ['E', 'Ost (ohne Gästeblock)']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Höhe (m)<input type="number" className={num} min={0.4} max={3} step={0.1} value={el.h} onChange={(e) => patch({ h: Math.max(0.4, Math.min(3, Number(e.target.value) || 1)) } as Partial<FenceEl>)} /></label>
          <label>Von (%)<input type="number" className={num} min={0} max={100} value={Math.round(el.from * 100)} onChange={(e) => patch({ from: Math.min(el.to - 0.05, Math.max(0, Number(e.target.value) / 100)) } as Partial<FenceEl>)} /></label>
          <label>Bis (%)<input type="number" className={num} min={0} max={100} value={Math.round(el.to * 100)} onChange={(e) => patch({ to: Math.max(el.from + 0.05, Math.min(1, Number(e.target.value) / 100)) } as Partial<FenceEl>)} /></label>
        </>}
        {el.kind === 'flags' && <>
          <label>Form<select className={sel} value={el.flag.shape} onChange={(e) => patch({ flag: { ...el.flag, shape: e.target.value } } as Partial<ChoreoElement>)} data-testid="choreo-flag-shape">{[['rect', 'Rechteck'], ['square', 'Quadrat'], ['triangle', 'Dreieck'], ['swallow', 'Schwalbenschwanz'], ['banner', 'Querbanner']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Größe<select className={sel} value={el.size} onChange={(e) => patch({ size: e.target.value } as Partial<FlagsEl>)} data-testid="choreo-flag-size">{[['swing_s', 'Kleine Schwenkfahne'], ['swing_l', 'Große Schwenkfahne'], ['double', 'Doppelhalter']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Muster<select className={sel} value={el.flag.pattern} onChange={(e) => patch({ flag: { ...el.flag, pattern: e.target.value } } as Partial<ChoreoElement>)}>{[['solid', 'Einfarbig'], ['stripes_h', 'Streifen'], ['stripes_v', 'Streifen senkrecht'], ['diagonal', 'Diagonal'], ['halves', 'Geteilt'], ['cross', 'Kreuz'], ['checker', 'Schachbrett'], ['star', 'Stern']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Anzahl ({el.count})<input type="range" min={1} max={40} value={el.count} onChange={(e) => patch({ count: Number(e.target.value) } as Partial<FlagsEl>)} data-testid="choreo-flag-count" /></label>
          <div className="col-span-2 flex flex-wrap items-center gap-2">
            <Button variant={pointMode ? 'primary' : 'secondary'} className="!px-3 !text-sm" onClick={() => setPointMode(!pointMode)} data-testid="choreo-flag-points">{pointMode ? 'Platzieren beenden' : 'Einzeln platzieren'}</Button>
            {el.points && el.points.length > 0 && <Button variant="ghost" className="!px-3 !text-sm" onClick={() => patch({ points: undefined } as Partial<FlagsEl>)}>Automatisch verteilen</Button>}
            <span className="text-xs text-cream-dim">{el.points?.length ?? 0} von {el.count} Fahnen einzeln gesetzt{pointMode ? ' – tippe auf die Tribüne, ziehen verschiebt' : ''}</span>
          </div>
        </>}
        {(el.kind === 'confetti' || el.kind === 'streamers' || el.kind === 'smoke') && <label>Dichte ({el.density})<input type="range" min={1} max={5} value={el.density} onChange={(e) => patch({ density: Number(e.target.value) } as Partial<ChoreoElement>)} /></label>}
        {el.kind === 'wave' && <label>Tempo ({el.speed})<input type="range" min={0.3} max={3} step={0.1} value={el.speed} onChange={(e) => patch({ speed: Number(e.target.value) } as Partial<ChoreoElement>)} /></label>}
        <label>Sichtbar ab Szene<select className={sel} value={el.s0} onChange={(e) => patch({ s0: Number(e.target.value), s1: Math.max(Number(e.target.value), el.s1) })} data-testid="choreo-s0">{Array.from({ length: scenes }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></label>
        <label>bis Szene<select className={sel} value={el.s1} onChange={(e) => patch({ s1: Number(e.target.value) })} data-testid="choreo-s1">{Array.from({ length: scenes }, (_, i) => i >= el.s0 && <option key={i} value={i}>{i + 1}</option>)}</select></label>
        <label className="col-span-2 flex items-center gap-2"><input type="checkbox" checked={!!el.persist} onChange={(e) => patch({ persist: e.target.checked })} data-testid="choreo-persist" /> Bleibt nach dem Einlauf während des Spiels sichtbar</label>
      </div>
      {free && <p className="mt-1 text-xs text-cream-dim">Ziehen verschiebt{el.kind === 'banner' ? ', der eckige Griff ändert die Größe, der runde Griff dreht.' : '.'}</p>}
    </div>
  );
}
void SIDES; void blockCount;
