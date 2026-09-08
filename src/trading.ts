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
