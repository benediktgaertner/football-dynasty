/**
 * Unmut der Heimfans: entscheidet, ob und wie stark die Heimkurve pfeift bzw. buht.
 *
 * Reine Logik ohne Audio (testbar). MatchSound meldet Spielereignisse aus Sicht des Heimteams; das Modell
 * liefert eine Entscheidung (kurzer Pfiff oder längeres Pfeifkonzert, Intensität) oder nichts.
 *
 * Grundsätze
 * - Schiedsrichter/Gegner (hartes Foul, Karte/Elfmeter gegen Heim, Foulserie): unabhängig vom Spielstand – auch bei Führung.
 * - Schwache Heimleistung (Gegentore, Gefahr in Serie, Ballverluste, Rückstand): abhängig von Spielstand, Minute
 *   und der aufgestauten Unzufriedenheit D (0…1). Ein einzelner Ballverlust bei 0:0 löst nichts aus.
 * - Fouls des Heimteams lösen bei den Heimfans nie Pfiffe aus (werden gar nicht gemeldet).
 * - Cooldowns und eine Obergrenze je 10 Minuten verhindern Dauerpfeifen und Überlagerungen.
 */
export type DisapprovalCause =
  | 'hard_foul' | 'foul' | 'foul_series' | 'card_home' | 'red_home' | 'penalty_against' | 'offside_home'
  | 'danger_series' | 'conceded' | 'conceded_error' | 'ball_loss' | 'deficit' | 'weak_spell' | 'halftime' | 'missed_chance';

export interface DisapprovalCtx {
  /** Audiozeit in Sekunden (wie MatchSound.t) */
  t: number;
  minute: number;
  /** Tordifferenz aus Heimsicht (Heim − Gast) */
  diff: number;
}

export interface Disapproval {
  t: number; minute: number; diff: number;
  cause: DisapprovalCause;
  /** kurzer Pfiff (≈ 3–4 s) oder Pfeifkonzert (≈ 7–16 s) */
  length: 'short' | 'long';
  /** Lautstärkefaktor 0,5…1,3 */
  intensity: number;
  /** berechnete Wahrscheinlichkeit 0…1 */
  chance: number;
  /** Ergebnis: true = wird gespielt; sonst Grund */
  play: boolean;
  reason?: 'chance' | 'cooldown' | 'limit';
  D: number;
}

export const DISAPPROVAL = {
  /** Mindestabstand zwischen zwei Pfeifreaktionen (s) */
  gap: 14,
  /** Mindestabstand zwischen zwei langen Pfeifkonzerten (s) */
  gapLong: 50,
  /** schwere Entscheidungen (Elfmeter, Rot, hartes Foul) dürfen früher kommen (s) */
  gapSevere: 6,
  /** gleiche Ursache frühestens nach (s) */
  gapCause: 45,
  /** höchstens so viele Pfeifreaktionen je 10 Spielminuten Audiozeit (600 s) */
  maxPer10Min: 5,
  /** Abbau der aufgestauten Unzufriedenheit je Sekunde (Richtung Grundwert aus dem Spielstand) */
  decay: 1 / 300,
  /** Anstieg Richtung Spielstand-Grundwert je Sekunde (schlechter Stand verärgert schnell) */
  rise: 1 / 45,
  /** Prüfintervall für anhaltenden Unmut (Rückstand, schwache Phase) in s */
  checkEvery: 20,
} as const;

