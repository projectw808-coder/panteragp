/**
 * Bring the whole thing up with one command: npm start
 *
 * Installs anything missing, writes a .env on first run, starts the dev database, the API
 * and the web app, waits until each is actually answering, seeds a demo client if the
 * database is empty, then prints where to go and how to sign in.
 *
 * Ctrl-C stops all three.
 */
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const vite = join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js');

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n${msg}`);

// --------------------------------------------------------------- environment

/**
 * A generated secret is written to .env on first run and reused after that, so tokens
 * survive a restart and `npm run test:e2e` signs with the same key the API verifies with.
 */
function loadEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) {
    writeFileSync(path, [
      '# Written by npm start on first run. Development only.',
      'DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres',
      `JWT_SECRET=${randomBytes(32).toString('base64url')}`,
      '# src/devdb.ts serves one connection at a time.',
      'PG_POOL_MAX=1',
      '# Uncomment to keep the demo data between restarts:',
      '# DEV_DB_DIR=./.pgdata',
      '',
    ].join('\n'));
    log('wrote .env with a freshly generated JWT_SECRET');
  }
  const env = { ...process.env };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// ------------------------------------------------------------------ waiting

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port) => new Promise((resolve) => {
  const socket = createConnection({ port, host: '127.0.0.1' })
    .on('connect', () => { socket.end(); resolve(true); })
    .on('error', () => resolve(false));
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});

/** Poll until `check` passes, so we never race ahead of a service that is still booting. */
async function waitFor(what, check, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await check()) return true;
    await sleep(500);
  }
  throw new Error(`${what} did not come up within ${seconds}s`);
}

const httpOk = (url) => fetch(url).then(() => true).catch(() => false);

// ----------------------------------------------------------------- children

const children = [];
function start(name, command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, ...options });
  child.on('error', (err) => console.error(`  ${name} failed to start: ${err.message}`));
  // Keep the noise down: only surface a child's output if it dies unexpectedly.
  const tail = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (d) => {
      tail.push(String(d));
      if (tail.length > 40) tail.shift();
    });
  }
  child.on('exit', (code) => {
    if (code !== 0 && !stopping) {
      console.error(`\n  ${name} exited with code ${code}. Last output:\n${tail.join('')}`);
    }
  });
  children.push({ name, child });
  return child;
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  for (const { child } of children) {
    // On Windows a shell-spawned child needs the whole tree killed, not just the shell.
    if (isWindows && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

// -------------------------------------------------------------------- seed

/** A client with money, trades, a portfolio and a ticket, so the screens are not empty. */
async function seedDemo(env) {
  const B = 'http://localhost:3000';
  const json = (r) => r.text().then((t) => { try { return JSON.parse(t); } catch { return t; } });
  const call = (p, { token, method = 'GET', body } = {}) => fetch(B + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(json);

  const admin = await call('/auth/login', { method: 'POST', body: { email: 'admin@local.test', password: 'devpassword', as: 'staff' } });
  if (!admin.token) throw new Error('could not sign in as the seeded admin');
  const A = admin.token;

  if ((await call('/clients', { token: A })).length > 0) {
    log('database already has clients — leaving it alone');
    return null;
  }

  const email = 'demo.client@local.test';
  const client = await call('/clients', { token: A, method: 'POST', body: {
    name: 'Demo Client', email, phone: '+44 20 7946 0100', country: 'GB', password: 'devpassword' } });
  const T = (await call('/auth/login', { method: 'POST', body: { email, password: 'devpassword', as: 'client' } })).token;

  for (const [currency, amount] of [['GBP', 25000], ['EUR', 8000], ['JPY', 500000]]) {
    await call(`/clients/${client.id}/credit`, { token: A, method: 'POST', body: { currency, amount, note: 'welcome credit' } });
  }
  await call(`/clients/${client.id}/wallet-credit`, { token: A, method: 'POST', body: { asset: 'BTC', amount: 0.4 } });
  await call(`/clients/${client.id}/wallet-credit`, { token: A, method: 'POST', body: { asset: 'ETH', amount: 6 } });

  await call('/orders', { token: T, method: 'POST', body: { symbol: 'EURUSD', side: 'buy', type: 'market', qty: 20000 } });
  await call('/orders', { token: T, method: 'POST', body: { symbol: 'XAUUSD', side: 'sell', type: 'market', qty: 10 } });
  const quotes = await call('/quotes', { token: T });
  const btc = quotes.find((q) => q.symbol === 'BTCUSD').price;
  await call('/orders', { token: T, method: 'POST', body: {
    symbol: 'BTCUSD', side: 'buy', type: 'limit', qty: 0.5, limit_price: Math.round(btc * 0.9) } });

  const pot = await call('/portfolios', { token: T, method: 'POST', body: {
    type_code: 'retirement', name: 'Retirement 2055', currency: 'GBP',
    target_amount: 250000, target_date: '2055-01-01' } });
  await call(`/portfolios/${pot.id}/contribute`, { token: T, method: 'POST', body: { amount: 9000 } });
  const savings = await call('/portfolios', { token: T, method: 'POST', body: {
    type_code: 'savings', name: 'Rainy day', currency: 'GBP', target_amount: 5000 } });
  await call(`/portfolios/${savings.id}/contribute`, { token: T, method: 'POST', body: { amount: 3250 } });

  await call('/cash', { token: T, method: 'POST', body: { kind: 'withdrawal', amount: 12000 } });
  await call('/tickets', { token: T, method: 'POST', body: {
    subject: 'Withdrawal has not arrived', category: 'funding',
    body: 'I requested a withdrawal a few days ago and it is still pending.' } });
  await call(`/clients/${client.id}/notify`, { token: A, method: 'POST', body: {
    title: 'Welcome aboard', body: 'Your account manager is Admin.' } });

  return { email, client };
}

// -------------------------------------------------------------------- main

console.log('Trading platform — starting everything\n');
const env = loadEnv();

step('Dependencies');
for (const [label, cwd] of [['api', root], ['web', join(root, 'web')]]) {
  if (existsSync(join(cwd, 'node_modules'))) { log(`${label}: already installed`); continue; }
  log(`${label}: installing…`);
  await new Promise((resolve, reject) => {
    spawn(npm, ['install', '--no-audit', '--no-fund'], { cwd, shell: isWindows, stdio: 'inherit' })
      .on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install failed in ${label}`))));
  });
}

