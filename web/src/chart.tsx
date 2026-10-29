import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarSeries, CandlestickSeries, HistogramSeries, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import {
  BarChart3, CandlestickChart, Columns2, Eraser, Grid2x2, LineChart, Minus, MousePointer2, Ratio, Search, Square, TrendingUp,
} from 'lucide-react';
import { grouped, PageTitle } from './App.tsx';
import { Coin } from './landing.tsx';
import { FundamentalsCard } from './fundamentals.tsx';

import { api, useApi } from './api.ts';
import { useFeed } from './feed.ts';
import { bollinger, ema, macd, rsi, sma } from './indicators.ts';


export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Instrument = { symbol: string; display_name: string; asset_class: string | null };
type Quote = { symbol: string; price: number; change: number; change_pct: number };

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'] as const;
const TF_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800,
} as const;
const TYPES = ['candlestick', 'line', 'bar'] as const;
const OVERLAYS = ['MA', 'EMA', 'BB'] as const;   // drawn on the price pane
const PANELS = ['RSI', 'MACD'] as const;         // drawn in their own pane
type Indicator = (typeof OVERLAYS)[number] | (typeof PANELS)[number];
type Tool = 'none' | 'trend' | 'hline' | 'fib';

type Point = { time: number; price: number };
type Drawing =
  | { kind: 'trend'; a: Point; b: Point }
  | { kind: 'fib'; a: Point; b: Point }
  | { kind: 'hline'; a: Point };

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// The chart is the one place a chart library needs literal colours rather than classes, so
// the tokens are repeated here as hex. Keep these in step with src/index.css.
// Only two chromatic values appear: up/down (the sanctioned money-delta exception) and
// ember for the single most important overlay. Every other series is neutral grey.
const theme = (dark: boolean) => dark
  ? { bg: 'rgba(0,0,0,0)', text: '#8b93a1', grid: 'rgba(255,255,255,0.05)', up: '#2cba60', down: '#ff4d4f',
      line: '#ff7817', draw: '#ff7817', accent: '#ff7817', muted: '#71717a', faint: '#3f3f46' }
  : { bg: 'rgba(0,0,0,0)', text: '#71717a', grid: '#eef0f3', up: '#116a32', down: '#af1b1b',
      line: '#ff7817', draw: '#ff7817', accent: '#ff7817', muted: '#71717a', faint: '#a1a1aa' };

/** Pair indicator output with bar times, dropping the leading nulls the chart can't plot. */
const series = (bars: Candle[], values: (number | null)[]) =>
  bars.flatMap((b, i) => values[i] === null || values[i] === undefined
    ? [] : [{ time: b.time as UTCTimestamp, value: values[i]! }]);

// ------------------------------------------------------------------ panel

