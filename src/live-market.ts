/**
 * Real crypto prices for the whole platform, from Kraken's public market data (no key).
 *
 * src/market.ts asks this module first for every crypto symbol: the live price, the
 * price at a past moment, and candles on each timeframe. Everything here is synchronous
 * from the caller's side — prices and candles are kept in memory and refreshed in the
 * background — so the order book, the auto trader and the charts read real prices without
 * waiting on the network. Until a symbol's real data has arrived, or for a coin Kraken
 * does not list, market.ts falls back to its own curve (scaled to the real level once a
 * real price is known), so nothing ever goes blank.
 *
 * Off in tests and with PRICE_FEED=off: nothing reaches the network uninvited.
 */

export type LiveCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const API = 'https://api.kraken.com/0/public';
// Kraken's names for bases that differ from the platform's.
const KRAKEN_BASE: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG', RNDR: 'RENDER' };
// Kraken's OHLC intervals, in minutes, for each platform timeframe.
const INTERVAL: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1H': 60, '4H': 240, '1D': 1440, '1W': 10080 };
const TF_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800 };

export const liveEnabled = (env: NodeJS.ProcessEnv = process.env) => env.PRICE_FEED !== 'off' && !env.NODE_TEST_CONTEXT;
export const krakenAlt = (symbol: string) => {
  const base = symbol.replace(/USD$/, '');
  return `${KRAKEN_BASE[base] ?? base}USD`;
};

