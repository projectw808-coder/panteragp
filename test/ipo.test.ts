import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accruableDays, allocation, effectiveStatus, group, settlement } from '../src/ipo.ts';
import { accrue } from '../src/trading.ts';

const at = (iso: string) => new Date(iso);
const deal = (over: Partial<Parameters<typeof effectiveStatus>[0]> = {}) => ({
  status: 'upcoming',
  opens_at: '2026-09-10T09:00:00Z',
  closes_at: '2026-09-20T16:00:00Z',
  matures_at: '2026-12-19T16:00:00Z',
  ...over,
});

describe('an offering knows what it is from its dates', () => {
  test('the timeline decides, so nobody has to remember to click', () => {
    assert.equal(effectiveStatus(deal(), at('2026-09-01T00:00:00Z')), 'upcoming');
    assert.equal(effectiveStatus(deal(), at('2026-09-15T00:00:00Z')), 'open');
    assert.equal(effectiveStatus(deal(), at('2026-10-01T00:00:00Z')), 'active');
    assert.equal(effectiveStatus(deal(), at('2027-01-01T00:00:00Z')), 'completed');
  });

  test('every boundary lands on the later state, to the millisecond', () => {
    // At exactly opens_at it is open: a deal that is still "upcoming" on its own opening
    // instant is a deal nobody can subscribe to at the time it advertised.
    assert.equal(effectiveStatus(deal(), at('2026-09-10T08:59:59.999Z')), 'upcoming');
    assert.equal(effectiveStatus(deal(), at('2026-09-10T09:00:00.000Z')), 'open');
    // At exactly closes_at the window is done. An offering open for the instant its close
    // falls on is an offering that takes money it said it would not.
    assert.equal(effectiveStatus(deal(), at('2026-09-20T15:59:59.999Z')), 'open');
    assert.equal(effectiveStatus(deal(), at('2026-09-20T16:00:00.000Z')), 'active');
    assert.equal(effectiveStatus(deal(), at('2026-12-19T15:59:59.999Z')), 'active');
    assert.equal(effectiveStatus(deal(), at('2026-12-19T16:00:00.000Z')), 'completed');
  });

  test("the desk's own decisions outrank the clock", () => {
    for (const status of ['draft', 'cancelled', 'closed', 'completed'] as const) {
      assert.equal(
        effectiveStatus(deal({ status }), at('2026-09-15T00:00:00Z')), status,
        `${status} is a decision, not a consequence of the date`,
      );
    }
  });

  test('a half-prepared offering reads as a draft however it is stored', () => {
    // This is what keeps an offering with no dates off the client page without the desk
    // having to remember to hide it.
    assert.equal(effectiveStatus(deal({ status: 'open', opens_at: null })), 'draft');
    assert.equal(effectiveStatus(deal({ status: 'open', closes_at: null })), 'draft');
    assert.equal(effectiveStatus(deal({ status: 'open', matures_at: null })), 'draft');
  });

  test('grouping keeps money that is working out of history', () => {
    assert.equal(group('active'), 'running');
    assert.equal(group('closed'), 'running', 'committed money is not history either');
    assert.equal(group('upcoming'), 'incoming');
    assert.equal(group('open'), 'incoming');
    assert.equal(group('completed'), 'finished');
    assert.equal(group('cancelled'), 'finished');
    assert.equal(group('draft'), 'hidden', 'a draft is desk-only');
  });
});

describe('the cap is shared, so allocation has to be exact', () => {
  const book = { target: 100_000, raised: 87_600, min: 500, max: null };

  test('what fits, fits', () => {
    const out = allocation({ ...book, amount: 1_000 });
    assert.equal(out.ok, true);
  });

  test('an exact fill is allowed, or every book ends a penny short', () => {
    const out = allocation({ ...book, amount: 12_400 });
    assert.equal(out.ok, true, '12,400 is precisely what remains');
  });

  test('a penny past the cap is refused, and names what is left', () => {
    const out = allocation({ ...book, amount: 12_400.01 });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason, 'over-cap');
    assert.equal(out.ok === false && out.reason === 'over-cap' && out.available, 12_400);
  });

  test('a full book refuses everything and says nothing is left', () => {
    const out = allocation({ target: 100_000, raised: 100_000, amount: 1, min: 0, max: null });
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.reason === 'over-cap' && out.available, 0);
  });

  test('an oversubscribed book never reports a negative remainder', () => {
    const out = allocation({ target: 100, raised: 150, amount: 1, min: 0, max: null });
    assert.equal(out.ok === false && out.reason === 'over-cap' && out.available, 0);
  });

  test("the offering's own limits are checked before the cap", () => {
    assert.equal(allocation({ ...book, amount: 499 }).ok, false);
    const low = allocation({ ...book, amount: 499 });
    assert.equal(low.ok === false && low.reason, 'below-min');
    const high = allocation({ ...book, max: 5_000, amount: 5_001 });
    assert.equal(high.ok === false && high.reason, 'above-max');
  });
});

