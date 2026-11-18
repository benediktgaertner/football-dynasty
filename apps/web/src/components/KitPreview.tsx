import { readableTextColor, type KitConfig } from '@fd/shared';
import { useId } from 'react';

/** B2.7: Trikotvorschau plus Spielerkreis, wie er in der 2D-Match-Engine erscheint (F2). */
export function KitPreview({ kit, number = 10, size = 140 }: { kit: KitConfig; number?: number; size?: number }) {
  const id = useId().replace(/:/g, '');
  const pattern = (() => {
    switch (kit.pattern) {
      case 'solid':
        return null;
      case 'stripes':
        return [28, 44, 60, 76].map((x) => <rect key={x} x={x} y="0" width="8" height="120" fill={kit.secondary} />);
      case 'hoops':
        return [34, 54, 74, 94].map((y) => <rect key={y} x="0" y={y} width="120" height="9" fill={kit.secondary} />);
      case 'halves':
        return <rect x="60" y="0" width="60" height="120" fill={kit.secondary} />;
      case 'sash':
        return <polygon points="20,10 40,10 104,110 84,110" fill={kit.secondary} />;
    }
  })();
  const shirt = 'M38 10 L22 16 L4 34 L18 50 L28 42 L28 110 L92 110 L92 42 L102 50 L116 34 L98 16 L82 10 C78 20 70 24 60 24 C50 24 42 20 38 10 Z';
  const numberColor = readableTextColor(kit.primary);
  return (
    <div className="flex items-end gap-6">
      <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label="Trikotvorschau">
        <defs>
          <clipPath id={`shirt-${id}`}>
            <path d={shirt} />
          </clipPath>
        </defs>
        <g clipPath={`url(#shirt-${id})`}>
          <rect width="120" height="120" fill={kit.primary} />
          {pattern}
        </g>
        <path d={shirt} fill="none" stroke="#15170f" strokeWidth="2" strokeLinejoin="round" />
        <text x="60" y="80" textAnchor="middle" fontSize="34" fontWeight="900" fontFamily="Barlow Condensed, sans-serif" fill={numberColor} stroke={kit.primary} strokeWidth="1" paintOrder="stroke">
          {number}
        </text>
      </svg>
      <div className="flex flex-col items-center gap-1">
        <svg viewBox="0 0 40 40" width={size / 3} height={size / 3} aria-label="Spielerkreis in der Match Engine">
          <circle cx="20" cy="20" r="17" fill={kit.primary} stroke={kit.secondary} strokeWidth="3" />
          <text x="20" y="26" textAnchor="middle" fontSize="16" fontWeight="800" fontFamily="Barlow Condensed, sans-serif" fill={numberColor}>
            {number}
          </text>
        </svg>
        <span className="text-xs text-cream-dim">auf dem Feld</span>
      </div>
    </div>
  );
}