export function makeLiveMarket(o: { fetch?: Fetch; now?: () => number; tickMs?: number; spacingMs?: number } = {}) {
  const get = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const now = o.now ?? Date.now;
  const tickMs = o.tickMs ?? 5000;
  const spacingMs = o.spacingMs ?? 1300;

  let symbols: string[] = [];
  const altOf = new Map<string, string>();          // platform symbol -> Kraken altname, only if listed
  const prices = new Map<string, { price: number; open: number; at: number }>();
  const series = new Map<string, { candles: LiveCandle[]; at: number }>();   // `${symbol}|${tf}`
  const queue: { symbol: string; tf: string }[] = [];
  const queued = new Set<string>();
  let timers: ReturnType<typeof setInterval>[] = [];
  let pumping = false;

  const json = async (path: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await get(`${API}/${path}`, { signal: ctl.signal });
      if (!r.ok) throw new Error('kraken http');
      const body = await r.json();
      if (body?.error?.length) throw new Error(String(body.error[0]));
      return body.result;
    } finally { clearTimeout(t); }
  };

  async function loadPairs() {
    const result = await json('AssetPairs');
    const listed = new Set(Object.values<any>(result).map((p) => p?.altname).filter(Boolean));
    altOf.clear();
    for (const s of symbols) if (listed.has(krakenAlt(s))) altOf.set(s, krakenAlt(s));
    // Kraken answers the ticker under its own keys; remember which key is which symbol.
    keyOf.clear();
    for (const [key, p] of Object.entries<any>(result)) keyOf.set(key, p?.altname);
  }
  const keyOf = new Map<string, string>();

  async function tick() {
    if (!altOf.size) return;
    const bySymbolAlt = new Map([...altOf].map(([s, a]) => [a, s]));
    const result = await json(`Ticker?pair=${[...altOf.values()].join(',')}`);
    const at = now();
    for (const [key, t] of Object.entries<any>(result)) {
      const symbol = bySymbolAlt.get(keyOf.get(key) ?? key);
      const price = Number(t?.c?.[0]), open = Number(t?.o);
      if (symbol && price > 0) prices.set(symbol, { price, open: open > 0 ? open : price, at });
    }
  }

  async function fetchSeries(symbol: string, tf: string) {
    const alt = altOf.get(symbol);
    if (!alt) return;
    const result = await json(`OHLC?pair=${alt}&interval=${INTERVAL[tf]}`);
    const rows = Object.entries<any>(result).find(([k]) => k !== 'last')?.[1] as any[] | undefined;
    if (!rows?.length) return;
    series.set(`${symbol}|${tf}`, {
      candles: rows.map((c) => ({ time: Number(c[0]), open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]) })),
      at: now(),
    });
  }

  /** One OHLC request at a time, spaced out, so the public rate limit is never hit. */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift()!;
        queued.delete(`${job.symbol}|${job.tf}`);
        try { await fetchSeries(job.symbol, job.tf); } catch { /* keep what we had */ }
        await new Promise((r) => setTimeout(r, spacingMs));
      }
    } finally { pumping = false; }
  }
  function want(symbol: string, tf: string) {
    const key = `${symbol}|${tf}`;
    if (!altOf.has(symbol) || queued.has(key) || !INTERVAL[tf]) return;
    queued.add(key);
    queue.push({ symbol, tf });
    void pump();
  }

  /** Start: learn which symbols Kraken lists, read prices on a timer, warm the 1m and 1H history. */
  async function start(list: string[]) {
    symbols = list;
    try { await loadPairs(); } catch { /* retried below */ }
    const safeTick = () => { tick().catch(() => {}); };
    safeTick();
    timers.push(setInterval(safeTick, tickMs));
    timers.push(setInterval(() => { if (!altOf.size) loadPairs().catch(() => {}); }, 60_000));
    for (const s of altOf.keys()) { want(s, '1m'); want(s, '1H'); }
  }
  const stop = () => { timers.forEach(clearInterval); timers = []; };

  /** The real last price, or null when there is none yet (or the coin is not listed). */
  const price = (symbol: string) => prices.get(symbol)?.price ?? null;
  const open = (symbol: string) => prices.get(symbol)?.open ?? null;
  const listed = (symbol: string) => altOf.has(symbol);

  /**
   * Real candles, newest last, with the bar now forming brought up to the live price.
   * Null until the history has arrived; asks for it (and for a refresh when it is stale).
   */
  function candles(symbol: string, tf: string, limit: number): LiveCandle[] | null {
    if (!altOf.has(symbol)) return null;
    const s = series.get(`${symbol}|${tf}`);
    const step = TF_SECONDS[tf] ?? 60;
    if (!s || now() - s.at > Math.min(step * 1000, 5 * 60_000)) want(symbol, tf);
    if (!s) return null;
    const out = s.candles.slice(-limit).map((c) => ({ ...c }));
    const live = prices.get(symbol)?.price;
    if (live && out.length) {
      const bucket = Math.floor(now() / 1000 / step) * step;
      const last = out[out.length - 1]!;
      if (bucket > last.time) {
        out.push({ time: bucket, open: last.close, high: Math.max(last.close, live), low: Math.min(last.close, live), close: live, volume: 0 });
        if (out.length > limit) out.shift();
      } else {
        last.close = live; last.high = Math.max(last.high, live); last.low = Math.min(last.low, live);
      }
    }
    return out;
  }

  /** The real price at a past moment, from the finest history held that reaches it. */
  function priceAt(symbol: string, atMs: number): number | null {
    const t = atMs / 1000;
    for (const tf of ['1m', '1H', '4H', '1D']) {
      const s = series.get(`${symbol}|${tf}`)?.candles;
      if (!s?.length || t < s[0]!.time) continue;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid]!.time <= t) lo = mid; else hi = mid - 1; }
      const c = s[lo]!;
      const step = TF_SECONDS[tf]!;
      if (t > c.time + step * 2) continue;           // the history stops before this moment
      const f = Math.min(1, Math.max(0, (t - c.time) / step));
      return c.open + (c.close - c.open) * f;
    }
    return null;
  }

  return { start, stop, price, open, listed, candles, priceAt, _tick: tick, _loadPairs: loadPairs, _fetchSeries: fetchSeries, _setSymbols: (l: string[]) => { symbols = l; } };
}

export type LiveMarket = ReturnType<typeof makeLiveMarket>;
