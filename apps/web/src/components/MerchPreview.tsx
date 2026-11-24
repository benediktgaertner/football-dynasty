import { readableTextColor, renderCrestSvg, type CrestConfig } from '@fd/shared';
import { useId, useMemo, type ReactElement } from 'react';
import { PRODUCT_FAMILY, type MerchDesign } from '../lib/merchDesign';

const SHIRT = 'M38 10 L22 16 L4 34 L18 50 L28 42 L28 110 L92 110 L92 42 L102 50 L116 34 L98 16 L82 10 C78 20 70 24 60 24 C50 24 42 20 38 10 Z';
const OUT = '#15170f';

/** Live-Vorschau eines Fanartikels (Trikot, Schal, Kappe, Fahne) – reines SVG, nur aus dem geprüften Design erzeugt. */
export function MerchPreview({ product, design, crest, size = 120, label }: { product: string; design: MerchDesign; crest?: CrestConfig | null; size?: number; label?: string }) {
  const id = useId().replace(/:/g, '');
  const fam = PRODUCT_FAMILY[product] ?? 'jersey';
  const crestUri = useMemo(() => {
    if (!crest || !design.crest) return null;
    try { return `data:image/svg+xml;utf8,${encodeURIComponent(renderCrestSvg(crest, `m${id}`))}`; } catch { return null; }
  }, [crest, design.crest, id]);
  const { c1, c2, c3, pattern, text } = design;
  const printColor = readableTextColor(fam === 'flag' ? c1 : c1);
  const crestImg = (x: number, y: number, w: number) => (crestUri ? <image href={crestUri} x={x} y={y} width={w} height={w * 1.2} preserveAspectRatio="xMidYMid meet" /> : null);

  let body: ReactElement;
  if (fam === 'jersey') {
    const stripes = (n: number, w: number, start: number, gap: number) => Array.from({ length: n }, (_, i) => <rect key={i} x={start + i * gap} y="0" width={w} height="120" fill={c2} />);
    const pat = (() => {
      switch (pattern) {
        case 'stripes': return stripes(4, 8, 28, 16);
        case 'hoops': return [34, 54, 74, 94].map((y) => <rect key={y} x="0" y={y} width="120" height="9" fill={c2} />);
        case 'halves': return <rect x="60" y="0" width="60" height="120" fill={c2} />;
        case 'quarters': return <><rect x="60" y="0" width="60" height="60" fill={c2} /><rect x="0" y="60" width="60" height="60" fill={c2} /></>;
        case 'sash': return <polygon points="20,10 40,10 104,110 84,110" fill={c2} />;
        case 'chevron': return [0, 14, 28].map((o) => <polyline key={o} points={`28,${48 + o} 60,${70 + o} 92,${48 + o}`} fill="none" stroke={c2} strokeWidth="7" />);
        case 'pinstripe': return Array.from({ length: 14 }, (_, i) => <rect key={i} x={26 + i * 5} y="0" width="1.6" height="120" fill={c2} />);
        case 'diagonal': return <polygon points="0,60 0,100 60,0 100,0" fill={c2} />;
        default: return null;
      }
    })();
    body = (
      <>
        <defs><clipPath id={`s${id}`}><path d={SHIRT} /></clipPath></defs>
        <g clipPath={`url(#s${id})`}>
          <rect width="120" height="120" fill={c1} />
          {pat}
          <path d="M38 10 C42 20 50 24 60 24 C70 24 78 20 82 10 L76 9 C74 15 68 18 60 18 C52 18 46 15 44 9 Z" fill={c3} />
          <rect x="4" y="30" width="16" height="6" fill={c3} transform="rotate(-38 12 34)" opacity="0.9" />
          <rect x="100" y="30" width="16" height="6" fill={c3} transform="rotate(38 108 34)" opacity="0.9" />
        </g>
        <path d={SHIRT} fill="none" stroke={OUT} strokeWidth="2" strokeLinejoin="round" />
        {crestImg(74, 34, 15)}
        {text && <text x="60" y="88" textAnchor="middle" fontSize="12" fontWeight="800" fontFamily="Barlow Condensed, sans-serif" fill={readableTextColor(c1)}>{text}</text>}
      </>
    );
  } else if (fam === 'scarf') {
    const pat = (() => {
      switch (pattern) {
        case 'stripes': return Array.from({ length: 9 }, (_, i) => <rect key={i} x={8 + i * 12.4} y="38" width="6.2" height="44" fill={c2} />);
        case 'bands': return <><rect x="8" y="38" width="16" height="44" fill={c2} /><rect x="96" y="38" width="16" height="44" fill={c2} /><rect x="26" y="38" width="5" height="44" fill={c3} /><rect x="89" y="38" width="5" height="44" fill={c3} /></>;
        case 'checker': return Array.from({ length: 24 }, (_, i) => ((i % 12) + Math.floor(i / 12)) % 2 === 0 ? <rect key={i} x={8 + (i % 12) * 8.67} y={38 + Math.floor(i / 12) * 22} width="8.67" height="22" fill={c2} /> : null);
        case 'bar': return <rect x="8" y="53" width="104" height="14" fill={c2} />;
        default: return null;
      }
    })();
    body = (
      <>
        <rect x="8" y="38" width="104" height="44" fill={c1} />
        {pat}
        <rect x="8" y="38" width="104" height="44" fill="none" stroke={c3} strokeWidth="2.5" />
        {Array.from({ length: 12 }, (_, i) => <line key={`l${i}`} x1={11 + i * 8.7} y1="82" x2={11 + i * 8.7} y2="92" stroke={c3} strokeWidth="2" strokeLinecap="round" />)}
        {Array.from({ length: 12 }, (_, i) => <line key={`r${i}`} x1={11 + i * 8.7} y1="28" x2={11 + i * 8.7} y2="38" stroke={c3} strokeWidth="2" strokeLinecap="round" />)}
        <rect x="8" y="38" width="104" height="44" fill="none" stroke={OUT} strokeWidth="1.5" />
        {text && <text x="60" y="66" textAnchor="middle" fontSize="15" fontWeight="900" fontFamily="Barlow Condensed, sans-serif" fill={readableTextColor(pattern === 'bar' ? c2 : c1)} stroke={pattern === 'bar' ? c2 : c1} strokeWidth="0.5" paintOrder="stroke">{text}</text>}
        {crestImg(50, 46, 20)}
      </>
    );
  } else if (fam === 'cap') {
    const dome = 'M16 74 C16 28 104 28 104 74 Z';
    const pat = (() => {
      switch (pattern) {
        case 'panels': return [38, 60, 82].map((x) => <path key={x} d={`M${x} 34 C${x - 6} 50 ${x - 6} 62 ${x - 4} 74`} fill="none" stroke={c2} strokeWidth="2.5" />);
        case 'stripe': return <rect x="54" y="26" width="12" height="50" fill={c2} />;
        case 'twotone': return <rect x="60" y="26" width="46" height="50" fill={c2} />;
        default: return null;
      }
    })();
    body = (
      <>
        <defs><clipPath id={`c${id}`}><path d={dome} /></clipPath></defs>
        <g clipPath={`url(#c${id})`}><rect x="10" y="20" width="100" height="60" fill={c1} />{pat}</g>
        <path d={dome} fill="none" stroke={OUT} strokeWidth="2" />
        <path d="M14 74 L104 74 L114 80 C108 88 50 90 14 82 Z" fill={pattern === 'bill' ? c2 : c1} stroke={OUT} strokeWidth="2" strokeLinejoin="round" />
        <rect x="14" y="72" width="90" height="4" fill={c3} />
        <circle cx="60" cy="27" r="3" fill={c3} stroke={OUT} strokeWidth="1" />
        {crestImg(44, 40, 24)}
        {text && <text x="60" y="108" textAnchor="middle" fontSize="12" fontWeight="800" fontFamily="Barlow Condensed, sans-serif" fill="#e8e6da">{text}</text>}
      </>
    );
  } else {
    const pat = (() => {
      switch (pattern) {
        case 'horizontal': return <><rect x="22" y="24" width="88" height="20" fill={c1} /><rect x="22" y="44" width="88" height="20" fill={c2} /><rect x="22" y="64" width="88" height="20" fill={c3} /></>;
        case 'vertical': return <><rect x="22" y="24" width="30" height="60" fill={c1} /><rect x="52" y="24" width="30" height="60" fill={c2} /><rect x="82" y="24" width="28" height="60" fill={c3} /></>;
        case 'diagonal': return <><rect x="22" y="24" width="88" height="60" fill={c1} /><polygon points="22,84 110,84 110,24" fill={c2} /></>;
        case 'cross': return <><rect x="22" y="24" width="88" height="60" fill={c1} /><rect x="22" y="48" width="88" height="12" fill={c2} /><rect x="56" y="24" width="12" height="60" fill={c2} /></>;
        case 'border': return <><rect x="22" y="24" width="88" height="60" fill={c2} /><rect x="29" y="31" width="74" height="46" fill={c1} /></>;
        default: return <rect x="22" y="24" width="88" height="60" fill={c1} />;
      }
    })();
    body = (
      <>
        <rect x="12" y="14" width="4" height="100" rx="2" fill="#8a8f98" stroke={OUT} strokeWidth="1" />
        <circle cx="14" cy="13" r="4" fill={c3} stroke={OUT} strokeWidth="1" />
        {pat}
        <rect x="22" y="24" width="88" height="60" fill="none" stroke={OUT} strokeWidth="1.5" />
        {crestImg(54, 34, 22)}
        {text && <text x="66" y="80" textAnchor="middle" fontSize="11" fontWeight="800" fontFamily="Barlow Condensed, sans-serif" fill={printColor} stroke={c1} strokeWidth="0.4" paintOrder="stroke">{text}</text>}
      </>
    );
  }
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={label ?? 'Fanartikel-Vorschau'} data-testid={`merch-preview-${product}`} data-pattern={design.pattern} data-c1={design.c1}>
      {body}
    </svg>
  );
}
