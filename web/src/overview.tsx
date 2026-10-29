import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Activity, Bell, Bot, ChartCandlestick, ChartLine, Landmark, Layers, Wallet } from 'lucide-react';
import { alertBox, card, PageTitle } from './App.tsx';
import { Coin } from './landing.tsx';
import { ICON as NOTE_ICON, TONE as NOTE_TONE, when, type Notification } from './notifications.tsx';
import { QuoteCard, useQuotes } from './x-shell.tsx';
import { useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { headline, unit, type Accounts } from './balance.tsx';

/**
 * The client's own front page: what they have, what it has done, and what it is in.
 *
 * Every figure is read from something recorded. The performance line is earnings — realised
 * P&L, interest and staking rewards, each summed from the row that created it — and not an
 * equity curve, because equity on a past day depends on what the open positions were worth
 * that day and nothing here keeps a price history per client. Drawing one would mean
 * inventing the part nobody recorded, and a performance line on a trading platform is read
 * as a statement of fact.
 *
 * Charts are inline SVG on the platform's own tokens rather than a charting library: a
 * donut and a gradient area are a few dozen lines each, and a second set of colours coming
 * from a library's defaults is how a design system quietly stops being one.
 */

type Account = {
  balance: number; equity: number; unrealized: number; currency: string; leverage: number;
  /** The move on open positions over what they cost. Null when nothing is open. */
  open_pct: number | null;
  exposure?: number; margin_used?: number; free_margin?: number;
};
type Position = { symbol: string; qty: number; avg_price: number; price: number; unrealized: number };
type Point = { day: string; earned: number; cumulative: number; moved_in: number; moved_out: number };
type Performance = {
  days: number; series: Point[]; earned: number; pct: number | null;
  opening: number; equity: number; unpriced: string[]; holdings?: number; open_pnl?: number;
  best: Point | null; worst: Point | null;
};

const RANGES = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '1Y', days: 365 },
] as const;

const usd = (n: number) =>
  '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;
