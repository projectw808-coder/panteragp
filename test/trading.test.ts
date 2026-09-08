import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accrue, applyFill, convert, DAYS_PER_YEAR, floorTo, MAX_FLOOR_DECIMALS, isTriggered, positionSize, progress, project, trailStop, unrealized } from '../src/trading.ts';

describe('applyFill', () => {
  test('opens a position at the fill price', () => {
    const r = applyFill(null, { side: 'buy', qty: 10, price: 100 });
    assert.deepEqual(r.position, { qty: 10, avg_price: 100 });
    assert.equal(r.realized, 0);
  });

  test('opens a short with negative quantity', () => {
    const r = applyFill(null, { side: 'sell', qty: 4, price: 50 });
    assert.deepEqual(r.position, { qty: -4, avg_price: 50 });
  });

  test('averages the entry when adding to a position', () => {
    const r = applyFill({ qty: 10, avg_price: 100 }, { side: 'buy', qty: 10, price: 120 });
    assert.deepEqual(r.position, { qty: 20, avg_price: 110 });
    assert.equal(r.realized, 0, 'adding to a position realises nothing');
  });

  test('realises P&L when reducing a long, leaving the entry untouched', () => {
    const r = applyFill({ qty: 10, avg_price: 100 }, { side: 'sell', qty: 4, price: 130 });
    assert.deepEqual(r.position, { qty: 6, avg_price: 100 });
    assert.equal(r.realized, 120);                       // 4 × (130 − 100)
  });

  test('realises P&L when reducing a short', () => {
    // Short from 50, buy back 2 at 40 — a short makes money when the price falls.
    const r = applyFill({ qty: -5, avg_price: 50 }, { side: 'buy', qty: 2, price: 40 });
    assert.deepEqual(r.position, { qty: -3, avg_price: 50 });
    assert.equal(r.realized, 20);                        // 2 × (50 − 40)
  });

  test('closing flat realises the whole move and clears the entry', () => {
    const r = applyFill({ qty: 10, avg_price: 100 }, { side: 'sell', qty: 10, price: 90 });
    assert.deepEqual(r.position, { qty: 0, avg_price: 0 });
    assert.equal(r.realized, -100);
  });

  test('crossing through zero realises the old side and re-opens at the fill price', () => {
    const r = applyFill({ qty: 5, avg_price: 100 }, { side: 'sell', qty: 8, price: 110 });
    assert.equal(r.realized, 50, '5 units closed at +10');
    assert.deepEqual(r.position, { qty: -3, avg_price: 110 }, 'the remaining 3 are short at 110');
  });

  test('a round trip nets the price difference, whatever the path', () => {
    let pos = applyFill(null, { side: 'buy', qty: 3, price: 100 }).position;
    let pnl = 0;
    for (const f of [{ qty: 1, price: 110 }, { qty: 1, price: 120 }, { qty: 1, price: 90 }]) {
      const r = applyFill(pos, { side: 'sell', ...f });
      pos = r.position;
      pnl += r.realized;
    }
    assert.equal(pos.qty, 0);
    assert.equal(pnl, 20);                               // (110−100) + (120−100) + (90−100)
  });
});

test('unrealized is signed by the direction of the position', () => {
  assert.equal(unrealized({ qty: 10, avg_price: 100 }, 105), 50);
  assert.equal(unrealized({ qty: -10, avg_price: 100 }, 105), -50);
});

