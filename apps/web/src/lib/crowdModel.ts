/**
 * Zuschauerreaktion als reines Modell (ohne Web Audio, testbar):
 * Spielsituation → Ziel-Intensität für Heim- und Gästefans → geglättete Werte → Verstärkung.
 *
 * Ausgangswerte (relative Intensität, keine gemessenen Stadionpegel):
 *   Normales Spiel 40/12 · Angriff Heim 65/10 · Heim vor dem Tor 85/8 · Heimtor 100/5
 *   Angriff Gäste 25/30 · Auswärtstor 5/65 · Spannende Schlussphase 80/25
 * Die Intensität wird auf einen Pegelbereich von 30 dB abgebildet (0,40 → −18 dB, 1,0 → 0 dB),
 * damit die Unterschiede tatsächlich hörbar sind; Übergänge laufen über Zeitkonstanten (keine Sprünge).
 */
export type Situation =
  | 'calm' | 'harmless' | 'home_possession' | 'home_attack' | 'home_box'
  | 'away_possession' | 'away_attack' | 'away_box' | 'finale';

export const LEVELS: Record<Situation | 'home_goal' | 'away_goal' | 'home_miss', readonly [number, number]> = {
  calm: [0.40, 0.12],
  harmless: [0.30, 0.11],
  home_possession: [0.50, 0.11],
  home_attack: [0.65, 0.10],
  home_box: [0.85, 0.08],
  away_possession: [0.33, 0.18],
  away_attack: [0.25, 0.30],
  away_box: [0.22, 0.38],
  finale: [0.80, 0.25],
  home_goal: [1.0, 0.05],
  away_goal: [0.05, 0.65],
  home_miss: [0.30, 0.14],
};

export interface PlayState {
  /** Ballbesitz (sichtbarer Ballführer) */
  possession: 'home' | 'away' | null;
  /** Abstand des Balls zum Tor, auf das der Ballbesitzer spielt (m) */
  toGoal: number;
  /** Ball im Strafraum des Gegners */
  inBox: boolean;
  /** Ballgeschwindigkeit in Richtung gegnerisches Tor (m/s, negativ = Rückpass) */
  forward: number;
  minute: number;
  homeScore: number;
  awayScore: number;
}

/** Situation aus dem sichtbaren Spielzustand */
export function situationOf(s: PlayState): Situation {
  const tight = s.minute >= 78 && Math.abs(s.homeScore - s.awayScore) <= 1;
  let sit: Situation;
  if (!s.possession) sit = 'calm';
  else if (s.forward < -3 && s.toGoal > 45) sit = 'harmless'; // Rückpass, Spielaufbau ⇒ ruhiger
  else if (s.possession === 'home') sit = s.inBox || s.toGoal < 18 ? 'home_box' : s.toGoal < 35 || s.forward > 6 ? 'home_attack' : 'home_possession';
  else sit = s.inBox || s.toGoal < 18 ? 'away_box' : s.toGoal < 35 || s.forward > 6 ? 'away_attack' : 'away_possession';
  // Schlussphase bei knappem Stand: Grundspannung deutlich höher (außer bei klarer Gefahr für das eigene Tor)
  if (tight && (sit === 'calm' || sit === 'harmless' || sit === 'home_possession' || sit === 'away_possession')) return 'finale';
  return sit;
}

export function targetsOf(sit: Situation, s: PlayState): [number, number] {
  const [h, a] = LEVELS[sit];
  if (sit === 'home_box' || sit === 'away_box' || sit === 'home_attack' || sit === 'away_attack') {
    // Schlussphase verstärkt jeden Angriff noch etwas
    const extra = s.minute >= 78 && Math.abs(s.homeScore - s.awayScore) <= 1 ? 0.08 : 0;
    return [Math.min(1, h + (sit.startsWith('home') ? extra : 0)), Math.min(1, a + (sit.startsWith('away') ? extra : 0))];
  }
  return [h, a];
}

/** 0…1 → lineare Verstärkung (30 dB Bereich) */
export function intensityGain(i: number): number {
  return 10 ** ((-30 + 30 * Math.max(0, Math.min(1, i))) / 20);
}

/**
 * Hüllkurve beider Fangruppen: folgt der Situation mit Zeitkonstanten,
 * Ereignisse (Tor, Gegentor, vergebene Chance) überschreiben das Ziel für eine Weile.
 */
export class CrowdEnvelope {
  home = LEVELS.calm[0];
  away = LEVELS.calm[1];
  private override: { until: number; home: number; away: number; fallHome: number } | null = null;
  private t = 0;

  /** Tor (Heim/Gäste) bzw. vergebene Großchance */
  event(kind: 'home_goal' | 'away_goal' | 'home_miss' | 'away_miss', holdSec?: number) {
    const lv = kind === 'away_miss' ? ([0.5, 0.12] as const) : LEVELS[kind];
    const hold = holdSec ?? (kind === 'home_goal' ? 8 : kind === 'away_goal' ? 8 : 2.5);
    // Gegentor: Heimfans verstummen schlagartig; Heimtor: explosiver Anstieg
    this.override = { until: this.t + hold, home: lv[0], away: lv[1], fallHome: kind === 'away_goal' ? 0.35 : kind === 'home_miss' ? 1.2 : 2 };
    if (kind === 'home_goal') this.home = Math.max(this.home, 0.92);
    if (kind === 'away_goal') this.away = Math.max(this.away, 0.5);
  }

  /** Wiederanstoß: Torjubel/Verstummen sofort beenden, die Kulisse folgt wieder der Spielsituation */
  release() { this.override = null; }

  /** läuft gerade ein Ereignis (Tor, Chance)? */
  get busy(): boolean { return !!this.override && this.t < this.override.until; }

  /** dt in Sekunden; target aus targetsOf(); liefert aktuelle Intensitäten */
  update(dt: number, target: readonly [number, number]): { home: number; away: number } {
    this.t += dt;
    let [th, ta] = target;
    let fallH = 2.2;
    if (this.override) {
      if (this.t < this.override.until) { th = this.override.home; ta = this.override.away; fallH = this.override.fallHome; }
      else this.override = null;
    }
    // schneller Anstieg (≈ 0,6 s), langsameres Abklingen (≈ 2,2 s; Verstummen nach Gegentor ≈ 0,35 s)
    const step = (cur: number, tgt: number, up: number, down: number) => cur + (tgt - cur) * (1 - Math.exp(-dt / (tgt > cur ? up : down)));
    this.home = step(this.home, th, 0.6, fallH);
    this.away = step(this.away, ta, 0.5, 2.5);
    return { home: this.home, away: this.away };
  }
}
