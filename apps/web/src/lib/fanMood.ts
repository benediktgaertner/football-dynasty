/**
 * Dynamisches Fanstimmungsmodell V2 (rein rechnerisch, ohne Web Audio – testbar).
 * Grundlage: docs/Football_Dynasty_Fanstimmung_Audio_Matrix_V2.xlsx
 *   · „Crowd-Reaktionen“: 120 Regeln (12 Auslöser × Heim/Gast × Klatschen/Pfeifen/Ah/Oh/Uh)
 *   · „Audio-Parameter“: Prüfintervalle, Pausen, Blenden, Cooldowns, Grenzen
 *   · „Stimmungs-Matrix“: 105 Zustände (Phase × Spielstand aus Heimsicht × Spielsituation)
 *     → Gesangschance Heim/Gast je Auswahlfenster, Grundpegel Heim/Gast, Pfiff-Chance Heim
 *   · „Ereignis-Sounds“: 26 Ereignisse mit Pegel, Dauer und Priorität
 *   · „Audio-Regeln“ R01–R22 (Auswahlfenster 8–12 s, Teilmenge je Partie, keine direkte Wiederholung,
 *     0:4-Regel, Trend statt Sofort-Erholung, Ein-/Ausblenden, Vorrang von Ereignissen)
 * Die Werte werden mit scripts/import-fan-matrix.py in fanMoodData.ts übernommen.
 */
import type { Situation } from './crowdModel';
import { AUDIO_PARAMS, CROWD_RULES, MOOD_EVENTS, MOOD_ROWS } from './fanMoodData';

export interface MoodRow {
  id: string;
  /** 0 = Früh (1–30), 1 = Mitte (31–60), 2 = Spät (61–90+) */
  phase: 0 | 1 | 2 | number;
  /** Tordifferenz aus Heimsicht, begrenzt auf −3…+3 */
  diff: number;
  /** 0 Ruhige Phase · 1 Heim Ballbesitz · 2 Heim Angriff · 3 Gast Ballbesitz · 4 Gast Angriff */
  sit: number;
  homeMood: string;
  awayMood: string;
  /** Chance (0–100) je Auswahlfenster, dass ein neuer Gesang beginnt */
  homeChant: number;
  awayChant: number;
  /** relative Grundlautstärke (0–100) */
  homeLevel: number;
  awayLevel: number;
  /** Chance (0–100) je Auswahlfenster für Pfiffe der Heimfans */
  homeWhistle: number;
  rule: string;
}
export type ReactionKind = 'clap' | 'whistle' | 'aah' | 'ooh' | 'uuh';
export type CrowdTrigger = 'calm00' | 'own_ball' | 'own_attack' | 'opp_attack' | 'own_chance' | 'opp_chance' | 'own_goal' | 'opp_goal'
  | 'minus2_45' | 'minus3_60' | 'plus2_60' | 'tight_finale';
export interface CrowdRule {
  id: string; trigger: CrowdTrigger | string; side: 'home' | 'away'; reaction: ReactionKind | string;
  /** Auslösechance % je freiem Prüffenster bzw. je Ereignis */
  chance: number; volume: number; minSec: number; maxSec: number; cooldown: number; priority: number; eventBound: boolean;
}
export interface AudioParams {
  chantCheckMin: number; chantCheckMax: number; chantPauseMin: number; chantPauseMax: number; maxHomeChants: number; maxAwayChants: number;
  fadeIn: number; fadeOut: number; goalDuck: number; goalMax: number; reactionCheckMin: number; reactionCheckMax: number; reactionGap: number;
  moodLag: number; homeChantDeficit3After60: number; awayCapPercent: number; peakLimit: number; subsetMin: number; subsetMax: number; noRepeat: number;
}
export const PARAMS: AudioParams = AUDIO_PARAMS;

/**
 * Major-Update: Gesangshäufigkeit insgesamt um ≈ 25 % senken (Excel-Situationslogik bleibt, nur skaliert),
 * Heim und Gäste überwiegend abwechselnd: Singt die andere Seite gerade, startet ein Gesang nur selten;
 * hat zuletzt dieselbe Seite gesungen, ist ein Wechsel wahrscheinlicher.
 */