describe('isTriggered', () => {
  const o = (over: Partial<Parameters<typeof isTriggered>[0]>) =>
    ({ side: 'buy', type: 'market', limit_price: null, stop_price: null, ...over }) as Parameters<typeof isTriggered>[0];

  test('market fills immediately', () => {
    assert.ok(isTriggered(o({}), 123));
  });

  test('a buy limit fills at or below its price, never above', () => {
    assert.ok(isTriggered(o({ type: 'limit', limit_price: 100 }), 100));
    assert.ok(isTriggered(o({ type: 'limit', limit_price: 100 }), 99));
    assert.equal(isTriggered(o({ type: 'limit', limit_price: 100 }), 101), false);
  });

  test('a sell limit fills at or above its price', () => {
    const sell = o({ side: 'sell', type: 'limit', limit_price: 100 });
    assert.ok(isTriggered(sell, 101));
    assert.equal(isTriggered(sell, 99), false);
  });

  test('stops trigger in the opposite direction to limits', () => {
    assert.ok(isTriggered(o({ type: 'stop', stop_price: 100 }), 101));
    assert.equal(isTriggered(o({ type: 'stop', stop_price: 100 }), 99), false);
    const sellStop = o({ side: 'sell', type: 'stop', stop_price: 100 });
    assert.ok(isTriggered(sellStop, 99));
    assert.equal(isTriggered(sellStop, 101), false);
  });

  test('stop-limit needs the stop breached and the limit still satisfied', () => {
    const sl = o({ type: 'stop_limit', stop_price: 100, limit_price: 102 });
    assert.ok(isTriggered(sl, 101));
    assert.equal(isTriggered(sl, 99), false, 'stop not reached');
    assert.equal(isTriggered(sl, 103), false, 'gapped past the limit');
  });
});

describe('trailStop', () => {
  test('follows a long in profit and never retreats', () => {
    const o = { side: 'sell' as const, stop_price: 90, trail_amount: 10 };
    assert.equal(trailStop(o, 105), 95, 'price up, stop follows');
    assert.equal(trailStop(o, 95), null, 'price back down, stop holds');
  });

  test('follows a short down', () => {
    const o = { side: 'buy' as const, stop_price: 110, trail_amount: 10 };
    assert.equal(trailStop(o, 95), 105);
    assert.equal(trailStop(o, 105), null);
  });

  test('seeds the stop when there is not one yet', () => {
    assert.equal(trailStop({ side: 'sell', stop_price: null, trail_amount: 5 }, 100), 95);
    assert.equal(trailStop({ side: 'sell', stop_price: null, trail_amount: null }, 100), null);
  });
});

describe('positionSize', () => {
  test('risks exactly the requested percentage at the stop', () => {
    // 1% of 10,000 = 100 at risk; a 2-point stop means 50 units.
    const qty = positionSize({ balance: 10_000, riskPct: 1, entry: 100, stop: 98 });
    assert.equal(qty, 50);
    assert.equal(qty * Math.abs(100 - 98), 100);
  });

  test('is capped by the margin leverage allows', () => {
    // Risk alone would want 5,000 units; 1× leverage on 10,000 at 100 allows only 100.
    assert.equal(positionSize({ balance: 10_000, riskPct: 1, entry: 100, stop: 99.98 }), 100);
    assert.equal(positionSize({ balance: 10_000, riskPct: 1, entry: 100, stop: 99.98, leverage: 30 }), 3000);
  });

  test('refuses to size without a real stop distance', () => {
    assert.equal(positionSize({ balance: 10_000, riskPct: 1, entry: 100, stop: 100 }), 0);
    assert.equal(positionSize({ balance: 0, riskPct: 1, entry: 100, stop: 98 }), 0);
    assert.equal(positionSize({ balance: 10_000, riskPct: 0, entry: 100, stop: 98 }), 0);
  });
});

