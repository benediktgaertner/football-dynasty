/**
 * Vertragsmanagement beim Saisonabschluss: Vertragsattraktivität (Barometer 0–100).
 * Spiegel von SQL fd_contract_reference / fd_contract_utility / fd_contract_prob (Migration 0038).
 * Der Server entscheidet; der Client nutzt das nur für die Live-Anzeige. Änderungen an den Konstanten
 * müssen in beiden Implementierungen erfolgen (Paritätstest: contracts.test.ts + supabase/tests/G2_contracts.sql).
 *
 * Modell:
 *   Erwartung  R = S0 · (1 + e)   mit e aus Stärkeentwicklung, Leistung, Alter und Marktlage (−20 % … +60 %)
 *   Nutzen     U = 10 + Geld + Einsatzzeit + Laufzeit + Perspektive + Reputation
 *   Geld       = 60 · ln(S1 / R)  (ab 31 Jahren ×1,15)
 *   Barometer  P = 1 / (1 + exp(−U / 6)), das ist die Zusagewahrscheinlichkeit.
 * Die Entscheidung fällt deterministisch je Spieler und Saison: Zusage genau dann, wenn eine feste Zahl x ∈ [0, 1)
 * (Hash aus Spieler und Saison, dem Client nicht bekannt) kleiner als P ist. Dasselbe Angebot ergibt also immer
 * dieselbe Antwort; ein höheres Angebot wird nie schlechter beantwortet.
 */
export interface ContractInputs {
  /** bisheriges Jahresgehalt */
  currentSalary: number;
  /** angebotenes neues Jahresgehalt */
  offeredSalary: number;
  /** marktübliches Gehalt (Stärke, Alter, Spielklasse, Reputation) */
  marketSalary: number;
  overall: number;
  /** OVR-Veränderung in der Saison */
  overallChange: number;
  /** Ø-Matchbewertung der Saison (null = keine Einsätze) */
  rating: number | null;
  /** Anteil der gespielten Minuten an den möglichen (0–1, null = unbekannt) */
  minutesShare: number | null;
  age: number;
  /** Laufzeit des neuen Vertrags ab der nächsten Saison (1–5) */
  years: number;
  /** Spielklasse des Vereins (1–4) */
  tier: number;
  /** Tabellenplatz und Teilnehmerzahl (null = unbekannt) */
  position: number | null;
  teams: number | null;
  /** Vereinsreputation 0–100 */
  reputation: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Gehalt, das der Spieler nach Entwicklung, Leistung, Alter und Marktlage erwartet */
export function contractReference(i: ContractInputs): number {
  const eOvr = i.overallChange > 0 ? 0.07 * i.overallChange : 0.03 * i.overallChange;
  const eMkt = clamp(0.35 * Math.log(i.marketSalary / i.currentSalary), -0.15, 0.25);
  const eAge = i.age >= 31 ? -0.02 * (i.age - 30) : 0;
  const ePerf = i.rating !== null && i.minutesShare !== null && i.minutesShare >= 0.3 ? 0.12 * (i.rating - 6.5) : 0;
  const e = clamp(eOvr + eMkt + eAge + ePerf, -0.2, 0.6);
  return i.currentSalary * (1 + e);
}

/** Gesamtnutzen U des Angebots aus Sicht des Spielers */
export function contractUtility(i: ContractInputs): number {
  const young = i.age <= 24;
  const money = 60 * (i.age >= 31 ? 1.15 : 1) * Math.log(i.offeredSalary / contractReference(i));
  const share = i.minutesShare ?? (young ? 0.5 : 0.4);
  const play = (young ? 14 : 6) * (share - (young ? 0.5 : 0.4));
  const pref = i.age <= 23 ? 4 : i.age >= 31 ? 2 : 3;
  const years = -1.5 * Math.abs(i.years - pref);
  const amb = clamp(0.6 + (i.overall - 65) / 25, 0.5, 1.3);
  const tierPts = i.tier <= 1 ? 6 : i.tier === 2 ? 0 : i.tier === 3 ? -6 : -12;
  const placePts = i.position === null || i.teams === null ? 0 : i.position <= 3 ? 3 : i.position >= i.teams - 2 ? -3 : 0;
  const rep = 0.1 * (i.reputation - 50);
  return 10 + money + play + years + amb * (tierPts + placePts) + rep;
}

/** Zusagewahrscheinlichkeit 0–1 */
export function contractProbability(i: ContractInputs): number {
  return 1 / (1 + Math.exp(-contractUtility(i) / 6));
}

/** Barometer 0–100 */
export function contractBarometer(i: ContractInputs): number {
  return Math.round(contractProbability(i) * 100);
}

/** Entscheidung bei gegebener fester Zufallszahl x ∈ [0, 1) des Spielers (Server: Hash aus Spieler und Saison) */
export function contractAccepts(i: ContractInputs, x: number): boolean {
  return x < contractProbability(i);
}

/** Abfindung bei vorzeitiger Auflösung: Restgehalt (volle verbleibende Saisons) × 0,7 */
export const CONTRACT_TERMINATION_FACTOR = 0.7;
export function terminationCompensation(annualSalary: number, remainingSeasons: number): number {
  return Math.round((annualSalary * Math.max(0, remainingSeasons) * CONTRACT_TERMINATION_FACTOR) / 100) * 100;
}

/** Harte Obergrenze: Spieler darüber werden nie ablösefrei Free Agent (verlängern immer bzw. wechseln gegen Ablöse) */
export const FREE_AGENT_MAX_OVERALL = 82;
