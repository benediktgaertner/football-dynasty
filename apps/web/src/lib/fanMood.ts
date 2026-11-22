/**
 * Dynamisches Fanstimmungsmodell (rein rechnerisch, ohne Web Audio – testbar).
 * Grundlage: docs/Football_Dynasty_Fanstimmung_Audio_Matrix.xlsx
 *   · „Stimmungs-Matrix“: 105 Zustände (Phase × Spielstand aus Heimsicht × Spielsituation)
 *     → Gesangschance Heim/Gast je Auswahlfenster, Grundpegel Heim/Gast, Pfiff-Chance Heim
 *   · „Ereignis-Sounds“: 26 Ereignisse mit Pegel, Dauer und Priorität
 *   · „Audio-Regeln“ R01–R22 (Auswahlfenster 8–12 s, Teilmenge je Partie, keine direkte Wiederholung,
 *     0:4-Regel, Trend statt Sofort-Erholung, Ein-/Ausblenden, Vorrang von Ereignissen)
 * Die Werte werden mit scripts/import-fan-matrix.py in fanMoodData.ts übernommen.
 */
import type { Situation } from './crowdModel';
import { MOOD_EVENTS, MOOD_ROWS } from './fanMoodData';

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
 * R05: ab Minute 60 und ≥ 3 Toren Rückstand höchstens 4 % Gesangschance der Heimfans, hörbare Pfiffe.
 */
export function moodTargets(minute: number, homeScore: number, awayScore: number, sit: Situation | number): MoodValues & { row: MoodRow } {
  const row = moodRow(minute, homeScore, awayScore, sit);
  let { homeChant, homeWhistle } = row;
  if (minute >= 60 && homeScore - awayScore <= -3) { homeChant = Math.min(homeChant, 4); homeWhistle = Math.max(homeWhistle, 60); }
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
  constructor(private upSec = 45, private downSec = 4) {}

  update(dt: number, minute: number, homeScore: number, awayScore: number, sit: Situation | number): MoodValues & { row: MoodRow } {
    const calm = moodTargets(minute, homeScore, awayScore, 0);
    const now = moodTargets(minute, homeScore, awayScore, sit);
    if (!this.base) this.base = { ...calm };
    const b = this.base;
    for (const k of ['homeChant', 'awayChant', 'homeLevel', 'awayLevel'] as const) {
      const tgt = calm[k];
      b[k] += (tgt - b[k]) * (1 - Math.exp(-dt / (tgt > b[k] ? this.upSec : this.downSec)));
    }
    // Pfiffe dürfen schnell kommen und nur langsam abklingen
    b.homeWhistle += (calm.homeWhistle - b.homeWhistle) * (1 - Math.exp(-dt / (calm.homeWhistle > b.homeWhistle ? this.downSec : this.upSec)));
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const homeChant = clamp(b.homeChant + (now.homeChant - calm.homeChant));
    return {
      row: now.row,
      // R05 gilt auch während des Trends
      homeChant: minute >= 60 && homeScore - awayScore <= -3 ? Math.min(homeChant, 4) : homeChant,
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

/** R02: je Partie nur einen Teil der Gesänge aktiv (≈ 60 %, mindestens 2, bei ≤ 2 Gesängen alle) */
export function matchSubset<T>(list: T[], seed: string): T[] {
  if (list.length <= 2) return list.slice();
  const rnd = seeded(seed);
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a.slice(0, Math.max(2, Math.round(list.length * 0.6)));
}

// ------------------------------------------------------------------ Auswahlfenster (R04, R20)
export type Side = 'home' | 'away';
export interface SchedulerInput {
  /** Torjubel, Einlauf, Verletzung oder anderes dominantes Audio läuft (R20) */
  busy: boolean;
  playing: Record<Side, boolean>;
  /** Seite darf gerade nicht singen (z. B. nach Roter Karte, Verletzung) */
  blocked: Record<Side, boolean>;
  hasSongs: Record<Side, boolean>;
  mood: MoodValues;
}
export interface Decision { t: number; kind: 'chant' | 'whistle'; side: Side; chance: number; started: boolean }

/**
 * Alle 8–12 s (Echtzeit) je Seite prüfen, ob ein neuer Gesang beginnt (Chance aus der Matrix);
 * läuft auf der Seite bereits ein Gesang, wird nicht neu gewählt. Pfiffe der Heimfans eigenes Fenster.
 */
export class FanScheduler {
  private next: Record<'home' | 'away' | 'whistle', number>;
  readonly log: Decision[] = [];
  /** Zähler über die ganze Partie (Log wird gekürzt) */
  readonly stats = { windows: { home: 0, away: 0, whistle: 0 }, starts: { home: 0, away: 0, whistle: 0 } };
  constructor(private rnd: () => number = Math.random, private scale = 1) {
    this.next = { home: this.win() * 0.4, away: this.win() * 0.7, whistle: this.win() * 0.5 };
  }
  private win() { return (8 + this.rnd() * 4) * this.scale; }

  step(t: number, i: SchedulerInput): Array<{ kind: 'chant' | 'whistle'; side: Side }> {
    const out: Array<{ kind: 'chant' | 'whistle'; side: Side }> = [];
    for (const side of ['home', 'away'] as const) {
      if (t < this.next[side]) continue;
      if (i.busy) { this.next[side] = t + 2 * this.scale; continue; } // kurz warten, dann neues Fenster
      this.next[side] = t + this.win();
      if (i.playing[side] || !i.hasSongs[side]) continue;
      const chance = i.blocked[side] ? 0 : side === 'home' ? i.mood.homeChant : i.mood.awayChant;
      const started = this.rnd() * 100 < chance;
      this.log.push({ t, kind: 'chant', side, chance, started });
      this.stats.windows[side]++;
      if (started) { this.stats.starts[side]++; out.push({ kind: 'chant', side }); }
    }
    if (t >= this.next.whistle) {
      if (i.busy) this.next.whistle = t + 2 * this.scale;
      else {
        this.next.whistle = t + this.win();
        // Pfiffe statt Gesang: nicht über einen laufenden Heimgesang
        if (!i.playing.home && !out.some((o) => o.side === 'home')) {
          const chance = i.mood.homeWhistle;
          const started = this.rnd() * 100 < chance;
          this.log.push({ t, kind: 'whistle', side: 'home', chance, started });
          this.stats.windows.whistle++;
          if (started) { this.stats.starts.whistle++; out.push({ kind: 'whistle', side: 'home' }); }
        }
      }
    }
    if (this.log.length > 400) this.log.splice(0, 200);
    return out;
  }
}
