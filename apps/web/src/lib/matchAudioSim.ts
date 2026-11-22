/**
 * Offline-Simulation einer 3-Minuten-Partie durch den ECHTEN Audio-Stack (MatchSound → StadiumMixer → Web Audio Graph).
 * Dient der technischen Prüfung des Stadiontons (Tests/Diagnose): geplante Start-/Stoppzeiten, harte Stopps,
 * Überlagerungen, Lautstärkesprünge. Ersetzt KEINE Hörprobe – gemessen wird nur, was sich aus dem Signal ableiten lässt.
 * Benötigt `node-web-audio-api` (lokal: `npm i --no-save node-web-audio-api`).
 *
 * Eingesetzte Aufnahmen: echtes Stadionrauschen und echte KI-Fangesänge aus public/audio; Torjubel und Pfiffe
 * (Host-Dateien, im Repository nicht enthalten) werden durch synthetisches, gefiltertes Rauschen mit Hüllkurve ersetzt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mixer, type AudioLogEntry } from './audioMixer';
import { MatchSound, type Song } from './fanAudio';
import { buildLibrary, type CrowdFile } from './crowdLibrary';
import type { PlayState } from './crowdModel';

export const SIM_SR = 22050;
const PUBLIC = join(__dirname, '../../public/audio');

export interface SimEvent { at: number; type: 'goal' | 'miss' | 'save' | 'foul' | 'yellow' | 'red' | 'injury' | 'penalty' | 'corner' | 'chance'; side: 'home' | 'away' }
export interface SimScenario {
  name: string;
  /** Partiedauer in Sekunden (Echtzeit; 90 Spielminuten) */
  seconds?: number;
  events: SimEvent[];
  /** Fangesänge: 'ai' = KI-Pool (Dateien aus public/audio/chants/ai), 'upload' = eigene Dateien des Heimvereins */
  chants?: 'ai' | 'upload';
  seed?: string;
  /** Diagnose: wird je Schritt (50 ms) aufgerufen */
  probe?: (t: number, sound: MatchSound) => void;
}

export interface SimResult {
  scenario: string;
  seconds: number;
  log: AudioLogEntry[];
  /** Pegelverlauf (dB, 100-ms-Fenster) der gesamten Ausgabe */
  levels: number[];
  stats: {
    chantStarts: number; chantsNatural: number; chantsCut: number; hardCuts: number; cutFades: number[]; cutReasons: Record<string, number>;
    maxSimultaneousChants: number; overlapSeconds: number; reactions: number; goalsHeard: number;
    maxJumpDb: number; jumpsOver6: number; jumpsOver9: number; maxJumpOutsideEventsDb: number; jumpsOver9OutsideEvents: number; hardStarts: number; shortEndFades: number; minLevelDb: number; p10Db: number; medianDb: number; p90Db: number;
    sameFileTwice: number; errors: string[]; bigJumps: Array<{ t: number; db: number }>; played: Array<{ t: number; side: string; id?: string }>;
  };
}

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13; return ((h >>> 0) % 100000) / 100000; };
}

function synthNoise(ctx: BaseAudioContext, sec: number, color: number, shape: (x: number) => number, seed: string): AudioBuffer {
  const r = rng(seed);
  const b = ctx.createBuffer(2, Math.floor(sec * SIM_SR), SIM_SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = 0; i < d.length; i++) { lp += (r() * 2 - 1 - lp) * color; d[i] = lp * 2.2 * shape(i / d.length); }
  }
  return b;
}

type Wa = { OfflineAudioContext: typeof OfflineAudioContext };

