/**
 * Stadionton eines Spiels: verbindet sichtbare Spielereignisse mit dem Mixer.
 * - Auslöser sind ausschließlich Ereignisse/Zustände, die gerade auf dem Spielfeld zu sehen sind
 *   (gleicher Tick wie die Darstellung) – kein Ereignis löst zweimal aus.
 * - Kulisse: Heim- und Gästefans als getrennte Spuren; Intensität aus der Spielsituation (crowdModel),
 *   30-dB-Bereich mit weichen Übergängen (Angriff, Strafraum, Chance vergeben, Tor, Gegentor, Schlussphase).
 * - Fangesänge: AUSSCHLIESSLICH hochgeladene MP3 des jeweiligen Vereins (Heimverein links, Gastverein rechts),
 *   zufällig, ohne direkte Wiederholung, mit natürlichen Pausen. KI-Vereine ohne Upload singen nicht –
 *   dort gibt es nur Stadionrauschen und situative Reaktionen. Keine generierten Gesänge, keine Chant-Schleifen.
 * - Ereignisse (Aufnahmen): Anfeuerung bei Angriffen, Aufschrei bei Großchancen, Raunen bei vergebenen Chancen,
 *   Pfiffe gegen den Gegner, Klatschen (Ecke, langer Ballbesitz, Schlussphase), Torjubel bzw. Enttäuschung – geschichtet über Gesang und Rauschen.
 * - Hymne und Signatur-Fangesang nur beim Einlauf; Torhymne nur beim Tor des eigenen Vereins.
 */
import { mixer, type Track } from './audioMixer';
import { CrowdEnvelope, chantRate, situationOf, targetsOf, type PlayState, type Situation } from './crowdModel';
import { loadCrowdLibrary } from './crowdLibrary';
import type { AudioRef } from './matchClient';

export interface ChantRef extends AudioRef { signature?: boolean }

/** reguläre Gesänge = alles außer Signatur-Gesang und Torhymne */
export function regularChants(list: ChantRef[]): ChantRef[] {
  return list.filter((c) => !!c.path && !c.signature && c.situation !== 'goal');
}
export function goalHymns(list: ChantRef[]): ChantRef[] {
  return list.filter((c) => !!c.path && c.situation === 'goal');
}
/** nächsten Gesang wählen: zufällig, nicht derselbe wie zuletzt (sofern Alternativen da sind) */
export function pickNext<T extends { id: string }>(list: T[], lastId: string | null, rnd: () => number = Math.random): T | null {
  if (!list.length) return null;
  const pool = list.length > 1 ? list.filter((c) => c.id !== lastId) : list;
  return pool[Math.floor(rnd() * pool.length)] ?? pool[0]!;
}
/** Pause bis zum nächsten Gesang (Sekunden): 3–8 s, bei Druckphasen kürzer */
export function nextPause(pressure: number, rnd: () => number = Math.random): number {
  const p = Math.max(0, Math.min(1, pressure));
  return (3 + rnd() * 5) * (1 - 0.35 * p);
}

type Ev = { tick: number; type: string; side: 'home' | 'away' | null; xg?: number };
type Side = 'home' | 'away';

/**
 * Rhythmisches Klatschen als situative Reaktion (kein Gesang, keine Dauerschleife):
 * Ecke/Freistoß der eigenen Mannschaft, längerer eigener Ballbesitz, knappe Schlussphase.
 */
export function clapTrigger(o: { sit: Situation; side: 'home' | 'away'; ownPossessionSec: number; corner: boolean; sinceLastClap: number }): boolean {
  if (o.sinceLastClap < 25) return false;
  if (o.corner) return true;
  if (o.sit === 'finale') return true;
  return o.side === 'home' && o.ownPossessionSec > 10;
}

const DEFAULT_MANIFEST = '/audio/crowd/manifest.json';

export class MatchSound {
  private uploads: Record<Side, ChantRef[]> = { home: [], away: [] };
  private homeGoal: ChantRef[] = [];
  private awayGoal: ChantRef[] = [];
  private cur: Record<Side, Track | null> = { home: null, away: null };
  private lastClap: Record<Side, number> = { home: -99, away: -99 };
  private possSince: { side: Side | null; t: number } = { side: null, t: 0 };
  private lastUpload: Record<Side, string | null> = { home: null, away: null };
  private wait: Record<Side, number> = { home: 4, away: 9 };
  private goalUntil = 0;
  private finished = false;
  private started = false;
  private sit: Situation = 'calm';
  private lastAttack: Record<Side, number> = { home: 0, away: 0 };
  private t = 0;
  readonly envelope = new CrowdEnvelope();
  private url: (path: string) => string;
  private manifest: string;
  /** Bibliothek geladen (Promise für Tests) */
  ready: Promise<void> = Promise.resolve();

