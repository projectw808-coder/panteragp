// Paper-trading maths. Pure functions, no database — the engine in server.ts calls these
// inside a transaction. Everything here is demo-only; there is no live code path.
// ponytail: plain floats, rounded to 8dp on write. Real money needs integer minor units.

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';

export type Position = { qty: number; avg_price: number };   // qty is signed; negative is short
export type Fill = { side: Side; qty: number; price: number };

export const round8 = (n: number) => Number(n.toFixed(8));

/**
 * Apply a fill to a position, returning the new position and any realised P&L.
 * Adding to a position averages the entry; reducing one realises P&L on the part
 * closed; crossing through zero does both and re-opens at the fill price.
 */
export function applyFill(pos: Position | null, f: Fill): { position: Position; realized: number } {
  const signed = f.side === 'buy' ? f.qty : -f.qty;
  const cur = pos?.qty ?? 0;
  const avg = pos?.avg_price ?? 0;

  if (cur === 0) return { position: { qty: signed, avg_price: f.price }, realized: 0 };

  if (Math.sign(cur) === Math.sign(signed)) {
    const size = Math.abs(cur) + Math.abs(signed);
    return {
      position: { qty: round8(cur + signed), avg_price: round8((avg * Math.abs(cur) + f.price * Math.abs(signed)) / size) },
      realized: 0,
    };
  }

  const closed = Math.min(Math.abs(cur), Math.abs(signed));
  const realized = round8((f.price - avg) * closed * Math.sign(cur));
  const remaining = round8(cur + signed);
  if (remaining === 0) return { position: { qty: 0, avg_price: 0 }, realized };
  // Crossed through zero: what is left is a new position opened at this fill's price.
  const flipped = Math.sign(remaining) !== Math.sign(cur);
  return { position: { qty: remaining, avg_price: flipped ? f.price : avg }, realized };
}

/** Unrealised P&L of an open position at the current price. */
export const unrealized = (pos: Position, price: number) => round8((price - pos.avg_price) * pos.qty);

export type Triggerable = {
  side: Side; type: OrderType;
  limit_price: number | null; stop_price: number | null;
};

/** Would this working order fill at `price`? */
export function isTriggered(o: Triggerable, price: number): boolean {
  const buy = o.side === 'buy';
  switch (o.type) {
    case 'market':
      return true;
    case 'limit':
      return o.limit_price !== null && (buy ? price <= o.limit_price : price >= o.limit_price);
    case 'stop':
    case 'trailing_stop':
      return o.stop_price !== null && (buy ? price >= o.stop_price : price <= o.stop_price);
    case 'stop_limit':
      // ponytail: fills only when the stop is breached AND the limit is still satisfied.
      // A real book would leave a resting limit order behind after the stop triggers.
      return o.stop_price !== null && o.limit_price !== null
        && (buy ? price >= o.stop_price && price <= o.limit_price
                : price <= o.stop_price && price >= o.limit_price);
  }
}

/**
 * Ratchet a trailing stop in the profitable direction only. Returns the new stop, or
 * null when it should not move.
 */
export function trailStop(
  o: { side: Side; stop_price: number | null; trail_amount: number | null }, price: number,
): number | null {
  if (o.trail_amount === null) return null;
  // A sell stop protects a long: it follows the price up and never comes back down.
  const candidate = o.side === 'sell' ? price - o.trail_amount : price + o.trail_amount;
  if (o.stop_price === null) return round8(candidate);
  const better = o.side === 'sell' ? candidate > o.stop_price : candidate < o.stop_price;
  return better ? round8(candidate) : null;
}

/**
 * The most decimal places a double can actually floor. Above this, n * 10**decimals
 * passes Number.MAX_SAFE_INTEGER (9.007e15) and Math.floor becomes a no-op that can even
 * round *up* — so ETH's declared 18 decimals is truncated here to 15. That is the same
 * float limitation already flagged at the top of this file, made explicit rather than
 * silently breaking the guarantee below.
 */
export const MAX_FLOOR_DECIMALS = 15;

