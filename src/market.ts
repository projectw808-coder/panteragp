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

/**
 * Base price, daily volatility and displayed digits per symbol. Every instrument in
 * db/instruments.sql needs an entry here — without one it lists but never quotes.
 * Volatility is set by asset class: FX moves least, then ETFs, then crypto, with the
 * small-cap coins highest. The numbers are plausible starting points, not live prices.
 */
const BASE: Record<string, [price: number, vol: number, digits: number]> = {
  // Foreign exchange
  EURUSD: [1.0850, 0.006, 5],
  GBPUSD: [1.2720, 0.007, 5],
  USDJPY: [151.40, 0.006, 3],
  AUDUSD: [0.6580, 0.007, 5],
  USDCAD: [1.3640, 0.006, 5],
  USDCHF: [0.9020, 0.006, 5],
  NZDUSD: [0.6010, 0.008, 5],
  EURGBP: [0.8530, 0.005, 5],

  // Metals
  XAUUSD: [2380.0, 0.011, 2],
  XAGUSD: [28.40, 0.018, 3],

  // Crypto
  BTCUSD: [64200, 0.035, 2],
  ETHUSD: [3120, 0.040, 2],
  SOLUSD: [148.20, 0.055, 2],
  XRPUSD: [0.5240, 0.050, 4],
  ADAUSD: [0.4460, 0.052, 4],
  DOGEUSD: [0.15200, 0.065, 5],
  AVAXUSD: [35.60, 0.058, 2],
  DOTUSD: [6.840, 0.050, 3],
  LINKUSD: [17.250, 0.050, 3],
  POLUSD: [0.5820, 0.055, 4],
  LTCUSD: [84.30, 0.042, 2],
  BCHUSD: [462.00, 0.048, 2],
  ATOMUSD: [8.420, 0.052, 3],
  UNIUSD: [9.860, 0.055, 3],
  AAVEUSD: [96.40, 0.058, 2],
  ARBUSD: [0.9240, 0.062, 4],
  OPUSD: [1.8600, 0.062, 4],
  NEARUSD: [5.320, 0.058, 3],
  APTUSD: [8.940, 0.060, 3],
  SUIUSD: [1.4200, 0.068, 4],
  TONUSD: [6.180, 0.052, 3],
  TRXUSD: [0.12400, 0.038, 5],
  XLMUSD: [0.11200, 0.048, 5],
  FILUSD: [4.320, 0.058, 3],
  ICPUSD: [9.740, 0.060, 3],
  INJUSD: [24.600, 0.065, 3],
  ETCUSD: [26.400, 0.050, 3],
  BNBUSD: [592.00, 0.038, 2],
  SHIBUSD: [0.00002420, 0.070, 8],
  PEPEUSD: [0.00001180, 0.085, 8],

  // Crypto — added with the wider listing. Volatility rises with how small and how new
  // the asset is: majors around 4%, mid-caps 5-6%, meme coins 7-9%.
  HBARUSD: [0.08240, 0.055, 5],
  ZECUSD: [24.60, 0.050, 2],
  DASHUSD: [28.40, 0.048, 2],
  XTZUSD: [0.8640, 0.048, 4],
  EOSUSD: [0.6820, 0.050, 4],
  ALGOUSD: [0.14800, 0.052, 5],
  VETUSD: [0.02640, 0.055, 5],
  SEIUSD: [0.4320, 0.062, 4],
  TIAUSD: [6.240, 0.068, 3],
  EGLDUSD: [28.20, 0.058, 2],
  KASUSD: [0.14200, 0.070, 5],
  STXUSD: [1.7400, 0.060, 4],
  MINAUSD: [0.5140, 0.062, 4],
  FLOWUSD: [0.6480, 0.058, 4],
  IMXUSD: [1.4600, 0.060, 4],
  MKRUSD: [2412.00, 0.048, 2],
  LDOUSD: [1.8200, 0.058, 4],
  CRVUSD: [0.3140, 0.065, 4],
  SNXUSD: [2.140, 0.060, 3],
  COMPUSD: [48.60, 0.055, 2],
  RUNEUSD: [4.180, 0.062, 3],
  DYDXUSD: [1.2400, 0.062, 4],
  JUPUSD: [0.8420, 0.068, 4],
  PYTHUSD: [0.3260, 0.068, 4],
  GRTUSD: [0.16400, 0.058, 5],
  RNDRUSD: [6.820, 0.065, 3],
  FETUSD: [1.3400, 0.068, 4],
  THETAUSD: [1.4800, 0.058, 4],
  ARUSD: [24.800, 0.062, 3],
  SANDUSD: [0.3180, 0.062, 4],
  MANAUSD: [0.3420, 0.062, 4],
  AXSUSD: [5.240, 0.062, 3],
  GALAUSD: [0.02180, 0.070, 5],
  CHZUSD: [0.06840, 0.062, 5],
  ENSUSD: [23.400, 0.060, 3],
  CAKEUSD: [2.2400, 0.058, 4],
  WIFUSD: [2.1800, 0.085, 4],
  BONKUSD: [0.00002140, 0.090, 8],
  FLOKIUSD: [0.00014200, 0.088, 8],
  // ETFs — broad market
  SPY: [521.40, 0.011, 2],
  QQQ: [443.60, 0.014, 2],
  DIA: [389.20, 0.010, 2],
  IWM: [204.80, 0.015, 2],
  VTI: [258.30, 0.011, 2],
  VOO: [478.90, 0.011, 2],

  // ETFs — international
  EEM: [42.60, 0.013, 2],
  EFA: [79.40, 0.011, 2],
  FXI: [26.80, 0.019, 2],

  // ETFs — sector
  XLF: [41.20, 0.012, 2],
  XLK: [208.40, 0.016, 2],
  XLE: [92.60, 0.017, 2],
  SMH: [242.10, 0.024, 2],
  ARKK: [47.80, 0.028, 2],

  // ETFs — commodity and fixed income
  GLD: [219.40, 0.011, 2],
  SLV: [26.10, 0.018, 2],
  USO: [78.20, 0.020, 2],
  TLT: [92.40, 0.009, 2],
  HYG: [77.60, 0.005, 2],

  // ETFs — digital asset
  IBIT: [36.80, 0.035, 2],
  FBTC: [56.40, 0.035, 2],
  ETHA: [22.90, 0.040, 2],
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