  constructor(url: (path: string) => string, manifest = DEFAULT_MANIFEST) { this.url = url; this.manifest = manifest; }

  /**
   * Gesänge des Spiels setzen (aus dem Match-Setup – keine weiteren Datenbankabfragen).
   * Hochgeladene Gesänge der Vereine werden weiter verwendet (Heim- und Auswärtsspiel);
   * dazu – bzw. für KI-Vereine ausschließlich – echte Stadionaufnahmen aus der Bibliothek.
   */
  setChants(home: ChantRef[], away: ChantRef[], _clubs: { home?: string | null; away?: string | null } = {}) {
    this.uploads = { home: regularChants(home), away: regularChants(away) };
    this.homeGoal = goalHymns(home); this.awayGoal = goalHymns(away);
    // Dateien vorab zwischenspeichern (einmal laden/dekodieren)
    for (const c of [...this.uploads.home, ...this.uploads.away, ...this.homeGoal, ...this.awayGoal]) void mixer.load(this.url(c.path!));
    this.ready = loadCrowdLibrary(this.manifest).then((lib) => { mixer.setLibrary(lib); });
  }

  private warm: ReturnType<typeof setInterval> | null = null;
  /** vor dem Anpfiff (Einlauf): Stadionrauschen läuft bereits, Vorfreude-Pegel */
  warmup() {
    if (this.warm || this.started) return;
    mixer.setCrowd(0.55, 0.2);
    this.warm = setInterval(() => {
      if (this.started || this.finished || !mixer.active) { if (this.warm) clearInterval(this.warm); this.warm = null; return; }
      mixer.setCrowd(0.55, 0.2);
    }, 1000);
  }

  begin() { if (this.warm) { clearInterval(this.warm); this.warm = null; } this.started = true; this.finished = false; this.wait = { home: 1.5 + Math.random() * 2.5, away: 5 + Math.random() * 6 }; }

  /** aktuelle Spielsituation (für Anzeige/Tests) */
  get situation(): Situation { return this.sit; }

  /**
   * Je Frame: vergangene Zeit (s) und sichtbarer Spielzustand.
   * Heim- und Gästefans reagieren getrennt (eigene Spuren), Übergänge laufen weich über die Hüllkurve.
   */
  frame(dt: number, play: PlayState | number) {
    if (!this.started || this.finished || !mixer.active) return;
    this.t += dt;
    const ps: PlayState = typeof play === 'number'
      ? { possession: play > 0.1 ? 'home' : play < 0.1 ? 'away' : null, toGoal: (1 - play) * 65, inBox: play >= 1, forward: 0, minute: 0, homeScore: 0, awayScore: 0 }
      : play;
    const prev = this.sit;
    this.sit = situationOf(ps);
    const lv = this.envelope.update(dt, targetsOf(this.sit, ps));
    // Spielstand: führende Fans etwas lauter, zurückliegende etwas gedämpfter
    const diff = Math.max(-3, Math.min(3, ps.homeScore - ps.awayScore));
    mixer.setCrowd(Math.min(1, lv.home * (1 + 0.04 * diff)), Math.min(1, lv.away * (1 - 0.04 * diff)));
    if (performance.now() < this.goalUntil || this.envelope.busy) return;
    // Anfeuerung beim Übergang in einen Angriff (geschichtet über den laufenden Gesang)
    for (const side of ['home', 'away'] as const) {
      const now = this.sit.startsWith(side) && (this.sit.endsWith('attack') || this.sit.endsWith('box'));
      const before = prev.startsWith(side) && (prev.endsWith('attack') || prev.endsWith('box'));
      if (now && !before && this.t - this.lastAttack[side] > 9 && Math.random() < (side === 'home' ? 0.6 : 0.35)) {
        this.lastAttack[side] = this.t;
        void mixer.reaction('attack', side, { maxSec: 6, cooldownMs: 6000, volume: side === 'home' ? 0.9 : 0.8 });
      }
    }
    // Klatschen: nach längerem eigenem Ballbesitz bzw. in der knappen Schlussphase
    // (Ball in der Luft = kein Ballführer: zählt nicht als Ballverlust)
    if (ps.possession && ps.possession !== this.possSince.side) this.possSince = { side: ps.possession, t: this.t };
    for (const side of ['home', 'away'] as const) {
      const ownPossessionSec = this.possSince.side === side ? this.t - this.possSince.t : 0;
      // Gästeblock klatscht seltener (längere Sperrzeit)
      const since = (this.t - this.lastClap[side]) * (side === 'away' ? 0.5 : 1);
      if (clapTrigger({ sit: this.sit, side, ownPossessionSec, corner: false, sinceLastClap: since })) this.clap(side);
    }
    // Fangesänge nur, wenn der Verein dieser Seite eigene MP3 hochgeladen hat (KI ohne Upload: keine Gesänge)
    for (const side of ['home', 'away'] as const) {
      if (this.cur[side] || !this.uploads[side].length) continue;
      this.wait[side] -= dt;
      if (this.wait[side] > 0) continue;
      this.wait[side] = 1;
      // Gesangswahrscheinlichkeit steigt bei Ballbesitz und Angriffen der eigenen Mannschaft; Heimfans dominieren
      if (Math.random() < chantRate(side, this.sit)) this.sing(side);
    }
  }