export async function simulateMatchAudio(wa: Wa, sc: SimScenario): Promise<SimResult> {
  const errors: string[] = [];
  const seconds = sc.seconds ?? 180;
  const ctx = new wa.OfflineAudioContext(2, Math.floor(SIM_SR * (seconds + 6)), SIM_SR) as unknown as OfflineAudioContext;
  mixer.attach(ctx, { attendance: 30000, capacity: 35000, importance: 0.5, awayShare: 0.08 });
  mixer.log.length = 0;
  const decode = (p: string) => ctx.decodeAudioData(readFileSync(p).buffer.slice(0) as ArrayBuffer);

  // Bibliothek: echtes Stadionrauschen + synthetische Platzhalter für Torjubel/Pfiffe (Host-Dateien)
  const files: CrowdFile[] = [];
  const amb = readdirSync(join(PUBLIC, 'crowd/ambience')).filter((f) => f.endsWith('.mp3'));
  for (const f of amb) {
    const buf = await decode(join(PUBLIC, 'crowd/ambience', f));
    mixer.preload(`mem://amb/${f}`, buf);
    files.push({ id: `amb-${f}`, category: 'ambience', file: `amb/${f}`, duration: buf.duration });
  }
  const synth: Array<[string, CrowdFile['category'], number, number, (x: number) => number]> = [
    ['goal1', 'goal', 9, 0.25, (x) => Math.min(1, x * 12) * (1 - x * 0.6)], ['goal2', 'goal', 8, 0.3, (x) => Math.min(1, x * 10) * (1 - x * 0.5)],
    ['boo1', 'pfeifkonzert', 8, 0.12, (x) => Math.sin(Math.PI * x) ** 0.7], ['boo2', 'pfiff', 4, 0.12, (x) => Math.sin(Math.PI * x) ** 0.7],
  ];
  for (const [id, cat, sec, color, shape] of synth) {
    const buf = synthNoise(ctx, sec, color, shape, id);
    mixer.preload(`mem://syn/${id}`, buf);
    files.push({ id, category: cat, file: `syn/${id}`, duration: sec });
  }
  mixer.setLibrary(buildLibrary('mem://', files));

  // Fangesänge
  const songs: Record<'home' | 'away', Song[]> = { home: [], away: [] };
  const pool = JSON.parse(readFileSync(join(PUBLIC, 'chants/ai/manifest.json'), 'utf8')) as { files: Array<{ id: string; file: string; mood: 'support' | 'taunt'; title: string }> };
  const r = rng(sc.seed ?? sc.name);
  const shuffled = [...pool.files].sort(() => r() - 0.5);
  const take = shuffled.slice(0, 7);
  for (const f of take) mixer.preload(`mem://chant/${f.file}`, await decode(join(PUBLIC, 'chants/ai', f.file)));
  const mk = (list: typeof take) => list.map((f): Song => ({ id: f.id, url: `mem://chant/${f.file}`, volume: 0.85, mood: sc.chants === 'upload' ? 'upload' : f.mood, title: f.title }));
  songs.home = mk(take.slice(0, 3)); songs.away = mk(take.slice(3, 6));

  const sound = new MatchSound((p) => `mem://${p}`, 'mem://manifest', { seed: sc.seed ?? sc.name });
  sound.songs = songs;
  sound.begin();

  // Zeitsteuerung: Uhr = Audiozeit des Offline-Kontexts; setTimeout läuft auf dieser Uhr
  const realNow = performance.now.bind(performance);
  const realSet = globalThis.setTimeout;
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  performance.now = () => clock * 1000;
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms = 0) => { timers.push({ at: clock + ms / 1000, fn }); return 0; }) as unknown as typeof setTimeout;

  const rnd = rng((sc.seed ?? sc.name) + ':play');
  const events = [...sc.events].sort((a, b) => a.at - b.at);
  let ei = 0, home = 0, away = 0, poss: 'home' | 'away' = 'home', possUntil = 0, toGoal = 50, kickoffPending: number | null = null;
  const STEP = 0.05;
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  const tick = async (t: number) => {
    clock = t;
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.at <= t) { const x = timers.splice(i, 1)[0]!; x.fn(); }
    const minute = Math.min(90, (t / seconds) * 90);
    if (t >= possUntil) { poss = rnd() < 0.5 ? 'home' : 'away'; possUntil = t + 3 + rnd() * 6; }
    toGoal = Math.max(4, Math.min(80, toGoal + (rnd() - 0.55) * 4 * (poss === 'home' ? 1 : -1) * -1));
    while (ei < events.length && events[ei]!.at <= t) {
      const e = events[ei++]!;
      if (e.type === 'goal') { if (e.side === 'home') home++; else away++; kickoffPending = t + 4.5; }
      sound.event({ tick: Math.floor(t * 20), type: e.type, side: e.side, xg: e.type === 'miss' || e.type === 'save' ? 0.3 : undefined },
        { homeScore: home, awayScore: away, minute, ballOutsideNet: false }, 'test');
    }
    if (kickoffPending !== null && t >= kickoffPending) { kickoffPending = null; sound.event({ tick: Math.floor(t * 20), type: 'kickoff', side: 'home' }, { homeScore: home, awayScore: away, minute, ballOutsideNet: false }, 'test'); }
    const ps: PlayState = { possession: poss, toGoal: toGoal, inBox: toGoal < 16, forward: poss === 'home' ? 3 : -2, minute, homeScore: home, awayScore: away };
    sound.frame(STEP, ps);
    sc.probe?.(t, sound);
    await flush();
  };

  try {
    const steps = Math.floor(seconds / STEP);
    for (let i = 1; i <= steps; i++) {
      const t = Math.round(i * STEP * 1000) / 1000;
      // Aufruf vor dem Rendern: Suspend-Zeitpunkte werden auf Renderblöcke (128 Frames) gerundet
      void ctx.suspend(Math.max(1 / SIM_SR * 128, t - 0.0001 > 0 ? Math.floor(t * SIM_SR / 128) * 128 / SIM_SR : 128 / SIM_SR)).then(async () => {
        try { await tick(t); } catch (e) { errors.push(`${t}s: ${(e as Error).message}`); } finally { void ctx.resume(); }
      }).catch(() => undefined);
    }
    const out = await ctx.startRendering();
    const res = analyse(sc, seconds, [...mixer.log], out, sc.events.map((e) => e.at));
    res.stats.errors = errors;
    return res;
  } finally {
    performance.now = realNow;
    (globalThis as { setTimeout: unknown }).setTimeout = realSet;
    sound.stop(0.01);
  }
}

