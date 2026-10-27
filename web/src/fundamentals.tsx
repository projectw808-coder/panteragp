import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Droplets, Landmark, Mountain, TrendingUp } from 'lucide-react';
import { useApi } from './api.ts';
import { price } from './format.ts';
import { Coin } from './landing.tsx';

/**
 * Fundamentals for the markets the bot trades: how big each coin is, how much of it changes
 * hands, how much of its supply is out, and where its price sits against its own history.
 * The figures are the market's own (server: src/fundamentals.ts); the four readings under
 * each are plain labels from stated thresholds, not a view on where the price goes next.
 */

type Read = { size: string; liquidity: string; supply: string; trend: string };
type Market = { symbol: string; available: false } | {
  symbol: string; available: true; name: string; rank: number | null;
  market_cap: number | null; fdv: number | null; volume_24h: number | null; turnover: number | null;
  circulating: number | null; max_supply: number | null; issued: number | null;
  ath: number | null; ath_date: string | null; from_ath: number | null;
  change_24h: number | null; change_7d: number | null; change_30d: number | null;
  high_24h: number | null; low_24h: number | null; updated: string | null; read: Read;
};
type Full = Extract<Market, { available: true }>;

const big = (v: number | null) => {
  if (v === null) return '—';
  const a = Math.abs(v);
  return a >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v).toLocaleString()}`;
};
const units = (v: number | null) => {
  if (v === null) return '—';
  return v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.round(v).toLocaleString();
};
const chg = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`);
const tone = (v: number | null) => (v === null ? '' : v >= 0 ? 'text-up' : 'text-down');
const base = (s: string) => (s.length > 3 && s.endsWith('USD') ? s.slice(0, -3) : s);
/** Where the price is now, from the all-time high and the distance below it. */
const now = (m: Full) => (m.ath !== null && m.from_ath !== null ? m.ath * (1 + m.from_ath / 100) : null);

