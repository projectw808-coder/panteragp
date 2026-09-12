import { subscribe } from './feed.ts';

/**
 * The auto trader's preview, kept outside the page that shows it.
 *
 * Living in component state, the list started from nothing every time somebody navigated
 * away and back — which is not what "running" means. It lives here instead: one ticker for
 * the whole app, started when the switch goes on and stopped when it goes off, and the
 * lines are kept in local storage so closing the tab and coming back picks up where it
 * was rather than at zero.
 *
 * What it deliberately does not do is invent the trades it would have made while the tab
 * was shut. Resuming means carrying on; it does not mean filling in a history that never
 * happened, and a demonstration that manufactures a backlog is a demonstration nobody
 * should trust.
 */

export type Line = {
  id: number; symbol: string; side: 'buy' | 'sell'; qty: number;
  price: number; at: number; pnl: number;
};

const KEY = 'autotrader.preview';
const MAX = 40;
const EVERY = 2600;

let lines: Line[] = load();
let symbols: string[] = [];
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unfeed: (() => void) | null = null;
let seq = lines.length ? Math.max(...lines.map((l) => l.id)) : 0;

const prices: Record<string, number> = {};
const listeners = new Set<(l: Line[]) => void>();

function load(): Line[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    // A browser with storage blocked, or something else's data under our key. Neither is
    // worth failing over for a preview.
    return [];
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* not worth failing over */ }
}

function emit() {
  save();
  for (const l of listeners) l(lines);
}

function tick() {
  if (!symbols.length) return;
  const symbol = symbols[Math.floor(Math.random() * symbols.length)]!;
  const price = prices[symbol];
  if (!price) return;
  const side: Line['side'] = Math.random() > 0.5 ? 'buy' : 'sell';

  // Size by notional, not by unit count. Taking 0.1–2 units of everything is what produced
  // a log holding two units of bitcoin next to two units of a coin worth a thousandth of a
  // cent, and results computed off the unit price then rounded away to 0.00 on anything
  // cheap — most of the table saying nothing happened. A desk sizes a position in money, so
  // this picks the money first and divides by the price to get the quantity.
  const notional = 2_000 + Math.random() * 18_000;
  const qty = notional / price;

  lines = [{
    id: ++seq,
    symbol, side,
    // Quantity carries the precision the size actually needs: fractions of a coin priced in
    // thousands, whole units of one priced in cents.
    qty: Number(qty.toPrecision(4)),
    price,
    at: Date.now(),
    // A spread of outcomes either side of nothing, proportional to the size taken — which
    // is what makes a result on a cheap instrument as legible as one on an expensive one.
    // Still a shape rather than a forecast, and still never summed anywhere: a running
    // total on invented trades is exactly the number somebody would mistake for their own.
    pnl: Number((notional * (Math.random() - 0.45) * 0.01).toFixed(2)),
  }, ...lines].slice(0, MAX);
  emit();
}

/** The instruments the preview draws from. Set once the app knows them. */
export function setSymbols(next: string[]) {
  symbols = next;
}

export function isRunning() {
  return running;
}

export function getLines() {
  return lines;
}

export function start() {
  if (running) return;
  running = true;
  // The ticker needs prices whether or not a chart is open, so it holds its own
  // subscription rather than borrowing one from whichever page happens to be mounted.
  unfeed = subscribe((ticks) => {
    for (const t of ticks) prices[t.symbol] = t.price;
  });
  timer = setInterval(tick, EVERY);
}

export function stop() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  unfeed?.();
  unfeed = null;
}

/** Clear the list. Used when the switch is turned off, so it does not look paused. */
export function clear() {
  lines = [];
  emit();
}

export function onLines(fn: (l: Line[]) => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
