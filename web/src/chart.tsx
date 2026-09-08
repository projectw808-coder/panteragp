import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BarSeries, CandlestickSeries, HistogramSeries, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { card } from './App.tsx';

import { api, useApi } from './api.ts';
import { useFeed } from './feed.ts';
import { bollinger, ema, macd, rsi, sma } from './indicators.ts';

// Compact select: the shared `input` style is w-full, which would beat a fixed width here.
const sel = 'rounded border border-slate-300 px-2 py-1 text-xs outline-none dark:border-slate-700 dark:bg-slate-900';

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Instrument = { symbol: string; display_name: string };
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

const theme = (dark: boolean) => dark
  ? { bg: '#0f172a', text: '#94a3b8', grid: '#1e293b', up: '#22c55e', down: '#ef4444', line: '#38bdf8', draw: '#f59e0b' }
  : { bg: '#ffffff', text: '#64748b', grid: '#e2e8f0', up: '#16a34a', down: '#dc2626', line: '#0284c7', draw: '#b45309' };

/** Pair indicator output with bar times, dropping the leading nulls the chart can't plot. */
const series = (bars: Candle[], values: (number | null)[]) =>
  bars.flatMap((b, i) => values[i] === null || values[i] === undefined
    ? [] : [{ time: b.time as UTCTimestamp, value: values[i]! }]);

// ------------------------------------------------------------------ panel

function ChartPanel({ instruments, dark, symbol, onSymbol }: {
  instruments: Instrument[]; dark: boolean; symbol: string; onSymbol: (s: string) => void;
}) {
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('1H');
  const [type, setType] = useState<(typeof TYPES)[number]>('candlestick');
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

    if (on.includes('MA')) ch.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false })
      .setData(series(data, sma(closes, 20)));
    if (on.includes('EMA')) ch.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, priceLineVisible: false })
      .setData(series(data, ema(closes, 50)));
    if (on.includes('BB')) {
      const bb = bollinger(closes, 20, 2);
      for (const band of [bb.upper, bb.mid, bb.lower]) {
        ch.addSeries(LineSeries, { color: '#64748b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(series(data, band));
      }
    }

    let pane = 1;
    if (on.includes('RSI')) {
      const s = ch.addSeries(LineSeries, { color: '#0ea5e9', lineWidth: 1, priceLineVisible: false }, pane);
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
      ch.addSeries(LineSeries, { color: '#0ea5e9', lineWidth: 1, priceLineVisible: false }, pane)
        .setData(series(data, m.line));
      ch.addSeries(LineSeries, { color: '#f97316', lineWidth: 1, priceLineVisible: false }, pane)
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
    <div className={`${card} flex min-h-0 flex-col gap-2 p-2`}>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <select className={`${sel} w-28`} value={symbol} onChange={(e) => onSymbol(e.target.value)}>
          {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
        </select>
        <select className={`${sel} w-16`} value={tf} onChange={(e) => setTf(e.target.value as typeof tf)}>
          {TIMEFRAMES.map((f) => <option key={f}>{f}</option>)}
        </select>
        <select className={`${sel} w-28`} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          {TYPES.map((f) => <option key={f}>{f}</option>)}
        </select>
        <span className="mx-1 flex gap-1">
          {[...OVERLAYS, ...PANELS].map((i) => (
            <button key={i} onClick={() => toggle(i)} aria-pressed={on.includes(i)}
              className={`rounded px-2 py-1 ${on.includes(i) ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {i}
            </button>
          ))}
        </span>
        <span className="flex gap-1">
          {(['none', 'trend', 'hline', 'fib'] as Tool[]).map((t) => (
            <button key={t} onClick={() => { setTool(t); pending.current = null; setAwaiting(false); }} aria-pressed={tool === t}
              className={`rounded px-2 py-1 ${tool === t ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {t === 'none' ? 'cursor' : t}
            </button>
          ))}
          {drawings.length > 0 &&
            <button className="rounded px-2 py-1 text-slate-500 hover:text-red-600"
              onClick={() => { setDrawings([]); pending.current = null; setAwaiting(false); }}>clear</button>}
        </span>
        {awaiting && <span className="text-amber-600">click the second point…</span>}
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

// ----------------------------------------------------------------- watchlist

function Watchlist({ onPick }: { onPick: (s: string) => void }) {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  // The previous bar's close, to price the change against. Comes from the REST snapshot;
  // ticks only carry the current price.
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

  return (
    <div className={`${card} p-0`}>
      <h2 className="border-b border-slate-200 px-3 py-2 text-xs font-semibold dark:border-slate-700">Watchlist</h2>
      <table className="w-full text-xs">
        <tbody>
          {quotes.map((q) => (
            <tr key={q.symbol} onClick={() => onPick(q.symbol)}
              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800">
              <td className="px-3 py-1.5 font-medium">{q.symbol}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums transition-colors ${
                flash[q.symbol] === 'up' ? 'text-green-600' : flash[q.symbol] === 'down' ? 'text-red-600' : ''}`}>
                {q.price}
              </td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${q.change >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {q.change >= 0 ? '+' : ''}{q.change_pct}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------- view

export function ChartsView({ dark }: { dark: boolean }) {
  const instruments = useApi<Instrument[]>('/instruments');
  const [count, setCount] = useState(1);
  const [symbols, setSymbols] = useState(['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD']);
  const setAt = (i: number, s: string) => setSymbols((v) => v.map((x, j) => (j === i ? s : x)));

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex w-56 shrink-0 flex-col gap-3">
        <div className="flex gap-1 text-xs">
          {[1, 2, 4].map((n) => (
            <button key={n} onClick={() => setCount(n)} aria-pressed={count === n}
              className={`flex-1 rounded px-2 py-1 ${count === n ? 'bg-slate-900 text-white dark:bg-slate-200 dark:text-slate-900' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              {n} chart{n > 1 ? 's' : ''}
            </button>
          ))}
        </div>
        <Watchlist onPick={(s) => setAt(0, s)} />
      </div>

      <div className={`grid min-h-0 flex-1 gap-3 ${count === 1 ? '' : 'grid-cols-2'} ${count === 4 ? 'grid-rows-2' : ''}`}>
        {symbols.slice(0, count).map((s, i) => (
          <ChartPanel key={i} symbol={s} onSymbol={(v) => setAt(i, v)}
            instruments={instruments.data ?? []} dark={dark} />
        ))}
      </div>
    </div>
  );
}
