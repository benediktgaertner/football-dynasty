import { readableTextColor } from '@fd/shared';
import { useEffect, useRef } from 'react';
import type { MatchClient, RosterTeam, StadiumView, Weather } from '../../lib/matchClient';
import { ChoreoPlayer } from '../../lib/choreo/render';
import { isV2 } from '../../lib/choreo/model';
import { renderChoreoLayer, renderFanLayers, renderStadiumLayer, stadiumMargin } from '../../lib/stadiumArt';
import { autoFanCulture, awayFlagSpots, drawFlag, flagSpots, renderAwayBanner, renderChoreoDesign, renderUltrasLayer, type FlagSpot } from '../../lib/fanArt';
import type { FlagDesign, MatchEvent, UltraGroup } from '../../lib/matchClient';
import type { MatchSound } from '../../lib/fanAudio';

/** Dauer der Einlaufzeremonie (muss zum Match-Server passen: WALKOUT_MS) */
export const WALKOUT_MS = 20_000;

const L = 105;
const W = 68;
/** Seitenverhältnis der Spielansicht inkl. Stadion */
export function pitchAspect(stadium: StadiumView | null | undefined): string {
  const m = stadiumMargin(stadium?.capacity);
  return `${L + 2 * m} / ${W + 2 * m}`;
}

const SET_PIECE_LABEL: Record<string, string> = { corner: 'Eckball', free_kick: 'Freistoß', penalty: 'Elfmeter' };

/** Wetter: Rasenfarben, Licht und Partikel (rein optisch, für alle Teilnehmer gleich vom Server bestimmt) */
const GRASS: Record<Weather, [string, string, string]> = {
  sunny: ['#327440', '#2c6838', '#21502a'],
  cloudy: ['#2d6838', '#285e33', '#1e4626'],
  rain: ['#245a30', '#20512b', '#183d21'],
  heavy_rain: ['#1f5029', '#1b4825', '#14361c'],
  snow: ['#3a7449', '#356b43', '#e9eef2'],
  fog: ['#2d6838', '#285e33', '#1e4626'],
};

interface Drop { x: number; y: number; v: number; l: number }
interface Puff { x: number; y: number; r: number; a: number; vx: number; vy: number }

/**
 * Canvas-Darstellung der Live-Partie: 60 fps mit Interpolation zwischen den Snapshots.
 * Ball: Position = Bodenpunkt (Flugrichtung ist eindeutig), Höhe über Größe, Schatten und leichten
 * Versatz; Spur je Ballart (flach, hoch, Flanke, Schuss). Standards: Einblendung, Mauer, Positionierung.
 * Stadion: Ränge nach Kapazität, weiße Sitze, Fans in Bewegung, Choreografie, Banner, Pyrotechnik.
 */
