import { renderCrestSvg, type CrestConfig } from '@fd/shared';
import { useId, useMemo } from 'react';

/**
 * B3: Wappen-Darstellung. Das SVG wird ausschließlich aus der validierten Konfiguration
 * erzeugt (renderCrestSvg prüft jedes Feld mit zod und escaped Text). Ungültige
 * Konfigurationen werden nicht gerendert.
 */
export function Crest({ crest, size = 64, className = '' }: { crest: CrestConfig; size?: number; className?: string }) {
  const id = useId();
  const svg = useMemo(() => {
    try {
      return renderCrestSvg(crest, id.replace(/:/g, ''));
    } catch {
      return null;
    }
  }, [crest, id]);
  if (!svg) {
    return <div style={{ width: size, height: size * 1.2 }} className={`rounded-lg bg-olive-700 ${className}`} aria-label="Ungültiges Wappen" />;
  }
  return <div style={{ width: size, height: size * 1.2 }} className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
