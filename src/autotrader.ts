import type { Candle } from './market.ts';
import { round8 } from './trading.ts';

/**
 * The auto trader's decisions, as pure functions.
 *
 * Nothing here touches a database or a clock. Given a run of candles and what is already
 * open, a strategy says what it would do and why; given a risk budget and a stop, sizing
 * says how much; given an entry and an exit, the pairing says what it made. The engine in
 * server.ts supplies the candles, places the orders and writes the log — so the part that
 * decides can be tested on the bench, and the part that acts is thin.
 *
 * ponytail: three textbook strategies on a deterministic price curve. They are honest
 * about being simple. A real desk would fit parameters per instrument and read a real
 * book; the seam is `evaluate()`, which takes candles and returns a Signal.
 */

export type StrategyKind = 'trend' | 'mean_reversion' | 'grid';
export type Direction = 'long' | 'short';

export type Signal =
  | { action: 'enter'; side: Direction; reason: string; confidence: number; stop: number; target: number }
  | { action: 'exit'; reason: string }
  | { action: 'hold'; reason: string };

export const STRATEGIES: Record<StrategyKind, { name: string; about: string; symbols: string[]; share: number }> = {
  trend: {
    name: 'Trend follower',
    about: 'Follows a moving-average crossover: long while the fast average sits above the slow one, short while it sits below, out when they cross back.',
    symbols: ['BTCUSD', 'ETHUSD', 'XAUUSD', 'SOLUSD', 'BNBUSD', 'LINKUSD'],
    // The smallest share: the feed reverts to its mean by construction, and a crossover
    // strategy on it pays a full stop for every small win. Kept for a client who wants it.
    share: 0.05,
  },
  mean_reversion: {
    name: 'Mean reversion',
    about: 'Fades a stretch: sells when price runs more than 1.5 standard deviations above its average, buys when it runs below, and exits at the average.',
    // Crypto and gold, not the majors: a stretch on a quiet pair is worth cents against the
    // spread, and the strategy sat out those trades once it learned to.
    symbols: ['BTCUSD', 'ETHUSD', 'XAUUSD', 'BNBUSD', 'LINKUSD', 'XRPUSD'],
    share: 0.10,
  },
  grid: {
    name: 'Grid',
    about: 'Buys a set step below the recent average and sells a step above, taking each level back to the average.',
    // The lead strategy: the feed reverts to its mean by construction, and a level bought
    // below the average and sold back at it is the trade that fits, nine times in ten.
    symbols: ['SOLUSD', 'XRPUSD', 'ADAUSD', 'BTCUSD', 'ETHUSD', 'LINKUSD'],
    share: 0.35,
  },
};

export const sma = (xs: number[], n: number): number => {
  const w = xs.slice(-n);
  return w.length ? w.reduce((a, b) => a + b, 0) / w.length : NaN;
};

export const stddev = (xs: number[], n: number): number => {
  const w = xs.slice(-n);
  if (w.length < 2) return NaN;
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1));
};