export const CHANT_TUNING = { scale: 0.95, whileOtherSings: 0.12, sameSideAgain: 0.55, otherSideTurn: 1.8 } as const;
export const RULES: CrowdRule[] = CROWD_RULES;

export interface MoodEvent { id: string; name: string; fans: string; level: number; duration: number; effect: string; note: string; priority: number }

export const MOOD_SITS = ['Ruhige Phase', 'Heimteam Ballbesitz', 'Heimteam Angriff', 'Gästeteam Ballbesitz', 'Gästeteam Angriff'] as const;

const INDEX = new Map(MOOD_ROWS.map((r) => [`${r.phase}|${r.diff}|${r.sit}`, r]));
export const EVENTS: Record<string, MoodEvent> = Object.fromEntries(MOOD_EVENTS.map((e) => [e.id, e]));

/** virtuelle Spielminute → Phase der Matrix (01–30 / 31–60 / 61–90+) */
export function phaseOf(minute: number): 0 | 1 | 2 { return minute <= 30 ? 0 : minute <= 60 ? 1 : 2; }

/** Spielsituation des Spielfelds → Spalte „Situation“ der Matrix */
export function moodSitOf(s: Situation): number {
  switch (s) {
    case 'home_possession': return 1;
    case 'home_attack': case 'home_box': return 2;
    case 'away_possession': return 3;
    case 'away_attack': case 'away_box': return 4;
    default: return 0; // ruhig, harmlos, Schlussphase ohne Ballführung
  }
}

export function moodRow(minute: number, homeScore: number, awayScore: number, sit: Situation | number): MoodRow {
  const diff = Math.max(-3, Math.min(3, homeScore - awayScore));
  const s = typeof sit === 'number' ? sit : moodSitOf(sit);
  return INDEX.get(`${phaseOf(minute)}|${diff}|${s}`)!;
}

export interface MoodValues { homeChant: number; awayChant: number; homeLevel: number; awayLevel: number; homeWhistle: number }

/**
 * Zielwerte inkl. verbindlicher Regeln:
 * R05: ab Minute 60 und ≥ 3 Toren Rückstand Gesangschance der Heimfans = Parameter (V2: 0 %), hörbare Pfiffe.
 */
export function moodTargets(minute: number, homeScore: number, awayScore: number, sit: Situation | number): MoodValues & { row: MoodRow } {
  const row = moodRow(minute, homeScore, awayScore, sit);
  let { homeChant, homeWhistle } = row;
  if (minute >= 60 && homeScore - awayScore <= -3) { homeChant = Math.min(homeChant, PARAMS.homeChantDeficit3After60); homeWhistle = Math.max(homeWhistle, 60); }
  return { row, homeChant, awayChant: row.awayChant, homeLevel: row.homeLevel, awayLevel: row.awayLevel, homeWhistle };
}

/** Grundpegel (0–100) → Intensität der Fanspur (0…1, Mixer bildet 30 dB ab) */
export function levelToIntensity(level: number): number {
  return Math.max(0, Math.min(1, 0.08 + (level / 100) * 1.1));
}

/**
 * R19 – Trend statt Sprung: Die Grundstimmung (Spielstand × Minute, Spalte „Ruhige Phase“) folgt nur langsam
 * nach oben (≈ 45 s), fällt aber schnell (≈ 4 s, z. B. nach einem Gegentor). Die Spielsituation (Ballbesitz,
 * Angriff) wirkt sofort als Abweichung von dieser Grundstimmung.
 */
export class MoodTrend {
  private base: MoodValues | null = null;
  /** Erholung langsam (Stimmungsgedächtnis R19/R26), Absturz mit dem Stimmungsnachlauf aus den Parametern (8 s) */
  constructor(private upSec = 45, private downSec = PARAMS.moodLag) {}

