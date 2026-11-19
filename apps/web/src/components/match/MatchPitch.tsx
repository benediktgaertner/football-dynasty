import { readableTextColor } from '@fd/shared';
import { useEffect, useRef } from 'react';
import type { MatchClient, RosterTeam, StadiumView } from '../../lib/matchClient';
import { renderStadiumLayer, stadiumMargin } from '../../lib/stadiumArt';

const L = 105;
const W = 68;
/** Seitenverhältnis der Spielansicht inkl. Stadion */
export function pitchAspect(stadium: StadiumView | null | undefined): string {
  const m = stadiumMargin(stadium?.capacity);
  return `${L + 2 * m} / ${W + 2 * m}`;
}

/**
 * Canvas-Darstellung der Live-Partie: 60 fps mit Interpolation zwischen den Snapshots,
 * Trikots in Vereinsfarben, Ballhöhe mit Schatten, Ballspur und Name des Ballführenden.
 */
export function MatchPitch({ client, teams, homeColor, awayColor, highlight, stadium }: {
  stadium?: StadiumView | null;
  client: MatchClient;
  teams: { home: RosterTeam; away: RosterTeam };
  homeColor: string;
  awayColor: string;
  highlight?: string | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const info = new Map<string, { n: number; side: 'home' | 'away'; name: string }>();
    for (const p of teams.home.players) info.set(p.id, { n: p.shirt, side: 'home', name: p.name });
    for (const p of teams.away.players) info.set(p.id, { n: p.shirt, side: 'away', name: p.name });
    const fill = { home: homeColor, away: awayColor };
    const txt = { home: readableTextColor(homeColor), away: readableTextColor(awayColor) };
    const ring = {
      home: teams.home.colorAlt && teams.home.colorAlt.toLowerCase() !== homeColor.toLowerCase() ? teams.home.colorAlt : txt.home,
      away: awayColor.toLowerCase() === teams.away.color.toLowerCase() && teams.away.colorAlt.toLowerCase() !== awayColor.toLowerCase() ? teams.away.colorAlt : teams.away.color.toLowerCase() !== awayColor.toLowerCase() ? teams.away.color : txt.away,
    };
    const trail: Array<[number, number]> = [];
    // Rand in Metern: Tore/Namen, bei bekanntem Stadion zusätzlich die Tribünen
    const M = stadiumMargin(stadium?.capacity);
    let layer: HTMLCanvasElement | null = null;
    let layerKey = '';
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
      const s = Math.min(cw / (L + 2 * M), ch / (W + 2 * M)) * dpr;
      const ox = (canvas.width - (L + 2 * M) * s) / 2 + M * s;
      const oy = (canvas.height - (W + 2 * M) * s) / 2 + M * s;
      const X = (x: number) => ox + x * s;
      const Y = (y: number) => oy + y * s;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Stadion (Tribünen + Fans nach realer Auslastung) als vorberechnete Ebene, sonst Rasen bis zum Rand
      if (stadium) {
        ctx.fillStyle = '#15191a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const key = `${canvas.width}x${canvas.height}`;
        if (key !== layerKey) {
          layer = renderStadiumLayer({ capacity: stadium.capacity, attendance: stadium.attendance ?? stadium.capacity * 0.5, design: stadium.design,
            homeColors: [teams.home.color, teams.home.colorAlt], awayColor, s, ox, oy, width: canvas.width, height: canvas.height });
          layerKey = key;
        }
        if (layer) ctx.drawImage(layer, 0, 0);
        ctx.fillStyle = '#1f4626';
        ctx.fillRect(X(-2.4), Y(-1.5), (L + 4.8) * s, (W + 3) * s);
      } else {
        ctx.fillStyle = '#1f4626';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? '#2f6c3a' : '#2a6234'; ctx.fillRect(X((i * L) / 18), Y(-1.5), (L / 18) * s + 1, (W + 3) * s); }
      const vg = ctx.createRadialGradient(X(L / 2), Y(W / 2), W * s * 0.3, X(L / 2), Y(W / 2), L * s * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Linien
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1, 0.22 * s);
      ctx.strokeRect(X(0), Y(0), L * s, W * s);
      ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(W)); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 9.15 * s, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 0.35 * s, 0, Math.PI * 2); ctx.fill();
      for (const left of [true, false]) {
        const gx = left ? 0 : L;
        const d = left ? 1 : -1;
        ctx.strokeRect(X(left ? 0 : L - 16.5), Y(W / 2 - 20.16), 16.5 * s, 40.32 * s);
        ctx.strokeRect(X(left ? 0 : L - 5.5), Y(W / 2 - 9.16), 5.5 * s, 18.32 * s);
        ctx.beginPath(); ctx.arc(X(gx + d * 11), Y(W / 2), 0.3 * s, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(X(gx + d * 11), Y(W / 2), 9.15 * s, left ? -0.93 : Math.PI - 0.93, left ? 0.93 : Math.PI + 0.93); ctx.stroke();
        // Tor mit Netz
        const nx = left ? X(-2.2) : X(L);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(nx, Y(W / 2 - 3.66), 2.2 * s, 7.32 * s);
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(0.5, 0.06 * s);
        for (let k = 0; k <= 7; k++) { ctx.beginPath(); ctx.moveTo(nx, Y(W / 2 - 3.66 + k * 1.046)); ctx.lineTo(nx + 2.2 * s, Y(W / 2 - 3.66 + k * 1.046)); ctx.stroke(); }
        ctx.restore();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.5, 0.3 * s);
        ctx.beginPath(); ctx.moveTo(X(gx), Y(W / 2 - 3.66)); ctx.lineTo(left ? X(-2.2) : X(L + 2.2), Y(W / 2 - 3.66)); ctx.lineTo(left ? X(-2.2) : X(L + 2.2), Y(W / 2 + 3.66)); ctx.lineTo(X(gx), Y(W / 2 + 3.66)); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = Math.max(1, 0.22 * s);
      }
      for (const [cx, cy, a0] of [[0, 0, 0], [L, 0, Math.PI / 2], [L, W, Math.PI], [0, W, -Math.PI / 2]] as const) {
        ctx.beginPath(); ctx.arc(X(cx), Y(cy), 1 * s, a0, a0 + Math.PI / 2); ctx.stroke();
      }

      const st = client.interpolated();
      if (!st) return;
      const sinceCut = performance.now() - client.cutAt;
      if (sinceCut < 50) trail.length = 0;
      const [bx, by, bz] = st.ball;
      // Ballspur
      trail.push([bx, by - bz * 0.55]);
      if (trail.length > 14) trail.shift();
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1]!, b = trail[i]!;
        ctx.strokeStyle = `rgba(255,255,255,${(i / trail.length) * 0.35})`;
        ctx.lineWidth = (0.15 + (i / trail.length) * 0.35) * s;
        ctx.beginPath(); ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1])); ctx.stroke();
      }

      const r = 1.45 * s;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let carrierPos: [number, number, string] | null = null;
      // Spieler (Schatten zuerst)
      for (const [, [x, y]] of st.players) {
        ctx.beginPath(); ctx.ellipse(X(x) + 0.25 * s, Y(y) + 0.55 * s, r * 1.05, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
      }
      ctx.font = `700 ${Math.round(1.5 * s)}px "Barlow Condensed", system-ui, sans-serif`;
      for (const [id, [x, y]] of st.players) {
        const p = info.get(id);
        if (!p) continue;
        const isCarrier = id === st.carrier;
        if (isCarrier) {
          ctx.beginPath(); ctx.arc(X(x), Y(y), r * 1.75, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(242,193,78,0.22)'; ctx.fill();
          carrierPos = [x, y, p.name];
        }
        ctx.beginPath(); ctx.arc(X(x), Y(y), r, 0, Math.PI * 2);
        ctx.fillStyle = fill[p.side]; ctx.fill();
        ctx.lineWidth = 0.32 * s;
        ctx.strokeStyle = id === highlight ? '#f2c14e' : ring[p.side]; ctx.stroke();
        ctx.fillStyle = txt[p.side];
        ctx.fillText(String(p.n || ''), X(x), Y(y) + 0.08 * s);
      }
      // Ball: Schatten am Boden, Ball mit Höhe
      ctx.beginPath(); ctx.ellipse(X(bx), Y(by) + 0.3 * s, 0.7 * s, 0.4 * s, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      const br = (0.72 + Math.min(bz, 9) * 0.06) * s;
      ctx.beginPath(); ctx.arc(X(bx), Y(by - bz * 0.55), br, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 0.14 * s; ctx.strokeStyle = '#111'; ctx.stroke();
      // Name des Ballführenden
      if (carrierPos) {
        const [x, y, name] = carrierPos;
        ctx.font = `600 ${Math.round(1.55 * s)}px "Barlow", system-ui, sans-serif`;
        const w = ctx.measureText(name).width + 0.9 * s;
        const ly = Y(y) - r - 1.6 * s;
        ctx.fillStyle = 'rgba(12,16,12,0.78)';
        ctx.beginPath(); ctx.roundRect(X(x) - w / 2, ly - 0.95 * s, w, 1.9 * s, 0.5 * s); ctx.fill();
        ctx.fillStyle = '#f5efe0';
        ctx.fillText(name, X(x), ly + 0.05 * s);
      }
      // Schnitt: kurze Abblende, damit Sprünge nicht als Teleport wirken
      if (sinceCut < 320) {
        ctx.fillStyle = `rgba(10,14,10,${0.85 * (1 - sinceCut / 320)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [client, teams, homeColor, awayColor, highlight, stadium]);
  return <canvas ref={ref} className="block h-full w-full rounded-xl" aria-label="Spielfeld mit Live-Positionen" />;
}
