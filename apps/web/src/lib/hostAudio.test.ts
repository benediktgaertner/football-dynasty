import { describe, expect, it } from 'vitest';
import { buildLibrary } from './crowdLibrary';
import { hostChantPool, hostCrowdFiles, mergeHostLibrary, type HostAudioFile } from './fanAudio';
import { DISAPPROVAL, HomeDisapproval } from './homeDisapproval';

const f = (id: string, category: HostAudioFile['category'], duration: number): HostAudioFile => ({ id, category, name: `${id}.mp3`, url: `https://x.supabase.co/storage/v1/object/sign/world-audio/w/${category}/${id}.mp3?token=t`, duration });

describe('KI-Audiodateien des Liga-Hosts im Stadion-Audio', () => {
  it('Pfiffe: jede Datei als kurzer Pfiff, ab 6 s zusätzlich als Pfeifkonzert; Torjubel als goal', () => {
    const c = hostCrowdFiles([f('b1', 'boo', 3.2), f('b2', 'boo', 12), f('g1', 'goal', 7), f('c1', 'chant', 20)]);
    expect(c.filter((x) => x.category === 'pfiff').map((x) => x.id)).toEqual(['b1:kurz', 'b2:kurz']);
    expect(c.filter((x) => x.category === 'pfeifkonzert').map((x) => x.id)).toEqual(['b2:lang']);
    expect(c.filter((x) => x.category === 'goal').map((x) => x.id)).toEqual(['g1']);
    expect(c.some((x) => x.id.startsWith('c1'))).toBe(false); // Gesänge nicht in der Reaktionsbibliothek
  });
  it('Host-Kategorien ersetzen feste Aufnahmen gleicher Kategorie; Stadionrauschen bleibt', () => {
    const base = buildLibrary('/audio/crowd/', [
      { id: 'amb', category: 'ambience', file: 'ambience/a.mp3', duration: 60 },
      { id: 'oldgoal', category: 'goal', file: 'goal/x.mp3', duration: 6 },
    ]);
    const m = mergeHostLibrary(base, [f('g1', 'goal', 7), f('b1', 'boo', 9)]);
    expect(m.byCategory.get('ambience')?.map((x) => x.id)).toEqual(['amb']);
    expect(m.byCategory.get('goal')?.map((x) => x.id)).toEqual(['g1']);
    expect(m.byCategory.get('pfeifkonzert')?.length).toBe(1);
    // ohne Host-Dateien: nur die Grundatmosphäre
    expect([...mergeHostLibrary(base, []).byCategory.keys()].sort()).toEqual(['ambience', 'goal']);
  });
  it('Fangesangpool: nur chant-Dateien, stabile Reihenfolge (gleiche Auswahl auf allen Geräten)', () => {
    const a = hostChantPool([f('c2', 'chant', 10), f('b1', 'boo', 3), f('c1', 'chant', 12)]);
    const b = hostChantPool([f('c1', 'chant', 12), f('c2', 'chant', 10)]);
    expect(a.map((x) => x.id)).toEqual(['c1', 'c2']);
    expect(b).toEqual(a);
    expect(a.every((x) => x.mood === 'support' && x.url.startsWith('https://'))).toBe(true);
  });
  it('normales Spiel: höchstens ~3 Pfeifreaktionen, mehr nur bei negativem Verlauf oder schweren Entscheidungen', () => {
    const m = new HomeDisapproval(() => 0);
    let plays = 0;
    for (let t = 0; t < 2400; t += 60) if (m.awayFoul({ t, minute: Math.min(90, t / 25), diff: 0 }, false)?.play) plays++;
    expect(plays).toBe(DISAPPROVAL.normalMatch);
    expect(m.penaltyAgainst({ t: 2500, minute: 88, diff: 0 })?.play).toBe(true); // schwere Entscheidung trotzdem
  });
});
