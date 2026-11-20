/**
 * Stadionsound: Vereinshymnen und Fangesänge ausschließlich als hochgeladene MP3 (Supabase Storage),
 * abgespielt im Browser (kein Streaming über den Match-Server). Dazu eine leise Zuschauerkulisse.
 */
export const SITUATIONS: Array<{ key: string; label: string }> = [
  { key: '', label: 'Keine (Bibliothek)' }, { key: 'attack', label: 'Angriff' }, { key: 'goal', label: 'Tor' }, { key: 'behind', label: 'Rückstand' },
  { key: 'lead', label: 'Führung' }, { key: 'derby', label: 'Derby/Topspiel' },
];

export interface PlayHandle { stop: () => void; duration: number; startedAt: number; error?: string }

export class StadiumSound {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crowd: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private active = new Set<() => void>();
  enabled = false;

  /** Muss aus einer Nutzeraktion heraus aufgerufen werden (Autoplay-Regeln der Browser) */
  async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 2;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const ch = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.enabled = this.ctx.state === 'running';
      return this.enabled;
    } catch { this.enabled = false; return false; }
  }

  stopAll(): void { for (const s of [...this.active]) s(); this.active.clear(); }

  /** Grundrauschen der Zuschauer (0…1, steigt bei Toren) */
  crowdLevel(level: number): void {
    if (!this.ctx || !this.master || !this.noise || !this.enabled) return;
    if (!this.crowd) {
      const src = this.ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
      const filter = this.ctx.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 700; filter.Q.value = 0.6;
      const gain = this.ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master); src.start();
      this.crowd = { src, gain, filter };
    }
    const now = this.ctx.currentTime;
    this.crowd.gain.gain.cancelScheduledValues(now);
    this.crowd.gain.gain.setTargetAtTime(0.04 + 0.2 * Math.max(0, Math.min(1, level)), now, 0.4);
    this.crowd.filter.frequency.setTargetAtTime(600 + 900 * level, now, 0.4);
  }

  /** MP3 abspielen, nach maxSec sanft ausblenden */
  playUrl(url: string, volume = 0.85, maxSec = 30, onError?: (msg: string) => void): PlayHandle {
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = Math.max(0, Math.min(1, volume));
    let done = false;
    const stop = () => { if (done) return; done = true; audio.pause(); this.active.delete(stop); };
    this.active.add(stop);
    audio.addEventListener('error', () => { onError?.('Die MP3-Datei konnte nicht geladen werden (gelöscht oder kein Netz).'); stop(); });
    void audio.play().catch((e: Error) => onError?.(e.name === 'NotAllowedError' ? 'Der Browser blockiert die Wiedergabe – tippe einmal auf „Ton an“.' : e.name === 'NotSupportedError' ? 'Die MP3-Datei wurde nicht gefunden oder ist beschädigt.' : `Wiedergabe fehlgeschlagen: ${e.message}`));
    const timer = setTimeout(() => {
      const v0 = audio.volume; let k = 0;
      const fade = setInterval(() => { k++; audio.volume = Math.max(0, v0 * (1 - k / 10)); if (k >= 10) { clearInterval(fade); stop(); } }, 80);
    }, maxSec * 1000);
    audio.addEventListener('ended', () => { clearTimeout(timer); stop(); });
    return { stop: () => { clearTimeout(timer); stop(); }, duration: maxSec, startedAt: performance.now() };
  }
}

/** Gemeinsame Instanz (ein AudioContext je Seite) */
export const stadiumSound = new StadiumSound();

const SKIP_KEY = 'fd-walkout-skip';
const SOUND_KEY = 'fd-sound';
export const prefs = {
  get alwaysSkip(): boolean { try { return localStorage.getItem(SKIP_KEY) === '1'; } catch { return false; } },
  set alwaysSkip(v: boolean) { try { localStorage.setItem(SKIP_KEY, v ? '1' : '0'); } catch { /* privat */ } },
  get sound(): boolean { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; } },
  set sound(v: boolean) { try { localStorage.setItem(SOUND_KEY, v ? '1' : '0'); } catch { /* privat */ } },
};
