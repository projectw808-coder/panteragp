// Indicator maths. Pure functions over closes; the chart maps them onto bar times.
// Each returns an array the same length as the input, with `null` before it has enough data.

export type Maybe = (number | null)[];

export function sma(values: number[], period: number): Maybe {
  const out: Maybe = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export function ema(values: number[], period: number): Maybe {
  const k = 2 / (period + 1);
  const out: Maybe = [];
  let prev: number | null = null;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i < period - 1) { out.push(null); continue; }
    // Seed with the SMA of the first `period` values, then compound.
    prev = prev === null ? sum / period : values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI: smoothed average gain / average loss. */
export function rsi(values: number[], period = 14): Maybe {
  const out: Maybe = [null];
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    const up = Math.max(d, 0), down = Math.max(-d, 0);
    if (i <= period) {
      gain += up / period;
      loss += down / period;
      out.push(i === period ? 100 - 100 / (1 + gain / (loss || 1e-10)) : null);
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
      out.push(100 - 100 / (1 + gain / (loss || 1e-10)));
    }
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(values, fast), s = ema(values, slow);
  const line: Maybe = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i]! - s[i]!));
  // The signal EMA runs over the defined part of the MACD line only.
  const start = line.findIndex((v) => v !== null);
  const sig: Maybe = values.map(() => null);
  if (start >= 0) {
    const tail = ema(line.slice(start) as number[], signal);
    tail.forEach((v, i) => { sig[start + i] = v; });
  }
  const hist: Maybe = line.map((v, i) => (v === null || sig[i] === null ? null : v - sig[i]!));
  return { line, signal: sig, hist };
}

export function bollinger(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper: Maybe = [], lower: Maybe = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    const win = values.slice(i - period + 1, i + 1);
    const mean = mid[i]!;
    const sd = Math.sqrt(win.reduce((a, v) => a + (v - mean) ** 2, 0) / period);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return { mid, upper, lower };
}
