import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarSeries, CandlestickSeries, HistogramSeries, LineSeries, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts';
import { ChevronDown, Columns2, Grid2x2, Search, SlidersHorizontal, Square } from 'lucide-react';
import { grouped } from './App.tsx';
import { api, useApi } from './api.ts';
import { useFeed } from './feed.ts';
import { bollinger, ema, macd, rsi, sma } from './indicators.ts';
import { Coin } from './landing.tsx';

/**
 * The charts screen, to the October 2026 client-area plan: one toolbar of timeframes and
 * indicators over up to four candle charts, each headed by its instrument and live price,
 * and the watchlist down the right with its asset-class tabs and a search.
 */

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Instrument = { symbol: string; display_name: string; asset_class: string | null };
type Quote = { symbol: string; price: number; change: number; change_pct: number };

const TIMEFRAMES = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'] as const;
type Tf = (typeof TIMEFRAMES)[number];
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800 } as const;
const TF_LABEL: Record<Tf, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1H': '1h', '4H': '4h', '1D': '1D', '1W': '1W' };
const TYPES = ['candlestick', 'line', 'bar'] as const;
const OVERLAYS = ['MA', 'EMA', 'BB'] as const;
const PANELS = ['RSI', 'MACD'] as const;
type Indicator = (typeof OVERLAYS)[number] | (typeof PANELS)[number];
const IND_LABEL: Record<Indicator, string> = { MA: 'Moving average (20)', EMA: 'Exponential average (50)', BB: 'Bollinger bands', RSI: 'RSI (14)', MACD: 'MACD' };
type Tool = 'none' | 'trend' | 'hline' | 'fib';

type Point = { time: number; price: number };
type Drawing =
  | { kind: 'trend'; a: Point; b: Point }
  | { kind: 'fib'; a: Point; b: Point }
  | { kind: 'hline'; a: Point };

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

// The chart library needs literal colours; these follow the client-area plan's tokens.
const theme = (dark: boolean) => dark
  ? { bg: '#0d1116', text: '#9ca3af', grid: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.08)', up: '#18c879', down: '#ff4b55',
      line: '#ff7a12', draw: '#ff7a12', accent: '#ff7a12', muted: '#9ca3af', faint: '#3f3f46', volUp: 'rgba(24,200,121,0.35)', volDown: 'rgba(255,75,85,0.35)' }
  : { bg: '#ffffff', text: '#71717a', grid: '#eef0f2', border: '#e5e7eb', up: '#15803d', down: '#b91c1c',
      line: '#ff7817', draw: '#ff7817', accent: '#ff7817', muted: '#71717a', faint: '#a1a1aa', volUp: 'rgba(21,128,61,0.3)', volDown: 'rgba(185,28,28,0.3)' };

const series = (bars: Candle[], values: (number | null)[]) =>
  bars.flatMap((b, i) => values[i] === null || values[i] === undefined
    ? [] : [{ time: b.time as UTCTimestamp, value: values[i]! }]);

const fmtPrice = (p: number) => p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: p < 10 ? 5 : 2 });

/** Every quote, from the snapshot and then from the live feed; the change is against the previous close. */
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
        return { ...q, price, change: Number((price - prevClose).toFixed(8)), change_pct: Number((((price - prevClose) / prevClose) * 100).toFixed(3)) };
      });
      setFlash(dir);
      return next;
    });
  }, []);
  return { quotes, flash };
}

// ------------------------------------------------------------------ panel