  update(dt: number, minute: number, homeScore: number, awayScore: number, sit: Situation | number): MoodValues & { row: MoodRow } {
    const calm = moodTargets(minute, homeScore, awayScore, 0);
    const now = moodTargets(minute, homeScore, awayScore, sit);
    if (!this.base) this.base = { ...calm };
    const b = this.base;
    // Stimmungsgedächtnis nur für die zurückliegende Fangruppe (langsame Erholung); sonst Nachlauf 8 s
    const d = homeScore - awayScore;
    for (const k of ['homeChant', 'awayChant', 'homeLevel', 'awayLevel'] as const) {
      const tgt = calm[k];
      const behind = k.startsWith('home') ? d < 0 : d > 0;
      b[k] += (tgt - b[k]) * (1 - Math.exp(-dt / (tgt > b[k] ? (behind ? this.upSec : this.downSec) : this.downSec)));
    }
    // Pfiffe dürfen schnell kommen und nur langsam abklingen
    b.homeWhistle += (calm.homeWhistle - b.homeWhistle) * (1 - Math.exp(-dt / (calm.homeWhistle > b.homeWhistle ? this.downSec : this.upSec)));
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const homeChant = clamp(b.homeChant + (now.homeChant - calm.homeChant));
    return {
      row: now.row,
      // R05 gilt auch während des Trends
      homeChant: minute >= 60 && homeScore - awayScore <= -3 ? Math.min(homeChant, PARAMS.homeChantDeficit3After60) : homeChant,
      awayChant: clamp(b.awayChant + (now.awayChant - calm.awayChant)),
      homeLevel: clamp(b.homeLevel + (now.homeLevel - calm.homeLevel)),
      awayLevel: clamp(b.awayLevel + (now.awayLevel - calm.awayLevel)),
      homeWhistle: clamp(b.homeWhistle),
    };
  }
}

// ------------------------------------------------------------------ Zufall & Auswahl
/** deterministischer Zufall (für eine Partie auf allen Geräten gleich) */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * R02 + Parameter: je Partie eine zufällige Teilmenge (3–6 Gesänge, nie alle, sofern mehr als 3 vorhanden).
 * Bei ≤ 3 Gesängen werden alle verwendet.
 */
export function subsetRange(n: number): [number, number] {
  if (n <= PARAMS.subsetMin) return [n, n];
  return [PARAMS.subsetMin, Math.max(PARAMS.subsetMin, Math.min(PARAMS.subsetMax, n - 1))];
}
export function matchSubset<T>(list: T[], seed: string): T[] {
  const [lo, hi] = subsetRange(list.length);
  if (lo >= list.length) return list.slice();
  const rnd = seeded(seed);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a.slice(0, lo + Math.floor(rnd() * (hi - lo + 1)));
}

/**
 * KI-Fanlager: je Partie und Seite 2–4 verschiedene Gesänge aus dem gesamten KI-Pool (zufällig, aber je Partie
 * auf allen Geräten und nach Reconnects gleich – Seed = Partie-ID + Seite). Mindestens zwei „support“-Gesänge,
 * damit Spottgesänge (nur bei Führung) die Häufigkeit nicht senken. `avoid`: Gesänge des anderen Fanlagers –
 * werden nur genommen, wenn sonst zu wenige übrig bleiben.
 */
export const AI_SUBSET = { min: 2, max: 4, minSupport: 2 } as const;
export function aiMatchSubset<T extends { id: string; mood: string }>(pool: T[], seed: string, avoid: Iterable<string> = []): T[] {
  if (!pool.length) return [];
  const rnd = seeded(`ai:${seed}`);
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  const av = new Set(avoid);
  const order = [...a.filter((x) => !av.has(x.id)), ...a.filter((x) => av.has(x.id))];
  const k = Math.min(order.length, AI_SUBSET.min + Math.floor(rnd() * (AI_SUBSET.max - AI_SUBSET.min + 1)));
  const pick = order.slice(0, k);
  const need = Math.min(AI_SUBSET.minSupport, k, order.filter((x) => x.mood !== 'taunt').length);
  for (const extra of order.slice(k)) {
    if (pick.filter((x) => x.mood !== 'taunt').length >= need) break;
    if (extra.mood === 'taunt') continue;
    const i = pick.map((x) => x.mood).lastIndexOf('taunt');
    if (i < 0) break;
    pick[i] = extra;
  }
  return pick;
}

