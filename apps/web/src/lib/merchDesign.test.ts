import { describe, expect, it } from 'vitest';
import { MERCH_PATTERNS, PRODUCT_FAMILY, defaultDesign, effectiveDesign, validMerchDesign } from './merchDesign';

const club = { primary: '#c8102e', secondary: '#ffffff', accent: '#f2c14e', kitPattern: 'hoops' };

describe('Fanartikel-Designs', () => {
  it('jedes Produkt hat ein gültiges Standarddesign in Vereinsfarben', () => {
    for (const [product, fam] of Object.entries(PRODUCT_FAMILY)) {
      const d = defaultDesign(product, club);
      expect(validMerchDesign(fam, d), product).toBe(true);
    }
    expect(defaultDesign('home_jersey', club)).toMatchObject({ pattern: 'hoops', c1: '#c8102e', c2: '#ffffff' });
    expect(defaultDesign('away_jersey', club)).toMatchObject({ c1: '#ffffff', c2: '#c8102e' });
  });
  it('jede Produktfamilie bietet mehrere Muster', () => {
    for (const fam of ['jersey', 'scarf', 'cap', 'flag'] as const) expect(MERCH_PATTERNS[fam].length).toBeGreaterThanOrEqual(5);
  });
  it('Validierung lehnt fremde Muster, Farben und Texte ab (wie die Datenbank)', () => {
    expect(validMerchDesign('scarf', { pattern: 'hoops' })).toBe(false);
    expect(validMerchDesign('jersey', { pattern: 'hoops', c1: '#123456' })).toBe(true);
    expect(validMerchDesign('jersey', { c1: 'rot' })).toBe(false);
    expect(validMerchDesign('cap', { text: '<script>' })).toBe(false);
    expect(validMerchDesign('cap', { text: 'FC DEMO 1' })).toBe(true);
    expect(validMerchDesign('cap', { text: 'A'.repeat(17) })).toBe(false);
    expect(validMerchDesign('flag', { pattern: 'cross', extra: 1 } as never)).toBe(false);
  });
  it('gespeichertes Design wird mit dem Standard aufgefüllt, Ungültiges fällt zurück', () => {
    const d = effectiveDesign('scarf', { pattern: 'checker', c1: 'kaputt' } as never, club);
    expect(d.pattern).toBe('checker');
    expect(d.c1).toBe('#c8102e');
    expect(effectiveDesign('scarf', null, club).pattern).toBe('stripes');
  });
});