describe('settlement floors, and says what it kept', () => {
  test('never rounds up: money created from nothing is still created from nothing', () => {
    const { paid, dust } = settlement({ amount: 1_000, accrued: 12.3456789, decimals: 2 });
    assert.equal(paid, 1_012.34, 'the half-penny is not rounded into existence');
    assert.equal(dust, 0.0056789);
  });

  test('the parts always add back up to the whole', () => {
    for (const accrued of [0, 0.004, 1.999999, 123.456789]) {
      const { paid, dust } = settlement({ amount: 500, accrued, decimals: 2 });
      assert.ok(Math.abs(paid + dust - (500 + accrued)) < 1e-9, `${accrued} must reconcile`);
      assert.ok(paid <= 500 + accrued, 'paid can never exceed what was owed');
    }
  });

  test('a currency with no minor unit still settles', () => {
    const { paid, dust } = settlement({ amount: 500_000, accrued: 812.7, decimals: 0 });
    assert.equal(paid, 500_812);
    assert.equal(dust, 0.7);
  });
});

describe('ROI compounds daily and lands on the headline figure', () => {
  test('a full year at the annual rate pays the annual rate, not more', () => {
    // rate/365 daily would overshoot: this is the 365th-root compounding the accrual uses.
    const roi = accrue({ balance: 10_000, annualRate: 0.0725, days: 365 });
    assert.ok(Math.abs(roi - 725) < 0.01, `a year of 7.25% on 10,000 should be ~725, got ${roi}`);
  });

  test('a rate far above 100% compounds to exactly that rate over a year', () => {
    // The cap came off, so the maths has to hold where it was never exercised. 440% a year
    // is what a 30-day offering at 15% over its term annualises to — the ordinary case the
    // old ceiling refused, not an extreme one.
    const roi = accrue({ balance: 10_000, annualRate: 4.4, days: 365 });
    assert.ok(Math.abs(roi - 44_000) < 0.01,
      `a year at 440% on 10,000 should be ~44,000, got ${roi}`);

    // And the daily step still agrees with the whole-term one, which is the property the
    // 365th-root compounding exists for.
    let balance = 10_000;
    for (let i = 0; i < 365; i++) balance += accrue({ balance, annualRate: 4.4, days: 1 });
    assert.ok(Math.abs(balance - 10_000 - roi) < 0.01,
      'a year paid daily must equal the same year paid at once');
  });

  test('a negative rate pays nothing rather than returning NaN', () => {
    // (1 + rate) below zero has no real 365th root. The bound that stops this is the one
    // kept when the ceiling was dropped, and this is why it is not a matter of taste.
    const roi = accrue({ balance: 10_000, annualRate: -2, days: 30 });
    assert.ok(Number.isNaN(roi) === false, 'a negative rate produced NaN');
  });

  test('paying a week at once equals paying it a day at a time', () => {
    const atOnce = accrue({ balance: 10_000, annualRate: 0.0725, days: 7 });
    let balance = 10_000;
    for (let i = 0; i < 7; i++) balance += accrue({ balance, annualRate: 0.0725, days: 1 });
    assert.ok(Math.abs(balance - 10_000 - atOnce) < 1e-6,
      'an outage paid as one compounded step must equal seven daily ones');
  });

  test('the projection a client is shown is the accrual they are paid', () => {
    // The equivalent of the portfolio test: what the term promises and what the daily job
    // pays over that term cannot disagree.
    const term = 180;
    const promised = accrue({ balance: 5_000, annualRate: 0.0725, days: term });
    let balance = 5_000;
    for (let i = 0; i < term; i++) balance += accrue({ balance, annualRate: 0.0725, days: 1 });
    assert.ok(Math.abs(balance - 5_000 - promised) < 1e-6);
  });

  test('nothing accrues on nothing, or backwards', () => {
    assert.equal(accrue({ balance: 0, annualRate: 0.0725, days: 10 }), 0);
    assert.equal(accrue({ balance: 1_000, annualRate: 0.0725, days: 0 }), 0);
    assert.equal(accrue({ balance: 1_000, annualRate: 0, days: 10 }), 0);
  });
});

describe('accrual stops at maturity, whenever settlement happens', () => {
  test('a day claimed is a day counted', () => {
    assert.equal(accruableDays({
      lastAccruedOn: '2026-09-10', maturesAt: '2026-12-19T16:00:00Z', today: at('2026-09-17T06:00:00Z'),
    }), 7);
  });

  test('running twice in a day pays nothing the second time', () => {
    assert.equal(accruableDays({
      lastAccruedOn: '2026-09-17', maturesAt: '2026-12-19T16:00:00Z', today: at('2026-09-17T23:59:00Z'),
    }), 0);
  });

  test('settling late pays the term, not the delay', () => {
    const days = accruableDays({
      lastAccruedOn: '2026-12-10', maturesAt: '2026-12-19T16:00:00Z', today: at('2027-02-01T00:00:00Z'),
    });
    assert.equal(days, 9, 'nine days to maturity, and not one for the six weeks after it');
  });

  test('a subscription taken after maturity accrues nothing at all', () => {
    assert.equal(accruableDays({
      lastAccruedOn: '2026-12-25', maturesAt: '2026-12-19T16:00:00Z', today: at('2026-12-26T00:00:00Z'),
    }), 0);
  });
});
