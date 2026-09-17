import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { alertBox, card, PageTitle } from './App.tsx';
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
};
type Position = { symbol: string; qty: number; avg_price: number; price: number; unrealized: number };
type Point = { day: string; earned: number; cumulative: number; moved_in: number; moved_out: number };
type Performance = {
  days: number; series: Point[]; earned: number; pct: number | null;
  opening: number; equity: number; unpriced: string[];
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
  const openPnl = held.reduce((n, p) => n + Number(p.unrealized), 0);
  // Margin is what the leverage is actually carrying, not what it could.
  const exposure = held.reduce((n, p) => n + Math.abs(Number(p.qty)) * Number(p.price), 0);
  const margin = a?.leverage ? exposure / Number(a.leverage) : exposure;

  // The same rule the balance strip uses, from the same endpoint, so the two cannot
  // disagree about what somebody has: one currency is reported as itself, several convert.
  const openPct = a?.open_pct ?? null;
  const acc = accounts.data;
  const u = acc ? unit(acc) : null;
  const native = u?.code ?? null;
  const cashHeld = acc && native
    ? acc.cash.filter((x) => x.currency === native).reduce((n, x) => n + Number(x.balance), 0)
    : null;

  if (account.error) return <p role="alert" className={alertBox}>{account.error}</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Overview</PageTitle>
        <LiveBadge />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* On a single currency this is that currency's own total, taken from /accounts —
            the same number and the same unit as the strip above. Converting one currency
            into dollars showed a figure the client never held. */}
        <StatCard label="Total equity" icon="◈" i={0}
          format={native && acc ? headline(acc).format : usd}
          count={native && acc ? headline(acc).value
            : perf.data ? perf.data.equity : a ? Number(a.equity) : null}
          note={native ? `Everything held, in ${native}` : 'Everything held, valued in dollars'} />
        {/* A proportion of what the open positions cost, computed server-side so this and
            the balance strip cannot arrive at it two different ways. A null basis is a
            dash, not a skeleton: the card is loaded, there is simply nothing open. */}
        <StatCard label="Open P&L" icon="↗" i={1}
          format={(n) => (openPct === null ? '—' : pct(n))}
          count={a ? openPct ?? 0 : null}
          tone={openPct === null ? undefined : openPct < 0 ? 'down' : 'up'}
          note={`${held.length} position${held.length === 1 ? '' : 's'} open`} />
        {/* /account is one account. A client whose cash is in GBP was shown the balance of
            an empty USD one, which read $0.00 while they held 222 GBP. Where there is a
            single currency, this is their cash in it. */}
        <StatCard label="Available" icon="≡" i={2}
          format={native && u ? u.format : usd}
          count={cashHeld ?? (a ? Number(a.balance) : null)}
          note={native ? `Cash in ${native}` : a ? `Cash in ${a.currency}` : ''} />
        <StatCard label="Margin used" icon="⊞" i={3} format={usd}
          count={a ? margin : null}
          note={a ? `${a.leverage}× on ${usd(exposure)} exposure` : ''} />
      </div>

      <div className={`${card} grain enter space-y-4`} style={{ '--i': 5 } as CSSProperties}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <h2 className="section-title">Earnings</h2>
            {/* The proportion leads, not the amount: the amount is in dollars whatever the
                account holds, and pct is already null when there was nothing to earn on —
                a percentage of an opening balance of zero is not a return. */}
            {perf.data ? (
              <p className="mt-1 flex flex-wrap items-baseline gap-2">
                <span className={`font-mono text-2xl leading-none font-medium tabular-nums ${
                  perf.data.pct === null ? 'text-slate-ink'
                    : perf.data.earned < 0 ? 'text-down' : 'text-up'}`}>
                  {perf.data.pct === null ? '—' : pct(perf.data.pct)}
                </span>
                <span className="text-xs text-slate-ink">
                  over the last {range.label === '1W' ? 'week'
                    : range.label === '1M' ? 'month'
                    : range.label === '3M' ? 'three months' : 'year'}
                </span>
              </p>
            ) : (
              <p className="mt-1 text-sm text-slate-ink">Loading…</p>
            )}
          </div>

          <div role="tablist" aria-label="Range" className="ml-auto flex gap-1 rounded-full bg-bone p-0.5 dark:bg-white/10">
            {RANGES.map((r) => (
              <button key={r.label} role="tab" aria-selected={range.label === r.label}
                onClick={() => setRange(r)}
                className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                  range.label === r.label
                    ? 'bg-ember text-graphite'
                    : 'text-slate-ink hover:text-obsidian dark:text-mist dark:hover:text-vellum'}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <EarningsChart points={perf.data?.series ?? []} />

        <p className="text-xs text-slate-ink">
          Realised trading results, interest credited into savings and staking rewards, each
          on the day it happened. It is what the account has earned, not what it has been
          worth — nothing here keeps a daily valuation of open positions.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="enter" style={{ '--i': 6 } as CSSProperties}>
          <Allocation accounts={accounts.data} />
        </div>
        <div className="enter" style={{ '--i': 7 } as CSSProperties}>
          <Breakdown perf={perf.data} openPnl={openPnl} />
        </div>
      </div>
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
    ].filter((g) => g.value > 0);
  }, [accounts]);

  const total = groups.reduce((n, g) => n + g.value, 0);

  return (
    <div className={`${card} space-y-4`}>
      <h2 className="section-title">Allocation</h2>

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
    <svg viewBox="0 0 140 140" width="140" height="140" role="img"
      aria-label={groups.map((g) => `${g.name} ${((g.value / total) * 100).toFixed(0)}%`).join(', ')}>
      <g transform="rotate(-90 70 70)">
        {groups.map((g) => {
          const len = (g.value / total) * C;
          const dash = <circle key={g.name} cx="70" cy="70" r={R} fill="none" stroke={g.colour}
            strokeWidth="18" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
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

function Breakdown({ perf, openPnl }: { perf?: Performance | null; openPnl: number }) {
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
          'Trading, interest and rewards', perf && perf.earned < 0 ? 'down' : 'up')}
        {cell('Open P&L', signed(openPnl), 'On positions still held',
          openPnl < 0 ? 'down' : 'up')}
        {cell('Best day', perf?.best ? signed(perf.best.earned) : '—',
          perf?.best ? day(perf.best.day) : 'Nothing earned yet', 'up')}
        {cell('Worst day', perf?.worst ? signed(perf.worst.earned) : '—',
          perf?.worst ? day(perf.worst.day) : 'No losing day', perf?.worst ? 'down' : undefined)}
      </div>
    </div>
  );
}

