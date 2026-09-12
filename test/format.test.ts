import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { price, result, tone } from '../web/src/format.ts';

describe('a result on the signal log', () => {
  it('never prints a plus and a minus together', () => {
    // The bug that was on screen: Number('-0.00') is negative zero, and -0 >= 0 is true,
    // so the sign was taken from the raw value and "+-0.00" was printed.
    assert.equal(result(-0), '0.00');
    for (const n of [-0, -0.001, -0.004, 0.001, 0.004, -1.235, 1.235]) {
      assert.ok(!result(n).includes('+-'), `"+-" in result(${n}) = ${result(n)}`);
      assert.ok(!result(n).includes('-−'), `double minus in result(${n})`);
    }
  });

  it('does not call a result of nothing a result of zero', () => {
    // 0.00 is a claim that nothing happened. Something did; it is just under a cent.
    assert.equal(result(0.004), '+<0.01');
    assert.equal(result(-0.004), '−<0.01');
    assert.equal(result(0), '0.00');
  });

  it('rounds and signs ordinary figures the usual way', () => {
    assert.equal(result(1.235), '+1.24');
    assert.equal(result(-1.235), '−1.24');
    assert.equal(result(0.65), '+0.65');
    assert.equal(result(-462.17), '−462.17');
  });

  it('uses a real minus sign, not a hyphen', () => {
    assert.ok(result(-5).startsWith('−'), 'expected U+2212');
  });
});

describe('a price on the signal log', () => {
  it('does not round a sub-cent instrument down to zero', () => {
    // BONKUSD at two decimals read "0.00", which is a price of zero — a different claim.
    assert.notEqual(price(0.00002341), '0.00');
    assert.ok(price(0.00002341).startsWith('0.00002'), price(0.00002341));
  });

  it('keeps two decimals once the price is worth reading that way', () => {
    assert.equal(price(462.17), '462.17');
    assert.equal(price(1), '1.00');
    assert.equal(price(56.1949), '56.19');
  });

  it('never returns an empty or NaN string for the values the feed produces', () => {
    for (const n of [0, 0.000001, 0.15, 0.93, 1.24, 592.37, 120000]) {
      const s = price(n);
      assert.ok(s.length > 0 && !s.includes('NaN'), `price(${n}) = ${s}`);
    }
  });
});

describe('the colour of a result', () => {
  it('treats a gain too small to print as a gain', () => {
    assert.equal(tone(0.004), 'text-up');
    assert.equal(tone(-0.004), 'text-down');
  });

  it('treats no result, and negative zero, as neither', () => {
    assert.equal(tone(0), 'text-slate-ink');
    assert.equal(tone(-0), 'text-slate-ink');
  });
});