function ChartPanel({ instruments, dark, symbol, onSymbol, tf, on, quote, flash }: {
  instruments: Instrument[]; dark: boolean; symbol: string; onSymbol: (s: string) => void;
  tf: Tf; on: Indicator[]; quote?: Quote; flash?: 'up' | 'down';
}) {
  const [type, setType] = useState<(typeof TYPES)[number]>('candlestick');
  const [tool, setTool] = useState<Tool>('none');
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const pending = useRef<Point | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const [, redraw] = useState(0);

  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<'Candlestick' | 'Line' | 'Bar'> | null>(null);
  const push = useRef<((b: Candle) => void) | null>(null);
  const forming = useRef<Candle | null>(null);
  const bars = useApi<Candle[]>(`/candles?symbol=${symbol}&tf=${tf}&limit=500`);
  const name = instruments.find((i) => i.symbol === symbol)?.display_name;

  useEffect(() => {
    if (!box.current || !bars.data?.length) return;
    const c = theme(dark);
    const data = bars.data;
    const closes = data.map((b) => b.close);

    const ch = createChart(box.current, {
      layout: { background: { color: c.bg }, textColor: c.text, attributionLogo: false, fontFamily: "'Segoe UI', Figtree, system-ui, sans-serif" },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border, timeVisible: tf !== '1D' && tf !== '1W' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chart.current = ch;

    // Volume along the foot of the price pane, as in the plan.
    const vol = ch.addSeries(HistogramSeries, { priceScaleId: '', priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(data.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? c.volUp : c.volDown })));

    if (type === 'candlestick') {
      const s = ch.addSeries(CandlestickSeries, { upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
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
    price.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
    forming.current = { ...data[data.length - 1]! };

    if (on.includes('MA')) ch.addSeries(LineSeries, { color: c.accent, lineWidth: 1, priceLineVisible: false }).setData(series(data, sma(closes, 20)));
    if (on.includes('EMA')) ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false }).setData(series(data, ema(closes, 50)));
    if (on.includes('BB')) {
      const bb = bollinger(closes, 20, 2);
      for (const band of [bb.upper, bb.mid, bb.lower]) {
        ch.addSeries(LineSeries, { color: c.faint, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(series(data, band));
      }
    }
    let pane = 1;
    if (on.includes('RSI')) {
      const s = ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false }, pane);
      s.setData(series(data, rsi(closes, 14)));
      for (const level of [30, 70]) s.createPriceLine({ price: level, color: c.border, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      ch.panes()[pane]?.setHeight(80);
      pane++;
    }
    if (on.includes('MACD')) {
      const m = macd(closes);
      ch.addSeries(HistogramSeries, { color: c.text, priceLineVisible: false }, pane)
        .setData(series(data, m.hist).map((p) => ({ ...p, color: p.value >= 0 ? c.up : c.down })));
      ch.addSeries(LineSeries, { color: c.muted, lineWidth: 1, priceLineVisible: false }, pane).setData(series(data, m.line));
      ch.addSeries(LineSeries, { color: c.faint, lineWidth: 1, priceLineVisible: false }, pane).setData(series(data, m.signal));
      ch.panes()[pane]?.setHeight(80);
    }

    const fit = () => ch.timeScale().fitContent();
    requestAnimationFrame(fit);
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);
    const bump = () => redraw((n) => n + 1);
    ch.timeScale().subscribeVisibleLogicalRangeChange(bump);
    bump();
    return () => { ro.disconnect(); ch.remove(); chart.current = null; price.current = null; push.current = null; };
  }, [bars.data, type, on, dark, tf, symbol]);

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
      if (!first) { pending.current = at; setAwaiting(true); return; }
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
  const up = (quote?.change ?? 0) >= 0;

  return (
    <div className="x-card tile flex h-[420px] min-h-0 flex-col p-3 lg:h-auto lg:flex-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="scale-[0.85]"><Coin symbol={symbol} /></span>
        <label className="relative min-w-0">
          <span className="sr-only">Instrument</span>
          <select className="x-symsel" value={symbol} onChange={(e) => onSymbol(e.target.value)}>
            {grouped(instruments).map(([label, items]) => (
              <optgroup key={label} label={label}>
                {items.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-mist" />
          <span className="block truncate text-[11.5px] text-mist">{name ?? symbol}</span>
        </label>
        <div className="ml-auto text-right">
          <p className={`text-[17px] font-bold tabular-nums transition-colors ${flash === 'up' ? 'text-up' : flash === 'down' ? 'text-down' : ''}`}>{quote ? fmtPrice(quote.price) : '—'}</p>
          {quote && <p className={`text-[12px] tabular-nums ${up ? 'text-up' : 'text-down'}`}>{up ? '+' : ''}{quote.change_pct.toFixed(2)}%</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {TYPES.map((t) => (
          <button key={t} onClick={() => setType(t)} aria-pressed={type === t} className={`x-mini ${type === t ? 'is-on' : ''}`}>{t === 'candlestick' ? 'Candles' : t === 'line' ? 'Line' : 'Bars'}</button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
        {(['none', 'trend', 'hline', 'fib'] as Tool[]).map((t) => (
          <button key={t} onClick={() => { setTool(t); pending.current = null; setAwaiting(false); }} aria-pressed={tool === t}
            className={`x-mini ${tool === t ? 'is-on' : ''}`}>{t === 'none' ? 'Cursor' : t === 'trend' ? 'Trend' : t === 'hline' ? 'Level' : 'Fib'}</button>
        ))}
        {drawings.length > 0 && <button className="x-mini" onClick={() => { setDrawings([]); pending.current = null; setAwaiting(false); }}>Clear</button>}
        {awaiting && <span className="text-[11.5px] text-mist">click the second point…</span>}
      </div>
      <div className="relative mt-2 min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" />
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
          {drawings.map((d, i) => {
            const a = xy(d.a);
            if (!a) return null;
            const c = theme(dark).draw;
            if (d.kind === 'hline') {
              return <g key={i}><line x1={0} y1={a.y} x2={width} y2={a.y} stroke={c} strokeWidth={1} strokeDasharray="4 3" /><text x={4} y={a.y - 4} fill={c} fontSize={10}>{d.a.price.toPrecision(6)}</text></g>;
            }
            const b = xy(d.b);
            if (!b) return null;
            if (d.kind === 'trend') return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={1.5} />;
            return <g key={i}>
              {FIB.map((f) => {
                const y = a.y + (b.y - a.y) * f;
                const level = d.a.price + (d.b.price - d.a.price) * f;
                return <g key={f}><line x1={Math.min(a.x, b.x)} y1={y} x2={width} y2={y} stroke={c} strokeWidth={1} opacity={0.7} /><text x={Math.min(a.x, b.x) + 4} y={y - 3} fill={c} fontSize={10}>{f} · {level.toPrecision(6)}</text></g>;
              })}
            </g>;
          })}
        </svg>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- watchlist

const TABS: [string, string | null][] = [['All', null], ['Crypto', 'crypto'], ['FX', 'fx'], ['Indices', 'etf'], ['Commodities', 'metals']];

function Watchlist({ quotes, flash, instruments, onPick, active }: {
  quotes: Quote[]; flash: Record<string, 'up' | 'down'>; instruments: Instrument[]; onPick: (s: string) => void; active: string[];
}) {
  const [tab, setTab] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const cls = useMemo(() => new Map(instruments.map((i) => [i.symbol, i.asset_class])), [instruments]);
  const shown = quotes.filter((x) => (tab === null || cls.get(x.symbol) === tab) && x.symbol.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="x-card flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-3">
        <label className="x-search">
          <Search size={15} aria-hidden className="text-mist" />
          <span className="sr-only">Search symbol</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol…" />
        </label>
        <h2 className="x-h mt-3 flex items-baseline">Watchlist<span className="ml-auto text-[11px] font-normal tabular-nums text-mist">{shown.length}</span></h2>
        <div role="tablist" aria-label="Asset class" className="mt-2 flex flex-wrap gap-1">
          {TABS.map(([label, key]) => (
            <button key={label} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`x-mini ${tab === key ? 'is-on' : ''}`}>{label}</button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-[1fr_5.5rem_4rem] border-b border-white/10 pb-1.5 text-[11px] text-mist">
          <span>Symbol</span><span className="text-right">Price</span><span className="text-right">24h</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {shown.map((x) => (
          <button key={x.symbol} type="button" onClick={() => onPick(x.symbol)}
            className={`grid w-full grid-cols-[1fr_5.5rem_4rem] items-center rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-white/5 ${active.includes(x.symbol) ? 'bg-ember/10' : ''}`}>
            <span className="flex min-w-0 items-center gap-2"><span className="x-coin-sm"><Coin symbol={x.symbol} /></span><span className="truncate font-semibold">{x.symbol}</span></span>
            <span className={`text-right tabular-nums transition-colors ${flash[x.symbol] === 'up' ? 'text-up' : flash[x.symbol] === 'down' ? 'text-down' : ''}`}>{fmtPrice(x.price)}</span>
            <span className={`text-right tabular-nums ${x.change >= 0 ? 'text-up' : 'text-down'}`}>{x.change >= 0 ? '+' : ''}{x.change_pct.toFixed(2)}%</span>
          </button>
        ))}
        {!shown.length && <p className="px-2 py-6 text-center text-sm text-mist">{quotes.length ? 'Nothing matches.' : 'Loading…'}</p>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- view

export function ChartsView({ dark }: { dark: boolean }) {
  const instruments = useApi<Instrument[]>('/instruments');
  const { quotes, flash } = useLiveQuotes();
  const [count, setCount] = useState(4);
  const [tf, setTf] = useState<Tf>('1H');
  const [on, setOn] = useState<Indicator[]>([]);
  const [menu, setMenu] = useState(false);
  const [symbols, setSymbols] = useState(['BTCUSD', 'ETHUSD', 'XAUUSD', 'EURUSD']);
  const [focus, setFocus] = useState(0);
  const setAt = (i: number, s: string) => setSymbols((v) => v.map((x, j) => (j === i ? s : x)));
  const toggle = (i: Indicator) => setOn((v) => (v.includes(i) ? v.filter((x) => x !== i) : [...v, i]));
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));

  return (
    <div className="flex min-h-0 flex-col gap-3 lg:h-full lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="x-card flex flex-wrap items-center gap-2 px-3 py-2">
          <div role="tablist" aria-label="Timeframe" className="flex flex-wrap gap-1">
            {TIMEFRAMES.map((f) => (
              <button key={f} role="tab" aria-selected={tf === f} onClick={() => setTf(f)} className={`x-tf ${tf === f ? 'is-on' : ''}`}>{TF_LABEL[f]}</button>
            ))}
          </div>
          <span className="mx-1 h-5 w-px bg-white/10" aria-hidden />
          <div className="relative">
            <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} className="x-tf flex items-center gap-1.5">
              <SlidersHorizontal size={14} aria-hidden />Indicators{on.length ? ` · ${on.length}` : ''}
            </button>
            {menu && (
              <div className="x-menu left-0 right-auto">
                {[...OVERLAYS, ...PANELS].map((i) => (
                  <button key={i} type="button" onClick={() => toggle(i)} aria-pressed={on.includes(i)}>
                    <span className={`grid h-4 w-4 place-items-center rounded border ${on.includes(i) ? 'border-ember bg-ember text-graphite' : 'border-white/25'}`} aria-hidden>{on.includes(i) ? '✓' : ''}</span>
                    {IND_LABEL[i]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="ml-auto flex gap-1" role="group" aria-label="Layout">
            {([[1, Square], [2, Columns2], [4, Grid2x2]] as const).map(([n, Icon]) => (
              <button key={n} onClick={() => setCount(n)} aria-pressed={count === n} aria-label={`${n} chart${n > 1 ? 's' : ''}`} className={`x-tf ${count === n ? 'is-on' : ''}`}><Icon size={15} aria-hidden /></button>
            ))}
          </div>
        </div>
        <div className={`stagger grid min-h-0 flex-1 gap-3 ${count === 1 ? '' : 'md:grid-cols-2'} ${count === 4 ? 'md:grid-rows-2' : ''}`}>
          {symbols.slice(0, count).map((s, i) => (
            <div key={i} className="flex min-h-0 flex-col" onPointerDown={() => setFocus(i)}>
              <ChartPanel symbol={s} onSymbol={(v) => setAt(i, v)} instruments={instruments.data ?? []} dark={dark}
                tf={tf} on={on} quote={bySymbol.get(s)} flash={flash[s]} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex max-h-80 min-h-0 w-full shrink-0 flex-col lg:max-h-none lg:w-80">
        <Watchlist quotes={quotes} flash={flash} instruments={instruments.data ?? []} active={symbols.slice(0, count)}
          onPick={(s) => setAt(Math.min(focus, count - 1), s)} />
      </div>
    </div>
  );
}