/** Round down to `decimals` places. Never rounds up: see convert(). */
export function floorTo(n: number, decimals: number): number {
  const f = 10 ** Math.min(decimals, MAX_FLOOR_DECIMALS);
  // The *(1+ε) nudges values a hair under an exact multiple back onto it, so 0.1+0.2 at
  // 2dp gives 0.30 rather than 0.29.
  return Math.floor(n * f * (1 + Number.EPSILON)) / f;
}

/**
 * Exchange `amount` of one currency for another, both priced in USD.
 *
 * The credited amount is rounded *down* to the destination's minor unit: rounding up
 * would hand out a fraction the rate did not earn, and across many conversions that is
 * money created from nothing. The dust is reported so the caller can show it rather than
 * quietly lose it.
 *
 * Returns null when either side has no price, or when the whole amount would round away
 * to nothing — debiting a balance and crediting zero is never the right answer.
 */
export function convert(
  { amount, fromUsd, toUsd, decimals }:
  { amount: number; fromUsd: number | null; toUsd: number | null; decimals: number },
): { received: number; rate: number; dustUsd: number } | null {
  if (!(amount > 0) || !fromUsd || !toUsd || fromUsd <= 0 || toUsd <= 0) return null;
  const rate = fromUsd / toUsd;
  const exact = amount * rate;
  const received = floorTo(exact, decimals);
  if (received <= 0) return null;
  return { received, rate, dustUsd: round8((exact - received) * toUsd) };
}

/**
 * What a pot would be worth after `years` at `annualRate`, compounded annually, if
 * `monthly` is also paid in at the end of each month.
 *
 * This is a projection for display, not a promise and not an accrual: nothing in this
 * system pays interest into a portfolio. Returns null without a rate, so the caller shows
 * nothing rather than implying growth that will not happen.
 */
export function project(
  { balance, annualRate, years, monthly = 0 }:
  { balance: number; annualRate: number | null; years: number; monthly?: number },
): number | null {
  if (annualRate === null || !(years > 0)) return null;
  const months = Math.round(years * 12);
  const monthlyRate = (1 + annualRate) ** (1 / 12) - 1;
  let value = balance;
  for (let m = 0; m < months; m++) value = value * (1 + monthlyRate) + monthly;
  return round8(value);
}

/** Days per year used to turn a headline annual rate into a daily one. */
export const DAYS_PER_YEAR = 365;

/**
 * Interest earned over `days` at `annualRate`, compounded daily.
 *
 * The daily rate is the 365th root of the annual one, not annualRate/365, so a full year
 * of daily compounding lands back on the headline rate instead of overshooting it — the
 * same convention project() uses monthly, so the projection and the accrual agree.
 *
 * Returns the interest only, not the new balance, and never rounds to a minor unit: a
 * penny a day on a small pot would floor to zero every day and never grow at all. The
 * fraction stays in the balance (numeric(38,18)) and the display rounds.
 * ponytail: 365-day year, so leap days pay a fraction less. Use an actual/actual day
 * count if that ever has to tie out against a real product.
 */
export function accrue(
  { balance, annualRate, days }: { balance: number; annualRate: number | null; days: number },
): number {
  if (annualRate === null || annualRate === 0 || !(days > 0) || !(balance > 0)) return 0;
  const daily = (1 + annualRate) ** (1 / DAYS_PER_YEAR) - 1;
  return round8(balance * ((1 + daily) ** days - 1));
}

/** How far a pot is towards its target, capped at 1. Null when there is no target. */
export function progress(balance: number, target: number | null): number | null {
  if (!target || target <= 0) return null;
  return Math.min(1, round8(balance / target));
}

/**
 * Position sizing: how many units risk `riskPct` of `balance` if the stop is hit.
 * Leverage caps the notional the account can carry, it does not change the risk.
 */
export function positionSize(
  { balance, riskPct, entry, stop, leverage = 1 }:
  { balance: number; riskPct: number; entry: number; stop: number; leverage?: number },
): number {
  const perUnit = Math.abs(entry - stop);
  if (!(perUnit > 0) || !(balance > 0) || !(riskPct > 0)) return 0;
  const byRisk = (balance * riskPct / 100) / perUnit;
  const byMargin = (balance * leverage) / entry;
  return round8(Math.min(byRisk, byMargin));
}
