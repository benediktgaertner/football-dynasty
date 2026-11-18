import { describe, expect, it } from 'vitest';
import { renderPlayerAvatarSvg } from '../src/index.js';

describe('Spielerporträts', () => {
  it('sind deterministisch je Spieler und unterscheiden sich zwischen Spielern', () => {
    const a = renderPlayerAvatarSvg({ seed: 'spieler-1', region: 'europe', age: 25 });
    expect(renderPlayerAvatarSvg({ seed: 'spieler-1', region: 'europe', age: 25 })).toBe(a);
    const others = new Set(Array.from({ length: 50 }, (_, i) => renderPlayerAvatarSvg({ seed: `s${i}`, region: 'europe', age: 25 })));
    expect(others.size).toBe(50);
  });
  it('übernehmen gültige Vereinsfarben und ignorieren ungültige', () => {
    expect(renderPlayerAvatarSvg({ seed: 'x', region: 'asia', age: 22, shirt: '#C0392B' })).toContain('#C0392B');
    const evil = renderPlayerAvatarSvg({ seed: 'x', region: 'asia', age: 22, shirt: 'red"/><script>alert(1)</script>' });
    expect(evil).not.toMatch(/<script|alert/);
  });
  it('erzeugen bei älteren Spielern häufiger graue Haare', () => {
    const grey = (age: number) =>
      Array.from({ length: 300 }, (_, i) => renderPlayerAvatarSvg({ seed: `g${i}`, region: 'europe', age })).filter((s) => /#8E8A84|#6F6A64/.test(s)).length;
    expect(grey(22)).toBe(0);
    expect(grey(34)).toBeGreaterThan(80);
  });
  it('sind gültiges, eigenständiges SVG für alle Regionen', () => {
    for (const region of ['europe', 'south_america', 'africa', 'asia', 'north_central_america', 'oceania'] as const) {
      const svg = renderPlayerAvatarSvg({ seed: region, region, age: 28 });
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
    }
  });
});