  /** Gesang = ausschließlich hochgeladene MP3 des Vereins dieser Seite (zufällig, nicht derselbe wie zuletzt) */
  private sing(side: Side) {
    const ref = pickNext(this.uploads[side], this.lastUpload[side]);
    if (!ref) return;
    this.lastUpload[side] = ref.id;
    const placeholder: Track = { stop: () => undefined, ended: Promise.resolve(), url: '' }; // Platzhalter während des Ladens
    this.cur[side] = placeholder;
    const p = mixer.play(this.url(ref.path!), { channel: side, volume: ref.volume, maxSec: 40, fadeIn: 1.4, fadeOut: 2, id: ref.id, category: 'upload' });
    void p.then((t) => {
      if (this.cur[side] !== placeholder) { t?.stop(0.3); return; }
      if (!t) { this.cur[side] = null; this.wait[side] = nextPause(0.3); return; }
      if (this.finished || performance.now() < this.goalUntil) { t.stop(0.5); this.cur[side] = null; return; }
      this.cur[side] = t;
      void t.ended.then(() => {
        if (this.cur[side] !== t) return;
        this.cur[side] = null;
        // natürliche Pause; in ruhigen Phasen länger, Gäste seltener
        const own = this.sit.startsWith(side);
        this.wait[side] = nextPause(own ? 0.6 : 0.1) * (side === 'away' ? 1.8 : 1) * (this.sit === 'calm' || this.sit === 'harmless' ? 1.5 : 1);
      });
    });
  }

  /** Klatschen (Aufnahme) auf der Ereignisspur */
  private clap(side: Side) {
    this.lastClap[side] = this.t;
    void mixer.reaction('clap', side, { maxSec: 9, cooldownMs: 20000, volume: side === 'home' ? 0.9 : 0.7 });
  }

  private silence(side: Side, fade: number) {
    this.cur[side]?.stop(fade);
    this.cur[side] = null;
  }

  /** sichtbares Spielereignis */
  event(e: Ev, ctx: { homeScore: number; awayScore: number; minute: number; ballOutsideNet: boolean }) {
    if (!mixer.active) return;
    if (['goal', 'miss', 'corner', 'foul', 'offside', 'penalty', 'kickoff'].includes(e.type)) this.lastWhistleEvent = performance.now();
    const home = e.side === 'home';
    const big = (e.xg ?? 0) > 0.12;
    switch (e.type) {
      case 'kickoff':
        mixer.whistle('long');
        // Wiederanstoß nach einem Tor: intensiver Jubel endet vollständig, normale Kulisse kehrt zurück
        if (e.side) this.endGoal();
        break;
      case 'halftime': mixer.whistle('half'); break;
      case 'fulltime': this.finish(); break;
      case 'goal': this.goal(e.side ?? 'home'); break;
      case 'woodwork': mixer.woodwork(); this.chance(e.side, true); break;
      case 'chance': this.chance(e.side, true); break;
      case 'save': if (big) this.chance(e.side, false); break;
      case 'miss': if (ctx.ballOutsideNet) mixer.net(true); if (big) this.missed(e.side); mixer.whistle('soft'); break;
      case 'foul':
        mixer.whistle('short');
        // Pfiffe der Heimfans gegen den Gegner; Gästeblock pfeift seltener und leiser
        if (e.side === 'away') void mixer.reaction('whistle', 'home', { maxSec: 5, cooldownMs: 8000 });
        else if (Math.random() < 0.4) void mixer.reaction('whistle', 'away', { maxSec: 4, cooldownMs: 10000, volume: 0.7 });
        break;
      case 'offside': mixer.whistle('short'); break;
      case 'corner': mixer.whistle('soft'); if (e.side && this.t - this.lastClap[e.side] >= 25) this.clap(e.side); break;
      case 'penalty': mixer.whistle('short'); this.envelope.event(home ? 'home_miss' : 'away_miss', 0.01); break;
      case 'yellow': case 'second_yellow': case 'red': if (e.side !== 'away') void mixer.reaction('whistle', 'home', { maxSec: 5, cooldownMs: 8000 }); break;
      default: break;
    }
  }

