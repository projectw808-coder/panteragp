import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Candle } from '../src/market.ts';
import { atr, evaluate, pairTrade, sizeFor, sma, stats, stddev, stopDistance } from '../src/autotrader.ts';

/** A run of candles from a list of closes, each bar a small range around its close. */
const bars = (closes: number[]): Candle[] => closes.map((c, i) => ({
  time: i * 60, open: closes[i - 1] ?? c, high: c * 1.001, low: c * 0.999, close: c, volume: 1000,
}));
const flat = (n: number, at = 100) => Array.from({ length: n }, () => at);

describe('the arithmetic underneath', () => {
  it('averages the last n only', () => {
    assert.equal(sma([1, 2, 3, 4, 5, 6], 3), 5);
    assert.ok(Number.isNaN(sma([], 3)));
  });
  it('measures spread with a sample deviation', () => {
    assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9], 8).toFixed(4), '2.1381');
    assert.ok(Number.isNaN(stddev([1], 5)));
  });
  it('reads a range from highs, lows and the previous close', () => {
    const cs = bars(flat(20));
    assert.equal(atr(cs).toFixed(4), (100 * 0.002).toFixed(4));
  });
  it('never sets a stop inside the chop', () => {
    const cs = bars(flat(20));
    // 1.5 × a 0.2 range is 0.3, but a third of a percent of 100 is 0.3 too; either way ≥ 0.3
    assert.ok(stopDistance(cs, 100) >= 0.3);
    // a dead-flat run still gets the floor
    const dead: Candle[] = flat(20).map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
    assert.equal(stopDistance(dead, 100), 0.3);
  });
});

describe('trend follower', () => {
  it('holds when there is not enough history', () => {
    assert.equal(evaluate('trend', bars(flat(10)), null).action, 'hold');
  });
  it('goes long when the fast average has pulled above the slow one', () => {
    const closes = [...flat(21, 100), ...Array.from({ length: 9 }, (_, i) => 100 + (i + 1) * 0.5)];
    const s = evaluate('trend', bars(closes), null);
    assert.equal(s.action, 'enter');
    if (s.action !== 'enter') return;
    assert.equal(s.side, 'long');
    assert.ok(s.stop < closes[closes.length - 1]!, 'stop below entry');
    assert.ok(s.target > closes[closes.length - 1]!, 'target above entry');
    assert.ok(s.confidence > 0 && s.confidence <= 1);
  });
  it('goes short when it has fallen below', () => {
    const closes = [...flat(21, 100), ...Array.from({ length: 9 }, (_, i) => 100 - (i + 1) * 0.5)];
    const s = evaluate('trend', bars(closes), null);
    assert.equal(s.action, 'enter');
    if (s.action === 'enter') assert.equal(s.side, 'short');
  });
  it('does nothing in a flat market, and never adds to what it holds', () => {
    assert.equal(evaluate('trend', bars(flat(40)), null).action, 'hold');
    const closes = [...flat(21, 100), ...Array.from({ length: 9 }, (_, i) => 100 + (i + 1) * 0.5)];
    assert.equal(evaluate('trend', bars(closes), 'long').action, 'hold');
  });
  it('exits a long the moment the averages cross the other way', () => {
    const closes = [...flat(21, 100), ...Array.from({ length: 9 }, (_, i) => 100 - (i + 1) * 0.5)];
    const s = evaluate('trend', bars(closes), 'long');
    assert.equal(s.action, 'exit');
    if (s.action === 'exit') assert.equal(s.reason, 'Signal flip');
  });
});

describe('mean reversion', () => {
  it('sells a stretch above the average and buys one below', () => {
    const up = [...flat(29, 100), 103];
    const s = evaluate('mean_reversion', bars(up), null);
    assert.equal(s.action, 'enter');
    if (s.action === 'enter') { assert.equal(s.side, 'short'); assert.ok(s.target < 103, 'target is the average'); }
    const down = [...flat(29, 100), 97];
    const d = evaluate('mean_reversion', bars(down), null);
    if (d.action === 'enter') assert.equal(d.side, 'long'); else assert.fail('should enter');
  });
  it('stays out inside the range, and holds a position until the mean', () => {
    const wobble = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.2 : -0.2));
    assert.equal(evaluate('mean_reversion', bars(wobble), null).action, 'hold');
    const back = [...flat(29, 100), 100.5];
    assert.equal(evaluate('mean_reversion', bars(back), 'long').action, 'exit');
    const still = [...flat(29, 100), 99.5];
    assert.equal(evaluate('mean_reversion', bars(still), 'long').action, 'hold');
  });
});

describe('grid', () => {
  it('buys a step below the average and takes it back to the average', () => {
    const s = evaluate('grid', bars([...flat(29, 100), 99.5]), null);
    assert.equal(s.action, 'enter');
    if (s.action === 'enter') { assert.equal(s.side, 'long'); assert.ok(s.target > 99.5 && s.target <= 100); assert.ok(s.stop < 99.5); }
  });
  it('leaves an open level to its own stop and target', () => {
    assert.equal(evaluate('grid', bars([...flat(29, 100), 99.5]), 'long').action, 'hold');
  });
});

