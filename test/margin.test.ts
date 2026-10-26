import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marginCheck } from '../src/trading.ts';

const flat = { cash: 100_000, leverage: 1, book: [], symbolQty: 0 };

test('an order that fits in free margin passes, one that does not is refused', () => {
  assert.equal(marginCheck({ ...flat, side: 'buy', qty: 1, price: 80_000 }).ok, true);
  const big = marginCheck({ ...flat, side: 'buy', qty: 1600, price: 80_000 });
  assert.equal(big.ok, false, '$128m of bitcoin on $100k is refused');
  assert.equal(big.required, 128_000_000);
  assert.equal(big.free, 100_000);
});

test('leverage divides what an order needs', () => {
  assert.equal(marginCheck({ ...flat, leverage: 5, side: 'buy', qty: 6, price: 80_000 }).ok, true);
  assert.equal(marginCheck({ ...flat, leverage: 5, side: 'buy', qty: 7, price: 80_000 }).ok, false);
});

test('closing or shrinking needs nothing, even with no margin free', () => {
  const book = [{ qty: 10, avg_price: 90_000, price: 80_000 }];   // a long that has lost
  const broke = { cash: 0, leverage: 1, book, symbolQty: 10 };
  assert.equal(marginCheck({ ...broke, side: 'sell', qty: 10, price: 80_000 }).ok, true);
  assert.equal(marginCheck({ ...broke, side: 'sell', qty: 4, price: 80_000 }).adds, 0);
});

test('flipping through zero needs margin for the new side only', () => {
  const book = [{ qty: 1, avg_price: 80_000, price: 80_000 }];
  const r = marginCheck({ cash: 100_000, leverage: 1, book, symbolQty: 1, side: 'sell', qty: 2, price: 80_000 });
  assert.equal(r.adds, 1);
  assert.equal(r.free, 20_000, 'cash less the margin the open long already uses');
  assert.equal(r.ok, false);
});

test('open profit counts towards what is free, and open losses against it', () => {
  const up = [{ qty: 1, avg_price: 60_000, price: 80_000 }];
  assert.equal(marginCheck({ cash: 70_000, leverage: 1, book: up, symbolQty: 1, side: 'buy', qty: 0.1, price: 80_000 }).free, 10_000);
  const down = [{ qty: 1, avg_price: 90_000, price: 80_000 }];
  assert.equal(marginCheck({ cash: 70_000, leverage: 1, book: down, symbolQty: 1, side: 'buy', qty: 0.1, price: 80_000 }).free, 0);
});