function ChartPanel({ instruments, dark, symbol, onSymbol, quote }: {
  instruments: Instrument[]; dark: boolean; symbol: string; onSymbol: (s: string) => void; quote?: Quote;
}) {
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('1H');
  const [type, setType] = useState<(typeof TYPES)[number]>('line');
  const [on, setOn] = useState<Indicator[]>(['MA']);
  const [tool, setTool] = useState<Tool>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const pending = useRef<Point | null>(null);   // first click of a two-point drawing
  const [awaiting, setAwaiting] = useState(false);
  const [, redraw] = useState(0);

  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<'Candlestick' | 'Line' | 'Bar'> | null>(null);
  // Set when the chart is built, so the tick handler doesn't have to know the series type.
  const push = useRef<((b: Candle) => void) | null>(null);
  const forming = useRef<Candle | null>(null);   // the bar currently being filled by ticks
  const bars = useApi<Candle[]>(`/candles?symbol=${symbol}&tf=${tf}&limit=500`);
  const toggle = (i: Indicator) => setOn((v) => v.includes(i) ? v.filter((x) => x !== i) : [...v, i]);

  // Rebuild on any change. A chart is cheap to recreate; incremental diffing is not.
  useEffect(() => {
    if (!box.current || !bars.data?.length) return;
    const c = theme(dark);
    const data = bars.data;
    const closes = data.map((b) => b.close);

    const ch = createChart(box.current, {
      layout: { background: { color: c.bg }, textColor: c.text, attributionLogo: false },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.grid },
      timeScale: { borderColor: c.grid, timeVisible: tf !== '1D' && tf !== '1W' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chart.current = ch;

    if (type === 'candlestick') {
      const s = ch.addSeries(CandlestickSeries, {
        upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down,
      });
      s.setData(data.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
      price.current = s;
      push.current = (b) => s.update({ ...b, time: b.time as UTCTimestamp });
    } else if (type === 'bar') {
      const s = ch.addSeries(BarSeries, { upColor: c.up, downColor: c.down });
      s.setData(data.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
      price.current = s;
      push.current = (b) => s.update({ ...b, time: b.time as UTCTimestamp });
    } else {
      const s = ch.addSeries(LineSeries, { color: c.line, lineWidth: 2 });
      s.setData(data.map((b) => ({ time: b.time as UTCTimestamp, value: b.close })));
      price.current = s;
      push.current = (b) => s.update({ time: b.time as UTCTimestamp, value: b.close });
    }
    forming.current = { ...data[data.length - 1]! };

    if (on.includes('MA')) ch.addSeries(LineSeries, { color: c.accent, lineWidth: 1, priceLineVisible: false })
      .setData(series(data, sma(closes, 20)));
    if (on.includes('EMA')) ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false })
      .setData(series(data, ema(closes, 50)));
    if (on.includes('BB')) {
      const bb = bollinger(closes, 20, 2);
      for (const band of [bb.upper, bb.mid, bb.lower]) {
        ch.addSeries(LineSeries, { color: c.faint, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(series(data, band));
      }
    }

    let pane = 1;
    if (on.includes('RSI')) {
      const s = ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false }, pane);
      s.setData(series(data, rsi(closes, 14)));
      // 30/70 reference lines, the levels traders actually read RSI against
      for (const level of [30, 70]) s.createPriceLine({ price: level, color: c.grid, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      ch.panes()[pane]?.setHeight(90);
      pane++;
    }
    if (on.includes('MACD')) {
      const m = macd(closes);
      ch.addSeries(HistogramSeries, { color: c.text, priceLineVisible: false }, pane)
        .setData(series(data, m.hist).map((p) => ({ ...p, color: p.value >= 0 ? c.up : c.down })));
      ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false }, pane)
        .setData(series(data, m.line));
      ch.addSeries(LineSeries, { color: c.faint, lineWidth: 1, priceLineVisible: false }, pane)
        .setData(series(data, m.signal));
      ch.panes()[pane]?.setHeight(90);
    }

    // autoSize picks the container width up in its own ResizeObserver callback, so a
    // synchronous fitContent() here fits to a stale width and leaves the bars bunched
    // into one corner. Fit on the next frame, and again whenever the box resizes.
    // ponytail: a resize therefore resets the user's zoom — fine until someone complains.
    const fit = () => ch.timeScale().fitContent();
    requestAnimationFrame(fit);
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);

    // The drawing overlay is positioned from chart coordinates, so it must repaint
    // whenever the visible range moves.
    const bump = () => redraw((n) => n + 1);
    ch.timeScale().subscribeVisibleLogicalRangeChange(bump);
    bump();

    return () => { ro.disconnect(); ch.remove(); chart.current = null; price.current = null; push.current = null; };
  }, [bars.data, type, on, dark, tf, symbol]);

  // Live ticks extend the bar currently forming, and roll to a new one when the
  // timeframe's bucket advances — the same thing a real feed does.
  useFeed((ticks) => {
    const tick = ticks.find((t) => t.symbol === symbol);
    const bar = forming.current;
    if (!tick || !bar || !push.current) return;
    const step = TF_SECONDS[tf];
    const bucket = Math.floor(Date.now() / 1000 / step) * step;
    if (bucket > bar.time) {
      forming.current = { time: bucket, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: 0 };
    } else {
      bar.close = tick.price;
      bar.high = Math.max(bar.high, tick.price);
      bar.low = Math.min(bar.low, tick.price);
    }
    push.current(forming.current!);
  }, [symbol, tf, type, bars.data]);

  // Click-to-draw. Two clicks for a trendline or fib, one for a horizontal level.
  // The first point lives in a ref, not state: two clicks in quick succession would
  // both read a stale `pending` from the closure and the first point would be lost.
  useEffect(() => {
    const ch = chart.current, s = price.current;
    if (!ch || !s || tool === 'none') return;
    const onClick = (p: { time?: unknown; point?: { x: number; y: number } }) => {
      if (!p.point || p.time === undefined) return;
      const value = s.coordinateToPrice(p.point.y);
      if (value === null) return;
      const at: Point = { time: Number(p.time), price: value };
      if (tool === 'hline') return setDrawings((d) => [...d, { kind: 'hline', a: at }]);
      const first = pending.current;
      if (!first) {
        pending.current = at;
        setAwaiting(true);
        return;
      }
      pending.current = null;
      setAwaiting(false);
      setDrawings((d) => [...d, { kind: tool, a: first, b: at }]);
    };
    ch.subscribeClick(onClick);
    return () => ch.unsubscribeClick(onClick);
  }, [tool]);

  const xy = useCallback((p: Point) => {
    const ch = chart.current, s = price.current;
    if (!ch || !s) return null;
    const x = ch.timeScale().timeToCoordinate(p.time as UTCTimestamp);
    const y = s.priceToCoordinate(p.price);
    return x === null || y === null ? null : { x, y };
  }, []);

  const width = box.current?.clientWidth ?? 0;

  return (
    <div className="ch-card flex h-[440px] shrink-0 flex-col lg:h-auto lg:min-h-0 lg:shrink">
      <div className="ch-head">
        <span className="ch-coin" aria-hidden><Coin symbol={symbol} /></span>
        <label className="min-w-0">
          <span className="sr-only">Market</span>
          <select className="ch-symbol" value={symbol} onChange={(e) => onSymbol(e.target.value)}>
            {grouped(instruments).map(([label, items]) => (
              <optgroup key={label} label={label}>
                {items.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
              </optgroup>
            ))}
          </select>
          <span className="block truncate text-[11px] text-slate-ink">{instruments.find((i) => i.symbol === symbol)?.display_name ?? ''}</span>
        </label>
        {quote && (
          <span className="ml-1 flex items-baseline gap-2">
            <span className="text-[17px] font-bold tabular-nums">{quote.price.toLocaleString('en-US', { maximumFractionDigits: quote.price < 10 ? 5 : 2 })}</span>
            <span className={`ch-chg ${quote.change >= 0 ? 'is-up' : 'is-down'}`}>{quote.change >= 0 ? '▲' : '▼'} {Math.abs(quote.change_pct).toFixed(2)}%</span>
          </span>
        )}
        <div role="radiogroup" aria-label="Timeframe" className="ch-seg ml-auto">
          {TIMEFRAMES.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={tf === f} onClick={() => setTf(f)} className={tf === f ? 'is-on' : ''}>{f}</button>
          ))}
        </div>
      </div>

      <div className="ch-tools">
        <div role="radiogroup" aria-label="Chart type" className="ch-seg">
          {TYPES.map((t) => {
            const Icon = t === 'candlestick' ? CandlestickChart : t === 'line' ? LineChart : BarChart3;
            return (
              <button key={t} type="button" role="radio" aria-checked={type === t} title={t} aria-label={t} onClick={() => setType(t)} className={type === t ? 'is-on' : ''}>
                <Icon size={14} aria-hidden />
              </button>
            );
          })}
        </div>
        <span className="ch-sep" aria-hidden />
        <div className="flex flex-wrap gap-1" aria-label="Indicators">
          {[...OVERLAYS, ...PANELS].map((i) => (
            <button key={i} type="button" onClick={() => toggle(i)} aria-pressed={on.includes(i)} className={`ch-chip ${on.includes(i) ? 'is-on' : ''}`}>{i}</button>
          ))}
        </div>
        <span className="ch-sep" aria-hidden />
        <div className="ch-seg" role="radiogroup" aria-label="Drawing tool">
          {(['none', 'trend', 'hline', 'fib'] as Tool[]).map((t) => {
            const Icon = t === 'none' ? MousePointer2 : t === 'trend' ? TrendingUp : t === 'hline' ? Minus : Ratio;
            const label = t === 'none' ? 'Cursor' : t === 'trend' ? 'Trend line' : t === 'hline' ? 'Horizontal line' : 'Fibonacci';
            return (
              <button key={t} type="button" role="radio" aria-checked={tool === t} title={label} aria-label={label}
                onClick={() => { setTool(t); pending.current = null; setAwaiting(false); }} className={tool === t ? 'is-on' : ''}>
                <Icon size={14} aria-hidden />
              </button>
            );
          })}
        </div>
        {drawings.length > 0 && (
          <button type="button" className="ch-chip inline-flex items-center gap-1" title="Clear drawings"
            onClick={() => { setDrawings([]); pending.current = null; setAwaiting(false); }}>
            <Eraser size={12} aria-hidden />Clear
          </button>
        )}
        {awaiting && <span className="text-[11.5px] font-semibold text-ember-ink">Click the second point…</span>}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" />
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
          {drawings.map((d, i) => {
            const a = xy(d.a);
            if (!a) return null;
            const c = theme(dark).draw;
            if (d.kind === 'hline') {
              return <g key={i}>
                <line x1={0} y1={a.y} x2={width} y2={a.y} stroke={c} strokeWidth={1} strokeDasharray="4 3" />
                <text x={4} y={a.y - 4} fill={c} fontSize={10}>{d.a.price.toPrecision(6)}</text>
              </g>;
            }
            const b = xy(d.b);
            if (!b) return null;
            if (d.kind === 'trend') return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={1.5} />;
            return <g key={i}>
              {FIB.map((f) => {
                const y = a.y + (b.y - a.y) * f;
                const level = d.a.price + (d.b.price - d.a.price) * f;
                return <g key={f}>
                  <line x1={Math.min(a.x, b.x)} y1={y} x2={width} y2={y} stroke={c} strokeWidth={1} opacity={0.7} />
                  <text x={Math.min(a.x, b.x) + 4} y={y - 3} fill={c} fontSize={10}>
                    {f} · {level.toPrecision(6)}
                  </text>
                </g>;
              })}
            </g>;
          })}
        </svg>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- live quotes

/**
 * Every instrument's price, kept live: the REST snapshot once, then each tick. The previous
 * bar's close comes from the snapshot, because ticks only carry the current price. Shared
 * by the watchlist and every chart's header, so the two can never show different prices.
 */
function useLiveQuotes() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const base = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});

  useEffect(() => {
    api<Quote[]>('/quotes').then((qs) => {
      base.current = Object.fromEntries(qs.map((q) => [q.symbol, q.price - q.change]));
      setQuotes(qs);
    }).catch(() => {});
  }, []);

  useFeed((ticks) => {
    setQuotes((prev) => {
      const now = new Map(ticks.map((t) => [t.symbol, t.price]));
      const dir: Record<string, 'up' | 'down'> = {};
      const next = prev.map((q) => {
        const price = now.get(q.symbol);
        if (price === undefined || price === q.price) return q;
        dir[q.symbol] = price > q.price ? 'up' : 'down';
        const prevClose = base.current[q.symbol] ?? price;
        return {
          ...q, price,
          change: Number((price - prevClose).toFixed(8)),
          change_pct: Number((((price - prevClose) / prevClose) * 100).toFixed(3)),
        };
      });
      setFlash(dir);
      return next;
    });
  }, []);

  return { quotes, flash };
}

