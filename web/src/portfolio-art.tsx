/**
 * A drawing for each kind of pot.
 *
 * Line art rather than photographs: these ship inside the bundle, so there is no third
 * party serving them, nothing to license, and nothing that breaks when a URL rots. They
 * take their colour from the text around them, which means one set works on both themes
 * instead of two sets that drift apart.
 *
 * Keyed by the product code, with a fallback, so a type added to the database later shows
 * a plain mark rather than an empty square.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ART: Record<string, React.ReactNode> = {
  // A path climbing towards a sun: time passing, and the point of it.
  retirement: (
    <>
      <circle cx="30" cy="12" r="4.5" {...stroke} />
      <path d="M4 34c6 0 8-6 13-6s6 6 11 6 6-4 8-4" {...stroke} />
      <path d="M4 40h36" {...stroke} opacity="0.4" />
    </>
  ),
  // Coins stacking up.
  savings: (
    <>
      <ellipse cx="22" cy="12" rx="11" ry="4" {...stroke} />
      <path d="M11 12v6c0 2.2 4.9 4 11 4s11-1.8 11-4v-6" {...stroke} />
      <path d="M11 22v6c0 2.2 4.9 4 11 4s11-1.8 11-4v-6" {...stroke} />
      <path d="M11 32v4c0 2.2 4.9 4 11 4s11-1.8 11-4v-4" {...stroke} />
    </>
  ),
  // A mortarboard.
  education: (
    <>
      <path d="M22 9 4 17l18 8 18-8-18-8Z" {...stroke} />
      <path d="M11 21v9c0 2.8 4.9 5 11 5s11-2.2 11-5v-9" {...stroke} />
      <path d="M40 17v10" {...stroke} opacity="0.5" />
    </>
  ),
  // A shield: money kept back for when something goes wrong.
  emergency: (
    <>
      <path d="M22 5 7 11v10c0 8.5 6.3 15.2 15 18 8.7-2.8 15-9.5 15-18V11L22 5Z" {...stroke} />
      <path d="m16 22 5 5 9-10" {...stroke} />
    </>
  ),
  // A house with a door.
  property: (
    <>
      <path d="M6 21 22 8l16 13" {...stroke} />
      <path d="M10 20v17h24V20" {...stroke} />
      <path d="M18 37V26h8v11" {...stroke} />
    </>
  ),
  // Bars of no particular purpose, which is the product.
  general: (
    <>
      <path d="M8 36V24" {...stroke} />
      <path d="M17 36V14" {...stroke} />
      <path d="M26 36V29" {...stroke} />
      <path d="M35 36V19" {...stroke} />
      <path d="M4 40h36" {...stroke} opacity="0.4" />
    </>
  ),
};

const FALLBACK = (
  <>
    <circle cx="22" cy="22" r="15" {...stroke} />
    <path d="M22 15v14M15 22h14" {...stroke} opacity="0.5" />
  </>
);

export function PotArt({ code, size = 44 }: { code: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden>
      {ART[code] ?? FALLBACK}
    </svg>
  );
}