  /** Großchance vorbei: enttäuschtes Raunen der Fans des angreifenden Teams */
  private missed(side: Side | null) {
    if (side === 'home') { void mixer.reaction('concede', 'home', { maxSec: 3.5, cooldownMs: 2500, volume: 0.7 }); this.envelope.event('home_miss', 2); }
    else if (side === 'away') { void mixer.reaction('concede', 'away', { maxSec: 3, cooldownMs: 2500, volume: 0.6 }); this.envelope.event('away_miss'); }
  }

  /** Großchance vergeben: Aufschrei der Fans des angreifenden Teams (Gäste leiser) */
  private chance(side: Side | null, envelope: boolean) {
    if (side === 'home') { void mixer.reaction('chance', 'home', { maxSec: 4, cooldownMs: 2500 }); this.envelope.event('home_miss', envelope ? undefined : 2); }
    else if (side === 'away') { void mixer.reaction('chance', 'away', { maxSec: 3.5, cooldownMs: 2500, volume: 0.8 }); this.envelope.event('away_miss'); }
  }

  /** Tor: laufenden Gesang ausblenden, Netz, Jubel, Torhymne des Vereins; danach zurück zur Playlist */
  private goalHymn: Track | null = null;

  /**
   * Tor: sofort intensiver Jubel (Heimtor) bzw. Verstummen der Heimfans und Jubel im Gästeblock (Auswärtstor).
   * Die Torhymne des Vereins setzt direkt ein. Alles endet mit dem Wiederanstoß (≈ 4–5 s später).
   */
  private goal(side: 'home' | 'away') {
    mixer.net(false);
    this.silence('home', 0.4);
    this.silence('away', 0.4);
    this.goalHymn?.stop(0.3);
    this.goalHymn = null;
    this.goalUntil = performance.now() + 7000; // Sicherung, falls kein Wiederanstoß kommt (Schlusspfiff)
    this.envelope.event(side === 'home' ? 'home_goal' : 'away_goal', 7);
    // Aufnahmen: Heimtor = Kurve explodiert; Auswärtstor = Gästeblock kurz sehr laut, Heimfans enttäuscht
    mixer.goal(side);
    const hymn = pickNext(side === 'home' ? this.homeGoal : this.awayGoal, null);
    if (!hymn) return;
    const gen = mixer.generation;
    void mixer.play(this.url(hymn.path!), { channel: 'anthem', volume: hymn.volume * (side === 'home' ? 1 : 0.4 * mixer.awayLevel), pan: side === 'home' ? -0.2 : 0.75, maxSec: 7, fadeIn: 0.3 }).then((t) => {
      if (!t) return;
      // Wiederanstoß bereits erfolgt oder Seite verlassen: nicht nachträglich starten
      if (this.finished || gen !== mixer.generation || performance.now() > this.goalUntil) { t.stop(0.2); return; }
      this.goalHymn = t;
    });
  }

  /** Wiederanstoß: Jubel, Torhymne und Ereignis-Hüllkurve sofort weich beenden */
  private endGoal() {
    mixer.endCelebration(0.6);
    this.goalHymn?.stop(0.6);
    this.goalHymn = null;
    this.envelope.release();
    this.goalUntil = performance.now() + 1500;
    this.wait = { home: 1.5 + Math.random() * 2, away: 4 + Math.random() * 4 };
  }

  private lastWhistleEvent = 0;
  /** Ballkontakt (Pass/Schuss) – aus der sichtbaren Ballart */
  kick(kind: 'pass' | 'shot') { if (this.started && !this.finished) mixer.kick(kind); }
  /** Ball verlässt das Spielfeld: dezenter Pfiff, aber nicht direkt nach Tor/Fehlschuss (dort pfeift es bereits) */
  outOfPlay() {
    if (!this.started || this.finished) return;
    const now = performance.now();
    if (now < this.goalUntil || now - this.lastWhistleEvent < 2500) return;
    this.lastWhistleEvent = now;
    mixer.whistle('soft');
  }

  /** Abpfiff: Schlusspfiff, Applaus, danach alles sanft ausblenden */
  finish() {
    if (this.finished) return;
    this.finished = true;
    mixer.whistle('final');
    this.silence('home', 1.5);
    this.silence('away', 1.5);
    this.envelope.event('home_miss', 3);
    const gen = mixer.generation;
    setTimeout(() => mixer.shutdown(2.5, gen), 4500);
  }

  stop(fade = 0.6) { this.finished = true; this.silence('home', fade); this.silence('away', fade); mixer.shutdown(fade); }
}
