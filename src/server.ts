import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { can, hashPassword, signToken, verifyPassword, verifyToken, type Perm, type Principal } from './auth.ts';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { candles, quote, spot, TIMEFRAMES, type Timeframe } from './market.ts';
import {
  accrue, applyFill, convert, isTriggered, progress, project, round8, trailStop, unrealized,
  type OrderType, type Position, type Side,
} from './trading.ts';
import { RULES, toCSV, volumeFlags, withdrawalFlags, type Flag } from './compliance.ts';

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}

// ponytail: numeric -> float. Fine for a demo account; real money wants minor units.
pg.types.setTypeParser(1700, Number);
// bigint counts and bigserial ids: JSON should carry numbers, not quoted strings.
pg.types.setTypeParser(20, Number);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),   // src/devdb.ts serves one connection at a time
});

/** Every write runs in here: one transaction, actor stamped for the audit triggers. */
async function tx<T>(actor: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.actor', $1, true)", [actor]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** The CRM timeline. Any subsystem that touches a client calls this. */
export function logActivity(c: pg.PoolClient, a: {
  client_id: string; kind: string; actor: string; summary: string;
  ref_table?: string; ref_id?: string; data?: unknown;
}) {
  return c.query(
    `INSERT INTO activity_log (client_id, kind, actor, summary, ref_table, ref_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [a.client_id, a.kind, a.actor, a.summary, a.ref_table ?? null, a.ref_id ?? null, a.data ?? {}],
  );
}

const app = Fastify({ logger: true });

// Without this, an error on an idle client (db restart, dropped connection) is an
// unhandled 'error' event and takes the process down.
pool.on('error', (err) => app.log.error({ err }, 'idle pg client error'));

// Plenty of clients set content-type: application/json on a bodyless DELETE. Fastify
// rejects that with a 400 by default; treat an empty body as no body.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, body ? JSON.parse(body as string) : undefined);
  } catch (err) {
    done(err as Error, undefined);
  }
});

/** Populates req.principal. Sends the error response and returns false if it can't. */
async function authenticate(req: any, reply: any, perm?: Perm): Promise<boolean> {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'unauthenticated' });
    return false;
  }
  try {
    req.principal = await verifyToken(header.slice(7));
  } catch {
    reply.code(401).send({ error: 'unauthenticated' });
    return false;
  }
  if (perm && !can(req.principal.role, perm)) {
    reply.code(403).send({ error: 'forbidden' });
    return false;
  }
  return true;
}

const auth = (perm?: Perm) => async (req: any, reply: any) => { await authenticate(req, reply, perm); };

// ------------------------------------------------------------------- auth

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  as: z.enum(['staff', 'client']),
});

app.post('/auth/login', async (req, reply) => {
  const body = loginBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { email, password, as } = body.data;

  const table = as === 'staff' ? 'staff' : 'clients';
  const { rows } = await pool.query(
    `SELECT id, password_hash${as === 'staff' ? ', role, active' : ''} FROM ${table} WHERE email = $1`,
    [email.toLowerCase()],
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!ok || (as === 'staff' && !row.active)) return reply.code(401).send({ error: 'invalid credentials' });

  const principal: Principal = { sub: row.id, kind: as, role: as === 'staff' ? row.role : 'trader' };
  if (as === 'client') {
    await tx(row.id, (c) => logActivity(c, {
      client_id: row.id, kind: 'login', actor: row.id, summary: 'Client signed in',
    }));
  }
  return { token: await signToken(principal), principal };
});

app.get('/me', { preHandler: auth() }, async (req) => req.principal);

// -------------------------------------------------------------------- CRM

const clientBody = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  phone: z.string().max(40).optional(),
  country: z.string().length(2).optional(),
  tier: z.string().max(40).optional(),
  owner_staff_id: z.string().uuid().optional(),
  password: z.string().min(8).max(200).optional(),
});

app.post('/clients', { preHandler: auth('crm:write') }, async (req, reply) => {
  const body = clientBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  const actor = req.principal.sub;

  return tx(actor, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO clients (email, name, phone, country, tier, owner_staff_id, password_hash)
       VALUES ($1,$2,$3,$4,coalesce($5,'standard'),coalesce($6::uuid,$7::uuid),$8) RETURNING *`,
      [b.email.toLowerCase(), b.name, b.phone ?? null, b.country ?? null, b.tier ?? null,
       b.owner_staff_id ?? null, req.principal.kind === 'staff' ? actor : null,
       b.password ? await hashPassword(b.password) : null],
    );
    await logActivity(c, {
      client_id: rows[0].id, kind: 'note', actor, summary: 'Client record created',
    });
    delete rows[0].password_hash;
    return rows[0];
  });
});

app.get('/clients', { preHandler: auth('crm:read') }, async (req) => {
  const q = z.object({
    stage_id: z.coerce.number().int().optional(),
    owner_staff_id: z.string().uuid().optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  // ponytail: ILIKE '%x%' is a seq scan; add a pg_trgm index when the client list gets long.
  const { rows } = await pool.query(
    `SELECT c.id, c.email, c.name, c.tier, c.kyc_status, c.risk_profile, c.created_at,
            c.stage_id, s.name AS stage, c.owner_staff_id, o.name AS owner_name
       FROM clients c
       JOIN pipeline_stages s ON s.id = c.stage_id
       LEFT JOIN staff o ON o.id = c.owner_staff_id
      WHERE ($1::smallint IS NULL OR c.stage_id = $1)
        AND ($2::uuid IS NULL OR c.owner_staff_id = $2)
        AND ($3::text IS NULL OR c.name ILIKE '%'||$3||'%' OR c.email ILIKE '%'||$3||'%')
      ORDER BY c.created_at DESC LIMIT $4`,
    [q.stage_id ?? null, q.owner_staff_id ?? null, q.q || null, q.limit],
  );
  return rows;
});

app.get('/pipeline-stages', { preHandler: auth('crm:read') }, async () =>
  (await pool.query('SELECT * FROM pipeline_stages ORDER BY sort_order')).rows);

app.get('/staff', { preHandler: auth('crm:read') }, async () =>
  (await pool.query('SELECT id, name, email, role FROM staff WHERE active ORDER BY name')).rows);

/** Traders reach their own record; staff need crm:read. */
const clientScope = async (req: any, reply: any) => {
  if (!(await authenticate(req, reply))) return;
  const self = req.principal.kind === 'client' && req.principal.sub === req.params.id;
  if (!self && !can(req.principal.role, 'crm:read')) return reply.code(403).send({ error: 'forbidden' });
};

app.get('/clients/:id', { preHandler: clientScope }, async (req: any, reply) => {
  const { rows } = await pool.query(
    `SELECT c.*, s.name AS stage FROM clients c
       JOIN pipeline_stages s ON s.id = c.stage_id WHERE c.id = $1`, [req.params.id]);
  if (!rows[0]) return reply.code(404).send({ error: 'not found' });
  delete rows[0].password_hash;
  return rows[0];
});

app.get('/clients/:id/timeline', { preHandler: clientScope }, async (req: any) => {
  const q = z.object({
    kind: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT id, at, kind, actor, summary, ref_table, ref_id, data
       FROM activity_log WHERE client_id = $1 AND ($2::text IS NULL OR kind = $2)
      ORDER BY at DESC, id DESC LIMIT $3`,
    [req.params.id, q.kind ?? null, q.limit],
  );
  return rows;
});

const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(40).optional(),
  tier: z.string().max(40).optional(),
  stage_id: z.number().int().min(1).optional(),
  owner_staff_id: z.string().uuid().nullable().optional(),
  risk_profile: z.enum(['low', 'medium', 'high']).optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');

app.patch('/clients/:id', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = patchBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const entries = Object.entries(body.data);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');

  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE clients SET ${set} WHERE id = $1 RETURNING *`,
      [req.params.id, ...entries.map(([, v]) => v)],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    if (body.data.stage_id !== undefined) {
      await logActivity(c, {
        client_id: rows[0].id, kind: 'stage', actor: req.principal.sub,
        summary: 'Pipeline stage changed', data: { stage_id: body.data.stage_id },
      });
    }
    delete rows[0].password_hash;
    return rows[0];
  });
});

app.post('/clients/:id/notes', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({ text: z.string().min(1).max(4000) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  await tx(req.principal.sub, (c) => logActivity(c, {
    client_id: req.params.id, kind: 'note', actor: req.principal.sub, summary: body.data.text,
  }));
  return reply.code(201).send({ ok: true });
});

// ------------------------------------------------------------------- tasks

app.post('/tasks', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({
    client_id: z.string().uuid(),
    assigned_to: z.string().uuid(),
    title: z.string().min(1).max(200),
    due_at: z.coerce.date().optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO tasks (client_id, assigned_to, title, due_at, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.client_id, b.assigned_to, b.title, b.due_at ?? null, req.principal.sub]);
    await logActivity(c, {
      client_id: b.client_id, kind: 'task', actor: req.principal.sub,
      summary: `Task: ${b.title}`, ref_table: 'tasks', ref_id: String(rows[0].id),
    });
    return reply.code(201).send(rows[0]);
  });
});

app.get('/tasks', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({
    status: z.enum(['open', 'done', 'cancelled']).default('open'),
    client_id: z.string().uuid().optional(),
    assigned_to: z.string().uuid().optional(),   // omit for "mine"; 'all' for everyone's
    scope: z.literal('all').optional(),
  }).parse(req.query);
  const assignee = q.scope === 'all' ? null : (q.assigned_to ?? req.principal.sub);
  const { rows } = await pool.query(
    `SELECT t.*, c.name AS client_name, s.name AS assignee_name
       FROM tasks t
       JOIN clients c ON c.id = t.client_id
       JOIN staff s ON s.id = t.assigned_to
      WHERE t.status = $1
        AND ($2::uuid IS NULL OR t.assigned_to = $2)
        AND ($3::uuid IS NULL OR t.client_id = $3)
      ORDER BY t.due_at NULLS LAST, t.created_at`,
    [q.status, assignee, q.client_id ?? null]);
  return rows;
});

app.patch('/tasks/:id', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({ status: z.enum(['open', 'done', 'cancelled']) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      'UPDATE tasks SET status = $2 WHERE id = $1 RETURNING *', [req.params.id, body.data.status]);
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    await logActivity(c, {
      client_id: rows[0].client_id, kind: 'task', actor: req.principal.sub,
      summary: `Task ${body.data.status}: ${rows[0].title}`, ref_table: 'tasks', ref_id: String(rows[0].id),
    });
    return rows[0];
  });
});

// ------------------------------------------------------------- market data

// Market data isn't client-specific: any authenticated principal may read it.
app.get('/instruments', { preHandler: auth() }, async () =>
  (await pool.query('SELECT * FROM instruments ORDER BY symbol')).rows);

/** Symbols must exist in the instruments table — never generate data for arbitrary input. */
async function knownSymbol(symbol: string) {
  return (await pool.query('SELECT 1 FROM instruments WHERE symbol = $1', [symbol])).rowCount === 1;
}