/** Grundwahrscheinlichkeit je Ursache und ob sie „schwer“ ist (Schiedsrichter-/Fouleinfluss) */
const BASE: Record<DisapprovalCause, { p: number; severe?: boolean; referee?: boolean }> = {
  hard_foul: { p: 0.85, severe: true, referee: true },
  foul: { p: 0.06, referee: true },
  foul_series: { p: 0.5, referee: true },
  card_home: { p: 0.55, referee: true },
  red_home: { p: 0.92, severe: true, referee: true },
  penalty_against: { p: 0.9, severe: true, referee: true },
  offside_home: { p: 0.1, referee: true },
  danger_series: { p: 0.16 },
  conceded: { p: 0 },
  conceded_error: { p: 0.6 },
  ball_loss: { p: 0 },
  deficit: { p: 0 },
  weak_spell: { p: 0.25 },
  halftime: { p: 0 },
  missed_chance: { p: 0 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Unzufriedenheit, die allein der Spielstand rechtfertigt (Untergrenze für D) */
export function baseDiscontent(diff: number, minute: number): number {
  const behind = Math.max(0, -diff);
  return clamp(behind * 0.2 * (minute >= 75 ? 1.3 : minute >= 46 ? 1.1 : 0.85), 0, 0.9);
}

export class HomeDisapproval {
  /** aufgestaute Unzufriedenheit 0…1 */
  D = 0;
  readonly log: Disapproval[] = [];
  private lastPlay = -1e9;
  private lastLong = -1e9;
  private lastCause = new Map<DisapprovalCause, number>();
  private plays: number[] = [];
  private awayFouls: number[] = [];
  private awayDanger: number[] = [];
  private homeDanger: number[] = [];
  private lastCheck = 0;

  constructor(private rnd: () => number = Math.random) {}
  /** nur für Tests: Zufallsquelle ersetzen (z. B. () => 0 ⇒ jede erlaubte Reaktion wird gespielt) */
  setRandom(r: () => number) { this.rnd = r; }

  /** Zeitverlauf: D baut sich Richtung Spielstand-Grundwert ab; alle checkEvery s Prüfung auf anhaltenden Unmut */
  tick(dt: number, c: DisapprovalCtx): Disapproval | null {
    const floor = baseDiscontent(c.diff, c.minute);
    this.D = this.D > floor ? Math.max(floor, this.D - dt * DISAPPROVAL.decay) : Math.min(floor, this.D + dt * DISAPPROVAL.rise);
    if (c.t - this.lastCheck < DISAPPROVAL.checkEvery) return null;
    this.lastCheck = c.t;
    // deutlicher Rückstand (v. a. 2. Halbzeit, Schlussphase): zunehmender Unmut
    if (c.diff <= -2 && c.minute >= 30) {
      const p = 0.07 * (-c.diff - 1) * (c.minute >= 75 ? 1.6 : c.minute >= 46 ? 1.2 : 0.7) * (0.6 + this.D);
      return this.decide('deficit', c, p, c.diff <= -3 && c.minute >= 60 ? 'long' : undefined);
    }
    // lange schwache Phase: Gegner in den letzten 10 min deutlich gefährlicher, eigene Mannschaft harmlos
    const w = this.recent(this.awayDanger, c.t, 600) - this.recent(this.homeDanger, c.t, 600);
    if (w >= 6 && c.diff <= 0) return this.decide('weak_spell', c, BASE.weak_spell.p * (c.diff < 0 ? 1.4 : 1));
    return null;
  }

  // ---------------------------------------------------------------- Beobachtungen (ohne direkte Reaktion)
  /** Gast kommt gefährlich vor das Heimtor (Strafraum, Schuss, Chance); bei Serie ggf. Unmut */
  awayDangerous(c: DisapprovalCtx): Disapproval | null {
    this.awayDanger.push(c.t);
    this.D = clamp(this.D + 0.025, 0, 1);
    const n = this.recent(this.awayDanger, c.t, 150);
    if (n >= 3) {
      const p = BASE.danger_series.p * this.scoreFactor(c.diff) * this.lateFactor(c.minute) * (0.6 + this.D);
      return this.decide('danger_series', c, c.diff >= 1 ? p * 0.4 : p);
    }
    return null;
  }
  homeDangerous(c: DisapprovalCtx) { this.homeDanger.push(c.t); this.D = clamp(this.D - 0.03, 0, 1); }
  homeGoal() { this.D = clamp(this.D - 0.35, 0, 1); }

  // ---------------------------------------------------------------- Ereignisse mit möglicher Reaktion
  /** Foul des Gastes an einem Heimspieler; hart = Karte/Verletzung/Elfmeter in derselben Szene */
  awayFoul(c: DisapprovalCtx, hard: boolean): Disapproval | null {
    this.awayFouls.push(c.t);
    if (hard) return this.decide('hard_foul', c, BASE.hard_foul.p);
    if (this.recent(this.awayFouls, c.t, 300) >= 3) return this.decide('foul_series', c, BASE.foul_series.p);
    return this.decide('foul', c, BASE.foul.p);
  }
  /** Karte gegen einen Heimspieler (strittig aus Sicht der Heimfans) */
  homeCard(c: DisapprovalCtx, red: boolean): Disapproval | null {
    this.D = clamp(this.D + (red ? 0.15 : 0.05), 0, 1);
    return red ? this.decide('red_home', c, BASE.red_home.p, this.rnd() < 0.45 ? 'long' : 'short') : this.decide('card_home', c, BASE.card_home.p);
  }
  penaltyAgainst(c: DisapprovalCtx): Disapproval | null {
    this.D = clamp(this.D + 0.1, 0, 1);
    return this.decide('penalty_against', c, BASE.penalty_against.p, this.rnd() < 0.35 ? 'long' : 'short');
  }
  offsideHome(c: DisapprovalCtx): Disapproval | null { return this.decide('offside_home', c, BASE.offside_home.p); }

  /** Gegentor; `c.diff` ist der Stand NACH dem Tor. error = Ballverlust in der eigenen Hälfte kurz davor */
  conceded(c: DisapprovalCtx, error: boolean): Disapproval | null {
    const behind = Math.max(0, -c.diff);
    this.D = clamp(this.D + 0.12 + 0.08 * behind + (error ? 0.15 : 0), 0, 1);
    if (error) return this.decide('conceded_error', c, BASE.conceded_error.p * (c.diff >= 1 ? 0.5 : 1));
    if (behind < 2) return null; // normales Gegentor bei knappem Stand: Enttäuschung, keine Pfiffe
    const p = clamp(0.35 + 0.15 * (behind - 2) + 0.3 * this.D, 0, 0.9) * this.lateFactor(c.minute);
    return this.decide('conceded', c, p, behind >= 3 && this.D > 0.6 ? 'long' : undefined);
  }

  /** Ballverlust des Heimteams (own = in der eigenen Hälfte) – nur bei aufgestautem Frust */
  ballLoss(c: DisapprovalCtx, own: boolean): Disapproval | null {
    if (c.diff < 0) this.D = clamp(this.D + 0.01, 0, 1);
    const frust = this.D - 0.45;
    if (frust <= 0 || c.diff >= 0) return null; // 0:0 oder Führung: einzelne Fehler werden toleriert
    const p = frust * 0.5 * (own ? 1.3 : 1) * this.lateFactor(c.minute) * this.scoreFactor(c.diff);
    return this.decide('ball_loss', c, p, this.D > 0.75 && c.minute >= 70 ? 'long' : undefined);
  }

  /** eigene Großchance vergeben – meist Aufmunterung; nur bei großem Frust Buhrufe */
  missedChance(c: DisapprovalCtx): Disapproval | null {
    if (c.diff >= 0 || this.D < 0.6) return null;
    return this.decide('missed_chance', c, (this.D - 0.55) * 0.5);
  }

  halftime(c: DisapprovalCtx): Disapproval | null {
    const behind = Math.max(0, -c.diff);
    const p = behind >= 1 ? 0.3 + 0.25 * (behind - 1) + 0.2 * this.D : this.D > 0.6 ? 0.25 : 0;
    return this.decide('halftime', c, p, behind >= 2 ? 'long' : undefined);
  }

  /** Pfiff-Regel der Stimmungsmatrix (Excel) für die Heimkurve – läuft durch dieselben Cooldowns/Grenzen */
  matrix(c: DisapprovalCtx, ruleChance: number): Disapproval | null {
    const p = ruleChance * (0.4 + this.D) * (c.diff >= 1 ? 0.4 : 1);
    return this.decide(c.diff < 0 ? 'deficit' : 'danger_series', c, p, c.diff <= -3 && c.minute >= 60 && this.D > 0.6 ? 'long' : undefined);
  }
  /** sofortige Prüfung auf anhaltenden Unmut (z. B. Zustandsereignis „Heim ≥ 3 zurück ab Minute 60“) */
  deficitNow(c: DisapprovalCtx): Disapproval | null {
    this.lastCheck = -1e9;
    return this.tick(0, c);
  }

  // ---------------------------------------------------------------- intern
  private recent(list: number[], t: number, win: number): number {
    while (list.length && t - list[0]! > 900) list.shift();
    return list.filter((x) => t - x <= win).length;
  }
  private scoreFactor(diff: number): number { return diff >= 2 ? 0.4 : diff === 1 ? 0.6 : diff === 0 ? 1 : diff === -1 ? 1.15 : diff === -2 ? 1.35 : 1.6; }
  private lateFactor(minute: number): number { return minute >= 75 ? 1.3 : minute >= 46 ? 1.1 : 1; }

  private decide(cause: DisapprovalCause, c: DisapprovalCtx, chance: number, length?: 'short' | 'long'): Disapproval | null {
    const b = BASE[cause];
    const p = clamp(chance, 0, 0.95);
    if (p <= 0) return null;
    const long = (length ?? (this.D >= 0.7 && !b.referee && c.diff <= -2 ? 'long' : 'short')) === 'long';
    const sev = b.severe ? 1 : b.referee ? 0.5 : 0;
    const intensity = clamp(0.55 + 0.3 * sev + 0.35 * this.D + (c.diff <= -2 ? 0.1 : 0) + (c.minute >= 75 && c.diff < 0 ? 0.1 : 0), 0.5, 1.3);
    const d: Disapproval = { t: c.t, minute: c.minute, diff: c.diff, cause, length: long ? 'long' : 'short', intensity: Math.round(intensity * 100) / 100, chance: Math.round(p * 1000) / 1000, play: false, D: Math.round(this.D * 100) / 100 };
    this.plays = this.plays.filter((x) => c.t - x < 600);
    const since = c.t - this.lastPlay;
    if (since < (b.severe ? DISAPPROVAL.gapSevere : DISAPPROVAL.gap) || c.t - (this.lastCause.get(cause) ?? -1e9) < (b.severe ? DISAPPROVAL.gapSevere : DISAPPROVAL.gapCause)) d.reason = 'cooldown';
    else if (this.plays.length >= DISAPPROVAL.maxPer10Min && !b.severe) d.reason = 'limit';
    else if (this.rnd() >= p) d.reason = 'chance';
    else {
      // langes Konzert nur mit genügend Abstand, sonst kurzer Pfiff
      if (d.length === 'long' && c.t - this.lastLong < DISAPPROVAL.gapLong) d.length = 'short';
      d.play = true;
      this.lastPlay = c.t; this.plays.push(c.t); this.lastCause.set(cause, c.t);
      if (d.length === 'long') this.lastLong = c.t;
    }
    this.log.push(d);
    if (this.log.length > 400) this.log.shift();
    return d;
  }
}