// ----------------------------------------------------------------- watchlist

const CLASS_LABEL: Record<string, string> = { crypto: 'Crypto', forex: 'FX', fx: 'FX', metal: 'Metals', metals: 'Metals', commodity: 'Metals', index: 'Indices', etf: 'ETFs', stock: 'Stocks', equity: 'Stocks' };

function Watchlist({ quotes, flash, instruments, active, onPick }: {
  quotes: Quote[]; flash: Record<string, 'up' | 'down'>; instruments: Instrument[]; active: string; onPick: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [cls, setCls] = useState('all');
  const info = new Map(instruments.map((i) => [i.symbol, i]));
  const classes = [...new Set(instruments.map((i) => CLASS_LABEL[i.asset_class ?? ''] ?? 'Other'))].filter((c) => c !== 'Other');
  const term = q.trim().toLowerCase();
  const rows = quotes.filter((x) => {
    const i = info.get(x.symbol);
    if (cls !== 'all' && (CLASS_LABEL[i?.asset_class ?? ''] ?? 'Other') !== cls) return false;
    return !term || x.symbol.toLowerCase().includes(term) || (i?.display_name ?? '').toLowerCase().includes(term);
  });

  return (
    // The frame keeps its height and the rows move inside it: header pinned, list scrolling
    // under it, and the whole thing bounded by the column rather than by how many
    // instruments happen to be listed.
    <div className="ch-card flex max-h-80 min-h-0 flex-1 flex-col overflow-hidden lg:max-h-none">
      <div className="shrink-0 space-y-2 border-b border-white/5 p-3 [html:not(.dark)_&]:border-pebble">
        <div className="flex items-center gap-2">
          <h2 className="section-title">Watchlist</h2>
          <span className="ml-auto text-[11px] tabular-nums text-slate-ink">{rows.length}</span>
        </div>
        <label className="ch-search">
          <Search size={13} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" aria-label="Search markets" />
        </label>
        {classes.length > 1 && (
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Asset class">
            {['all', ...classes].map((c) => (
              <button key={c} type="button" role="tab" aria-selected={cls === c} onClick={() => setCls(c)} className={`ch-chip shrink-0 ${cls === c ? 'is-on' : ''}`}>
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {rows.map((x) => (
          <li key={x.symbol}>
            <button type="button" onClick={() => onPick(x.symbol)} className={`ch-row ${x.symbol === active ? 'is-active' : ''}`}>
              <span className="ch-coin is-sm" aria-hidden><Coin symbol={x.symbol} /></span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[12.5px] font-semibold">{x.symbol}</span>
                <span className="block truncate text-[10.5px] text-slate-ink">{info.get(x.symbol)?.display_name ?? ''}</span>
              </span>
              <span className="text-right">
                <span className={`block text-[12.5px] font-semibold tabular-nums transition-colors ${flash[x.symbol] === 'up' ? 'text-up' : flash[x.symbol] === 'down' ? 'text-down' : ''}`}>
                  {x.price.toLocaleString('en-US', { maximumFractionDigits: x.price < 10 ? 5 : 2 })}
                </span>
                <span className={`ch-chg is-xs ${x.change >= 0 ? 'is-up' : 'is-down'}`}>{x.change >= 0 ? '+' : ''}{x.change_pct.toFixed(2)}%</span>
              </span>
            </button>
          </li>
        ))}
        {!rows.length && <li className="px-3 py-6 text-center text-xs text-slate-ink">{quotes.length ? 'Nothing matches.' : 'Loading markets…'}</li>}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------------- view

const LAYOUTS = [[1, Square, 'One chart'], [2, Columns2, 'Two charts'], [4, Grid2x2, 'Four charts']] as const;

export function ChartsView({ dark }: { dark: boolean }) {
  const instruments = useApi<Instrument[]>('/instruments');
  const { quotes, flash } = useLiveQuotes();
  const [count, setCount] = useState(4);
  const [symbols, setSymbols] = useState(['BTCUSD', 'ETHUSD', 'XAUUSD', 'EURUSD']);
  // The chart the watchlist loads into and the fundamentals describe: the last one touched.
  const [focus, setFocus] = useState(0);
  const at = Math.min(focus, count - 1);
  const setAt = (i: number, s: string) => setSymbols((v) => v.map((x, j) => (j === i ? s : x)));
  const quoteOf = (s: string) => quotes.find((x) => x.symbol === s);

  return (
    <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <PageTitle>Charts</PageTitle>
        <span className="x-badge"><i className="nav-live mr-1.5 block size-1.5 rounded-full bg-up" aria-hidden />Live prices</span>
        {count > 1 && <span className="hidden text-xs text-slate-ink md:inline">Click a chart to focus it; the watchlist loads into the one outlined.</span>}
        <div role="radiogroup" aria-label="Layout" className="ch-seg ml-auto">
          {LAYOUTS.map(([n, Icon, label]) => (
            <button key={n} type="button" role="radio" aria-checked={count === n} title={label} aria-label={label} onClick={() => setCount(n)} className={count === n ? 'is-on' : ''}>
              <Icon size={15} aria-hidden />
            </button>
          ))}
        </div>
      </div>

      {/* Side by side from lg up; on a phone or a tablet the watchlist sits above the charts,
          kept short so the charts are not a screen away, and each chart has its own height. */}
      <div className="flex flex-1 flex-col gap-3 lg:min-h-0 lg:flex-row">
        <div className="flex w-full shrink-0 flex-col gap-3 lg:min-h-0 lg:w-72">
          <Watchlist quotes={quotes} flash={flash} instruments={instruments.data ?? []} active={symbols[at]!} onPick={(s) => setAt(at, s)} />
          <FundamentalsCard symbol={symbols[at]!} />
        </div>

        {/* The panels sequence in. Safe against lightweight-charts' autoSize, which sizes from
            a ResizeObserver on the border box: a translate does not change that box, so the
            chart measures the same width mid-animation as at rest. Nothing here re-runs on a
            price tick — the series is updated in place — so this is arrival only, which is the
            whole rule. Changing the 1/2/4 count does remount and replay it, and should. */}
        <div className={`stagger grid flex-1 gap-3 lg:min-h-0 ${count === 1 ? '' : 'md:grid-cols-2'} ${count === 4 ? 'md:grid-rows-2' : ''}`}>
          {symbols.slice(0, count).map((s, i) => (
            <div key={i} className={`ch-slot ${count > 1 && at === i ? 'is-focus' : ''}`} onPointerDownCapture={() => setFocus(i)} onFocusCapture={() => setFocus(i)}>
              <ChartPanel symbol={s} onSymbol={(v) => setAt(i, v)} quote={quoteOf(s)}
                instruments={instruments.data ?? []} dark={dark} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