app.get('/candles', { preHandler: auth() }, async (req, reply) => {
  const q = z.object({
    symbol: z.string().max(20),
    tf: z.enum(Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]]).default('1H'),
    limit: z.coerce.number().int().min(10).max(2000).default(500),
  }).safeParse(req.query);
  if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
  if (!await knownSymbol(q.data.symbol)) return reply.code(404).send({ error: 'unknown symbol' });
  return candles(q.data.symbol, q.data.tf, q.data.limit);
});

app.get('/quotes', { preHandler: auth() }, async () => {
  const { rows } = await pool.query<{ symbol: string }>('SELECT symbol FROM instruments ORDER BY symbol');
  return rows.map((r) => quote(r.symbol));
});

// -------------------------------------------------------------- live feed

// ponytail: one process broadcasting from one interval. Move to Redis pub/sub when
// there is more than one API instance — the message shape stays the same.
type Socket = { send: (s: string) => void };
const feed = new Map<Socket, Principal>();
let ticker: NodeJS.Timeout | null = null;

/** Order and fill events go to the client they belong to, and to staff who may read trades. */
function notify(clientId: string, msg: unknown) {
  const text = JSON.stringify(msg);
  for (const [sock, p] of feed) {
    const mine = p.kind === 'client' ? p.sub === clientId : can(p.role, 'trade:read');
    if (!mine) continue;
    try { sock.send(text); } catch { feed.delete(sock); }
  }
}

/**
 * Drives both the price broadcast and order settlement.
 *
 * Started at boot, not when the first client connects: a resting limit order has to fill
 * when the market reaches it whether or not anybody happens to be watching. Broadcasting
 * is skipped when nothing is listening; settlement never is.
 */
async function startTicker() {
  if (ticker) return;
  const { rows } = await pool.query<{ symbol: string }>('SELECT symbol FROM instruments');
  ticker = setInterval(() => {
    const at = Date.now();
    const prices = new Map(rows.map((r) => [r.symbol, spot(r.symbol, at)]));
    if (feed.size) {
      const msg = JSON.stringify({
        type: 'tick', at,
        ticks: [...prices].map(([symbol, price]) => ({ symbol, price })),
      });
      for (const [sock] of feed) {
        try { sock.send(msg); } catch { feed.delete(sock); }
      }
    }
    settle(prices).catch((err) => app.log.error({ err }, 'settlement failed'));
  }, 1000);
}

// ------------------------------------------------- paper execution engine

type OrderRow = {
  id: string; account_id: string; client_id: string; symbol: string;
  side: Side; type: OrderType; qty: number;
  limit_price: number | null; stop_price: number | null; trail_amount: number | null;
  take_profit: number | null; stop_loss: number | null; parent_order_id: string | null;
};

let settling = false;

/** Fill whatever the current prices trigger. One pass per tick, never re-entrant. */
async function settle(prices: Map<string, number>) {
  if (settling) return;              // a slow pass must not overlap the next tick
  settling = true;
  try {
    const { rows } = await pool.query<OrderRow>(
      `SELECT o.* FROM orders o
         JOIN trading_accounts a ON a.id = o.account_id
        WHERE o.status IN ('new','working') AND a.mode = 'demo'
        ORDER BY o.placed_at`);
    for (const o of rows) {
      const price = prices.get(o.symbol);
      if (price === undefined) continue;
      if (o.type === 'trailing_stop') {
        const moved = trailStop(o, price);
        if (moved !== null) {
          await pool.query('UPDATE orders SET stop_price = $2 WHERE id = $1', [o.id, moved]);
          o.stop_price = moved;
        }
      }
      if (isTriggered(o, price)) await fillOrder(o, price, true);
    }
  } finally {
    settling = false;
  }
}

/**
 * Fill an order: record the fill, move the position, realise P&L onto the balance,
 * cancel the sibling exit, attach take-profit / stop-loss, and write the CRM timeline.
 * All of it in one transaction — a fill the timeline never saw is not acceptable.
 */
async function fillOrder(o: OrderRow, price: number, viaEngine = false) {
  await tx('engine', async (c) => {
    // Re-read under a lock: the request path can fill a market order at the same moment.
    const { rows: [live] } = await c.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [o.id]);
    if (!live || (live.status !== 'new' && live.status !== 'working')) return;

    await c.query('INSERT INTO fills (order_id, qty, price) VALUES ($1,$2,$3)', [o.id, o.qty, price]);
    await c.query(`UPDATE orders SET status = 'filled' WHERE id = $1`, [o.id]);

    const { rows: [held] } = await c.query<Position>(
      'SELECT qty, avg_price FROM positions WHERE account_id = $1 AND symbol = $2 FOR UPDATE',
      [o.account_id, o.symbol]);
    const { position, realized } = applyFill(held ?? null, { side: o.side, qty: o.qty, price });

    if (position.qty === 0) {
      await c.query('DELETE FROM positions WHERE account_id = $1 AND symbol = $2', [o.account_id, o.symbol]);
    } else {
      await c.query(
        `INSERT INTO positions (account_id, symbol, qty, avg_price) VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, symbol) DO UPDATE SET qty = $3, avg_price = $4, updated_at = now()`,
        [o.account_id, o.symbol, position.qty, position.avg_price]);
    }
    if (realized !== 0) {
      await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1', [o.account_id, realized]);
    }

    // One-cancels-the-other: whichever exit fills, the other leg is done.
    await c.query(
      `UPDATE orders SET status = 'cancelled'
        WHERE parent_order_id = $1 AND id <> $2 AND status IN ('new','working')`,
      [o.parent_order_id ?? o.id, o.id]);

    // An entry with take-profit / stop-loss attached becomes two resting exit orders.
    if (!o.parent_order_id) {
      const exit = o.side === 'buy' ? 'sell' : 'buy';
      const child = (type: 'limit' | 'stop', limit: number | null, stop: number | null) => c.query(
        `INSERT INTO orders (account_id, client_id, symbol, side, type, qty, limit_price, stop_price,
                             status, parent_order_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'working',$9)`,
        [o.account_id, o.client_id, o.symbol, exit, type, o.qty, limit, stop, o.id]);
      if (o.take_profit !== null) await child('limit', o.take_profit, null);
      if (o.stop_loss !== null) await child('stop', null, o.stop_loss);
    }

    await logActivity(c, {
      client_id: o.client_id, kind: 'order.filled', actor: 'engine',
      summary: `Filled ${o.side} ${o.qty} ${o.symbol} at ${price}`,
      ref_table: 'orders', ref_id: o.id,
      data: { price, qty: o.qty, side: o.side, symbol: o.symbol, realized, type: o.type },
    });
    if (viaEngine) {
      await notifyClientOf(c, {
        client_id: o.client_id, kind: 'order.filled',
        title: `${o.side === 'buy' ? 'Bought' : 'Sold'} ${o.qty} ${o.symbol}`,
        body: `Your ${o.type.replace('_', ' ')} order filled at ${price}.`,
        ref_table: 'orders', ref_id: o.id,
      });
    }
  });

  notify(o.client_id, { type: 'fill', order_id: o.id, symbol: o.symbol, side: o.side, qty: o.qty, price });
  flushNotifications();
  await checkVolume(o.client_id).catch((err: unknown) => app.log.error({ err }, 'volume check failed'));
}

/**
 * Compare today's traded value against this client's own recent average. Raised at most
 * once a day per client — a spike shouldn't produce a flag per fill.
 */
async function checkVolume(clientId: string) {
  const { rows: [v] } = await pool.query<{ today: number; avg_daily: number; already: number }>(
    `SELECT
       coalesce(sum(fl.qty * fl.price) FILTER (WHERE fl.filled_at >= current_date), 0) AS today,
       coalesce(sum(fl.qty * fl.price) FILTER (WHERE fl.filled_at <  current_date
                 AND fl.filled_at >= current_date - interval '30 days'), 0) / 30        AS avg_daily,
       (SELECT count(*) FROM flags
         WHERE client_id = $1 AND rule = 'volume_spike' AND raised_at >= current_date)  AS already
       FROM fills fl JOIN orders o ON o.id = fl.order_id
      WHERE o.client_id = $1`, [clientId]);
  if (!v || Number(v.already) > 0) return;

  const flags = volumeFlags({ today: Number(v.today), avgDaily: Number(v.avg_daily) });
  if (flags.length) await tx('system', (c) => raiseFlags(c, clientId, flags));
}

// ---------------------------------------------------------------- trading

const DEMO_STARTING_BALANCE = 100_000;

/** The caller's demo account, created on first use. Live accounts are never served. */
async function demoAccount(clientId: string) {
  const { rows } = await pool.query(
    `INSERT INTO trading_accounts (client_id, mode, balance) VALUES ($1,'demo',$2)
     ON CONFLICT (client_id, mode, currency) DO UPDATE SET client_id = excluded.client_id
     RETURNING *`, [clientId, DEMO_STARTING_BALANCE]);
  return rows[0];
}

/** Trading endpoints are for the account holder. Staff read trading history via the CRM. */
const trader = async (req: any, reply: any) => {
  if (!(await authenticate(req, reply, 'trade:own'))) return;
  if (req.principal.kind !== 'client') return reply.code(403).send({ error: 'not a trading account' });
  // A token outlives the row it names — a deleted client must get 401, not a foreign key
  // violation from the first write that trusts the subject.
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.principal.sub]);
  if (!rowCount) return reply.code(401).send({ error: 'unauthenticated' });
};

app.get('/account', { preHandler: trader }, async (req) => {
  const a = await demoAccount(req.principal.sub);
  const { rows: pos } = await pool.query<{ symbol: string; qty: number; avg_price: number }>(
    'SELECT symbol, qty, avg_price FROM positions WHERE account_id = $1', [a.id]);
  const equity = pos.reduce((sum, p) => sum + unrealized(p, spot(p.symbol)), 0);
  return { ...a, unrealized: round8(equity), equity: round8(Number(a.balance) + equity) };
});

const orderBody = z.object({
  symbol: z.string().max(20),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']),
  qty: z.number().positive().finite(),
  limit_price: z.number().positive().finite().optional(),
  stop_price: z.number().positive().finite().optional(),
  trail_amount: z.number().positive().finite().optional(),
  take_profit: z.number().positive().finite().optional(),
  stop_loss: z.number().positive().finite().optional(),
}).refine((o) => o.type !== 'limit' || o.limit_price !== undefined, 'limit_price required')
  .refine((o) => !['stop', 'stop_limit'].includes(o.type) || o.stop_price !== undefined, 'stop_price required')
  .refine((o) => o.type !== 'stop_limit' || o.limit_price !== undefined, 'limit_price required')
  .refine((o) => o.type !== 'trailing_stop' || o.trail_amount !== undefined, 'trail_amount required');