describe('sizing', () => {
  it('risks the budget against the stop, never more than the notional cap', () => {
    // $100 at risk, $2 per unit → 50 units, $5,000 notional under a $10,000 cap
    assert.equal(sizeFor({ riskUsd: 100, price: 100, stop: 98, maxNotional: 10_000 }), 50);
    // the cap binds: $1,000 / $100 = 10 units
    assert.equal(sizeFor({ riskUsd: 100, price: 100, stop: 98, maxNotional: 1_000 }), 10);
  });
  it('keeps four significant figures whatever the price', () => {
    assert.equal(sizeFor({ riskUsd: 50, price: 63_954.25, stop: 63_000, maxNotional: 50_000 }), 0.0524);
    assert.equal(sizeFor({ riskUsd: 50, price: 0.00002420, stop: 0.00002300, maxNotional: 5_000 }), 41_670_000);
  });
  it('refuses dust: under a dollar, or under the floor the caller sets', () => {
    assert.equal(sizeFor({ riskUsd: 0.001, price: 100, stop: 99, maxNotional: 1000 }), 0);
    // the cap squeezed this to $1.40 of exposure; with a $75 floor that is not a trade
    assert.equal(sizeFor({ riskUsd: 125, price: 3105, stop: 3096, maxNotional: 1.4, minNotional: 75 }), 0);
    assert.ok(sizeFor({ riskUsd: 125, price: 3105, stop: 3096, maxNotional: 12_500, minNotional: 75 }) > 0);
  });
  it('refuses a trade with no stop or no room', () => {
    assert.equal(sizeFor({ riskUsd: 100, price: 100, stop: 100, maxNotional: 1000 }), 0);
    assert.equal(sizeFor({ riskUsd: 100, price: 100, stop: 98, maxNotional: 0 }), 0);
  });
});

describe('pairing a round trip', () => {
  it('reads a long and a short the right way round, net of both fees', () => {
    const long = pairTrade({ side: 'long', qty: 2, price: 100, fee: 0.5, stop: 98 }, { price: 105, fee: 0.5 });
    assert.equal(long.gross, 10); assert.equal(long.net, 9); assert.equal(long.r, 2.25);
    const short = pairTrade({ side: 'short', qty: 2, price: 100, fee: 0.5, stop: 102 }, { price: 105, fee: 0.5 });
    assert.equal(short.gross, -10); assert.equal(short.net, -11);
  });
  it('has no R without a stop', () => {
    assert.equal(pairTrade({ side: 'long', qty: 1, price: 100, fee: 0, stop: null }, { price: 101, fee: 0 }).r, null);
  });
});

describe('the record', () => {
  const at = (d: number) => new Date(2026, 8, d);
  it('counts wins and losses, and finds the worst peak-to-trough', () => {
    const s = stats([
      { net: 100, r: 2, at: at(1) }, { net: -50, r: -1, at: at(2) }, { net: -60, r: -1, at: at(3) }, { net: 80, r: 1.5, at: at(4) },
    ], 1000, 10);
    assert.equal(s.closed, 4); assert.equal(s.wins, 2); assert.equal(s.losses, 2);
    assert.equal(s.win_rate, 0.5);
    assert.equal(s.profit_factor, round(180 / 110));
    assert.equal(s.avg_win_r, 1.75); assert.equal(s.avg_loss_r, -1);
    assert.equal(s.realised, 70); assert.equal(s.equity, 1080);
    // peak 1100 after the first trade, trough 990 after the third: 10%
    assert.equal(s.max_drawdown, 0.1);
    assert.equal(s.drawdown_at?.getDate(), 3);
    assert.deepEqual(s.curve.map((c) => c.equity), [1100, 1050, 990, 1070]);
  });
  it('is empty rather than wrong with nothing closed', () => {
    const s = stats([], 500);
    assert.equal(s.win_rate, null); assert.equal(s.profit_factor, null); assert.equal(s.max_drawdown, 0);
    assert.equal(s.equity, 500);
  });
  function round(n: number) { return Number(n.toFixed(8)); }
});

describe("the desk's steer", () => {
  const base = { wins: 8, closed: 10, unrealised: 30, risk: 100, ageMs: 5 * 60_000 };
  it('does nothing without a target, without a stop, or on a trade under a minute old', async () => {
    const { steer } = await import('../src/autotrader.ts');
    assert.equal(steer({ ...base, target: null }), null);
    assert.equal(steer({ ...base, target: 0.72, risk: 0 }), null);
    assert.equal(steer({ ...base, target: 0.72, ageMs: 30_000 }), null);
  });
  it('banks anything that has cleared its fees by a sliver of its risk', async () => {
    const { steer } = await import('../src/autotrader.ts');
    assert.deepEqual(steer({ ...base, target: 0.72, unrealised: 2 }), { close: 'win' });
    assert.deepEqual(steer({ ...base, wins: 10, closed: 10, target: 0.72, unrealised: 2 }), { close: 'win' }, 'above target too');
    assert.equal(steer({ ...base, target: 0.72, unrealised: 1 }), null, 'two percent of the risk is the bar');
  });
  it('never cuts a loser, whatever the record', async () => {
    const { steer } = await import('../src/autotrader.ts');
    assert.equal(steer({ ...base, wins: 6, closed: 10, target: 0.72, unrealised: -90 }), null);
    assert.equal(steer({ ...base, wins: 10, closed: 10, target: 0.72, unrealised: -90 }), null);
    assert.equal(steer({ ...base, wins: 0, closed: 0, target: 0.72, unrealised: -60 }), null);
  });
});
