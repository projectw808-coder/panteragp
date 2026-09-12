/**
 * Number formatting for the signal log, kept apart from the component so the edge cases can
 * be checked. All three had a bug on screen before they were written down.
 */

/**
 * A price at two decimals, unless two decimals would call it nothing.
 *
 * Plenty of these instruments trade below a cent — BONKUSD sits near $0.00002 — and
 * rounding that to "0.00" states a price of zero, which is a different and untrue claim.
 * Below a dollar the figure switches to significant digits, so the number on screen is the
 * number the strategy used.
 */
export const price = (n: number): string => n >= 1
  ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : n.toLocaleString(undefined, { maximumSignificantDigits: 4 });

/**
 * A result, with its sign taken from the rounded figure rather than the raw one.
 *
 * Two things went wrong here at once. A result of -0.004 rounds to -0.00 and Number() hands
 * back negative zero — for which `n >= 0` is true in JavaScript — so it took the positive
 * branch and printed a minus straight after the plus: "+-0.00", which is what reached the
 * screen. And a result that rounds away is not zero: printing 0.00 tells the reader nothing
 * happened when something did. Deciding on the rounded value fixes the first; naming the
 * remainder fixes the second.
 */
export const result = (n: number): string => {
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return n === 0 ? '0.00' : n > 0 ? '+<0.01' : '−<0.01';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}`;
};

/**
 * Colour follows the real sign, not the rounded one: a gain too small to print is still a
 * gain. Negative zero satisfies neither comparison and lands on neutral, which is right —
 * it is the absence of a result, not a loss.
 */
export const tone = (n: number): string =>
  n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-slate-ink';
