import { describe, expect, it } from 'vitest';
import { clearMarketState, loadMarketState, saveMarketState } from './marketState';

function mem() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; }

describe('Transfermarkt: Ansicht merken', () => {
  it('speichert und lädt Filter, Seite, Reiter und Scrollposition je Welt', () => {
    const s = mem();
    saveMarketState('w1', { tab: 'free', filters: { position: 'ST', minAge: '18', search: 'müller' }, page: 3, scrollY: 640 }, s);
    expect(loadMarketState('w1', s)).toEqual({ tab: 'free', filters: { position: 'ST', minAge: '18', search: 'müller' }, page: 3, scrollY: 640 });
    expect(loadMarketState('w2', s)).toBeNull();
  });
  it('Zurücksetzen löscht die Ansicht', () => {
    const s = mem();
    saveMarketState('w1', { tab: 'market', filters: {}, page: 1, scrollY: 10 }, s);
    clearMarketState('w1', s);
    expect(loadMarketState('w1', s)).toBeNull();
  });
  it('defekte oder fremde Daten werden ignoriert', () => {
    expect(loadMarketState('w1', { getItem: () => '{kaputt' })).toBeNull();
    expect(loadMarketState('w1', { getItem: () => '{"x":1}' })).toBeNull();
    expect(loadMarketState('w1', undefined)).toBeNull();
  });
});