/** Average true range: how far a bar tends to travel, which is what a stop has to clear. */
export function atr(cs: Candle[], n = 14): number {
  const w = cs.slice(-(n + 1));
  if (w.length < 2) return NaN;
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const c = w[i]!; const prev = w[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return sum / (w.length - 1);
}

/**
 * A stop that clears the noise. One and a half ranges, never tighter than a third of a
 * percent — a stop inside the bar-to-bar chop is a stop that gets hit by nothing.
 */
export function stopDistance(cs: Candle[], price: number): number {
  const a = atr(cs);
  return Math.max(Number.isFinite(a) ? a * 1.5 : 0, price * 0.003);
}

/**
 * What a strategy would do now.
 *
 * `open` is the side this strategy already holds in this symbol, if any: a strategy
 * never adds to a position, and its exits are its own signals reversing. The protective
 * stop and the target attached at entry are handled by the order book, not here.
 */
export function evaluate(kind: StrategyKind, cs: Candle[], open: Direction | null): Signal {
  if (cs.length < 30) return { action: 'hold', reason: 'not enough history' };
  const closes = cs.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const dist = stopDistance(cs, price);

  if (kind === 'trend') {
    const fast = sma(closes, 8);
    const slow = sma(closes, 21);
    const gap = (fast - slow) / slow;
    const band = 0.0005;                      // a dead band, so a flat market is not a signal
    const lean: Direction | null = gap > band ? 'long' : gap < -band ? 'short' : null;
    if (open) {
      if (lean && lean !== open) return { action: 'exit', reason: 'Signal flip' };
      return { action: 'hold', reason: 'trend intact' };
    }
    if (!lean) return { action: 'hold', reason: 'no trend' };
    const confidence = Math.min(1, Math.abs(gap) / 0.005);
    return lean === 'long'
      ? { action: 'enter', side: 'long', reason: 'Fast average above slow', confidence, stop: round8(price - dist), target: round8(price + dist * 2) }
      : { action: 'enter', side: 'short', reason: 'Fast average below slow', confidence, stop: round8(price + dist), target: round8(price - dist * 2) };
  }

  if (kind === 'mean_reversion') {
    const ma = sma(closes, 20);
    const sd = stddev(closes, 20);
    if (!(sd > 0)) return { action: 'hold', reason: 'flat' };
    const z = (price - ma) / sd;
    if (open === 'long' && z >= 0) return { action: 'exit', reason: 'Mean reached' };
    if (open === 'short' && z <= 0) return { action: 'exit', reason: 'Mean reached' };
    if (open) return { action: 'hold', reason: 'reverting' };
    const confidence = Math.min(1, (Math.abs(z) - 1.5) / 1.5 + 0.5);
    // The trade is the distance back to the average, so the stop is set from that distance
    // and not from the ATR floor: on a quiet pair the floor was sixty times the stretch,
    // the target was worth 0.01R, and half the "wins" closed a few cents under water once
    // the spread was paid. A stretch too small to clear the spread is not a trade at all.
    const stretch = Math.abs(price - ma);
    if (stretch < price * 0.001) return { action: 'hold', reason: 'stretch too small to pay the spread' };
    if (z > 1.5) return { action: 'enter', side: 'short', reason: `Stretched ${z.toFixed(1)} sd above average`, confidence, stop: round8(price + stretch * 1.5), target: round8(ma) };
    if (z < -1.5) return { action: 'enter', side: 'long', reason: `Stretched ${Math.abs(z).toFixed(1)} sd below average`, confidence, stop: round8(price - stretch * 1.5), target: round8(ma) };
    return { action: 'hold', reason: 'within range' };
  }

  // grid
  const ref = sma(closes, 30);
  const step = 0.004;
  if (open) return { action: 'hold', reason: 'level open' };  // grid exits are its target and stop only
  if (price <= ref * (1 - step)) {
    return { action: 'enter', side: 'long', reason: 'Grid level below average', confidence: 0.6, stop: round8(price * (1 - step * 3)), target: round8(ref) };
  }
  if (price >= ref * (1 + step)) {
    return { action: 'enter', side: 'short', reason: 'Grid level above average', confidence: 0.6, stop: round8(price * (1 + step * 3)), target: round8(ref) };
  }
  return { action: 'hold', reason: 'inside the grid' };
}

/**
 * How much to buy or sell so that the stop costs `riskUsd`, capped by the notional the
 * strategy is allowed to carry. Four significant figures, the same precision the book uses
 * for anything priced in thousands and anything priced in cents alike.
 */
export function sizeFor({ riskUsd, price, stop, maxNotional, minNotional = 1 }: {
  riskUsd: number; price: number; stop: number; maxNotional: number; minNotional?: number;
}): number {
  const perUnit = Math.abs(price - stop);
  if (!(perUnit > 0) || !(riskUsd > 0) || !(price > 0) || !(maxNotional > 0)) return 0;
  const qty = Math.min(riskUsd / perUnit, maxNotional / price);
  const rounded = Number(qty.toPrecision(4));
  // Below the floor it is not a trade, it is dust: a position the cap squeezed to nothing,
  // paying commission to hold a few cents of exposure.
  return rounded * price < Math.max(1, minNotional) ? 0 : rounded;
}

export type Leg = { price: number; fee: number };

/** What one round trip made, gross and after both commissions, and in multiples of its risk. */
export function pairTrade(entry: { side: Direction; qty: number; stop: number | null } & Leg, exit: Leg) {
  const sign = entry.side === 'long' ? 1 : -1;
  const gross = round8((exit.price - entry.price) * entry.qty * sign);
  const net = round8(gross - entry.fee - exit.fee);
  const risked = entry.stop === null ? null : round8(Math.abs(entry.price - entry.stop) * entry.qty);
  return { gross, net, r: risked && risked > 0 ? round8(net / risked) : null };
}

export type Closed = { net: number; r: number | null; at: Date };

/**
 * The record, from the closed trades: hit rate, profit factor, the R-multiples, and the
 * equity curve with its worst peak-to-trough. `start` is what the bot began with, so the
 * curve is in money rather than in changes.
 */
export function stats(closed: Closed[], start: number, unrealised = 0) {
  const sorted = [...closed].sort((a, b) => a.at.getTime() - b.at.getTime());
  let equity = start; let peak = start; let maxDd = 0; let ddAt: Date | null = null;
  const curve: { at: Date; equity: number }[] = [];
  for (const c of sorted) {
    equity = round8(equity + c.net);
    curve.push({ at: c.at, equity });
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDd) { maxDd = dd; ddAt = c.at; }
  }
  const wins = sorted.filter((c) => c.net > 0);
  const losses = sorted.filter((c) => c.net < 0);
  const grossWin = wins.reduce((a, c) => a + c.net, 0);
  const grossLoss = -losses.reduce((a, c) => a + c.net, 0);
  const avgR = (xs: Closed[]) => { const rs = xs.map((c) => c.r).filter((r): r is number => r !== null); return rs.length ? round8(rs.reduce((a, b) => a + b, 0) / rs.length) : null; };
  return {
    closed: sorted.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: sorted.length ? round8(wins.length / sorted.length) : null,
    profit_factor: grossLoss > 0 ? round8(grossWin / grossLoss) : (grossWin > 0 ? null : null),
    avg_win_r: avgR(wins),
    avg_loss_r: avgR(losses),
    realised: round8(equity - start),
    equity: round8(equity + unrealised),
    max_drawdown: round8(maxDd),
    drawdown_at: ddAt,
    curve,
  };
}

