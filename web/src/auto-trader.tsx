import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, CircleCheck, CircleStop, Gauge, Layers, OctagonX, Percent, Power, Scale,
  ShieldAlert, Sparkles, TrendingDown, Zap,
} from 'lucide-react';
import { alertBox, PageTitle } from './App.tsx';
import { api, useApi } from './api.ts';
import { useCountUp } from './count-up.ts';
import { price } from './format.ts';
import { Coin } from './landing.tsx';
import { StatTile } from './x-shell.tsx';

/**
 * The auto trader, for real.
 *
 * Everything on this page is read from the book. The bot's orders are orders: they fill,
 * move the position and realise onto the balance like the client's own, marked with the
 * strategy that decided them and the reason it gave. So a number here is money that moved,
 * not a demonstration — which is why the page says plainly what it costs to be wrong: risk
 * per trade, a daily loss budget with how much of it is spent, and a kill switch that
 * closes everything.
 *
 * The page leads with the engine itself: a dial that sweeps while the bot is working, the
 * equity it has made, and the decisions it is taking as they happen. Motion here is only
 * ever the bot doing something — a sweep while it runs, a line arriving when it trades, a
 * figure flashing when a price moves it.
 */

type Strategy = {
  id: string; kind: 'trend' | 'mean_reversion' | 'grid'; name: string; symbols: string[];
  allocation: number; state: 'running' | 'paused'; about: string;
  open: number; realised: number; closed: number; win_rate: number | null;
};
type Position = {
  id: string; symbol: string; side: 'long' | 'short'; qty: number; entry: number; mark: number;
  stop_loss: number | null; take_profit: number | null; unrealised: number;
  strategy: string | null; opened_at: string; reason: string | null;
};
type Closed = {
  id: string; symbol: string; side: 'long' | 'short'; qty: number; entry: number; exit: number;
  net: number; r: number | null; fees: number; strategy: string | null; exit_reason: string;
  opened_at: string; closed_at: string;
};
type Log = { id: number; at: string; level: 'info' | 'trade' | 'win' | 'loss' | 'warn'; message: string };
type Dash = {
  on: boolean; since: string | null; halted_until: string | null;
  settings: { risk_per_trade: number; max_daily_loss: number | null; daily_profit_target: number | null; max_open_positions: number; max_leverage: number };
  account: { balance: number; currency: string };
  strategies: Strategy[];
  kpis: {
    equity: number; allocated: number; realised: number; unrealised: number; return_pct: number | null;
    today_net: number; today_realised: number; today_trades: number; today_fees: number;
    wins: number; losses: number; closed: number; win_rate: number | null; profit_factor: number | null;
    avg_win_r: number | null; avg_loss_r: number | null; max_drawdown: number; drawdown_at: string | null;
    open: number; daily_loss_used: number;
  };
  curve: { at: string; equity: number }[];
  positions: Position[];
  closed: Closed[];
  log: Log[];
};