export function FundamentalsPanel({ symbols }: { symbols: string[] }) {
  const key = useMemo(() => [...new Set(symbols)].sort().join(','), [symbols]);
  const data = useApi<{ markets: Market[] }>(key ? `/market/fundamentals?symbols=${encodeURIComponent(key)}` : null);
  const covered = (data.data?.markets ?? []).filter((m): m is Full => m.available).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const missing = (data.data?.markets ?? []).filter((m) => !m.available).map((m) => base(m.symbol));
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { if (!pick && covered[0]) setPick(covered[0].symbol); }, [covered.length]);
  const m = covered.find((x) => x.symbol === pick) ?? covered[0];

  return (
    <section className="x-card x-holo space-y-4 p-5" aria-label="Fundamentals">
      <div className="flex flex-wrap items-center gap-3">
        <span className="x-chip !size-8" aria-hidden><BookOpen size={16} /></span>
        <div>
          <h2 className="section-title">Fundamentals</h2>
          <p className="text-xs text-slate-ink">The markets the bot trades: size, liquidity, supply and where each price sits in its history.</p>
        </div>
        {covered[0]?.updated && <span className="ml-auto text-xs text-mist">Market data, refreshed every few minutes</span>}
      </div>

      {!data.data && <div className="skeleton h-48 rounded-lg" />}
      {data.data && covered.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-ink">Market figures are not available right now. They come back on their own.</p>
      )}

      {m && (
        <>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Market">
            {covered.map((x) => (
              <button key={x.symbol} type="button" role="tab" aria-selected={x.symbol === m.symbol} onClick={() => setPick(x.symbol)}
                className={`fa-pick ${x.symbol === m.symbol ? 'is-on' : ''}`}>
                <span className="x-qcoin" aria-hidden><Coin symbol={x.symbol} /></span>{base(x.symbol)}
                <span className={`text-[11.5px] tabular-nums ${tone(x.change_24h)}`}>{chg(x.change_24h)}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            {/* The coin at a glance: what it is, the readings, and how it has moved. */}
            <div className="fa-card">
              <div className="flex items-center gap-3">
                <span className="x-qcoin !size-10" aria-hidden><Coin symbol={m.symbol} /></span>
                <div className="min-w-0">
                  <p className="text-[18px] font-bold">{m.name}</p>
                  <p className="text-xs text-mist">{m.rank ? `Number ${m.rank} by market value` : 'Unranked'}</p>
                </div>
                <span className="ml-auto text-right">
                  <span className="block text-[20px] font-bold tabular-nums">{now(m) === null ? '—' : `$${price(now(m)!)}`}</span>
                  <span className={`text-xs font-semibold tabular-nums ${tone(m.change_24h)}`}>{chg(m.change_24h)} today</span>
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="x-badge is-locked">{m.read.size}</span>
                <span className="x-badge is-muted">{m.read.liquidity}</span>
                <span className="x-badge is-muted">{m.read.supply}</span>
                <span className={`x-badge ${m.change_30d !== null && m.change_30d < 0 ? 'is-bad' : ''}`}>{m.read.trend}</span>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                {([['24 hours', m.change_24h], ['7 days', m.change_7d], ['30 days', m.change_30d]] as const).map(([l, v]) => (
                  <div key={l} className="fa-move">
                    <span className="text-[11.5px] text-mist">{l}</span>
                    <span className={`mt-1 block text-[17px] font-bold tabular-nums ${tone(v)}`}>{chg(v)}</span>
                  </div>
                ))}
              </div>
              {m.low_24h !== null && m.high_24h !== null && now(m) !== null && m.high_24h > m.low_24h && (
                <div className="mt-5">
                  <div className="flex justify-between text-[11.5px] text-mist"><span>Today's low</span><span>Today's high</span></div>
                  <div className="fa-range mt-1.5"><span style={{ left: `${Math.min(100, Math.max(0, ((now(m)! - m.low_24h) / (m.high_24h - m.low_24h)) * 100))}%` }} /></div>
                  <div className="mt-1 flex justify-between text-[12px] font-semibold tabular-nums"><span>${price(m.low_24h)}</span><span>${price(m.high_24h)}</span></div>
                </div>
              )}
            </div>

            {/* The figures behind the readings. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Fig Icon={Landmark} label="Market value" value={big(m.market_cap)}
                note={m.fdv && m.market_cap && m.fdv > m.market_cap * 1.02 ? `${big(m.fdv)} once every coin is issued` : 'Nearly all of it already issued'} />
              <Fig Icon={Droplets} label="Traded in 24 hours" value={big(m.volume_24h)}
                note={m.turnover === null ? '' : `${(m.turnover * 100).toFixed(1)}% of its value changed hands`} />
              <div className="fa-fig">
                <p className="flex items-center gap-2 text-[13px] text-mist"><TrendingUp size={15} className="text-ember" aria-hidden />Supply issued</p>
                <p className="mt-2 text-[20px] font-bold tabular-nums">{m.issued === null ? units(m.circulating) : `${(m.issued * 100).toFixed(1)}%`}</p>
                {m.issued !== null && <div className="x-meter mt-2"><span style={{ width: `${m.issued * 100}%` }} /></div>}
                <p className="mt-2 text-xs text-slate-ink">{m.max_supply ? `${units(m.circulating)} of ${units(m.max_supply)} coins` : `${units(m.circulating)} coins out, no maximum set`}</p>
              </div>
              <div className="fa-fig">
                <p className="flex items-center gap-2 text-[13px] text-mist"><Mountain size={15} className="text-ember" aria-hidden />From its all-time high</p>
                <p className={`mt-2 text-[20px] font-bold tabular-nums ${tone(m.from_ath)}`}>{chg(m.from_ath)}</p>
                {m.from_ath !== null && <div className="fa-ath mt-2"><span style={{ width: `${Math.max(2, 100 + Math.max(-100, m.from_ath))}%` }} /></div>}
                <p className="mt-2 text-xs text-slate-ink">{m.ath === null ? '' : `High of $${price(m.ath)}${m.ath_date ? ` on ${new Date(m.ath_date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`}</p>
              </div>
            </div>
          </div>

          {/* Every market side by side, for the comparison the detail above cannot make. */}
          <div className="x-table overflow-x-auto"><table className="w-full text-sm">
            <thead className="x-thead"><tr>
              {['Market', 'Rank', 'Market value', 'Traded 24h', 'Turnover', 'Supply issued', 'From high', '30 days'].map((h, i) => (
                <th key={h} className={`px-3 py-2 ${i >= 1 ? 'text-right' : 'text-left'}`}>{h}</th>))}
            </tr></thead>
            <tbody>{covered.map((x) => (
              <tr key={x.symbol} className={`cursor-pointer ${x.symbol === m.symbol ? 'fa-row-on' : ''}`} onClick={() => setPick(x.symbol)}>
                <td className="px-3 py-2"><span className="flex items-center gap-2 font-semibold"><span className="x-qcoin" aria-hidden><Coin symbol={x.symbol} /></span>{x.name}</span></td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-ink">{x.rank ?? '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{big(x.market_cap)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{big(x.volume_24h)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{x.turnover === null ? '—' : `${(x.turnover * 100).toFixed(1)}%`}</td>
                <td className="px-3 py-2 text-right tabular-nums">{x.issued === null ? 'No cap' : `${(x.issued * 100).toFixed(0)}%`}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${tone(x.from_ath)}`}>{chg(x.from_ath)}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${tone(x.change_30d)}`}>{chg(x.change_30d)}</td>
              </tr>))}
            </tbody>
          </table></div>
        </>
      )}

      <p className="text-xs text-slate-ink">
        {missing.length > 0 && <>{missing.join(', ')} {missing.length === 1 ? 'is' : 'are'} not covered: these figures exist for coins, not for currencies, metals or funds. </>}
        The readings follow fixed rules (large cap means over $10B, deep liquidity means over $1B traded a day) and are not a forecast or advice.
      </p>
    </section>
  );
}

function Fig({ Icon, label, value, note }: { Icon: typeof BookOpen; label: string; value: string; note: string }) {
  return (
    <div className="fa-fig">
      <p className="flex items-center gap-2 text-[13px] text-mist"><Icon size={15} className="text-ember" aria-hidden />{label}</p>
      <p className="mt-2 text-[20px] font-bold tabular-nums">{value}</p>
      {note && <p className="mt-2 text-xs text-slate-ink">{note}</p>}
    </div>
  );
}