// ------------------------------------------------------------------ Crowd-Reaktionen
export interface ScoreState { minute: number; homeScore: number; awayScore: number; sit: Situation }

/** zutreffender Zustands-Auslöser einer Fangruppe (spezifischster zuerst) */
export function stateTrigger(side: 'home' | 'away', s: ScoreState): CrowdTrigger | null {
  const d = side === 'home' ? s.homeScore - s.awayScore : s.awayScore - s.homeScore;
  const own = s.sit.startsWith(side), opp = !own && (s.sit.startsWith('home') || s.sit.startsWith('away'));
  const attack = s.sit.endsWith('attack') || s.sit.endsWith('box');
  if (s.minute >= 60 && d <= -3) return 'minus3_60';
  if (s.minute >= 78 && Math.abs(d) <= 1) return 'tight_finale';
  if (own && attack) return 'own_attack';
  if (opp && attack) return 'opp_attack';
  if (s.minute >= 45 && d <= -2) return 'minus2_45';
  if (s.minute >= 60 && d >= 2) return 'plus2_60';
  if (own) return 'own_ball';
  if (s.homeScore === 0 && s.awayScore === 0) return 'calm00';
  return null;
}

/** Ereignisgebundene Reaktion: genau eine Variante (gewichtet nach Chance) oder keine – keine Soundgarantie */
export function pickEventReaction(trigger: CrowdTrigger, side: 'home' | 'away', rnd: () => number = Math.random): CrowdRule | null {
  const rules = RULES.filter((r) => r.trigger === trigger && r.side === side && r.chance > 0);
  const total = rules.reduce((a, r) => a + r.chance, 0);
  let x = rnd() * Math.max(100, total);
  for (const r of rules) { x -= r.chance; if (x < 0) return r; }
  return null;
}

// ------------------------------------------------------------------ Auswahlfenster (R04, R20, R29)
export type Side = 'home' | 'away';
export interface SchedulerInput {
  /** Torjubel, Einlauf, Verletzung oder anderes dominantes Audio läuft (R20, R25) */
  busy: boolean;
  /** läuft auf der Seite gerade ein Gesang? (max. 1 je Seite) */
  playing: Record<Side, boolean>;
  /** Seite darf gerade nicht singen (z. B. nach Roter Karte, Verletzung) */
  blocked: Record<Side, boolean>;
  hasSongs: Record<Side, boolean>;
  mood: MoodValues;
  state: ScoreState;
}
export interface Decision { t: number; kind: 'chant' | 'reaction'; side: Side; chance: number; started: boolean; rule?: string }
export type Action = { kind: 'chant'; side: Side } | { kind: 'reaction'; side: Side; rule: CrowdRule };

/**
 * V2-Taktung:
 * - Gesang: Prüffenster alle 5–8 s je Seite; Chance aus der Matrix (H/I) nur bei freiem Slot.
 *   Nach dem natürlichen Ende eines Gesangs 1–3 s Pause, dann sofort neues Prüffenster.
 * - Crowd-Reaktionen: eigenes Fenster alle 5–8 s je Seite, Regel des zutreffenden Zustands, Cooldown je Reaktion,
 *   mindestens 3 s Abstand zwischen zwei Reaktionen (keine Ah-Oh-Uh-Kaskaden), nicht über den eigenen Gesang.
 */
export class FanScheduler {
  private next: Record<'home' | 'away' | 'rhome' | 'raway', number>;
  private cool = new Map<string, number>();
  private lastReaction = -Infinity;
  /** Seite des zuletzt gestarteten Gesangs (Wechsel bevorzugt) */
  private lastSide: Side | null = null;
  readonly log: Decision[] = [];
  /** Zähler über die ganze Partie (Log wird gekürzt) */
  readonly stats = { windows: { home: 0, away: 0 }, starts: { home: 0, away: 0 }, reactionWindows: { home: 0, away: 0 }, reactions: { home: 0, away: 0 } };
  constructor(private rnd: () => number = Math.random, private scale = 1, private p: AudioParams = PARAMS, private tune: { scale: number; whileOtherSings: number; sameSideAgain: number; otherSideTurn: number } = CHANT_TUNING) {
    this.next = { home: this.win() * 0.3, away: this.win() * 0.6, rhome: this.rwin() * 0.5, raway: this.rwin() * 0.8 };
  }
  private win() { return (this.p.chantCheckMin + this.rnd() * (this.p.chantCheckMax - this.p.chantCheckMin)) * this.scale; }
  private rwin() { return (this.p.reactionCheckMin + this.rnd() * (this.p.reactionCheckMax - this.p.reactionCheckMin)) * this.scale; }