app.post('/orders', { preHandler: trader }, async (req: any, reply) => {
  const body = orderBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  if (!await knownSymbol(b.symbol)) return reply.code(404).send({ error: 'unknown symbol' });

  const account = await demoAccount(req.principal.sub);
  // Belt and braces: nothing in this build may touch a live account.
  if (account.mode !== 'demo') return reply.code(403).send({ error: 'live trading is disabled' });

  const order = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query<OrderRow>(
      `INSERT INTO orders (account_id, client_id, symbol, side, type, qty, limit_price, stop_price,
                           trail_amount, take_profit, stop_loss, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'working') RETURNING *`,
      [account.id, req.principal.sub, b.symbol, b.side, b.type, b.qty,
       b.limit_price ?? null, b.stop_price ?? null, b.trail_amount ?? null,
       b.take_profit ?? null, b.stop_loss ?? null]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'order.placed', actor: req.principal.sub,
      summary: `Placed ${b.type} ${b.side} ${b.qty} ${b.symbol}`,
      ref_table: 'orders', ref_id: rows[0]!.id, data: b,
    });
    return rows[0]!;
  });

  notify(req.principal.sub, { type: 'order', order });
  // Market orders shouldn't wait for the next tick.
  if (order.type === 'market') await fillOrder(order, spot(order.symbol));
  return reply.code(201).send(order);
});

app.get('/orders', { preHandler: trader }, async (req: any) => {
  const q = z.object({ open: z.coerce.boolean().default(false) }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE client_id = $1
       AND ($2::bool IS NOT TRUE OR status IN ('new','working'))
     ORDER BY placed_at DESC LIMIT 200`, [req.principal.sub, q.open]);
  return rows;
});

app.delete('/orders/:id', { preHandler: trader }, async (req: any, reply) => {
  const cancelled = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query<OrderRow>(
      `UPDATE orders SET status = 'cancelled'
        WHERE id = $1 AND client_id = $2 AND status IN ('new','working') RETURNING *`,
      [req.params.id, req.principal.sub]);
    if (!rows[0]) return null;
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'order.cancelled', actor: req.principal.sub,
      summary: `Cancelled ${rows[0].side} ${rows[0].qty} ${rows[0].symbol}`,
      ref_table: 'orders', ref_id: rows[0].id,
    });
    return rows[0];
  });
  if (!cancelled) return reply.code(404).send({ error: 'no such working order' });
  notify(req.principal.sub, { type: 'order', order: cancelled });
  return cancelled;
});

app.get('/positions', { preHandler: trader }, async (req: any) => {
  const account = await demoAccount(req.principal.sub);
  const { rows } = await pool.query<{ symbol: string; qty: number; avg_price: number }>(
    'SELECT symbol, qty, avg_price, updated_at FROM positions WHERE account_id = $1 ORDER BY symbol',
    [account.id]);
  return rows.map((p) => {
    const price = spot(p.symbol);
    return { ...p, price, unrealized: unrealized(p, price) };
  });
});

app.get('/trades', { preHandler: trader }, async (req: any) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.qty, f.price, f.fee, f.filled_at, o.symbol, o.side, o.type
       FROM fills f JOIN orders o ON o.id = f.order_id
      WHERE o.client_id = $1 ORDER BY f.filled_at DESC LIMIT 200`, [req.principal.sub]);
  return rows;
});

await app.register(websocket);

// Browsers cannot set an Authorization header on a WebSocket, and a token in the query
// string would end up in access logs — so the client authenticates in its first message
// and gets nothing until it does.
app.get('/feed', { websocket: true }, (socket) => {
  let authed = false;
  const deadline = setTimeout(() => { if (!authed) socket.close(4401, 'auth timeout'); }, 5000);

  socket.on('message', async (raw: Buffer) => {
    if (authed) return;                       // nothing else to say on this socket yet
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type !== 'auth' || typeof msg.token !== 'string') throw new Error('expected auth');
      const principal = await verifyToken(msg.token);
      authed = true;
      clearTimeout(deadline);
      feed.set(socket, principal);
      await startTicker();
      socket.send(JSON.stringify({ type: 'ready' }));
    } catch {
      socket.close(4401, 'unauthenticated');
    }
  });

  socket.on('close', () => { clearTimeout(deadline); feed.delete(socket); });
  socket.on('error', () => { feed.delete(socket); });
});

// ----------------------------------------------------------- KYC documents

const KYC_KINDS = ['id_front', 'id_back', 'proof_of_address', 'selfie'] as const;
const REQUIRED_KYC = ['id_front', 'proof_of_address'];
// Only formats a reviewer actually needs to look at. Anything else is refused outright.
const ALLOWED_UPLOAD = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['application/pdf', '.pdf'],
]);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(import.meta.dirname, '..', 'uploads');

await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

/** A client uploads its own documents; staff with crm:write can upload on their behalf. */
app.post('/clients/:id/kyc', { preHandler: clientScope }, async (req: any, reply) => {
  if (req.principal.kind !== 'client' && !can(req.principal.role, 'crm:write')) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no file' });

  const ext = ALLOWED_UPLOAD.get(file.mimetype);
  const kind = String(file.fields?.kind?.value ?? '');
  if (!ext) return reply.code(415).send({ error: 'only jpeg, png or pdf' });
  if (!KYC_KINDS.includes(kind as never)) return reply.code(400).send({ error: 'unknown document kind' });

  // The stored name is generated: an uploaded filename never reaches the filesystem.
  const storageKey = `${randomUUID()}${ext}`;
  await mkdir(UPLOAD_DIR, { recursive: true });
  await pipeline(file.file, createWriteStream(join(UPLOAD_DIR, storageKey)));
  if (file.file.truncated) {
    await rm(join(UPLOAD_DIR, storageKey), { force: true });
    return reply.code(413).send({ error: 'file too large' });
  }

  const doc = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO kyc_documents (client_id, kind, storage_key) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, kind, storageKey]);
    await c.query(
      `UPDATE clients SET kyc_status = 'pending' WHERE id = $1 AND kyc_status IN ('none','rejected','expired')`,
      [req.params.id]);
    await logActivity(c, {
      client_id: req.params.id, kind: 'kyc', actor: req.principal.sub,
      summary: `Uploaded ${kind.replace(/_/g, ' ')}`, ref_table: 'kyc_documents', ref_id: String(rows[0].id),
    });
    return rows[0];
  });
  return reply.code(201).send(doc);
});

app.get('/clients/:id/kyc', { preHandler: clientScope }, async (req: any) =>
  (await pool.query(
    `SELECT d.id, d.kind, d.status, d.note, d.uploaded_at, d.reviewed_at, s.name AS reviewed_by
       FROM kyc_documents d LEFT JOIN staff s ON s.id = d.reviewed_by
      WHERE d.client_id = $1 ORDER BY d.uploaded_at DESC`, [req.params.id])).rows);

/** The review queue: every document still waiting on a decision. */
app.get('/kyc/pending', { preHandler: auth('kyc:review') }, async () =>
  (await pool.query(
    `SELECT d.id, d.client_id, d.kind, d.uploaded_at, c.name AS client_name, c.country, c.kyc_status
       FROM kyc_documents d JOIN clients c ON c.id = d.client_id
      WHERE d.status = 'pending' ORDER BY d.uploaded_at`)).rows);

/** Documents are served through here, never as a static path. */
app.get('/kyc/:id/file', { preHandler: auth('kyc:review') }, async (req: any, reply) => {
  const { rows } = await pool.query<{ storage_key: string }>(
    'SELECT storage_key FROM kyc_documents WHERE id = $1', [req.params.id]);
  if (!rows[0]) return reply.code(404).send({ error: 'not found' });
  // storage_key is generated by us, but resolve and re-check anyway.
  const path = join(UPLOAD_DIR, basename(rows[0].storage_key));
  if (!path.startsWith(UPLOAD_DIR)) return reply.code(400).send({ error: 'bad key' });
  return reply.type(extname(path) === '.pdf' ? 'application/pdf' : 'image/*').send(createReadStream(path));
});

app.post('/kyc/:id/review', { preHandler: auth('kyc:review') }, async (req: any, reply) => {
  const body = z.object({
    status: z.enum(['approved', 'rejected']),
    note: z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE kyc_documents SET status = $2, note = $3, reviewed_by = $4, reviewed_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, body.data.status, body.data.note ?? null, req.principal.sub]);
    const doc = rows[0];
    if (!doc) return null;

    // The client is approved once every required document is; one rejection rejects them.
    const { rows: all } = await c.query<{ kind: string; status: string }>(
      'SELECT kind, status FROM kyc_documents WHERE client_id = $1', [doc.client_id]);
    const approved = new Set(all.filter((d) => d.status === 'approved').map((d) => d.kind));
    const status = body.data.status === 'rejected' ? 'rejected'
      : REQUIRED_KYC.every((k) => approved.has(k)) ? 'approved' : 'pending';
    await c.query('UPDATE clients SET kyc_status = $2 WHERE id = $1', [doc.client_id, status]);

    await notifyClientOf(c, {
      client_id: doc.client_id, kind: 'kyc',
      title: status === 'approved' ? 'Identity verified'
        : body.data.status === 'rejected' ? `${doc.kind.replace(/_/g, ' ')} needs attention`
        : `${doc.kind.replace(/_/g, ' ')} accepted`,
      body: body.data.note ?? (status === 'approved'
        ? 'Your account is fully verified.'
        : 'We will be in touch if anything else is needed.'),
      ref_table: 'kyc_documents', ref_id: String(doc.id),
    });
    await logActivity(c, {
      client_id: doc.client_id, kind: 'kyc', actor: req.principal.sub,
      summary: `${doc.kind.replace(/_/g, ' ')} ${body.data.status}${body.data.note ? ` — ${body.data.note}` : ''}`,
      ref_table: 'kyc_documents', ref_id: String(doc.id), data: { client_kyc_status: status },
    });
    return { doc, client_kyc_status: status };
  });
  if (!out) return reply.code(404).send({ error: 'no such pending document' });
  return out;
});

// ---------------------------------------------------- deposits & withdrawals

/** Raise flags and put them on the client's timeline. Returns what was raised. */
async function raiseFlags(c: pg.PoolClient, clientId: string, flags: Flag[]) {
  for (const f of flags) {
    await c.query(
      'INSERT INTO flags (client_id, rule, severity, details) VALUES ($1,$2,$3,$4)',
      [clientId, f.rule, f.severity, f.details]);
    await logActivity(c, {
      client_id: clientId, kind: 'flag', actor: 'system',
      summary: `Flagged: ${f.rule.replace(/_/g, ' ')} (${f.severity})`, data: f.details,
    });
  }
  return flags;
}

const cashBody = z.object({
  kind: z.enum(['deposit', 'withdrawal']),
  amount: z.number().positive().finite().max(1e9),
});

/**
 * A withdrawal leaves the balance the moment it is requested and comes back only if it is
 * rejected; a deposit lands only once it is approved, because money that has not arrived
 * cannot be spent. So the balance moves at opposite ends of the two flows.
 */
