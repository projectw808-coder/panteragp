import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFill, isTriggered, positionSize, trailStop, unrealized } from '../src/trading.ts';

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