// A return too small to show at two decimals is reported as too small to show, not as
// +0.00% — a zero that is not a zero is the figure people quote back at you.
const pct = (n: number) => {
  const v = Math.abs(n * 100);
  if (v > 0 && v < 0.01) return n > 0 ? 'under +0.01%' : 'under −0.01%';
  return `${n >= 0 ? '+' : '−'}${v.toFixed(2)}%`;
};
const day = (d: string) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function OverviewView() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const account = useApi<Account>('/account');
  const positions = useApi<Position[]>('/positions');
  const accounts = useApi<Accounts>('/accounts');
  const perf = useApi<Performance>(`/me/performance?days=${range.days}`);

  const a = account.data;
  const held = positions.data ?? [];
  // From /account, not re-summed from /positions. Both count the same positions, but they
  // are two fetches at two moments and the price moves between them, so the amount shown
  // at the top and the amount shown at the bottom disagreed by whatever the market did in
  // between. One request supplies the amount and the percentage, and they are of the same
  // instant by construction.
  const openPnl = a ? Number(a.unrealized) : 0;
  // Margin is what the leverage is actually carrying, not what it could. The server's
  // figure where it gives one, so this tile and the order ticket's refusal agree.
  const exposure = a?.exposure ?? held.reduce((n, p) => n + Math.abs(Number(p.qty)) * Number(p.price), 0);
  const margin = a?.margin_used ?? (a?.leverage ? exposure / Number(a.leverage) : exposure);

  // The same rule the balance strip uses, from the same endpoint, so the two cannot
  // disagree about what somebody has: one currency is reported as itself, several convert.
  const openPct = a?.open_pct ?? null;
  const acc = accounts.data;
  const u = acc ? unit(acc) : null;
  const native = u?.code ?? null;
  const cashHeld = acc && native
    ? acc.cash.filter((x) => x.currency === native).reduce((n, x) => n + Number(x.balance), 0)
    : null;

  const quotes = useQuotes();
  const longs = held.filter((p) => Number(p.qty) > 0).length;
  const shorts = held.filter((p) => Number(p.qty) < 0).length;
  const equityFmt = native && acc ? headline(acc).format : usd;
  // One equity, the server's: everything held plus the open positions' P&L. The top bar,
  // the allocation card and the staff record all read the same figure.
  const equityValue = native && acc ? headline(acc).value
    : acc?.equity_usd !== undefined ? Number(acc.equity_usd)
    : perf.data ? perf.data.equity : a ? Number(a.equity) : null;
  const book = acc?.book ?? null;
  const shownEquity = useCountUp(equityValue);
  const tiles: [string, typeof Wallet, number | null, (n: number) => string, string, ('up' | 'down')?][] = [
    ['Available Cash', Wallet, cashHeld ?? (a ? Number(a.balance) : null), native && u ? u.format : usd, native ? `Cash in ${native}` : a ? `Cash in ${a.currency}` : ''],
    ['Open P&L', ChartCandlestick, a ? openPnl : null, signed,
      openPct === null ? 'Nothing open' : pct(openPct), openPnl < 0 ? 'down' : openPnl > 0 ? 'up' : undefined],
    ['Margin Used', Landmark, a ? margin : null, usd,
      a ? `${a.leverage}× · ${a.free_margin !== undefined ? `${usd(a.free_margin)} free` : 'exposure'}` : ''],
    ['Active Positions', Layers, positions.data ? held.length : null, (n) => String(Math.round(n)), `${longs} Long  ${shorts} Short`],
  ];

  if (account.error) return <p role="alert" className={alertBox}>{account.error}</p>;

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      <Header />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* Total equity, and what the account has earned over the range beneath it. */}
        <div className="x-card tile enter p-5" style={{ '--i': 0 } as CSSProperties}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0">
              <p className="text-[13px] text-mist">Total Equity</p>
              {shownEquity === null
                ? <span className="skeleton mt-2 block h-[38px] w-56" aria-label="Total equity loading" />
                : <p className="mt-1 flex items-center gap-3 text-[36px] leading-none font-bold tracking-[-0.02em] tabular-nums">
                    <span className="h-[30px] w-[3px] rounded bg-ember" aria-hidden />{equityFmt(shownEquity)}
                  </p>}
              {perf.data && (
                <p className="mt-2 flex flex-wrap items-baseline gap-2 tabular-nums">
                  <span className={`text-[20px] font-semibold ${perf.data.earned < 0 ? 'text-down' : 'text-up'}`}>{perf.data.pct === null ? '—' : pct(perf.data.pct)}</span>
                  <span className={`text-[13px] ${perf.data.earned < 0 ? 'text-down' : 'text-up'}`}>{signed(perf.data.earned)} earned ({range.label})</span>
                </p>
              )}
              {/* How the figure above is made, so it can be checked against every other card. */}
              {book && !native && (
                <p className="mt-1.5 text-[12px] text-slate-ink tabular-nums">
                  Holdings {usd(book.holdings_usd)}
                  <span className="mx-1.5 text-mist">{book.open_pnl < 0 ? '−' : '+'}</span>
                  open P&amp;L <span className={book.open_pnl < 0 ? 'text-down' : book.open_pnl > 0 ? 'text-up' : ''}>{usd(Math.abs(book.open_pnl))}</span>
                </p>
              )}
            </div>
            <div role="tablist" aria-label="Range" className="x-tabs ml-auto">
              {RANGES.map((r) => (
                <button key={r.label} role="tab" aria-selected={range.label === r.label} onClick={() => setRange(r)}
                  className={range.label === r.label ? 'is-on' : ''}>{r.label}</button>
              ))}
            </div>
          </div>
          <div className="mt-3"><EarningsChart points={perf.data?.series ?? []} /></div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {tiles.map(([label, Icon, value, format, note, tone], i) => (
            <XTile key={label} label={label} Icon={Icon} value={value} format={format} note={note} tone={tone} i={i + 1} />
          ))}
        </div>
      </div>

      {/* The markets the account trades most, live. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {([['BTCUSD', 'Bitcoin'], ['ETHUSD', 'Ethereum'], ['XAUUSD', 'Gold'], ['EURUSD', 'EUR/USD']] as const).map(([sym, name], i) => {
          const q = quotes.find((x) => x.symbol === sym);
          return q
            ? <div key={sym} className="enter" style={{ '--i': i + 5 } as CSSProperties}><QuoteCard q={q} name={name} /></div>
            : <div key={sym} className="x-card h-[68px] skeleton" />;
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="enter" style={{ '--i': 9 } as CSSProperties}><Allocation accounts={accounts.data} /></div>
        <div className="enter" style={{ '--i': 10 } as CSSProperties}><PerformanceBars perf={perf.data} label={range.label} /></div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="enter" style={{ '--i': 11 } as CSSProperties}><OpenPositions rows={positions.data} /></div>
        <div className="enter" style={{ '--i': 12 } as CSSProperties}><RecentActivity /></div>
      </div>
      <p className="text-xs text-slate-ink">
        Earnings are realised trading results, interest credited into savings and staking rewards, each on the day it
        happened: what the account has earned, not a daily valuation of open positions.
      </p>
    </div>
  );
}

/** The page's own heading: who it is for, that it is live, and the two places people go next. */
function Header() {
  const me = useApi<{ name: string }>('/me/profile').data;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me?.name.trim().split(/\s+/)[0];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PageTitle>Overview</PageTitle>
      <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Live</span>
      {first && <span className="hidden text-[13px] text-slate-ink sm:inline">{greeting}, {first}.</span>}
      <span className="ml-auto flex gap-2">
        <a href="#/charts" className="x-btn-sm inline-flex items-center gap-1.5"><ChartLine size={14} aria-hidden />Charts</a>
        <a href="#/trade" className="x-btn-sm inline-flex items-center gap-1.5"><Bot size={14} aria-hidden />Auto Trader</a>
      </span>
    </div>
  );
}

