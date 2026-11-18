import { readableTextColor } from '@fd/shared';
import { useEffect, useRef } from 'react';
import type { MatchClient, RosterTeam } from '../../lib/matchClient';

const L = 105;
const W = 68;
const M = 3; // Rand in Metern

/** Canvas-Darstellung der Live-Partie, 60 fps mit Interpolation zwischen den 10-Hz-Snapshots. */
export function MatchPitch({ client, teams, homeColor, awayColor, highlight }: {
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
    const shirts = new Map<string, { n: number; side: 'home' | 'away' }>();
    for (const p of teams.home.players) shirts.set(p.id, { n: p.shirt, side: 'home' });
    for (const p of teams.away.players) shirts.set(p.id, { n: p.shirt, side: 'away' });
    const txt = { home: readableTextColor(homeColor), away: readableTextColor(awayColor) };
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
      ctx.fillStyle = '#24502c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < 14; i++) { ctx.fillStyle = i % 2 ? '#2f6b3a' : '#2b6235'; ctx.fillRect(X((i * L) / 14), Y(0), (L / 14) * s + 1, W * s); }
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1, 0.25 * s);
      ctx.strokeRect(X(0), Y(0), L * s, W * s);
      ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(W)); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 9.15 * s, 0, Math.PI * 2); ctx.stroke();
      for (const left of [true, false]) {
        const gx = left ? 0 : L;
        const d = left ? 1 : -1;
        ctx.strokeRect(X(left ? 0 : L - 16.5), Y(W / 2 - 20.16), 16.5 * s, 40.32 * s);
        ctx.strokeRect(X(left ? 0 : L - 5.5), Y(W / 2 - 9.16), 5.5 * s, 18.32 * s);
        ctx.beginPath(); ctx.arc(X(gx + d * 11), Y(W / 2), 9.15 * s, left ? -0.93 : Math.PI - 0.93, left ? 0.93 : Math.PI + 0.93); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(X(left ? -1.6 : L), Y(W / 2 - 3.66), 1.6 * s, 7.32 * s);
      }
      const st = client.interpolated();
      if (!st) return;
      const r = 1.55 * s;
      ctx.font = `700 ${Math.round(1.6 * s)}px "Barlow Condensed", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const [id, [x, y]] of st.players) {
        const info = shirts.get(id);
        if (!info) continue;
        ctx.beginPath(); ctx.arc(X(x), Y(y) + r * 0.25, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fill();
        ctx.beginPath(); ctx.arc(X(x), Y(y), r, 0, Math.PI * 2);
        ctx.fillStyle = info.side === 'home' ? homeColor : awayColor; ctx.fill();
        ctx.lineWidth = id === highlight ? 0.5 * s : 0.18 * s;
        ctx.strokeStyle = id === highlight ? '#f2c14e' : 'rgba(0,0,0,0.55)'; ctx.stroke();
        ctx.fillStyle = txt[info.side];
        ctx.fillText(String(info.n || ''), X(x), Y(y) + 0.1 * s);
      }
      const [bx, by] = st.ball;
      ctx.beginPath(); ctx.arc(X(bx) + 0.3 * s, Y(by) + 0.4 * s, 0.7 * s, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(X(bx), Y(by), 0.75 * s, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 0.15 * s; ctx.strokeStyle = '#111'; ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [client, teams, homeColor, awayColor, highlight]);
  return <canvas ref={ref} className="block h-full w-full rounded-xl" aria-label="Spielfeld mit Live-Positionen" />;
}