app.post('/cash', { preHandler: trader }, async (req: any, reply) => {
  const body = cashBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { kind, amount } = body.data;
  const account = await demoAccount(req.principal.sub);

  const { rows: [client] } = await pool.query<{ kyc_status: string }>(
    'SELECT kyc_status FROM clients WHERE id = $1', [req.principal.sub]);

  const result = await tx(req.principal.sub, async (c) => {
    // Lock the account first: checking the balance and debiting it must be one step, or
    // two withdrawals racing each other can both pass a check neither can afford.
    const { rows: [locked] } = await c.query<{ balance: number; currency: string }>(
      'SELECT balance, currency FROM trading_accounts WHERE id = $1 FOR UPDATE', [account.id]);
    if (kind === 'withdrawal' && amount > Number(locked!.balance)) return 'insufficient' as const;

    // Signed at the source: a withdrawal is negative everywhere downstream.
    const signed = kind === 'withdrawal' ? -amount : amount;
    const { rows } = await c.query(
      `INSERT INTO cash_transactions (account_id, client_id, kind, amount) VALUES ($1,$2,$3,$4) RETURNING *`,
      [account.id, req.principal.sub, kind, signed]);

    if (kind === 'withdrawal') {
      await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1', [account.id, signed]);
    }
    await logActivity(c, {
      client_id: req.principal.sub, kind, actor: req.principal.sub,
      summary: kind === 'withdrawal'
        ? `Requested withdrawal of ${amount} ${locked!.currency} — debited, awaiting approval`
        : `Requested deposit of ${amount} ${locked!.currency}`,
      ref_table: 'cash_transactions', ref_id: String(rows[0].id), data: { amount },
    });

    let flags: Flag[] = [];
    if (kind === 'withdrawal') {
      const { rows: deposits } = await c.query<{ amount: number; created_at: Date }>(
        `SELECT amount, created_at FROM cash_transactions
          WHERE client_id = $1 AND kind = 'deposit' AND status IN ('approved','settled')
          ORDER BY created_at DESC LIMIT 10`, [req.principal.sub]);
      flags = await raiseFlags(c, req.principal.sub, withdrawalFlags({
        amount,
        kycStatus: client?.kyc_status ?? 'none',
        recentDeposits: deposits.map((d) => ({ amount: Number(d.amount), at: d.created_at })),
      }));
    }
    return { transaction: rows[0], flags };
  });
  if (result === 'insufficient') return reply.code(400).send({ error: 'amount exceeds balance' });
  return reply.code(201).send(result);
});

app.get('/cash', { preHandler: auth() }, async (req: any, reply) => {
  // A trader sees its own; staff with crm:read may pass ?client_id=.
  const q = z.object({ client_id: z.string().uuid().optional() }).parse(req.query);
  if (req.principal.kind !== 'client' && !can(req.principal.role, 'crm:read')) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  const clientId = req.principal.kind === 'client' ? req.principal.sub : q.client_id;
  if (!clientId) return [];
  const { rows } = await pool.query(
    `SELECT id, kind, amount, status, created_at FROM cash_transactions
      WHERE client_id = $1 ORDER BY created_at DESC LIMIT 200`, [clientId]);
  return rows;
});

app.post('/cash/:id/decide', { preHandler: auth('kyc:review') }, async (req: any, reply) => {
  const body = z.object({
    status: z.enum(['approved', 'rejected']),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE cash_transactions SET status = $2, approved_by = $3
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, body.data.status, req.principal.sub]);
    const t = rows[0];
    if (!t) return null;

    // A deposit lands on approval. A withdrawal already left on request, so approval moves
    // nothing and only a rejection does — putting the money back.
    const reversal = t.kind === 'withdrawal' && body.data.status === 'rejected';
    const settles = t.kind === 'deposit' && body.data.status === 'approved';
    if (settles) {
      await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1', [t.account_id, t.amount]);
    } else if (reversal) {
      await c.query('UPDATE trading_accounts SET balance = balance - $2 WHERE id = $1', [t.account_id, t.amount]);
    }

    await notifyClientOf(c, {
      client_id: t.client_id, kind: t.kind,
      title: `${t.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} ${body.data.status}`,
      body: `${Math.abs(Number(t.amount))} ${body.data.status}`
        + (reversal ? ', and returned to your balance.' : '.'),
      ref_table: 'cash_transactions', ref_id: String(t.id),
    });
    await logActivity(c, {
      client_id: t.client_id, kind: t.kind, actor: req.principal.sub,
      summary: `${t.kind} of ${Math.abs(Number(t.amount))} ${body.data.status}`
        + (reversal ? ' — refunded to the balance' : ''),
      ref_table: 'cash_transactions', ref_id: String(t.id),
      data: { reversed: reversal },
    });
    return t;
  });
  if (!out) return reply.code(404).send({ error: 'no such pending transaction' });
  return out;
});

// ------------------------------------------------------------------- flags

