/**
 * What a client pays to trade.
 *
 * Two dials, both in basis points, both set per client by the desk and shown to the client:
 *
 *   commission — charged on the notional of every fill, whichever way it goes
 *   spread     — moves the executed price against the client, buying higher and selling lower
 *
 * They are deliberately the only levers of this kind. Neither is aware of whether a trade
 * is winning, both cost the client the same on the way in and the way out, and no value of
 * either can turn a loss into a profit. What they change is the cost of trading, which is a
 * term of an account and is disclosed like one.
 */

const BPS = 10_000;

/** Nothing is charged until the desk says otherwise, so existing accounts do not change. */
export const DEFAULT_COMMISSION_BPS = 0;
export const DEFAULT_SPREAD_BPS = 0;

/** The ceiling the column also enforces: 500 bps is 5%. */
export const MAX_BPS = 500;

export type Terms = { commission_bps: number; spread_bps: number };

export const termsOf = (row: { commission_bps?: number | null; spread_bps?: number | null } | null): Terms => ({
  commission_bps: Number(row?.commission_bps ?? DEFAULT_COMMISSION_BPS),
  spread_bps: Number(row?.spread_bps ?? DEFAULT_SPREAD_BPS),
});

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

/**
 * The price this client actually gets.
 *
 * A buyer pays above the market and a seller receives below it, which is what a spread is.
 * The direction is fixed by the side, not by anything about the position — so widening it
 * always costs the client and can never pay them.
 */
export function executionPrice(mid: number, side: 'buy' | 'sell', terms: Terms): number {
  const markup = mid * (terms.spread_bps / BPS);
  return round8(side === 'buy' ? mid + markup : mid - markup);
}

/**
 * Commission on one fill, as a positive amount to take off the balance.
 *
 * On notional rather than on profit: a commission that grew with a client's gains would be
 * a share of their result rather than a price for the service, and it would give the number
 * an opinion about the outcome. This one does not have one.
 */
export function commission(qty: number, price: number, terms: Terms): number {
  return round8(Math.abs(qty) * Math.abs(price) * (terms.commission_bps / BPS));
}
