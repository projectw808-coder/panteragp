import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEnabled, makeLiveCrypto } from '../src/live-prices.ts';

const reply = (result: unknown) => ({ ok: true, json: async () => ({ error: [], result }) });

function fakeKraken(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    if (url.endsWith('/AssetPairs')) return reply({ XXBTZUSD: { altname: 'XBTUSD' }, XETHZUSD: { altname: 'ETHUSD' } });
    if (url.includes('/Ticker?')) return reply({ XXBTZUSD: { c: ['80230.5', '1'], o: '80772.0' }, XETHZUSD: { c: ['2328.1', '1'], o: '2355.7' } });
    if (url.includes('/OHLC?')) return reply({ XXBTZUSD: [[1, '1', '1', '1', '80100', '0', '0', 0], [2, '1', '1', '1', '80230', '0', '0', 0]], last: 2 });
    throw new Error('unexpected ' + url);
  };
}

test('real prices are mapped back from the exchange names to the platform symbols', async () => {
  const calls: string[] = [];
  const live = makeLiveCrypto({ fetch: fakeKraken(calls) });
  const q = await live.quotes(['BTCUSD', 'ETHUSD', 'NOPEUSD']);
  assert.equal(q.get('BTCUSD')?.price, 80230.5);
  assert.equal(q.get('BTCUSD')?.open, 80772);
  assert.equal(q.get('ETHUSD')?.price, 2328.1);
  assert.equal(q.has('NOPEUSD'), false, 'a symbol the exchange does not list falls back to the platform');
  assert.ok(calls.some((u) => u.includes('pair=XBTUSD,ETHUSD')), 'BTC is asked for under the exchange name XBT');
  assert.equal(live.last('BTCUSD'), 80230.5);
});

test('an exchange outage serves nothing rather than throwing', async () => {
  const live = makeLiveCrypto({ fetch: async () => { throw new Error('down'); } });
  const q = await live.quotes(['BTCUSD']);
  assert.equal(q.size, 0);
  assert.equal(live.last('BTCUSD'), null);
});

test('the feed stays off in tests and when switched off', () => {
  assert.equal(liveEnabled({ NODE_TEST_CONTEXT: 'child' } as NodeJS.ProcessEnv), false);
  assert.equal(liveEnabled({ PRICE_FEED: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(liveEnabled({} as NodeJS.ProcessEnv), true);
});