app.get('/flags', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({
    status: z.enum(['open', 'cleared', 'escalated']).default('open'),
    client_id: z.string().uuid().optional(),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT f.*, c.name AS client_name FROM flags f JOIN clients c ON c.id = f.client_id
      WHERE f.status = $1 AND ($2::uuid IS NULL OR f.client_id = $2)
      ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, f.raised_at DESC
      LIMIT 200`, [q.status, q.client_id ?? null]);
  return rows;
});

app.patch('/flags/:id', { preHandler: auth('kyc:review') }, async (req: any, reply) => {
  const body = z.object({ status: z.enum(['cleared', 'escalated']) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE flags SET status = $2, closed_by = $3, closed_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [req.params.id, body.data.status, req.principal.sub]);
    if (!rows[0]) return null;
    await logActivity(c, {
      client_id: rows[0].client_id, kind: 'flag', actor: req.principal.sub,
      summary: `Flag ${rows[0].rule.replace(/_/g, ' ')} ${body.data.status}`,
      ref_table: 'flags', ref_id: String(rows[0].id),
    });
    return rows[0];
  });
  if (!out) return reply.code(404).send({ error: 'no such open flag' });
  return out;
});

// ----------------------------------------------------------------- reports

/** Per client: what they are worth and what they have done. */
const CLIENT_REPORT = `
  SELECT c.name, c.email, c.country, c.tier, s.name AS stage, c.kyc_status,
         o.name AS account_manager, c.created_at,
         coalesce(cash.deposits, 0)     AS deposits,
         coalesce(cash.withdrawals, 0)  AS withdrawals,
         -- Debited from the balance already, but not yet paid out, so it is neither
         -- spendable nor withdrawn. Shown so balance and net_deposits reconcile.
         coalesce(cash.withdrawals_pending, 0) AS withdrawals_pending,
         coalesce(cash.deposits, 0) - coalesce(cash.withdrawals, 0) AS net_deposits,
         coalesce(t.trades, 0)          AS trades,
         coalesce(t.volume, 0)          AS volume,
         coalesce(a.balance, 0)         AS balance,
         coalesce(f.open_flags, 0)      AS open_flags
    FROM clients c
    JOIN pipeline_stages s ON s.id = c.stage_id
    LEFT JOIN staff o ON o.id = c.owner_staff_id
    LEFT JOIN trading_accounts a ON a.client_id = c.id AND a.mode = 'demo'
    LEFT JOIN (
      SELECT client_id,
             sum(amount) FILTER (WHERE kind = 'deposit'    AND status IN ('approved','settled')) AS deposits,
             -sum(amount) FILTER (WHERE kind = 'withdrawal' AND status IN ('approved','settled')) AS withdrawals,
             -sum(amount) FILTER (WHERE kind = 'withdrawal' AND status = 'pending')                AS withdrawals_pending
        FROM cash_transactions GROUP BY client_id
    ) cash ON cash.client_id = c.id
    LEFT JOIN (
      SELECT ord.client_id, count(*) AS trades, sum(fl.qty * fl.price) AS volume
        FROM fills fl JOIN orders ord ON ord.id = fl.order_id GROUP BY ord.client_id
    ) t ON t.client_id = c.id
    LEFT JOIN (
      SELECT client_id, count(*) AS open_flags FROM flags WHERE status = 'open' GROUP BY client_id
    ) f ON f.client_id = c.id
   ORDER BY volume DESC`;

/** Per staff member: pipeline throughput and how quickly they respond. */
const TEAM_REPORT = `
  SELECT st.name AS staff, st.role,
         count(c.id)                                              AS clients,
         count(c.id) FILTER (WHERE ps.sort_order >= 4)            AS onboarded,
         count(c.id) FILTER (WHERE ps.name = 'Churned')           AS churned,
         count(c.id) FILTER (WHERE c.kyc_status = 'approved')     AS kyc_approved,
         coalesce(tk.open_tasks, 0)                               AS open_tasks,
         round(avg(extract(epoch FROM first_touch.at - c.created_at) / 3600)::numeric, 1)
                                                                  AS avg_hours_to_first_contact
    FROM staff st
    LEFT JOIN clients c ON c.owner_staff_id = st.id
    LEFT JOIN pipeline_stages ps ON ps.id = c.stage_id
    LEFT JOIN LATERAL (
      SELECT min(al.at) AS at FROM activity_log al
       WHERE al.client_id = c.id AND al.kind IN ('note','task')
    ) first_touch ON true
    LEFT JOIN (
      SELECT assigned_to, count(*) AS open_tasks FROM tasks WHERE status = 'open' GROUP BY assigned_to
    ) tk ON tk.assigned_to = st.id
   WHERE st.active
   GROUP BY st.id, st.name, st.role, tk.open_tasks
   ORDER BY clients DESC`;

const REPORTS: Record<string, { sql: string; perm: Perm }> = {
  clients: { sql: CLIENT_REPORT, perm: 'crm:read' },
  team: { sql: TEAM_REPORT, perm: 'crm:read' },
};

app.get('/reports/:name', { preHandler: auth('crm:read') }, async (req: any, reply) => {
  const name = String(req.params.name).replace(/\.csv$/, '');
  const report = REPORTS[name];
  if (!report) return reply.code(404).send({ error: 'unknown report' });
  if (!can(req.principal.role, report.perm)) return reply.code(403).send({ error: 'forbidden' });

  const { rows } = await pool.query(report.sql);
  if (!String(req.params.name).endsWith('.csv')) return rows;
  return reply
    .type('text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(toCSV(rows));
});

// ------------------------------------------------------------ notifications

type Notice = {
  client_id: string; kind: string; title: string;
  body?: string; ref_table?: string; ref_id?: string;
};

/**
 * Tell a client something happened to them. Written in the caller's transaction so a
 * notification cannot outlive the event it describes, then pushed over the socket so an
 * open session sees it without polling.
 *
 * The rule for what belongs here: things done *to* the client — by staff, or by the
 * engine — not things the client just did themselves, which they already know about.
 * Compliance flags are never notified; see the note on the table.
 */
async function notifyClientOf(c: pg.PoolClient, n: Notice) {
  const { rows: [row] } = await c.query(
    `INSERT INTO notifications (client_id, kind, title, body, ref_table, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [n.client_id, n.kind, n.title, n.body ?? null, n.ref_table ?? null, n.ref_id ?? null]);
  pending.push(row);
  return row;
}

/**
 * Sockets are pushed after the transaction commits, not during it: a client told about a
 * fill that then rolled back would be looking at money that never moved.
 */
const pending: any[] = [];
function flushNotifications() {
  while (pending.length) {
    const row = pending.shift();
    notify(row.client_id, { type: 'notification', notification: row });
  }
}

app.addHook('onResponse', async () => flushNotifications());

app.get('/notifications', { preHandler: trader }, async (req: any) => {
  const q = z.object({
    unread: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM notifications
      WHERE client_id = $1 AND ($2::bool IS NOT TRUE OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [req.principal.sub, q.unread, q.limit]);
  return rows;
});

app.get('/notifications/unread-count', { preHandler: trader }, async (req: any) => {
  const { rows: [row] } = await pool.query<{ unread: number }>(
    'SELECT count(*) AS unread FROM notifications WHERE client_id = $1 AND read_at IS NULL',
    [req.principal.sub]);
  return { unread: Number(row!.unread) };
});

app.post('/notifications/:id/read', { preHandler: trader }, async (req: any, reply) => {
  // Scoped by client_id as well as id, so one client cannot mark another's as read.
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = coalesce(read_at, now())
      WHERE id = $1 AND client_id = $2 RETURNING *`, [req.params.id, req.principal.sub]);
  if (!rows[0]) return reply.code(404).send({ error: 'no such notification' });
  return rows[0];
});

app.post('/notifications/read-all', { preHandler: trader }, async (req: any) => {
  const { rowCount } = await pool.query(
    'UPDATE notifications SET read_at = now() WHERE client_id = $1 AND read_at IS NULL',
    [req.principal.sub]);
  return { marked: rowCount ?? 0 };
});

/** Staff message a client directly — the CRM side of the same inbox. */
app.post('/clients/:id/notify', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({
    title: z.string().min(1).max(120),
    body: z.string().max(2000).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });

  const out = await tx(req.principal.sub, async (c) => {
    const row = await notifyClientOf(c, {
      client_id: req.params.id, kind: 'message', title: body.data.title, body: body.data.body,
    });
    await logActivity(c, {
      client_id: req.params.id, kind: 'message', actor: req.principal.sub,
      summary: `Messaged the client: ${body.data.title}`,
      ref_table: 'notifications', ref_id: String(row.id),
    });
    return row;
  });
  return reply.code(201).send(out);
});

// ---------------------------------------------------------- support tickets

/**
 * Resolve who is asking and which client's tickets they may see. A client gets its own
 * and nothing else; staff need crm:read and may name a client. Returns null once a reply
 * has already been sent.
 */
async function ticketScope(req: any, reply: any): Promise<{ clientId: string | null; staff: boolean } | null> {
  if (!(await authenticate(req, reply))) return null;
  if (req.principal.kind === 'client') return { clientId: req.principal.sub, staff: false };
  if (!can(req.principal.role, 'crm:read')) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  const q = z.object({ client_id: z.string().uuid().optional() }).parse(req.query ?? {});
  return { clientId: q.client_id ?? null, staff: true };
}

app.get('/tickets', async (req: any, reply) => {
  const scope = await ticketScope(req, reply);
  if (!scope) return;
  const q = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed', 'live']).optional(),
  }).parse(req.query ?? {});

  const { rows } = await pool.query(
    `SELECT t.*, c.name AS client_name, s.name AS assignee_name,
            (SELECT count(*) FROM ticket_messages m
              WHERE m.ticket_id = t.id AND (m.internal = false OR $3::bool)) AS messages,
            (SELECT max(created_at) FROM ticket_messages m WHERE m.ticket_id = t.id) AS last_message_at
       FROM tickets t
       JOIN clients c ON c.id = t.client_id
       LEFT JOIN staff s ON s.id = t.assigned_to
      WHERE ($1::uuid IS NULL OR t.client_id = $1)
        AND ($2::text IS NULL
             OR ($2 = 'live' AND t.status IN ('open','pending'))
             OR t.status = $2)
      ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               t.updated_at DESC
      LIMIT 200`,
    [scope.clientId, q.status ?? null, scope.staff]);
  return rows;
});

app.get('/tickets/:id', async (req: any, reply) => {
  const scope = await ticketScope(req, reply);
  if (!scope) return;
  const { rows: [ticket] } = await pool.query(
    `SELECT t.*, c.name AS client_name, s.name AS assignee_name
       FROM tickets t JOIN clients c ON c.id = t.client_id
       LEFT JOIN staff s ON s.id = t.assigned_to
      WHERE t.id = $1 AND ($2::uuid IS NULL OR t.client_id = $2)`,
    [req.params.id, scope.clientId]);
  if (!ticket) return reply.code(404).send({ error: 'no such ticket' });

  // The one filter that matters: internal notes are staff-only.
  const { rows: messages } = await pool.query(
    `SELECT m.id, m.author_kind, m.body, m.internal, m.created_at,
            coalesce(s.name, c.name) AS author_name
       FROM ticket_messages m
       LEFT JOIN staff s ON s.id = m.author_id AND m.author_kind = 'staff'
       LEFT JOIN clients c ON c.id = m.author_id AND m.author_kind = 'client'
      WHERE m.ticket_id = $1 AND (m.internal = false OR $2::bool)
      ORDER BY m.created_at, m.id`,
    [req.params.id, scope.staff]);
  return { ...ticket, messages };
});

const ticketBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  category: z.enum(['account', 'funding', 'trading', 'kyc', 'technical', 'other']).default('other'),
});

app.post('/tickets', { preHandler: trader }, async (req: any, reply) => {
  const body = ticketBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const ticket = await tx(req.principal.sub, async (c) => {
    const { rows: [t] } = await c.query(
      `INSERT INTO tickets (client_id, subject, category) VALUES ($1,$2,$3) RETURNING *`,
      [req.principal.sub, body.data.subject, body.data.category]);
    await c.query(
      `INSERT INTO ticket_messages (ticket_id, client_id, author_kind, author_id, body)
       VALUES ($1,$2,'client',$2,$3)`, [t.id, req.principal.sub, body.data.body]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'ticket', actor: req.principal.sub,
      summary: `Opened a support ticket: ${body.data.subject}`,
      ref_table: 'tickets', ref_id: t.id, data: { category: body.data.category },
    });
    return t;
  });
  return reply.code(201).send(ticket);
});

const messageBody = z.object({
  body: z.string().min(1).max(5000),
  internal: z.boolean().default(false),
});

app.post('/tickets/:id/messages', async (req: any, reply) => {
  const scope = await ticketScope(req, reply);
  if (!scope) return;
  const parsed = messageBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  // Only staff can write an internal note, and only staff with write access can reply.
  const internal = parsed.data.internal && scope.staff;
  if (scope.staff && !can(req.principal.role, 'crm:write')) {
    return reply.code(403).send({ error: 'forbidden' });
  }

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [t] } = await c.query<{ id: string; client_id: string; subject: string; status: string }>(
      `SELECT id, client_id, subject, status FROM tickets
        WHERE id = $1 AND ($2::uuid IS NULL OR client_id = $2) FOR UPDATE`,
      [req.params.id, scope.clientId]);
    if (!t) return 'missing' as const;

    await c.query(
      `INSERT INTO ticket_messages (ticket_id, client_id, author_kind, author_id, body, internal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.id, t.client_id, scope.staff ? 'staff' : 'client', req.principal.sub, parsed.data.body, internal]);

    // A note to ourselves does not change whose turn it is. A real reply does: ours puts
    // the ball in the client's court, theirs brings the ticket back to us — and reopens
    // it if it had been resolved.
    if (!internal) {
      const status = scope.staff ? 'pending' : 'open';
      await c.query(
        `UPDATE tickets SET status = $2, resolved_at = NULL WHERE id = $1`, [t.id, status]);
    } else {
      await c.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [t.id]);
    }

    if (scope.staff && !internal) {
      await notifyClientOf(c, {
        client_id: t.client_id, kind: 'ticket',
        title: `Reply on: ${t.subject}`,
        body: parsed.data.body.slice(0, 160),
        ref_table: 'tickets', ref_id: t.id,
      });
    }
    await logActivity(c, {
      client_id: t.client_id, kind: 'ticket', actor: req.principal.sub,
      summary: internal ? `Internal note on: ${t.subject}`
        : scope.staff ? `Replied on: ${t.subject}` : `Client replied on: ${t.subject}`,
      ref_table: 'tickets', ref_id: t.id, data: { internal },
    });
    return t;
  });
  if (out === 'missing') return reply.code(404).send({ error: 'no such ticket' });
  return reply.code(201).send({ ok: true });
});

