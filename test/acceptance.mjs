/**
 * End-to-end acceptance check: walks every phase against a running stack and a database
 * seeded only by db/schema.sql. Unlike `npm test` this needs the API up:
 *
 *   npm run dev:db
 *   DATABASE_URL=... JWT_SECRET=... PG_POOL_MAX=1 npm run dev
 *   JWT_SECRET=... npm run test:e2e
 *
 * It asserts rather than prints, so a regression anywhere fails the run.
 */
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { WebSocket } from 'ws';
import { SignJWT } from 'jose';

/*
 * Several checks forge a token to prove the API rejects it for the right reason. Without
 * the real secret they would be signed with garbage and rejected for the wrong one, so a
 * broken auth check would still look like a pass. Refuse to run rather than lie.
 */
const SECRET = process.env.JWT_SECRET;
assert.ok(SECRET, 'set JWT_SECRET to the same value the API is running with');
const forge = (claims, sub) => new SignJWT(claims)
  .setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
  .setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET));

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

// Date.now() alone collides when two of these land in the same millisecond, which turns a
// duplicate-email 409 into a confusing 401 three assertions later. The counter makes each
// address unique within a run, the clock keeps it unique between runs.
let seq = 0;
const unique = (prefix) => `${prefix}+${Date.now()}-${++seq}@example.com`;

await step('bad password is rejected', async () =>
  assert.equal(await status('/auth/login', { method: 'POST', body: { email: 'admin@local.test', password: 'wrongpassword', as: 'staff' } }), 401));
await step('no token is 401', async () => assert.equal(await status('/clients'), 401));
await step('admin identity round-trips', async () => {
  const me = await get('/me', { token: A });
  assert.equal(me.kind, 'staff');
  assert.equal(me.role, 'admin');
});

console.log('\nPhase 2 — CRM core');
const email = unique('acceptance');
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
await step('a demo account is opened on first use, and opens empty', async () => {
  const account = await get('/account', { token: T });
  assert.equal(account.mode, 'demo');
  // Accounts start at zero on purpose: holdings must trace back to a funding decision
  // somebody made, not to a balance the system granted on first login.
  assert.equal(Number(account.balance), 0);
});

await step('the desk funds the account before it can trade', async () => {
  await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: {
    currency: 'USD', amount: 100000, note: 'opening balance' } });
  const account = await get('/account', { token: T });
  assert.equal(Number(account.balance), 100000, 'the credit should reach the trading account');
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
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy', email: unique('nosy'), password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal(await status(`/wallets/${wallet.id}/withdraw`, { token: N, method: 'POST', body: { amount: 0.01, to_address: 'DEMO-x' } }), 404);
});
await step('credits and wallet movements reach the CRM timeline', async () => {
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('credit'), 'credits missing from the timeline');
  assert.ok(kinds.includes('wallet'), 'wallet creation missing from the timeline');
});
await step('a quote prices the pair without moving anything', async () => {
  const q = await get('/convert/quote?from=GBP&to=USD&amount=1000', { token: T });
  assert.ok(q.received > 1000, 'sterling buys more than its face in dollars');
  assert.ok(q.rate > 1);
  assert.equal(await status('/convert/quote?from=GBP&to=GBP&amount=10', { token: T }), 400, 'same currency');
  assert.equal(await status('/convert/quote?from=GBP&to=ZZZ&amount=10', { token: T }), 404);
  assert.equal(await status('/convert/quote?from=XMR&to=USD&amount=1', { token: T }), 422, 'no price source');
});
await step('exchanging debits one balance and credits the other exactly', async () => {
  const held = async (code) => {
    const a = await get('/accounts', { token: T });
    const row = a.cash.find((c) => c.currency === code) ?? a.wallets.find((w) => w.asset === code);
    return row ? Number(row.balance) : 0;
  };
  const gbpBefore = await held('GBP');
  const usdBefore = await held('USD');
  const done = await get('/convert', { token: T, method: 'POST', body: { from: 'GBP', to: 'USD', amount: 1000 } });
  assert.ok(Math.abs((gbpBefore - await held('GBP')) - 1000) < 1e-9, 'the debit must be exactly the amount asked for');
  assert.ok(Math.abs((await held('USD') - usdBefore) - Number(done.to_amount)) < 1e-6, 'the credit must match the recorded amount');
});
await step('converting into a zero-decimal currency yields whole units', async () => {
  const done = await get('/convert', { token: T, method: 'POST', body: { from: 'USD', to: 'JPY', amount: 100 } });
  assert.equal(Number(done.to_amount) % 1, 0, `${done.to_amount} is not a whole number of yen`);
});
await step('a round trip never ends with more than it started', async () => {
  const held = async (code) => {
    const a = await get('/accounts', { token: T });
    const row = a.cash.find((c) => c.currency === code);
    return row ? Number(row.balance) : 0;
  };
  const start = await held('GBP');
  const out = await get('/convert', { token: T, method: 'POST', body: { from: 'GBP', to: 'USD', amount: 500 } });
  await get('/convert', { token: T, method: 'POST', body: { from: 'USD', to: 'GBP', amount: Number(out.to_amount) } });
  const end = await held('GBP');
  assert.ok(end <= start, `a round trip created money: ${start} -> ${end}`);
  assert.ok(start - end < 0.05, `a round trip lost too much: ${start - end}`);
});
await step('conversion refuses what it cannot do', async () => {
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'GBP', to: 'USD', amount: 1e9 } }), 400, 'over balance');
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'CHF', to: 'USD', amount: 10 } }), 400, 'currency not held');
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'XMR', to: 'USD', amount: 1 } }), 422, 'unpriced');
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'GBP', to: 'USD', amount: -5 } }), 400);
  assert.equal(await status('/convert', { token: A, method: 'POST', body: { from: 'GBP', to: 'USD', amount: 1 } }), 403, 'staff do not hold balances');
});
await step('the slippage guard refuses an exchange that would underdeliver', async () => {
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'GBP', to: 'USD', amount: 10, min_receive: 1e6 } }), 409);
});
await step('exchanges are recorded and reach the timeline', async () => {
  assert.ok((await get('/conversions', { token: T })).length > 0);
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('convert'), 'conversions missing from the timeline');
});

console.log('\nPortfolios');
const gbp = async () => {
  const a = await get('/accounts', { token: T });
  const row = a.cash.find((c) => c.currency === 'GBP');
  return row ? Number(row.balance) : 0;
};
let retirement, savings;

await step('the product catalogue offers the named plans', async () => {
  const types = await get('/portfolio-types', { token: T });
  const codes = types.map((t) => t.code);
  for (const expected of ['retirement', 'savings']) assert.ok(codes.includes(expected), `missing ${expected}`);
  assert.ok(types.find((t) => t.code === 'retirement').indicative_rate > 0);
  assert.equal(types.find((t) => t.code === 'general').indicative_rate, null, 'no rate means no projection');
});

await step('a client opens portfolios, and names stay unique', async () => {
  retirement = await get('/portfolios', { token: T, method: 'POST', body: {
    type_code: 'retirement', name: 'Retirement 2055', currency: 'GBP',
    target_date: '2055-01-01' } });
  savings = await get('/portfolios', { token: T, method: 'POST', body: {
    type_code: 'savings', name: 'Rainy day', currency: 'GBP' } });
  assert.ok(retirement.id && savings.id);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'savings', name: 'Rainy day', currency: 'GBP' } }), 409);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'yacht', name: 'Yacht', currency: 'GBP' } }), 404);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'savings', name: 'Odd', currency: 'ZZZ' } }), 404);
  // Staff act on a named client or not at all: no client_id is a 400, not a portfolio
  // silently opened against the staff member's own id.
  assert.equal(await status('/portfolios', { token: A, method: 'POST', body: { type_code: 'savings', name: 'x', currency: 'GBP' } }), 400);
});