  /** natürliches Ende eines Gesangs: 1–3 s Pause, danach gleich das nächste Prüffenster */
  chantEnded(side: Side, t: number) {
    this.next[side] = t + (this.p.chantPauseMin + this.rnd() * (this.p.chantPauseMax - this.p.chantPauseMin)) * this.scale;
  }
  /** Reaktion außerhalb der Fenster (Ereignis) zählt für Mindestabstand und Cooldown */
  noteReaction(rule: CrowdRule, t: number) {
    this.lastReaction = t;
    this.cool.set(`${rule.side}:${rule.reaction}`, t + rule.cooldown * this.scale);
  }

  step(t: number, i: SchedulerInput): Action[] {
    const out: Action[] = [];
    for (const side of ['home', 'away'] as const) {
      if (t < this.next[side]) continue;
      if (i.busy) { this.next[side] = t + 2 * this.scale; continue; }
      this.next[side] = t + this.win();
      if (i.playing[side] || !i.hasSongs[side]) continue; // R29: nur bei freiem Slot
      const other: Side = side === 'home' ? 'away' : 'home';
      const T = this.tune;
      let chance = i.blocked[side] ? 0 : (side === 'home' ? i.mood.homeChant : i.mood.awayChant) * T.scale;
      if (i.playing[other] || out.some((o) => o.kind === 'chant')) chance *= T.whileOtherSings; // gleichzeitig nur selten
      else if (this.lastSide === side) chance *= T.sameSideAgain;
      else if (this.lastSide === other) chance = Math.min(100, chance * T.otherSideTurn);
      const started = this.rnd() * 100 < chance;
      this.log.push({ t, kind: 'chant', side, chance, started });
      this.stats.windows[side]++;
      if (started) { this.stats.starts[side]++; this.lastSide = side; out.push({ kind: 'chant', side }); }
    }
    for (const side of ['home', 'away'] as const) {
      const key = side === 'home' ? 'rhome' : 'raway';
      if (t < this.next[key]) continue;
      if (i.busy) { this.next[key] = t + 2 * this.scale; continue; }
      if (t - this.lastReaction < this.p.reactionGap * this.scale) { this.next[key] = this.lastReaction + this.p.reactionGap * this.scale; continue; }
      this.next[key] = t + this.rwin();
      // nicht über den eigenen (oder gerade startenden) Gesang legen
      if (i.playing[side] || out.some((o) => o.kind === 'chant' && o.side === side)) continue;
      const trig = stateTrigger(side, i.state);
      if (!trig) continue;
      this.stats.reactionWindows[side]++;
      const rules = RULES.filter((r) => r.trigger === trig && r.side === side && !r.eventBound);
      // zufällige Reihenfolge, höchstens eine Reaktion je Fenster
      for (const r of rules.map((x) => [this.rnd(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1])) {
        if ((this.cool.get(`${side}:${r.reaction}`) ?? -Infinity) > t) continue;
        const chance = side === 'home' && r.reaction === 'whistle' ? Math.max(r.chance, i.mood.homeWhistle) : r.chance;
        const started = this.rnd() * 100 < chance;
        this.log.push({ t, kind: 'reaction', side, chance, started, rule: r.id });
        if (started) {
          this.noteReaction(r, t);
          this.stats.reactions[side]++;
          out.push({ kind: 'reaction', side, rule: r });
          break;
        }
      }
    }
    if (this.log.length > 600) this.log.splice(0, 300);
    return out;
  }
}
