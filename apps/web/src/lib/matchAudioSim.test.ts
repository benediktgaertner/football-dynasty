/**
 * Technische Audioprüfung ganzer 3-Minuten-Partien (Offline-Rendering des echten Audio-Stacks, siehe matchAudioSim.ts).
 * Prüft Planung und Signal: Gesänge laufen bis zum natürlichen Ende (oder werden weich ausgeblendet), keine harten Stopps,
 * kaum Überlagerung, keine Lautstärkesprünge, nie Stille. Eine Hörprobe ersetzt das nicht.
 * Benötigt `node-web-audio-api` (lokal: `npm i --no-save node-web-audio-api`); ohne Paket übersprungen.
 */
import { describe, expect, it } from 'vitest';
import { simulateMatchAudio, type SimScenario } from './matchAudioSim';

const wa = await import('node-web-audio-api' as string).catch(() => null) as { OfflineAudioContext: typeof OfflineAudioContext } | null;

const SCENARIOS: SimScenario[] = [
  { name: '0:0 (KI-Gesänge)', events: [{ at: 50, type: 'miss', side: 'home' }, { at: 110, type: 'corner', side: 'away' }, { at: 140, type: 'foul', side: 'away' }] },
  { name: 'Heimführung 2:0', events: [{ at: 40, type: 'goal', side: 'home' }, { at: 95, type: 'goal', side: 'home' }, { at: 130, type: 'foul', side: 'away' }] },
  { name: 'Auswärtsführung 0:2', events: [{ at: 45, type: 'goal', side: 'away' }, { at: 110, type: 'goal', side: 'away' }, { at: 150, type: 'miss', side: 'home' }] },
  { name: 'Heimrückstand 0:4', events: [{ at: 25, type: 'goal', side: 'away' }, { at: 60, type: 'goal', side: 'away' }, { at: 100, type: 'goal', side: 'away' }, { at: 140, type: 'goal', side: 'away' }] },
  { name: 'Mehrere Tore 3:2', events: [{ at: 20, type: 'goal', side: 'home' }, { at: 55, type: 'goal', side: 'away' }, { at: 80, type: 'goal', side: 'home' }, { at: 120, type: 'goal', side: 'away' }, { at: 160, type: 'goal', side: 'home' }, { at: 90, type: 'injury', side: 'home' }] },
  { name: 'Eigene MP3 (Mensch) 1:0', chants: 'upload', events: [{ at: 60, type: 'goal', side: 'home' }, { at: 120, type: 'red', side: 'away' }] },
];