app.patch('/tickets/:id', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({
    status: z.enum(['open', 'pending', 'resolved', 'closed']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigned_to: z.string().uuid().nullable().optional(),
    category: z.enum(['account', 'funding', 'trading', 'kyc', 'technical', 'other']).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const entries = Object.entries(body.data);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE tickets SET ${set},
              resolved_at = CASE WHEN $${entries.length + 2} = 'resolved' THEN now()
                                 WHEN $${entries.length + 2} IS NOT NULL THEN NULL
                                 ELSE resolved_at END
        WHERE id = $1 RETURNING *`,
      [req.params.id, ...entries.map(([, v]) => v), body.data.status ?? null]);
    if (!rows[0]) return null;
    if (body.data.status === 'resolved' || body.data.status === 'closed') {
      await notifyClientOf(c, {
        client_id: rows[0].client_id, kind: 'ticket',
        title: `Ticket ${body.data.status}: ${rows[0].subject}`,
        body: 'Reply on the ticket if you need anything further.',
        ref_table: 'tickets', ref_id: rows[0].id,
      });
    }
    await logActivity(c, {
      client_id: rows[0].client_id, kind: 'ticket', actor: req.principal.sub,
      summary: `Ticket updated: ${rows[0].subject}`,
      ref_table: 'tickets', ref_id: rows[0].id, data: body.data,
    });
    return rows[0];
  });
  if (!out) return reply.code(404).send({ error: 'no such ticket' });
  return out;
});

// ----------------------------------------------- currencies, credits, wallets

type Currency = { code: string; name: string; kind: 'fiat' | 'crypto'; decimals: number };

/** Reference data changes about never, so read it once and keep it. */
let currencyCache: Map<string, Currency> | null = null;
let rateCache: Map<string, number> | null = null;
async function currencies() {
  if (!currencyCache) {
    const { rows } = await pool.query<Currency>(
      'SELECT code, name, kind, decimals FROM currencies WHERE active ORDER BY kind, code');
    currencyCache = new Map(rows.map((c) => [c.code, c]));
    const { rows: rates } = await pool.query<{ code: string; per_usd: number }>('SELECT code, per_usd FROM fx_rates');
    rateCache = new Map(rates.map((r) => [r.code, Number(r.per_usd)]));
  }
  return currencyCache;
}

/**
 * What one unit of `code` is worth in USD, or null when we genuinely do not know.
 * Crypto is priced from the live feed where an instrument exists; everything else comes
 * from the seeded FX table. Returning null rather than a guess keeps unpriced assets out
 * of totals instead of quietly understating them.
 */
async function rateToUsd(code: string): Promise<number | null> {
  const all = await currencies();
  const ccy = all.get(code);
  if (!ccy) return null;
  if (code === 'USD') return 1;
  if (ccy.kind === 'crypto') {
    const { rowCount } = await pool.query('SELECT 1 FROM instruments WHERE symbol = $1', [`${code}USD`]);
    if (rowCount) return spot(`${code}USD`);
  }
  const per = rateCache?.get(code);
  return per ? 1 / per : null;
}

/** Sum mixed-currency amounts into USD, reporting what could not be priced. */
async function totalUsd(rows: { code: string; amount: number }[]) {
  let usd = 0;
  const unpriced: string[] = [];
  for (const r of rows) {
    const rate = await rateToUsd(r.code);
    if (rate === null) unpriced.push(r.code);
    else usd += Number(r.amount) * rate;
  }
  return { usd: round8(usd), unpriced: [...new Set(unpriced)] };
}

app.get('/currencies', { preHandler: auth() }, async () =>
  [...(await currencies()).values()]);

/** Every balance the client holds, fiat and crypto, with a USD view for totals. */
app.get('/accounts', { preHandler: trader }, async (req: any) => {
  await demoAccount(req.principal.sub);   // make sure the base USD account exists
  const { rows: accounts } = await pool.query<{ currency: string; balance: number }>(
    `SELECT id, currency, balance, mode, leverage FROM trading_accounts
      WHERE client_id = $1 AND mode = 'demo' ORDER BY currency`, [req.principal.sub]);
  const { rows: wallets } = await pool.query<{ asset: string; balance: number }>(
    'SELECT id, asset, address, balance FROM wallets WHERE client_id = $1 ORDER BY asset',
    [req.principal.sub]);

  const priced = async <T extends { balance: number }>(row: T, code: string) => {
    const rate = await rateToUsd(code);
    return { ...row, usd_value: rate === null ? null : round8(Number(row.balance) * rate) };
  };
  const cash = await Promise.all(accounts.map((a) => priced(a, a.currency)));
  const crypto = await Promise.all(wallets.map((w) => priced(w, w.asset)));
  const total = await totalUsd([
    ...accounts.map((a) => ({ code: a.currency, amount: a.balance })),
    ...wallets.map((w) => ({ code: w.asset, amount: w.balance })),
  ]);
  return { cash, wallets: crypto, total_usd: total.usd, unpriced: total.unpriced };
});

const creditBody = z.object({
  currency: z.string().min(2).max(10),
  amount: z.number().positive().finite().max(1e12),
  note: z.string().max(500).optional(),
});

/**
 * Put credit on a client's account in any supported currency. This creates money from
 * nothing, so it is admin-only, always audited, and always on the client's timeline.
 */
app.post('/clients/:id/credit', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = creditBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { currency, amount, note } = body.data;

  const ccy = (await currencies()).get(currency);
  if (!ccy) return reply.code(404).send({ error: 'unknown currency' });
  if (ccy.kind !== 'fiat') return reply.code(400).send({ error: 'use the wallet credit route for crypto' });
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });

  return tx(req.principal.sub, async (c) => {
    // The account for this currency may not exist yet; opening it is part of crediting it.
    const { rows: [account] } = await c.query(
      `INSERT INTO trading_accounts (client_id, mode, currency, balance) VALUES ($1,'demo',$2,0)
       ON CONFLICT (client_id, mode, currency) DO UPDATE SET client_id = excluded.client_id
       RETURNING *`, [req.params.id, currency]);
    await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1', [account.id, amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO cash_transactions (account_id, client_id, kind, amount, status, approved_by)
       VALUES ($1,$2,'adjustment',$3,'settled',$4) RETURNING *`,
      [account.id, req.params.id, amount, req.principal.sub]);
    await notifyClientOf(c, {
      client_id: req.params.id, kind: 'credit',
      title: `${amount} ${currency} added to your account`,
      body: note ?? undefined, ref_table: 'cash_transactions', ref_id: String(entry.id),
    });
    await logActivity(c, {
      client_id: req.params.id, kind: 'credit', actor: req.principal.sub,
      summary: `Credited ${amount} ${currency}${note ? ` — ${note}` : ''}`,
      ref_table: 'cash_transactions', ref_id: String(entry.id),
      data: { currency, amount, note: note ?? null },
    });
    return { transaction: entry, currency, amount };
  });
});

// ------------------------------------------------------- currency converter

/**
 * Lock a client's holding of one currency and return its balance. Fiat lives in
 * trading_accounts, crypto in wallets; the caller should not have to care which.
 * `open` creates the holding when it does not exist yet, which is what the receiving
 * side of a conversion needs.
 */
async function lockHolding(
  c: pg.PoolClient, clientId: string, code: string, kind: 'fiat' | 'crypto', open: boolean,
): Promise<{ table: 'trading_accounts' | 'wallets'; id: string; balance: number } | null> {
  if (kind === 'fiat') {
    if (open) {
      await c.query(
        `INSERT INTO trading_accounts (client_id, mode, currency, balance) VALUES ($1,'demo',$2,0)
         ON CONFLICT (client_id, mode, currency) DO NOTHING`, [clientId, code]);
    }
    const { rows } = await c.query<{ id: string; balance: number }>(
      `SELECT id, balance FROM trading_accounts
        WHERE client_id = $1 AND mode = 'demo' AND currency = $2 FOR UPDATE`, [clientId, code]);
    return rows[0] ? { table: 'trading_accounts', ...rows[0] } : null;
  }
  if (open) {
    await c.query(
      `INSERT INTO wallets (client_id, asset, address) VALUES ($1,$2,$3)
       ON CONFLICT (client_id, asset) DO NOTHING`, [clientId, code, demoAddress(code)]);
  }
  const { rows } = await c.query<{ id: string; balance: number }>(
    'SELECT id, balance FROM wallets WHERE client_id = $1 AND asset = $2 FOR UPDATE', [clientId, code]);
  return rows[0] ? { table: 'wallets', ...rows[0] } : null;
}

const moveBalance = (c: pg.PoolClient, h: { table: string; id: string }, delta: number) =>
  c.query(`UPDATE ${h.table === 'wallets' ? 'wallets' : 'trading_accounts'}
            SET balance = balance + $2 WHERE id = $1`, [h.id, delta]);

const convertBody = z.object({
  from: z.string().min(2).max(10),
  to: z.string().min(2).max(10),
  amount: z.number().positive().finite(),
  /** Slippage guard: refuse if the rate moved and this much would not be received. */
  min_receive: z.number().positive().finite().optional(),
});

/** What a conversion would give right now. Indicative — the rate is re-read on execution. */
app.get('/convert/quote', { preHandler: trader }, async (req: any, reply) => {
  const q = convertBody.omit({ min_receive: true }).safeParse(req.query && {
    ...req.query, amount: Number(req.query.amount),
  });
  if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
  const all = await currencies();
  const from = all.get(q.data.from), to = all.get(q.data.to);
  if (!from || !to) return reply.code(404).send({ error: 'unknown currency' });
  if (from.code === to.code) return reply.code(400).send({ error: 'same currency' });

  const quoted = convert({
    amount: q.data.amount,
    fromUsd: await rateToUsd(from.code), toUsd: await rateToUsd(to.code),
    decimals: to.decimals,
  });
  if (!quoted) return reply.code(422).send({ error: 'cannot price this pair right now' });
  return { from: from.code, to: to.code, amount: q.data.amount, ...quoted };
});

/**
 * Exchange one of a client's balances for another. Both sides move inside a single
 * transaction: a conversion that debited without crediting would simply destroy money.
 */
app.post('/convert', { preHandler: trader }, async (req: any, reply) => {
  const body = convertBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { from, to, amount, min_receive } = body.data;

  const all = await currencies();
  const src = all.get(from), dst = all.get(to);
  if (!src || !dst) return reply.code(404).send({ error: 'unknown currency' });
  if (src.code === dst.code) return reply.code(400).send({ error: 'same currency' });

  const priced = convert({
    amount, fromUsd: await rateToUsd(src.code), toUsd: await rateToUsd(dst.code), decimals: dst.decimals,
  });
  if (!priced) return reply.code(422).send({ error: 'cannot price this pair, or the amount is too small' });
  if (min_receive !== undefined && priced.received < min_receive) {
    return reply.code(409).send({ error: 'rate moved', would_receive: priced.received, min_receive });
  }

  const out = await tx(req.principal.sub, async (c) => {
    // Always lock in the same order whatever the direction, or GBP->USD and USD->GBP
    // running at once can each hold what the other is waiting for.
    const order = [src, dst].sort((a, b) => a.code.localeCompare(b.code));
    const locked = new Map<string, Awaited<ReturnType<typeof lockHolding>>>();
    for (const ccy of order) {
      locked.set(ccy.code, await lockHolding(c, req.principal.sub, ccy.code, ccy.kind, ccy.code === dst.code));
    }
    const source = locked.get(src.code);
    const target = locked.get(dst.code);
    if (!source) return 'no-holding' as const;
    if (Number(source.balance) < amount) return 'insufficient' as const;
    if (!target) return 'no-holding' as const;

    await moveBalance(c, source, -amount);
    await moveBalance(c, target, priced.received);
    const { rows: [record] } = await c.query(
      `INSERT INTO conversions (client_id, from_code, from_amount, to_code, to_amount, rate)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.principal.sub, src.code, amount, dst.code, priced.received, priced.rate]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'convert', actor: req.principal.sub,
      summary: `Exchanged ${amount} ${src.code} for ${priced.received} ${dst.code}`,
      ref_table: 'conversions', ref_id: String(record.id),
      data: { from: src.code, to: dst.code, amount, received: priced.received, rate: priced.rate },
    });
    return record;
  });

  if (out === 'no-holding') return reply.code(400).send({ error: `no ${from} balance to exchange` });
  if (out === 'insufficient') return reply.code(400).send({ error: `amount exceeds your ${from} balance` });
  return reply.code(201).send({ ...out, dust_usd: priced.dustUsd });
});

app.get('/conversions', { preHandler: trader }, async (req: any) =>
  (await pool.query(
    `SELECT * FROM conversions WHERE client_id = $1 ORDER BY at DESC LIMIT 100`,
    [req.principal.sub])).rows);

// ------------------------------------------------------------ crypto wallets

/**
 * Simulated addresses. The DEMO- prefix is not decoration: an address that looked real
 * could be funded with real coin that nothing here can ever recover or return.
 */
const demoAddress = (asset: string) => `DEMO-${asset}-${randomUUID().replace(/-/g, '')}`;

app.get('/wallets', { preHandler: trader }, async (req: any) => {
  const { rows } = await pool.query(
    `SELECT id, asset, address, balance, created_at FROM wallets WHERE client_id = $1 ORDER BY asset`,
    [req.principal.sub]);
  return Promise.all(rows.map(async (w) => ({ ...w, usd_value: await rateToUsd(w.asset).then((r) => r === null ? null : round8(Number(w.balance) * r)) })));
});

app.post('/wallets', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({ asset: z.string().min(2).max(10) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const ccy = (await currencies()).get(body.data.asset);
  if (!ccy) return reply.code(404).send({ error: 'unknown asset' });
  if (ccy.kind !== 'crypto') return reply.code(400).send({ error: 'not a crypto asset' });

  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO wallets (client_id, asset, address) VALUES ($1,$2,$3)
       ON CONFLICT (client_id, asset) DO UPDATE SET client_id = excluded.client_id RETURNING *`,
      [req.principal.sub, body.data.asset, demoAddress(body.data.asset)]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'wallet', actor: req.principal.sub,
      summary: `Opened a ${body.data.asset} wallet`, ref_table: 'wallets', ref_id: rows[0].id,
    });
    return rows[0];
  });
});

