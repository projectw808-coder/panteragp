import { spot } from './market.ts';
import { stats, STRATEGIES, type Direction, type StrategyKind } from './autotrader.ts';
import { round8 } from './trading.ts';

/**
 * The landing page's demo record, shown while the desk has not chosen a showcase account.
 *
 * It is simulated, and the landing page labels it as a demo. The day-by-day result follows
 * a modest planned path (about 0.15% a day) with realistic swings, including losing days,
 * so the figures read like a real book rather than a brochure. Each trade opens and closes
 * at this platform's own quoted price at those moments; its side and size are chosen so the
 * trade carries the result the day was dealt. Nothing here touches the database or anyone's
 * money. Everything is deterministic: the same moment always gives the same record, and the
 * record grows as time passes.
 */

// Sized so the record stood at about 570,553 USD on 25 October 2026, and grows from there.
export const DEMO_START = 535_961;
export const DEMO_SINCE = Date.UTC(2026, 8, 25);   // 25 September 2026
const DAY = 86_400_000;
const DAILY_DRIFT = 0.0025;       // the planned path: steady growth, about 7.8% a month
const RISK = 0.0019;              // of equity, per trade
const PULL = 8;                   // how firmly a day's hit rate is lifted when the record falls behind the path
const FEE = 0.0001;               // commission per side, on notional
const ALLOC: Record<StrategyKind, number> = { trend: 0.2, mean_reversion: 0.3, grid: 0.5 };
const PICK: [StrategyKind, number][] = [['grid', 0.5], ['mean_reversion', 0.3], ['trend', 0.2]];

/** How the public page scales a symbol's platform price to the real market; 1 until told. */
let scaleOf: (symbol: string) => number = () => 1;
export function setDemoScale(f: (symbol: string) => number) { scaleOf = f; cache = null; }
const px = (symbol: string, at: number) => spot(symbol, at) * scaleOf(symbol);

