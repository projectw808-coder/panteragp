import { test } from 'node:test';
import assert from 'node:assert/strict';
import { krakenAlt, liveEnabled, makeLiveMarket } from '../src/live-market.ts';

const reply = (result: unknown) => ({ ok: true, json: async () => ({ error: [], result }) });
const T0 = 1_800_000_000;                 // seconds, on a minute boundary
const clock = { ms: (T0 + 30) * 1000 };   // thirty seconds into the current minute

function fakeKraken() {
  return async (url: string) => {
    if (url.endsWith('/AssetPairs')) return reply({ XXBTZUSD: { altname: 'XBTUSD' }, XETHZUSD: { altname: 'ETHUSD' }, RENDERUSD: { altname: 'RENDERUSD' } });
    if (url.includes('/Ticker?')) return reply({ XXBTZUSD: { c: ['80230.5', '1'], o: '80772.0' }, XETHZUSD: { c: ['2328.1', '1'], o: '2355.7' } });
    if (url.includes('/OHLC?pair=XBTUSD&interval=1')) {
      return reply({ XXBTZUSD: [[T0 - 120, '80000', '80100', '79900', '80050', '0', '2', 1], [T0 - 60, '80050', '80200', '80000', '80150', '0', '3', 1], [T0, '80150', '80180', '80120', '80160', '0', '1', 1]], last: T0 });
    }
    throw new Error('unexpected ' + url);
  };
}

test('platform symbols are asked for under the exchange names', () => {
  assert.equal(krakenAlt('BTCUSD'), 'XBTUSD');
  assert.equal(krakenAlt('DOGEUSD'), 'XDGUSD');
  assert.equal(krakenAlt('RNDRUSD'), 'RENDERUSD');
  assert.equal(krakenAlt('ETHUSD'), 'ETHUSD');
});

test('live prices, candles that follow them, and prices at past moments', async () => {
  const live = makeLiveMarket({ fetch: fakeKraken(), now: () => clock.ms, spacingMs: 0 });
  live._setSymbols(['BTCUSD', 'ETHUSD', 'RNDRUSD', 'EOSUSD']);
  await live._loadPairs();
  await live._tick();
  assert.equal(live.price('BTCUSD'), 80230.5);
  assert.equal(live.open('ETHUSD'), 2355.7);
  assert.equal(live.listed('RNDRUSD'), true, 'Render is listed under its new name');
  assert.equal(live.listed('EOSUSD'), false, 'a coin the exchange does not list stays with the platform');
  assert.equal(live.price('EOSUSD'), null);

  assert.equal(live.candles('BTCUSD', '1m', 10), null, 'history is asked for on first sight');
  await live._fetchSeries('BTCUSD', '1m');
  const cs = live.candles('BTCUSD', '1m', 10)!;
  assert.equal(cs.length, 3);
  const last = cs[cs.length - 1]!;
  assert.equal(last.close, 80230.5, 'the bar now forming closes at the live price');
  assert.equal(last.high, 80230.5);

  const mid = live.priceAt('BTCUSD', (T0 - 90) * 1000)!;
  assert.ok(mid > 80000 && mid < 80150, `a past moment reads from the real history (${mid})`);
  assert.equal(live.priceAt('BTCUSD', (T0 - 100_000) * 1000), null, 'before the history held, nothing is invented');
});

test('an outage leaves no price rather than throwing', async () => {
  const live = makeLiveMarket({ fetch: async () => { throw new Error('down'); }, spacingMs: 0 });
  live._setSymbols(['BTCUSD']);
  await assert.rejects(live._loadPairs());
  assert.equal(live.price('BTCUSD'), null);
  assert.equal(live.candles('BTCUSD', '1m', 5), null);
});

test('the feed stays off in tests and when switched off', () => {
  assert.equal(liveEnabled({ NODE_TEST_CONTEXT: 'child' } as NodeJS.ProcessEnv), false);
  assert.equal(liveEnabled({ PRICE_FEED: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(liveEnabled({} as NodeJS.ProcessEnv), true);
});