app.get('/wallet-transactions', { preHandler: auth() }, async (req: any, reply) => {
  const q = z.object({ client_id: z.string().uuid().optional() }).parse(req.query);
  if (req.principal.kind !== 'client' && !can(req.principal.role, 'crm:read')) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  const clientId = req.principal.kind === 'client' ? req.principal.sub : q.client_id;
  if (!clientId) return [];
  const { rows } = await pool.query(
    `SELECT t.*, w.asset FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id
      WHERE t.client_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [clientId]);
  return rows;
});

/** Staff credit a wallet. Same reasoning as the fiat credit route: admin-only. */
app.post('/clients/:id/wallet-credit', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = z.object({
    asset: z.string().min(2).max(10),
    amount: z.number().positive().finite().max(1e12),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const ccy = (await currencies()).get(body.data.asset);
  if (!ccy || ccy.kind !== 'crypto') return reply.code(404).send({ error: 'unknown crypto asset' });

  return tx(req.principal.sub, async (c) => {
    const { rows: [wallet] } = await c.query(
      `INSERT INTO wallets (client_id, asset, address) VALUES ($1,$2,$3)
       ON CONFLICT (client_id, asset) DO UPDATE SET client_id = excluded.client_id RETURNING *`,
      [req.params.id, body.data.asset, demoAddress(body.data.asset)]);
    await c.query('UPDATE wallets SET balance = balance + $2 WHERE id = $1', [wallet.id, body.data.amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO wallet_transactions (wallet_id, client_id, kind, amount, status, decided_by, tx_ref)
       VALUES ($1,$2,'credit',$3,'confirmed',$4,$5) RETURNING *`,
      [wallet.id, req.params.id, body.data.amount, req.principal.sub, `DEMO-TX-${randomUUID().slice(0, 16)}`]);
    await logActivity(c, {
      client_id: req.params.id, kind: 'credit', actor: req.principal.sub,
      summary: `Credited ${body.data.amount} ${body.data.asset} to the wallet`,
      ref_table: 'wallet_transactions', ref_id: String(entry.id),
      data: { asset: body.data.asset, amount: body.data.amount },
    });
    return entry;
  });
});