await step('the desk can run a client portfolio, and it is recorded as the desk doing it', async () => {
  const pot = await get('/portfolios', { token: A, method: 'POST', body: {
    client_id: client.id, type_code: 'savings', name: 'Opened by the desk', currency: 'GBP' } });
  assert.ok(pot.id);

  // It belongs to the client, not to the staff member who opened it.
  const theirs = await get(`/portfolios?client_id=${client.id}`, { token: A });
  assert.ok(theirs.some((x) => x.id === pot.id), 'the pot should be on the client');
  assert.ok((await get('/portfolios', { token: T })).some((x) => x.id === pot.id),
    'and the client should see it as their own');

  // Money moved by the desk reaches the client's timeline as the desk, and tells them.
  await get(`/portfolios/${pot.id}/contribute`, { token: A, method: 'POST', body: { client_id: client.id, amount: 25 } });
  const timeline = await get(`/clients/${client.id}/timeline`, { token: A });
  assert.ok(timeline.some((a) => a.summary.startsWith('Desk moved')), 'the timeline should say who moved it');
  assert.ok((await get('/notifications', { token: T })).some((n) => n.title.includes('Opened by the desk')),
    'the client should be told about money they did not move');

  // Ordinary CRM write access is not enough: this is the funds:credit power, which is
  // admin-only for the same reason crediting an account is.
  const seller = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Portfolio Sales', email: unique('pf-sales'),
    role: 'sales', password: 'a-long-enough-password' } });
  const sellerToken = (await login(seller.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status(`/portfolios/${pot.id}/contribute`,
    { token: sellerToken, method: 'POST', body: { client_id: client.id, amount: 1 } }), 403);

  // A client naming somebody else is ignored rather than obeyed: they act on themselves.
  // Paying in is the client's own act, so it is the one that shows this.
  const other = await get(`/portfolios/${pot.id}/contribute`, { token: T, method: 'POST', body: {
    client_id: '00000000-0000-4000-8000-000000000000', amount: 5 } });
  assert.ok(other.id, 'a client_id from a client changes nothing');
});

await step("money moved into a pot is still the client's money", async () => {
  const before = await get('/accounts', { token: T });
  await get(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: 500 } });
  const after = await get('/accounts', { token: T });

  // The cash balance falls, which is the point. What the client holds must not: a pot is
  // somewhere the money is, not somewhere it went. Without portfolios in the sum, paying
  // 500 into savings read as 500 vanishing off the client's own balance screen.
  //
  // Counted in GBP rather than in the USD total, because crypto prices tick between the
  // two reads and a dollar comparison would need slack wide enough to hide the bug.
  const gbpHeld = (a) => [...a.cash, ...a.portfolios]
    .filter((x) => x.currency === 'GBP')
    .reduce((n, x) => n + Number(x.balance), 0);
  assert.ok(Math.abs(gbpHeld(after) - gbpHeld(before)) < 1e-9,
    'moving money into a pot must not change what the client holds');
  assert.ok(gbpHeld(before) > 0, 'and there has to be something there for that to mean anything');
  assert.ok(after.portfolios.some((x) => Number(x.balance) > 0), 'the pot is listed as a holding');

  // And it is the same figure the desk sees on the client record.
  const staffSide = await get(`/clients/${client.id}/holdings`, { token: A });
  assert.ok(Math.abs(staffSide.totals.holdings_usd - after.total_usd) < after.total_usd * 0.01,
    'both sides answer "what do they have" with the same number');

  await get(`/portfolios/${savings.id}/withdraw`, { token: T, method: 'POST', body: { amount: 500 } });
});

