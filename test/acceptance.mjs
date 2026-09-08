/**
 * End-to-end acceptance check: walks every phase against a running stack and a database
 * seeded only by db/schema.sql. Unlike `npm test` this needs the API up:
 *
 *   npm run dev:db
 *   DATABASE_URL=... JWT_SECRET=... PG_POOL_MAX=1 npm run dev
 *   npm run test:e2e
 *
 * It asserts rather than prints, so a regression anywhere fails the run.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const B = process.env.API ?? 'http://localhost:3000';
const j = (r) => r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (path, { token, method = 'GET', body } = {}) => fetch(B + path, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const get = (path, opts) => call(path, opts).then(j);
const status = (path, opts) => call(path, opts).then((r) => r.status);

const login = (email, password, as) =>
  get('/auth/login', { method: 'POST', body: { email, password, as } });

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ok  ' + name);
};

// ---------------------------------------------------------------------------

console.log('\nPhase 1 — auth and RBAC');
const admin = await login('admin@local.test', 'devpassword', 'staff');
assert.ok(admin.token, 'seed account admin@local.test must exist (src/devdb.ts or src/seed.ts)');
const A = admin.token;

await step('bad password is rejected', async () =>
  assert.equal(await status('/auth/login', { method: 'POST', body: { email: 'admin@local.test', password: 'wrongpassword', as: 'staff' } }), 401));
await step('no token is 401', async () => assert.equal(await status('/clients'), 401));
await step('admin identity round-trips', async () => {
  const me = await get('/me', { token: A });
  assert.equal(me.kind, 'staff');
  assert.equal(me.role, 'admin');
});

console.log('\nPhase 2 — CRM core');
const email = `acceptance+${Date.now()}@example.com`;
const client = await get('/clients', { token: A, method: 'POST', body: { name: 'Acceptance Ada', email, country: 'IE', password: 'devpassword' } });
await step('client is created and never returns its password hash', () => {
  assert.ok(client.id);
  assert.ok(!('password_hash' in client));
});
await step('pipeline stage change lands on the timeline', async () => {
  await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { stage_id: 5, risk_profile: 'medium' } });
  const timeline = await get(`/clients/${client.id}/timeline`, { token: A });
  assert.ok(timeline.some((a) => a.kind === 'stage'));
});
await step('note and task appear on the timeline', async () => {
  await get(`/clients/${client.id}/notes`, { token: A, method: 'POST', body: { text: 'Acceptance note' } });
  const staff = await get('/staff', { token: A });
  await get('/tasks', { token: A, method: 'POST', body: { client_id: client.id, assigned_to: staff[0].id, title: 'Acceptance task' } });
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('note') && kinds.includes('task'));
});
await step('every change is in the audit log, without secrets', async () => {
  const audit = await get(`/audit?row_id=${client.id}`, { token: A });
  assert.ok(audit.length >= 2, 'insert and update both audited');
  assert.ok(audit.every((a) => !a.after || !('password_hash' in a.after)), 'password_hash must never be copied');
  assert.ok(audit.some((a) => a.action === 'UPDATE' && a.before.stage_id !== a.after.stage_id));
});

console.log('\nPhase 3 — charting data');
await step('instruments are seeded', async () => {
  const instruments = await get('/instruments', { token: A });
  assert.ok(instruments.length >= 6);
  assert.ok(instruments.some((i) => i.symbol === 'EURUSD'));
});
await step('candles respect OHLC invariants on every timeframe', async () => {
  for (const tf of ['1m', '15m', '1H', '1D', '1W']) {
    const bars = await get(`/candles?symbol=EURUSD&tf=${tf}&limit=50`, { token: A });
    assert.equal(bars.length, 50, `${tf} returned ${bars.length} bars`);
    for (const b of bars) {
      assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close), `bad candle on ${tf}`);
    }
  }
});
await step('unknown symbols and timeframes are refused', async () => {
  assert.equal(await status('/candles?symbol=NOPE', { token: A }), 404);
  assert.equal(await status('/candles?symbol=EURUSD&tf=3Y', { token: A }), 400);
});

console.log('\nPhase 4 — live feed');
await step('the socket rejects anything but a valid auth message', async () => {
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(B.replace('http', 'ws') + '/feed');
    ws.on('open', () => ws.send(JSON.stringify({ type: 'tick' })));
    ws.on('close', resolve);
  });
  assert.equal(code, 4401);
});
await step('an authenticated socket receives moving prices', async () => {
  const ticks = await new Promise((resolve, reject) => {
    const ws = new WebSocket(B.replace('http', 'ws') + '/feed');
    const seen = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('no ticks within 6s')); }, 6000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: A })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type !== 'tick') return;
      seen.push(msg.ticks.find((t) => t.symbol === 'BTCUSD').price);
      if (seen.length === 3) { clearTimeout(timer); ws.close(); resolve(seen); }
    });
  });
  assert.equal(ticks.length, 3);
  assert.ok(new Set(ticks).size > 1, 'a price that never changes is not a feed');
});

console.log('\nPhase 5 — paper execution');
const trader = await login(email, 'devpassword', 'client');
const T = trader.token;
await step('a demo account is opened on first use', async () => {
  const account = await get('/account', { token: T });
  assert.equal(account.mode, 'demo');
  assert.equal(Number(account.balance), 100000);
});
await step('staff cannot place orders, and bad orders are refused', async () => {
  assert.equal(await status('/orders', { token: A, method: 'POST', body: { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: 1 } }), 403);
  assert.equal(await status('/orders', { token: T, method: 'POST', body: { symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: 1 } }), 400, 'limit needs a price');
  assert.equal(await status('/orders', { token: T, method: 'POST', body: { symbol: 'BTCUSD', side: 'buy', type: 'market', qty: -1 } }), 400);
  assert.equal(await status('/orders', { token: T, method: 'POST', body: { symbol: 'DOGE', side: 'buy', type: 'market', qty: 1 } }), 404);
});
await step('a market order fills and opens a position', async () => {
  await get('/orders', { token: T, method: 'POST', body: { symbol: 'ETHUSD', side: 'buy', type: 'market', qty: 4 } });
  await wait(400);
  const positions = await get('/positions', { token: T });
  const eth = positions.find((p) => p.symbol === 'ETHUSD');
  assert.ok(eth, 'no ETHUSD position after a market buy');
  assert.equal(Number(eth.qty), 4);
});
await step('closing the position realises P&L onto the balance', async () => {
  const before = Number((await get('/account', { token: T })).balance);
  const entry = Number((await get('/positions', { token: T })).find((p) => p.symbol === 'ETHUSD').avg_price);
  await get('/orders', { token: T, method: 'POST', body: { symbol: 'ETHUSD', side: 'sell', type: 'market', qty: 4 } });
  await wait(400);
  const after = Number((await get('/account', { token: T })).balance);
  const exit = Number((await get('/trades', { token: T }))[0].price);
  assert.ok(!(await get('/positions', { token: T })).some((p) => p.symbol === 'ETHUSD'), 'position should be flat');
  assert.ok(Math.abs((after - before) - (exit - entry) * 4) < 1e-6,
    `balance moved ${after - before}, expected ${(exit - entry) * 4}`);
});
await step('take-profit and stop-loss become linked exit orders', async () => {
  const px = (await get('/quotes', { token: T })).find((q) => q.symbol === 'BTCUSD').price;
  await get('/orders', { token: T, method: 'POST', body: {
    symbol: 'BTCUSD', side: 'buy', type: 'market', qty: 1,
    take_profit: Math.round(px * 1.05), stop_loss: Math.round(px * 0.95) } });
  await wait(500);
  const exits = (await get('/orders?open=true', { token: T })).filter((o) => o.parent_order_id);
  assert.equal(exits.length, 2, 'expected one take-profit and one stop-loss');
  assert.deepEqual(exits.map((o) => o.type).sort(), ['limit', 'stop']);
  assert.equal(new Set(exits.map((o) => o.parent_order_id)).size, 1, 'both exits share one parent');
});
await step('a working order can be cancelled, once', async () => {
  const order = await get('/orders', { token: T, method: 'POST', body: { symbol: 'ETHUSD', side: 'buy', type: 'limit', qty: 1, limit_price: 1 } });
  assert.equal((await get(`/orders/${order.id}`, { token: T, method: 'DELETE' })).status, 'cancelled');
  assert.equal(await status(`/orders/${order.id}`, { token: T, method: 'DELETE' }), 404);
});
await step('every order and fill reached the CRM timeline', async () => {
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('order.placed'), 'placements missing from the timeline');
  assert.ok(kinds.includes('order.filled'), 'fills missing from the timeline');
  assert.ok(kinds.includes('order.cancelled'), 'cancellations missing from the timeline');
});

console.log('\nPhase 6 — compliance');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const upload = async (kind, type) => {
  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('file', new Blob([png], { type }), 'doc');
  return (await fetch(`${B}/clients/${client.id}/kyc`, { method: 'POST', headers: { authorization: `Bearer ${T}` }, body: fd })).status;
};
await step('only permitted document types and kinds are accepted', async () => {
  assert.equal(await upload('id_front', 'image/jpeg'), 201);
  assert.equal(await upload('proof_of_address', 'application/pdf'), 201);
  assert.equal(await upload('id_back', 'application/x-msdownload'), 415);
  assert.equal(await upload('not_a_kind', 'image/jpeg'), 400);
});
await step('documents are readable by compliance only', async () => {
  const doc = (await get('/kyc/pending', { token: A })).find((d) => d.client_id === client.id);
  assert.ok(doc, 'uploaded document not in the review queue');
  assert.equal(await status(`/kyc/${doc.id}/file`, { token: A }), 200);
  assert.equal(await status(`/kyc/${doc.id}/file`, { token: T }), 403, 'the client must not read the raw file');
  assert.equal(await status(`/kyc/${doc.id}/file`), 401);
});
await step('approval requires every required document', async () => {
  const queue = (await get('/kyc/pending', { token: A })).filter((d) => d.client_id === client.id);
  const first = await get(`/kyc/${queue[0].id}/review`, { token: A, method: 'POST', body: { status: 'approved' } });
  assert.equal(first.client_kyc_status, 'pending', 'one of two documents must not approve the client');
  const second = await get(`/kyc/${queue[1].id}/review`, { token: A, method: 'POST', body: { status: 'approved' } });
  assert.equal(second.client_kyc_status, 'approved');
  assert.equal(await status(`/kyc/${queue[0].id}/review`, { token: A, method: 'POST', body: { status: 'rejected' } }), 404, 'a decided document cannot be re-decided');
});
// Counts below are firm-wide, so assert how far this run moved them, not their value.
const pendingBefore = Number((await get('/admin/overview', { token: A })).cash.pending_withdrawals);

await step('a large withdrawal returning a fresh deposit trips both rules', async () => {
  await get('/cash', { token: T, method: 'POST', body: { kind: 'deposit', amount: 60000 } });
  const deposit = (await get('/cash', { token: T })).find((c) => c.kind === 'deposit');
  await get(`/cash/${deposit.id}/decide`, { token: A, method: 'POST', body: { status: 'approved' } });
  const withdrawal = await get('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 55000 } });
  const rules = withdrawal.flags.map((f) => f.rule).sort();
  assert.deepEqual(rules, ['large_withdrawal', 'rapid_withdrawal_after_deposit']);
  assert.ok(withdrawal.flags.every((f) => f.severity === 'high'));
});
await step('withdrawing more than the balance is refused', async () =>
  assert.equal(await status('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 9e8 } }), 400));
await step('a withdrawal debits the balance immediately', async () => {
  const before = Number((await get('/account', { token: T })).balance);
  await get('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 1000 } });
  const after = Number((await get('/account', { token: T })).balance);
  assert.equal(before - after, 1000, 'the money should leave on request, not on approval');
});
await step('rejecting a withdrawal puts the money back', async () => {
  const before = Number((await get('/account', { token: T })).balance);
  const pending = (await get('/cash', { token: T })).find((c) => c.kind === 'withdrawal' && c.status === 'pending' && Number(c.amount) === -1000);
  await get(`/cash/${pending.id}/decide`, { token: A, method: 'POST', body: { status: 'rejected' } });
  assert.equal(Number((await get('/account', { token: T })).balance) - before, 1000, 'a rejected withdrawal must be refunded');
  const refund = (await get(`/clients/${client.id}/timeline`, { token: A }))
    .find((a) => a.ref_id === String(pending.id) && a.summary.includes('rejected'));
  assert.ok(refund?.summary.includes('refunded'), 'the refund must be visible on the timeline');
});
await step('approving a withdrawal does not debit it twice', async () => {
  const before = Number((await get('/account', { token: T })).balance);
  const w = await get('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 500 } });
  assert.equal(before - Number((await get('/account', { token: T })).balance), 500);
  await get(`/cash/${w.transaction.id}/decide`, { token: A, method: 'POST', body: { status: 'approved' } });
  assert.equal(before - Number((await get('/account', { token: T })).balance), 500, 'approval must not debit a second time');
  assert.equal(await status(`/cash/${w.transaction.id}/decide`, { token: A, method: 'POST', body: { status: 'rejected' } }), 404,
    'a decided transaction cannot be reversed after the fact');
});
await step('flags surface in the CRM and can be escalated', async () => {
  const flags = await get(`/flags?status=open&client_id=${client.id}`, { token: A });
  assert.ok(flags.length >= 2);
  assert.equal(flags[0].severity, 'high', 'highest severity must sort first');
  await get(`/flags/${flags[0].id}`, { token: A, method: 'PATCH', body: { status: 'escalated' } });
  assert.equal((await get(`/flags?status=escalated&client_id=${client.id}`, { token: A })).length, 1);
});
await step('reports export as CSV with formulas defused', async () => {
  const rows = await get('/reports/clients', { token: A });
  const row = rows.find((r) => r.email === email);
  assert.equal(Number(row.deposits), 60000);
  assert.equal(Number(row.withdrawals), 500, 'only the approved withdrawal counts as paid out');
  assert.equal(Number(row.withdrawals_pending), 55000, 'debited but unpaid is reported separately');
  assert.equal(Number(row.net_deposits), 59500);
  assert.equal(row.kyc_status, 'approved');

  const res = await call('/reports/clients.csv', { token: A });
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"/);
  const text = await res.text();
  assert.ok(text.split('\r\n').length > 1);
  assert.ok(!/^[=+@]/m.test(text), 'a cell begins with a formula character');

  assert.equal(await status('/reports/nope', { token: A }), 404);
  assert.equal(await status('/reports/clients', { token: T }), 403);
});

console.log('\nCurrencies, credits and wallets');
await step('the currency list covers world fiat and crypto, with correct minor units', async () => {
  const all = await get('/currencies', { token: A });
  const by = Object.fromEntries(all.map((c) => [c.code, c]));
  assert.ok(all.filter((c) => c.kind === 'fiat').length > 100, 'expected a worldwide fiat list');
  for (const code of ['USD', 'GBP', 'EUR', 'CAD']) assert.equal(by[code].decimals, 2, code);
  assert.equal(by.JPY.decimals, 0, 'yen has no minor unit');
  assert.equal(by.KWD.decimals, 3, 'the dinar has three');
  assert.equal(by.BTC.decimals, 8);
  assert.equal(by.ETH.decimals, 18);
});
await step('an admin can credit any currency, and nobody else can', async () => {
  for (const [currency, value] of [['GBP', 5000], ['EUR', 2500], ['CAD', 1200], ['JPY', 300000]]) {
    const r = await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency, amount: value, note: 'acceptance' } });
    assert.ok(r.transaction, `credit in ${currency} failed: ${JSON.stringify(r)}`);
  }
  assert.equal(await status(`/clients/${client.id}/credit`, { token: T, method: 'POST', body: { currency: 'GBP', amount: 1 } }), 403,
    'a client must not be able to credit itself');
  assert.equal(await status(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'XYZ', amount: 1 } }), 404);
  assert.equal(await status(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'GBP', amount: -5 } }), 400);
  assert.equal(await status(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'BTC', amount: 1 } }), 400,
    'crypto belongs on the wallet route');
});
await step('balances appear per currency with a USD total', async () => {
  const acct = await get('/accounts', { token: T });
  const held = Object.fromEntries(acct.cash.map((c) => [c.currency, Number(c.balance)]));
  assert.equal(held.GBP, 5000);
  assert.equal(held.JPY, 300000);
  assert.ok(acct.total_usd > 0);
  const gbp = acct.cash.find((c) => c.currency === 'GBP');
  assert.ok(gbp.usd_value > gbp.balance, 'sterling should convert to more dollars than its face');
});
await step('wallets are simulated, and say so in the address', async () => {
  const wallet = await get('/wallets', { token: T, method: 'POST', body: { asset: 'BTC' } });
  assert.match(wallet.address, /^DEMO-BTC-/, 'an address must never look fundable');
  assert.equal(await status('/wallets', { token: T, method: 'POST', body: { asset: 'GBP' } }), 400, 'fiat is not a wallet asset');
  assert.equal(await status('/wallets', { token: T, method: 'POST', body: { asset: 'NOPE' } }), 404);
  const again = await get('/wallets', { token: T, method: 'POST', body: { asset: 'BTC' } });
  assert.equal(again.id, wallet.id, 'opening the same wallet twice returns the same wallet');
});
await step('a wallet withdrawal debits immediately and refunds on rejection', async () => {
  await get(`/clients/${client.id}/wallet-credit`, { token: A, method: 'POST', body: { asset: 'BTC', amount: 0.5 } });
  const wallet = (await get('/wallets', { token: T })).find((w) => w.asset === 'BTC');
  assert.equal(Number(wallet.balance), 0.5);

  const wd = await get(`/wallets/${wallet.id}/withdraw`, { token: T, method: 'POST', body: { amount: 0.2, to_address: 'DEMO-BTC-elsewhere' } });
  const debited = (await get('/wallets', { token: T })).find((w) => w.asset === 'BTC');
  assert.ok(Math.abs(Number(debited.balance) - 0.3) < 1e-12, 'the coin should leave on request');

  await get(`/wallet-transactions/${wd.id}/decide`, { token: A, method: 'POST', body: { status: 'rejected' } });
  const refunded = (await get('/wallets', { token: T })).find((w) => w.asset === 'BTC');
  assert.ok(Math.abs(Number(refunded.balance) - 0.5) < 1e-12, 'a rejected withdrawal must come back');
  assert.equal(await status(`/wallets/${wallet.id}/withdraw`, { token: T, method: 'POST', body: { amount: 999, to_address: 'DEMO-x' } }), 400);
});
await step('one client cannot withdraw from another client wallet', async () => {
  const wallet = (await get('/wallets', { token: T })).find((w) => w.asset === 'BTC');
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy', email: `nosy+${Date.now()}@example.com`, password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal(await status(`/wallets/${wallet.id}/withdraw`, { token: N, method: 'POST', body: { amount: 0.01, to_address: 'DEMO-x' } }), 404);
});
await step('credits and wallet movements reach the CRM timeline', async () => {
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('credit'), 'credits missing from the timeline');
  assert.ok(kinds.includes('wallet'), 'wallet creation missing from the timeline');
});


console.log('\nPhase 7 — admin dashboard');
await step('the overview agrees with the underlying endpoints', async () => {
  const o = await get('/admin/overview', { token: A });
  const clients = await get('/clients?limit=200', { token: A });
  assert.equal(Number(o.clients.total), clients.length);
  assert.equal(Number(o.flags.open), (await get('/flags?status=open', { token: A })).length);
  assert.equal(Number(o.kyc.pending_docs), (await get('/kyc/pending', { token: A })).length);
  assert.equal(o.pipeline.reduce((n, p) => n + Number(p.clients), 0), clients.length, 'pipeline must account for every client');
  assert.ok(Number(o.trading.volume_today) > 0);
  assert.equal(Number(o.cash.pending_withdrawals) - pendingBefore, 1, 'this run added exactly one pending withdrawal');
});
await step('config reports live trading as disabled', async () => {
  const config = await get('/admin/config', { token: A });
  assert.equal(config.live_trading_enabled, false);
  assert.ok(config.flag_rules.largeWithdrawal > 0);
});
await step('the firm-wide feed is staff-only', async () => {
  assert.ok((await get('/activity?limit=10', { token: A })).length > 0);
  assert.equal(await status('/activity', { token: T }), 403);
  assert.equal(await status('/admin/overview', { token: T }), 403);
});

console.log('\nCross-cutting');
await step('a token for a deleted subject is unauthorised, not a crash', async () => {
  const { SignJWT } = await import('jose');
  const forged = await new SignJWT({ kind: 'client', role: 'trader' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('00000000-0000-0000-0000-000000000000')
    .setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  for (const path of ['/account', '/positions', '/orders', '/trades']) {
    assert.equal(await status(path, { token: forged }), 401, `${path} leaked a 500`);
  }
});
await step('the trader sees no CRM, the client record is its own', async () => {
  assert.equal(await status('/clients', { token: T }), 403);
  assert.equal(await status('/audit', { token: T }), 403);
  assert.equal(await status(`/clients/${client.id}`, { token: T }), 200);
});

console.log(`\n${passed} checks passed across all seven phases.\n`);
