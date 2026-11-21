import { countryOptions, type StartTier } from '@fd/shared';
import { useMemo } from 'react';

/**
 * Welterstellung: Land (alle 55 UEFA-Verbände) und Startliga (1.–3. Liga).
 * Das Land stellt drei Ligen à 18 Vereine mit Auf- und Abstieg und einen nationalen Pokal;
 * alle anderen Länder existieren nur als Erstligen für Transfermarkt und Europapokal.
 */
export function CountryPicker({ country, tier, onChange, disabled }: {
  country: string;
  tier: StartTier;
  onChange: (country: string, tier: StartTier) => void;
  disabled?: boolean;
}) {
  const options = useMemo(() => countryOptions(), []);
  const sel = options.find((o) => o.code === country) ?? options[0]!;
  const level = sel.strength >= 85 ? 'Spitzenliga' : sel.strength >= 60 ? 'starke Liga' : sel.strength >= 40 ? 'mittlere Liga' : 'kleine Liga';
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="display mb-1 block text-sm font-semibold uppercase tracking-wider text-cream-dim">Land</span>
        <select
          className="min-h-11 w-full rounded-xl border border-olive-600 bg-anthracite px-3 text-cream disabled:opacity-60"
          value={country}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value, tier)}
        >
          {options.map((o) => (
            <option key={o.code} value={o.code}>{o.name} · {o.leagues[1]}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-cream-dim">Landesstärke {sel.strength}/100 ({level}) – bestimmt Spielstärke, Gehälter, Prämien und Einnahmen.</span>
      </label>
      <div>
        <span className="display mb-1 block text-sm font-semibold uppercase tracking-wider text-cream-dim">Startliga</span>
        <div className="grid grid-cols-3 gap-2">
          {([1, 2, 3] as const).map((t) => (
            <button
              key={t}
              type="button"
              disabled={disabled}
              onClick={() => onChange(country, t)}
              className={`min-h-11 rounded-xl border px-2 py-2 text-center transition ${tier === t ? 'border-gold bg-gold/10 text-cream' : 'border-olive-600 text-cream-dim'} ${disabled ? 'cursor-default' : 'hover:border-gold/70'}`}
            >
              <div className="display text-base font-bold uppercase">{t}. Liga</div>
              <div className="truncate text-xs">{sel.leagues[t]}</div>
            </button>
          ))}
        </div>
        <span className="mt-1 block text-xs text-cream-dim">Alle Manager starten gemeinsam in dieser Liga. Pokal: {sel.leagues.cup}.</span>
      </div>
    </div>
  );
}