step('Services');
if (await portOpen(5432)) {
  log('database: something is already listening on 5432, reusing it');
} else {
  start('database', 'node', ['--experimental-strip-types', 'src/devdb.ts'], { env });
  await waitFor('the database', () => portOpen(5432));
  log('database: up on 5432');
}

if (await portOpen(3000)) {
  log('api: something is already listening on 3000, reusing it');
} else {
  // Deliberately not --watch: the dev database does not survive its client being killed
  // repeatedly (pglite-socket leaves a zombie handler on the shared query queue, and after
  // a few every connection breaks), so a watched API wedges the database within minutes.
  // Restart npm start to pick up an API change, or run against a real Postgres to watch.
  start('api', 'node', ['--experimental-strip-types', 'src/server.ts'], { env });
  await waitFor('the API', () => httpOk('http://localhost:3000/clients'));
  log('api: up on 3000');
}

if (await portOpen(5173)) {
  log('web: something is already listening on 5173, reusing it');
} else {
  start('web', process.execPath, [vite], { cwd: join(root, 'web'), env });
  await waitFor('the web app', () => httpOk('http://localhost:5173'));
  log('web: up on 5173');
}

step('Demo data');
const seeded = await seedDemo(env).catch((err) => { log(`skipped: ${err.message}`); return null; });
if (seeded) log('created a demo client with balances, trades, portfolios and a ticket');

console.log(`
──────────────────────────────────────────────────────────────
  Open  http://localhost:5173

  Staff   admin@local.test        / devpassword
  Client  demo.client@local.test  / devpassword   (pick "Trader")

  Staff see: Dashboard, Clients, Support, Reports, Charts.
  Clients see: Charts and Trade (holdings, portfolios, support).

  Run the checks in another terminal:
    npm test
    npm run test:e2e
──────────────────────────────────────────────────────────────

Ctrl-C stops everything.`);

// Hold the process open so the children keep running.
await new Promise(() => {});
