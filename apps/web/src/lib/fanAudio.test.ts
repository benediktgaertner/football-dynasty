import { describe, expect, it } from 'vitest';
import { goalHymns, nextPause, pickNext, regularChants, type ChantRef } from './fanAudio';
import { loudnessGain } from './audioMixer';

const c = (id: string, extra: Partial<ChantRef> = {}): ChantRef => ({ id, name: id, source: 'upload', path: `w/c/${id}.mp3`, volume: 0.8, situation: null, ...extra });

describe('Fangesang-Playlist', () => {
  const all = [c('a'), c('b', { situation: 'attack' }), c('sig', { signature: true }), c('tor', { situation: 'goal' }), c('kaputt', { path: null })];
  it('reguläre Gesänge ohne Signatur-Gesang und Torhymne', () => {
    expect(regularChants(all).map((x) => x.id)).toEqual(['a', 'b']);
    expect(goalHymns(all).map((x) => x.id)).toEqual(['tor']);
  });
  it('keine direkte Wiederholung, wenn Alternativen existieren', () => {
    const list = regularChants(all);
    for (let i = 0; i < 50; i++) expect(pickNext(list, 'a', Math.random)!.id).toBe('b');
    expect(pickNext([c('x')], 'x')!.id).toBe('x');
    expect(pickNext([], null)).toBeNull();
  });
  it('alle Gesänge kommen dran (zufällig, abwechslungsreich)', () => {
    const list = [c('a'), c('b'), c('c'), c('d')];
    const seen = new Set<string>(); let last: string | null = null;
    for (let i = 0; i < 200; i++) { const n: ChantRef = pickNext(list, last)!; expect(n.id).not.toBe(last); last = n.id; seen.add(n.id); }
    expect(seen.size).toBe(4);
  });
  it('Pausen 3–8 s, in Druckphasen kürzer', () => {
    expect(nextPause(0, () => 0)).toBeCloseTo(3); expect(nextPause(0, () => 1)).toBeCloseTo(8);
    expect(nextPause(1, () => 1)).toBeLessThan(nextPause(0, () => 1));
    for (let i = 0; i < 100; i++) { const p = nextPause(Math.random()); expect(p).toBeGreaterThanOrEqual(1.9); expect(p).toBeLessThanOrEqual(8); }
  });
});

describe('Lautheitsangleich', () => {
  const buf = (amp: number) => ({ numberOfChannels: 1, length: 48000, getChannelData: () => Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10) * amp) }) as unknown as AudioBuffer;
  it('leise Aufnahmen lauter, laute leiser, begrenzt', () => {
    expect(loudnessGain(buf(0.05))).toBeGreaterThan(1);
    expect(loudnessGain(buf(0.9))).toBeLessThan(1);
    expect(loudnessGain(buf(0.001))).toBeLessThanOrEqual(4);
    // vergleichbare Lautheit: RMS × Verstärkung ähnlich
    const r = (a: number) => (a / Math.SQRT2) * loudnessGain(buf(a));
    expect(Math.abs(r(0.1) - r(0.6))).toBeLessThan(0.02);
  });
});
