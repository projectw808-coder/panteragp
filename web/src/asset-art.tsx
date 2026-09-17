/**
 * A drawing for each crypto asset, in the same voice as the pot art.
 *
 * Marks rather than brand logos, and deliberately so. A logo belongs to somebody: shipping
 * Tether's or Circle's would be using their trademark to dress our own product, and pulling
 * them from a CDN would put a third party in the page and break the day a URL rots. These
 * are our own line art, they take their colour from the text around them so one set works
 * on both themes, and the asset code is already on the tile — the drawing identifies, it
 * does not have to spell.
 *
 * Keyed by currency code, with a fallback, so an asset added to the database later shows a
 * plain coin rather than an empty square.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** The coin every mark sits on, so the set reads as one family. */
const coin = <circle cx="22" cy="22" r="15" {...stroke} />;

const ART: Record<string, React.ReactNode> = {
  // The bitcoin B: two bowls, and the strokes through the top and bottom.
  BTC: (
    <>
      {coin}
      <path d="M18 14v16" {...stroke} />
      <path d="M22 11.5v2.5M22 30v2.5M26 11.5v2.5M26 30v2.5" {...stroke} opacity="0.55" />
      <path d="M18 14h8.5a4 4 0 0 1 0 8H18" {...stroke} />
      <path d="M18 22h9.5a4 4 0 0 1 0 8H18" {...stroke} />
    </>
  ),
  // The octahedron, seen edge on: two faces above, two below.
  ETH: (
    <>
      <path d="M22 6 11 22l11 6.5L33 22 22 6Z" {...stroke} />
      <path d="m11 25 11 13 11-13" {...stroke} opacity="0.55" />
    </>
  ),
  // A dollar on a coin — the stablecoin idea, drawn once.
  USDC: (
    <>
      {coin}
      <path d="M22 13v18" {...stroke} />
      <path d="M26.5 17.5A4 4 0 0 0 22.5 15h-1a3.5 3.5 0 0 0 0 7h1a3.5 3.5 0 0 1 0 7h-1a4 4 0 0 1-4-2.5" {...stroke} />
    </>
  ),
  // The same idea on a hexagon, so the two stablecoins are told apart at a glance.
  USDT: (
    <>
      <path d="M22 7 35 14.5v15L22 37 9 29.5v-15L22 7Z" {...stroke} />
      <path d="M15 17h14" {...stroke} />
      <path d="M22 17v13" {...stroke} />
      <ellipse cx="22" cy="21" rx="7" ry="2.6" {...stroke} opacity="0.55" />
    </>
  ),
  // Three bars, each sheared the way the ledger's mark is.
  SOL: (
    <>
      <path d="M13 15h16l-4 4H9l4-4Z" {...stroke} />
      <path d="M13 22h16l-4 4H9l4-4Z" {...stroke} opacity="0.75" />
      <path d="M13 29h16l-4 4H9l4-4Z" {...stroke} opacity="0.55" />
    </>
  ),
  // Two arms crossing through a ring.
  XRP: (
    <>
      {coin}
      <path d="M14 15c3 0 4 5 8 5s5-5 8-5" {...stroke} />
      <path d="M14 29c3 0 4-5 8-5s5 5 8 5" {...stroke} />
    </>
  ),
  // A coin with a bar through it: a note, folded.
  LTC: (
    <>
      {coin}
      <path d="M21 12v18h9" {...stroke} />
      <path d="M16 23.5 27 20" {...stroke} opacity="0.7" />
    </>
  ),
  // A square on its corner, with the four that orbit it.
  BNB: (
    <>
      <path d="M22 16.5 27.5 22 22 27.5 16.5 22 22 16.5Z" {...stroke} />
      <path d="M22 6.5 27 11.5 22 16.5 17 11.5 22 6.5Z" {...stroke} opacity="0.7" />
      <path d="M22 27.5 27 32.5 22 37.5 17 32.5 22 27.5Z" {...stroke} opacity="0.7" />
      <path d="M11.5 17 16.5 22 11.5 27 6.5 22 11.5 17Z" {...stroke} opacity="0.7" />
      <path d="M32.5 17 37.5 22 32.5 27 27.5 22 32.5 17Z" {...stroke} opacity="0.7" />
    </>
  ),
};

/** A plain coin, for an asset with no drawing of its own yet. */
const FALLBACK = (
  <>
    {coin}
    <circle cx="22" cy="22" r="8" {...stroke} opacity="0.45" />
  </>
);

export function AssetArt({ code, size = 44 }: { code: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" aria-hidden>
      {ART[code.toUpperCase()] ?? FALLBACK}
    </svg>
  );
}