function analyse(sc: SimScenario, seconds: number, log: AudioLogEntry[], out: AudioBuffer, eventTimes: number[]): SimResult {
  // Pegelverlauf
  const win = Math.floor(SIM_SR * 0.1), n = Math.floor(seconds * 10);
  const l = out.getChannelData(0), r = out.getChannelData(1);
  const levels: number[] = [];
  for (let w = 0; w < n; w++) {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win && i < l.length; i++) s += (l[i]! * l[i]! + r[i]! * r[i]!) / 2;
    levels.push(10 * Math.log10(s / win + 1e-12));
  }
  // die ersten 4 s (Einblenden des Summenpegels) und das Ausklingen nach dem Abpfiff zählen nicht
  const body = levels.slice(40);
  const jumps: number[] = [];
  for (let i = 1; i < body.length; i++) jumps.push(Math.abs(body[i]! - body[i - 1]!));
  // Sprünge außerhalb der Ereignisfenster (Ereignis −0,3 … +2 s: dort ist ein Pegelanstieg/-abfall gewollt)
  const near = (i: number) => { const t = (40 + i) / 10; return eventTimes.some((e) => (t >= e - 0.3 && t <= e + 2) || (t >= e + 4.2 && t <= e + 6)); }; // Ereignis (Tor/Foul …) und Wiederanstoß-Pfiff (≈ 4,5 s nach einem Tor)
  const jumpsOut = jumps.filter((_, i) => !near(i + 1));
  const sorted = [...body].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

  // Gesänge: Starts, vorzeitige Stopps, Überlagerung
  const chantStarts = log.filter((e) => e.ev === 'start' && (e.channel === 'home' || e.channel === 'away'));
  const spans: Array<{ a: number; b: number }> = [];
  const cutFades: number[] = []; const cutReasons: Record<string, number> = {};
  let cut = 0, hard = 0, natural = 0;
  for (const s of chantStarts) {
    const stop = log.find((e) => e.ev === 'stop' && e.channel === s.channel && e.id === s.id && e.t >= s.t && e.t < s.t + (s.len ?? 0) - 0.05);
    if (stop) { cut++; cutFades.push(stop.fade ?? 0); cutReasons[stop.reason ?? '?'] = (cutReasons[stop.reason ?? '?'] ?? 0) + 1; if ((stop.fade ?? 0) < 1.0) hard++; spans.push({ a: s.t, b: stop.t + (stop.fade ?? 0) }); }
    else { natural++; spans.push({ a: s.t, b: s.t + (s.len ?? 0) }); }
  }
  let maxSim = 0, overlap = 0;
  const pts = spans.flatMap((s) => [{ t: s.a, d: 1 }, { t: s.b, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, last = 0;
  for (const p of pts) { if (cur >= 2) overlap += p.t - last; cur += p.d; last = p.t; maxSim = Math.max(maxSim, cur); }
  let twice = 0;
  for (let i = 1; i < chantStarts.length; i++) if (chantStarts[i]!.id === chantStarts[i - 1]!.id) twice++;
  const reactions = log.filter((e) => e.ev === 'start' && e.channel === 'events').length;
  return {
    scenario: sc.name, seconds, log, levels,
    stats: {
      chantStarts: chantStarts.length, chantsNatural: natural, chantsCut: cut, hardCuts: hard, cutFades, cutReasons,
      maxSimultaneousChants: maxSim, overlapSeconds: Math.round(overlap * 10) / 10, reactions,
      goalsHeard: log.filter((e) => e.ev === 'start' && e.category === 'goal').length,
      maxJumpDb: Math.round(Math.max(0, ...jumps) * 10) / 10, maxJumpOutsideEventsDb: Math.round(Math.max(0, ...jumpsOut) * 10) / 10, jumpsOver9OutsideEvents: jumpsOut.filter((j) => j > 9).length,
      hardStarts: chantStarts.filter((s) => (s.fadeIn ?? 0) < 1).length, shortEndFades: chantStarts.filter((s) => s.natural && (s.fade ?? 0) < 1.5).length, jumpsOver6: jumps.filter((j) => j > 6).length, jumpsOver9: jumps.filter((j) => j > 9).length,
      minLevelDb: Math.round(sorted[0]! * 10) / 10, p10Db: Math.round(q(0.1) * 10) / 10, medianDb: Math.round(q(0.5) * 10) / 10, p90Db: Math.round(q(0.9) * 10) / 10,
      sameFileTwice: twice, errors: [], bigJumps: jumps.map((j, i) => ({ t: (40 + i + 1) / 10, db: Math.round(j * 10) / 10 })).filter((x, i) => x.db > 7 && !near(i + 1)), played: chantStarts.map((s) => ({ t: Math.round(s.t * 10) / 10, side: s.channel as string, id: s.id })),
    },
  };
}