await step('the desk sets what a pot earns, and nobody else does', async () => {
  const before = (await get('/portfolios', { token: T })).find((x) => x.id === savings.id);
  assert.equal(before.rate_override, null, 'a new pot is on the product rate');

  await get(`/portfolios/${savings.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, rate_override: 0.0725 } });
  const after = (await get('/portfolios', { token: T })).find((x) => x.id === savings.id);
  // indicative_rate is the effective one, so the client is shown what they will actually
  // be paid rather than the product's headline.
  assert.equal(Number(after.indicative_rate), 0.0725);
  assert.equal(Number(after.standard_rate), Number(before.indicative_rate));

  // A client may rename their pot. What it pays them is a term of the account.
  assert.equal(await status(`/portfolios/${savings.id}`, { token: T, method: 'PATCH', body: { rate_override: 0.9 } }), 403);
  assert.equal(Number((await get('/portfolios', { token: T })).find((x) => x.id === savings.id).indicative_rate), 0.0725);

  // 35 typed for 3.5 is a hundredfold, so the range is refused rather than stored.
  assert.equal(await status(`/portfolios/${savings.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, rate_override: 35 } }), 400);

  assert.ok((await get('/notifications', { token: T })).some((n) => n.title.includes('7.25% a year')),
    'the client is told when what they earn changes');
  assert.ok((await get(`/clients/${client.id}/timeline`, { token: A }))
    .some((x) => x.summary.includes('7.25% a year')));

  // Clearing it puts the pot back on the product rate rather than on nothing.
  await get(`/portfolios/${savings.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, rate_override: null } });
  const back = (await get('/portfolios', { token: T })).find((x) => x.id === savings.id);
  assert.equal(back.rate_override, null);
  assert.equal(Number(back.indicative_rate), Number(before.indicative_rate));
});

await step('contributing moves money out of the balance, and back again', async () => {
  const before = await gbp();
  await get(`/portfolios/${retirement.id}/contribute`, { token: T, method: 'POST', body: { amount: 3000 } });
  const afterIn = await gbp();
  assert.ok(Math.abs((before - afterIn) - 3000) < 1e-9, 'the balance should fall by exactly the contribution');

  const pots = await get('/portfolios', { token: T });
  const pot = pots.find((p) => p.id === retirement.id);
  assert.equal(Number(pot.balance), 3000);

  // The client cannot simply take it back: that is what a request is for, and leaving the
  // direct route open would make the approval flow decoration one API call walks around.
  assert.equal(await status(`/portfolios/${retirement.id}/withdraw`, { token: T, method: 'POST', body: {
    amount: 1000 } }), 403);

  const asked = await get(`/portfolios/${retirement.id}/requests`, { token: T, method: 'POST', body: {
    amount: 1000, note: 'acceptance run' } });
  assert.equal(asked.status, 'pending');
  assert.equal(await gbp(), afterIn, 'asking moves nothing');

  // More than the pot holds, counting what is already asked for.
  assert.equal(await status(`/portfolios/${retirement.id}/requests`, { token: T, method: 'POST', body: {
    amount: 2500 } }), 400);

  // Deciding needs funds:credit, like every other route where staff move a balance.
  const seller = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Request Sales', email: unique('req-sales'), role: 'sales', password: 'a-long-enough-password' } });
  const sellerToken = (await login(seller.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status(`/portfolio-requests/${asked.id}/decide`, { token: sellerToken, method: 'POST', body: {
    status: 'approved' } }), 403);

  await get(`/portfolio-requests/${asked.id}/decide`, { token: A, method: 'POST', body: {
    status: 'approved', note: 'fine' } });
  assert.ok(Math.abs((await gbp() - afterIn) - 1000) < 1e-9, 'approving returns it to the balance');
  assert.equal(Number((await get('/portfolios', { token: T })).find((p) => p.id === retirement.id).balance), 2000);
  assert.equal(await status(`/portfolio-requests/${asked.id}/decide`, { token: A, method: 'POST', body: {
    status: 'approved' } }), 409, 'and it cannot be decided twice');

  assert.ok((await get('/notifications', { token: T })).some((n) => n.title.includes('released from')),
    'the client is told the decision');
});

await step('a dated pot projects, and an undated one does not', async () => {
  const pot = (await get('/portfolios', { token: T })).find((p) => p.id === retirement.id);
  assert.ok(pot.projected > Number(pot.balance), 'a dated pot with a rate should project growth');
  const rainy = (await get('/portfolios', { token: T })).find((p) => p.id === savings.id);
  assert.equal(rainy.projected, null, 'no target date means no projection');
});

await step('one pot at a time rides on the balance strip', async () => {
  await get(`/portfolios/${retirement.id}/feature`, { token: T, method: 'POST', body: { featured: true } });
  // Choosing a second replaces the first rather than being refused by the unique index.
  await get(`/portfolios/${savings.id}/feature`, { token: T, method: 'POST', body: { featured: true } });
  const on = (await get('/accounts', { token: T })).portfolios.filter((p) => p.featured);
  assert.equal(on.length, 1, 'only one pot is featured');
  assert.equal(on[0].id, savings.id, 'and it is the one just chosen');

  await get(`/portfolios/${savings.id}/feature`, { token: T, method: 'POST', body: { featured: false } });
  assert.equal((await get('/accounts', { token: T })).portfolios.filter((p) => p.featured).length, 0);
  assert.equal(await status(`/portfolios/${savings.id}/feature`, { token: A, method: 'POST', body: {
    featured: true } }), 403, 'which pot a client looks at is not the desk\'s to set');
});

await step('the auto trader switch is the client\'s own', async () => {
  assert.equal((await get('/me/profile', { token: T })).auto_trader, false, 'off until asked for');
  assert.equal((await get('/me/auto-trader', { token: T, method: 'POST', body: { on: true } })).on, true);
  assert.equal((await get('/me/profile', { token: T })).auto_trader, true, 'and it sticks');
  assert.equal(await status('/me/auto-trader', { token: A, method: 'POST', body: { on: true } }), 403);
  await get('/me/auto-trader', { token: T, method: 'POST', body: { on: false } });
});

await step('a portfolio refuses what it cannot do', async () => {
  assert.equal(await status(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: 1e9 } }), 400, 'over balance');
  assert.equal(await status(`/portfolios/${savings.id}/requests`, { token: T, method: 'POST', body: { amount: 1e9 } }), 400, 'over the pot');
  assert.equal(await status(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: -50 } }), 400);
  assert.equal(await status(`/portfolios/${retirement.id}`, { token: T, method: 'PATCH', body: { status: 'closed' } }), 409, 'closing a funded pot would strand the money');
});

await step('one client cannot pay into another client portfolio', async () => {
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Pot', email: unique('pot'), password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal(await status(`/portfolios/${retirement.id}/contribute`, { token: N, method: 'POST', body: { amount: 1 } }), 404);
  // 403 rather than 404 here, and deliberately: the client route is closed to everyone,
  // so a stranger is turned away before the answer could tell them whether it exists.
  assert.equal(await status(`/portfolios/${retirement.id}/withdraw`, { token: N, method: 'POST', body: { amount: 1 } }), 403);
  assert.equal(await status(`/portfolios/${retirement.id}/requests`, { token: N, method: 'POST', body: { amount: 1 } }), 404,
    'nor can they ask for money out of a pot that is not theirs');
});

await step('an emptied portfolio can be closed, and then takes nothing more', async () => {
  const pot = (await get('/portfolios', { token: T })).find((p) => p.id === savings.id);
  if (Number(pot.balance) > 0) {
    // Emptying it goes through the desk now, like any other withdrawal.
    const req = await get(`/portfolios/${savings.id}/requests`, { token: T, method: 'POST', body: {
      amount: Number(pot.balance) } });
    await get(`/portfolio-requests/${req.id}/decide`, { token: A, method: 'POST', body: { status: 'approved' } });
  }
  const closed = await get(`/portfolios/${savings.id}`, { token: T, method: 'PATCH', body: { status: 'closed' } });
  assert.equal(closed.status, 'closed');
  assert.equal(await status(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: 10 } }), 409);
});

await step('staff can read a client portfolio, and it is on the timeline', async () => {
  const staffView = await get(`/portfolios?client_id=${client.id}`, { token: A });
  assert.ok(staffView.length >= 2);
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('portfolio'), 'portfolio activity missing from the timeline');
});

await step('accrual posts nothing on the day a pot was funded, however often it runs', async () => {
  // The acceptance database is fresh, so no whole day has elapsed for any portfolio.
  // Elapsed-day behaviour is pinned by the maths tests in test/trading.test.ts.
  const pots = await get('/portfolios', { token: T });
  const before = Object.fromEntries(pots.map((p) => [p.id, Number(p.balance)]));

  for (let run = 0; run < 3; run++) {
    const result = await get('/admin/accrue', { token: A, method: 'POST' });
    assert.equal(result.posted, 0, 'nothing has been held for a whole day yet');
  }
  const after = Object.fromEntries((await get('/portfolios', { token: T })).map((p) => [p.id, Number(p.balance)]));
  assert.deepEqual(after, before, 'repeated accrual runs must not move a balance');
});
await step('only an admin can trigger accrual', async () => {
  assert.equal(await status('/admin/accrue', { token: T, method: 'POST' }), 403);
  assert.equal(await status('/admin/accrue', { method: 'POST' }), 401);
});

console.log('\nNotifications');
await step('things done to the client are notified', async () => {
  const before = (await get('/notifications', { token: T })).length;
  await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'CHF', amount: 250, note: 'goodwill' } });
  await get(`/clients/${client.id}/notify`, { token: A, method: 'POST', body: { title: 'Welcome aboard', body: 'Your manager is Ada.' } });
  const inbox = await get('/notifications', { token: T });
  assert.equal(inbox.length, before + 2);
  assert.ok(inbox.some((n) => n.kind === 'credit' && n.title.includes('CHF')));
  assert.ok(inbox.some((n) => n.kind === 'message' && n.title === 'Welcome aboard'));
});

await step('things the client did themselves are not', async () => {
  const before = (await get('/notifications', { token: T })).length;
  await get('/orders', { token: T, method: 'POST', body: { symbol: 'EURUSD', side: 'buy', type: 'market', qty: 500 } });
  assert.equal((await get('/notifications', { token: T })).length, before,
    'a market order the client just placed needs no telling');
});

await step('an order the engine fills later is notified, with nobody watching', async () => {
  // Nothing here holds a WebSocket open, which is the point: settlement and its
  // notification must not depend on a client being connected.
  const px = (await get('/quotes', { token: T })).find((q) => q.symbol === 'ETHUSD').price;
  await get('/orders', { token: T, method: 'POST', body: {
    symbol: 'ETHUSD', side: 'buy', type: 'limit', qty: 1, limit_price: Math.round(px * 1.05) } });
  for (let i = 0; i < 20 && !(await get('/notifications?limit=5', { token: T })).some((n) => n.kind === 'order.filled'); i++) {
    await wait(500);
  }
  const fill = (await get('/notifications', { token: T })).find((n) => n.kind === 'order.filled');
  assert.ok(fill, 'a resting order filled by the engine must notify the client');
  assert.match(fill.title, /ETHUSD/);
});

await step('a compliance flag is never disclosed to the client', async () => {
  // Tipping off is a criminal offence in most jurisdictions: flags stop at staff.
  await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'USD', amount: 80000 } });
  const w = await get('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 60000 } });
  assert.ok(w.flags.length > 0, 'this withdrawal should have raised a flag');

  const inbox = await get('/notifications', { token: T });
  const leaked = inbox.filter((n) => /flag|suspic|aml|laundering/i.test(`${n.title} ${n.body ?? ''}`));
  assert.equal(leaked.length, 0, `a flag leaked to the client: ${JSON.stringify(leaked)}`);
  assert.ok((await get(`/flags?status=open&client_id=${client.id}`, { token: A })).length > 0,
    'while staff must still see it');
});

await step('reading is idempotent and scoped to the owner', async () => {
  const unreadNow = async () => (await get('/notifications/unread-count', { token: T })).unread;
  const before = await unreadNow();
  assert.ok(before > 0);
  const first = (await get('/notifications?unread=true', { token: T }))[0];
  await get(`/notifications/${first.id}/read`, { token: T, method: 'POST' });
  assert.equal(await unreadNow(), before - 1);
  await get(`/notifications/${first.id}/read`, { token: T, method: 'POST' });
  assert.equal(await unreadNow(), before - 1, 'marking the same one twice must not double-count');

  const { marked } = await get('/notifications/read-all', { token: T, method: 'POST' });
  assert.equal(marked, before - 1);
  assert.equal(await unreadNow(), 0);
});

await step('an inbox belongs to one person, staff and client alike', async () => {
  const mine = (await get('/notifications', { token: T }))[0];
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Inbox', email: unique('inbox'), password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal((await get('/notifications', { token: N })).length, 0);
  assert.equal(await status(`/notifications/${mine.id}/read`, { token: N, method: 'POST' }), 404);
  assert.equal(await status(`/clients/${client.id}/notify`, { token: T, method: 'POST', body: { title: 'hi' } }), 403);

  // Staff have an inbox of their own now. It must never contain a client's: the two are
  // the same table, and the only thing keeping them apart is the column each side is
  // scoped by, so this is the check that catches a query that forgets.
  const staffInbox = await get('/notifications', { token: A });
  assert.ok(Array.isArray(staffInbox), 'staff read their own inbox');
  assert.ok(staffInbox.every((n) => n.staff_id && !n.client_id),
    'a staff inbox holds staff rows only');
  assert.equal(await status(`/notifications/${mine.id}/read`, { token: A, method: 'POST' }), 404,
    'and staff cannot mark a client notification read');
});

await step('switching a kind off stops it being written', async () => {
  const kinds = await get('/me/notification-prefs', { token: T });
  assert.ok(kinds.some((k) => k.kind === 'credit'), 'the catalogue is for whoever is asking');
  assert.ok(kinds.every((k) => k.enabled), 'everything is on until somebody turns it off');

  // Security notices are the one thing nobody may silence.
  const locked = kinds.find((k) => k.locked);
  assert.equal(locked.kind, 'security');
  assert.equal(await status('/me/notification-prefs', { token: T, method: 'PUT', body: { security: false } }), 422);
  assert.equal(await status('/me/notification-prefs', { token: T, method: 'PUT', body: { 'not.a.kind': false } }), 400);
  // A trader has no business setting a compliance officer's preferences.
  assert.equal(await status('/me/notification-prefs', { token: T, method: 'PUT', body: { 'flag.raised': false } }), 400);

  await get('/me/notification-prefs', { token: T, method: 'PUT', body: { credit: false } });
  const before = (await get('/notifications', { token: T, limit: 100 })).length;
  await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'GBP', amount: 11 } });
  const after = await get('/notifications', { token: T });
  assert.equal(after.length, before, 'a switched-off kind is not written at all');
  assert.ok(!after.some((n) => n.title.includes('11 GBP')));

  // The money still moved and is still on the timeline: the preference governs the bell,
  // never the record.
  const timeline = await get(`/clients/${client.id}/timeline`, { token: A });
  assert.ok(timeline.some((a) => a.summary.includes('Credited 11 GBP')), 'the audit trail is not a preference');

  await get('/me/notification-prefs', { token: T, method: 'PUT', body: { credit: true } });
  await get(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency: 'GBP', amount: 12 } });
  assert.ok((await get('/notifications', { token: T })).some((n) => n.title.includes('12 GBP')),
    'and switching it back on resumes them');
});

await step("a client corrects their own details, but not the desk's assessment of them", async () => {
  const before = await get('/me/profile', { token: T });
  assert.equal(before.email, email);

  const saved = await get('/me/profile', { token: T, method: 'PATCH', body: {
    date_of_birth: '1988-04-02', address: '12 Ludgate Hill, London', phone: '+353 1 234 5678' } });
  // A date has no timezone. Stored as 1988-04-02 it must come back as 1988-04-02, not as
  // the 1st, which is what a Date parsed at local midnight turns into on the way out.
  assert.equal(saved.date_of_birth, '1988-04-02');
  assert.equal(saved.address, '12 Ludgate Hill, London');

  // Emptying a field clears it rather than being ignored.
  assert.equal((await get('/me/profile', { token: T, method: 'PATCH', body: { address: null } })).address, null);

  // Tier, KYC status and the login are the desk's, not theirs. Unknown keys are refused
  // outright rather than quietly dropped, so nobody promotes themselves by guessing a
  // field name and getting a 200 back.
  assert.equal(await status('/me/profile', { token: T, method: 'PATCH', body: { tier: 'platinum' } }), 400);
  assert.equal(await status('/me/profile', { token: T, method: 'PATCH', body: { kyc_status: 'approved' } }), 400);
  assert.equal(await status('/me/profile', { token: T, method: 'PATCH', body: { email: 'someone@else.test' } }), 400);
  assert.equal((await get('/me/profile', { token: T })).tier, before.tier);

  // Staff have no /me/profile: their record is not a client record.
  assert.equal(await status('/me/profile', { token: A }), 403);

  // And the correction lands on the timeline, like every other change to the record.
  assert.ok((await get(`/clients/${client.id}/timeline`, { token: A }))
    .some((x) => x.summary.startsWith('Updated their own details')));
});

await step('staff are told when something needs them, unless they said not to', async () => {
  // Compared by what is at the top rather than by how many there are: the inbox is capped
  // at a page, so a busy desk would show the same count either way.
  const top = async () => (await get('/notifications', { token: A }))[0];
  await get('/tickets', { token: T, method: 'POST', body: {
    subject: 'Notifying the desk', category: 'other', body: 'Please look at this.' } });
  const arrived = await top();
  assert.equal(arrived.kind, 'ticket.activity');
  assert.ok(arrived.title.includes('Notifying the desk'), 'a new ticket should reach the desk');
  assert.ok(arrived.staff_id && !arrived.client_id);

  // Switched off, the same event writes nothing: one preference table, both audiences.
  await get('/me/notification-prefs', { token: A, method: 'PUT', body: { 'ticket.activity': false } });
  await get('/tickets', { token: T, method: 'POST', body: {
    subject: 'Should not reach the desk', category: 'other', body: 'Silence please.' } });
  assert.equal((await top()).id, arrived.id, 'nothing new should have been written');
  await get('/me/notification-prefs', { token: A, method: 'PUT', body: { 'ticket.activity': true } });
});

await step('a wallet is linked by proving it, not by claiming it', async () => {
  // Signs the way MetaMask does, so the endpoint is exercised through its real shape.
  const sign = (message, priv) => {
    const body = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
    const joined = new Uint8Array(prefix.length + body.length);
    joined.set(prefix);
    joined.set(body, prefix.length);
    const sig = secp256k1.sign(keccak_256(joined), priv);
    return '0x' + Buffer.from(sig.toCompactRawBytes()).toString('hex')
      + (27 + sig.recovery).toString(16).padStart(2, '0');
  };
  const addressOf = (priv) => '0x' + Buffer.from(
    keccak_256(secp256k1.getPublicKey(priv, false).subarray(1))).subarray(-20).toString('hex');

  const priv = Buffer.from('a1'.repeat(32), 'hex');
  const address = addressOf(priv);
  const challenge = await get('/me/wallet/challenge', { token: T, method: 'POST', body: { address } });
  assert.ok(challenge.message.includes(challenge.nonce), 'the nonce is in what gets signed');

  const linked = await get('/me/wallet', { token: T, method: 'POST', body: {
    address, nonce: challenge.nonce, signature: sign(challenge.message, priv) } });
  assert.equal(linked.address.toLowerCase(), address.toLowerCase());

  // Claiming an address without the key gets nowhere: the signature has to come from it.
  const someoneElse = addressOf(Buffer.from('b2'.repeat(32), 'hex'));
  const other = await get('/me/wallet/challenge', { token: T, method: 'POST', body: { address: someoneElse } });
  assert.equal(await status('/me/wallet', { token: T, method: 'POST', body: {
    address: someoneElse, nonce: other.nonce, signature: sign(other.message, priv) } }), 400,
    'signing with the wrong key must not link the address');
  assert.equal(await status('/me/wallet', { token: T, method: 'POST', body: {
    address: someoneElse, nonce: other.nonce, signature: '0xgarbage' } }), 400);
  assert.equal(await status('/me/wallet', { token: T, method: 'POST', body: {
    address, nonce: 'not-a-challenge', signature: sign(challenge.message, priv) } }), 400);

  // One address, one account.
  const nosy = await get('/clients', { token: A, method: 'POST', body: {
    name: 'Nosy Wallet', email: unique('wallet'), password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  const theirs = await get('/me/wallet/challenge', { token: N, method: 'POST', body: { address } });
  assert.equal(await status('/me/wallet', { token: N, method: 'POST', body: {
    address, nonce: theirs.nonce, signature: sign(theirs.message, priv) } }), 409,
    'an address already linked elsewhere is refused even with a good signature');

  // A challenge is bound to whoever asked for it, so one client cannot hand theirs over.
  assert.equal(await status('/me/wallet', { token: N, method: 'POST', body: {
    address: someoneElse, nonce: challenge.nonce, signature: sign(challenge.message, priv) } }), 400);

  // Staff can see what a client proved; the client can take it back.
  assert.ok((await get(`/clients/${client.id}/wallets`, { token: A })).some((w) => w.id === linked.id));
  assert.equal((await get(`/me/wallet/${linked.id}`, { token: T, method: 'DELETE' })).unlinked, linked.address);
  assert.equal(await status(`/me/wallet/${linked.id}`, { token: T, method: 'DELETE' }), 404);
});

await step('the desk sets what a client pays to trade, and it costs them either way', async () => {
  const before = await get('/me/profile', { token: T });
  assert.equal(before.terms.commission_bps, 0, 'nothing is charged until the desk says so');
  assert.equal(before.terms.spread_bps, 0);

  // Ordinary CRM write access is not enough: this is the price of the service.
  const seller = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Terms Sales', email: unique('terms-sales'), role: 'sales', password: 'a-long-enough-password' } });
  const sellerToken = (await login(seller.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status(`/clients/${client.id}`, { token: sellerToken, method: 'PATCH', body: {
    commission_bps: 25 } }), 403);

  // A hundredfold typo is refused rather than stored.
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: {
    commission_bps: 9000 } }), 400);

  await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: {
    commission_bps: 25, spread_bps: 10 } });
  assert.equal((await get('/me/profile', { token: T })).terms.commission_bps, 25,
    'the client is told what they are charged');

  const cash = async () => Number((await get('/account', { token: T })).balance);
  const spot = async () => Number((await get('/quotes', { token: T })).find((q) => q.symbol === 'EURUSD').price);

  // Buying fills above the market and selling below it, both times costing commission.
  const openedAt = await spot();
  const beforeBuy = await cash();
  await get('/orders', { token: T, method: 'POST', body: {
    symbol: 'EURUSD', side: 'buy', type: 'market', qty: 1000 } });
  const buy = (await get('/trades', { token: T }))[0];
  assert.ok(Number(buy.price) > openedAt * 0.999, 'a buy does not fill below the market');
  assert.ok(Number(buy.fee) > 0, 'the fill carries its commission');
  // The commission is 25 bps of what was actually traded.
  assert.ok(Math.abs(Number(buy.fee) - (1000 * Number(buy.price) * 0.0025)) < 1e-6);
  // And it came off the balance, before any position was closed.
  assert.ok(Math.abs((beforeBuy - await cash()) - Number(buy.fee)) < 1e-6,
    'commission leaves the balance on the way in');

  // Close it straight back. The market has barely moved, so a round trip must lose money:
  // that is the whole point of these being costs rather than a dial on the outcome.
  const beforeSell = await cash();
  await get('/orders', { token: T, method: 'POST', body: {
    symbol: 'EURUSD', side: 'sell', type: 'market', qty: 1000 } });
  const sell = (await get('/trades', { token: T }))[0];
  assert.ok(Number(sell.price) < Number(buy.price), 'the spread is paid on the way out too');
  assert.ok(await cash() < beforeSell + Number(buy.fee),
    'a round trip at an unchanged price cannot make money');

  // Put them back so the rest of the run is not paying commission it does not expect.
  await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: {
    commission_bps: null, spread_bps: null } });
  assert.equal((await get('/me/profile', { token: T })).terms.commission_bps, 0);
});

console.log('\nStaking');

let stake;
let stakeAsset;
let flexibleProduct;
let lockedProduct;

await step('staking moves crypto out of the wallet and keeps it in the total', async () => {
  const products = await get('/staking-products', { token: T });
  assert.ok(products.length > 0, 'the desk offers something to stake');
  // Whatever the catalogue currently offers, in an asset that has both a flexible and a
  // locked product — naming one here would break every time the desk changes its range.
  flexibleProduct = products.find((f) => f.lock_days === 0
    && products.some((l) => l.asset === f.asset && l.lock_days > 0));
  assert.ok(flexibleProduct, 'the desk offers a flexible product with a locked sibling');
  lockedProduct = products.find((l) => l.asset === flexibleProduct.asset && l.lock_days > 0);
  stakeAsset = flexibleProduct.asset;

  const size = Math.max(2, Number(flexibleProduct.min_amount) * 4, Number(lockedProduct.min_amount) * 4);
  await get(`/clients/${client.id}/wallet-credit`, { token: A, method: 'POST', body: {
    asset: stakeAsset, amount: size * 4 } });

  const heldIn = (a) => [...a.wallets, ...(a.stakes ?? [])]
    .filter((x) => (x.asset ?? x.currency) === stakeAsset)
    .reduce((n, x) => n + Number(x.balance), 0);
  const before = await get('/accounts', { token: T });
  const walletBefore = Number(before.wallets.find((w) => w.asset === stakeAsset).balance);

  stake = await get('/stakes', { token: T, method: 'POST', body: {
    product_code: flexibleProduct.code, amount: size } });
  assert.equal(Number(stake.amount), size);

  const after = await get('/accounts', { token: T });
  assert.ok(Math.abs(Number(after.wallets.find((w) => w.asset === stakeAsset).balance)
    - (walletBefore - size)) < 1e-9, 'the wallet is lighter by exactly what was staked');
  // Staked is not spent. Left out of the total it would read as the asset vanishing.
  assert.ok(Math.abs(heldIn(after) - heldIn(before)) < 1e-9,
    'what the client holds in that asset is unchanged by staking it');
  assert.ok((after.stakes ?? []).some((x) => Number(x.balance) === size), 'the stake is listed as a holding');
});

await step('a stake will not take more than there is, or less than the minimum', async () => {
  assert.equal(await status('/stakes', { token: T, method: 'POST', body: {
    product_code: flexibleProduct.code, amount: 1e9 } }), 400, 'more than the wallet holds');
  assert.equal(await status('/stakes', { token: T, method: 'POST', body: {
    product_code: flexibleProduct.code, amount: Number(flexibleProduct.min_amount) / 2 } }), 400,
    'below the minimum');
  assert.equal(await status('/stakes', { token: T, method: 'POST', body: {
    product_code: 'no_such_product', amount: 1 } }), 404);
});

await step('a lock is a lock, and the desk is not exempt from it', async () => {
  const held = await get('/stakes', { token: T, method: 'POST', body: {
    product_code: lockedProduct.code, amount: Math.max(1, Number(lockedProduct.min_amount) * 2) } });

  const mine = (await get('/stakes', { token: T })).find((s) => s.id === held.id);
  assert.ok(mine.locked, 'it starts locked');
  assert.ok(mine.unlocks_at, 'and says until when');

  assert.equal(await status(`/stakes/${held.id}/unstake`, { token: T, method: 'POST', body: {} }), 409,
    'the client cannot take it back early');
  // The desk cannot simply take it either: an early exit is a change to the agreement,
  // which is a separate, recorded act rather than a way around the lock.
  assert.equal(await status(`/stakes/${held.id}/unstake`, { token: A, method: 'POST', body: {
    client_id: client.id } }), 409, 'nor can the desk, by unstaking it');

  await get(`/stakes/${held.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, unlock_now: true } });
  assert.ok((await get(`/clients/${client.id}/timeline`, { token: A }))
    .some((x) => x.summary.includes('released the lock')), 'releasing a lock is recorded');

  const out = await get(`/stakes/${held.id}/unstake`, { token: T, method: 'POST', body: {} });
  assert.ok(Number(out.returned) > 0, 'the principal comes back');
  assert.equal(await status(`/stakes/${held.id}/unstake`, { token: T, method: 'POST', body: {} }), 409,
    'and it cannot be unstaked twice');
});