describe('currency conversion', () => {
  // Rates are USD per unit: 1 GBP = 1.266 USD, 1 USD = 1 USD, 1 JPY = 0.0066 USD.
  const GBP = 1.266, USD = 1, JPY = 0.0066, BTC = 64000;
  const conv = (o: Parameters<typeof convert>[0]) => {
    const r = convert(o);
    assert.ok(r, 'expected this conversion to be possible');
    return r;
  };

  test('converts at the cross rate', () => {
    const r = conv({ amount: 100, fromUsd: GBP, toUsd: USD, decimals: 2 });
    assert.equal(r.rate, 1.266);
    assert.equal(r.received, 126.6);
  });

  test('is reversible to within the rounding it declares', () => {
    const there = conv({ amount: 100, fromUsd: GBP, toUsd: USD, decimals: 2 });
    const back = conv({ amount: there.received, fromUsd: USD, toUsd: GBP, decimals: 2 });
    assert.ok(Math.abs(back.received - 100) <= 0.01, `round trip drifted to ${back.received}`);
  });

  test('rounds down, never up - a conversion must not create money', () => {
    assert.equal(conv({ amount: 1, fromUsd: GBP, toUsd: USD, decimals: 2 }).received, 1.26);
    assert.equal(conv({ amount: 0.999, fromUsd: BTC, toUsd: USD, decimals: 2 }).received, 63936);
  });

  test('reports the dust it rounded away', () => {
    const r = conv({ amount: 1, fromUsd: GBP, toUsd: USD, decimals: 2 });
    assert.ok(r.dustUsd > 0 && r.dustUsd < 0.01, `dust was ${r.dustUsd}`);
  });

  test('honours the destination minor unit', () => {
    const r = conv({ amount: 100, fromUsd: USD, toUsd: JPY, decimals: 0 });
    assert.equal(r.received % 1, 0, `${r.received} is not a whole number of yen`);
    assert.ok(r.received > 15000 && r.received < 15200);
    const sats = conv({ amount: 1000, fromUsd: USD, toUsd: BTC, decimals: 8 });
    assert.ok((String(sats.received).split('.')[1] ?? '').length <= 8);
  });

  test('refuses when either side has no price', () => {
    assert.equal(convert({ amount: 10, fromUsd: null, toUsd: USD, decimals: 2 }), null);
    assert.equal(convert({ amount: 10, fromUsd: USD, toUsd: null, decimals: 2 }), null);
    assert.equal(convert({ amount: 10, fromUsd: 0, toUsd: USD, decimals: 2 }), null);
  });

  test('refuses an amount that would round away to nothing', () => {
    // A dust amount of BTC into yen is worth under one yen: debiting it and crediting
    // zero would simply consume the balance.
    assert.equal(convert({ amount: 0.000000001, fromUsd: BTC, toUsd: JPY, decimals: 0 }), null);
    assert.equal(convert({ amount: 0, fromUsd: USD, toUsd: GBP, decimals: 2 }), null);
    assert.equal(convert({ amount: -5, fromUsd: USD, toUsd: GBP, decimals: 2 }), null);
  });

  test('floorTo does not mangle values already on the boundary', () => {
    assert.equal(floorTo(0.1 + 0.2, 2), 0.3);
    assert.equal(floorTo(126.6, 2), 126.6);
    assert.equal(floorTo(2.675, 2), 2.67);
    assert.equal(floorTo(15151.5151, 0), 15151);
  });

  test('floorTo never rounds up, even for assets declaring 18 decimals', () => {
    // 10**18 is past Number.MAX_SAFE_INTEGER, where Math.floor stops truncating and can
    // hand back more than it was given. Capping at MAX_FLOOR_DECIMALS is what stops a
    // conversion into ETH from crediting a fraction the rate never earned.
    const v = 0.31994266627420376;
    assert.ok(floorTo(v, 18) <= v, 'flooring must never increase a value');
    assert.equal(floorTo(v, 18), floorTo(v, MAX_FLOOR_DECIMALS));
    for (const decimals of [0, 2, 6, 8, 15, 18]) {
      assert.ok(floorTo(v, decimals) <= v, `floorTo rounded up at ${decimals} decimals`);
    }
  });
});

describe('portfolio projection', () => {
  test('compounds to the annual rate over a year', () => {
    // Monthly compounding derived from the annual rate must land back on it after 12
    // months, not overshoot the way naive rate/12 does.
    const v = project({ balance: 1000, annualRate: 0.05, years: 1 });
    assert.ok(Math.abs(v! - 1050) < 0.01, `a year at 5% gave ${v}`);
  });

  test('grows with time and with contributions', () => {
    const alone = project({ balance: 1000, annualRate: 0.05, years: 10 })!;
    const longer = project({ balance: 1000, annualRate: 0.05, years: 20 })!;
    const topped = project({ balance: 1000, annualRate: 0.05, years: 10, monthly: 100 })!;
    assert.ok(longer > alone);
    assert.ok(topped > alone);
    assert.ok(topped > 1000 + 100 * 120, 'contributions should themselves earn something');
  });

  test('a zero rate returns the money paid in, and nothing more', () => {
    assert.equal(project({ balance: 500, annualRate: 0, years: 5 }), 500);
    assert.equal(project({ balance: 0, annualRate: 0, years: 2, monthly: 50 }), 1200);
  });

  test('says nothing rather than implying growth it cannot promise', () => {
    assert.equal(project({ balance: 1000, annualRate: null, years: 10 }), null);
    assert.equal(project({ balance: 1000, annualRate: 0.05, years: 0 }), null);
    assert.equal(project({ balance: 1000, annualRate: 0.05, years: -3 }), null);
  });
});

