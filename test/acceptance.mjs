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
await step('a quote prices the pair without moving anything', async () => {
  const q = await get('/convert/quote?from=GBP&to=USD&amount=1000', { token: T });
  assert.ok(q.received > 1000, 'sterling buys more than its face in dollars');
  assert.ok(q.rate > 1);
  assert.equal(await status('/convert/quote?from=GBP&to=GBP&amount=10', { token: T }), 400, 'same currency');
  assert.equal(await status('/convert/quote?from=GBP&to=ZZZ&amount=10', { token: T }), 404);
  assert.equal(await status('/convert/quote?from=SOL&to=USD&amount=1', { token: T }), 422, 'no price source');
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
  assert.equal(await status('/convert', { token: T, method: 'POST', body: { from: 'SOL', to: 'USD', amount: 1 } }), 422, 'unpriced');
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
    target_amount: 250000, target_date: '2055-01-01' } });
  savings = await get('/portfolios', { token: T, method: 'POST', body: {
    type_code: 'savings', name: 'Rainy day', currency: 'GBP', target_amount: 5000 } });
  assert.ok(retirement.id && savings.id);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'savings', name: 'Rainy day', currency: 'GBP' } }), 409);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'yacht', name: 'Yacht', currency: 'GBP' } }), 404);
  assert.equal(await status('/portfolios', { token: T, method: 'POST', body: { type_code: 'savings', name: 'Odd', currency: 'ZZZ' } }), 404);
  assert.equal(await status('/portfolios', { token: A, method: 'POST', body: { type_code: 'savings', name: 'x', currency: 'GBP' } }), 403);
});

await step('contributing moves money out of the balance, and back again', async () => {
  const before = await gbp();
  await get(`/portfolios/${retirement.id}/contribute`, { token: T, method: 'POST', body: { amount: 3000 } });
  const afterIn = await gbp();
  assert.ok(Math.abs((before - afterIn) - 3000) < 1e-9, 'the balance should fall by exactly the contribution');

  const pots = await get('/portfolios', { token: T });
  const pot = pots.find((p) => p.id === retirement.id);
  assert.equal(Number(pot.balance), 3000);

  await get(`/portfolios/${retirement.id}/withdraw`, { token: T, method: 'POST', body: { amount: 1000 } });
  assert.ok(Math.abs((await gbp() - afterIn) - 1000) < 1e-9, 'taking money out must return it to the balance');
  assert.equal(Number((await get('/portfolios', { token: T })).find((p) => p.id === retirement.id).balance), 2000);
});

await step('progress and projection reflect the target', async () => {
  const pot = (await get('/portfolios', { token: T })).find((p) => p.id === retirement.id);
  assert.ok(Math.abs(pot.progress - 2000 / 250000) < 1e-9);
  assert.ok(pot.projected > Number(pot.balance), 'a dated pot with a rate should project growth');
  const rainy = (await get('/portfolios', { token: T })).find((p) => p.id === savings.id);
  assert.equal(rainy.projected, null, 'no target date means no projection');
});

await step('a portfolio refuses what it cannot do', async () => {
  assert.equal(await status(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: 1e9 } }), 400, 'over balance');
  assert.equal(await status(`/portfolios/${savings.id}/withdraw`, { token: T, method: 'POST', body: { amount: 1e9 } }), 400, 'over the pot');
  assert.equal(await status(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: -50 } }), 400);
  assert.equal(await status(`/portfolios/${retirement.id}`, { token: T, method: 'PATCH', body: { status: 'closed' } }), 409, 'closing a funded pot would strand the money');
});

await step('one client cannot pay into another client portfolio', async () => {
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Pot', email: `pot+${Date.now()}@example.com`, password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal(await status(`/portfolios/${retirement.id}/contribute`, { token: N, method: 'POST', body: { amount: 1 } }), 404);
  assert.equal(await status(`/portfolios/${retirement.id}/withdraw`, { token: N, method: 'POST', body: { amount: 1 } }), 404);
});

await step('an emptied portfolio can be closed, and then takes nothing more', async () => {
  const pot = (await get('/portfolios', { token: T })).find((p) => p.id === savings.id);
  if (Number(pot.balance) > 0) {
    await get(`/portfolios/${savings.id}/withdraw`, { token: T, method: 'POST', body: { amount: Number(pot.balance) } });
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

await step('an inbox belongs to one client, and staff have none', async () => {
  const mine = (await get('/notifications', { token: T }))[0];
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Inbox', email: `inbox+${Date.now()}@example.com`, password: 'devpassword' } });
  const N = (await login(nosy.email, 'devpassword', 'client')).token;
  assert.equal((await get('/notifications', { token: N })).length, 0);
  assert.equal(await status(`/notifications/${mine.id}/read`, { token: N, method: 'POST' }), 404);
  assert.equal(await status('/notifications', { token: A }), 403, 'staff read the CRM timeline, not an inbox');
  assert.equal(await status(`/clients/${client.id}/notify`, { token: T, method: 'POST', body: { title: 'hi' } }), 403);
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
  const nosy = await get('/clients', { token: A, method: 'POST', body: { name: 'Nosy Ticket', email: `tk+${Date.now()}@example.com`, password: 'devpassword' } });
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
      name: `Test ${role}`, email: `${role}+${Date.now()}@example.com`, role, password: 'a-long-enough-password' } });
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
    name: 'On their way out', email: `leaver+${Date.now()}@example.com`, role: 'support', password: 'a-long-enough-password' } });
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
    name: 'Promoted', email: `mover+${Date.now()}@example.com`, role: 'support', password: 'a-long-enough-password' } });
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

  const other = await get('/clients', { token: A, method: 'POST', body: { name: 'Taken', email: `taken+${Date.now()}@example.com`, password: 'devpassword' } });
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { email: other.email } }), 409);
  assert.equal(await status(`/clients/${client.id}`, { token: A, method: 'PATCH', body: { email: 'not-an-email' } }), 400);
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
  assert.equal(Number(o.clients.total), clients.length);
  assert.equal(Number(o.flags.open), (await get('/flags?status=open', { token: A })).length);
  assert.equal(Number(o.kyc.pending_docs), (await get('/kyc/pending', { token: A })).length);
  assert.equal(o.pipeline.reduce((n, p) => n + Number(p.clients), 0), clients.length, 'pipeline must account for every client');
  assert.ok(Number(o.trading.volume_today) > 0);
  // Derived rather than hardcoded: the count is firm-wide, so compare how far this run
  // moved it against the withdrawals this run's client actually has outstanding.
  const minePending = (await get('/cash', { token: T }))
    .filter((c) => c.kind === 'withdrawal' && c.status === 'pending').length;
  assert.equal(Number(o.cash.pending_withdrawals) - pendingBefore, minePending,
    'the dashboard should account for exactly the withdrawals this run left pending');
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
