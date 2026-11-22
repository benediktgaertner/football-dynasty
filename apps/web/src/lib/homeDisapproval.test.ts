import { describe, expect, it } from 'vitest';
import { seeded } from './fanMood';
import { DISAPPROVAL, HomeDisapproval, baseDiscontent } from './homeDisapproval';

const ctx = (t: number, minute: number, diff: number) => ({ t, minute, diff });
/** Anteil gespielter Reaktionen über viele unabhängige Läufe */
function rate(setup: (m: HomeDisapproval) => void, fire: (m: HomeDisapproval) => unknown, n = 400): number {
  let hit = 0;
  for (let i = 0; i < n; i++) {
    const m = new HomeDisapproval(seeded(`r${i}`));
    setup(m);
    const d = fire(m) as { play: boolean } | null;
    if (d?.play) hit++;
  }
  return hit / n;
}
/** Unzufriedenheit auf den Spielstand einschwingen lassen */
const settle = (m: HomeDisapproval, minute: number, diff: number) => { for (let t = 0; t < 400; t += 1) m.tick(1, ctx(-1000 + t, minute, diff)); };

describe('Unmut der Heimfans', () => {
  it('einzelner Ballverlust bei 0:0 ⇒ nie Pfiffe', () => {
    expect(rate((m) => settle(m, 20, 0), (m) => m.ballLoss(ctx(100, 20, 0), true))).toBe(0);
  });
  it('Ballverlust bei 0:3 in der 75. Minute ⇒ deutliche Buhrufe möglich (aber nicht immer)', () => {
    const r = rate((m) => settle(m, 75, -3), (m) => m.ballLoss(ctx(100, 75, -3), true));
    expect(r).toBeGreaterThan(0.12);
    expect(r).toBeLessThan(0.6);
  });
  it('hartes Foul des Gegners: Pfiffe auch bei eigener Führung', () => {
    expect(rate((m) => settle(m, 30, 2), (m) => m.awayFoul(ctx(100, 30, 2), true))).toBeGreaterThan(0.75);
  });
  it('normales Einzelfoul selten, Foulserie (3 in 5 min) deutlich häufiger', () => {
    const single = rate(() => undefined, (m) => m.awayFoul(ctx(100, 30, 0), false));
    const series = rate(() => undefined, (m) => { m.awayFoul(ctx(10, 28, 0), false); m.awayFoul(ctx(60, 29, 0), false); return m.awayFoul(ctx(200, 31, 0), false); });
    expect(single).toBeLessThan(0.12);
    expect(series).toBeGreaterThan(0.4);
  });
  it('Elfmeter und Rot gegen Heim fast immer, Gelb gegen Heim oft', () => {
    expect(rate(() => undefined, (m) => m.penaltyAgainst(ctx(100, 50, 0)))).toBeGreaterThan(0.85);
    expect(rate(() => undefined, (m) => m.homeCard(ctx(100, 50, 0), true))).toBeGreaterThan(0.85);
    const y = rate(() => undefined, (m) => m.homeCard(ctx(100, 50, 0), false));
    expect(y).toBeGreaterThan(0.4); expect(y).toBeLessThan(0.7);
  });
  it('normales Gegentor bei knappem Stand ⇒ keine Pfiffe; nach Fehler oder bei 0:3 ⇒ Pfiffe wahrscheinlich', () => {
    expect(rate(() => undefined, (m) => m.conceded(ctx(100, 30, -1), false))).toBe(0);
    expect(rate(() => undefined, (m) => m.conceded(ctx(100, 30, -1), true))).toBeGreaterThan(0.5);
    expect(rate((m) => settle(m, 70, -2), (m) => m.conceded(ctx(100, 70, -3), false))).toBeGreaterThan(0.55);
  });
  it('Gefahr in Serie: Unmut bei Rückstand, bei Führung kaum', () => {
    const run = (diff: number) => rate((m) => settle(m, 60, diff), (m) => { m.awayDangerous(ctx(10, 60, diff)); m.awayDangerous(ctx(50, 60, diff)); return m.awayDangerous(ctx(90, 60, diff)); }, 800);
    expect(run(-1)).toBeGreaterThan(run(2) * 2);
    expect(run(2)).toBeLessThan(0.1);
  });
  it('Cooldown: zwei Ereignisse kurz hintereinander ⇒ höchstens eine Reaktion; Schweres darf nach 6 s', () => {
    const m = new HomeDisapproval(() => 0); // spielt immer, wenn erlaubt
    expect(m.homeCard(ctx(100, 40, 0), false)?.play).toBe(true);
    expect(m.awayFoul(ctx(105, 40, 0), true)?.reason).toBe('cooldown'); // < 6 s
    expect(m.awayFoul(ctx(107, 40, 0), true)?.play).toBe(true); // schwer, ≥ 6 s
    expect(m.offsideHome(ctx(115, 41, 0))?.reason).toBe('cooldown'); // < 14 s
  });
  it('nie Dauerpfeifen: höchstens 5 je 10 Minuten (außer schweren Entscheidungen)', () => {
    const m = new HomeDisapproval(() => 0);
    settle(m, 80, -4);
    let plays = 0;
    for (let t = 0; t < 600; t += 3) {
      const d = m.ballLoss(ctx(t, 80, -4), true) ?? m.tick(3, ctx(t, 80, -4));
      if (d?.play) plays++;
    }
    expect(plays).toBeLessThanOrEqual(DISAPPROVAL.maxPer10Min);
    expect(plays).toBeGreaterThanOrEqual(3);
  });
  it('lange Pfeifkonzerte nur bei anhaltendem Unmut, mit Abstand', () => {
    const m = new HomeDisapproval(() => 0);
    settle(m, 80, -3);
    const a = m.tick(20, ctx(1000, 80, -3));
    expect(a?.play).toBe(true); expect(a?.length).toBe('long');
    const b = m.conceded(ctx(1030, 81, -4), false); // 30 s später: kein zweites langes Konzert
    expect(b?.play).toBe(true); expect(b?.length).toBe('short');
    const q = new HomeDisapproval(() => 0);
    expect(q.offsideHome(ctx(100, 10, 0))?.length).toBe('short'); // kurze Ereignisse ⇒ kurze Pfiffe
  });
  it('Intensität steigt mit Rückstand, Minute und Frust; Grundwert folgt dem Spielstand', () => {
    const a = new HomeDisapproval(() => 0), b = new HomeDisapproval(() => 0);
    settle(b, 80, -3);
    const ia = a.homeCard(ctx(100, 10, 0), false)!.intensity, ib = b.homeCard(ctx(100, 80, -3), false)!.intensity;
    expect(ib).toBeGreaterThan(ia);
    expect(baseDiscontent(0, 80)).toBe(0);
    expect(baseDiscontent(-3, 80)).toBeGreaterThan(baseDiscontent(-3, 20));
  });
  it('Heimtor baut Unmut ab', () => {
    const m = new HomeDisapproval(() => 0.99);
    settle(m, 70, -2);
    const before = m.D; m.homeGoal();
    expect(m.D).toBeLessThan(before - 0.2);
  });
});