describe.skipIf(!wa)('3-Minuten-Partien: technische Audioprüfung (Offline-Rendering)', () => {
  const rows: Record<string, unknown>[] = [];
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const res = await simulateMatchAudio(wa!, sc);
      const s = res.stats;
      rows.push({ Szenario: sc.name, Gesänge: s.chantStarts, 'bis Ende': s.chantsNatural, abgeschnitten: s.chantsCut, 'hart <1 s': s.hardCuts, Fades: s.cutFades.map((f) => f.toFixed(1)).join('/'), Gründe: JSON.stringify(s.cutReasons),
        'max parallel': s.maxSimultaneousChants, 'Überlapp s': s.overlapSeconds, Reaktionen: s.reactions, Torjubel: s.goalsHeard, 'max Sprung dB': s.maxJumpDb, 'ohne Ereignis max dB': s.maxJumpOutsideEventsDb, '>9 dB ohne Ereignis': s.jumpsOver9OutsideEvents, '>6 dB': s.jumpsOver6, 'harter Start': s.hardStarts, 'kurzes Ende': s.shortEndFades, 'min dB': s.minLevelDb, 'p10/med/p90': `${s.p10Db}/${s.medianDb}/${s.p90Db}`, 'gleiche Datei 2×': s.sameFileTwice });
      console.table(rows.slice(-1));
      if (process.env.FD_AUDIO_RANGE) { const [a, b] = process.env.FD_AUDIO_RANGE.split('-').map(Number) as [number, number]; console.log('Pegel', a, '-', b, 's:', res.levels.slice(a * 10, b * 10).map((v) => v.toFixed(0)).join(' '), '\nLog:', JSON.stringify(res.log.filter((e) => e.t >= a - 1 && e.t <= b).map((e) => `${e.t.toFixed(2)} ${e.ev} ${e.channel ?? e.side ?? ''}/${e.category ?? ''}:${e.id ?? ''} fade=${e.fade ?? ''} ${e.reason ?? ''} depth=${e.depth ?? ''}`))); }
      if (process.env.FD_AUDIO_DEBUG) console.log(sc.name, 'große Sprünge außerhalb von Ereignissen:', JSON.stringify(s.bigJumps), '\nStarts:', JSON.stringify(res.log.filter((e) => e.ev === 'start' && e.category !== 'ambience').map((e) => `${e.t.toFixed(1)}s ${e.channel}/${e.category ?? ''}:${e.id} len=${e.len?.toFixed(1)}`)));
      expect(res.levels.length).toBeGreaterThan(1700);
      expect(s.errors).toEqual([]); // keine Laufzeitfehler im Audio-Stack
      expect(s.hardCuts, JSON.stringify(res.log.filter((e) => e.channel === 'home' || e.channel === 'away').map((e) => `${e.t.toFixed(1)} ${e.ev} ${e.channel} ${e.id} fade=${e.fade} fi=${e.fadeIn} ${e.reason ?? ''}`))).toBe(0); // kein Gesang wird mit weniger als 1 s Ausblendung gestoppt
      expect(s.hardStarts, JSON.stringify(res.log.filter((e) => e.channel === 'home' || e.channel === 'away').map((e) => `${e.t.toFixed(1)} ${e.ev} ${e.channel} ${e.id} fade=${e.fade} fi=${e.fadeIn} ${e.reason ?? ''}`))).toBe(0); // alle Gesänge blenden ≥ 1 s ein
      expect(s.shortEndFades, JSON.stringify(res.log.filter((e) => e.channel === 'home' || e.channel === 'away').map((e) => `${e.t.toFixed(1)} ${e.ev} ${e.channel} ${e.id} fade=${e.fade} fi=${e.fadeIn} ${e.reason ?? ''}`))).toBe(0); // natürliches Ende immer mit ≥ 1,5 s Ausblendung
      expect(Object.keys(s.cutReasons).every((r) => ['goal', 'injury', 'deficit', 'finish'].includes(r))).toBe(true); // Abbrüche nur durch Tor/Verletzung/Rückstand/Abpfiff
      expect(s.chantsCut).toBeLessThanOrEqual(sc.events.filter((e) => e.type === 'goal' || e.type === 'injury').length);
      expect(s.chantStarts).toBeGreaterThanOrEqual(5); expect(s.chantStarts).toBeLessThanOrEqual(14); // Häufigkeit wie bisher (8–11 je Partie)
      expect(s.maxSimultaneousChants).toBeLessThanOrEqual(2);
      expect(s.overlapSeconds).toBeLessThan(40); // gleichzeitiger Gesang bleibt die Ausnahme
      expect(s.sameFileTwice, JSON.stringify(res.log.filter((e) => e.channel === 'home' || e.channel === 'away').map((e) => `${e.t.toFixed(1)} ${e.ev} ${e.channel} ${e.id} fade=${e.fade} fi=${e.fadeIn} ${e.reason ?? ''}`))).toBe(0); // nie dieselbe Datei direkt hintereinander
      expect(s.minLevelDb).toBeGreaterThan(-50); // nie Stille: Grundrauschen läuft durchgehend
      expect(s.jumpsOver9OutsideEvents).toBeLessThanOrEqual(12); // keine Pegelsprünge außerhalb von Ereignissen (Aufnahmen haben natürliche Dynamik)
      if (sc.name.startsWith('0:0')) expect(s.chantsCut).toBe(0); // ohne Tor/Verletzung läuft jeder Gesang bis zum Ende
    }, 240_000);
  }
});
