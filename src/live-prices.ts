/**
 * Real crypto prices for the public page, from Kraken's public market data (no key).
 *
 * The trading platform still prices from src/market.ts; this module only feeds what the
 * public page shows as the market: the running price strip, and the level the landing
 * page's demo record is drawn at. A symbol Kraken does not list, an outage, or a test run
 * falls back to the platform's own quote, so the page never goes blank.
 *
 * Polled lazily: a request older than the refresh interval triggers one fetch, shared by
 * every caller in flight, and the last good answer is served meanwhile.
 */

type Live = { price: number; open: number; spark: number[]; at: number };

const API = 'https://api.kraken.com/0/public';
const TICK_MS = 10_000;          // how stale a price may be before it is re-read
const SPARK_MS = 5 * 60_000;     // the hourly line changes slowly
const PAIRS_MS = 24 * 3_600_000;

// Kraken's own names for two of the bases.
const KRAKEN_BASE: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG' };
const altname = (symbol: string) => {
  const base = symbol.replace(/USD$/, '');
  return `${KRAKEN_BASE[base] ?? base}USD`;
};

/** Off in tests and when PRICE_FEED=off, so nothing reaches the network uninvited. */
export const liveEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.PRICE_FEED !== 'off' && !env.NODE_TEST_CONTEXT;

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

export function makeLiveCrypto(o: { fetch?: Fetch; now?: () => number } = {}) {
  const get = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const now = o.now ?? Date.now;
  const live = new Map<string, Live>();
  const sparks = new Map<string, { values: number[]; at: number }>();
  let pairs: { map: Map<string, string>; at: number } | null = null;   // response key -> altname
  let inflight: Promise<void> | null = null;
  let lastTick = 0;

  const json = async (path: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await get(`${API}/${path}`, { signal: ctl.signal });
      if (!r.ok) throw new Error('kraken http');
      const body = await r.json();
      if (body?.error?.length) throw new Error(String(body.error[0]));
      return body.result;
    } finally { clearTimeout(t); }
  };

  async function pairMap() {
    if (pairs && now() - pairs.at < PAIRS_MS) return pairs.map;
    const result = await json('AssetPairs');
    const map = new Map<string, string>();
    for (const [key, p] of Object.entries<any>(result)) if (p?.altname) map.set(key, p.altname);
    pairs = { map, at: now() };
    return map;
  }

  async function refresh(symbols: string[]) {
    const keys = await pairMap();
    const byAlt = new Map(symbols.map((s) => [altname(s), s]));
    const known = new Set(keys.values());
    const asked = [...byAlt.keys()].filter((a) => known.has(a));
    if (!asked.length) return;
    const result = await json(`Ticker?pair=${asked.join(',')}`);
    const at = now();
    for (const [key, t] of Object.entries<any>(result)) {
      const symbol = byAlt.get(keys.get(key) ?? key);
      const price = Number(t?.c?.[0]), open = Number(t?.o);
      if (symbol && price > 0) live.set(symbol, { price, open: open > 0 ? open : price, spark: live.get(symbol)?.spark ?? [], at });
    }
    // The hourly line, one pair at a time and only when it has gone stale.
    for (const alt of asked) {
      const symbol = byAlt.get(alt)!;
      const s = sparks.get(symbol);
      if (s && now() - s.at < SPARK_MS) continue;
      try {
        const r = await json(`OHLC?pair=${alt}&interval=60`);
        const rows = Object.entries<any>(r).find(([k]) => k !== 'last')?.[1] as any[] | undefined;
        if (rows?.length) sparks.set(symbol, { values: rows.slice(-25).map((c) => Number(c[4])), at: now() });
      } catch { /* keep the last line */ }
    }
  }

  /** Real prices for the symbols Kraken lists, refreshed when stale; never throws. */
  async function quotes(symbols: string[]): Promise<Map<string, Live>> {
    if (now() - lastTick > TICK_MS && !inflight) {
      lastTick = now();
      inflight = refresh(symbols).catch(() => {}).finally(() => { inflight = null; });
    }
    // Wait for the very first answer; after that serve the last one while refreshing.
    if (!live.size && inflight) await inflight;
    const out = new Map<string, Live>();
    for (const s of symbols) {
      const l = live.get(s);
      if (l) out.set(s, { ...l, spark: sparks.get(s)?.values ?? [] });
    }
    return out;
  }

  /** The last real price seen for a symbol, without fetching. */
  const last = (symbol: string) => live.get(symbol)?.price ?? null;

  return { quotes, last };
}