describe('portfolio progress', () => {
  test('reports the fraction of the target reached', () => {
    assert.equal(progress(250, 1000), 0.25);
    assert.equal(progress(0, 1000), 0);
  });

  test('caps at complete, so an overfunded pot is not shown as 340%', () => {
    assert.equal(progress(3400, 1000), 1);
  });

  test('has nothing to report without a target', () => {
    assert.equal(progress(250, null), null);
    assert.equal(progress(250, 0), null);
  });
});

describe('interest accrual', () => {
  test('a full year of daily compounding lands on the headline rate', () => {
    // The point of the 365th root: annualRate/365 compounded daily would overshoot 5%.
    const earned = accrue({ balance: 1000, annualRate: 0.05, days: DAYS_PER_YEAR });
    assert.ok(Math.abs(earned - 50) < 0.01, `a year at 5% earned ${earned}`);
  });

  test('agrees with the projection shown to the client', () => {
    // Same money, same rate, same year, two different code paths: they must not disagree.
    const viaAccrual = 1000 + accrue({ balance: 1000, annualRate: 0.05, days: DAYS_PER_YEAR });
    const viaProjection = project({ balance: 1000, annualRate: 0.05, years: 1 })!;
    assert.ok(Math.abs(viaAccrual - viaProjection) < 0.01,
      `accrual said ${viaAccrual}, projection said ${viaProjection}`);
  });

  test('compounds rather than adding a flat daily amount', () => {
    const oneDay = accrue({ balance: 10000, annualRate: 0.05, days: 1 });
    const twoDays = accrue({ balance: 10000, annualRate: 0.05, days: 2 });
    assert.ok(twoDays > oneDay * 2, 'two days should beat twice one day, however slightly');
    assert.ok(twoDays < oneDay * 2.001);
  });

  test('catching up several days equals accruing them one at a time', () => {
    // This is what makes a missed run safe: a five-day catch-up must not pay differently
    // from five daily runs.
    let daily = 1000;
    for (let d = 0; d < 5; d++) daily += accrue({ balance: daily, annualRate: 0.04, days: 1 });
    const caughtUp = 1000 + accrue({ balance: 1000, annualRate: 0.04, days: 5 });
    assert.ok(Math.abs(daily - caughtUp) < 1e-6, `${daily} vs ${caughtUp}`);
  });

  test('pays nothing when there is nothing to pay', () => {
    assert.equal(accrue({ balance: 1000, annualRate: null, days: 30 }), 0, 'no rate');
    assert.equal(accrue({ balance: 1000, annualRate: 0, days: 30 }), 0, 'zero rate');
    assert.equal(accrue({ balance: 1000, annualRate: 0.05, days: 0 }), 0, 'no elapsed days');
    assert.equal(accrue({ balance: 0, annualRate: 0.05, days: 30 }), 0, 'empty pot');
    assert.equal(accrue({ balance: 1000, annualRate: 0.05, days: -3 }), 0, 'clock went backwards');
  });

  test('a small balance still earns, instead of rounding to nothing every day', () => {
    // 100 units at 3.5% earns well under a minor unit per day. Flooring daily would mean
    // it never grew at all, so the fraction is kept.
    const earned = accrue({ balance: 100, annualRate: 0.035, days: 1 });
    assert.ok(earned > 0, 'a small pot must still accrue something');
    assert.ok(earned < 0.01);
  });
});
