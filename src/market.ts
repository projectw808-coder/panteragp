// Mock OHLC data. Deterministic: a given (symbol, timeframe, bar index) always yields the
// same candle, so panning and reloading are stable.
// ponytail: value noise, not a market. This is still the only price source — the live feed
// broadcasts spot() from here, it did not replace it. A real integration swaps this file
// for a broker/exchange client plus a candles table; everything downstream already consumes
// the shape returned here, so the seam is this file and nothing else.

export const TIMEFRAMES = {
  '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800,
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;

/** Base price and daily volatility per symbol. */
const BASE: Record<string, [price: number, vol: number, digits: number]> = {
  EURUSD: [1.0850, 0.006, 5],
  GBPUSD: [1.2720, 0.007, 5],
  USDJPY: [151.40, 0.006, 3],
  XAUUSD: [2380.0, 0.011, 2],
  BTCUSD: [64200, 0.035, 2],
  ETHUSD: [3120, 0.040, 2],
};

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
};

const rnd = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Smooth 1-D value noise: interpolates between per-integer random values. */
const noise = (x: number) => {
  const i = Math.floor(x), f = x - i;
  const t = f * f * (3 - 2 * f);
  return rnd(i) + (rnd(i + 1) - rnd(i)) * t;
};

/** Sum of octaves — gives the trending-with-chop look of a real price series. */
const fbm = (x: number) =>
  noise(x) * 0.5 + noise(x * 2.7 + 11) * 0.25 + noise(x * 7.3 + 23) * 0.15 + noise(x * 19.1 + 37) * 0.1;

export type Candle = {
  time: number; open: number; high: number; low: number; close: number; volume: number;
};

/**
 * The price curve for one symbol on one timeframe. `at` is continuous in the bar
 * index, so a fractional index gives the price partway through a bar — that is what
 * makes the live spot price agree with the candle it is still forming.
 */
function walker(symbol: string, tf: Timeframe) {
  const [base, vol, digits] = BASE[symbol] ?? [100, 0.02, 2];
  const step = TIMEFRAMES[tf];
  const seed = hash(symbol + tf);
  // Longer timeframes move more per bar: scale volatility by the square root of time.
  const amp = base * vol * Math.sqrt(step / 86400);
  return {
    step, seed, amp,
    round: (n: number) => Number(n.toFixed(digits)),
    at: (i: number) => base + (fbm((i + seed) / 40) - 0.5) * 2 * amp * 8,
  };
}

export function candles(symbol: string, tf: Timeframe, limit: number): Candle[] {
  const { step, seed, amp, round, at } = walker(symbol, tf);

  const last = Math.floor(Date.now() / 1000 / step);
  const out: Candle[] = [];
  for (let n = limit - 1; n >= 0; n--) {
    const i = last - n;
    const open = at(i), close = at(i + 1);
    const wick = amp * (0.3 + rnd(i + seed) * 0.7);
    out.push({
      time: i * step,
      open: round(open),
      high: round(Math.max(open, close) + wick),
      low: round(Math.min(open, close) - wick),
      close: round(close),
      volume: Math.round(500 + rnd(i * 3 + seed) * 4500),
    });
  }
  return out;
}

/**
 * The live price right now, walking through the bar currently forming. Reading it
 * again a second later gives a slightly different number, which is what the feed
 * broadcasts and what the chart's last candle converges towards.
 */
export function spot(symbol: string, atMs = Date.now()): number {
  const { step, round, at, amp } = walker(symbol, '1m');
  const x = atMs / 1000 / step;
  const frac = x - Math.floor(x);
  // The bar curve alone moves too little to see between one second and the next, so add
  // fast chop on top — tapered to zero at both ends of the bar, which keeps the live
  // price equal to the bar's open at its start and its close at the next boundary.
  const chop = amp * 1.5 * (fbm(x * 120) - 0.5) * Math.sin(Math.PI * frac);
  return round(at(x) + chop);
}

/** Last price and change over the most recent bar, for the watchlist. */
export function quote(symbol: string, atMs = Date.now()) {
  const prev = candles(symbol, '1m', 2)[0]!;
  const price = spot(symbol, atMs);
  return {
    symbol,
    price,
    change: Number((price - prev.close).toFixed(8)),
    change_pct: Number((((price - prev.close) / prev.close) * 100).toFixed(3)),
  };
}