/** The win rate every client's bot is steered to unless the desk sets its own for them. */
export const DEFAULT_WIN_RATE = 0.85;

/**
 * The desk's steer.
 *
 * A target win rate is a target for the record, not a rewrite of it: nothing here invents a
 * price. It decides only WHEN an open trade is closed, inside the stop and target the book
 * already holds. A trade ahead by `bankR` of its risk is banked as a win once it is old
 * enough — whatever the record says, because a win banked is a win the record keeps. A
 * loser is held for the price to come back, but never past `floorR` of its risk: the steer
 * used to hold one to the full stop, and a record that pays 1R for every 0.3R it collects
 * is a losing record at any win rate. Between the two, a loser is cut early at `cutR` only
 * when the record would still sit a margin above target with the loss counted, so the rate
 * settles in a band above the target rather than climbing toward a hundred.
 */
export function steer({ target, wins, closed, unrealised, risk, ageMs, minAgeMs = 60_000, bankR = 0.02, cutR = 0.25, cutMargin = 0.03, floorR = 0.5 }: {
  target: number | null; wins: number; closed: number; unrealised: number; risk: number;
  ageMs: number; minAgeMs?: number; bankR?: number; cutR?: number; cutMargin?: number; floorR?: number;
}): { close: 'win' | 'loss' } | null {
  if (target === null || !(risk > 0) || !(ageMs >= minAgeMs)) return null;
  const r = unrealised / risk;
  if (r >= bankR) return { close: 'win' };
  if (r <= -floorR) return { close: 'loss' };
  if (r <= -cutR && closed > 0 && wins / (closed + 1) >= target + cutMargin) return { close: 'loss' };
  return null;
}
