import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFundamentals, readOf } from '../src/fundamentals.ts';

const row = (symbol: string, rank: number, extra: Record<string, unknown> = {}) => ({
  symbol, name: symbol.toUpperCase(), market_cap_rank: rank, market_cap: 1.6e12, fully_diluted_valuation: 1.6e12,
  total_volume: 2.7e10, circulating_supply: 20_100_000, max_supply: 21_000_000, ath: 126_080,
  ath_date: '2025-10-06T10:57:42.000Z', ath_change_percentage: -36.7, price_change_percentage_24h_in_currency: -0.2,
  price_change_percentage_7d_in_currency: 1.5, price_change_percentage_30d_in_currency: -5.7,
  high_24h: 80_680, low_24h: 79_421, last_updated: '2026-10-27T08:24:50.000Z', ...extra,
});

test('coins are filled in from the market, everything else is not covered', async () => {
  let calls = 0;
  const f = makeFundamentals({
    enabled: () => true,
    fetch: async (url) => {
      calls++;
      assert.match(url, /symbols=btc,render/, 'asked under the market\'s own tickers');
      return { ok: true, json: async () => [row('btc', 1), row('render', 40, { max_supply: null }), row('btc', 900, { name: 'A copycat' })] };
    },
  });
  const crypto = (s: string) => s !== 'XAUUSD';
  const out = await f.forSymbols(['BTCUSD', 'RNDRUSD', 'XAUUSD'], crypto);
  const btc = out[0]!;
  assert.ok(btc.available);
  if (btc.available) {
    assert.equal(btc.name, 'BTC', 'the largest coin with the ticker, not a copycat');
    assert.ok(Math.abs(btc.turnover! - 2.7e10 / 1.6e12) < 1e-12);
    assert.ok(Math.abs(btc.issued! - 20.1 / 21) < 1e-9);
    assert.equal(btc.read.size, 'Large cap');
    assert.equal(btc.read.supply, 'Mostly issued');
  }
  const rndr = out[1]!;
  assert.ok(rndr.available && rndr.issued === null && rndr.read.supply === 'No fixed cap');
  assert.deepEqual(out[2], { symbol: 'XAUUSD', available: false });
  await f.forSymbols(['BTCUSD'], crypto);
  assert.equal(calls, 1, 'cached between calls');
});

test('an outage reports nothing rather than throwing', async () => {
  const f = makeFundamentals({ enabled: () => true, fetch: async () => { throw new Error('down'); } });
  assert.deepEqual(await f.forSymbols(['BTCUSD'], () => true), [{ symbol: 'BTCUSD', available: false }]);
});

test('the plain readings follow their stated thresholds', () => {
  assert.equal(readOf({ market_cap: 5e9, volume: 2e9, issued: 0.4, change_30d: 12 }).size, 'Mid cap');
  assert.equal(readOf({ market_cap: 5e9, volume: 2e9, issued: 0.4, change_30d: 12 }).liquidity, 'Deep liquidity');
  assert.equal(readOf({ market_cap: 5e8, volume: 5e7, issued: 0.4, change_30d: -15 }).trend, 'Weak month');
  assert.equal(readOf({ market_cap: 5e8, volume: 5e7, issued: 0.4, change_30d: -15 }).supply, 'Early in issuance');
});
