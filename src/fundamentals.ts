// Fundamentals for the coins the platform trades: size, liquidity, supply and where the
// price sits against its history. Read from CoinGecko's public markets endpoint (no key),
// cached for five minutes, and off wherever the live price feed is off. Nothing here is a
// forecast or a recommendation — it is the market's own figures, plus a few plain labels
// for what those figures mean, each derived by a stated rule.
import { liveEnabled } from './live-market.ts';

type Fetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Platform base → CoinGecko symbol, where the two differ. */
const GECKO_SYMBOL: Record<string, string> = { RNDR: 'render' };

export type Fundamentals = {
  symbol: string; available: true; name: string; rank: number | null;
  market_cap: number | null; fdv: number | null; volume_24h: number | null;
  /** 24h volume over market cap: how much of the coin changed hands in a day. */
  turnover: number | null;
  circulating: number | null; max_supply: number | null;
  /** Share of the maximum supply already issued. Null when there is no cap. */
  issued: number | null;
  ath: number | null; ath_date: string | null; from_ath: number | null;
  change_24h: number | null; change_7d: number | null; change_30d: number | null;
  high_24h: number | null; low_24h: number | null; updated: string | null;
  read: { size: string; liquidity: string; supply: string; trend: string };
};
export type NotCovered = { symbol: string; available: false };

type Row = {
  symbol: string; name: string; market_cap_rank: number | null; market_cap: number | null;
  fully_diluted_valuation: number | null; total_volume: number | null; circulating_supply: number | null;
  max_supply: number | null; ath: number | null; ath_date: string | null; ath_change_percentage: number | null;
  price_change_percentage_24h_in_currency?: number | null; price_change_percentage_7d_in_currency?: number | null;
  price_change_percentage_30d_in_currency?: number | null; high_24h: number | null; low_24h: number | null;
  last_updated: string | null;
};

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The plain-language reading of the figures. Thresholds are stated so they can be checked. */
export function readOf(f: { market_cap: number | null; volume: number | null; issued: number | null; change_30d: number | null }) {
  const cap = f.market_cap ?? 0;
  return {
    size: cap >= 10e9 ? 'Large cap' : cap >= 1e9 ? 'Mid cap' : cap > 0 ? 'Small cap' : 'Unknown size',
    // By what trades in a day, not by its share of the coin's value: bitcoin turns over a
    // small fraction of itself and is still the deepest market there is.
    liquidity: f.volume === null ? 'Unknown' : f.volume >= 1e9 ? 'Deep liquidity' : f.volume >= 1e8 ? 'Liquid' : 'Thinly traded',
    supply: f.issued === null ? 'No fixed cap' : f.issued >= 0.9 ? 'Mostly issued' : f.issued >= 0.5 ? 'Partly issued' : 'Early in issuance',
    trend: f.change_30d === null ? 'Unknown' : f.change_30d >= 10 ? 'Strong month' : f.change_30d >= 0 ? 'Up on the month' : f.change_30d > -10 ? 'Down on the month' : 'Weak month',
  };
}

export function toFundamentals(symbol: string, r: Row): Fundamentals {
  const market_cap = n(r.market_cap), volume = n(r.total_volume), circ = n(r.circulating_supply), max = n(r.max_supply);
  const turnover = market_cap && volume !== null ? volume / market_cap : null;
  const issued = max && circ !== null ? Math.min(1, circ / max) : null;
  const change_30d = n(r.price_change_percentage_30d_in_currency);
  return {
    symbol, available: true, name: r.name, rank: n(r.market_cap_rank),
    market_cap, fdv: n(r.fully_diluted_valuation), volume_24h: volume, turnover,
    circulating: circ, max_supply: max, issued,
    ath: n(r.ath), ath_date: r.ath_date, from_ath: n(r.ath_change_percentage),
    change_24h: n(r.price_change_percentage_24h_in_currency), change_7d: n(r.price_change_percentage_7d_in_currency), change_30d,
    high_24h: n(r.high_24h), low_24h: n(r.low_24h), updated: r.last_updated,
    read: readOf({ market_cap, volume, issued, change_30d }),
  };
}

export function makeFundamentals(o: { fetch?: Fetch; ttlMs?: number; now?: () => number; enabled?: () => boolean } = {}) {
  const enabled = o.enabled ?? (() => liveEnabled());
  const get: Fetch = o.fetch ?? ((url) => fetch(url, { headers: { accept: 'application/json' } }));
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; row: Row | null }>();

  /** Fundamentals for platform symbols. Crypto that CoinGecko lists comes back filled in;
   *  anything else (forex, metals, ETFs, an unlisted coin, an outage) comes back not covered. */
  async function forSymbols(symbols: string[], isCrypto: (s: string) => boolean): Promise<(Fundamentals | NotCovered)[]> {
    const crypto = symbols.filter(isCrypto);
    const base = (s: string) => s.replace(/USD$/, '');
    const gecko = (s: string) => GECKO_SYMBOL[base(s)] ?? base(s).toLowerCase();
    const stale = crypto.filter((s) => { const c = cache.get(s); return !c || now() - c.at > ttl; });
    if (stale.length && enabled()) {
      try {
        const res = await get(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=${stale.map(gecko).join(',')}&price_change_percentage=24h,7d,30d&per_page=250`);
        const rows = res.ok ? (await res.json()) as Row[] : [];
        for (const s of stale) {
          // Several coins can share a ticker; the markets call lists the largest first.
          const row = Array.isArray(rows) ? rows.filter((r) => r.symbol?.toLowerCase() === gecko(s)).sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0] ?? null : null;
          cache.set(s, { at: now(), row });
        }
      } catch { /* an outage leaves the last good figures in place, or none */ }
    }
    return symbols.map((s) => {
      const row = isCrypto(s) ? cache.get(s)?.row ?? null : null;
      return row ? toFundamentals(s, row) : { symbol: s, available: false as const };
    });
  }
  return { forSymbols, _cache: cache };
}
