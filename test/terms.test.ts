/**
 * What the trading terms can and cannot do.
 *
 * The arithmetic is simple; the properties are the point. Both dials are costs, both are
 * blind to whether a trade is winning, and no setting of either turns a loss into a gain.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commission, executionPrice, MAX_BPS, termsOf } from '../src/terms.ts';

const terms = (commission_bps: number, spread_bps = 0) => termsOf({ commission_bps, spread_bps });

describe('trading terms default to costing nothing', () => {
  it('an account with nothing set is charged nothing', () => {
    const t = termsOf(null);
    assert.equal(t.commission_bps, 0);
    assert.equal(t.spread_bps, 0);
    assert.equal(executionPrice(100, 'buy', t), 100);
    assert.equal(commission(10, 100, t), 0);
  });

  it('a null on one dial does not disturb the other', () => {
    const t = termsOf({ commission_bps: 25, spread_bps: null });
    assert.equal(t.commission_bps, 25);
    assert.equal(t.spread_bps, 0);
  });
});

describe('spread always moves against the client', () => {
  it('a buyer pays above the market and a seller receives below it', () => {
    const t = terms(0, 50);                       // 50 bps = 0.5%
    assert.equal(executionPrice(100, 'buy', t), 100.5);
    assert.equal(executionPrice(100, 'sell', t), 99.5);
  });

  it('the direction comes from the side and from nothing else', () => {
    // The same side gets the same treatment at any price, so there is no input that makes
    // the spread pay the client instead of costing them.
    const t = terms(0, 100);
    for (const mid of [0.0001, 1, 63_000, 1e6]) {
      assert.ok(executionPrice(mid, 'buy', t) > mid, `buy at ${mid}`);
      assert.ok(executionPrice(mid, 'sell', t) < mid, `sell at ${mid}`);
    }
  });

  it('a round trip at an unchanged price loses exactly the spread, twice', () => {
    const t = terms(0, 50);
    const bought = executionPrice(100, 'buy', t);
    const sold = executionPrice(100, 'sell', t);
    assert.ok(sold < bought, 'buying and selling at one price cannot make money');
    assert.equal(Number((bought - sold).toFixed(8)), 1);   // 0.5% each way
  });
});

describe('commission is a price, not a share of the result', () => {
  it('is charged on the size of the trade', () => {
    assert.equal(commission(10, 100, terms(25)), 2.5);     // 25 bps of 1,000
    assert.equal(commission(2, 63_000, terms(10)), 126);
  });

  it('does not depend on which way the trade went', () => {
    // The same fill costs the same whether the client is up or down on it: nothing in the
    // inputs describes an outcome, which is what keeps this a fee.
    assert.equal(commission(5, 200, terms(30)), commission(-5, 200, terms(30)));
    assert.equal(commission(5, 200, terms(30)), commission(5, -200, terms(30)));
  });

  it('is never negative, at any setting', () => {
    for (const bps of [0, 1, 25, 250, MAX_BPS]) {
      assert.ok(commission(3, 1_000, terms(bps)) >= 0);
    }
  });

  it('at the ceiling still costs a fraction of the notional', () => {
    // 500 bps is 5%: painful, disclosed, and nowhere near able to take an account.
    assert.equal(commission(1, 1_000, terms(MAX_BPS)), 50);
  });
});

describe('what the terms cannot do', () => {
  it('cannot turn a losing trade into a winning one', () => {
    // Buy at 100, price falls to 90, sell. Whatever the terms, the client is down.
    for (const c of [0, 25, 250, MAX_BPS]) {
      for (const sp of [0, 25, 250, MAX_BPS]) {
        const t = terms(c, sp);
        const bought = executionPrice(100, 'buy', t);
        const sold = executionPrice(90, 'sell', t);
        const gross = (sold - bought) * 1;
        const net = gross - commission(1, bought, t) - commission(1, sold, t);
        assert.ok(net < 0, `terms ${c}/${sp} must not rescue a losing trade`);
        assert.ok(net <= gross, `terms ${c}/${sp} must not improve on the market`);
      }
    }
  });

  it('cannot improve on the market for a winning trade either', () => {
    for (const c of [0, 25, MAX_BPS]) {
      for (const sp of [0, 25, MAX_BPS]) {
        const t = terms(c, sp);
        const bought = executionPrice(100, 'buy', t);
        const sold = executionPrice(120, 'sell', t);
        const net = (sold - bought) - commission(1, bought, t) - commission(1, sold, t);
        assert.ok(net <= 20, `terms ${c}/${sp} must not pay more than the move`);
      }
    }
  });
});
