import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { candles, quote, spot, TIMEFRAMES } from '../src/market.ts';
import { bollinger, ema, macd, rsi, sma } from '../web/src/indicators.ts';

describe('indicators', () => {
  test('sma is null until the window fills, then averages it', () => {
    assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  test('ema seeds on the sma then compounds', () => {
    // period 3 -> k = 0.5; seed = sma(1,2,3) = 2, then 4*.5+2*.5 = 3, 5*.5+3*.5 = 4
    assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  });

  test('rsi pins to its bounds on one-way series', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    assert.ok(rsi(up).at(-1)! > 99.9, 'a series that only rises should read ~100');
    assert.ok(rsi(down).at(-1)! < 0.1, 'a series that only falls should read ~0');
    assert.equal(rsi(up).length, up.length);
    assert.equal(rsi(up)[12], null, 'not enough data before period 14');
  });

  test('rsi of a flat series is neutral-ish and never NaN', () => {
    const flat = Array(40).fill(100);
    const v = rsi(flat).at(-1)!;
    assert.ok(Number.isFinite(v), 'zero gain and zero loss must not divide by zero');
  });

  test('bollinger bands collapse onto the mean when there is no variance', () => {
    const { mid, upper, lower } = bollinger(Array(30).fill(7), 20);
    assert.equal(mid.at(-1), 7);
    assert.equal(upper.at(-1), 7);
    assert.equal(lower.at(-1), 7);
  });

  test('bollinger bands straddle the mean and widen with variance', () => {
    const noisy = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 5 : -5));
    const { mid, upper, lower } = bollinger(noisy, 20);
    assert.ok(upper.at(-1)! > mid.at(-1)! && mid.at(-1)! > lower.at(-1)!);
  });

  test('macd line and histogram align with the input length', () => {
    const vals = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const m = macd(vals);
    assert.equal(m.line.length, 100);
    assert.equal(m.signal.length, 100);
    assert.equal(m.hist.length, 100);
    assert.equal(m.line[24], null, 'undefined before the slow ema is seeded');
    assert.ok(m.hist.at(-1) !== null);
    // hist is line - signal, by definition
    assert.ok(Math.abs(m.hist.at(-1)! - (m.line.at(-1)! - m.signal.at(-1)!)) < 1e-9);
  });
});

describe('mock candles', () => {
  test('are deterministic for the same window', () => {
    assert.deepEqual(candles('EURUSD', '1H', 50), candles('EURUSD', '1H', 50));
  });

  test('a bar keeps its values regardless of how much history is requested', () => {
    const short = candles('BTCUSD', '1D', 10);
    const long = candles('BTCUSD', '1D', 200);
    assert.deepEqual(short, long.slice(-10), 'panning further back must not redraw existing bars');
  });

  test('respect OHLC invariants', () => {
    for (const tf of Object.keys(TIMEFRAMES) as (keyof typeof TIMEFRAMES)[]) {
      for (const c of candles('XAUUSD', tf, 200)) {
        assert.ok(c.high >= Math.max(c.open, c.close), `high below body on ${tf}`);
        assert.ok(c.low <= Math.min(c.open, c.close), `low above body on ${tf}`);
        assert.ok(c.low > 0 && c.volume > 0);
      }
    }
  });

  test('are evenly spaced and ascending in time', () => {
    const cs = candles('GBPUSD', '15m', 100);
    assert.equal(cs.length, 100);
    for (let i = 1; i < cs.length; i++) assert.equal(cs[i]!.time - cs[i - 1]!.time, TIMEFRAMES['15m']);
  });

  test('quote reports the live price against the previous bar close', () => {
    const now = Date.now();
    const prev = candles('EURUSD', '1m', 2)[0]!;
    const q = quote('EURUSD', now);
    assert.equal(q.price, spot('EURUSD', now));
    assert.ok(Math.abs(q.change - (q.price - prev.close)) < 1e-8);
  });

  test('spot meets the bar it belongs to at the bar boundary', () => {
    // At the exact start of a bar the live price is that bar's open.
    const bar = candles('EURUSD', '1m', 3)[1]!;
    assert.equal(spot('EURUSD', bar.time * 1000), bar.open);
  });

  test('spot moves within a bar', () => {
    const t = Date.now();
    const a = spot('BTCUSD', t);
    const b = spot('BTCUSD', t + 20_000);
    assert.notEqual(a, b, 'a live price that never changes is not a live price');
  });
});
