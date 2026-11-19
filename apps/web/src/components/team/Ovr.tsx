/** Dezente Farbcodierung der Gesamtstärke: grün ≥ 75, gelb 65–74, rot < 65 */
export function ovrTone(v: number): string {
  return v >= 75 ? 'border-emerald-400/70 text-emerald-200' : v >= 65 ? 'border-gold/70 text-gold' : 'border-red-400/70 text-red-200';
}

/** Kompakte OVR-Angabe (eckig, umrandet) – für Taktiktafel und Listen */
export function OvrChip({ value, title = 'Gesamtstärke (OVR)' }: { value: number; title?: string }) {
  return (
    <span title={title} aria-label={`${title}: ${value}`}
      className={`display inline-flex h-4 shrink-0 items-center rounded-[3px] border bg-ink/80 px-1 text-[10px] font-bold leading-none tabular-nums ${ovrTone(value)}`}>
      {value}
    </span>
  );
}

/** Aktuelle Matchnote 1,0–10,0 (rund, gefüllt, mit Stern) – klar von der OVR unterscheidbar */
export function RatingChip({ value }: { value: number }) {
  const tone = value >= 7.5 ? 'bg-emerald-400 text-ink' : value >= 6.5 ? 'bg-cream text-ink' : value >= 5.5 ? 'bg-gold text-ink' : 'bg-red-400 text-ink';
  return (
    <span title="Aktuelle Matchnote (1,0–10,0)" aria-label={`Matchnote ${value.toLocaleString('de-DE', { minimumFractionDigits: 1 })}`}
      className={`inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-bold leading-none tabular-nums shadow ${tone}`}>
      ★{value.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
    </span>
  );
}