/** A repeatable random number in [0, 1) for any whole-number key. */
function rnd(n: number): number {
  let t = (n * 0x9e3779b1 + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = (n: number) => Math.sqrt(-2 * Math.log(rnd(n) || 1e-9)) * Math.cos(2 * Math.PI * rnd(n + 7919));

type Trade = {
  kind: StrategyKind; symbol: string; side: Direction; qty: number;
  openAt: number; closeAt: number; entry: number; exit: number; net: number; fees: number; r: number;
};

/**
 * One day's trades. Each risks a fixed slice of equity; the day is dealt a hit rate that
 * wanders around 56% (some days most trades lose), drawn gently back toward the planned
 * path when the record has drifted from it.
 */
function dayTrades(d: number, equity: number): Trade[] {
  const start = DEMO_SINCE + d * DAY;
  const traj = DEMO_START * Math.pow(1 + DAILY_DRIFT, d);
  const p = Math.min(0.92, Math.max(0.15, 0.58 + 0.09 * gauss(d * 101 + 1) + PULL * Math.max(0, traj - equity) / equity));
  const n = 8 + Math.floor(rnd(d * 101 + 2) * 9);
  const risk = equity * RISK;
  const units = Array.from({ length: n }, (_, i) => {
    const k = d * 1000 + i * 17;
    return rnd(k + 3) < p ? 0.3 + rnd(k + 4) * 0.7 : -(0.35 + rnd(k + 5) * 0.65);
  });
  const out: Trade[] = [];
  for (let i = 0; i < n; i++) {
    const k = d * 1000 + i * 17;
    let x = rnd(k + 6); let kind: StrategyKind = 'grid';
    for (const [kk, w] of PICK) { if (x < w) { kind = kk; break; } x -= w; }
    const syms = STRATEGIES[kind].symbols;
    const symbol = syms[Math.floor(rnd(k + 8) * syms.length)]!;
    const openAt = start + ((i + rnd(k + 9) * 0.8) / n) * DAY;
    const net = round8(units[i]! * risk);
    // Hold until the price has moved enough to carry the result past the commission.
    let closeAt = openAt, entry = px(symbol, openAt), exit = entry;
    for (let h = 0; h < 12; h++) {
      closeAt = openAt + (25 + rnd(k + 10 + h) * 180 + h * 70) * 60_000;
      exit = px(symbol, closeAt);
      if (Math.abs(exit - entry) / entry >= 0.003) break;
    }
    const move = Math.abs(exit - entry);
    if (!(move > 0)) continue;
    const win = net > 0;
    const side: Direction = (exit > entry) === win ? 'long' : 'short';
    const feePerUnit = FEE * (entry + exit);
    const qty = win ? net / (move - feePerUnit) : -net / (move + feePerUnit);
    if (!(qty > 0) || !Number.isFinite(qty)) continue;
    const q = Number(qty.toPrecision(4));
    const fees = round8(q * feePerUnit);
    const real = round8((side === 'long' ? exit - entry : entry - exit) * q - fees);
    out.push({ kind, symbol, side, qty: q, openAt, closeAt, entry, exit, net: real, fees, r: round8(real / risk) });
  }
  return out;
}

function simulate(nowMs: number) {
  const days = Math.max(1, Math.floor((nowMs - DEMO_SINCE) / DAY) + 1);
  const all: Trade[] = [];
  let equity = DEMO_START;
  for (let d = 0; d < days; d++) {
    const t = dayTrades(d, equity);
    all.push(...t);
    // The path for the next day starts from the whole day's result, as dealt.
    equity += t.reduce((a, x) => a + x.net, 0);
  }
  const done = all.filter((t) => t.closeAt <= nowMs).sort((a, b) => a.closeAt - b.closeAt);
  const open = all.filter((t) => t.openAt <= nowMs && t.closeAt > nowMs);
  const unrealised = round8(open.reduce((a, t) => {
    const mark = px(t.symbol, nowMs);
    return a + (t.side === 'long' ? mark - t.entry : t.entry - mark) * t.qty - FEE * t.entry * t.qty;
  }, 0));
  const st = stats(done.map((t) => ({ net: t.net, r: t.r, at: new Date(t.closeAt) })), DEMO_START, unrealised);

  const today = new Date(nowMs).toISOString().slice(0, 10);
  const todays = done.filter((t) => new Date(t.closeAt).toISOString().slice(0, 10) === today);

  // Sharpe from the daily results, as the live showcase computes it.
  const byDay = new Map<string, number>();
  for (const t of done) { const k = new Date(t.closeAt).toISOString().slice(0, 10); byDay.set(k, (byDay.get(k) ?? 0) + t.net); }
  let eq = DEMO_START; const daily: number[] = [];
  for (const pnl of byDay.values()) { daily.push(pnl / eq); eq += pnl; }
  let sharpe: number | null = null;
  if (daily.length >= 5) {
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1));
    sharpe = sd > 0 ? round8((mean / sd) * Math.sqrt(365)) : null;
  }

  const since = new Date(DEMO_SINCE).toISOString();
  const step = Math.max(1, Math.ceil(st.curve.length / 200));
  const curve = [{ at: since, equity: DEMO_START }, ...st.curve.filter((_, i) => i % step === 0 || i === st.curve.length - 1).map((p) => ({ at: p.at.toISOString(), equity: p.equity }))];
  const kinds = Object.keys(STRATEGIES) as StrategyKind[];

  return {
    configured: true as const,
    demo: true as const,
    on: true,
    since,
    kpis: {
      equity: st.equity, allocated: DEMO_START, return_pct: round8((st.equity - DEMO_START) / DEMO_START), unrealised,
      today_net: round8(todays.reduce((a, t) => a + t.net, 0)), today_trades: todays.length, today_fees: round8(todays.reduce((a, t) => a + t.fees, 0)),
      wins: st.wins, closed: st.closed, win_rate: st.win_rate,
      profit_factor: st.profit_factor, avg_win_r: st.avg_win_r, avg_loss_r: st.avg_loss_r,
      max_drawdown: st.max_drawdown, drawdown_at: st.drawdown_at?.toISOString() ?? null, open: open.length,
      total_trades: st.closed, sharpe,
    },
    curve,
    trades: [...done].reverse().slice(0, 5).map((t) => ({ closed_at: new Date(t.closeAt).toISOString(), symbol: t.symbol, side: t.side, entry: round8(t.entry), exit: round8(t.exit), net: t.net, strategy: STRATEGIES[t.kind].name })),
    strategies: kinds.map((k) => {
      let run = 0; const spark = [0];
      for (const t of done) if (t.kind === k) { run += t.net; spark.push(round8(run)); }
      return { name: STRATEGIES[k].name, kind: k, symbols: STRATEGIES[k].symbols, state: 'running' as const, return_pct: round8(run / (DEMO_START * ALLOC[k])), spark: spark.slice(-24) };
    }),
  };
}

export type DemoShowcase = ReturnType<typeof simulate>;
let cache: { key: number; value: DemoShowcase } | null = null;

/** The demo record, recomputed at most every twenty seconds. */
export function demoShowcase(nowMs = Date.now()): DemoShowcase {
  const key = Math.floor(nowMs / 20_000);
  if (cache?.key !== key) cache = { key, value: simulate(nowMs) };
  return cache.value;
}