// Anything that rounds to zero is shown as zero, unsigned: "−$0.00" is a loss of nothing
// wearing the colour of a loss.
const money = (n: number, sign = false) => {
  const v = Math.abs(n) < 0.005 ? 0 : n;
  return (sign && v > 0 ? '+' : v < 0 ? '−' : '')
    + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pct = (n: number | null, digits = 1) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`);
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const toneOf = (n: number) => (n >= 0.005 ? 'text-up' : n <= -0.005 ? 'text-down' : '');
const base = (symbol: string) => (symbol.length > 3 && symbol.endsWith('USD') ? symbol.slice(0, -3) : symbol);

export function AutoTraderView() {
  const dash = useApi<Dash>('/me/auto-trader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The book moves on its own; the page follows it every few seconds.
  useEffect(() => { const t = setInterval(() => dash.reload(), 5000); return () => clearInterval(t); }, []);

  const d = dash.data;
  const run = async (what: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await what(); dash.reload(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!d) {
    return (
      <div className="mx-auto max-w-[1440px] space-y-4">
        <div className="skeleton h-10 w-64 rounded-lg" />
        <div className="skeleton h-[340px] rounded-xl" />
      </div>
    );
  }
  const k = d.kpis;
  const halted = d.halted_until !== null && new Date(d.halted_until) >= new Date(new Date().toDateString());
  const live = d.on && !halted;
  const watching = [...new Set(d.strategies.filter((s) => s.state === 'running').flatMap((s) => s.symbols))];
  const state = !d.on ? 'Stopped' : halted ? 'Paused for today' : 'Running';

  return (
    <div className="mx-auto max-w-[1440px] space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Auto Trader</PageTitle>
        <span className={`at-state ${live ? 'is-live' : halted ? 'is-halted' : ''}`}>
          <i aria-hidden />{state}
          {live && watching.length > 0 && <span className="font-medium text-mist">watching {watching.length} market{watching.length === 1 ? '' : 's'}</span>}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" role="switch" aria-checked={d.on} disabled={busy}
            onClick={() => run(() => api('/me/auto-trader', { method: 'POST', body: JSON.stringify({ on: !d.on }) }))}
            className={`at-power ${d.on ? 'is-on' : ''}`}>
            <Power size={16} aria-hidden />{busy ? 'Working…' : d.on ? 'Turn off' : 'Turn on'}
          </button>
          <button type="button" disabled={busy || (!d.on && k.open === 0)} className="at-kill"
            onClick={() => {
              if (!window.confirm(`Close ${k.open} open bot position${k.open === 1 ? '' : 's'} at market and stop the auto trader?`)) return;
              run(() => api('/me/auto-trader/kill', { method: 'POST' }));
            }}>
            <OctagonX size={16} aria-hidden />Stop all
          </button>
        </div>
      </div>

      {error && <p role="alert" className={alertBox}>{error}</p>}
      {d.on && !(d.account.balance > 0) && (
        <p className={alertBox}>The account has no balance, so the bot has nothing to trade with. Fund it and the strategies will start.</p>
      )}
      {halted && (
        <p className={alertBox}>Today's loss limit was reached, so the bot opens nothing new until tomorrow. Open positions keep their stops and targets.</p>
      )}

      {/* The engine: what it has made, the line it made it on, and what it is deciding now. */}
      <section className="x-card x-holo at-hero" aria-label="Bot equity">
        <EngineDial live={live} equity={k.equity} ret={k.return_pct} since={d.since} winRate={k.win_rate} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <h2 className="text-[15px] font-semibold">Equity curve</h2>
            <Figure label="Realised" value={money(k.realised, true)} tone={toneOf(k.realised)} />
            <Figure label="Open now" value={money(k.unrealised, true)} tone={toneOf(k.unrealised)} />
            <Figure label="Allocated" value={money(k.allocated)} />
          </div>
          <EquityChart points={d.curve} live={live} />
        </div>
        <LiveFeed log={d.log} live={live} />
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Today" Icon={Zap} value={money(k.today_net, true)} tone={toneOf(k.today_net)}
          note={`${k.today_trades} trade${k.today_trades === 1 ? '' : 's'} closed, ${money(k.today_fees)} in fees`} />
        <StatTile label="Win rate" Icon={Percent} note={`${k.wins} won of ${k.closed} closed`}>
          <div className="mt-3 flex items-center gap-3">
            <Ring value={k.win_rate ?? 0} />
            <span className="text-[22px] leading-none font-bold tabular-nums">{pct(k.win_rate, 0)}</span>
          </div>
        </StatTile>
        <StatTile label="Profit factor" Icon={Scale} value={k.profit_factor === null ? '—' : k.profit_factor.toFixed(2)}
          tone={k.profit_factor !== null && k.profit_factor >= 1 ? 'text-up' : ''}
          note={k.avg_win_r === null && k.avg_loss_r === null ? 'No closed trades yet' : `Average win ${k.avg_win_r?.toFixed(1) ?? '—'}R, loss ${k.avg_loss_r?.toFixed(1) ?? '—'}R`} />
        <StatTile label="Deepest drawdown" Icon={TrendingDown} value={k.max_drawdown ? `−${pct(k.max_drawdown)}` : '0%'}
          tone={k.max_drawdown ? 'text-down' : ''} note={k.drawdown_at ? `On ${day(k.drawdown_at)}` : 'None so far'} />
        <StatTile label="Open positions" Icon={Layers} value={`${k.open} of ${d.settings.max_open_positions}`}
          note={`${money(k.unrealised, true)} unrealised`}>
          <div className="x-meter mt-3"><span style={{ width: `${Math.min(100, (k.open / Math.max(1, d.settings.max_open_positions)) * 100)}%` }} /></div>
        </StatTile>
      </div>

      <section className="space-y-3" aria-label="Strategies">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="section-title">Strategies</h2>
          <span className="text-xs text-slate-ink">Each one trades its own allocation, at up to {d.settings.max_leverage}× leverage.</span>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {d.strategies.map((s) => <StrategyCard key={s.id} s={s} live={live} busy={busy} onChange={run} />)}
        </div>
      </section>

      <section className="x-card space-y-3 p-5" aria-label="Open positions">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="section-title">Open positions</h2>
          <span className={`text-xs ${toneOf(k.unrealised)}`}>{money(k.unrealised, true)} unrealised</span>
          <span className="ml-auto text-xs text-slate-ink">The bar runs from the stop to the target; the dot is the price now.</span>
        </div>
        {d.positions.length === 0
          ? <p className="py-8 text-center text-sm text-slate-ink">{d.on ? 'Nothing open. The strategies are waiting for a setup.' : 'Nothing open.'}</p>
          : <ul className="space-y-2">{d.positions.map((p) => <PositionRow key={p.id} p={p} />)}</ul>}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="x-card min-w-0 space-y-3 p-5" aria-label="Closed trades">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="section-title">Closed trades</h2>
            <span className="text-xs text-slate-ink">{k.closed} in all, {money(k.realised, true)} realised</span>
          </div>
          {d.closed.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-ink">No trade has closed yet.</p>
          ) : (
            <div className="x-table overflow-x-auto"><table className="w-full text-sm">
              <thead className="x-thead"><tr>
                {(['Closed', 'Instrument', 'Side', 'Entry to exit', 'Result', 'R', 'Strategy', 'Exit'] as const).map((h, i) => (
                  <th key={h} className={`px-3 py-2 ${i >= 3 && i <= 5 ? 'text-right' : 'text-left'}`}>{h}</th>))}
              </tr></thead>
              <tbody>{d.closed.map((t) => (
                <tr key={t.id}>
                  <td className="px-3 py-2 text-xs whitespace-nowrap text-slate-ink">{day(t.closed_at)}, {clock(t.closed_at)}</td>
                  <td className="px-3 py-2"><span className="flex items-center gap-2 font-semibold"><span className="x-qcoin" aria-hidden><Coin symbol={t.symbol} /></span>{base(t.symbol)}</span></td>
                  <td className="px-3 py-2"><Side side={t.side} /></td>
                  <td className="px-3 py-2 text-right text-xs whitespace-nowrap tabular-nums text-slate-ink">{price(t.entry)} → {price(t.exit)}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${toneOf(t.net)}`}>{money(t.net, true)}</td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${t.r === null ? 'text-slate-ink' : toneOf(t.r)}`}>{t.r === null ? '—' : `${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R`}</td>
                  <td className="px-3 py-2 text-xs text-slate-ink">{t.strategy ?? '—'}</td>
                  <td className="px-3 py-2"><span className={`x-badge ${t.exit_reason === 'Take profit' ? '' : t.exit_reason === 'Stop loss' || t.exit_reason === 'Daily loss limit' ? 'is-bad' : 'is-muted'}`}>{t.exit_reason}</span></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </section>

        <div className="space-y-4">
          <section className="x-card x-holo space-y-4 p-5" aria-label="Risk controls">
            {/* Read-only here: the limits are the desk's to set, from the client's record. */}
            <div className="flex items-center gap-3">
              <span className="x-chip !size-8" aria-hidden><ShieldAlert size={16} /></span>
              <h2 className="section-title">Risk controls</h2>
            </div>
            <div className="space-y-3.5 text-[13px]">
              <Limit l="Risk per trade" v={`${d.settings.risk_per_trade}% of bot equity`} />
              {d.settings.max_daily_loss !== null && (
                <Limit l="Daily loss budget" v={`${pct(k.daily_loss_used, 0)} used of ${d.settings.max_daily_loss}%`} bar={k.daily_loss_used} warn={k.daily_loss_used > 0.6} />
              )}
              {d.settings.daily_profit_target !== null && (
                <Limit l="Daily profit target" v={`${d.settings.daily_profit_target}% of bot equity`} />
              )}
              <Limit l="Open positions" v={`${k.open} of ${d.settings.max_open_positions}`} bar={k.open / Math.max(1, d.settings.max_open_positions)} />
              <Limit l="Leverage" v={`Up to ${d.settings.max_leverage}×`} />
              <Limit l="Stop all" v="Closes everything at market and turns the bot off" />
            </div>
          </section>

          <EngineLog log={d.log} live={live} busy={busy} on={d.on}
            onEvaluate={() => run(() => api('/me/auto-trader/tick', { method: 'POST' }))} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- the engine

/**
 * The dial: bot equity at its centre, the win rate as the arc around it, and a sweep that
 * turns while the bot is working. Stopped, the sweep stops with it — the one motion on the
 * page that says the engine is on.
 */
function EngineDial({ live, equity, ret, since, winRate }: {
  live: boolean; equity: number; ret: number | null; since: string | null; winRate: number | null;
}) {
  const shown = useCountUp(equity) ?? equity;
  const R = 92, C = 2 * Math.PI * R;
  const ticks = useMemo(() => Array.from({ length: 72 }, (_, i) => i), []);
  return (
    <div className={`at-dial ${live ? 'is-live' : ''}`}>
      <svg viewBox="0 0 220 220" className="at-dial-svg" aria-hidden>
        <defs>
          <linearGradient id="at-arc" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffb066" />
            <stop offset="100%" stopColor="#ff7518" />
          </linearGradient>
        </defs>
        {ticks.map((i) => {
          const a = (i / ticks.length) * Math.PI * 2;
          const long = i % 6 === 0;
          const r1 = long ? 100 : 103, r2 = 107;
          return <line key={i} x1={110 + r1 * Math.sin(a)} y1={110 - r1 * Math.cos(a)} x2={110 + r2 * Math.sin(a)} y2={110 - r2 * Math.cos(a)}
            className={long ? 'at-tick is-long' : 'at-tick'} />;
        })}
        <circle cx="110" cy="110" r={R} className="at-track" />
        <circle cx="110" cy="110" r={R} className="at-arc" stroke="url(#at-arc)"
          strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, winRate ?? 0)))} transform="rotate(-90 110 110)" />
      </svg>
      <div className="at-sweep" aria-hidden />
      <div className="at-dial-core">
        <span className="text-[12px] text-mist">Bot equity</span>
        <span className="mt-1 text-[26px] leading-none font-bold tracking-[-0.02em] tabular-nums">{money(shown)}</span>
        <span className={`at-ret ${ret !== null && ret < 0 ? 'is-down' : ''}`}>
          {ret === null ? 'Nothing allocated' : <>{ret >= 0 ? <ArrowUpRight size={13} aria-hidden /> : <ArrowDownRight size={13} aria-hidden />}{ret >= 0 ? '+' : ''}{pct(ret, 2)}</>}
        </span>
        <span className="mt-2 text-[11.5px] text-mist">{since ? `Trading since ${day(since)}` : 'Not started yet'}</span>
      </div>
      <span className="at-dial-legend"><i aria-hidden />Arc shows the win rate</span>
    </div>
  );
}

const Figure = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => (
  <span className="flex items-baseline gap-2">
    <span className="text-[12px] text-mist">{label}</span>
    <span className={`text-[14px] font-semibold tabular-nums ${tone}`}>{value}</span>
  </span>
);

/** Equity over time: one point per closed trade, the deepest drawdown shaded, now pulsing. */
function EquityChart({ points, live }: { points: { at: string; equity: number }[]; live: boolean }) {
  const W = 760, H = 210;
  const [hover, setHover] = useState<number | null>(null);
  const line = useRef<SVGPathElement>(null);
  useEffect(() => {
    const el = line.current;
    if (el) el.style.setProperty('--len', String(Math.ceil(el.getTotalLength())));
  }, [points.length]);
  if (points.length < 2) {
    return (
      <div className="grid h-[210px] place-items-center text-center">
        <div>
          <span className="x-drop-icon mx-auto" aria-hidden><Sparkles size={22} /></span>
          <p className="mt-3 text-sm font-semibold">The curve starts with the first closed trade</p>
          <p className="mt-1 text-xs text-slate-ink">Every trade the bot closes adds a point here, after fees.</p>
        </div>
      </div>
    );
  }
  const xs = points.map((p) => new Date(p.at).getTime());
  const ys = points.map((p) => p.equity);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.12 || 1;
  const X = (t: number) => (x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * W);
  const Y = (v: number) => H - 12 - ((v - (lo - pad)) / (hi - lo + pad * 2)) * (H - 24);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]!).toFixed(1)} ${Y(p.equity).toFixed(1)}`).join(' ');
  const area = `${path} L ${W} ${H} L 0 ${H} Z`;
  // The deepest drawdown: from the running peak to the trough after it.
  let peak = 0, worst = 0, from = 0, to = 0, runFrom = 0;
  ys.forEach((v, i) => { if (v > ys[peak]!) { peak = i; runFrom = i; } const dd = ys[peak]! - v; if (dd > worst) { worst = dd; from = runFrom; to = i; } });
  const h = hover ?? points.length - 1;
  const up = ys[ys.length - 1]! >= ys[0]!;
  return (
    <div className="relative mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[210px] w-full" role="img"
        aria-label={`Bot equity from ${money(ys[0]!)} to ${money(ys[ys.length - 1]!)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const t = x0 + ((e.clientX - r.left) / r.width) * (x1 - x0);
          let best = 0;
          xs.forEach((x, i) => { if (Math.abs(x - t) < Math.abs(xs[best]! - t)) best = i; });
          setHover(best);
        }}>
        <defs>
          <linearGradient id="at-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? '#ff7518' : '#ff4b4d'} stopOpacity="0.32" />
            <stop offset="100%" stopColor={up ? '#ff7518' : '#ff4b4d'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="at-grid" />)}
        {worst > 0 && <rect x={X(xs[from]!)} y="0" width={Math.max(2, X(xs[to]!) - X(xs[from]!))} height={H} className="at-dd" />}
        <path d={area} fill="url(#at-fill)" className="at-area" />
        <path ref={line} d={path} className="at-line" vectorEffect="non-scaling-stroke" />
        <line x1={X(xs[h]!)} x2={X(xs[h]!)} y1="0" y2={H} className="at-cross" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* The point is drawn outside the stretched SVG so it stays round at any width. */}
      <span className={`at-now ${live && hover === null ? 'is-live' : ''}`}
        style={{ left: `${(X(xs[h]!) / W) * 100}%`, top: `${(Y(ys[h]!) / H) * 210}px` }} aria-hidden />
      <div className="x-tip pointer-events-none absolute -top-1 rounded-md px-2.5 py-1.5 text-[12px]"
        style={{ left: `clamp(0px, calc(${(X(xs[h]!) / W) * 100}% - 70px), calc(100% - 150px))` }}>
        <span className="block text-mist">{day(points[h]!.at)}, {clock(points[h]!.at)}</span>
        <span className="block font-semibold tabular-nums">{money(ys[h]!)}</span>
      </div>
    </div>
  );
}

/** The last few decisions, newest first. A new one slides in when the bot acts. */
function LiveFeed({ log, live }: { log: Log[]; live: boolean }) {
  const recent = log.filter((l) => l.level !== 'info').slice(0, 4);
  return (
    <div className="at-feed" aria-live="polite">
      <span className={`at-feed-tag ${live ? 'is-live' : ''}`}><Activity size={14} aria-hidden />{live ? 'Live' : 'Last moves'}</span>
      {recent.length === 0
        ? <span className="text-[13px] text-slate-ink">{live ? 'Scanning for a setup. Trades appear here the moment they happen.' : 'Turn the bot on and its trades appear here as they happen.'}</span>
        : recent.map((l) => (
          <span key={l.id} className={`at-feed-item is-${l.level}`}>
            <LevelIcon level={l.level} />
            <span className="truncate">{l.message}</span>
            <span className="shrink-0 text-mist">{clock(l.at)}</span>
          </span>
        ))}
    </div>
  );
}

function LevelIcon({ level }: { level: Log['level'] }) {
  const I = level === 'win' ? CircleCheck : level === 'loss' ? CircleStop : level === 'warn' ? ShieldAlert : level === 'trade' ? Zap : Gauge;
  return <I size={14} className="shrink-0" aria-hidden />;
}

function Ring({ value }: { value: number }) {
  const R = 15, C = 2 * Math.PI * R;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r={R} className="at-track" strokeWidth="4" />
      <circle cx="20" cy="20" r={R} fill="none" stroke="var(--color-up)" strokeWidth="4" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, value)))} transform="rotate(-90 20 20)" className="at-ring" />
    </svg>
  );
}

// ---------------------------------------------------------------------------- strategies

/** One strategy: what it trades, what it may spend, and how it has done. Pause, resume, re-allocate. */
function StrategyCard({ s, live, busy, onChange }: {
  s: Strategy; live: boolean; busy: boolean; onChange: (what: () => Promise<unknown>) => Promise<void>;
}) {
  const [alloc, setAlloc] = useState<string | null>(null);
  const patch = (body: Record<string, unknown>) => onChange(() => api(`/me/auto-trader/strategies/${s.id}`, { method: 'PATCH', body: JSON.stringify(body) }));
  const running = s.state === 'running';
  return (
    <article className={`x-card at-strat ${running && live ? 'is-live' : ''}`} style={{ '--k': s.kind === 'trend' ? 0 : s.kind === 'grid' ? 2 : 1 } as CSSProperties}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold">{s.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-slate-ink">{s.about}</p>
        </div>
        <button type="button" role="switch" aria-checked={running} aria-label={`${s.name} ${running ? 'running' : 'paused'}`} disabled={busy}
          className={`at-switch ${running ? 'is-on' : ''}`} onClick={() => patch({ state: running ? 'paused' : 'running' })}>
          <span aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {s.symbols.map((sym) => (
          <span key={sym} className="at-sym"><span className="x-qcoin" aria-hidden><Coin symbol={sym} /></span>{base(sym)}</span>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[12px] text-mist">Result</dt>
          <dd className={`mt-1 text-[16px] font-bold tabular-nums ${toneOf(s.realised)}`}>{money(s.realised, true)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mist">Trades</dt>
          <dd className="mt-1 text-[16px] font-bold tabular-nums">{s.closed}<span className="ml-1 text-[12px] font-normal text-mist">{s.open} open</span></dd>
        </div>
        <div>
          <dt className="text-[12px] text-mist">Allocation</dt>
          <dd className="mt-1">
            {alloc === null ? (
              <button type="button" className="text-[16px] font-bold tabular-nums underline decoration-mist/40 decoration-dotted underline-offset-4 hover:decoration-ember"
                onClick={() => setAlloc(String(s.allocation))} title="Change the allocation">{money(s.allocation).replace('.00', '')}</button>
            ) : (
              <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); patch({ allocation: Number(alloc) }).then(() => setAlloc(null)); }}>
                <input value={alloc} onChange={(e) => setAlloc(e.target.value)} inputMode="decimal" autoFocus
                  className="x-field w-24 !px-2 !py-1 text-sm" aria-label={`Allocation for ${s.name}`} />
                <button className="x-btn-sm !h-auto !px-2" disabled={busy}>Save</button>
              </form>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <div className="flex justify-between text-[12px]"><span className="text-mist">Win rate</span><span className="font-semibold tabular-nums">{pct(s.win_rate, 0)}</span></div>
        <div className="at-win mt-1.5"><span style={{ width: `${(s.win_rate ?? 0) * 100}%` }} /></div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------- positions

/**
 * One open position, with where it stands between its stop and its target. That track is
 * the question a client asks of an open trade — how close is it to being stopped out, how
 * close to paying — answered without reading three prices.
 */
function PositionRow({ p }: { p: Position }) {
  const last = useRef(p.unrealised);
  const [flash, setFlash] = useState<'' | 'up' | 'down'>('');
  useEffect(() => {
    if (p.unrealised === last.current) return;
    setFlash(p.unrealised > last.current ? 'up' : 'down');
    last.current = p.unrealised;
    const t = setTimeout(() => setFlash(''), 900);
    return () => clearTimeout(t);
  }, [p.unrealised]);

  const hasTrack = p.stop_loss !== null && p.take_profit !== null && p.stop_loss !== p.take_profit;
  // Along the track from the stop (0) to the target (1), whichever way round the trade is.
  const along = (v: number) => (hasTrack ? Math.max(0, Math.min(1, (v - p.stop_loss!) / (p.take_profit! - p.stop_loss!))) : 0.5);
  const mark = along(p.mark), entry = along(p.entry);

  return (
    <li className={`at-pos ${flash ? `is-${flash}` : ''}`}>
      <span className="flex min-w-0 items-center gap-3">
        <span className="x-qcoin !size-8" aria-hidden><Coin symbol={p.symbol} /></span>
        <span className="min-w-0">
          <span className="flex items-center gap-2"><span className="font-semibold">{base(p.symbol)}</span><Side side={p.side} /></span>
          <span className="block truncate text-xs text-slate-ink">{p.qty} at {price(p.entry)}, {p.strategy ?? 'bot'}, {clock(p.opened_at)}</span>
        </span>
      </span>
      <span className="min-w-0">
        {hasTrack ? (
          <>
            <span className="at-track-bar" aria-label={`Price ${price(p.mark)}, stop ${price(p.stop_loss!)}, target ${price(p.take_profit!)}`}>
              <span className="at-track-fill" style={{ left: `${Math.min(entry, mark) * 100}%`, width: `${Math.abs(mark - entry) * 100}%` }} data-good={mark >= entry ? '1' : '0'} />
              <span className="at-track-entry" style={{ left: `${entry * 100}%` }} />
              <span className="at-track-mark" style={{ left: `${mark * 100}%` }} />
            </span>
            <span className="mt-1.5 flex justify-between text-[11.5px] tabular-nums">
              <span className="text-down">Stop {price(p.stop_loss!)}</span>
              <span className="text-mist">Now {price(p.mark)}</span>
              <span className="text-up">Target {price(p.take_profit!)}</span>
            </span>
          </>
        ) : <span className="text-xs text-slate-ink">Now {price(p.mark)}</span>}
      </span>
      <span className={`text-right text-[16px] font-bold tabular-nums ${toneOf(p.unrealised)}`}>{money(p.unrealised, true)}</span>
    </li>
  );
}

function Side({ side }: { side: 'long' | 'short' }) {
  return <span className={`at-side ${side === 'long' ? 'is-long' : 'is-short'}`}>{side === 'long' ? 'Long' : 'Short'}</span>;
}

// ---------------------------------------------------------------------------- the rest

function Limit({ l, v, bar, warn }: { l: string; v: string; bar?: number; warn?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3"><span className="text-slate-ink">{l}</span><span className="text-right font-medium">{v}</span></div>
      {bar !== undefined && (
        <div className={`x-meter ${warn ? 'is-warn' : ''}`} aria-hidden><span style={{ width: `${Math.min(100, Math.max(0, bar * 100))}%` }} /></div>
      )}
    </div>
  );
}

/** Everything the engine said, newest first, the way a terminal shows it. */
function EngineLog({ log, live, busy, on, onEvaluate }: { log: Log[]; live: boolean; busy: boolean; on: boolean; onEvaluate: () => void }) {
  return (
    <section className="x-card space-y-3 p-5" aria-label="Engine log">
      <div className="flex items-center gap-3">
        <span className="x-chip !size-8" aria-hidden><Activity size={16} /></span>
        <h2 className="section-title">Engine log</h2>
        <span className={`ml-auto h-2 w-2 rounded-full ${live ? 'nav-live bg-up' : 'bg-slate-ink'}`} aria-hidden />
        {on && <button type="button" className="x-btn-sm" disabled={busy} onClick={onEvaluate}>Check markets now</button>}
      </div>
      {log.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-ink">Nothing yet.</p>
      ) : (
        <ol className="at-log">
          {log.map((l) => (
            <li key={l.id} className={`is-${l.level}`}>
              <span className="shrink-0 tabular-nums text-mist">{clock(l.at)}</span>
              <LevelIcon level={l.level} />
              <span className="min-w-0">{l.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