await step('the rate on a stake is the desk\'s to set, and nobody else\'s', async () => {
  const before = (await get('/stakes', { token: T })).find((s) => s.id === stake.id);
  assert.equal(before.apy_override, null, 'a new stake is on the product rate');

  assert.equal(await status(`/stakes/${stake.id}`, { token: T, method: 'PATCH', body: {
    apy_override: 0.9 } }), 403, 'a client cannot set what they are paid');

  const seller = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Stake Sales', email: unique('stake-sales'), role: 'sales', password: 'a-long-enough-password' } });
  const sellerToken = (await login(seller.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status(`/stakes/${stake.id}`, { token: sellerToken, method: 'PATCH', body: {
    client_id: client.id, apy_override: 0.09 } }), 403, 'nor does ordinary CRM access');

  assert.equal(await status(`/stakes/${stake.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, apy_override: 5 } }), 400, 'a hundredfold typo is refused');

  await get(`/stakes/${stake.id}`, { token: A, method: 'PATCH', body: {
    client_id: client.id, apy_override: 0.09 } });
  const after = (await get('/stakes', { token: T })).find((s) => s.id === stake.id);
  assert.equal(Number(after.apy), 0.09, 'the client is shown what they will be paid');
  assert.equal(Number(after.product_apy), Number(before.product_apy), 'the product is untouched');
  assert.ok((await get('/notifications', { token: T })).some((n) => n.title.includes('9% a year')),
    'and told when it changes');
});

await step('rewards accrue once a day, however often the job runs', async () => {
  const first = await get('/admin/accrue-staking', { token: A, method: 'POST' });
  assert.ok(typeof first.posted === 'number');
  // Whatever the first run did, a second on the same day must find nothing left to pay.
  const second = await get('/admin/accrue-staking', { token: A, method: 'POST' });
  assert.equal(second.posted, 0, 'running twice in a day pays once');
  assert.equal(await status('/admin/accrue-staking', { token: T, method: 'POST' }), 403);
});

await step('the desk maintains the staking catalogue', async () => {
  const code = `t${Date.now().toString(36)}`;
  const made = await get('/admin/staking-products', { token: A, method: 'POST', body: {
    code, name: 'Test product', asset: 'ETH', description: 'For the acceptance run.',
    apy: 0.04, lock_days: 30, min_amount: 0.5, sort_order: 99 } });
  assert.equal(made.code, code);

  assert.equal(await status('/admin/staking-products', { token: A, method: 'POST', body: {
    code, name: 'x', asset: 'ETH', description: 'y', apy: 0.04 } }), 409, 'codes are unique');
  assert.equal(await status('/admin/staking-products', { token: A, method: 'POST', body: {
    code: `${code}b`, name: 'x', asset: 'NOPE', description: 'y', apy: 0.04 } }), 404, 'the asset must exist');
  assert.equal(await status('/admin/staking-products', { token: A, method: 'POST', body: {
    code: `${code}c`, name: 'x', asset: 'ETH', description: 'y', apy: 5 } }), 400, 'a 500% rate is a typo');

  // A new product is offered to clients straight away, and appears with its numbers.
  const offered = await get('/staking-products', { token: T });
  const mine = offered.find((x) => x.code === code);
  assert.ok(mine, 'clients see it');
  assert.equal(Number(mine.apy), 0.04);
  assert.equal(mine.lock_days, 30);

  await get(`/admin/staking-products/${code}`, { token: A, method: 'PATCH', body: { apy: 0.06 } });
  assert.equal(Number((await get('/staking-products', { token: T })).find((x) => x.code === code).apy), 0.06);

  // Retiring stops it being offered without touching anything already staked on it.
  await get(`/admin/staking-products/${code}`, { token: A, method: 'PATCH', body: { active: false } });
  assert.ok(!(await get('/staking-products', { token: T })).some((x) => x.code === code),
    'a retired product is not offered');
  assert.ok((await get('/admin/staking-products', { token: A })).some((x) => x.code === code),
    'but the desk still sees it');

  assert.equal(await status(`/admin/staking-products/no_such_code`, { token: A, method: 'PATCH', body: {
    apy: 0.01 } }), 404);
});

await step('the catalogue is the desk\'s, and its asset is fixed once anything is staked', async () => {
  // Reading the catalogue is ordinary CRM work; changing it is not.
  const seller = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Catalogue Sales', email: unique('cat-sales'), role: 'sales', password: 'a-long-enough-password' } });
  const sellerToken = (await login(seller.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status('/admin/staking-products', { token: sellerToken }), 200, 'staff may read it');
  assert.equal(await status('/admin/staking-products', { token: sellerToken, method: 'POST', body: {
    code: 'sneaky', name: 'x', asset: 'ETH', description: 'y', apy: 0.04 } }), 403);
  assert.equal(await status('/admin/staking-products', { token: T }), 403, 'clients see products, not the desk view');

  // A stake keeps the asset it opened in, so a product carrying open stakes cannot change
  // its own — the two would end up disagreeing about what the same row is denominated in.
  const live = flexibleProduct;
  await get('/stakes', { token: T, method: 'POST', body: {
    product_code: live.code, amount: Math.max(0.5, Number(live.min_amount) * 2) } });
  // Any asset other than its own: naming a fixed one here passes for the wrong reason
  // the day the catalogue happens to be denominated in it.
  const other = live.asset === 'BTC' ? 'ETH' : 'BTC';
  assert.equal(await status(`/admin/staking-products/${live.code}`, { token: A, method: 'PATCH', body: {
    asset: other } }), 409);

  // The firm-wide view lists it with the client attached.
  const all = await get('/admin/stakes', { token: A });
  assert.ok(all.some((s) => s.client_id === client.id && s.client_name), 'stakes carry their client');
  assert.equal(await status('/admin/stakes', { token: T }), 403);
});

console.log('\nSupport tickets');
let ticket;

await step('a client raises a ticket; staff cannot raise one for them', async () => {
  ticket = await get('/tickets', { token: T, method: 'POST', body: {
    subject: 'Withdrawal has not arrived', category: 'funding',
    body: 'Requested three days ago and still pending.' } });
  assert.equal(ticket.status, 'open', 'a new ticket is waiting on us');
  assert.equal(ticket.priority, 'normal');
  assert.equal(await status('/tickets', { token: T, method: 'POST', body: { subject: 'x', body: 'y', category: 'nonsense' } }), 400);
  assert.equal(await status('/tickets', { token: T, method: 'POST', body: { subject: 'x', body: '' } }), 400);
  assert.equal(await status('/tickets', { token: A, method: 'POST', body: { subject: 'x', body: 'y' } }), 403);
});

await step('replying passes the ticket back and forth', async () => {
  await get(`/tickets/${ticket.id}/messages`, { token: A, method: 'POST', body: { body: 'Looking into it now.' } });
  assert.equal((await get(`/tickets/${ticket.id}`, { token: A })).status, 'pending', 'our reply waits on the client');
  await get(`/tickets/${ticket.id}/messages`, { token: T, method: 'POST', body: { body: 'Any update?' } });
  assert.equal((await get(`/tickets/${ticket.id}`, { token: A })).status, 'open', 'their reply comes back to us');
});

await step('an internal note is never visible to the client', async () => {
  const secret = 'INTERNAL: on the AML watchlist, do not expedite.';
  await get(`/tickets/${ticket.id}/messages`, { token: A, method: 'POST', body: { body: secret, internal: true } });

  const asStaff = await get(`/tickets/${ticket.id}`, { token: A });
  const asClient = await get(`/tickets/${ticket.id}`, { token: T });
  assert.ok(asStaff.messages.some((m) => m.body === secret), 'staff must see their own note');
  assert.ok(!asClient.messages.some((m) => m.body.includes('INTERNAL') || m.body.includes('watchlist')),
    'an internal note leaked to the client');
  assert.equal(asClient.messages.filter((m) => m.internal).length, 0);
  assert.equal(asClient.messages.length, asStaff.messages.length - 1);

  // The count in the list view is filtered too, or it would disclose that a note exists.
  const listedForClient = (await get('/tickets', { token: T })).find((t) => t.id === ticket.id);
  const listedForStaff = (await get('/tickets', { token: A })).find((t) => t.id === ticket.id);
  assert.equal(Number(listedForClient.messages), Number(listedForStaff.messages) - 1);

  // And a note does not change whose turn it is.
  assert.equal((await get(`/tickets/${ticket.id}`, { token: A })).status, 'open');
});

await step('a client cannot smuggle in an internal note', async () => {
  await get(`/tickets/${ticket.id}/messages`, { token: T, method: 'POST', body: { body: 'sneaky', internal: true } });
  const stored = (await get(`/tickets/${ticket.id}`, { token: A })).messages.find((m) => m.body === 'sneaky');
  assert.equal(stored.internal, false, 'internal is a staff-only flag');
  assert.equal(stored.author_kind, 'client');
});

await step('resolving notifies, and a client reply reopens it', async () => {
  await get(`/tickets/${ticket.id}`, { token: A, method: 'PATCH', body: { status: 'resolved', priority: 'high' } });
  const resolved = await get(`/tickets/${ticket.id}`, { token: A });
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at, 'resolved_at should be stamped');
  assert.ok((await get('/notifications', { token: T })).some((n) => n.kind === 'ticket' && /resolved/i.test(n.title)));

  await get(`/tickets/${ticket.id}/messages`, { token: T, method: 'POST', body: { body: 'Still not arrived.' } });
  const reopened = await get(`/tickets/${ticket.id}`, { token: A });
  assert.equal(reopened.status, 'open', 'a reply to a resolved ticket reopens it');
  assert.equal(reopened.resolved_at, null, 'and clears the resolution');
});

await step('a ticket belongs to one client', async () => {
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Ticket', email: unique('tk'), password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal(await status(`/tickets/${ticket.id}`, { token: N }), 404);
  assert.equal(await status(`/tickets/${ticket.id}/messages`, { token: N, method: 'POST', body: { body: 'hi' } }), 404);
  assert.equal((await get('/tickets', { token: N })).length, 0);
  assert.equal(await status(`/tickets/${ticket.id}`, { token: T, method: 'PATCH', body: { status: 'closed' } }), 403,
    'only staff triage a ticket');
});

await step('staff see the queue with the client attached', async () => {
  const queue = await get('/tickets?status=live', { token: A });
  const mine = queue.find((t) => t.id === ticket.id);
  assert.ok(mine, 'an open ticket should be in the live queue');
  assert.equal(mine.client_name, 'Acceptance Ada');
  assert.equal(mine.priority, 'high');
  const kinds = (await get(`/clients/${client.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('ticket'), 'ticket activity missing from the timeline');
});

console.log('\nPasswords');
await step('you can change your own, but only by proving the current one', async () => {
  // A fresh client, so the rest of the suite keeps the credentials it started with.
  const email = unique('pw');
  const subject = await get('/clients', { token: A, method: 'POST', body: {
    name: 'Password Pat', email, password: 'devpassword' } });
  const token = (await login(email, 'devpassword', 'client')).token;

  assert.equal(await status('/me/password', { token, method: 'POST', body: {
    current_password: 'not-the-password', new_password: 'a-brand-new-one' } }), 403,
    'the current password must actually be checked');
  assert.equal(await status('/me/password', { token, method: 'POST', body: {
    current_password: 'devpassword', new_password: 'short' } }), 400, 'too short must be refused');
  assert.equal(await status('/me/password', { token, method: 'POST', body: {
    current_password: 'devpassword', new_password: 'devpassword' } }), 400,
    'setting the same password again is not a change');

  assert.equal(await status('/me/password', { token, method: 'POST', body: {
    current_password: 'devpassword', new_password: 'a-brand-new-one' } }), 200);
  assert.ok((await login(email, 'a-brand-new-one', 'client')).token, 'the new password should work');
  assert.equal((await login(email, 'devpassword', 'client')).error ? 1 : 0, 1, 'the old one must not');

  // The client's own change lands on their timeline, so an account takeover is visible.
  const kinds = (await get(`/clients/${subject.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('security'), 'a password change belongs on the timeline');
  return subject;
});

await step('only an admin may set somebody else\'s, and the client is told', async () => {
  const email = unique('pwreset');
  const subject = await get('/clients', { token: A, method: 'POST', body: {
    name: 'Reset Rita', email, password: 'devpassword' } });

  // Ordinary CRM write access is not enough: this hands over the account. Real accounts,
  // not forged role claims — authenticate() reads the role from the row, so a forged
  // claim on an admin's id would still be an admin and the check would pass for nothing.
  for (const role of ['sales', 'support', 'compliance']) {
    const colleague = await get('/staff', { token: A, method: 'POST', body: {
      name: `Reset ${role}`, email: unique(`reset-${role}`), role,
      password: 'a-long-enough-password' } });
    const token = (await login(colleague.email, 'a-long-enough-password', 'staff')).token;
    assert.equal(await status(`/clients/${subject.id}/password`, { token, method: 'POST', body: {
      new_password: 'taken-over-by-staff' } }), 403, `${role} must not reset a client password`);
  }
  assert.equal(await status(`/clients/${subject.id}/password`, { method: 'POST', body: {
    new_password: 'no-token-at-all' } }), 401);
  assert.equal(await status('/clients/00000000-0000-0000-0000-000000000000/password', {
    token: A, method: 'POST', body: { new_password: 'nobody-home' } }), 404);

  assert.equal(await status(`/clients/${subject.id}/password`, { token: A, method: 'POST', body: {
    new_password: 'set-by-the-admin' } }), 200);
  const theirs = (await login(email, 'set-by-the-admin', 'client')).token;
  assert.ok(theirs, 'the password the admin set should work');

  // Being told is the point: a silent credential change is how a takeover goes unnoticed.
  const inbox = await get('/notifications', { token: theirs });
  assert.ok(inbox.some((n) => n.kind === 'security'), 'the client must be notified');
  const kinds = (await get(`/clients/${subject.id}/timeline`, { token: A })).map((a) => a.kind);
  assert.ok(kinds.includes('security'), 'the reset belongs on the timeline');
});

await step('a staff password is admin-only, and never your own by this route', async () => {
  const email = unique('colleague');
  const colleague = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Reset Colleague', email, role: 'support', password: 'a-long-enough-one' } });
  const me = (await get('/staff', { token: A })).find((s) => s.role === 'admin');

  const sales = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Reset Sales', email: unique('reset-staff-sales'), role: 'sales',
    password: 'a-long-enough-password' } });
  const salesToken = (await login(sales.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status(`/staff/${colleague.id}/password`, { token: salesToken, method: 'POST',
    body: { new_password: 'promoted-myself' } }), 403, 'sales must not reset a colleague');
  // Resetting your own without the current one would turn a stolen session into a takeover.
  assert.equal(await status(`/staff/${me.id}/password`, { token: A, method: 'POST', body: {
    new_password: 'skipping-the-current-one' } }), 409);

  assert.equal(await status(`/staff/${colleague.id}/password`, { token: A, method: 'POST', body: {
    new_password: 'set-by-the-admin' } }), 200);
  assert.ok((await login(email, 'set-by-the-admin', 'staff')).token, 'the new staff password should work');
});

await step('the password hash never reaches the audit log', async () => {
  const rows = await get('/audit?limit=200', { token: A });
  for (const r of rows) {
    for (const side of [r.before, r.after]) {
      assert.ok(!side || !('password_hash' in side), 'a password hash leaked into the audit log');
    }
  }
});

console.log('\nAdmin CRM');
await step('one call returns everything about a client to staff', async () => {
  const h = await get(`/clients/${client.id}/holdings`, { token: A });
  for (const key of ['accounts', 'wallets', 'portfolios', 'positions', 'orders', 'trades', 'cash', 'totals']) {
    assert.ok(key in h, `holdings is missing ${key}`);
  }
  assert.ok(h.accounts.some((a) => a.currency === 'GBP'), 'the credits earlier should show here');
  assert.ok(h.trades.length > 0, 'the fills earlier should show here');
  assert.equal(typeof h.totals.equity_usd, 'number');
  // Equity is holdings plus open P&L, and must agree rather than being computed twice.
  assert.ok(Math.abs(h.totals.equity_usd - (h.totals.holdings_usd + h.totals.open_pnl)) < 1e-6);
});

await step('every staff role may read it; none may trade or credit through it', async () => {
  for (const role of ['sales', 'support', 'compliance']) {
    const colleague = await get('/staff', { token: A, method: 'POST', body: {
      name: `Test ${role}`, email: unique(role), role, password: 'a-long-enough-password' } });
    assert.equal(colleague.role, role);
    const token = (await login(colleague.email, 'a-long-enough-password', 'staff')).token;
    assert.equal(await status(`/clients/${client.id}/holdings`, { token }), 200, `${role} should read holdings`);
    assert.equal(await status('/orders', { token, method: 'POST', body: { symbol: 'EURUSD', side: 'buy', type: 'market', qty: 1 } }), 403,
      `${role} must not place orders`);
    assert.equal(await status(`/clients/${client.id}/credit`, { token, method: 'POST', body: { currency: 'GBP', amount: 1 } }), 403,
      `${role} must not credit funds`);
    if (role === 'sales') {
      assert.equal(await status(`/clients/${client.id}`, { token, method: 'PATCH', body: { kyc_status: 'approved' } }), 403,
        'sales writes to the CRM but must not wave KYC through');
    }
  }
  assert.equal(await status(`/clients/${client.id}/holdings`, { token: T }), 403, 'this is the staff view, not the client one');
  assert.equal(await status(`/clients/${client.id}/holdings`), 401);
  assert.equal(await status('/clients/00000000-0000-0000-0000-000000000000/holdings', { token: A }), 404);
});

await step('deactivating a staff member ends their session immediately', async () => {
  const leaver = await get('/staff', { token: A, method: 'POST', body: {
    name: 'On their way out', email: unique('leaver'), role: 'support', password: 'a-long-enough-password' } });
  const token = (await login(leaver.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status('/clients', { token }), 200, 'they should work while employed');

  await get(`/staff/${leaver.id}`, { token: A, method: 'PATCH', body: { active: false } });
  assert.equal(await status('/clients', { token }), 401,
    'the same token must stop working the moment they are switched off, not when it expires');
  assert.equal(await status(`/clients/${client.id}/holdings`, { token }), 401);
  assert.equal((await login(leaver.email, 'a-long-enough-password', 'staff')).token, undefined,
    'and they cannot log back in');
});

await step('a role change applies at once, without a new token', async () => {
  const mover = await get('/staff', { token: A, method: 'POST', body: {
    name: 'Promoted', email: unique('mover'), role: 'support', password: 'a-long-enough-password' } });
  const token = (await login(mover.email, 'a-long-enough-password', 'staff')).token;
  assert.equal(await status('/audit', { token }), 403, 'support cannot read the audit log');
  await get(`/staff/${mover.id}`, { token: A, method: 'PATCH', body: { role: 'compliance' } });
  assert.equal(await status('/audit', { token }), 200, 'the same token now carries the new role');
});

await step('an admin cannot lock themselves out', async () => {
  const me = await get('/me', { token: A });
  assert.equal(await status(`/staff/${me.sub}`, { token: A, method: 'PATCH', body: { active: false } }), 409);
  assert.equal(await status(`/staff/${me.sub}`, { token: A, method: 'PATCH', body: { role: 'sales' } }), 409);
});

await step('a token for a staff member who is gone stops working at once', async () => {
  // staff.active used to be checked only at login, so deactivating someone left them with
  // full CRM and audit access until their token expired.
  const ghost = await forge({ kind: 'staff', role: 'admin' }, '00000000-0000-0000-0000-000000000000');
  for (const path of ['/clients', '/audit', '/admin/overview', '/kyc/pending']) {
    assert.equal(await status(path, { token: ghost }), 401, `${path} accepted a token with no staff row`);
  }
});

await step('the record is editable, and email stays unique', async () => {
  const updated = await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: {
    phone: '+353 1 234 5678', country: 'IE', tier: 'premium' } });
  assert.equal(updated.phone, '+353 1 234 5678');
  assert.equal(updated.country, 'IE');
  assert.equal(updated.tier, 'premium');

  const other = await get('/clients', { token: A, method: 'POST', body: { name: 'Taken', email: unique('taken'), password: 'devpassword' } });
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { email: other.email } }), 409);
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { email: 'not-an-email' } }), 400);
});

await step('a nullable field set by mistake can be set back to nothing', async () => {
  // Both of these are nullable in the schema, and the UI offers a blank option for each,
  // so refusing null would leave a wrong value on the record for good.
  const me = (await get('/staff', { token: A }))[0];
  for (const [field, value] of [['risk_profile', 'high'], ['owner_staff_id', me.id]]) {
    const set = await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { [field]: value } });
    assert.equal(set[field], value, `${field} did not take`);
    const cleared = await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { [field]: null } });
    assert.equal(cleared[field], null, `${field} could be set but not cleared`);
  }
  // Null is not a way past the allowed values.
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { risk_profile: 'catastrophic' } }), 400);
});

await step('a KYC override needs kyc:review and is recorded as an override', async () => {
  await get(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { kyc_status: 'expired' } });
  assert.equal((await get(`/clients/${client.id}`, { token: A })).kyc_status, 'expired');
  const entry = (await get(`/clients/${client.id}/timeline`, { token: A }))
    .find((a) => a.kind === 'kyc' && a.data?.override === true);
  assert.ok(entry, 'an override must be distinguishable on the timeline from a reviewed decision');
});














console.log('\nPhase 7 — admin dashboard');
await step('the overview agrees with the underlying endpoints', async () => {
  const o = await get('/admin/overview', { token: A });
  const clients = await get('/clients?limit=200', { token: A });
  const total = Number(o.clients.total);

  // The tile counts every client; the listing returns at most a page of them. Comparing
  // the two directly passed only while the database held fewer than 200 — the check was
  // guaranteed to start failing on the day the desk got busy, which is the worst possible
  // day for a test to cry wolf.
  assert.equal(clients.length, Math.min(total, 200), 'the listing is a page of the total');
  assert.ok(total >= clients.length);
  // Same shape again: the flags listing is capped at 200, so it is a page of the tile's
  // count rather than equal to it.
  const openFlags = await get('/flags?status=open', { token: A });
  assert.equal(openFlags.length, Math.min(Number(o.flags.open), 200), 'the flag listing is a page of the total');
  assert.equal(Number(o.kyc.pending_docs), (await get('/kyc/pending', { token: A })).length);
  // The pipeline is grouped over every client, not over a page, so it must sum to the total.
  assert.equal(o.pipeline.reduce((n, p) => n + Number(p.clients), 0), total,
    'pipeline must account for every client');
  assert.ok(Number(o.trading.volume_today) > 0);
  // Derived rather than hardcoded: the count is firm-wide, so compare how far this run
  // moved it against the withdrawals this run's client actually has outstanding.
  const minePending = (await get('/cash', { token: T }))
    .filter((c) => c.kind === 'withdrawal' && c.status === 'pending').length;
  assert.equal(Number(o.cash.pending_withdrawals) - pendingBefore, minePending,
    'the dashboard should account for exactly the withdrawals this run left pending');
});
await step('the 14-day series lines up with the figures beside it', async () => {
  const o = await get('/admin/overview', { token: A });
  assert.equal(o.series.length, 14, 'fourteen days, empty ones included');
  const today = o.series[o.series.length - 1];
  // The tile and the last bar are the same number counted two ways; if they ever disagree
  // one of them is lying, and the graph is the one nobody would check.
  assert.equal(Number(today.volume).toFixed(6), Number(o.trading.volume_today).toFixed(6));
  assert.equal(Number(today.fills), Number(o.trading.fills_today));
  assert.equal(Number(o.series[0].day) || o.series[0].day.length, 10, 'days are plain YYYY-MM-DD');
  assert.ok(o.series.every((d) => Number.isFinite(Number(d.net_flow))));
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
  const forged = await forge({ kind: 'client', role: 'trader' }, '00000000-0000-0000-0000-000000000000');
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