/** Withdrawals debit on request and refund on rejection — the same rule as fiat. */
app.post('/wallets/:id/withdraw', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({
    amount: z.number().positive().finite(),
    to_address: z.string().min(6).max(120),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    // Lock before checking, so two withdrawals cannot both spend the same balance.
    const { rows: [w] } = await c.query<{ id: string; asset: string; balance: number }>(
      'SELECT id, asset, balance FROM wallets WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [req.params.id, req.principal.sub]);
    if (!w) return 'missing' as const;
    if (body.data.amount > Number(w.balance)) return 'insufficient' as const;

    await c.query('UPDATE wallets SET balance = balance - $2 WHERE id = $1', [w.id, body.data.amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO wallet_transactions (wallet_id, client_id, kind, amount, to_address)
       VALUES ($1,$2,'withdrawal',$3,$4) RETURNING *`,
      [w.id, req.principal.sub, -body.data.amount, body.data.to_address]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'withdrawal', actor: req.principal.sub,
      summary: `Requested withdrawal of ${body.data.amount} ${w.asset} — debited, awaiting approval`,
      ref_table: 'wallet_transactions', ref_id: String(entry.id),
      data: { asset: w.asset, amount: body.data.amount, to_address: body.data.to_address },
    });
    return entry;
  });
  if (out === 'missing') return reply.code(404).send({ error: 'no such wallet' });
  if (out === 'insufficient') return reply.code(400).send({ error: 'amount exceeds wallet balance' });
  return reply.code(201).send(out);
});

app.post('/wallet-transactions/:id/decide', { preHandler: auth('kyc:review') }, async (req: any, reply) => {
  const body = z.object({ status: z.enum(['confirmed', 'rejected']) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE wallet_transactions SET status = $2, decided_by = $3,
              tx_ref = coalesce(tx_ref, $4)
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, body.data.status, req.principal.sub, `DEMO-TX-${randomUUID().slice(0, 16)}`]);
    const t = rows[0];
    if (!t) return null;
    // The withdrawal already left on request, so only a rejection moves the balance back.
    const reversed = t.kind === 'withdrawal' && body.data.status === 'rejected';
    if (reversed) {
      await c.query('UPDATE wallets SET balance = balance - $2 WHERE id = $1', [t.wallet_id, t.amount]);
    }
    const { rows: [w] } = await c.query<{ asset: string }>('SELECT asset FROM wallets WHERE id = $1', [t.wallet_id]);
    await logActivity(c, {
      client_id: t.client_id, kind: 'withdrawal', actor: req.principal.sub,
      summary: `${Math.abs(Number(t.amount))} ${w!.asset} withdrawal ${body.data.status}`
        + (reversed ? ' — refunded to the wallet' : ''),
      ref_table: 'wallet_transactions', ref_id: String(t.id), data: { reversed },
    });
    return t;
  });
  if (!out) return reply.code(404).send({ error: 'no such pending transaction' });
  return out;
});

// -------------------------------------------------------------- portfolios

/*
 * A portfolio is a labelled pot: money reaches it only by being moved out of a balance
 * the client already holds, so the two always move together in one transaction.
 * ponytail: nothing accrues interest. `indicative_rate` drives the projection shown to
 * the client and nothing else — add a daily accrual job when balances need to grow.
 */

/**
 * Post interest to every open portfolio that has whole days outstanding.
 *
 * Safe to run repeatedly: each portfolio is claimed by moving last_accrued_on to today
 * inside the same transaction that credits it, so a second run the same day finds nothing
 * to do. A run missed for a week pays the week in one compounded step, which the maths
 * tests pin as equal to seven daily runs.
 */
async function accrueInterest(): Promise<{ portfolios: number; posted: number }> {
  const { rows } = await pool.query<{
    id: string; client_id: string; name: string; currency: string;
    balance: number; rate: number; days: number;
  }>(`
    SELECT p.id, p.client_id, p.name, p.currency, p.balance,
           t.indicative_rate AS rate,
           (current_date - p.last_accrued_on) AS days
      FROM portfolios p JOIN portfolio_types t ON t.code = p.type_code
     WHERE p.status = 'open'
       AND t.indicative_rate IS NOT NULL
       AND p.balance > 0
       AND p.last_accrued_on < current_date`);

  let posted = 0;
  for (const p of rows) {
    const interest = accrue({ balance: Number(p.balance), annualRate: Number(p.rate), days: Number(p.days) });
    if (interest <= 0) {
      await pool.query('UPDATE portfolios SET last_accrued_on = current_date WHERE id = $1', [p.id]);
      continue;
    }
    await tx('system', async (c) => {
      // Claim the days and credit them together: if this transaction rolls back, the
      // portfolio stays unclaimed and the next run picks it up again.
      const { rowCount } = await c.query(
        `UPDATE portfolios SET balance = balance + $2, last_accrued_on = current_date
          WHERE id = $1 AND last_accrued_on < current_date`, [p.id, interest]);
      if (!rowCount) return;              // another run got there first
      await c.query(
        `INSERT INTO portfolio_transactions (portfolio_id, client_id, kind, amount, note)
         VALUES ($1,$2,'interest',$3,$4)`,
        [p.id, p.client_id, interest, `${p.days} day(s) at ${(Number(p.rate) * 100).toFixed(2)}%`]);
      await notifyClientOf(c, {
        client_id: p.client_id, kind: 'interest',
        title: `Interest on ${p.name}`,
        body: `${interest} ${p.currency} credited for ${p.days} day(s).`,
        ref_table: 'portfolios', ref_id: p.id,
      });
      await logActivity(c, {
        client_id: p.client_id, kind: 'interest', actor: 'system',
        summary: `Interest of ${interest} ${p.currency} on ${p.name}`,
        ref_table: 'portfolios', ref_id: p.id,
        data: { days: Number(p.days), rate: Number(p.rate), interest },
      });
      posted++;
    });
  }
  flushNotifications();
  return { portfolios: rows.length, posted };
}

app.get('/portfolio-types', { preHandler: auth() }, async () =>
  (await pool.query('SELECT * FROM portfolio_types ORDER BY sort_order')).rows);

/**
 * Run the accrual now. Exists so operations can re-run after an incident and so the day
 * rollover can be exercised without waiting for one — it is idempotent, so an accidental
 * double-click costs nothing.
 */
app.post('/admin/accrue', { preHandler: auth('admin') }, async () => accrueInterest());

/** Portfolios belong to a client; staff with crm:read may look at someone else's. */
async function portfolioScope(req: any, reply: any) {
  if (!(await authenticate(req, reply))) return null;
  const q = z.object({ client_id: z.string().uuid().optional() }).parse(req.query ?? {});
  if (req.principal.kind === 'client') return req.principal.sub as string;
  if (!can(req.principal.role, 'crm:read')) {
    reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return q.client_id ?? null;
}

app.get('/portfolios', async (req: any, reply) => {
  const clientId = await portfolioScope(req, reply);
  if (clientId === null) return reply.sent ? undefined : [];
  const { rows } = await pool.query(
    `SELECT p.*, t.name AS type_name, t.indicative_rate
       FROM portfolios p JOIN portfolio_types t ON t.code = p.type_code
      WHERE p.client_id = $1 ORDER BY p.status, p.created_at`, [clientId]);

  return Promise.all(rows.map(async (p) => {
    const rate = await rateToUsd(p.currency);
    const years = p.target_date
      ? (new Date(p.target_date).getTime() - Date.now()) / (365.25 * 86400_000) : 0;
    return {
      ...p,
      usd_value: rate === null ? null : round8(Number(p.balance) * rate),
      progress: progress(Number(p.balance), p.target_amount === null ? null : Number(p.target_amount)),
      projected: project({
        balance: Number(p.balance),
        annualRate: p.indicative_rate === null ? null : Number(p.indicative_rate),
        years,
      }),
    };
  }));
});

const portfolioBody = z.object({
  type_code: z.string().min(2).max(30),
  name: z.string().min(1).max(80),
  currency: z.string().min(2).max(10).default('USD'),
  target_amount: z.number().positive().finite().optional(),
  target_date: z.coerce.date().optional(),
});

app.post('/portfolios', { preHandler: trader }, async (req: any, reply) => {
  const body = portfolioBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  if (!(await currencies()).has(b.currency)) return reply.code(404).send({ error: 'unknown currency' });
  const { rowCount } = await pool.query('SELECT 1 FROM portfolio_types WHERE code = $1', [b.type_code]);
  if (!rowCount) return reply.code(404).send({ error: 'unknown portfolio type' });

  try {
    return await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO portfolios (client_id, type_code, name, currency, target_amount, target_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.principal.sub, b.type_code, b.name, b.currency,
         b.target_amount ?? null, b.target_date ?? null]);
      await logActivity(c, {
        client_id: req.principal.sub, kind: 'portfolio', actor: req.principal.sub,
        summary: `Opened ${b.name} (${b.type_code.replace(/_/g, ' ')})`,
        ref_table: 'portfolios', ref_id: rows[0].id,
        data: { type: b.type_code, currency: b.currency, target: b.target_amount ?? null },
      });
      return reply.code(201).send(rows[0]);
    });
  } catch (err: any) {
    // One name per client, so the list stays legible.
    if (err?.code === '23505') return reply.code(409).send({ error: 'you already have a portfolio with that name' });
    throw err;
  }
});

const moveBody = z.object({ amount: z.number().positive().finite(), note: z.string().max(200).optional() });

/**
 * Move money between a balance and a pot. `into` decides the direction; either way both
 * sides move in one transaction, so money is never in neither place or in both.
 */
async function movePortfolio(req: any, reply: any, into: boolean) {
  const body = moveBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { amount, note } = body.data;

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [p] } = await c.query<{ id: string; currency: string; balance: number; name: string; status: string }>(
      'SELECT id, currency, balance, name, status FROM portfolios WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [req.params.id, req.principal.sub]);
    if (!p) return 'missing' as const;
    if (p.status !== 'open') return 'closed' as const;

    const ccy = (await currencies()).get(p.currency)!;
    // Opened on demand when money is coming back out, so a withdrawal always has a home.
    const holding = await lockHolding(c, req.principal.sub, p.currency, ccy.kind, !into);
    if (!holding) return 'no-holding' as const;
    if (into && Number(holding.balance) < amount) return 'insufficient-balance' as const;
    if (!into && Number(p.balance) < amount) return 'insufficient-portfolio' as const;

    await moveBalance(c, holding, into ? -amount : amount);
    await c.query('UPDATE portfolios SET balance = balance + $2 WHERE id = $1',
      [p.id, into ? amount : -amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO portfolio_transactions (portfolio_id, client_id, kind, amount, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [p.id, req.principal.sub, into ? 'contribution' : 'withdrawal', into ? amount : -amount, note ?? null]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'portfolio', actor: req.principal.sub,
      summary: into
        ? `Paid ${amount} ${p.currency} into ${p.name}`
        : `Took ${amount} ${p.currency} out of ${p.name}`,
      ref_table: 'portfolio_transactions', ref_id: String(entry.id),
      data: { portfolio: p.name, amount, currency: p.currency },
    });
    return entry;
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such portfolio' });
  if (out === 'closed') return reply.code(409).send({ error: 'that portfolio is closed' });
  if (out === 'no-holding') return reply.code(400).send({ error: 'you hold no balance in that currency' });
  if (out === 'insufficient-balance') return reply.code(400).send({ error: 'amount exceeds your balance' });
  if (out === 'insufficient-portfolio') return reply.code(400).send({ error: 'amount exceeds the portfolio balance' });
  return reply.code(201).send(out);
}

app.post('/portfolios/:id/contribute', { preHandler: trader }, (req, reply) => movePortfolio(req, reply, true));
app.post('/portfolios/:id/withdraw', { preHandler: trader }, (req, reply) => movePortfolio(req, reply, false));

app.patch('/portfolios/:id', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({
    name: z.string().min(1).max(80).optional(),
    target_amount: z.number().positive().finite().nullable().optional(),
    target_date: z.coerce.date().nullable().optional(),
    status: z.enum(['open', 'closed']).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const entries = Object.entries(body.data);
  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [p] } = await c.query<{ balance: number }>(
      'SELECT balance FROM portfolios WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [req.params.id, req.principal.sub]);
    if (!p) return 'missing' as const;
    // Closing a pot with money still in it would strand it: take it out first.
    if (body.data.status === 'closed' && Number(p.balance) > 0) return 'not-empty' as const;

    const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await c.query(
      `UPDATE portfolios SET ${set} WHERE id = $1 RETURNING *`,
      [req.params.id, ...entries.map(([, v]) => v)]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'portfolio', actor: req.principal.sub,
      summary: body.data.status === 'closed' ? `Closed ${rows[0].name}` : `Updated ${rows[0].name}`,
      ref_table: 'portfolios', ref_id: rows[0].id, data: body.data,
    });
    return rows[0];
  });
  if (out === 'missing') return reply.code(404).send({ error: 'no such portfolio' });
  if (out === 'not-empty') return reply.code(409).send({ error: 'take the balance out before closing' });
  return out;
});

app.get('/portfolios/:id/transactions', { preHandler: trader }, async (req: any) =>
  (await pool.query(
    `SELECT t.* FROM portfolio_transactions t JOIN portfolios p ON p.id = t.portfolio_id
      WHERE t.portfolio_id = $1 AND p.client_id = $2 ORDER BY t.at DESC LIMIT 200`,
    [req.params.id, req.principal.sub])).rows);

// --------------------------------------------------------------- dashboard

/** The whole business in one response: CRM, trading and compliance side by side. */
app.get('/admin/overview', { preHandler: auth('admin') }, async () => {
  const q = async <T extends pg.QueryResultRow>(sql: string) => (await pool.query<T>(sql)).rows;

  const [clients, pipeline, kyc, flags, tasks, trading, positions, cash] = await Promise.all([
    q<{ total: number; new_7d: number; dormant: number }>(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_7d,
             count(*) FILTER (WHERE stage_id = 6) AS dormant
        FROM clients`),
    q<{ stage: string; sort_order: number; clients: number }>(`
      SELECT s.name AS stage, s.sort_order, count(c.id) AS clients
        FROM pipeline_stages s LEFT JOIN clients c ON c.stage_id = s.id
       GROUP BY s.name, s.sort_order ORDER BY s.sort_order`),
    q<{ pending_docs: number; clients_pending: number; clients_approved: number }>(`
      SELECT (SELECT count(*) FROM kyc_documents WHERE status = 'pending')      AS pending_docs,
             (SELECT count(*) FROM clients WHERE kyc_status = 'pending')        AS clients_pending,
             (SELECT count(*) FROM clients WHERE kyc_status = 'approved')       AS clients_approved`),
    q<{ severity: string; open: number }>(`
      SELECT severity, count(*) AS open FROM flags WHERE status = 'open'
       GROUP BY severity ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`),
    q<{ open: number; overdue: number }>(`
      SELECT count(*) AS open,
             count(*) FILTER (WHERE due_at < now()) AS overdue
        FROM tasks WHERE status = 'open'`),
    q<{ fills_today: number; volume_today: number; volume_7d: number; working_orders: number }>(`
      SELECT count(*) FILTER (WHERE f.filled_at >= current_date)                       AS fills_today,
             coalesce(sum(f.qty * f.price) FILTER (WHERE f.filled_at >= current_date), 0) AS volume_today,
             coalesce(sum(f.qty * f.price) FILTER (WHERE f.filled_at >= current_date - interval '7 days'), 0) AS volume_7d,
             (SELECT count(*) FROM orders WHERE status IN ('new','working'))           AS working_orders
        FROM fills f`),
    q<{ symbol: string; qty: number; avg_price: number }>(
      'SELECT symbol, qty, avg_price FROM positions'),
    q<{ pending_withdrawals: number; pending_amount: number; net_30d: number; balances: number }>(`
      SELECT count(*) FILTER (WHERE kind = 'withdrawal' AND status = 'pending')            AS pending_withdrawals,
             coalesce(-sum(amount) FILTER (WHERE kind = 'withdrawal' AND status = 'pending'), 0) AS pending_amount,
             coalesce(sum(amount) FILTER (WHERE status IN ('approved','settled')
                       AND created_at >= now() - interval '30 days'), 0)                   AS net_30d,
             (SELECT coalesce(sum(balance), 0) FROM trading_accounts)                      AS balances
        FROM cash_transactions`),
  ]);

  // Client exposure is only knowable with live prices, so it is computed here, not in SQL.
  const exposure = positions.reduce((sum, p) => sum + Math.abs(p.qty) * spot(p.symbol), 0);
  const openPnl = positions.reduce((sum, p) => sum + unrealized(p, spot(p.symbol)), 0);

  return {
    clients: clients[0],
    pipeline,
    kyc: kyc[0],
    flags: { by_severity: flags, open: flags.reduce((n, f) => n + Number(f.open), 0) },
    tasks: tasks[0],
    trading: {
      ...trading[0],
      open_positions: positions.length,
      exposure: round8(exposure),
      open_pnl: round8(openPnl),
    },
    cash: cash[0],
  };
});

/** The firm-wide timeline: the same feed as a client record, across every client. */
app.get('/activity', { preHandler: auth('crm:read') }, async (req) => {
  const q = z.object({
    kind: z.string().max(40).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT a.id, a.at, a.kind, a.actor, a.summary, a.client_id, c.name AS client_name
       FROM activity_log a JOIN clients c ON c.id = a.client_id
      WHERE ($1::text IS NULL OR a.kind = $1)
      ORDER BY a.at DESC, a.id DESC LIMIT $2`, [q.kind ?? null, q.limit]);
  return rows;
});

/**
 * What the system is configured to do. Read-only: thresholds are code constants, not
 * settings — see the note in the admin screen.
 */
app.get('/admin/config', { preHandler: auth('admin') }, async () => ({
  live_trading_enabled: false,
  demo_starting_balance: DEMO_STARTING_BALANCE,
  flag_rules: RULES,
  required_kyc_documents: REQUIRED_KYC,
  accepted_uploads: [...ALLOWED_UPLOAD.keys()],
  instruments: (await pool.query('SELECT symbol, display_name, tick_size, lot_size FROM instruments ORDER BY symbol')).rows,
  pipeline_stages: (await pool.query('SELECT name, sort_order, is_terminal FROM pipeline_stages ORDER BY sort_order')).rows,
}));

// ------------------------------------------------------------------- audit

app.get('/audit', { preHandler: auth('audit:read') }, async (req) => {
  const q = z.object({
    tbl: z.string().max(40).optional(),
    row_id: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM audit_log
      WHERE ($1::text IS NULL OR tbl = $1) AND ($2::text IS NULL OR row_id = $2)
      ORDER BY at DESC, id DESC LIMIT $3`,
    [q.tbl ?? null, q.row_id ?? null, q.limit]);
  return rows;
});

if (process.argv[1]?.endsWith('server.ts')) {
  app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });

  // Settlement must not depend on anyone being connected — see startTicker.
  startTicker().catch((err: unknown) => app.log.error({ err }, 'could not start the ticker'));

  // Interest is posted per whole day, so an hourly sweep is ample: it catches the day
  // rollover wherever the server happens to be, and picks up anything a restart missed.
  // ponytail: an in-process timer, so several API instances would each run it — harmless
  // because the accrual is idempotent, but move it to a single scheduled job at that point.
  const sweep = () => accrueInterest()
    .then(({ posted }) => posted && app.log.info({ posted }, 'interest accrued'))
    .catch((err: unknown) => app.log.error({ err }, 'interest accrual failed'));
  setTimeout(sweep, 5_000).unref();          // once shortly after boot
  setInterval(sweep, 3600_000).unref();
}

export { app, pool, tx };