const priceFmt = (n: number) => Number(n).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 10 ? 5 : 2,
});

/**
 * What is open right now, read-only: the same positions the margin and open P&L tiles
 * count, so the table and the tiles are the same instant's figures.
 */
function OpenPositions({ rows }: { rows?: Position[] | null }) {
  const list = [...(rows ?? [])].sort((a, b) => Math.abs(Number(b.unrealized)) - Math.abs(Number(a.unrealized)));
  return (
    <section className="x-card x-holo h-full space-y-3 p-5">
      <div className="flex items-center gap-3">
        <h2 className="section-title">Open positions</h2>
        {!!list.length && <span className="x-badge is-muted">{list.length}</span>}
        <a href="#/trade" className="ml-auto text-xs font-semibold text-ember-ink hover:underline">Auto Trader</a>
      </div>
      {!rows && <div className="skeleton h-28 rounded-lg" />}
      {rows && !list.length && (
        <div className="grid place-items-center gap-2 py-8 text-center">
          <span className="x-drop-icon" aria-hidden><Layers size={22} /></span>
          <p className="text-[14px] font-semibold">Nothing open</p>
          <p className="max-w-xs text-xs text-slate-ink">Positions the Auto Trader opens on your account appear here with their live P&amp;L.</p>
        </div>
      )}
      {!!list.length && (
        <div className="table-card x-table overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="x-thead">
              <tr>{['Market', 'Side', 'Size', 'Entry', 'Price', 'P&L'].map((h, i) => (
                <th key={h} className={`px-3 py-2 ${i > 1 ? 'text-right' : 'text-left'}`}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {list.slice(0, 8).map((p) => {
                const long = Number(p.qty) > 0;
                const pnl = Number(p.unrealized);
                return (
                  <tr key={p.symbol} className="border-t border-white/5">
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2 font-semibold">
                        <span className="ov-coin"><Coin symbol={p.symbol} /></span>{p.symbol}
                      </span>
                    </td>
                    <td className="px-3 py-2.5"><span className={`x-badge ${long ? '' : 'is-bad'}`}>{long ? 'Long' : 'Short'}</span></td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{Math.abs(Number(p.qty)).toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
                    <td className="px-3 py-2.5 text-right text-slate-ink tabular-nums">{priceFmt(Number(p.avg_price))}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{priceFmt(Number(p.price))}</td>
                    <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : ''}`}>{signed(pnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The latest things that happened on the account, from the same feed as the bell. */
function RecentActivity() {
  const items = useApi<Notification[]>('/notifications?limit=6').data;
  return (
    <section className="x-card x-holo h-full space-y-3 p-5">
      <div className="flex items-center gap-3">
        <h2 className="section-title">Recent activity</h2>
        <Activity size={15} className="ml-auto text-mist" aria-hidden />
      </div>
      {!items && <div className="skeleton h-28 rounded-lg" />}
      {items && !items.length && (
        <div className="grid place-items-center gap-2 py-8 text-center">
          <span className="x-drop-icon" aria-hidden><Bell size={22} /></span>
          <p className="text-[14px] font-semibold">Nothing yet</p>
          <p className="max-w-xs text-xs text-slate-ink">Fills, deposits, interest and messages from the desk show up here.</p>
        </div>
      )}
      <ul className="ov-feed">
        {(items ?? []).map((n) => {
          const Icon = NOTE_ICON[n.kind] ?? Bell;
          return (
            <li key={n.id} className={n.read_at ? '' : 'is-new'}>
              <span className={`x-note-icon ${NOTE_TONE[n.kind] ?? ''}`} aria-hidden><Icon size={14} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{n.title}</span>
                {n.body && <span className="block truncate text-[11.5px] text-slate-ink">{n.body}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-slate-ink">{when(n.created_at)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A headline figure in the plan's tile: an ember icon chip, the label, the value, a note. */
function XTile({ label, Icon, value, format, note, tone, i }: {
  label: string; Icon: typeof Wallet; value: number | null; format: (n: number) => string; note: string; tone?: 'up' | 'down'; i: number;
}) {
  const shown = useCountUp(value);
  return (
    <div className="x-card tile lift enter flex flex-col p-4" style={{ '--i': i } as CSSProperties}>
      <div className="flex items-center gap-3">
        <span className="x-chip"><Icon size={18} strokeWidth={1.9} aria-hidden /></span>
        <span className="text-[13px] text-mist">{label}</span>
      </div>
      {shown === null
        ? <span className="skeleton mt-3 block h-[24px] w-28" aria-label={`${label} loading`} />
        : <p className={`mt-3 truncate text-[22px] leading-none font-bold tabular-nums ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>{format(shown)}</p>}
      {note && <p className={`mt-2 text-xs ${tone === 'down' && label === 'Open P&L' ? 'text-down' : 'text-slate-ink'}`}>{note}</p>}
    </div>
  );
}

/** What each day earned over the range, as ember bars, losses below the line in red. */
function PerformanceBars({ perf, label }: { perf?: Performance | null; label: string }) {
  const series = perf?.series ?? [];
  const W = 520, H = 150;
  const vals = series.map((p) => p.earned);
  const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals), span = hi - lo || 1;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const bw = series.length ? (W / series.length) * 0.62 : 0;
  const months = series.filter((p, i) => i === 0 || new Date(p.day).getMonth() !== new Date(series[i - 1]!.day).getMonth());
  return (
    <div className="x-card h-full p-5">
      <h2 className="x-h">Performance</h2>
      {perf ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-3 tabular-nums">
          <span className={`text-[22px] font-semibold ${perf.earned < 0 ? 'text-down' : 'text-up'}`}>{perf.pct === null ? '—' : pct(perf.pct)}</span>
          <span className={`text-[13px] ${perf.earned < 0 ? 'text-down' : 'text-up'}`}>{signed(perf.earned)}</span>
          <span className="text-xs text-slate-ink">{label}</span>
        </p>
      ) : <span className="skeleton mt-2 block h-6 w-40" />}
      {series.length > 1 ? (
        <div className="mt-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[150px] w-full" preserveAspectRatio="none" role="img" aria-label="Earnings by day">
            <defs><linearGradient id="perf-bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff9a3d" /><stop offset="1" stopColor="#ff7a12" stopOpacity="0.35" /></linearGradient></defs>
            {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="currentColor" strokeOpacity="0.07" />)}
            {series.map((p, i) => {
              const x = (i + 0.19) * (W / series.length);
              const top = y(Math.max(0, p.earned)), bottom = y(Math.min(0, p.earned));
              return <rect key={p.day} x={x} y={top} width={bw} height={Math.max(1, bottom - top)} rx="1"
                fill={p.earned < 0 ? 'var(--color-down)' : 'url(#perf-bar)'} className="bar" style={{ animationDelay: `${i * 12}ms` }} />;
            })}
          </svg>
          <div className="mt-1 flex justify-around text-[11px] text-slate-ink">
            {months.map((m) => <span key={m.day}>{new Date(m.day).toLocaleDateString(undefined, { month: 'short' })}</span>)}
          </div>
        </div>
      ) : <p className="py-12 text-center text-sm text-slate-ink">Not enough history yet. This fills in as the account earns.</p>}
    </div>
  );
}

/** A slowly pulsing dot beside a heading, for figures that move on their own. */
export function LiveBadge() {
  return (
    <span className="flex items-center gap-2 rounded-full chip-up px-2.5 py-0.5">
      <span className="nav-live inline-block h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
      <span className="font-mono text-[10px] tracking-[0.16em] text-up uppercase">Live</span>
    </span>
  );
}

/**
 * One headline figure.
 *
 * The number counts up the first time it lands and is simply set on every refresh after —
 * see useCountUp. Until it lands there is a shimmering block rather than an em dash,
 * because a dash in a money slot reads as zero, and zero is a claim about somebody's
 * account that we are in no position to make while the request is still in flight.
 */
function StatCard({ label, icon, count, format, note, tone, i }: {
  label: string; icon: string; count: number | null; format: (n: number) => string;
  note?: string; tone?: 'up' | 'down'; i: number;
}) {
  const shown = useCountUp(count);

  return (
    <div className={`${card} tile lift grain enter`} style={{ '--i': i } as CSSProperties}>
      <span className="tile-corner" aria-hidden />
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-ember-ink" aria-hidden>{icon}</span>
        <span className="metric-label">{label}</span>
      </div>
      {shown === null ? (
        <span className="skeleton mt-2 block h-[26px] w-36" aria-label={`${label} loading`} />
      ) : (
        <p className={`mt-2 font-mono text-[26px] leading-none font-medium tabular-nums ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
          {format(shown)}
        </p>
      )}
      {note && <p className="mt-2 text-xs text-slate-ink">{note}</p>}
    </div>
  );
}

/**
 * The earnings line.
 *
 * Drawn as a path over a gradient rather than with a chart library. The baseline is zero
 * when everything is positive, so a good month does not look like it started underwater;
 * where there are losses the baseline is the minimum, and the fill stops at zero.
 */
function EarningsChart({ points }: { points: Point[] }) {
  const W = 720;
  const H = 160;
  const line = useRef<SVGPathElement>(null);

  // The dash has to be at least as long as the path or the line draws in as a row of
  // dashes. Measured rather than guessed: the length depends on how spiky the series is,
  // and a constant large enough for the worst case makes the calm ones crawl.
  useEffect(() => {
    const el = line.current;
    if (el) el.style.setProperty('--len', String(Math.ceil(el.getTotalLength())));
  }, [points]);

  const path = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.cumulative);
    const top = Math.max(...values, 0);
    const bottom = Math.min(...values, 0);
    const span = top - bottom || 1;
    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => H - ((v - bottom) / span) * H;

    // A smooth line through the points, each segment eased by its own midpoint so a spike
    // does not overshoot into a curve that shows a value nothing recorded.
    let line = `M 0 ${y(values[0]!)}`;
    for (let i = 1; i < values.length; i++) {
      const px = x(i - 1);
      const cx = x(i);
      const mid = (px + cx) / 2;
      line += ` C ${mid} ${y(values[i - 1]!)}, ${mid} ${y(values[i]!)}, ${cx} ${y(values[i]!)}`;
    }
    return { line, area: `${line} L ${W} ${y(bottom)} L 0 ${y(bottom)} Z`, zero: y(0), top, bottom };
  }, [points]);

  if (!path) {
    return (
      <p className="py-12 text-center text-sm text-slate-ink">
        Not enough history yet. This fills in as the account earns.
      </p>
    );
  }

  const ticks = points.filter((_, i) => i === 0 || i === points.length - 1
    || i === Math.floor(points.length / 2));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`Earnings over ${points.length} days`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="earnings" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-ember)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-ember)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Zero, so a line above it reads as a gain without anybody having to check. */}
        {path.bottom < 0 && (
          <line x1="0" y1={path.zero} x2={W} y2={path.zero}
            className="stroke-slate-ink/40" strokeWidth="1" strokeDasharray="3 4" />
        )}
        {/* The fill wipes in behind the line rather than with it, so the line reads as
            leading and the area as following. */}
        <path d={path.area} fill="url(#earnings)" className="wipe" />
        <path ref={line} d={path.line} fill="none" stroke="var(--color-ember)" strokeWidth="2"
          strokeLinecap="round" vectorEffect="non-scaling-stroke" className="draw" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-ink">
        {ticks.map((t) => <span key={t.day}>{day(t.day)}</span>)}
      </div>
    </div>
  );
}

/**
 * Where the money is, as a donut.
 *
 * Grouped by what the money is doing rather than by currency: cash waiting, crypto held,
 * savings put aside, crypto staked. Four groups somebody can act on beats fourteen
 * currency slices nobody can read.
 */
function Allocation({ accounts }: { accounts?: Accounts | null }) {
  const fmt = accounts ? unit(accounts).format : usd;
  const groups = useMemo(() => {
    if (!accounts) return [];
    // With one currency the slices are that currency's own amounts. Converting them would
    // put a different unit on this card than on the two above it, for no gain: the shares
    // are identical either way, since one currency converts at one rate.
    const asNative = unit(accounts).code !== null;
    const sum = (xs: { usd_value: number | null; balance: number }[]) =>
      xs.reduce((n, x) => n + Number(asNative ? x.balance : x.usd_value ?? 0), 0);
    return [
      { name: 'Cash', value: sum(accounts.cash), colour: 'var(--color-cat-1)' },
      { name: 'Crypto', value: sum(accounts.wallets), colour: 'var(--color-cat-2)' },
      { name: 'Savings', value: sum(accounts.portfolios), colour: 'var(--color-cat-3)' },
      { name: 'Staked', value: sum(accounts.stakes ?? []), colour: 'var(--color-cat-4)' },
      { name: 'IPOs', value: sum(accounts.ipos ?? []), colour: 'var(--color-cat-5)' },
    ].filter((g) => g.value > 0);
  }, [accounts]);

  const total = groups.reduce((n, g) => n + g.value, 0);
  // Open positions are not a place money sits, so they are not a slice; they are what
  // takes the holdings to the equity at the top of the page, and are shown as exactly that.
  const openPnl = accounts && unit(accounts).code === null ? Number(accounts.open_pnl ?? 0) : 0;

  return (
    <div className="x-card h-full space-y-4 p-5">
      <h2 className="x-h">Portfolio Allocation</h2>

      {total === 0 ? (
        <p className="py-10 text-center text-sm text-slate-ink">
          Nothing held yet. This fills in once the account is funded.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <Donut groups={groups} total={total} format={fmt} />
          <ul className="min-w-40 flex-1 space-y-2">
            {groups.map((g) => (
              <li key={g.name} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: g.colour }} aria-hidden />
                <span>{g.name}</span>
                <span className="ml-auto font-mono tabular-nums text-slate-ink">
                  {((g.value / total) * 100).toFixed(1)}%
                </span>
                <span className="w-24 text-right font-mono tabular-nums">{fmt(g.value)}</span>
              </li>
            ))}
            {openPnl !== 0 && (
              <>
                <li className="flex items-center gap-2 border-t border-white/10 pt-2 text-sm">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-mist" aria-hidden />
                  <span>Open P&amp;L</span>
                  <span className={`ml-auto w-24 text-right font-mono tabular-nums ${openPnl < 0 ? 'text-down' : 'text-up'}`}>{openPnl < 0 ? '−' : '+'}{fmt(Math.abs(openPnl))}</span>
                </li>
                <li className="flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2.5 w-2.5 shrink-0" aria-hidden />
                  <span>Total equity</span>
                  <span className="ml-auto w-28 text-right font-mono tabular-nums">{fmt(total + openPnl)}</span>
                </li>
              </>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Arc segments on one circle, drawn with stroke-dasharray so there is no path maths. */
function Donut({ groups, total, format }: {
  groups: { name: string; value: number; colour: string }[]; total: number;
  format: (n: number) => string;
}) {
  const R = 54;
  const C = 2 * Math.PI * R;
  let offset = 0;

  return (
    <svg viewBox="0 0 140 140" width="170" height="170" role="img"
      aria-label={groups.map((g) => `${g.name} ${((g.value / total) * 100).toFixed(0)}%`).join(', ')}>
      <g transform="rotate(-90 70 70)">
        {groups.map((g) => {
          const len = (g.value / total) * C;
          const dash = <circle key={g.name} cx="70" cy="70" r={R} fill="none" stroke={g.colour}
            strokeWidth="16" className="ring-draw" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return dash;
        })}
      </g>
      <text x="70" y="66" textAnchor="middle"
        className="fill-slate-ink font-mono text-[9px] tracking-[0.14em] uppercase">Total</text>
      <text x="70" y="82" textAnchor="middle"
        className="fill-current font-mono text-[13px] font-medium">{format(total)}</text>
    </svg>
  );
}

/**
 * The same figures the cards above state, with their counterpart alongside.
 *
 * Every P&L and every earning appears in two places on this page. Each place used to show
 * one half of it — a proportion at the top, an amount at the bottom — so the two read as
 * unrelated numbers. Each now carries both, from the same fetch, so a reader can see that
 * −0.11% and −$139,486.60 are one fact rather than two.
 */
function Breakdown({ perf, openPnl, openPct }: {
  perf?: Performance | null; openPnl: number; openPct: number | null;
}) {
  const cell = (label: string, value: string, note?: string, tone?: 'up' | 'down') => (
    <div className="rounded-lg border border-pebble p-3 dark:border-white/10">
      <p className="metric-label">{label}</p>
      <p className={`mt-1 font-mono text-lg leading-tight font-medium tabular-nums ${
        tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : ''}`}>
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-slate-ink">{note}</p>}
    </div>
  );

  return (
    <div className={`${card} space-y-4`}>
      <h2 className="section-title">Result</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {cell('Earned', perf ? signed(perf.earned) : '—',
          `${perf && perf.pct !== null ? `${pct(perf.pct)} · ` : ''}Trading, interest and rewards`,
          perf && perf.earned < 0 ? 'down' : 'up')}
        {cell('Open P&L', signed(openPnl),
          `${openPct === null ? '' : `${pct(openPct)} · `}On positions still held`,
          openPnl < 0 ? 'down' : 'up')}
        {cell('Best day', perf?.best ? signed(perf.best.earned) : '—',
          perf?.best ? day(perf.best.day) : 'Nothing earned yet', 'up')}
        {cell('Worst day', perf?.worst ? signed(perf.worst.earned) : '—',
          perf?.worst ? day(perf.worst.day) : 'No losing day', perf?.worst ? 'down' : undefined)}
      </div>
    </div>
  );
}