export function MatchPitch({ client, teams, homeColor, awayColor, highlight, stadium, walkoutEndsAt = null, walkoutStartedAt = null, walkoutSkipped = false, sound = null }: {
  /** Stadionton: erhält die gerade sichtbaren Ereignisse (gleicher Tick wie die Darstellung) */
  sound?: MatchSound | null;
  stadium?: StadiumView | null;
  /** Anpfiff nach der Einlaufzeremonie (lokale Uhr); null = kein Einlauf */
  walkoutEndsAt?: number | null;
  walkoutStartedAt?: number | null;
  /** Einlauf lokal übersprungen (gemeinsamer Spielzustand bleibt unverändert) */
  walkoutSkipped?: boolean;
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
    const info = new Map<string, { n: number; side: 'home' | 'away'; name: string; pos: string }>();
    for (const p of teams.home.players) info.set(p.id, { n: p.shirt, side: 'home', name: p.name, pos: p.position });
    for (const p of teams.away.players) info.set(p.id, { n: p.shirt, side: 'away', name: p.name, pos: p.position });
    const fill = { home: homeColor, away: awayColor };
    const txt = { home: readableTextColor(homeColor), away: readableTextColor(awayColor) };
    const ring = {
      home: teams.home.colorAlt && teams.home.colorAlt.toLowerCase() !== homeColor.toLowerCase() ? teams.home.colorAlt : txt.home,
      away: awayColor.toLowerCase() === teams.away.color.toLowerCase() && teams.away.colorAlt.toLowerCase() !== awayColor.toLowerCase() ? teams.away.colorAlt : teams.away.color.toLowerCase() !== awayColor.toLowerCase() ? teams.away.color : txt.away,
    };
    const weather: Weather = stadium?.weather ?? 'cloudy';
    const atmo = stadium?.atmosphere ?? null;
    const grass = GRASS[weather] ?? GRASS.cloudy;
    const trail: Array<[number, number, number]> = [];
    const M = stadiumMargin(stadium?.capacity);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let base: HTMLCanvasElement | null = null;
    let fans: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
    let choreo: HTMLCanvasElement | null = null;
    /** Choreografie v2 (Szenen, Elemente, Animation); ältere einfache Designs laufen über die Bitmap-Ebene */
    let choreoPlayer: ChoreoPlayer | null = null;
    let ultrasLayer: HTMLCanvasElement | null = null;
    let spots: FlagSpot[] = [];
    const fanView = stadium?.fans ?? null;
    // Heimseite: eigene Fankultur; KI-Vereine bzw. Vereine ohne Einstellungen erhalten eine automatisch erzeugte
    const homeClub = fanView?.home_club ?? { id: teams.home.clubId, name: teams.home.name, short: teams.home.shortName, control: teams.home.control, colors: [teams.home.color, teams.home.colorAlt] as [string, string] };
    const homeAuto = autoFanCulture(homeClub);
    const ownHome = !!fanView && (fanView.flags.length > 0 || fanView.ultras.length > 0);
    const homeFlags: FlagDesign[] = ownHome ? fanView!.flags : homeAuto.flags;
    const homeUltras: UltraGroup[] = ownHome ? fanView!.ultras : homeAuto.ultras;
    // Gäste im Gästeblock: eigene Fahnen des Gastvereins (Mensch) oder automatisch erzeugte
    const awayClub = fanView?.away ?? { id: teams.away.clubId, name: teams.away.name, short: teams.away.shortName, control: teams.away.control, colors: [teams.away.color, teams.away.colorAlt] as [string, string], flags: [] as FlagDesign[], ultra: null as UltraGroup | null };
    const awayAuto = autoFanCulture(awayClub);
    const awayFlags: FlagDesign[] = awayClub.flags?.length ? awayClub.flags : awayAuto.flags;
    const awayBannerText = awayClub.ultra?.banner || awayClub.ultra?.name || awayAuto.banner;
    let awayBanner: HTMLCanvasElement | null = null;
    let awaySpots: FlagSpot[] = [];
    const important = !!atmo?.choreo;
    let layerKey = '';
    let raf = 0;
    // Ereignisse im Takt der Darstellung (Ton + Einblendungen am Spieler), jedes genau einmal
    const evState = { idx: -1, lastKind: null as string | null, out: false, lastT: performance.now(), lastBx: null as number | null, vx: 0 };
    const overlays: Array<{ kind: string; id: string | null; name: string; until: number; start: number }> = [];
    const homeGkId = teams.home.players.find((p) => p.position === 'GK')?.id ?? null;
    const OVERLAY = new Set(['yellow', 'second_yellow', 'red', 'injury', 'offside', 'goal']);
    let celebration: { side: 'home' | 'away'; scorer: string | null; start: number; end: number | null; cx: number; cy: number } | null = null;
    // Diagnose für E2E-Tests (nur wenn die Testumgebung window.__fdDebug setzt)
    const debugPitch = (d: Record<string, unknown>) => { const w = window as unknown as { __fdDebug?: boolean; __fdPitch?: Record<string, unknown> }; if (w.__fdDebug) w.__fdPitch = d; };
    let drops: Drop[] = [];
    const smoke: Puff[] = [];
    let lastT = performance.now();
    let lastScore: [number, number] | null = null;
    let cheerUntil = 0;
    let awayCheer = 0;
    let homeGoalMinute = -10;
    // Pyrotechnik: zwei feste Momente je Spiel aus dem Seed (für alle gleich) + nach Heimtoren
    const pyroSeed = atmo?.pyro_seed ?? 0.5;
    const pyroMinutes = atmo && (atmo.choreo || pyroSeed > 0.45) ? [4 + Math.floor(pyroSeed * 18), 52 + Math.floor(((pyroSeed * 7) % 1) * 25)] : [];

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
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
      const st = client.interpolated();
      const minute = st?.minute ?? 0;
      const inWalkout = !!walkoutEndsAt && !walkoutSkipped && Date.now() < walkoutEndsAt;
      if (st) {
        if (lastScore && st.score[0] > lastScore[0]) { cheerUntil = now + 6000; homeGoalMinute = minute; }
        if (lastScore && st.score[1] > lastScore[1]) { cheerUntil = now + 2500; awayCheer = now + 6000; }
        lastScore = [st.score[0], st.score[1]];
      }
      // Stadion: vorberechnete Ebenen (Bau + weiße Sitze, Fans in zwei Phasen, Choreografie)
      if (stadium) {
        ctx.fillStyle = '#121519';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const key = `${canvas.width}x${canvas.height}`;
        if (key !== layerKey) {
          const o = { capacity: stadium.capacity, attendance: stadium.attendance ?? stadium.capacity * 0.5, design: stadium.design,
            homeColors: [teams.home.color, teams.home.colorAlt] as [string, string], awayColor, s, ox, oy, width: canvas.width, height: canvas.height,
            homeShort: teams.home.shortName, banners: atmo?.banners ?? false };
          base = renderStadiumLayer(o);
          fans = renderFanLayers(o);
          // eigene Choreografie des Heimvereins (gewählt oder Standard), sonst die automatische bei wichtigen Spielen
          choreoPlayer?.dispose();
          choreoPlayer = fanView?.choreo && isV2(fanView.choreo) ? new ChoreoPlayer(o, fanView.choreo, { reduced }) : null;
          choreo = fanView?.choreo ? (isV2(fanView.choreo) ? null : renderChoreoDesign(o, fanView.choreo)) : atmo?.choreo ? renderChoreoLayer(o) : null;
          ultrasLayer = homeUltras.length ? renderUltrasLayer(o, homeUltras, important ? 1 : 0.6) : null;
          // Schwenkfahnen: eigene Fahnen/Ultra-Fahnen, sonst Vereinsfahnen in den Heimfarben
          spots = reduced ? [] : flagSpots(o, homeFlags, homeUltras, important ? 1 : 0.45);
          awaySpots = reduced ? [] : awayFlagSpots(o, awayFlags, important ? 1 : 0.5);
          awayBanner = renderAwayBanner(o, awayBannerText, [awayClub.colors[0] ?? awayColor, awayClub.colors[1] ?? '#ffffff']);
          layerKey = key;
          drops = [];
        }
        if (base) ctx.drawImage(base, 0, 0);
        const fast = now < cheerUntil;
        const phase = reduced ? 0 : Math.floor(now / (fast ? 160 : 560)) % 2;
        if (fans) ctx.drawImage(fans[phase]!, 0, 0);
        if (ultrasLayer) ctx.drawImage(ultrasLayer, 0, 0);
        if (awayBanner) ctx.drawImage(awayBanner, 0, 0);
        // Choreografie beim Einlauf, vor dem Anpfiff und zu Beginn beider Halbzeiten
        if (choreo && (inWalkout || minute < 8 || (minute >= 45 && minute < 48))) ctx.drawImage(choreo, 0, 0);
        // Choreografie v2: Szenenfolge im Einlauf (synchron zur gemeinsamen Einlaufzeit), danach beständige Elemente
        if (choreoPlayer) {
          const wStart = walkoutStartedAt ?? (walkoutEndsAt ? walkoutEndsAt - WALKOUT_MS : 0);
          choreoPlayer.draw(ctx, { now, walkout: inWalkout ? { elapsedMs: Date.now() - wStart, totalMs: walkoutEndsAt! - wStart } : null, minute });
        }
        // Schwenkfahnen (schneller bei Toren und beim Einlauf)
        const waveT = now / 1000 * (fast || inWalkout ? 1.6 : 1);
        for (let i = 0; i < spots.length; i++) {
          const sp = spots[i]!;
          if (!fast && !inWalkout && !important && i % 2 === 1) continue;
          drawFlag(ctx, sp.x, sp.y, sp.scale * 0.85, sp.flag, waveT + sp.phase, sp.side);
        }
        // Gästefans schwenken im Gästeblock (lebhafter nach Auswärtstoren)
        for (let i = 0; i < awaySpots.length; i++) { const sp = awaySpots[i]!; drawFlag(ctx, sp.x, sp.y, sp.scale * 0.8, sp.flag, now / 1000 * (awayCheer > now ? 1.8 : 1) + sp.phase, sp.side); }
        ctx.fillStyle = weather === 'snow' ? '#dfe6ec' : '#1f4626';
        ctx.fillRect(X(-2.4), Y(-1.5), (L + 4.8) * s, (W + 3) * s);
      } else {
        ctx.fillStyle = weather === 'snow' ? '#dfe6ec' : '#1f4626';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      for (let i = 0; i < 18; i++) { ctx.fillStyle = i % 2 ? grass[0] : grass[1]; ctx.fillRect(X((i * L) / 18), Y(0), (L / 18) * s + 1, W * s); }
      if (weather === 'snow') {
        // Schneereste an den Rändern, Rasen leicht überzuckert
        ctx.fillStyle = 'rgba(240,245,250,0.16)'; ctx.fillRect(X(0), Y(0), L * s, W * s);
        ctx.fillStyle = 'rgba(240,245,250,0.55)';
        ctx.fillRect(X(0), Y(0), L * s, 1.2 * s); ctx.fillRect(X(0), Y(W - 1.2), L * s, 1.2 * s);
      }
      const vg = ctx.createRadialGradient(X(L / 2), Y(W / 2), W * s * 0.3, X(L / 2), Y(W / 2), L * s * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = vg; ctx.fillRect(X(-2.4), Y(-1.5), (L + 4.8) * s, (W + 3) * s);
      // Sonne: Dachschatten als diagonaler Streifen über einem Teil des Spielfelds
      if (weather === 'sunny' && stadium?.design?.roof !== false) {
        ctx.save();
        ctx.beginPath(); ctx.rect(X(0), Y(0), L * s, W * s); ctx.clip();
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(L), Y(0)); ctx.lineTo(X(L), Y(W * 0.18)); ctx.lineTo(X(0), Y(W * 0.32)); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      // Linien
      ctx.strokeStyle = weather === 'snow' ? 'rgba(200,40,40,0.75)' : 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1, 0.22 * s);
      ctx.strokeRect(X(0), Y(0), L * s, W * s);
      ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(W)); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 9.15 * s, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(X(L / 2), Y(W / 2), 0.35 * s, 0, Math.PI * 2); ctx.fill();
      for (const left of [true, false]) {
        const gx = left ? 0 : L;
        const d = left ? 1 : -1;
        ctx.strokeRect(X(left ? 0 : L - 16.5), Y(W / 2 - 20.16), 16.5 * s, 40.32 * s);
        ctx.strokeRect(X(left ? 0 : L - 5.5), Y(W / 2 - 9.16), 5.5 * s, 18.32 * s);
        ctx.beginPath(); ctx.arc(X(gx + d * 11), Y(W / 2), 0.3 * s, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(X(gx + d * 11), Y(W / 2), 9.15 * s, left ? -0.93 : Math.PI - 0.93, left ? 0.93 : Math.PI + 0.93); ctx.stroke();
        const nx = left ? X(-2.2) : X(L);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(nx, Y(W / 2 - 3.66), 2.2 * s, 7.32 * s);
        ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(0.5, 0.06 * s);
        for (let k = 0; k <= 7; k++) { ctx.beginPath(); ctx.moveTo(nx, Y(W / 2 - 3.66 + k * 1.046)); ctx.lineTo(nx + 2.2 * s, Y(W / 2 - 3.66 + k * 1.046)); ctx.stroke(); }
        ctx.restore();
        ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1.5, 0.3 * s);
        ctx.beginPath(); ctx.moveTo(X(gx), Y(W / 2 - 3.66)); ctx.lineTo(left ? X(-2.2) : X(L + 2.2), Y(W / 2 - 3.66)); ctx.lineTo(left ? X(-2.2) : X(L + 2.2), Y(W / 2 + 3.66)); ctx.lineTo(X(gx), Y(W / 2 + 3.66)); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = ctx.strokeStyle;
      }
      for (const [cx, cy, a0] of [[0, 0, 0], [L, 0, Math.PI / 2], [L, W, Math.PI], [0, W, -Math.PI / 2]] as const) {
        ctx.beginPath(); ctx.arc(X(cx), Y(cy), 1 * s, a0, a0 + Math.PI / 2); ctx.stroke();
      }
      // Eckfahnen
      for (const [cx, cy] of [[0, 0], [L, 0], [L, W], [0, W]] as const) {
        ctx.fillStyle = '#f5d000'; ctx.beginPath(); ctx.arc(X(cx), Y(cy), 0.35 * s, 0, Math.PI * 2); ctx.fill();
      }

      if (!st) { drawWeather(); drawPyro(); return; }
      if (inWalkout) {
        // Ablauf in Echtzeit: Einlauf (≈ 14 s) → Aufstellung vor der Haupttribüne, solange die Hymne läuft →
        // in den letzten 5,6 s zur Anfangsformation. Lange Hymnen verlängern nur das Stehen, nichts wiederholt sich.
        const nowMs = Date.now();
        const remaining = walkoutEndsAt! - nowMs;
        const total = walkoutStartedAt ? walkoutEndsAt! - walkoutStartedAt : WALKOUT_MS;
        // Bezugsdauer: kurzer Einlauf (ohne Hymne) läuft komplett in seiner Zeit, lange Hymnen verlängern nur das Stehen
        const base = Math.min(total, 20_000);
        const elapsed = total - remaining;
        const p = remaining < base * 0.28 ? Math.max(Math.min(0.72, elapsed / base), 1 - remaining / base) : Math.min(0.72, elapsed / base);
        // Aufstellung steht vor der Haupttribüne (unten, y = W − 3,2 m): Bildschirmlage für die Overlay-Prüfung
        debugPitch({ mode: 'walkout', choreo: choreoPlayer?.lastDrawn ?? null, view: { s, ox, oy, dpr }, minute, walkoutP: p, lineupTopPx: (oy + (W - 3.2 - 1.6) * s) / dpr, canvasH: ch });
        drawWalkout([...st.players].map(([id, [x, y]]) => [id, x, y] as [string, number, number]), p, nowMs / 1000);
        drawWeather(); drawPyro(); return;
      }
      const sp = st.setPiece;
      debugPitch({ mode: celebration ? 'celebration' : 'play', choreo: choreoPlayer?.lastDrawn ?? null, view: { s, ox, oy, dpr }, minute, score: st.score, tick: st.tick, ball: st.ball });
      {
        const evs = client.state.events as MatchEvent[];
        const nowMs = performance.now();
        const dt = Math.min(0.25, (nowMs - evState.lastT) / 1000); evState.lastT = nowMs;
        if (evState.idx > evs.length) evState.idx = -1; // Ereignisprotokoll wurde zurückgesetzt (Server-Neustart)
        if (evState.idx < 0) { const i = evs.findIndex((e) => e.tick > st.tick); evState.idx = i < 0 ? evs.length : i; }
        const [bx0, by0, bz0] = st.ball;
        while (evState.idx < evs.length && evs[evState.idx]!.tick <= st.tick) {
          const e = evs[evState.idx++]!;
          if (st.minute - e.minute > 1) continue; // übersprungene Passage: nicht nachholen
          // Torjubel: Torschütze läuft zur Eckfahne, Mitspieler springen um ihn herum – bis zum Wiederanstoß
          if (e.type === 'goal' && e.side && (e.side === 'home' || e.side === 'away')) {
            const sc = e.playerId ? st.players.get(e.playerId) : undefined;
            const sx = sc?.[0] ?? (bx0 > L / 2 ? L - 8 : 8), sy = sc?.[1] ?? W / 2;
            celebration = { side: e.side, scorer: e.playerId ?? null, start: nowMs, end: null, cx: sx > L / 2 ? L - 5 : 5, cy: sy < W / 2 ? 6 : W - 6 };
          }
          if (e.type === 'kickoff' && e.side && celebration && celebration.end === null) celebration.end = nowMs;
          if (OVERLAY.has(e.type)) overlays.push({ kind: e.type, id: e.playerId ?? null, name: e.playerId ? (info.get(e.playerId)?.name ?? '') : '', start: nowMs, until: nowMs + (e.type === 'goal' ? 2200 : 1700) });
          const sideNet = (bx0 < 1.6 || bx0 > L - 1.6) && Math.abs(by0 - W / 2) > 3.7 && Math.abs(by0 - W / 2) < 6.5 && bz0 < 2.5;
          sound?.event(e as { tick: number; type: string; side: 'home' | 'away' | null; xg?: number }, { homeScore: st.score[0], awayScore: st.score[1], minute: st.minute, ballOutsideNet: sideNet });
        }
        if (sound) {
          const k = st.ballKind ?? null;
          if (k && k !== evState.lastKind && k !== 'set_piece') sound.kick(k === 'shot' ? 'shot' : 'pass');
          evState.lastKind = k;
          const out = bx0 < -0.4 || bx0 > L + 0.4 || by0 < -0.4 || by0 > W + 0.4;
          if (out && !evState.out) sound.outOfPlay();
          evState.out = out;
          // Sichtbare Spielsituation für die Zuschauer: Ballbesitz, Abstand zum Tor, Strafraum, Tempo nach vorn
          const car = st.carrier ? info.get(st.carrier) : null;
          const gk = homeGkId ? st.players.get(homeGkId) : undefined;
          const homeAttacksRight = !(gk && gk[0] > L / 2);
          const side = car?.side === 'home' || car?.side === 'away' ? car.side : null;
          const dirRight = side === 'home' ? homeAttacksRight : !homeAttacksRight;
          const toGoal = side ? (dirRight ? L - bx0 : bx0) : 52;
          const vx = evState.lastBx === null ? 0 : (bx0 - evState.lastBx) / Math.max(0.016, dt);
          evState.lastBx = bx0;
          evState.vx = evState.vx * 0.8 + vx * 0.2;
          sound.frame(dt, {
            possession: side, toGoal, inBox: !!side && toGoal < 16.5 && Math.abs(by0 - W / 2) < 20.16,
            forward: side ? (dirRight ? evState.vx : -evState.vx) : 0,
            minute: st.minute, homeScore: st.score[0], awayScore: st.score[1],
          });
        }
      }
      const sinceCut = performance.now() - client.cutAt;
      if (sinceCut < 50) trail.length = 0;
      const [bx, by, bz] = st.ball;
      // Spur am Boden entlang der echten Flugbahn (Richtung eindeutig); Stil je Ballart
      trail.push([bx, by, bz]);
      if (trail.length > 16) trail.shift();
      const kind = st.ballKind;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1]!, b = trail[i]!;
        const f = i / trail.length;
        const shot = kind === 'shot';
        ctx.strokeStyle = shot ? `rgba(255,245,200,${f * 0.6})` : kind === 'cross' || kind === 'lofted' || kind === 'set_piece' ? `rgba(255,255,255,${f * 0.28})` : `rgba(255,255,255,${f * 0.32})`;
        ctx.lineWidth = (shot ? 0.25 + f * 0.45 : 0.12 + f * 0.3) * s;
        if (kind === 'cross' || kind === 'lofted' || kind === 'set_piece') ctx.setLineDash([0.6 * s, 0.5 * s]);
        ctx.beginPath(); ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1])); ctx.stroke();
        ctx.setLineDash([]);
      }

      const r = 1.45 * s;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let carrierPos: [number, number, string] | null = null;
      // Schatten (Richtung nach Wetter: Sonne lang, bewölkt kurz)
      const shx = weather === 'sunny' ? 0.6 : 0.25, shy = weather === 'sunny' ? 0.75 : 0.5, sha = weather === 'sunny' ? 0.32 : weather === 'fog' ? 0.12 : 0.22;
      const nowP = performance.now();
      if (celebration && (nowP - celebration.start > 6000 || (celebration.end !== null && nowP - celebration.end > 700))) celebration = null;
      const shown = (id: string, x: number, y: number): [number, number, number] => celebrate(id, x, y, nowP);
      for (const [cid, [x0, y0]] of st.players) {
        const [x, y] = shown(cid, x0, y0);
        ctx.beginPath(); ctx.ellipse(X(x) + shx * s, Y(y) + shy * s, r * 1.05, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,0,0,${sha})`; ctx.fill();
      }
      // Standard: Elfmeterpunkt/Mauer hervorheben
      const wall = new Set(sp?.wall ?? []);
      ctx.font = `700 ${Math.round(1.5 * s)}px "Barlow Condensed", system-ui, sans-serif`;
      for (const [id, [x0, y0]] of st.players) {
        const p = info.get(id);
        if (!p) continue;
        const [x, y, jump] = shown(id, x0, y0);
        const isCarrier = id === st.carrier;
        if (isCarrier) {
          ctx.beginPath(); ctx.arc(X(x), Y(y), r * 1.75, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
          carrierPos = [x, y, p.name];
        }
        if (wall.has(id)) {
          ctx.beginPath(); ctx.arc(X(x), Y(y), r * 1.35, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.18 * s; ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(X(x), Y(y), r * jump, 0, Math.PI * 2);
        ctx.fillStyle = fill[p.side]; ctx.fill();
        kitPattern(p.side, X(x), Y(y), r * jump);
        ctx.lineWidth = 0.32 * s;
        ctx.strokeStyle = id === highlight ? '#ffd24a' : ring[p.side]; ctx.stroke();
        ctx.fillStyle = txt[p.side];
        ctx.fillText(String(p.n || ''), X(x), Y(y) + 0.08 * s);
      }
      // Ball: Bodenpunkt + Schatten; Höhe über Größe und leichten Versatz (Vogelperspektive mit minimaler Neigung)
      const z = Math.max(0, bz);
      const shadowR = Math.max(0.35, 0.75 - z * 0.03);
      ctx.beginPath(); ctx.ellipse(X(bx + z * 0.06), Y(by + z * 0.09), shadowR * s, shadowR * 0.6 * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0.14, 0.4 - z * 0.025)})`; ctx.fill();
      const br = (0.7 + Math.min(z, 10) * 0.09) * s;
      const ballX = X(bx - z * 0.04), ballY = Y(by - z * 0.16);
      ctx.beginPath(); ctx.arc(ballX, ballY, br, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = 0.14 * s; ctx.strokeStyle = '#111'; ctx.stroke();
      ctx.beginPath(); ctx.arc(ballX - br * 0.25, ballY - br * 0.2, br * 0.32, 0, Math.PI * 2); ctx.fillStyle = 'rgba(40,40,40,0.55)'; ctx.fill();
      // Name des Ballführenden
      if (carrierPos && !sp) {
        const [x, y, name] = carrierPos;
        ctx.font = `600 ${Math.round(1.55 * s)}px "Barlow", system-ui, sans-serif`;
        const w = ctx.measureText(name).width + 0.9 * s;
        const ly = Y(y) - r - 1.6 * s;
        ctx.fillStyle = 'rgba(12,14,18,0.78)';
        ctx.beginPath(); ctx.roundRect(X(x) - w / 2, ly - 0.95 * s, w, 1.9 * s, 0.5 * s); ctx.fill();
        ctx.fillStyle = '#f5f7fa';
        ctx.fillText(name, X(x), ly + 0.05 * s);
      }
      // Einblendungen am Spieler (Karte, Verletzung, Abseits, Tor) – ca. 1,7 s, klein über dem Spieler
      for (let i = overlays.length - 1; i >= 0; i--) {
        const o = overlays[i]!;
        const nowO = performance.now();
        if (nowO > o.until) { overlays.splice(i, 1); continue; }
        const pos = (o.id && st.players.get(o.id)) || [bx, by];
        const a = Math.max(0, Math.min(1, (nowO - o.start) / 150, (o.until - nowO) / 250));
        drawOverlay(o.kind, o.name, X(pos[0]), Y(pos[1]) - r - 2.6 * s, a);
      }
      drawWeather();
      drawPyro();
      // Standard-Einblendung (Vorbereitung sichtbar, bevor ausgeführt wird)
      if (sp) {
        const team = sp.side === 'home' ? teams.home : teams.away;
        const label = `${SET_PIECE_LABEL[sp.kind] ?? 'Standard'} · ${team.shortName}`;
        ctx.font = `800 ${Math.round(2.1 * s)}px "Barlow Condensed", system-ui, sans-serif`;
        const w = ctx.measureText(label).width + 2.4 * s;
        const cx = X(L / 2), cy = Y(3.2);
        ctx.fillStyle = 'rgba(10,12,16,0.82)';
        ctx.beginPath(); ctx.roundRect(cx - w / 2, cy - 1.5 * s, w, 3 * s, 0.8 * s); ctx.fill();
        ctx.fillStyle = sp.side === 'home' ? homeColor : awayColor;
        ctx.fillRect(cx - w / 2, cy - 1.5 * s, 0.5 * s, 3 * s);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label.toUpperCase(), cx + 0.2 * s, cy + 0.1 * s);
      }
      // Schnitt: kurze Abblende, damit Sprünge nicht als Teleport wirken
      if (sinceCut < 320) {
        ctx.fillStyle = `rgba(8,10,14,${0.85 * (1 - sinceCut / 320)})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      /**
       * Einlauf: beide Teams und das Schiedsrichtergespann kommen aus dem Spielertunnel (Haupttribüne),
       * gehen in zwei Reihen zur Mitte, stellen sich vor der Haupttribüne auf und laufen dann auf
       * ihre Startpositionen (= Positionen des ersten Snapshots, für alle gleich).
       */
      /** Torjubel-Position eines Spielers (Gewicht weich ein- und mit dem Wiederanstoß wieder ausgeblendet) */
      function celebrate(id: string, x: number, y: number, now: number): [number, number, number] {
        const c = celebration;
        const pi = info.get(id);
        if (!c || !pi || pi.side !== c.side || pi.pos === 'GK') return [x, y, 1];
        const t = (now - c.start) / 1000;
        const ease = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));
        const w = ease(t / 0.9) * (c.end === null ? 1 : 1 - ease((now - c.end) / 600));
        if (w <= 0) return [x, y, 1];
        const mates = [...st!.players.keys()].filter((k) => { const q = info.get(k); return q && q.side === c.side && q.pos !== 'GK'; });
        const i = mates.indexOf(id);
        const scorer = id === c.scorer;
        const ang = (i / Math.max(1, mates.length)) * Math.PI * 2;
        const rad = scorer ? 0 : 1.6 + (i % 3) * 0.9;
        const tx = c.cx + Math.cos(ang) * rad, ty = c.cy + Math.sin(ang) * rad;
        const jump = 1 + w * 0.16 * Math.abs(Math.sin(t * 8 + i * 1.3));
        return [x + (tx - x) * w, y + (ty - y) * w, jump];
      }

      function drawWalkout(players: Array<[string, number, number]>, p: number, t: number) {
        const home = players.filter(([id]) => info.get(id)?.side === 'home');
        const away = players.filter(([id]) => info.get(id)?.side === 'away');
        const tunnel: [number, number] = [L / 2, W + 2.4];
        const lineY = W - 3.2;
        const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
        const pos = (side: 'home' | 'away', i: number, target: [number, number]): [number, number] => {
          const lane = side === 'home' ? -0.9 : 0.9;
          const lx = L / 2 + (side === 'home' ? -1 : 1) * (2.2 + i * 1.55);
          const start = 0.1 + i * 0.012;
          const walk = ease((p - start) / 0.26);
          // Tunnel → Spielfeldrand (Reihe) → Aufstellung vor der Haupttribüne
          let x: number, y: number;
          if (walk < 0.4) { const k = walk / 0.4; x = tunnel[0] + lane; y = tunnel[1] + (W - 0.6 - tunnel[1]) * k; }
          else { const k = (walk - 0.4) / 0.6; x = tunnel[0] + lane + (lx - tunnel[0] - lane) * k; y = W - 0.6 + (lineY - (W - 0.6)) * k; }
          if (p < start) { x = tunnel[0] + lane; y = tunnel[1] + 0.5; }
          const go = ease((p - 0.72) / 0.25);
          return [x + (target[0] - x) * go, y + (target[1] - y) * go];
        };
        const rr = 1.45 * s;
        ctx.font = `700 ${Math.round(1.5 * s)}px "Barlow Condensed", system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const [side, list] of [['home', home], ['away', away]] as const) {
          list.forEach(([id, tx, ty], i) => {
            if (p < 0.1 + i * 0.012) return;
            const [x0, y] = pos(side, i, [tx, ty]);
            // in der Aufstellung: kaum merkliches Wiegen (lebendig, aber ruhig während der Hymne)
            const x = x0 + (p >= 0.6 && p <= 0.74 ? Math.sin(t * 1.1 + i * 0.9) * 0.07 : 0);
            ctx.beginPath(); ctx.ellipse(X(x) + 0.3 * s, Y(y) + 0.5 * s, rr, rr * 0.55, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fill();
            ctx.beginPath(); ctx.arc(X(x), Y(y), rr, 0, Math.PI * 2); ctx.fillStyle = fill[side]; ctx.fill();
            kitPattern(side, X(x), Y(y), rr);
            ctx.lineWidth = 0.32 * s; ctx.strokeStyle = ring[side]; ctx.stroke();
            ctx.fillStyle = txt[side]; ctx.fillText(String(info.get(id)?.n ?? ''), X(x), Y(y) + 0.08 * s);
          });
        }
        // Schiedsrichter-Gespann in der Mitte, danach an die Seitenlinie bzw. zum Mittelkreis
        if (p > 0.08) {
          const refTargets: Array<[number, number]> = [[L / 2 + 4, W / 2 - 6], [L * 0.25, W + 0.6], [L * 0.75, -0.6]];
          refTargets.forEach((t, k) => {
            const walk = ease((p - 0.08) / 0.26);
            let x = L / 2 + (k - 1) * 1.4, y = tunnel[1] + (lineY - tunnel[1]) * walk;
            const go = ease((p - 0.72) / 0.25);
            x += (t[0] - x) * go; y += (t[1] - y) * go;
            ctx.beginPath(); ctx.arc(X(x), Y(y), rr * 0.85, 0, Math.PI * 2); ctx.fillStyle = '#16181c'; ctx.fill();
            ctx.lineWidth = 0.25 * s; ctx.strokeStyle = '#f2d43a'; ctx.stroke();
          });
        }
        // Einblendung
        const label = p < 0.42 ? 'Einlauf der Mannschaften' : p <= 0.72 ? 'Aufstellung vor der Haupttribüne' : 'Gleich geht es los';
        ctx.font = `800 ${Math.round(2.1 * s)}px "Barlow Condensed", system-ui, sans-serif`;
        const w = ctx.measureText(label.toUpperCase()).width + 2.4 * s;
        ctx.fillStyle = 'rgba(10,12,16,0.8)';
        ctx.beginPath(); ctx.roundRect(X(L / 2) - w / 2, Y(3.2) - 1.5 * s, w, 3 * s, 0.8 * s); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.fillText(label.toUpperCase(), X(L / 2), Y(3.2) + 0.1 * s);
      }

      /** Trikotmuster (Streifen, Ringe, Hälften, Schärpe) im Spielerkreis – Farben aus dem gewählten Trikot */
      function kitPattern(side: 'home' | 'away', cx: number, cy: number, rad: number) {
        const kit = side === 'home' ? teams.home.kit : teams.away.kit;
        if (!kit || kit.pattern === 'solid' || kit.primary.toLowerCase() !== fill[side].toLowerCase()) return;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = kit.secondary;
        const d = rad * 2;
        if (kit.pattern === 'stripes') for (let k = -2; k <= 2; k += 2) ctx.fillRect(cx + (k * d) / 6 - d / 14, cy - rad, d / 7, d);
        else if (kit.pattern === 'hoops') for (let k = -1; k <= 1; k++) ctx.fillRect(cx - rad, cy + (k * d) / 3.4 - d / 14, d, d / 7);
        else if (kit.pattern === 'halves') ctx.fillRect(cx, cy - rad, rad, d);
        else if (kit.pattern === 'sash') { ctx.beginPath(); ctx.moveTo(cx - rad, cy - rad * 0.6); ctx.lineTo(cx - rad * 0.6, cy - rad); ctx.lineTo(cx + rad, cy + rad * 0.6); ctx.lineTo(cx + rad * 0.6, cy + rad); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      }

      function drawOverlay(kind: string, name: string, cx: number, cy: number, alpha: number) {
        ctx.save();
        ctx.globalAlpha = alpha;
        const u = s;
        if (kind === 'yellow' || kind === 'red') {
          ctx.fillStyle = kind === 'yellow' ? '#ffd400' : '#e1261c';
          ctx.beginPath(); ctx.roundRect(cx - 0.75 * u, cy - 1.05 * u, 1.5 * u, 2.1 * u, 0.25 * u); ctx.fill();
          ctx.lineWidth = 0.12 * u; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        } else if (kind === 'second_yellow') {
          ctx.fillStyle = '#ffd400'; ctx.beginPath(); ctx.roundRect(cx - 1.25 * u, cy - 1.05 * u, 1.5 * u, 2.1 * u, 0.25 * u); ctx.fill();
          ctx.fillStyle = '#e1261c'; ctx.beginPath(); ctx.roundRect(cx - 0.25 * u, cy - 0.85 * u, 1.5 * u, 2.1 * u, 0.25 * u); ctx.fill();
        } else if (kind === 'injury') {
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, 1.2 * u, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#d7262b'; ctx.fillRect(cx - 0.25 * u, cy - 0.8 * u, 0.5 * u, 1.6 * u); ctx.fillRect(cx - 0.8 * u, cy - 0.25 * u, 1.6 * u, 0.5 * u);
        } else if (kind === 'offside') {
          ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 0.22 * u; ctx.beginPath(); ctx.moveTo(cx - 0.6 * u, cy + 1.1 * u); ctx.lineTo(cx - 0.6 * u, cy - 1.1 * u); ctx.stroke();
          for (let k = 0; k < 4; k++) for (let j = 0; j < 3; j++) { ctx.fillStyle = (k + j) % 2 ? '#ffd400' : '#e1261c'; ctx.fillRect(cx - 0.5 * u + k * 0.35 * u, cy - 1.1 * u + j * 0.35 * u, 0.36 * u, 0.36 * u); }
        } else if (kind === 'goal') {
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, 1.1 * u, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(cx, cy, 0.42 * u, 0, Math.PI * 2); ctx.fill();
        }
        const label = kind === 'offside' ? `Abseits${name ? ' · ' + name : ''}` : kind === 'goal' ? `TOR · ${name}` : name;
        if (label) {
          ctx.font = `700 ${Math.round(1.45 * u)}px "Barlow", system-ui, sans-serif`;
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          const w = ctx.measureText(label).width + 0.9 * u;
          const lx = cx + 1.6 * u;
          ctx.fillStyle = kind === 'goal' ? 'rgba(255,210,74,0.92)' : 'rgba(12,14,18,0.82)';
          ctx.beginPath(); ctx.roundRect(lx, cy - 0.95 * u, w, 1.9 * u, 0.5 * u); ctx.fill();
          ctx.fillStyle = kind === 'goal' ? '#111' : '#f5f7fa';
          ctx.fillText(label, lx + 0.45 * u, cy + 0.05 * u);
        }
        ctx.restore();
      }

      function drawWeather() {
        if (reduced) return;
        const area = canvas.width * canvas.height;
        if (weather === 'rain' || weather === 'heavy_rain' || weather === 'snow') {
          const snow = weather === 'snow';
          const want = Math.round((area / 9000) * (weather === 'heavy_rain' ? 1.8 : snow ? 0.9 : 0.9));
          while (drops.length < Math.min(want, 420)) drops.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, v: (snow ? 0.5 + Math.random() * 0.6 : 7 + Math.random() * 4) * s, l: snow ? (0.18 + Math.random() * 0.22) * s : (1.2 + Math.random() * 1.4) * s });
          ctx.save();
          ctx.strokeStyle = weather === 'heavy_rain' ? 'rgba(200,215,235,0.42)' : 'rgba(200,215,235,0.32)';
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = Math.max(1, 0.08 * s);
          ctx.beginPath();
          for (const d of drops) {
            d.y += d.v * dt * (snow ? 4 : 9);
            d.x += (snow ? Math.sin((d.y + d.l * 40) / (8 * s)) * 0.6 : -0.35 * d.v * dt * 9 * 0.25);
            if (d.y > canvas.height) { d.y = -10; d.x = Math.random() * canvas.width; }
            if (snow) { ctx.moveTo(d.x + d.l, d.y); ctx.arc(d.x, d.y, d.l, 0, Math.PI * 2); }
            else { ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * 0.25, d.y - d.l); }
          }
          if (snow) ctx.fill(); else ctx.stroke();
          ctx.restore();
          if (!snow) { ctx.fillStyle = weather === 'heavy_rain' ? 'rgba(20,35,55,0.22)' : 'rgba(20,35,55,0.12)'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
        } else if (weather === 'fog') {
          const g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * 0.2, canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7);
          g.addColorStop(0, 'rgba(210,215,220,0.10)'); g.addColorStop(1, 'rgba(210,215,220,0.5)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (weather === 'sunny') {
          ctx.fillStyle = 'rgba(255,214,150,0.05)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          ctx.fillStyle = 'rgba(110,122,140,0.08)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }

      // Pyrotechnik in der Heimkurve: Fackelglühen + aufsteigender Rauch (rein optisch)
      function drawPyro() {
        if (!stadium || reduced) return;
        const active = pyroMinutes.some((m) => minute >= m && minute < m + 2) || (minute >= homeGoalMinute && minute < homeGoalMinute + 2);
        const kx = -M + 1.2;
        if (active) {
          for (let i = 0; i < 4; i++) {
            const fy = W * (0.25 + i * 0.17);
            const fx = kx + (i % 2) * 1.4;
            const flick = 0.75 + Math.sin(now / 60 + i * 2.1) * 0.15 + Math.random() * 0.1;
            const g = ctx.createRadialGradient(X(fx), Y(fy), 0, X(fx), Y(fy), 3.2 * s * flick);
            g.addColorStop(0, 'rgba(255,240,200,0.95)'); g.addColorStop(0.25, 'rgba(255,90,40,0.75)'); g.addColorStop(1, 'rgba(255,60,20,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(X(fx), Y(fy), 3.2 * s * flick, 0, Math.PI * 2); ctx.fill();
            if (smoke.length < 90 && Math.random() < 0.5) smoke.push({ x: X(fx), y: Y(fy), r: (0.8 + Math.random()) * s, a: 0.35, vx: (0.6 + Math.random()) * s, vy: (-0.4 - Math.random() * 0.6) * s });
          }
        }
        for (let i = smoke.length - 1; i >= 0; i--) {
          const p = smoke[i]!;
          p.x += p.vx * dt * 6; p.y += p.vy * dt * 6; p.r += s * dt * 2.2; p.a -= dt * 0.09;
          if (p.a <= 0) { smoke.splice(i, 1); continue; }
          ctx.fillStyle = `rgba(190,190,195,${p.a})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [client, teams, homeColor, awayColor, highlight, stadium, walkoutEndsAt, walkoutStartedAt, walkoutSkipped, sound]);
  return <canvas ref={ref} className="block h-full w-full rounded-xl" aria-label="Spielfeld mit Live-Positionen" />;
}
