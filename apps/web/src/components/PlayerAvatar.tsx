import { NATIONALITIES, renderPlayerAvatarSvg, type Region } from '@fd/shared';
import { memo, useMemo } from 'react';

const REGION_BY_NAT = new Map<string, Region>(NATIONALITIES.map((n) => [n.code, n.region]));

/**
 * Gezeichnetes Spielerporträt (keine Fotos realer Personen). Deterministisch aus der
 * Spieler-ID; Trikotfarbe = aktueller Verein bzw. neutral im Draft-Pool.
 */
export const PlayerAvatar = memo(function PlayerAvatar({
  id,
  nationality,
  age,
  size = 36,
  shirt,
  collar,
  className = '',
}: {
  id: string;
  nationality: string;
  age: number;
  size?: number;
  shirt?: string;
  collar?: string;
  className?: string;
}) {
  const svg = useMemo(
    () => renderPlayerAvatarSvg({ seed: id, region: REGION_BY_NAT.get(nationality) ?? 'europe', age, shirt, collar }),
    [id, nationality, age, shirt, collar],
  );
  return (
    <div
      className={`shrink-0 overflow-hidden rounded-full ring-1 ring-olive-600 ${className}`}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
