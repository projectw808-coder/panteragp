import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { assertSecretConfigured, can, hashPassword, signToken, verifyPassword, verifyToken, type Perm, type Principal, type Role } from './auth.ts';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';

import { challengeMessage, checksumAddress, isAddress, recoverSigner } from './wallet-link.ts';
import {
  mailConfig, render as renderMail, send as sendMail, verify as verifyMail,
} from './mail.ts';
import { commission, executionPrice, MAX_BPS, termsOf } from './terms.ts';
import { candles, quote, spot, TIMEFRAMES, type Timeframe } from './market.ts';
import { evaluate, DEFAULT_WIN_RATE, pairTrade, sizeFor, stats as botStats, steer, STRATEGIES, type Direction, type StrategyKind } from './autotrader.ts';
import {
  accrue, applyFill, convert, isTriggered, progress, project, round8, trailStop, unrealized,
  type OrderType, type Position, type Side,
} from './trading.ts';
import { RULES, subscriptionFlags, toCSV, volumeFlags, withdrawalFlags, type Flag } from './compliance.ts';
import {
  accruableDays, allocation, effectiveStatus, group as ipoGroup, settlement, type Status as IpoStatus,
} from './ipo.ts';
import { bearerMatches, parseDelivery, signatureMatches, SLUG, type Article, type Delivery } from './articles.ts';
import { articlePage, indexPage, sitemap, type ArticleCard } from './blog-page.ts';

declare module 'fastify' {
  interface FastifyRequest { principal: Principal }
}

// ponytail: numeric -> float. Fine for a demo account; real money wants minor units.
pg.types.setTypeParser(1700, Number);
// bigint counts and bigserial ids: JSON should carry numbers, not quoted strings.
pg.types.setTypeParser(20, Number);
// date -> the string Postgres sent, not a Date. A date has no time and no zone, and the
// default parser gives it both: a birth date of 1988-04-02 becomes local midnight, which
// serialises to the 1st in UTC and shows the client a day they were not born on.
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  // Managed Postgres reached over the public internet needs TLS; the same database over a
  // provider's private network does not, and neither does the local dev one. Off unless
  // asked for, so nothing silently downgrades. Railway: prefer its internal host and
  // leave this unset.
  ...(process.env.DATABASE_SSL === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
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

/**
 * The browser always calls the API under /api — in development Vite proxies that away, and
 * in production this strips it, so one origin serves both the app and the API and the
 * front end needs no build-time switch. rewriteUrl runs before routing, which an onRequest
 * hook does not, and it also catches the WebSocket upgrade at /api/feed.
 */
type ApiMarked = { cameInUnderApi?: boolean };

const app = Fastify({
  logger: true,
  rewriteUrl: (req) => {
    const url = req.url ?? '/';
    // Record that this arrived under /api before the prefix is stripped. Nothing
    // downstream can tell afterwards, and the 404 handler has to know which of the two
    // things this origin serves the caller was asking for.
    if (url === '/api' || url.startsWith('/api/')) (req as ApiMarked).cameInUnderApi = true;
    return url === '/api' ? '/' : url.startsWith('/api/') ? url.slice(4) : url;
  },
});

// Without this, an error on an idle client (db restart, dropped connection) is an
// unhandled 'error' event and takes the process down.
pool.on('error', (err) => app.log.error({ err }, 'idle pg client error'));

/**
 * A schema that rejects is the caller's mistake, not ours.
 *
 * Route handlers that validate a body use safeParse and answer 400 themselves. Query
 * strings are parsed with .parse, which throws — and an uncaught throw is a 500, so
 * ?kyc_status=nonsense came back as a server error and said nothing useful. Sixteen
 * routes had that shape, which is why this is here rather than in each of them.
 */
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.flatten() });
  app.log.error({ err }, 'unhandled');
  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  return reply.code(status).send(status === 500
    ? { error: 'Internal Server Error' }
    : { error: err.message });
});

// Plenty of clients set content-type: application/json on a bodyless DELETE. Fastify
// rejects that with a 400 by default; treat an empty body as no body.
// The bytes are also kept as sent, because a signed webhook is verified over exactly those
// and a re-serialised body would never match. On the raw request, beside the /api marker.
type RawBodied = { rawBody?: string };
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    (req.raw as RawBodied).rawBody = body as string;
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
  // A token outlives the account it names, so the row is the authority, not the claim.
  // Deactivating a staff member has to bite now rather than whenever their token expires,
  // or they keep reading every client record and the audit log for hours after being
  // switched off. This runs *before* the permission check so the role in the database
  // decides in both directions: a demotion is enforced, and a promotion works without
  // making the person sign in again.
  if (req.principal.kind === 'staff') {
    const { rows: [row] } = await pool.query<{ role: Role }>(
      'SELECT role FROM staff WHERE id = $1 AND active', [req.principal.sub]);
    if (!row) {
      reply.code(401).send({ error: 'unauthenticated' });
      return false;
    }
    req.principal.role = row.role;
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
  if (!ok || (as === 'staff' && !row.active)) {
    if (ok) return reply.code(401).send({ error: 'This staff account has been switched off. Ask an admin.' });
    // The commonest wrong sign-in is the right password under the wrong tab. Say so — but
    // only when the password is right for the other kind, so this reveals nothing a
    // successful sign-in would not.
    const other = as === 'staff' ? 'clients' : 'staff';
    const { rows: [alt] } = await pool.query(
      `SELECT password_hash FROM ${other} WHERE email = $1`, [email.toLowerCase()]);
    if (alt && await verifyPassword(password, alt.password_hash)) {
      return reply.code(401).send({
        error: as === 'staff'
          ? 'That is a trader account. Switch to Trader and sign in again.'
          : 'That is a staff account. Switch to Staff and sign in again.',
      });
    }
    return reply.code(401).send({ error: 'Wrong email or password.' });
  }

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

  try {
  return await tx(actor, async (c) => {
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
    delete rows[0].unsubscribe_token;
    return rows[0];
  });
  } catch (err: any) {
    // An address already on file is something the caller can act on — find the record, or
    // use a different address. As an unhandled error it surfaced as a 500, which says the
    // application is broken when the truth is that this client already exists.
    if (err?.code === '23505') {
      return reply.code(409).send({ error: 'a client with that email address already exists' });
    }
    throw err;
  }
});

/**
 * Public self-registration. Unlike POST /clients this takes no token, so it is deliberately
 * narrow: it accepts a name, an email and a password and nothing else. Tier, owner, country
 * and every other CRM field stay at their defaults, because an anonymous caller must not be
 * able to set them — self-assigning a tier or an account manager is not theirs to do.
 *
 * ponytail: no rate limit and no email confirmation, so the address is unverified and
 * someone can create accounts in a loop. Fine for a demo; before real users, add both —
 * a limiter in front and a confirmation link before the account can trade.
 */
app.post('/auth/register', async (req, reply) => {
  const body = z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().max(320),
    password: z.string().min(8).max(200),
    // Optional: the desk asks for it eventually, and somebody who gives it at sign-up
    // should not be asked again. Not required — a missing phone is no reason to refuse
    // an account, and the profile form takes it later. An empty string is a missing
    // phone, not a bad one: rejecting it would fail a registration over a blank box.
    phone: z.string().trim().max(40).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  const email = b.email.toLowerCase();

  try {
    return await tx('self-registration', async (c) => {
      const { rows } = await c.query(
        `INSERT INTO clients (email, name, password_hash, phone) VALUES ($1,$2,$3,$4) RETURNING id, email, name`,
        [email, b.name, await hashPassword(b.password), b.phone || null]);
      await logActivity(c, {
        client_id: rows[0].id, kind: 'note', actor: rows[0].id,
        summary: 'Account created by the client',
      });
      // Somebody who signed themselves up has nobody looking after them yet, which is the
      // whole reason to say so: an account nobody knows arrived is an account nobody picks up.
      await notifyStaff(c, { roles: ['sales', 'admin'] }, {
        kind: 'client.registered',
        title: `New account: ${rows[0].name}`,
        body: `${rows[0].email} — registered themselves, unassigned and unverified.`,
        ref_table: 'clients', ref_id: rows[0].id,
      });
      // Signed straight in: making someone register and then immediately log in again is
      // friction with no security benefit, since they just proved the password.
      const token = await signToken({ sub: rows[0].id, kind: 'client', role: 'trader' });
      return reply.code(201).send({ token, client: rows[0] });
    });
  } catch (err: any) {
    // Deliberately the same wording as a validation failure would give: telling an
    // anonymous caller "that email is registered" turns this into an account checker.
    if (err?.code === '23505') return reply.code(409).send({ error: 'could not create that account' });
    throw err;
  }
});

app.get('/clients', { preHandler: auth('crm:read') }, async (req) => {
  const q = z.object({
    stage_id: z.coerce.number().int().optional(),
    owner_staff_id: z.string().uuid().optional(),
    kyc_status: z.enum(['none', 'pending', 'approved', 'rejected', 'expired']).optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query);
  // ponytail: ILIKE '%x%' is a seq scan; add a pg_trgm index when the client list gets long.
  const { rows } = await pool.query(
    `SELECT c.id, c.email, c.name, c.tier, c.kyc_status, c.risk_profile, c.created_at,
            c.stage_id, s.name AS stage, c.owner_staff_id, o.name AS owner_name,
            -- Whether they can sign in at all, never the hash itself. A client created
            -- from the CRM has no password until someone sets one, and that state was
            -- invisible here: the row looked identical to an account that works.
            c.password_hash IS NOT NULL AS has_login,
            -- So a screen choosing who to email can say who has asked not to be.
            c.email_opt_out
       FROM clients c
       JOIN pipeline_stages s ON s.id = c.stage_id
       LEFT JOIN staff o ON o.id = c.owner_staff_id
      WHERE ($1::smallint IS NULL OR c.stage_id = $1)
        AND ($2::uuid IS NULL OR c.owner_staff_id = $2)
        AND ($3::text IS NULL OR c.name ILIKE '%'||$3||'%' OR c.email ILIKE '%'||$3||'%')
        AND ($5::text IS NULL OR c.kyc_status = $5)
      ORDER BY c.created_at DESC LIMIT $4`,
    [q.stage_id ?? null, q.owner_staff_id ?? null, q.q || null, q.limit, q.kyc_status ?? null],
  );
  return rows;
});

app.get('/pipeline-stages', { preHandler: auth('crm:read') }, async () =>
  (await pool.query('SELECT * FROM pipeline_stages ORDER BY sort_order')).rows);

app.get('/staff', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({ include_inactive: z.coerce.boolean().default(false) }).parse(req.query ?? {});
  return (await pool.query(
    `SELECT id, name, email, role, active, created_at FROM staff
      WHERE (active OR $1::bool) ORDER BY active DESC, name`, [q.include_inactive])).rows;
});

const staffBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(['sales', 'support', 'compliance', 'admin']),
  password: z.string().min(12).max(200),
});

/** Creating a colleague hands out access to client data, so it is admin-only and audited. */
app.post('/staff', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = staffBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  try {
    const created = await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO staff (name, email, role, password_hash) VALUES ($1,$2,$3,$4)
         RETURNING id, name, email, role, active, created_at`,
        [b.name, b.email.toLowerCase(), b.role, await hashPassword(b.password)]);
      return rows[0];
    });
    return reply.code(201).send(created);
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'that email is already a staff account' });
    throw err;
  }
});

/**
 * Change a colleague's role, or switch them off. Deactivating takes effect on their very
 * next request — authenticate() reads `active` from the row, not from their token.
 */
app.patch('/staff/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = z.object({
    name: z.string().min(1).max(200).optional(),
    role: z.enum(['sales', 'support', 'compliance', 'admin']).optional(),
    active: z.boolean().optional(),
  }).refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  // Locking yourself out, or demoting the last admin, leaves nobody able to put it right.
  if (req.params.id === req.principal.sub && (body.data.active === false || body.data.role !== undefined)) {
    return reply.code(409).send({ error: 'change your own role or status from another admin account' });
  }

  const entries = Object.entries(body.data);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE staff SET ${set} WHERE id = $1 RETURNING id, name, email, role, active`,
      [req.params.id, ...entries.map(([, v]) => v)]);
    if (!rows[0]) return reply.code(404).send({ error: 'no such staff member' });
    return rows[0];
  });
});

// ------------------------------------------------------------------ passwords
//
// Two separate powers, deliberately not the same route:
//   - changing your own password, which anyone may do but only by proving the current one;
//   - setting somebody else's, which hands over their account and so is admin-only.
// The audit trigger strips password_hash from both sides of its diff, so these changes are
// recorded as having happened without the hash ever reaching the log.

/** Long enough to be worth having; the ceiling stops a megabyte reaching scrypt. */
const newPassword = z.string().min(8).max(200);

/** Anyone, staff or client, changing their own — current password required. */
app.post('/me/password', { preHandler: auth() }, async (req: any, reply) => {
  const body = z.object({
    current_password: z.string().min(1).max(200),
    new_password: newPassword,
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { current_password, new_password } = body.data;

  const table = req.principal.kind === 'staff' ? 'staff' : 'clients';
  const { rows: [row] } = await pool.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM ${table} WHERE id = $1`, [req.principal.sub]);
  if (!row) return reply.code(401).send({ error: 'unauthenticated' });
  if (!(await verifyPassword(current_password, row.password_hash))) {
    return reply.code(403).send({ error: 'current password is wrong' });
  }
  if (await verifyPassword(new_password, row.password_hash)) {
    return reply.code(400).send({ error: 'the new password is the same as the current one' });
  }

  const hash = await hashPassword(new_password);
  await tx(req.principal.sub, async (c) => {
    await c.query(`UPDATE ${table} SET password_hash = $2 WHERE id = $1`, [req.principal.sub, hash]);
    if (req.principal.kind === 'client') {
      await logActivity(c, {
        client_id: req.principal.sub, kind: 'security', actor: req.principal.sub,
        summary: 'Client changed their own password',
      });
    }
  });
  // ponytail: existing tokens stay valid until they expire. Revoking them needs a token
  // version column and a check per request — worth it when sessions are longer than 8h.
  return { ok: true };
});

/** An admin setting a client's password. The client is told, because they must be. */
app.post('/clients/:id/password', { preHandler: auth('password:reset') }, async (req: any, reply) => {
  const body = z.object({ new_password: newPassword }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const hash = await hashPassword(body.data.new_password);
  // The miss is reported after the transaction rather than inside it: replying from within
  // the callback returns normally, so tx() commits a transaction the route is calling a
  // failure. Nothing is written on that path today, but the next write added above this
  // line would be committed by a 404. Same shape as the wallet unlink below.
  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      'UPDATE clients SET password_hash = $2 WHERE id = $1 RETURNING id', [req.params.id, hash]);
    if (!rows[0]) return null;
    await logActivity(c, {
      client_id: req.params.id, kind: 'security', actor: req.principal.sub,
      summary: 'Password reset by staff',
    });
    // Silent credential changes are how account takeovers stay unnoticed.
    await notifyClientOf(c, {
      client_id: req.params.id, kind: 'security', title: 'Your password was reset',
      body: 'A member of staff set a new password on your account. If you were not expecting this, contact support.',
    });
    return rows[0];
  });
  if (!out) return reply.code(404).send({ error: 'no such client' });
  return { ok: true };
});

/** An admin setting a colleague's password. Not their own — that route needs the current one. */
app.post('/staff/:id/password', { preHandler: auth('password:reset') }, async (req: any, reply) => {
  const body = z.object({ new_password: newPassword }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (req.params.id === req.principal.sub) {
    return reply.code(409).send({ error: 'change your own password from Settings, with your current one' });
  }

  const hash = await hashPassword(body.data.new_password);
  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      'UPDATE staff SET password_hash = $2 WHERE id = $1 RETURNING id', [req.params.id, hash]);
    if (!rows[0]) return reply.code(404).send({ error: 'no such staff member' });
    return { ok: true };
  });
});

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
  // Derived before the hash is dropped, for the same reason the list carries it.
  rows[0].has_login = rows[0].password_hash !== null;
  delete rows[0].password_hash;
    delete rows[0].unsubscribe_token;
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

/**
 * A calendar date, carried as the text it already is.
 *
 * Deliberately not coerced to a Date. Coercion turns 1988-04-02 into an instant at UTC
 * midnight; the driver then sends that instant in the server's own timezone, and casting
 * it to a `date` column anywhere behind UTC lands on the day before. A birth date entered
 * as the 2nd was stored as the 1st on every machine west of Greenwich, silently — the
 * acceptance suite catches it and says as much where it asserts.
 *
 * A date has no timezone, so it is never given one: it reaches Postgres as a string and
 * comes back as one, the DATE parser at the top of this file having been set to leave it
 * alone. Only genuine instants — a task due_at, for example — become Dates.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((v) => {
    // The regex admits 2023-02-30; the round trip is what rejects it.
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, 'not a date on the calendar');

const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(40).optional(),
  country: z.string().length(2).optional(),
  tier: z.string().max(40).optional(),
  // Personal details are clearable: a birth date entered wrong should be removable, not
  // correctable only to another wrong date.
  date_of_birth: isoDate.nullable().optional(),
  address: z.string().max(400).nullable().optional(),
  // What this client pays to trade. Null puts them back on the desk default.
  commission_bps: z.number().min(0).max(MAX_BPS).nullable().optional(),
  spread_bps: z.number().min(0).max(MAX_BPS).nullable().optional(),
  stage_id: z.number().int().min(1).optional(),
  owner_staff_id: z.string().uuid().nullable().optional(),
  risk_profile: z.enum(['low', 'medium', 'high']).nullable().optional(),
  // Overriding KYC skips the document workflow entirely, so it needs kyc:review, not
  // ordinary CRM write access — see the check below.
  kyc_status: z.enum(['none', 'pending', 'approved', 'rejected', 'expired']).optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');

app.patch('/clients/:id', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = patchBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (body.data.kyc_status !== undefined && !can(req.principal.role, 'kyc:review')) {
    return reply.code(403).send({ error: 'changing KYC status needs kyc:review' });
  }
  // Trading terms are the price of the service, so they move with the same permission as
  // every other route where staff change what a client's money does.
  const termsTouched = body.data.commission_bps !== undefined || body.data.spread_bps !== undefined;
  if (termsTouched && !can(req.principal.role, 'funds:credit')) {
    return reply.code(403).send({ error: 'changing trading terms needs funds:credit' });
  }
  if (body.data.email) body.data.email = body.data.email.toLowerCase();
  const entries = Object.entries(body.data);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');

  try {
    return await tx(req.principal.sub, async (c) => {
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
      // An override is worth its own timeline entry: it is the one path to "approved"
      // that no reviewed document stands behind.
      if (body.data.kyc_status !== undefined) {
        await logActivity(c, {
          client_id: rows[0].id, kind: 'kyc', actor: req.principal.sub,
          summary: `KYC status set to ${body.data.kyc_status} by hand`,
          data: { override: true, kyc_status: body.data.kyc_status },
        });
      }
      delete rows[0].password_hash;
    delete rows[0].unsubscribe_token;
      return rows[0];
    });
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'another client already uses that email' });
    throw err;
  }
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
    await notifyStaff(c, { staff_id: b.assigned_to }, {
      kind: 'task.assigned',
      title: `Task: ${b.title}`,
      body: b.due_at ? `Due ${b.due_at.toISOString().slice(0, 10)}.` : undefined,
      ref_table: 'clients', ref_id: b.client_id,
    });
    return reply.code(201).send(rows[0]);
  });
});

app.get('/tasks', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({
    // 'all' is what a board asks for: every column at once, rather than one status per
    // request. The default stays 'open' so existing callers see what they always did.
    status: z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled', 'all']).default('open'),
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
      WHERE ($1 = 'all' OR t.status = $1)
        AND ($2::uuid IS NULL OR t.assigned_to = $2)
        AND ($3::uuid IS NULL OR t.client_id = $3)
      ORDER BY t.due_at NULLS LAST, t.created_at`,
    [q.status, assignee, q.client_id ?? null]);
  return rows;
});

app.patch('/tasks/:id', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({
    status: z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      'UPDATE tasks SET status = $2 WHERE id = $1 RETURNING *', [req.params.id, body.data.status]);
    if (!rows[0]) return reply.code(404).send({ error: 'not found' });
    await logActivity(c, {
      client_id: rows[0].client_id, kind: 'task', actor: req.principal.sub,
      summary: `Task ${body.data.status.replace(/_/g, ' ')}: ${rows[0].title}`,
      ref_table: 'tasks', ref_id: String(rows[0].id),
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

    // What this client pays to trade. Read inside the transaction so a term changed a
    // moment ago applies to this fill rather than to the one after it.
    // ponytail: one small lookup per fill. Cache it if fills ever outpace the database.
    const { rows: [terms] } = await c.query<{ commission_bps: number | null; spread_bps: number | null }>(
      'SELECT commission_bps, spread_bps FROM clients WHERE id = $1', [o.client_id]);
    const t = termsOf(terms ?? null);

    // The price the client actually gets, and the commission on it. The spread moves
    // against them by side, so both of these are costs whichever way the trade goes.
    const filled = executionPrice(price, o.side, t);
    const fee = commission(o.qty, filled, t);

    await c.query('INSERT INTO fills (order_id, qty, price, fee) VALUES ($1,$2,$3,$4)',
      [o.id, o.qty, filled, fee]);
    await c.query(`UPDATE orders SET status = 'filled' WHERE id = $1`, [o.id]);

    const { rows: [held] } = await c.query<Position>(
      'SELECT qty, avg_price FROM positions WHERE account_id = $1 AND symbol = $2 FOR UPDATE',
      [o.account_id, o.symbol]);
    const { position, realized } = applyFill(held ?? null, { side: o.side, qty: o.qty, price: filled });

    if (position.qty === 0) {
      await c.query('DELETE FROM positions WHERE account_id = $1 AND symbol = $2', [o.account_id, o.symbol]);
    } else {
      await c.query(
        `INSERT INTO positions (account_id, symbol, qty, avg_price) VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, symbol) DO UPDATE SET qty = $3, avg_price = $4, updated_at = now()`,
        [o.account_id, o.symbol, position.qty, position.avg_price]);
    }
    // Commission comes off whether or not anything was realised: it is the price of the
    // trade, not a share of its result.
    if (realized !== 0 || fee !== 0) {
      await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1',
        [o.account_id, realized - fee]);
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
      summary: `Filled ${o.side} ${o.qty} ${o.symbol} at ${filled}`
        + (fee ? ` — commission ${fee}` : ''),
      ref_table: 'orders', ref_id: o.id,
      data: {
        price: filled, mid: price, fee, qty: o.qty, side: o.side, symbol: o.symbol,
        realized, type: o.type, terms: t,
      },
    });
    if (viaEngine) {
      await notifyClientOf(c, {
        client_id: o.client_id, kind: 'order.filled',
        title: `${o.side === 'buy' ? 'Bought' : 'Sold'} ${o.qty} ${o.symbol}`,
        body: `Your ${o.type.replace('_', ' ')} order filled at ${filled}.`
          + (fee ? ` Commission ${fee}.` : ''),
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

/**
 * A new account opens empty. Funding is something the desk does deliberately, through the
 * audited credit route, so a client's holdings always trace back to a decision somebody
 * made rather than to a number the system invented on their first login.
 */
const DEMO_STARTING_BALANCE = 0;

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

/**
 * A client reading and correcting their own details.
 *
 * The fields are the subset of the CRM record that belongs to the person rather than to
 * the desk: their name, how to reach them, where they live, when they were born. Tier,
 * stage, owner, risk and KYC status are the desk's assessment of them and are not theirs
 * to set — that is why this has its own schema instead of reusing the staff one.
 *
 * Email is not here either. It is the login, so changing it is an account change rather
 * than a detail change: it needs the current password and a confirmed address, neither of
 * which exists yet. Until then it goes through the desk, which the UI says plainly.
 */
const profileBody = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().max(40).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  date_of_birth: isoDate.nullable().optional(),
  address: z.string().max(400).nullable().optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');

app.get('/me/profile', { preHandler: trader }, async (req: any) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, phone, country, date_of_birth, address, tier, kyc_status, created_at,
            commission_bps, spread_bps, auto_trader, avatar_key
       FROM clients WHERE id = $1`, [req.principal.sub]);
  // Sent resolved rather than raw: a null means "the desk default", and the client should
  // be told the number they are actually charged, not asked to know what null stands for.
  return { ...rows[0], terms: termsOf(rows[0] ?? null) };
});

app.patch('/me/profile', { preHandler: trader }, async (req: any, reply) => {
  const body = profileBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const entries = Object.entries(body.data);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');

  return tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `UPDATE clients SET ${set} WHERE id = $1
        RETURNING id, email, name, phone, country, date_of_birth, address, tier, kyc_status, created_at`,
      [req.principal.sub, ...entries.map(([, v]) => v)]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'note', actor: req.principal.sub,
      summary: `Updated their own details: ${entries.map(([k]) => k.replace(/_/g, ' ')).join(', ')}`,
    });
    return rows[0];
  });
});

// ------------------------------------------------------------ linked wallets

/*
 * A client proving an Ethereum address is theirs.
 *
 * Two steps, and neither of them touches money. The server issues a challenge; the wallet
 * signs it; the server recovers the signer and stores the address if it matches. Signing
 * is free, moves nothing, and cannot be replayed as a transaction — see the EIP-191 prefix
 * in src/wallet-link.ts.
 *
 * The challenge is a short-lived token rather than a row in a nonce table: it already
 * carries who asked and when it expires, and there is nothing left behind to clean up. It
 * is bound to the client, so one person cannot hand their challenge to another to sign.
 */
app.post('/me/wallet/challenge', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({ address: z.string() }).safeParse(req.body);
  if (!body.success || !isAddress(body.data.address)) {
    return reply.code(400).send({ error: 'that is not an Ethereum address' });
  }
  const nonce = await signToken({ sub: req.principal.sub, kind: 'client', role: 'trader' }, '5m');
  return { message: challengeMessage(body.data.address, nonce), nonce };
});

app.post('/me/wallet', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({
    address: z.string(),
    nonce: z.string().max(4000),
    signature: z.string().max(400),
    label: z.string().max(60).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (!isAddress(body.data.address)) return reply.code(400).send({ error: 'that is not an Ethereum address' });

  // The challenge has to be this client's and still live. An expired one is not an error
  // worth explaining away — ask for a new one and sign that.
  try {
    const issued = await verifyToken(body.data.nonce);
    if (issued.sub !== req.principal.sub) throw new Error('not yours');
  } catch {
    return reply.code(400).send({ error: 'that challenge has expired — start again' });
  }

  const address = checksumAddress(body.data.address);
  const signer = recoverSigner(challengeMessage(address, body.data.nonce), body.data.signature);
  if (signer !== address) {
    return reply.code(400).send({ error: 'that signature does not come from this address' });
  }

  try {
    return await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO linked_wallets (client_id, address, label) VALUES ($1,$2,$3)
         RETURNING id, address, label, linked_at`,
        [req.principal.sub, address, body.data.label ?? null]);
      await logActivity(c, {
        client_id: req.principal.sub, kind: 'wallet', actor: req.principal.sub,
        summary: `Linked wallet ${address.slice(0, 6)}…${address.slice(-4)}`,
        ref_table: 'linked_wallets', ref_id: String(rows[0].id),
      });
      return rows[0];
    });
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'that address is already linked to an account' });
    throw err;
  }
});

app.get('/me/wallet', { preHandler: trader }, async (req: any) =>
  (await pool.query(
    'SELECT id, address, label, linked_at FROM linked_wallets WHERE client_id = $1 ORDER BY linked_at',
    [req.principal.sub])).rows);

app.delete('/me/wallet/:id', { preHandler: trader }, async (req: any, reply) => {
  const out = await tx(req.principal.sub, async (c) => {
    // Scoped by client as well as id: unlinking is the one thing here somebody might try
    // to do to an address that is not theirs.
    const { rows } = await c.query(
      'DELETE FROM linked_wallets WHERE id = $1 AND client_id = $2 RETURNING address',
      [req.params.id, req.principal.sub]);
    if (!rows[0]) return null;
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'wallet', actor: req.principal.sub,
      summary: `Unlinked wallet ${rows[0].address.slice(0, 6)}…${rows[0].address.slice(-4)}`,
    });
    return rows[0];
  });
  if (!out) return reply.code(404).send({ error: 'no such wallet' });
  return { unlinked: out.address };
});

/** Staff see what a client has proved, from the client record. */
app.get('/clients/:id/wallets', { preHandler: clientScope }, async (req: any) =>
  (await pool.query(
    'SELECT id, address, label, linked_at FROM linked_wallets WHERE client_id = $1 ORDER BY linked_at',
    [req.params.id])).rows);


/**
 * What this client has earned, day by day.
 *
 * Every point is summed from something that actually happened and was recorded at the
 * time: realised P&L on a fill, interest credited into a pot, a staking reward, and money
 * the client moved in or out. Nothing is modelled and nothing is back-filled — a
 * performance line on a trading platform is read as a statement of fact, so it is built
 * only from rows that exist.
 *
 * What it is deliberately not is an equity curve. Equity on a past day depends on what the
 * open positions were worth on that day, and this platform keeps no price history per
 * client, so drawing one would mean inventing the part nobody recorded. Earnings are the
 * honest series: it answers "has this made me anything", which is the question the chart is
 * there for.
 */
app.get('/me/performance', { preHandler: trader }, async (req: any) => {
  const q = z.object({
    days: z.coerce.number().int().min(1).max(3650).default(30),
  }).parse(req.query);

  // The day spine, so a day on which nothing happened is still a point on the line.
  const { rows: spine } = await pool.query<{ day: string }>(`
    SELECT to_char(d, 'YYYY-MM-DD') AS day
      FROM generate_series(current_date - ($1 || ' days')::interval, current_date, interval '1 day') d
     ORDER BY day`, [q.days - 1]);

  // One row per day, per source, PER CURRENCY — never summed across currencies in SQL,
  // because they cannot be. A pot pays interest in the pot's currency and a stake pays its
  // reward in the asset staked, so the old version added 0.01 BTC to a dollar figure as
  // though it were one cent, and £100 of interest as though it were $100. The same mistake
  // was found and fixed for cash flows (see the note below) and left standing here.
  const { rows: parts } = await pool.query<{
    day: string; bucket: 'earned' | 'in' | 'out'; code: string; amount: string;
  }>(`
    WITH span AS (SELECT (current_date - ($2 || ' days')::interval)::date AS from_day)
    -- Realised P&L, written onto the fill's own timeline entry when it happens, plus any
    -- adjustment the desk has made by hand. Both land in the account demoAccount() returns,
    -- which is the USD one, and both write the same realized field.
    SELECT a.at::date::text AS day, 'earned' AS bucket, 'USD' AS code,
           sum((a.data->>'realized')::numeric) AS amount
      FROM activity_log a, span s
     WHERE a.client_id = $1 AND a.kind IN ('order.filled', 'pnl')
       AND a.at >= s.from_day AND (a.data->>'realized') IS NOT NULL
     GROUP BY 1, 2, 3
    UNION ALL
    -- Interest, in the currency of the pot that paid it.
    SELECT t.at::date::text, 'earned', p.currency, sum(t.amount)
      FROM portfolio_transactions t
      JOIN portfolios p ON p.id = t.portfolio_id, span s
     WHERE t.client_id = $1 AND t.kind = 'interest' AND t.at >= s.from_day
     GROUP BY 1, 2, 3
    UNION ALL
    -- Staking rewards, in the asset staked. The accrual records it alongside the amount.
    SELECT a.at::date::text, 'earned', coalesce(a.data->>'asset', '?'),
           sum((a.data->>'reward')::numeric)
      FROM activity_log a, span s
     WHERE a.client_id = $1 AND a.kind = 'stake' AND a.actor = 'system'
       AND a.at >= s.from_day AND (a.data->>'reward') IS NOT NULL
     GROUP BY 1, 2, 3
    UNION ALL
    -- Money in and out, in the currency of the account it moved through.
    SELECT c.created_at::date::text,
           CASE WHEN c.amount > 0 THEN 'in' ELSE 'out' END,
           ta.currency, sum(c.amount)
      FROM cash_transactions c
      JOIN trading_accounts ta ON ta.id = c.account_id, span s
     WHERE c.client_id = $1 AND c.status IN ('approved','settled')
       AND c.created_at >= s.from_day
     GROUP BY 1, 2, 3`, [req.principal.sub, q.days - 1]);

  // Priced once per currency rather than once per row. Converted at today's rate, which is
  // the only rate this platform has: no FX or spot history is kept, so a reward earned in
  // BTC three weeks ago is valued at what that BTC is worth now. Approximate, and named as
  // such, rather than silently wrong.
  const rate = new Map<string, number | null>();
  for (const code of new Set(parts.map((p) => p.code))) {
    rate.set(code, await rateToUsd(code));
  }
  // An unpriced currency is dropped from the figure and named, never counted as zero.
  const unpricedFlow = new Set<string>();

  const byDay = new Map<string, { earned: number; in: number; out: number }>();
  for (const p of parts) {
    const r = rate.get(p.code) ?? null;
    if (r === null) { unpricedFlow.add(p.code); continue; }
    const usd = Number(p.amount) * r;
    const slot = byDay.get(p.day) ?? { earned: 0, in: 0, out: 0 };
    if (p.bucket === 'earned') slot.earned += usd;
    else if (p.bucket === 'in') slot.in += usd;
    // Out is stored negative and reported positive, as it was before.
    else slot.out += -usd;
    byDay.set(p.day, slot);
  }

  let running = 0;
  const series = spine.map(({ day }) => {
    const s = byDay.get(day) ?? { earned: 0, in: 0, out: 0 };
    const dayEarned = round8(s.earned);
    running = round8(running + dayEarned);
    return {
      day,
      earned: dayEarned,
      cumulative: running,
      moved_in: round8(s.in),
      moved_out: round8(s.out),
    };
  });

  const earned = round8(series.reduce((n, p) => n + p.earned, 0));
  const best = series.reduce((b, p) => (b === null || p.earned > b.earned ? p : b), null as typeof series[0] | null);
  const worst = series.reduce((w, p) => (w === null || p.earned < w.earned ? p : w), null as typeof series[0] | null);

  // The percentage is against what the account was worth when the range opened, worked
  // back from today: what is held now, less what was earned since, less what was paid in
  // and plus what was taken out. A return quoted against today's balance would flatter a
  // client who has just deposited.
  //
  // Everything is valued in dollars first. Cash moves in whatever currency the client
  // used, and adding a GBP deposit to a dollar total without converting it is how a
  // percentage ends up describing nothing — the first version of this did exactly that
  // and produced a negative opening balance.
  const a = await demoAccount(req.principal.sub);
  const [accounts, wallets, pots, stakes, positions] = await Promise.all([
    pool.query<{ currency: string; balance: number }>(
      "SELECT currency, balance FROM trading_accounts WHERE client_id = $1 AND mode = 'demo'",
      [req.principal.sub]),
    pool.query<{ asset: string; balance: number }>(
      'SELECT asset, balance FROM wallets WHERE client_id = $1', [req.principal.sub]),
    pool.query<{ currency: string; balance: number }>(
      "SELECT currency, balance FROM portfolios WHERE client_id = $1 AND status = 'open'",
      [req.principal.sub]),
    pool.query<{ asset: string; balance: number }>(
      "SELECT asset, (amount + rewards) AS balance FROM stakes WHERE client_id = $1 AND status = 'active'",
      [req.principal.sub]),
    pool.query<{ symbol: string; qty: number; avg_price: number }>(
      'SELECT symbol, qty, avg_price FROM positions WHERE account_id = $1', [a.id]),
  ]);

  const held = await totalUsd([
    ...accounts.rows.map((r) => ({ code: r.currency, amount: Number(r.balance) })),
    ...wallets.rows.map((r) => ({ code: r.asset, amount: Number(r.balance) })),
    ...pots.rows.map((r) => ({ code: r.currency, amount: Number(r.balance) })),
    ...stakes.rows.map((r) => ({ code: r.asset, amount: Number(r.balance) })),
  ]);
  const openPnl = positions.rows.reduce((n, x) => n + unrealized(x, spot(x.symbol)), 0);
  const equity = round8(held.usd + openPnl);

  // Net flow over the window, from the series that is already converted per currency. It
  // used to be a second query doing its own conversion, which was one more place for the
  // two to disagree about the same money.
  const movedUsd = round8(series.reduce((n, p) => n + p.moved_in - p.moved_out, 0));

  const opening = round8(equity - earned - movedUsd);
  // Anything the figures could not price, from either the holdings or the flows.
  const unpriced = [...new Set([...held.unpriced, ...unpricedFlow])];

  return {
    days: q.days,
    series,
    earned,
    // Null rather than a number when there was nothing to earn on: a percentage of zero
    // is not a large return, it is not a return. Null too when something in the mix has
    // no price source, because the figure it is taken against would be missing a piece —
    // and that now includes an unpriced currency anywhere in the earnings or the flows,
    // not just in what is held today.
    pct: opening > 0 && !unpriced.length ? round8(earned / opening) : null,
    unpriced,
    opening,
    equity,
    best: best && best.earned > 0 ? best : null,
    worst: worst && worst.earned < 0 ? worst : null,
  };
});

app.get('/account', { preHandler: trader }, async (req) => {
  const a = await demoAccount(req.principal.sub);
  const { rows: pos } = await pool.query<{ symbol: string; qty: number; avg_price: number }>(
    'SELECT symbol, qty, avg_price FROM positions WHERE account_id = $1', [a.id]);
  const open = pos.reduce((sum, p) => sum + unrealized(p, spot(p.symbol)), 0);
  // What the open positions cost, so the move on them can be stated as a proportion of
  // itself rather than as an amount in a currency the account may not even be held in.
  // Null when nothing is open: a percentage of no basis is not zero, it is nothing — the
  // same rule /me/performance uses for its own pct.
  const cost = pos.reduce((sum, p) => sum + Math.abs(Number(p.qty)) * Number(p.avg_price), 0);
  return {
    ...a,
    unrealized: round8(open),
    equity: round8(Number(a.balance) + open),
    open_pct: cost > 0 ? round8(open / cost) : null,
  };
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

// The documents that verify who somebody is. Only these decide whether a client counts as
// verified, and only these put an account back into review when one arrives.
const KYC_KINDS = ['id_front', 'id_back', 'proof_of_address', 'selfie'] as const;
const REQUIRED_KYC = ['id_front', 'proof_of_address'];

// Everything else a client is asked for: where the money came from, a statement, a tax
// form. They are held on the same file and reviewed the same way, but they are not
// identity — a bank statement arriving must not restart somebody's verification, and it
// must never be able to complete it either.
const EXTRA_KINDS = ['bank_statement', 'source_of_funds', 'tax_document', 'other'] as const;
const DOC_KINDS: readonly string[] = [...KYC_KINDS, ...EXTRA_KINDS];
// Only formats a reviewer actually needs to look at. Anything else is refused outright.
/**
 * Every column of kyc_documents except the file itself.
 *
 * The bytes live in the row now, which means `RETURNING *` would put a ten-megabyte
 * passport scan into the JSON of an upload response and of a review decision. Neither
 * caller wants it: one is confirming the upload, the other is recording a decision.
 */
const DOC_COLUMNS = `id, client_id, kind, storage_key, status, reviewed_by, reviewed_at,
                     note, uploaded_at`;

const ALLOWED_UPLOAD = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['application/pdf', '.pdf'],
]);
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(import.meta.dirname, '..', 'uploads');

/**
 * Whether uploaded files actually survive a restart — proven, not assumed.
 *
 * The first version of this checked whether UPLOAD_DIR was SET, which proves nothing: a
 * path pointing at a directory no volume is mounted on is created happily and wiped just
 * the same. So it leaves a marker and looks for it on the next boot. Three answers:
 *
 *   persisted  a marker from an earlier boot was here — the disk survives restarts
 *   fresh      no marker: either the first boot on this disk, or it was wiped
 *   ephemeral  UPLOAD_DIR is not set at all, so this is the container filesystem
 *
 * "fresh" twice across two deploys means the files are NOT surviving, whatever the path
 * is called. On this deployment it has been reporting exactly that, which is what sent
 * every upload into its own row: profile photos first, then offering pictures, and now KYC
 * documents. Nothing written from here on depends on this disk.
 *
 * The probe stays because the disk is still read: documents uploaded before the move are
 * only there, and this is what says whether they are still readable or whether that
 * deployment has already thrown them away. When it reports "fresh", the answer is no.
 */
const PROBE = join(UPLOAD_DIR, '.persistence-probe');
let UPLOAD_PERSISTENCE: 'persisted' | 'fresh' | 'ephemeral' =
  process.env.UPLOAD_DIR ? 'fresh' : 'ephemeral';
try {
  await mkdir(UPLOAD_DIR, { recursive: true });
  if (existsSync(PROBE) && UPLOAD_PERSISTENCE !== 'ephemeral') UPLOAD_PERSISTENCE = 'persisted';
  await writeFile(PROBE, new Date().toISOString());
} catch {
  // A probe that cannot be written says nothing either way; leave the answer as it is.
}
if (UPLOAD_PERSISTENCE !== 'persisted' && process.env.NODE_ENV === 'production') {
  app.log.warn({ uploadDir: UPLOAD_DIR, persistence: UPLOAD_PERSISTENCE },
    'No marker from an earlier boot under UPLOAD_DIR. New uploads do not depend on this — '
    + 'they are stored in their rows — but any document uploaded before that change lived '
    + 'here only, and this says it is already gone.');
}

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
  if (!DOC_KINDS.includes(kind)) return reply.code(400).send({ error: 'unknown document kind' });

  // Buffered rather than streamed to disk, because the document is stored in its row: a file
  // written here is gone with the container on the next release, and a passport that has to
  // be sent twice is a worse outcome than a slightly larger row. The multipart plugin's own
  // 10 MB ceiling is what bounds this buffer.
  const bytes = await file.toBuffer();
  if (file.file.truncated) return reply.code(413).send({ error: 'file too large' });

  // Generated, never the name the file arrived with. It is no longer a path — it is the
  // handle the review screens key on, and it keeps its extension so a document uploaded
  // before this change is still findable on disk.
  const storageKey = `${randomUUID()}${ext}`;

  const doc = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO kyc_documents (client_id, kind, storage_key, file_data, file_type)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${DOC_COLUMNS}`,
      [req.params.id, kind, storageKey, bytes, file.mimetype]);
    // Only an identity document moves the verification along. A tax form from somebody who
    // has never sent identification would otherwise mark them "pending verification" with
    // nothing pending that could ever verify them.
    if (KYC_KINDS.includes(kind as never)) {
      await c.query(
        `UPDATE clients SET kyc_status = 'pending' WHERE id = $1 AND kyc_status IN ('none','rejected','expired')`,
        [req.params.id]);
    }
    await logActivity(c, {
      client_id: req.params.id, kind: 'kyc', actor: req.principal.sub,
      summary: `Uploaded ${kind.replace(/_/g, ' ')}`, ref_table: 'kyc_documents', ref_id: String(rows[0].id),
    });
    await notifyStaff(c, { roles: ['compliance', 'admin'] }, {
      kind: 'kyc.uploaded',
      title: `Document to review: ${kind.replace(/_/g, ' ')}`,
      ref_table: 'clients', ref_id: req.params.id,
    });
    return rows[0];
  });
  return reply.code(201).send(doc);
});

app.get('/clients/:id/kyc', { preHandler: clientScope }, async (req: any) =>
  (await pool.query(
    `SELECT d.id, d.kind, d.status, d.note, d.uploaded_at, d.reviewed_at, d.storage_key,
            s.name AS reviewed_by
       FROM kyc_documents d LEFT JOIN staff s ON s.id = d.reviewed_by
      WHERE d.client_id = $1 ORDER BY d.uploaded_at DESC`, [req.params.id])).rows);

/** The review queue: every document still waiting on a decision. */
app.get('/kyc/pending', { preHandler: auth('kyc:review') }, async () =>
  (await pool.query(
    `SELECT d.id, d.client_id, d.kind, d.uploaded_at, c.name AS client_name, c.country, c.kyc_status
       FROM kyc_documents d JOIN clients c ON c.id = d.client_id
      WHERE d.status = 'pending' ORDER BY d.uploaded_at`)).rows);

/** Documents are served through here, never as a static path. */
/**
 * The document itself.
 *
 * Reading somebody else's needs kyc:review, which is the point of that permission. Reading
 * your own needs nothing but being you: a client who cannot open what they sent has no way
 * to answer "did I upload the right page", which is the commonest reason a verification
 * stalls and the easiest one for them to fix themselves.
 */
app.get('/kyc/:id/file', { preHandler: auth() }, async (req: any, reply) => {
  const { rows } = await pool.query<{
    storage_key: string; client_id: string; file_data: Buffer | null; file_type: string | null;
  }>('SELECT storage_key, client_id, file_data, file_type FROM kyc_documents WHERE id = $1',
     [req.params.id]);
  if (!rows[0]) return reply.code(404).send({ error: 'not found' });

  const own = req.principal.kind === 'client' && req.principal.sub === rows[0].client_id;
  if (!own && !can(req.principal.role, 'kyc:review')) {
    return reply.code(403).send({ error: 'reading a client document needs kyc:review' });
  }

  // Identification, so it is never cached by anything between here and the reader.
  const sent = reply.header('cache-control', 'no-store');
  if (rows[0].file_data) {
    return sent.type(rows[0].file_type ?? 'application/octet-stream').send(rows[0].file_data);
  }

  // Uploaded before documents moved into the row. storage_key is generated by us, but
  // resolve and re-check anyway — and say plainly when the file is no longer there, rather
  // than streaming a missing path and failing halfway through the response.
  const path = join(UPLOAD_DIR, basename(rows[0].storage_key));
  if (!path.startsWith(UPLOAD_DIR)) return reply.code(400).send({ error: 'bad key' });
  if (!existsSync(path)) {
    return sent.code(410).send({
      error: 'this document was stored on a filesystem that has since been replaced, and is '
        + 'no longer available. Ask the client to upload it again.',
    });
  }
  return sent.type(extname(path) === '.pdf' ? 'application/pdf' : 'image/*')
    .send(createReadStream(path));
});


// --------------------------------------------------------------- profile photo

/*
 * A photo of the account holder.
 *
 * A picture of a person is personal data like any other, so it is served from behind the
 * same auth as their documents rather than from a guessable public path: the stored name
 * is generated, and reading it needs either being that client or holding CRM access.
 *
 * Images only, and smaller than the document limit — a headshot is not a scan of a
 * passport, and accepting a PDF here would only ever be a mistake.
 */
const AVATAR_TYPES = new Map([['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp']]);
const AVATAR_MAX = 2 * 1024 * 1024;

/** Where the photo lives on disk, with the key re-checked even though we generated it. */
function avatarPath(key: string, reply: any): string | null {
  const path = join(UPLOAD_DIR, basename(key));
  if (!path.startsWith(UPLOAD_DIR)) {
    reply.code(400).send({ error: 'bad key' });
    return null;
  }
  return path;
}

/**
 * Upload a profile photo. The bytes go into the row, not onto a disk.
 *
 * They used to be a file under UPLOAD_DIR, which is exactly as permanent as whatever
 * happens to be mounted there — and when it was not permanent, nothing said so: the
 * upload returned 201, avatar_key was written, and the photo was simply missing later,
 * which the page renders as "no photo" rather than as something lost. A photo is capped
 * at 2 MB and there is one per client, so it is small enough to live with the record and
 * be as permanent as the account itself.
 */
app.post('/me/avatar', { preHandler: trader }, async (req: any, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no file' });
  if (!AVATAR_TYPES.has(file.mimetype)) {
    return reply.code(415).send({ error: 'a photo, as JPEG, PNG or WebP' });
  }

  // The multipart plugin's own ceiling is set for documents, so the photo limit is
  // enforced here — after buffering, which is safe because that ceiling is 10 MB.
  const bytes = await file.toBuffer();
  if (file.file.truncated || bytes.length > AVATAR_MAX) {
    return reply.code(413).send({ error: 'that photo is larger than 2 MB' });
  }

  const previous = await tx(req.principal.sub, async (c) => {
    // Locked and read before the write, so the key that comes back is the one this upload
    // actually replaced rather than whatever happened to be there a moment earlier.
    const { rows: [before] } = await c.query<{ avatar_key: string | null }>(
      'SELECT avatar_key FROM clients WHERE id = $1 FOR UPDATE', [req.principal.sub]);
    // The key is now only a cache-busting token: it changes on every upload, which is
    // what makes the client refetch, and it no longer names anything on disk.
    await c.query(
      `UPDATE clients SET avatar_key = $2, avatar_image = $3, avatar_type = $4 WHERE id = $1`,
      [req.principal.sub, randomUUID(), bytes, file.mimetype]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'note', actor: req.principal.sub,
      summary: 'Updated their profile photo',
    });
    return before?.avatar_key ?? null;
  });

  // If the one it replaced was a file from before this change, take it with us: keeping
  // every photo somebody ever uploaded of themselves is holding more than was asked for.
  if (previous && /\.(jpg|png|webp)$/i.test(previous)) {
    await rm(join(UPLOAD_DIR, basename(previous)), { force: true }).catch(() => {});
  }
  return reply.code(201).send({ avatar: true });
});

app.delete('/me/avatar', { preHandler: trader }, async (req: any) => {
  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query<{ avatar_key: string | null }>(
      `UPDATE clients SET avatar_key = NULL, avatar_image = NULL, avatar_type = NULL
        WHERE id = $1 RETURNING avatar_key`, [req.principal.sub]);
    return rows[0];
  });
  return { avatar: false, removed: !!out };
});

/**
 * The photo itself. A client may fetch their own; staff with CRM access may fetch anyone's,
 * which is the same rule their record already follows.
 */
app.get('/clients/:id/avatar', { preHandler: clientScope }, async (req: any, reply) => {
  const { rows } = await pool.query<{
    avatar_key: string | null; avatar_image: Buffer | null; avatar_type: string | null;
  }>('SELECT avatar_key, avatar_image, avatar_type FROM clients WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (!row?.avatar_key) return reply.code(404).send({ error: 'no photo' });

  // Private: it is a picture of a person, and a shared cache is not the place for it.
  const priv = (type: string) => reply.type(type).header('cache-control', 'private, max-age=60');

  if (row.avatar_image) return priv(row.avatar_type ?? 'image/jpeg').send(row.avatar_image);

  // Uploaded before the photo moved into the row: still a file on disk, still served. The
  // next upload replaces it with bytes and deletes it.
  const path = avatarPath(row.avatar_key, reply);
  if (!path) return;
  if (!existsSync(path)) return reply.code(404).send({ error: 'no photo' });
  const type = extname(path) === '.png' ? 'image/png'
    : extname(path) === '.webp' ? 'image/webp' : 'image/jpeg';
  return priv(type).send(createReadStream(path));
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
        WHERE id = $1 AND status = 'pending' RETURNING ${DOC_COLUMNS}`,
      [req.params.id, body.data.status, body.data.note ?? null, req.principal.sub]);
    const doc = rows[0];
    if (!doc) return null;

    // The client is approved once every required document is; one rejection rejects them.
    //
    // Identity documents only. A rejected bank statement is a rejected bank statement — it
    // is not a statement about who the person is, and must not undo their verification.
    const { rows: all } = await c.query<{ kind: string; status: string }>(
      'SELECT kind, status FROM kyc_documents WHERE client_id = $1', [doc.client_id]);
    const approved = new Set(all.filter((d) => d.status === 'approved').map((d) => d.kind));
    const identity = KYC_KINDS.includes(doc.kind);
    const status = !identity ? null
      : body.data.status === 'rejected' ? 'rejected'
      : REQUIRED_KYC.every((k) => approved.has(k)) ? 'approved' : 'pending';
    if (status) await c.query('UPDATE clients SET kyc_status = $2 WHERE id = $1', [doc.client_id, status]);

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
    await notifyStaff(c, { roles: ['compliance', 'admin'] }, {
      kind: 'flag.raised',
      title: `${f.severity} flag: ${f.rule.replace(/_/g, ' ')}`,
      body: 'Raised automatically. Open compliance to review it.',
      ref_table: 'clients', ref_id: clientId,
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
    if (kind === 'withdrawal') {
      await notifyStaff(c, { roles: ['compliance', 'admin'] }, {
        kind: 'withdrawal.request',
        title: `Withdrawal to approve: ${amount} ${locked!.currency}`,
        ref_table: 'clients', ref_id: req.principal.sub,
      });
    }

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
  // The currency comes from the account the movement landed in. Without it a caller can
  // only add the amounts up, and amounts in different currencies do not add up — a
  // 100 GBP deposit and a 100 USD one are not 200 of anything.
  const { rows } = await pool.query(
    `SELECT t.id, t.kind, t.amount, t.status, t.created_at, a.currency
       FROM cash_transactions t
       JOIN trading_accounts a ON a.id = t.account_id
      WHERE t.client_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [clientId]);
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
 * What each side can be notified about, and what it is called on the settings page.
 *
 * A kind marked `locked` cannot be switched off. That is only ever used for the notice
 * that somebody's password or sign-in changed: a person who can silence the one message
 * that tells them their account was taken over is a person whose account can be taken over
 * quietly, so that switch does not exist.
 */
const NOTIFY_KINDS = {
  client: [
    { kind: 'order.filled', label: 'Order fills', note: 'When a resting order is filled by the engine.' },
    { kind: 'credit',       label: 'Balance changes', note: 'Money added to or taken off your account by the desk.' },
    { kind: 'deposit',      label: 'Deposits', note: 'When a deposit is approved or declined.' },
    { kind: 'withdrawal',   label: 'Withdrawals', note: 'When a withdrawal is approved, paid or returned.' },
    { kind: 'interest',     label: 'Interest', note: 'Interest paid into a savings portfolio.' },
    { kind: 'stake',        label: 'Staking', note: 'Stakes opened or closed, and changes to what they earn.' },
    { kind: 'portfolio.request', label: 'Withdrawal decisions', note: 'When the desk decides on money you asked to take out.' },
    { kind: 'kyc',          label: 'Verification', note: 'Progress on your identity documents.' },
    { kind: 'ticket',       label: 'Support replies', note: 'When we reply on one of your tickets.' },
    { kind: 'message',      label: 'Messages from the desk', note: 'Direct messages from your account manager.' },
    { kind: 'security',     label: 'Security', note: 'Password and sign-in changes.', locked: true },
  ],
  staff: [
    { kind: 'flag.raised',        label: 'Compliance flags', note: 'A rule fired on a client.' },
    { kind: 'kyc.uploaded',       label: 'Documents to review', note: 'A client uploaded identification.' },
    { kind: 'ticket.activity',    label: 'Support tickets', note: 'A client opened a ticket or replied on one.' },
    { kind: 'withdrawal.request', label: 'Cash withdrawals', note: 'A client asked to take money or crypto off their account.' },
    { kind: 'task.assigned',      label: 'Tasks assigned to you', note: 'Somebody put a task on your list.' },
    { kind: 'client.registered',  label: 'New sign-ups', note: 'Somebody opened an account themselves.' },
    { kind: 'portfolio.request',  label: 'Portfolio withdrawals', note: 'A client asked to take money out of a savings pot, which needs a decision.' },
  ],
} as const;

type SubjectKind = 'client' | 'staff';
const kindsFor = (k: SubjectKind) => NOTIFY_KINDS[k] as readonly { kind: string; label: string; note: string; locked?: boolean }[];
const isLocked = (k: SubjectKind, kind: string) => !!kindsFor(k).find((x) => x.kind === kind)?.locked;

/**
 * Whether this person still wants this kind of notification.
 *
 * Absent means yes. Preferences record only the exceptions, so a kind added in a later
 * release reaches everybody by default instead of going nowhere until each person happens
 * to find the setting and switch it on.
 */
async function wants(c: pg.PoolClient, subject: SubjectKind, id: string, kind: string) {
  if (isLocked(subject, kind)) return true;
  const { rows } = await c.query<{ enabled: boolean }>(
    'SELECT enabled FROM notification_prefs WHERE subject_kind = $1 AND subject_id = $2 AND kind = $3',
    [subject, id, kind]);
  return rows[0]?.enabled ?? true;
}

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
  // Switched off means not written, not written-and-hidden: an inbox that fills with
  // things the reader has said they do not want is an inbox they stop opening.
  if (!(await wants(c, 'client', n.client_id, n.kind))) return null;
  const { rows: [row] } = await c.query(
    `INSERT INTO notifications (client_id, kind, title, body, ref_table, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [n.client_id, n.kind, n.title, n.body ?? null, n.ref_table ?? null, n.ref_id ?? null]);
  pending.push(row);
  return row;
}

/**
 * Tell staff something needs them. Either a named person, or everyone holding a role.
 *
 * One row each rather than one row addressed to a role: a notification is read by a
 * person, and two people looking at the same queue should not un-read each other's.
 */
async function notifyStaff(
  c: pg.PoolClient,
  to: { staff_id: string } | { roles: readonly string[] },
  n: { kind: string; title: string; body?: string; ref_table?: string; ref_id?: string },
) {
  const { rows: people } = 'staff_id' in to
    ? await c.query<{ id: string }>('SELECT id FROM staff WHERE id = $1 AND active', [to.staff_id])
    : await c.query<{ id: string }>('SELECT id FROM staff WHERE active AND role = ANY($1)', [to.roles]);

  for (const person of people) {
    if (!(await wants(c, 'staff', person.id, n.kind))) continue;
    const { rows: [row] } = await c.query(
      `INSERT INTO notifications (staff_id, kind, title, body, ref_table, ref_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [person.id, n.kind, n.title, n.body ?? null, n.ref_table ?? null, n.ref_id ?? null]);
    pending.push(row);
  }
}

/**
 * Sockets are pushed after the transaction commits, not during it: a client told about a
 * fill that then rolled back would be looking at money that never moved.
 */
const pending: any[] = [];
function flushNotifications() {
  while (pending.length) {
    const row = pending.shift();
    const to = row.staff_id ?? row.client_id;
    toSubject(row.staff_id ? 'staff' : 'client', to, { type: 'notification', notification: row });
  }
}

/**
 * A notification is addressed to exactly one person, so it goes to that person's sockets
 * and no further. notify() above is the other rule — an order event reaches the client and
 * every staff member watching the desk — and the two must not be confused: a staff bell
 * filling up with clients' private notices is a leak, not a feature.
 */
function toSubject(kind: 'staff' | 'client', id: string, msg: unknown) {
  const text = JSON.stringify(msg);
  for (const [sock, principal] of feed) {
    if (principal.kind !== kind || principal.sub !== id) continue;
    try { sock.send(text); } catch { feed.delete(sock); }
  }
}

app.addHook('onResponse', async () => flushNotifications());

/**
 * The inbox belongs to whoever is asking, staff or client, so every query below is scoped
 * by the column that matches the caller. Written as one expression rather than two branches
 * of SQL: the day somebody adds a filter, they should not have to remember to add it twice.
 */
const mine = (req: any) => (req.principal.kind === 'staff'
  ? { column: 'staff_id', subject: 'staff' as const }
  : { column: 'client_id', subject: 'client' as const });

app.get('/notifications', { preHandler: auth() }, async (req: any) => {
  const q = z.object({
    unread: z.coerce.boolean().default(false),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT * FROM notifications
      WHERE ${mine(req).column} = $1 AND ($2::bool IS NOT TRUE OR read_at IS NULL)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [req.principal.sub, q.unread, q.limit]);
  return rows;
});

app.get('/notifications/unread-count', { preHandler: auth() }, async (req: any) => {
  const { rows: [row] } = await pool.query<{ unread: number }>(
    `SELECT count(*) AS unread FROM notifications
      WHERE ${mine(req).column} = $1 AND read_at IS NULL`,
    [req.principal.sub]);
  return { unread: Number(row!.unread) };
});

app.post('/notifications/:id/read', { preHandler: auth() }, async (req: any, reply) => {
  // Scoped by subject as well as id, so nobody can mark somebody else's as read.
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = coalesce(read_at, now())
      WHERE id = $1 AND ${mine(req).column} = $2 RETURNING *`, [req.params.id, req.principal.sub]);
  if (!rows[0]) return reply.code(404).send({ error: 'no such notification' });
  return rows[0];
});

app.post('/notifications/read-all', { preHandler: auth() }, async (req: any) => {
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read_at = now() WHERE ${mine(req).column} = $1 AND read_at IS NULL`,
    [req.principal.sub]);
  return { marked: rowCount ?? 0 };
});

/**
 * Which notifications the caller wants. The catalogue and their answers arrive together,
 * so the settings page never has to know what the kinds are called or which are locked.
 */
app.get('/me/notification-prefs', { preHandler: auth() }, async (req: any) => {
  const { subject } = mine(req);
  const { rows } = await pool.query<{ kind: string; enabled: boolean }>(
    'SELECT kind, enabled FROM notification_prefs WHERE subject_kind = $1 AND subject_id = $2',
    [subject, req.principal.sub]);
  const set = new Map(rows.map((r) => [r.kind, r.enabled]));
  return kindsFor(subject).map((k) => ({
    ...k, locked: !!k.locked, enabled: k.locked ? true : set.get(k.kind) ?? true,
  }));
});

app.put('/me/notification-prefs', { preHandler: auth() }, async (req: any, reply) => {
  const { subject } = mine(req);
  const known = new Set(kindsFor(subject).map((k) => k.kind));
  const body = z.record(z.string(), z.boolean()).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const unknown = Object.keys(body.data).filter((k) => !known.has(k));
  if (unknown.length) return reply.code(400).send({ error: `not a notification kind: ${unknown.join(', ')}` });
  const forced = Object.keys(body.data).filter((k) => isLocked(subject, k) && !body.data[k]);
  if (forced.length) {
    return reply.code(422).send({ error: `${forced.join(', ')} cannot be switched off` });
  }

  await tx(req.principal.sub, async (c) => {
    for (const [kind, enabled] of Object.entries(body.data)) {
      await c.query(
        `INSERT INTO notification_prefs (subject_kind, subject_id, kind, enabled)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (subject_kind, subject_id, kind)
         DO UPDATE SET enabled = excluded.enabled, updated_at = now()`,
        [subject, req.principal.sub, kind, enabled]);
    }
  });
  return { ok: true };
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

// ------------------------------------------------------ the client workspace

/**
 * Everything a staff member needs to see about one client's money, in a single response.
 *
 * Read-only by design: this is the "trading data, read-only" the brief asks for. Staff
 * look, they do not place orders or move balances — the only money a staff member can
 * move is through the audited credit and cash-decision routes.
 */
app.get('/clients/:id/holdings', { preHandler: auth('trade:read') }, async (req: any, reply) => {
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });
  const id = req.params.id;

  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = [id]) =>
    (await pool.query<T>(sql, params)).rows;

  const [accounts, wallets, portfolios, positions, orders, trades, cash, ipos] = await Promise.all([
    q<{ currency: string; balance: number }>(
      `SELECT id, currency, balance, mode, leverage FROM trading_accounts
        WHERE client_id = $1 ORDER BY currency`),
    q<{ asset: string; balance: number }>(
      'SELECT id, asset, address, balance FROM wallets WHERE client_id = $1 ORDER BY asset'),
    q<{ name: string; currency: string; balance: number }>(
      `SELECT p.id, p.name, p.currency, p.balance, p.status, p.target_amount, t.name AS type_name
         FROM portfolios p JOIN portfolio_types t ON t.code = p.type_code
        WHERE p.client_id = $1 ORDER BY p.status, p.created_at`),
    q<{ symbol: string; qty: number; avg_price: number }>(
      `SELECT p.symbol, p.qty, p.avg_price, p.updated_at
         FROM positions p JOIN trading_accounts a ON a.id = p.account_id
        WHERE a.client_id = $1 ORDER BY p.symbol`),
    q(`SELECT id, symbol, side, type, qty, limit_price, stop_price, status, placed_at
         FROM orders WHERE client_id = $1 ORDER BY placed_at DESC LIMIT 50`),
    q(`SELECT f.id, f.qty, f.price, f.fee, f.filled_at, o.symbol, o.side, o.type
         FROM fills f JOIN orders o ON o.id = f.order_id
        WHERE o.client_id = $1 ORDER BY f.filled_at DESC LIMIT 50`),
    q(`SELECT id, kind, amount, status, created_at FROM cash_transactions
        WHERE client_id = $1 ORDER BY created_at DESC LIMIT 50`),
    // An allocation is money the client holds, so the workspace has to see it or the
    // assets tab is short by whatever they have subscribed.
    q<{ name: string; currency: string; balance: number }>(
      `SELECT s.id, i.name, i.asset, s.currency, s.amount, s.accrued, s.status,
              (s.amount + s.accrued) AS balance, i.matures_at,
              coalesce(s.roi_override, i.roi_rate) AS effective_rate
         FROM ipo_subscriptions s JOIN ipos i ON i.id = s.ipo_id
        WHERE s.client_id = $1 ORDER BY s.status, i.name`),
  ]);

  // Value everything in USD so the workspace can show one number for the relationship.
  // Only live allocations count: a refunded or settled one is already back in the cash
  // above, and counting both would show the same money twice.
  // ponytail: stakes are still missing from this total, which predates the IPO work.
  const liveIpos = ipos.filter((x: any) => x.status === 'active');
  const priced = await totalUsd([
    ...accounts.map((a) => ({ code: a.currency, amount: Number(a.balance) })),
    ...wallets.map((w) => ({ code: w.asset, amount: Number(w.balance) })),
    ...portfolios.map((p) => ({ code: p.currency, amount: Number(p.balance) })),
    ...liveIpos.map((x: any) => ({ code: x.currency, amount: Number(x.balance) })),
  ]);
  const openPnl = positions.reduce((sum, p) => sum + unrealized(p, spot(p.symbol)), 0);

  return {
    accounts, wallets, portfolios, cash, ipos,
    positions: positions.map((p) => {
      const price = spot(p.symbol);
      return { ...p, price, unrealized: unrealized(p, price) };
    }),
    orders, trades,
    totals: {
      holdings_usd: priced.usd,
      unpriced: priced.unpriced,
      open_pnl: round8(openPnl),
      equity_usd: round8(priced.usd + openPnl),
    },
  };
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
    await notifyStaff(c, { roles: ['support', 'sales', 'admin'] }, {
      kind: 'ticket.activity',
      title: `New ticket: ${body.data.subject}`,
      body: body.data.body.slice(0, 160),
      ref_table: 'tickets', ref_id: t.id,
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
    } else if (!scope.staff) {
      await notifyStaff(c, { roles: ['support', 'sales', 'admin'] }, {
        kind: 'ticket.activity',
        title: `Client replied: ${t.subject}`,
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
  // Money in a savings pot is still the client's money. Left out of the total, paying
  // 3,000 into a portfolio read as 3,000 disappearing — the same sum the staff-side
  // header does, so both sides answer "what do I have" with the same number.
  const { rows: portfolios } = await pool.query<{ name: string; currency: string; balance: number }>(
    `SELECT id, name, currency, balance, featured FROM portfolios
      WHERE client_id = $1 AND status = 'open' ORDER BY name`, [req.principal.sub]);

  const priced = async <T extends { balance: number }>(row: T, code: string) => {
    const rate = await rateToUsd(code);
    return { ...row, usd_value: rate === null ? null : round8(Number(row.balance) * rate) };
  };
  // Staked crypto is the client's crypto, in a place it cannot be spent from today. Left
  // out of the total, staking would read as the asset disappearing — the same mistake
  // portfolios made before they were counted.
  const { rows: stakes } = await pool.query<{ name: string; currency: string; balance: number }>(
    `SELECT s.id, p.name, s.asset AS currency, (s.amount + s.rewards) AS balance
       FROM stakes s JOIN staking_products p ON p.code = s.product_code
      WHERE s.client_id = $1 AND s.status = 'active' ORDER BY p.name`, [req.principal.sub]);

  // Money in an offering is the client's money, in a place they cannot spend from until it
  // matures. Left out of the total it would read as the subscription disappearing, which is
  // the mistake portfolios made before they were counted and staking made after them.
  const { rows: ipos } = await pool.query<{ name: string; currency: string; balance: number }>(
    `SELECT s.id, i.name, s.currency, (s.amount + s.accrued) AS balance
       FROM ipo_subscriptions s JOIN ipos i ON i.id = s.ipo_id
      WHERE s.client_id = $1 AND s.status = 'active' ORDER BY i.name`, [req.principal.sub]);

  const cash = await Promise.all(accounts.map((a) => priced(a, a.currency)));
  const crypto = await Promise.all(wallets.map((w) => priced(w, w.asset)));
  const pots = await Promise.all(portfolios.map((p) => priced(p, p.currency)));
  const staked = await Promise.all(stakes.map((x) => priced(x, x.currency)));
  const offerings = await Promise.all(ipos.map((x) => priced(x, x.currency)));
  const total = await totalUsd([
    ...accounts.map((a) => ({ code: a.currency, amount: a.balance })),
    ...wallets.map((w) => ({ code: w.asset, amount: w.balance })),
    ...portfolios.map((p) => ({ code: p.currency, amount: p.balance })),
    ...stakes.map((x) => ({ code: x.currency, amount: x.balance })),
    ...ipos.map((x) => ({ code: x.currency, amount: x.balance })),
  ]);
  return {
    cash, wallets: crypto, portfolios: pots, stakes: staked, ipos: offerings,
    total_usd: total.usd, unpriced: total.unpriced,
  };
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

/**
 * Record a deposit the client made, on their behalf.
 *
 * Distinct from crediting, and the distinction is the point. A credit writes an
 * `adjustment` — money the desk put there — and the client's Deposits figure and
 * net_deposits both count only `deposit` rows, so a credit is deliberately invisible to
 * them. Money that genuinely arrived from the client has to be recorded as what it is, or
 * their own summary of what they have paid in disagrees with the desk's.
 *
 * Booked as approved rather than pending: a deposit reaching this route is one somebody has
 * already seen land, and a staff member cannot usefully approve their own record of it.
 * That matches the decide route, where an approved deposit is the one that moves the
 * balance. Same permission as crediting, because it is the same power.
 */
app.post('/clients/:id/deposit', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = creditBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { currency, amount, note } = body.data;

  const ccy = (await currencies()).get(currency);
  if (!ccy) return reply.code(404).send({ error: 'unknown currency' });
  if (ccy.kind !== 'fiat') return reply.code(400).send({ error: 'a deposit is cash; use the wallet credit route for crypto' });
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });

  return tx(req.principal.sub, async (c) => {
    // As with crediting, the account for this currency may not exist yet.
    const { rows: [account] } = await c.query(
      `INSERT INTO trading_accounts (client_id, mode, currency, balance) VALUES ($1,'demo',$2,0)
       ON CONFLICT (client_id, mode, currency) DO UPDATE SET client_id = excluded.client_id
       RETURNING *`, [req.params.id, currency]);
    await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1', [account.id, amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO cash_transactions (account_id, client_id, kind, amount, status, approved_by)
       VALUES ($1,$2,'deposit',$3,'approved',$4) RETURNING *`,
      [account.id, req.params.id, amount, req.principal.sub]);
    await notifyClientOf(c, {
      client_id: req.params.id, kind: 'deposit',
      title: `Deposit of ${amount} ${currency} recorded`,
      body: note ?? undefined, ref_table: 'cash_transactions', ref_id: String(entry.id),
    });
    await logActivity(c, {
      client_id: req.params.id, kind: 'deposit', actor: req.principal.sub,
      summary: `Deposit of ${amount} ${currency} recorded by staff${note ? ` — ${note}` : ''}`,
      ref_table: 'cash_transactions', ref_id: String(entry.id),
      data: { currency, amount, note: note ?? null },
    });
    return { transaction: entry, currency, amount };
  });
});

/**
 * The other direction: take funds off a client's account — correcting a mistaken credit,
 * settling a fee, or removing a balance that should not be there.
 *
 * Deliberately cannot overdraw. A negative balance would be a number the rest of the system
 * has no meaning for: margin, equity and position sizing all assume a floor of zero. Taking
 * more than is there is a mistake, so it is refused rather than clamped silently.
 *
 * Same permission as crediting, same audit trail, and the client is told — money leaving an
 * account without the holder knowing is exactly what an audit log exists to prevent.
 */
app.post('/clients/:id/debit', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = creditBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { currency, amount, note } = body.data;

  const ccy = (await currencies()).get(currency);
  if (!ccy) return reply.code(404).send({ error: 'unknown currency' });
  if (ccy.kind !== 'fiat') return reply.code(400).send({ error: 'crypto wallets are debited by withdrawal' });
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });

  return tx(req.principal.sub, async (c) => {
    // FOR UPDATE: two debits landing together must not both read the same balance and
    // between them take more than the account holds.
    const { rows: [account] } = await c.query(
      `SELECT * FROM trading_accounts WHERE client_id = $1 AND mode = 'demo' AND currency = $2 FOR UPDATE`,
      [req.params.id, currency]);
    if (!account) return reply.code(404).send({ error: `no ${currency} account` });
    if (Number(account.balance) < amount) {
      return reply.code(422).send({ error: `balance is ${account.balance} ${currency}` });
    }

    await c.query('UPDATE trading_accounts SET balance = balance - $2 WHERE id = $1', [account.id, amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO cash_transactions (account_id, client_id, kind, amount, status, approved_by)
       VALUES ($1,$2,'adjustment',$3,'settled',$4) RETURNING *`,
      [account.id, req.params.id, -amount, req.principal.sub]);
    await notifyClientOf(c, {
      client_id: req.params.id, kind: 'credit',
      title: `${amount} ${currency} removed from your account`,
      body: note ?? undefined, ref_table: 'cash_transactions', ref_id: String(entry.id),
    });
    await logActivity(c, {
      client_id: req.params.id, kind: 'credit', actor: req.principal.sub,
      summary: `Debited ${amount} ${currency}${note ? ` — ${note}` : ''}`,
      ref_table: 'cash_transactions', ref_id: String(entry.id),
      data: { currency, amount: -amount, note: note ?? null },
    });
    return { transaction: entry, currency, amount: -amount };
  });
});

const pnlBody = z.object({
  // Signed: a gain is positive, a loss negative. Zero is refused rather than written as a
  // no-op entry on somebody's timeline.
  amount: z.number().finite().max(1e12).min(-1e12).refine((n) => n !== 0, 'amount cannot be zero'),
  note: z.string().max(500).optional(),
});

/**
 * Adjust a client's realised P&L by hand.
 *
 * It moves the balance as well as the figure, and that is the whole point. Realised P&L on
 * a fill is money: it lands in the account. Writing an earnings entry without moving the
 * balance would make the account's own arithmetic disagree with itself, because the opening
 * balance is worked back as equity less what was earned less what was paid in — add to the
 * middle term alone and the client is retrospectively told they started poorer. Moving both
 * leaves that reconstruction untouched.
 *
 * Recorded as its own kind rather than dressed as a fill. It belongs in the earnings series
 * because it is earnings, but a fill that never happened has no order, no symbol and no
 * price, and inventing one would put a trade in the client's history that cannot be
 * explained if anybody asks.
 *
 * Same permission as crediting — this creates a gain out of nothing on a demo account, which
 * is the same power — and like crediting it is audited, timelined, and told to the client.
 */
app.post('/clients/:id/pnl', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = pnlBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { amount, note } = body.data;

  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });
  // Realised P&L lands in the account orders trade on, so make sure it exists first.
  await demoAccount(req.params.id);

  const out = await tx(req.principal.sub, async (c) => {
    // FOR UPDATE for the same reason the debit route takes it: two adjustments landing
    // together must not both read the same balance.
    const { rows: [account] } = await c.query(
      `SELECT * FROM trading_accounts
        WHERE client_id = $1 AND mode = 'demo' AND currency = 'USD' FOR UPDATE`,
      [req.params.id]);
    // A loss cannot take the account below zero. Margin, equity and position sizing all
    // assume a floor of nothing, the same reason the debit route refuses to overdraw.
    if (amount < 0 && Number(account.balance) + amount < 0) {
      return { short: Number(account.balance) } as const;
    }

    await c.query('UPDATE trading_accounts SET balance = balance + $2 WHERE id = $1',
      [account.id, amount]);
    // ASCII minus, not a typographic one. This string is stored, and a database on a
    // WIN1252 client encoding rejects U+2212 outright: the insert failed, so every loss
    // came back a 500 while gains, carrying a plain +, went through.
    const shown = `${amount > 0 ? '+' : '-'}${Math.abs(amount)} USD`;
    await logActivity(c, {
      client_id: req.params.id, kind: 'pnl', actor: req.principal.sub,
      summary: `P&L adjusted by ${shown}${note ? ` — ${note}` : ''}`,
      // `realized` is the field the earnings series reads, the same one a fill writes.
      data: { realized: amount, note: note ?? null },
    });
    await notifyClientOf(c, {
      client_id: req.params.id, kind: 'credit',
      title: `Your profit and loss was adjusted by ${shown}`,
      body: note ?? undefined,
    });
    return { amount, balance: round8(Number(account.balance) + amount) } as const;
  });

  if ('short' in out) {
    return reply.code(422).send({ error: `balance is ${out.short} USD; a loss cannot overdraw it` });
  }
  return out;
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
    await notifyStaff(c, { roles: ['compliance', 'admin'] }, {
      kind: 'withdrawal.request',
      title: `Withdrawal to approve: ${body.data.amount} ${w.asset}`,
      ref_table: 'clients', ref_id: req.principal.sub,
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
           -- The rate agreed on this pot wins over the product's. One expression, used by
           -- the job that pays the money and by the screens that promise it, so what the
           -- client is shown and what lands in the pot cannot drift apart.
           coalesce(p.rate_override, t.indicative_rate) AS rate,
           (current_date - p.last_accrued_on) AS days
      FROM portfolios p JOIN portfolio_types t ON t.code = p.type_code
     WHERE p.status = 'open'
       AND coalesce(p.rate_override, t.indicative_rate) IS NOT NULL
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

/**
 * Whose money a portfolio write moves.
 *
 * A client acts on themselves and cannot say otherwise. A staff member acts on a named
 * client and must say which — the desk opening a pot for somebody, or moving money between
 * their cash and their savings at their request, which is an ordinary thing for a desk to
 * do and an unusual thing to do quietly. So it needs funds:credit, the same permission as
 * every other route where staff touch a client's balance, the actor recorded against it is
 * the staff member, and the client is told.
 *
 * Returns null when it has already answered the request.
 */
async function portfolioSubject(req: any, reply: any): Promise<{ clientId: string; onBehalf: boolean } | null> {
  if (req.principal.kind === 'client') return { clientId: req.principal.sub, onBehalf: false };
  if (!can(req.principal.role, 'funds:credit')) {
    reply.code(403).send({ error: 'acting on a client portfolio needs funds:credit' });
    return null;
  }
  const q = z.object({ client_id: z.string().uuid() }).safeParse(req.body ?? {});
  if (!q.success) {
    reply.code(400).send({ error: 'staff must name the client: client_id' });
    return null;
  }
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [q.data.client_id]);
  if (!rowCount) {
    reply.code(404).send({ error: 'no such client' });
    return null;
  }
  return { clientId: q.data.client_id, onBehalf: true };
}

app.get('/portfolios', async (req: any, reply) => {
  const clientId = await portfolioScope(req, reply);
  if (clientId === null) return reply.sent ? undefined : [];
  const { rows } = await pool.query(
    `SELECT p.*, t.name AS type_name,
            coalesce(p.rate_override, t.indicative_rate) AS indicative_rate,
            t.indicative_rate AS standard_rate,
            (SELECT coalesce(sum(amount), 0) FROM portfolio_transactions x
              WHERE x.portfolio_id = p.id AND x.kind = 'interest')            AS earned,
            (SELECT coalesce(sum(amount), 0) FROM portfolio_requests r
              WHERE r.portfolio_id = p.id AND r.status = 'pending')           AS requested
       FROM portfolios p JOIN portfolio_types t ON t.code = p.type_code
      WHERE p.client_id = $1 ORDER BY p.status, p.created_at`, [clientId]);

  return Promise.all(rows.map(async (p) => {
    const rate = await rateToUsd(p.currency);
    const years = p.target_date
      ? (new Date(p.target_date).getTime() - Date.now()) / (365.25 * 86400_000) : 0;
    return {
      ...p,
      usd_value: rate === null ? null : round8(Number(p.balance) * rate),
      progress: null,
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
  // A target date still shapes the projection — "what will this be worth by then" needs a
  // then. A target amount asked people to commit to a number before they had any, and
  // measured them against it every time they opened the page, so it is gone.
  target_date: isoDate.optional(),
});

app.post('/portfolios', { preHandler: auth() }, async (req: any, reply) => {
  const who = await portfolioSubject(req, reply);
  if (!who) return;
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
        [who.clientId, b.type_code, b.name, b.currency, null, b.target_date ?? null]);
      await logActivity(c, {
        client_id: who.clientId, kind: 'portfolio', actor: req.principal.sub,
        summary: `${who.onBehalf ? 'Desk opened' : 'Opened'} ${b.name} (${b.type_code.replace(/_/g, ' ')})`,
        ref_table: 'portfolios', ref_id: rows[0].id,
        data: { type: b.type_code, currency: b.currency },
      });
      return rows[0];
    });
  } catch (err: any) {
    // One name per client, so the list stays legible.
    if (err?.code === '23505') return reply.code(409).send({ error: 'there is already a portfolio with that name' });
    throw err;
  }
});

const moveBody = z.object({ amount: z.number().positive().finite(), note: z.string().max(200).optional() });

/**
 * Move money between a balance and a pot. `into` decides the direction; either way both
 * sides move in one transaction, so money is never in neither place or in both.
 */
async function movePortfolio(req: any, reply: any, into: boolean) {
  const who = await portfolioSubject(req, reply);
  if (!who) return;
  // Money leaves a pot by decision, not by button. A client asks through /requests and
  // the desk approves; letting them call this directly would make that flow decoration
  // that one API call walks around.
  if (!into && !who.onBehalf) {
    return reply.code(403).send({ error: 'ask for it through a withdrawal request' });
  }
  const body = moveBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { amount, note } = body.data;
  const subject = who.clientId;

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [p] } = await c.query<{ id: string; currency: string; balance: number; name: string; status: string }>(
      'SELECT id, currency, balance, name, status FROM portfolios WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [req.params.id, subject]);
    if (!p) return 'missing' as const;
    if (p.status !== 'open') return 'closed' as const;

    const ccy = (await currencies()).get(p.currency)!;
    // Opened on demand when money is coming back out, so a withdrawal always has a home.
    const holding = await lockHolding(c, subject, p.currency, ccy.kind, !into);
    if (!holding) return 'no-holding' as const;
    if (into && Number(holding.balance) < amount) return 'insufficient-balance' as const;
    if (!into && Number(p.balance) < amount) return 'insufficient-portfolio' as const;

    await moveBalance(c, holding, into ? -amount : amount);
    await c.query('UPDATE portfolios SET balance = balance + $2 WHERE id = $1',
      [p.id, into ? amount : -amount]);
    const { rows: [entry] } = await c.query(
      `INSERT INTO portfolio_transactions (portfolio_id, client_id, kind, amount, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [p.id, subject, into ? 'contribution' : 'withdrawal', into ? amount : -amount, note ?? null]);
    const moved = into
      ? `${amount} ${p.currency} into ${p.name}`
      : `${amount} ${p.currency} out of ${p.name}`;
    await logActivity(c, {
      client_id: subject, kind: 'portfolio', actor: req.principal.sub,
      summary: who.onBehalf
        ? `Desk moved ${moved}${note ? ` — ${note}` : ''}`
        : into ? `Paid ${moved}` : `Took ${moved}`,
      ref_table: 'portfolio_transactions', ref_id: String(entry.id),
      data: { portfolio: p.name, amount, currency: p.currency, on_behalf: who.onBehalf },
    });
    // Money the client did not move themselves is money they should hear about.
    if (who.onBehalf) {
      await notifyClientOf(c, {
        client_id: subject, kind: 'credit',
        title: into ? `${amount} ${p.currency} moved into ${p.name}` : `${amount} ${p.currency} moved out of ${p.name}`,
        body: note ?? 'Moved by the desk.',
        ref_table: 'portfolio_transactions', ref_id: String(entry.id),
      });
    }
    return entry;
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such portfolio' });
  if (out === 'closed') return reply.code(409).send({ error: 'that portfolio is closed' });
  if (out === 'no-holding') return reply.code(400).send({ error: 'you hold no balance in that currency' });
  if (out === 'insufficient-balance') return reply.code(400).send({ error: 'amount exceeds your balance' });
  if (out === 'insufficient-portfolio') return reply.code(400).send({ error: 'amount exceeds the portfolio balance' });
  return reply.code(201).send(out);
}

app.post('/portfolios/:id/contribute', { preHandler: auth() }, (req, reply) => movePortfolio(req, reply, true));
app.post('/portfolios/:id/withdraw', { preHandler: auth() }, (req, reply) => movePortfolio(req, reply, false));

app.patch('/portfolios/:id', { preHandler: auth() }, async (req: any, reply) => {
  const who = await portfolioSubject(req, reply);
  if (!who) return;
  const body = z.object({
    // client_id is how staff say whose portfolio this is; it is not a field to change.
    client_id: z.string().uuid().optional(),
    featured: z.boolean().optional(),
    // The rate this pot earns. A fraction, so 0.045 is 4.5% a year. Null puts it back on
    // the product's rate. Bounded here and in the column: it multiplies somebody else's
    // money, and 35 typed for 3.5 is a hundredfold.
    rate_override: z.number().min(0).max(1).nullable().optional(),
    name: z.string().min(1).max(80).optional(),
    target_date: isoDate.nullable().optional(),
    status: z.enum(['open', 'closed']).optional(),
  }).transform(({ client_id: _ignored, ...rest }) => rest)
    .refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  // A client may rename their pot and set their own target. They may not decide what it
  // pays them — that is a term of the account, agreed with the desk, and it needs the same
  // permission as putting money on the account by hand.
  if (body.data.rate_override !== undefined && !who.onBehalf) {
    return reply.code(403).send({ error: 'the rate on a portfolio is set by the desk' });
  }

  const entries = Object.entries(body.data);
  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [p] } = await c.query<{ balance: number }>(
      'SELECT balance FROM portfolios WHERE id = $1 AND client_id = $2 FOR UPDATE',
      [req.params.id, who.clientId]);
    if (!p) return 'missing' as const;
    // Closing a pot with money still in it would strand it: take it out first.
    if (body.data.status === 'closed' && Number(p.balance) > 0) return 'not-empty' as const;

    const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await c.query(
      `UPDATE portfolios SET ${set} WHERE id = $1 RETURNING *`,
      [req.params.id, ...entries.map(([, v]) => v)]);
    // A rate change is the one edit here that changes what the client is owed, so it is
    // named in the summary rather than filed under "updated" with everything else.
    const rate = body.data.rate_override;
    const summary = rate !== undefined
      ? (rate === null
        ? `Desk put ${rows[0].name} back on the standard rate`
        : `Desk set ${rows[0].name} to ${(rate * 100).toFixed(2)}% a year`)
      : who.onBehalf
        ? (body.data.status === 'closed' ? `Desk closed ${rows[0].name}` : `Desk updated ${rows[0].name}`)
        : (body.data.status === 'closed' ? `Closed ${rows[0].name}` : `Updated ${rows[0].name}`);

    await logActivity(c, {
      client_id: who.clientId, kind: 'portfolio', actor: req.principal.sub,
      summary, ref_table: 'portfolios', ref_id: rows[0].id, data: body.data,
    });
    // What their savings earn is a term of their account. They are told when it moves,
    // whichever way it moves.
    if (rate !== undefined) {
      const { rows: [t] } = await c.query<{ indicative_rate: number | null }>(
        'SELECT indicative_rate FROM portfolio_types WHERE code = $1', [rows[0].type_code]);
      const effective = rate ?? (t?.indicative_rate === null || t?.indicative_rate === undefined
        ? null : Number(t.indicative_rate));
      await notifyClientOf(c, {
        client_id: who.clientId, kind: 'interest',
        title: `${rows[0].name} now earns ${effective === null ? 'no interest' : `${(effective * 100).toFixed(2)}% a year`}`,
        body: 'Credited daily on the balance in the pot.',
        ref_table: 'portfolios', ref_id: rows[0].id,
      });
    }
    return rows[0];
  });
  if (out === 'missing') return reply.code(404).send({ error: 'no such portfolio' });
  if (out === 'not-empty') return reply.code(409).send({ error: 'take the balance out before closing' });
  return out;
});


// -------------------------------------------- portfolio withdrawal requests

/*
 * Taking money out of a pot is asked for rather than done.
 *
 * Paying in is the client's own money moving towards their own goal, so it happens on the
 * spot. Taking it back out is the act the pot exists to make deliberate, so it goes to the
 * desk: the client raises a request, nothing moves, and an admin decides. Both outcomes
 * are recorded with who decided and when.
 */

const requestBody = z.object({
  amount: z.number().positive().finite(),
  note: z.string().max(400).optional(),
});

app.post('/portfolios/:id/requests', { preHandler: trader }, async (req: any, reply) => {
  const body = requestBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [p] } = await c.query<{ id: string; name: string; currency: string; balance: number; status: string }>(
      'SELECT id, name, currency, balance, status FROM portfolios WHERE id = $1 AND client_id = $2',
      [req.params.id, req.principal.sub]);
    if (!p) return 'missing' as const;
    if (p.status !== 'open') return 'closed' as const;

    // Counted against what is already asked for, not only against the balance: three
    // requests for the whole pot would otherwise each look affordable on their own.
    const { rows: [{ pending }] } = await c.query<{ pending: number }>(
      `SELECT coalesce(sum(amount), 0) AS pending FROM portfolio_requests
        WHERE portfolio_id = $1 AND status = 'pending'`, [p.id]);
    if (body.data.amount + Number(pending) > Number(p.balance)) return 'insufficient' as const;

    const { rows: [request] } = await c.query(
      `INSERT INTO portfolio_requests (portfolio_id, client_id, amount, note)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [p.id, req.principal.sub, body.data.amount, body.data.note ?? null]);
    await logActivity(c, {
      client_id: req.principal.sub, kind: 'portfolio', actor: req.principal.sub,
      summary: `Requested ${body.data.amount} ${p.currency} out of ${p.name}`,
      ref_table: 'portfolio_requests', ref_id: String(request.id),
      data: { amount: body.data.amount, currency: p.currency, portfolio: p.name },
    });
    await notifyStaff(c, { roles: ['admin'] }, {
      kind: 'portfolio.request',
      title: `Withdrawal request: ${body.data.amount} ${p.currency}`,
      body: `From ${p.name}. Waiting on a decision.`,
      ref_table: 'clients', ref_id: req.principal.sub,
    });
    return request;
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such portfolio' });
  if (out === 'closed') return reply.code(409).send({ error: 'that portfolio is closed' });
  if (out === 'insufficient') {
    return reply.code(400).send({ error: 'that is more than the pot holds, counting requests already waiting' });
  }
  return reply.code(201).send(out);
});

/** The client's own requests, so they can see what they are waiting on. */
app.get('/me/portfolio-requests', { preHandler: trader }, async (req: any) =>
  (await pool.query(
    `SELECT r.*, p.name AS portfolio_name, p.currency
       FROM portfolio_requests r JOIN portfolios p ON p.id = r.portfolio_id
      WHERE r.client_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [req.principal.sub])).rows);

/** Everything waiting on the desk, and what has been decided. */
app.get('/portfolio-requests', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({
    status: z.enum(['pending', 'approved', 'declined', 'all']).default('pending'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT r.*, p.name AS portfolio_name, p.currency, p.balance AS portfolio_balance,
            cl.name AS client_name
       FROM portfolio_requests r
       JOIN portfolios p ON p.id = r.portfolio_id
       JOIN clients cl ON cl.id = r.client_id
      WHERE ($1 = 'all' OR r.status = $1)
      ORDER BY r.created_at DESC LIMIT $2`, [q.status, q.limit]);
  return rows;
});

/**
 * The decision. Approving moves the money in the same transaction that records the
 * decision — a request marked approved with nothing moved would be the worst of both.
 */
app.post('/portfolio-requests/:id/decide', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = z.object({
    status: z.enum(['approved', 'declined']),
    note: z.string().max(400).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [r] } = await c.query<{
      id: number; portfolio_id: string; client_id: string; amount: number; status: string;
    }>('SELECT * FROM portfolio_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!r) return 'missing' as const;
    if (r.status !== 'pending') return 'decided' as const;

    const { rows: [p] } = await c.query<{ name: string; currency: string; balance: number }>(
      'SELECT name, currency, balance FROM portfolios WHERE id = $1 FOR UPDATE', [r.portfolio_id]);
    if (!p) return 'missing' as const;

    if (body.data.status === 'approved') {
      // Re-checked at the moment of approval: the balance may have moved since it was asked.
      if (Number(r.amount) > Number(p.balance)) return 'insufficient' as const;
      const ccy = (await currencies()).get(p.currency)!;
      const holding = await lockHolding(c, r.client_id, p.currency, ccy.kind, true);
      if (!holding) return 'no-holding' as const;
      await moveBalance(c, holding, Number(r.amount));
      await c.query('UPDATE portfolios SET balance = balance - $2 WHERE id = $1', [r.portfolio_id, r.amount]);
      await c.query(
        `INSERT INTO portfolio_transactions (portfolio_id, client_id, kind, amount, note)
         VALUES ($1,$2,'withdrawal',$3,$4)`,
        [r.portfolio_id, r.client_id, -Number(r.amount), body.data.note ?? 'Approved by the desk']);
    }

    await c.query(
      `UPDATE portfolio_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE id = $1`, [r.id, body.data.status, req.principal.sub, body.data.note ?? null]);

    await logActivity(c, {
      client_id: r.client_id, kind: 'portfolio', actor: req.principal.sub,
      summary: `${body.data.status === 'approved' ? 'Approved' : 'Declined'} `
        + `${r.amount} ${p.currency} out of ${p.name}`
        + (body.data.note ? ` — ${body.data.note}` : ''),
      ref_table: 'portfolio_requests', ref_id: String(r.id),
    });
    await notifyClientOf(c, {
      client_id: r.client_id, kind: 'portfolio.request',
      title: body.data.status === 'approved'
        ? `${r.amount} ${p.currency} released from ${p.name}`
        : `Your request on ${p.name} was declined`,
      body: body.data.note ?? (body.data.status === 'approved'
        ? 'It is back in your balance.'
        : 'Open a ticket if you would like to talk it through.'),
      ref_table: 'portfolio_requests', ref_id: String(r.id),
    });
    return { id: r.id, status: body.data.status, amount: Number(r.amount), currency: p.currency };
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such request' });
  if (out === 'decided') return reply.code(409).send({ error: 'that request has already been decided' });
  if (out === 'insufficient') return reply.code(422).send({ error: 'the pot no longer holds that much' });
  if (out === 'no-holding') return reply.code(500).send({ error: 'could not open a balance to release it into' });
  return out;
});

/** Which pot the client wants on their balance strip. At most one. */
app.post('/portfolios/:id/feature', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({ featured: z.boolean() }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const out = await tx(req.principal.sub, async (c) => {
    const { rowCount } = await c.query(
      'SELECT 1 FROM portfolios WHERE id = $1 AND client_id = $2', [req.params.id, req.principal.sub]);
    if (!rowCount) return null;
    // Cleared first: the unique index allows one per client, so setting a second without
    // clearing the first would be refused by the database rather than replacing it.
    await c.query('UPDATE portfolios SET featured = false WHERE client_id = $1', [req.principal.sub]);
    if (body.data.featured) {
      await c.query('UPDATE portfolios SET featured = true WHERE id = $1', [req.params.id]);
    }
    return { featured: body.data.featured };
  });
  if (!out) return reply.code(404).send({ error: 'no such portfolio' });
  return out;
});

// ------------------------------------------------------------------ auto trader
/*
 * A bot that trades the client's own demo account through the same book as their hand.
 *
 * Every order it places is an order: it fills through fillOrder, moves the position,
 * realises onto the balance and lands on the timeline. What marks it as the bot's is
 * `source = 'auto'`, the strategy that decided it and the reason it gave. A bot trade is
 * an entry order with a stop and a target attached; the book turns those into two resting
 * exits, and whichever fills closes the trade. The bot itself closes a trade only when its
 * own signal reverses, and it does that with a market order that points at the entry as
 * its parent — so the pairing of entry to exit is a join, not a guess.
 *
 * Money is capped three ways: risk per trade against the bot's equity, notional against
 * the strategy's allocation times leverage, and a daily loss budget that closes everything
 * and halts new entries until tomorrow. The kill switch does the first two of those on
 * demand and switches the bot off.
 */

const AUTO_TICK_MS = 10_000;              // how often every running bot is evaluated
const AUTO_COOLDOWN_MS = 45_000;          // after an exit, no re-entry in that symbol for a while
const AUTO_BANK_R = 0.005;                // ahead by this much of its risk, a trade is a win worth banking
const AUTO_MIN_AGE_MS = 15_000;           // and it has to be at least this old
const AUTO_HISTORY = 60;                  // one-minute candles a strategy reads

type AutoSettings = {
  client_id: string; risk_per_trade: number; max_daily_loss: number; max_open_positions: number;
  max_leverage: number; started_at: Date | null; halted_until: string | null;
  target_win_rate: number | null;   // the desk's; never sent to the client
  record_since: Date | null;        // the desk's too: the record counts from here
};
type AutoStrategy = {
  id: string; client_id: string; kind: StrategyKind; name: string; symbols: string[];
  allocation: number; state: 'running' | 'paused'; created_at: Date;
};
type AutoOpen = {
  id: string; strategy_id: string | null; symbol: string; side: Direction; qty: number;
  price: number; fee: number; stop_loss: number | null; take_profit: number | null;
  reason: string | null; filled_at: Date;
};
type AutoClosed = AutoOpen & { exit_price: number; exit_fee: number; exit_at: Date; exit_type: string; exit_reason: string | null };

const asDirection = (side: string): Direction => (side === 'buy' ? 'long' : 'short');
const exitReason = (x: { exit_type: string; exit_reason: string | null }) =>
  x.exit_reason ?? (x.exit_type === 'limit' ? 'Take profit' : x.exit_type === 'stop' ? 'Stop loss' : 'Closed');

async function autoSettings(clientId: string): Promise<AutoSettings> {
  const { rows: [s] } = await pool.query<AutoSettings>(
    `INSERT INTO auto_settings (client_id) VALUES ($1)
     ON CONFLICT (client_id) DO UPDATE SET client_id = excluded.client_id RETURNING *`, [clientId]);
  return { ...s!, risk_per_trade: Number(s!.risk_per_trade), max_daily_loss: Number(s!.max_daily_loss),
    max_leverage: Number(s!.max_leverage),
    target_win_rate: s!.target_win_rate === null ? null : Number(s!.target_win_rate) };
}

/** The win rate the engine steers this client's record to: the desk's number for them, else the default. */
const autoTarget = (s: AutoSettings) => s.target_win_rate ?? DEFAULT_WIN_RATE;

async function autoLog(clientId: string, level: 'info' | 'trade' | 'win' | 'loss' | 'warn', message: string, strategyId: string | null = null) {
  await pool.query('INSERT INTO auto_log (client_id, strategy_id, level, message) VALUES ($1,$2,$3,$4)',
    [clientId, strategyId, level, message.slice(0, 500)]);
}

async function autoStrategies(clientId: string): Promise<AutoStrategy[]> {
  const { rows } = await pool.query<AutoStrategy>(
    'SELECT * FROM auto_strategies WHERE client_id = $1 ORDER BY created_at', [clientId]);
  return rows.map((s) => ({ ...s, allocation: Number(s.allocation) }));
}

/** Bot entries that have filled and whose exits have not: what the bot is holding. */
async function autoOpenTrades(clientId: string): Promise<AutoOpen[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.strategy_id, e.symbol, e.side, e.qty, e.stop_loss, e.take_profit, e.reason,
            f.price, f.fee, f.filled_at
       FROM orders e JOIN fills f ON f.order_id = e.id
      WHERE e.client_id = $1 AND e.source = 'auto' AND e.parent_order_id IS NULL AND e.status = 'filled'
        AND NOT EXISTS (SELECT 1 FROM orders x WHERE x.parent_order_id = e.id AND x.status = 'filled')
      ORDER BY f.filled_at DESC`, [clientId]);
  return rows.map((r) => ({ ...r, side: asDirection(r.side), qty: Number(r.qty), price: Number(r.price), fee: Number(r.fee),
    stop_loss: r.stop_loss === null ? null : Number(r.stop_loss), take_profit: r.take_profit === null ? null : Number(r.take_profit) }));
}

/** Bot entries paired with the exit that closed them — since the record was last started, if it was. */
async function autoClosedTrades(clientId: string, since: Date | null = null, limit = 500): Promise<AutoClosed[]> {
  const { rows } = await pool.query(
    `SELECT e.id, e.strategy_id, e.symbol, e.side, e.qty, e.stop_loss, e.take_profit, e.reason,
            f.price, f.fee, f.filled_at,
            x.type AS exit_type, x.reason AS exit_reason, xf.price AS exit_price, xf.fee AS exit_fee, xf.filled_at AS exit_at
       FROM orders e
       JOIN fills f   ON f.order_id = e.id
       JOIN orders x  ON x.parent_order_id = e.id AND x.status = 'filled'
       JOIN fills xf  ON xf.order_id = x.id
      WHERE e.client_id = $1 AND e.source = 'auto' AND e.parent_order_id IS NULL
        AND ($3::timestamptz IS NULL OR xf.filled_at >= $3)
      ORDER BY xf.filled_at DESC LIMIT $2`, [clientId, limit, since]);
  return rows.map((r) => ({ ...r, side: asDirection(r.side), qty: Number(r.qty), price: Number(r.price), fee: Number(r.fee),
    stop_loss: r.stop_loss === null ? null : Number(r.stop_loss), take_profit: r.take_profit === null ? null : Number(r.take_profit),
    exit_price: Number(r.exit_price), exit_fee: Number(r.exit_fee) }));
}

/** Place one of the bot's orders and fill it now, the way a market order from the ticket fills. */
async function autoOrder(clientId: string, accountId: string, o: {
  symbol: string; side: Side; qty: number; take_profit?: number | null; stop_loss?: number | null;
  strategy_id: string | null; reason: string; parent_order_id?: string | null;
}): Promise<OrderRow> {
  const order = await tx('engine', async (c) => {
    const { rows } = await c.query<OrderRow>(
      `INSERT INTO orders (account_id, client_id, symbol, side, type, qty, take_profit, stop_loss,
                           status, source, strategy_id, reason, parent_order_id)
       VALUES ($1,$2,$3,$4,'market',$5,$6,$7,'working','auto',$8,$9,$10) RETURNING *`,
      [accountId, clientId, o.symbol, o.side, o.qty, o.take_profit ?? null, o.stop_loss ?? null,
       o.strategy_id, o.reason, o.parent_order_id ?? null]);
    await logActivity(c, {
      client_id: clientId, kind: 'order.placed', actor: 'engine',
      summary: `Auto trader placed ${o.side} ${o.qty} ${o.symbol} — ${o.reason}`,
      ref_table: 'orders', ref_id: rows[0]!.id, data: { ...o, source: 'auto' },
    });
    return rows[0]!;
  });
  notify(clientId, { type: 'order', order });
  await fillOrder(order, spot(order.symbol));
  return order;
}

/** What the fill for one order came to, read back after fillOrder. */
async function fillOf(orderId: string): Promise<{ price: number; fee: number } | null> {
  const { rows: [f] } = await pool.query('SELECT price, fee FROM fills WHERE order_id = $1', [orderId]);
  return f ? { price: Number(f.price), fee: Number(f.fee) } : null;
}

const money2 = (n: number) => (n < 0 ? '-' : '+') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/** Close one bot trade at market, pointing the close at its entry so the pair is a join. */
async function autoClose(clientId: string, accountId: string, t: AutoOpen, reason: string) {
  const close = await autoOrder(clientId, accountId, {
    symbol: t.symbol, side: t.side === 'long' ? 'sell' : 'buy', qty: t.qty,
    strategy_id: t.strategy_id, reason, parent_order_id: t.id,
  });
  const f = await fillOf(close.id);
  if (!f) return;
  const p = pairTrade({ side: t.side, qty: t.qty, price: t.price, fee: t.fee, stop: t.stop_loss }, f);
  await autoLog(clientId, p.net >= 0 ? 'win' : 'loss',
    `${reason} ${t.symbol} ${money2(p.net)}${p.r !== null ? ` · ${p.r >= 0 ? '+' : ''}${p.r.toFixed(1)}R` : ''}`, t.strategy_id);
}

const autoWarned = new Map<string, number>();
/** A warning the bot would otherwise repeat every ten seconds, said once an hour. */
async function autoWarn(clientId: string, key: string, message: string) {
  const k = `${clientId}:${key}`;
  const last = autoWarned.get(k) ?? 0;
  if (Date.now() - last < 60 * 60_000) return;
  autoWarned.set(k, Date.now());
  await autoLog(clientId, 'warn', message);
}

/** One pass for one client: manage exits, honour the budgets, look for entries. */
async function autoTickClient(clientId: string) {
  // A switch left on from before the bot was real has no strategies behind it. Set it up
  // rather than ticking over an empty list forever.
  if (!(await autoStrategies(clientId)).length) await autoSetup(clientId);
  const settings = await autoSettings(clientId);
  const [strategies, account, open, closed] = await Promise.all([
    autoStrategies(clientId), demoAccount(clientId),
    autoOpenTrades(clientId), autoClosedTrades(clientId, settings.record_since),
  ]);
  const allocated = strategies.reduce((a, s) => a + s.allocation, 0);
  const realised = closed.reduce((a, c) => a + pairTrade({ side: c.side, qty: c.qty, price: c.price, fee: c.fee, stop: c.stop_loss }, { price: c.exit_price, fee: c.exit_fee }).net, 0);
  // What a trade would actually net if closed now: at the price the client gets, which
  // carries their spread, less both commissions. Estimating from the mid banked "wins" that
  // landed a few cents under water once the fill went through.
  const { rows: [termRow] } = await pool.query<{ commission_bps: number | null; spread_bps: number | null }>(
    'SELECT commission_bps, spread_bps FROM clients WHERE id = $1', [clientId]);
  const terms = termsOf(termRow ?? null);
  const netIfClosed = (t: AutoOpen, mark: number) => {
    const px = executionPrice(mark, t.side === 'long' ? 'sell' : 'buy', terms);
    return (px - t.price) * t.qty * (t.side === 'long' ? 1 : -1) - t.fee - commission(t.qty, px, terms);
  };
  const unrealised = open.reduce((a, t) => a + (spot(t.symbol) - t.price) * t.qty * (t.side === 'long' ? 1 : -1), 0);
  const equity = allocated + realised + unrealised;
  const today = startOfToday();
  // Realised only. Losers are held on purpose, so an unrealised dip is the steer doing its
  // job; counting it here would have the budget dump every held position as a loss — the
  // one outcome the whole arrangement exists to avoid. Each position still has its stop.
  const todayNet = closed.filter((c) => new Date(c.exit_at) >= today)
    .reduce((a, c) => a + pairTrade({ side: c.side, qty: c.qty, price: c.price, fee: c.fee, stop: c.stop_loss }, { price: c.exit_price, fee: c.exit_fee }).net, 0);

  // The daily budget: when it is spent, everything closes and nothing new opens today.
  const halted = settings.halted_until !== null && new Date(settings.halted_until) >= today;
  const budget = equity > 0 ? equity * settings.max_daily_loss / 100 : 0;
  if (!halted && budget > 0 && todayNet <= -budget) {
    for (const t of open) await autoClose(clientId, account.id, t, 'Daily loss limit');
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    await pool.query('UPDATE auto_settings SET halted_until = $2 WHERE client_id = $1', [clientId, tomorrow.toISOString().slice(0, 10)]);
    await autoLog(clientId, 'warn', `Daily loss limit reached (${money2(todayNet)} against a ${settings.max_daily_loss}% budget) · closed everything · no new entries until tomorrow`);
    return;
  }

  // Exits the strategies decide themselves. The stop and the target are the book's job.
  // Anything closed in this pass is remembered, because the closed list above was read
  // before the pass began and the cooldown below would otherwise let the same symbol be
  // re-entered a moment after it was banked.
  let holding = [...open];
  const justClosed = new Set<string>();
  for (const t of open) {
    const s = strategies.find((x) => x.id === t.strategy_id);
    if (!s) continue;
    const sig = evaluate(s.kind, candles(t.symbol, '1m', AUTO_HISTORY), t.side);
    if (sig.action !== 'exit') continue;
    // A signal reversing is a reason to leave — when leaving is a win. Behind, the trade is
    // held for its target instead: a strategy that closed every reversal at a loss was
    // writing four losses for every win, whatever the steer did afterwards.
    const mark = spot(t.symbol);
    const unreal = netIfClosed(t, mark);
    const risk = t.stop_loss === null ? 0 : Math.abs(t.price - t.stop_loss) * t.qty;
    if (!(risk > 0) || unreal < AUTO_BANK_R * risk) continue;
    await autoClose(clientId, account.id, t, sig.reason);
    holding = holding.filter((h) => h.id !== t.id);
    justClosed.add(`${t.strategy_id}:${t.symbol}`);
  }
  // The desk's steer: when a target win rate is set, close ahead-of-risk trades as wins while
  // the record is below it, and behind-of-risk trades as losses while it is above. Inside the
  // book's own stop and target, on real prices; only the timing is the desk's.
  {
    const target = autoTarget(settings);
    let wins = closed.filter((c) => pairTrade({ side: c.side, qty: c.qty, price: c.price, fee: c.fee, stop: c.stop_loss }, { price: c.exit_price, fee: c.exit_fee }).net > 0).length;
    let count = closed.length;
    for (const t of [...holding]) {
      const mark = spot(t.symbol);
      const unreal = netIfClosed(t, mark);
      const risk = t.stop_loss === null ? 0 : Math.abs(t.price - t.stop_loss) * t.qty;
      const s = steer({ target, wins, closed: count, unrealised: unreal, risk,
        ageMs: Date.now() - new Date(t.filled_at).getTime(), minAgeMs: AUTO_MIN_AGE_MS, bankR: AUTO_BANK_R });
      if (!s) continue;
      await autoClose(clientId, account.id, t, s.close === 'win' ? 'Take profit' : 'Stop loss');
      holding = holding.filter((h) => h.id !== t.id);
      justClosed.add(`${t.strategy_id}:${t.symbol}`);
      count++; if (s.close === 'win') wins++;
    }
  }
  if (halted) return;

  // Entries.
  const balance = Number(account.balance);
  if (!(balance > 0)) { await autoWarn(clientId, 'nofunds', 'The account has no balance to trade with · fund it to let the bot work'); return; }
  const totalNotional = () => holding.reduce((a, t) => a + t.qty * t.price, 0);
  for (const s of strategies) {
    if (s.state !== 'running') continue;
    if (!(s.allocation > 0)) { await autoWarn(clientId, `alloc:${s.id}`, `${s.name} has no allocation · give it some of the account to trade with`); continue; }
    for (const symbol of s.symbols) {
      if (holding.length >= settings.max_open_positions) {
        await autoWarn(clientId, 'maxopen', `At the open-position limit (${settings.max_open_positions}) · skipping new entries`);
        return;
      }
      if (holding.some((t) => t.strategy_id === s.id && t.symbol === symbol)) continue;
      if (justClosed.has(`${s.id}:${symbol}`)) continue;
      const lastExit = closed.find((c) => c.strategy_id === s.id && c.symbol === symbol);
      if (lastExit && Date.now() - new Date(lastExit.exit_at).getTime() < AUTO_COOLDOWN_MS) continue;
      if (!await knownSymbol(symbol)) continue;

      const sig = evaluate(s.kind, candles(symbol, '1m', AUTO_HISTORY), null);
      if (sig.action !== 'enter') continue;
      const price = spot(symbol);
      // Each symbol gets an equal slice of what the strategy may carry, so the first trade
      // cannot spend the whole allocation and leave the others sized to dust — which is
      // what happened when the cap was shared: one bitcoin position took all of it and
      // the ether entry behind it was worth a dollar and a half.
      const stratCap = s.allocation * settings.max_leverage;
      const stratNotional = holding.filter((t) => t.strategy_id === s.id).reduce((a, t) => a + t.qty * t.price, 0);
      const maxNotional = Math.min(
        stratCap / s.symbols.length,
        stratCap - stratNotional,
        balance * settings.max_leverage - totalNotional(),
      );
      // The stop sits three times as far out as the strategy asked, because the record is
      // steered: a loser is held for the price to come back rather than cut, and a tight
      // stop would take that decision away from the steer. Risk per trade is still the
      // budget — it is measured against this stop, so the position is smaller for it.
      const stop = round8(sig.side === 'long' ? price - (price - sig.stop) * 3 : price + (sig.stop - price) * 3);
      const qty = sizeFor({
        riskUsd: equity * settings.risk_per_trade / 100, price, stop, maxNotional,
        minNotional: s.allocation * 0.01,
      });
      if (!qty) continue;
      const order = await autoOrder(clientId, account.id, {
        symbol, side: sig.side === 'long' ? 'buy' : 'sell', qty,
        take_profit: sig.target, stop_loss: stop, strategy_id: s.id, reason: sig.reason,
      });
      const f = await fillOf(order.id);
      holding.push({ id: order.id, strategy_id: s.id, symbol, side: sig.side, qty, price: f?.price ?? price, fee: f?.fee ?? 0,
        stop_loss: stop, take_profit: sig.target, reason: sig.reason, filled_at: new Date() });
      await autoLog(clientId, 'trade',
        `${sig.side === 'long' ? 'BUY' : 'SELL'} ${symbol} ${qty} @ ${f?.price ?? price} · ${s.name} · ${sig.reason} · confidence ${sig.confidence.toFixed(2)}`, s.id);
    }
  }
}

let autoTicking = false;
/** Every running bot, one after another, never two passes at once. */
async function autoTick() {
  if (autoTicking) return;
  autoTicking = true;
  try {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM clients WHERE auto_trader');
    for (const r of rows) {
      await autoTickClient(r.id).catch((err: unknown) => app.log.error({ err, client: r.id }, 'auto trader pass failed'));
    }
  } finally {
    autoTicking = false;
  }
}

let autoTimer: NodeJS.Timeout | null = null;
function startAutoTrader() {
  if (autoTimer) return;
  autoTimer = setInterval(() => { autoTick().catch((err: unknown) => app.log.error({ err }, 'auto trader tick failed')); }, AUTO_TICK_MS);
}

/** Everything the page shows, computed from the book. */
async function autoDashboard(clientId: string) {
  const settings = await autoSettings(clientId);
  const [strategies, account, open, closed, me] = await Promise.all([
    autoStrategies(clientId), demoAccount(clientId),
    autoOpenTrades(clientId), autoClosedTrades(clientId, settings.record_since),
    pool.query<{ auto_trader: boolean }>('SELECT auto_trader FROM clients WHERE id = $1', [clientId]),
  ]);
  const { rows: log } = await pool.query(
    'SELECT id, strategy_id, at, level, message FROM auto_log WHERE client_id = $1 ORDER BY at DESC, id DESC LIMIT 40', [clientId]);
  const pair = (c: AutoClosed) => pairTrade({ side: c.side, qty: c.qty, price: c.price, fee: c.fee, stop: c.stop_loss }, { price: c.exit_price, fee: c.exit_fee });
  const allocated = strategies.reduce((a, s) => a + s.allocation, 0);
  const positions = open.map((t) => {
    const mark = spot(t.symbol);
    const s = strategies.find((x) => x.id === t.strategy_id);
    return {
      id: t.id, symbol: t.symbol, side: t.side, qty: t.qty, entry: t.price, mark,
      stop_loss: t.stop_loss, take_profit: t.take_profit,
      unrealised: round8((mark - t.price) * t.qty * (t.side === 'long' ? 1 : -1)),
      strategy: s?.name ?? null, strategy_id: t.strategy_id, opened_at: t.filled_at, reason: t.reason,
    };
  });
  const unrealised = round8(positions.reduce((a, p) => a + p.unrealised, 0));
  const closedRows = closed.map((c) => ({ c, p: pair(c) }));
  const st = botStats(closedRows.map(({ c, p }) => ({ net: p.net, r: p.r, at: new Date(c.exit_at) })), allocated, unrealised);
  const today = startOfToday();
  const todays = closedRows.filter(({ c }) => new Date(c.exit_at) >= today);
  const perStrategy = strategies.map((s) => {
    const mine = closedRows.filter(({ c }) => c.strategy_id === s.id);
    const wins = mine.filter(({ p }) => p.net > 0).length;
    return {
      ...s, about: STRATEGIES[s.kind].about,
      open: open.filter((t) => t.strategy_id === s.id).length,
      realised: round8(mine.reduce((a, { p }) => a + p.net, 0)),
      closed: mine.length, win_rate: mine.length ? round8(wins / mine.length) : null,
    };
  });
  const since = settings.record_since ? new Date(settings.record_since) : settings.started_at ? new Date(settings.started_at) : null;
  return {
    on: me.rows[0]?.auto_trader ?? false,
    since,
    halted_until: settings.halted_until,
    settings: {
      risk_per_trade: settings.risk_per_trade, max_daily_loss: settings.max_daily_loss,
      max_open_positions: settings.max_open_positions, max_leverage: settings.max_leverage,
    },
    account: { balance: Number(account.balance), currency: account.currency },
    strategies: perStrategy,
    kpis: {
      equity: st.equity, allocated: round8(allocated), realised: st.realised, unrealised,
      return_pct: allocated > 0 ? round8((st.equity - allocated) / allocated) : null,
      today_net: round8(todays.reduce((a, { p }) => a + p.net, 0) + unrealised),
      today_realised: round8(todays.reduce((a, { p }) => a + p.net, 0)),
      today_trades: todays.length,
      today_fees: round8(todays.reduce((a, { c }) => a + c.fee + c.exit_fee, 0)),
      wins: st.wins, losses: st.losses, closed: st.closed, win_rate: st.win_rate,
      profit_factor: st.profit_factor, avg_win_r: st.avg_win_r, avg_loss_r: st.avg_loss_r,
      max_drawdown: st.max_drawdown, drawdown_at: st.drawdown_at, open: open.length,
      daily_loss_used: (() => { const b = st.equity > 0 ? st.equity * settings.max_daily_loss / 100 : 0; const used = -Math.min(0, todays.reduce((a, { p }) => a + p.net, 0) + unrealised); return b > 0 ? round8(Math.min(1, used / b)) : 0; })(),
    },
    curve: [{ at: since ?? new Date(), equity: round8(allocated) }, ...st.curve],
    positions,
    closed: closedRows.slice(0, 30).map(({ c, p }) => ({
      id: c.id, symbol: c.symbol, side: c.side, qty: c.qty, entry: c.price, exit: c.exit_price,
      net: p.net, r: p.r, fees: round8(c.fee + c.exit_fee),
      strategy: strategies.find((x) => x.id === c.strategy_id)?.name ?? null,
      exit_reason: exitReason(c), opened_at: c.filled_at, closed_at: c.exit_at,
    })),
    log,
  };
}

app.get('/me/auto-trader', { preHandler: trader }, async (req: any) => autoDashboard(req.principal.sub));

/**
 * The switch. Turning it on for the first time sets the bot up with the three standard
 * strategies, each given a share of the account to work with. Turning it off stops new
 * entries; what is open keeps its stop and its target, because pulling those would leave
 * a position with no exit at all.
 */
app.post('/me/auto-trader', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({ on: z.boolean() }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  await autoSwitch(req.principal.sub, body.data.on, req.principal.sub);
  return reply.send({ on: body.data.on });
});

/** The switch itself, shared by the client's own page and the desk. */
async function autoSwitch(clientId: string, on: boolean, actor: string) {
  await tx(actor, async (c) => {
    await c.query('UPDATE clients SET auto_trader = $2 WHERE id = $1', [clientId, on]);
    await logActivity(c, {
      client_id: clientId, kind: 'note', actor,
      summary: `Auto trader switched ${on ? 'on' : 'off'}${actor === clientId ? '' : ' by the desk'}`,
    });
  });
  if (on) {
    await autoSetup(clientId);
    await autoLog(clientId, 'info', 'Switched on');
  } else {
    await autoLog(clientId, 'info', 'Switched off · open positions keep their stops and targets');
  }
}

/**
 * The bot's first day: settings, a start time, and the three standard strategies with a
 * share of the account each. Idempotent, and run from the engine as well as the switch —
 * a client whose switch was already on before the bot became real would otherwise sit
 * "running" with nothing to run.
 */
async function autoSetup(clientId: string) {
  await autoSettings(clientId);
  await pool.query('UPDATE auto_settings SET started_at = coalesce(started_at, now()) WHERE client_id = $1', [clientId]);
  const existing = await autoStrategies(clientId);
  if (existing.length) return;
  const account = await demoAccount(clientId);
  const balance = Number(account.balance);
  for (const [kind, def] of Object.entries(STRATEGIES) as [StrategyKind, typeof STRATEGIES[StrategyKind]][]) {
    await pool.query(
      'INSERT INTO auto_strategies (client_id, kind, name, symbols, allocation) VALUES ($1,$2,$3,$4,$5)',
      [clientId, kind, def.name, def.symbols, round8(Math.max(0, balance * def.share))]);
  }
  await autoLog(clientId, 'info', balance > 0
    ? `Set up three strategies with ${money2(balance * 0.5).slice(1)} of the account allocated`
    : 'Set up three strategies · fund the account to give them something to trade with');
}

/**
 * The desk's view of a client's bot, and its hand on it.
 *
 * Anyone who can read the CRM can see what the bot is doing for a client — it is part of
 * their money. Only an admin can set the target win rate or throw the switch for them, and
 * the target is returned here and nowhere else: the client's own page never carries it.
 */
app.get('/clients/:id/auto-trader', { preHandler: auth('crm:read') }, async (req: any, reply) => {
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });
  const [dash, settings] = await Promise.all([autoDashboard(req.params.id), autoSettings(req.params.id)]);
  return { ...dash, desk: { target_win_rate: autoTarget(settings), default: DEFAULT_WIN_RATE, custom: settings.target_win_rate !== null, record_since: settings.record_since } };
});

app.patch('/clients/:id/auto-trader', { preHandler: auth('admin') }, async (req: any, reply) => {
  // Any rate the desk wants for this client; null goes back to the default.
  const body = z.object({
    target_win_rate: z.number().min(0).max(1).nullable().optional(),
    on: z.boolean().optional(),
    reset_record: z.literal(true).optional(),
    // The client's own controls, reachable from the desk too: how much the bot may carry,
    // and what each strategy covers.
    settings: autoSettingsBody.optional(),
    strategies: z.array(z.object({
      id: z.string().uuid(),
      symbols: z.array(z.string().max(20)).min(1).max(12).optional(),
      allocation: z.number().min(0).max(1e9).optional(),
      state: z.enum(['running', 'paused']).optional(),
    })).max(20).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { rowCount } = await pool.query('SELECT 1 FROM clients WHERE id = $1', [req.params.id]);
  if (!rowCount) return reply.code(404).send({ error: 'no such client' });
  const clientId = req.params.id;
  const target = body.data.target_win_rate;
  if (target !== undefined) {
    await autoSettings(clientId);
    await tx(req.principal.sub, (c) => c.query(
      'UPDATE auto_settings SET target_win_rate = $2 WHERE client_id = $1', [clientId, target]));
    // Written to the audit trail through auto_settings' trigger, and to the CRM timeline; not
    // to the bot's own log, which the client reads.
    await tx(req.principal.sub, (c) => logActivity(c, {
      client_id: clientId, kind: 'note', actor: req.principal.sub,
      summary: target === null
        ? `Auto trader target win rate back to the ${Math.round(DEFAULT_WIN_RATE * 100)}% default`
        : `Auto trader target win rate set to ${Math.round(target * 100)}%`,
    }));
  }
  if (body.data.reset_record) {
    // Nothing in the book changes: every fill stays, every balance movement stays. Only
    // what the record counts from moves, and the timeline says who moved it.
    await autoSettings(clientId);
    await tx(req.principal.sub, async (c) => {
      await c.query('UPDATE auto_settings SET record_since = now() WHERE client_id = $1', [clientId]);
      await logActivity(c, { client_id: clientId, kind: 'note', actor: req.principal.sub, summary: 'Auto trader record started again by the desk' });
    });
  }
  if (body.data.settings) {
    await autoSettings(clientId);
    const entries = Object.entries(body.data.settings);
    if (entries.length) {
      await tx(req.principal.sub, (c) => c.query(
        `UPDATE auto_settings SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE client_id = $1`,
        [clientId, ...entries.map(([, v]) => v)]));
      await autoLog(clientId, 'info', `Risk controls changed · ${entries.map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · ')}`);
    }
  }
  for (const s of body.data.strategies ?? []) {
    if (s.symbols) for (const sym of s.symbols) if (!await knownSymbol(sym)) return reply.code(404).send({ error: `unknown symbol ${sym}` });
    const entries = Object.entries(s).filter(([k]) => k !== 'id');
    if (!entries.length) continue;
    const { rows: [after] } = await tx(req.principal.sub, (c) => c.query<AutoStrategy>(
      `UPDATE auto_strategies SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}
        WHERE id = $1 AND client_id = $2 RETURNING *`,
      [s.id, clientId, ...entries.map(([, v]) => v)]));
    if (!after) return reply.code(404).send({ error: `no such strategy ${s.id}` });
    await autoLog(clientId, 'info', `${after.name} · ${entries.map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}`, after.id);
  }
  if (body.data.on !== undefined) await autoSwitch(clientId, body.data.on, req.principal.sub);
  const [dash, settings] = await Promise.all([autoDashboard(clientId), autoSettings(clientId)]);
  return { ...dash, desk: { target_win_rate: autoTarget(settings), default: DEFAULT_WIN_RATE, custom: settings.target_win_rate !== null, record_since: settings.record_since } };
});

/** Evaluate now rather than at the next tick. Harmless: it does what the tick does. */
app.post('/me/auto-trader/tick', { preHandler: trader }, async (req: any) => {
  const { rows: [me] } = await pool.query<{ auto_trader: boolean }>('SELECT auto_trader FROM clients WHERE id = $1', [req.principal.sub]);
  if (me?.auto_trader) await autoTickClient(req.principal.sub);
  return autoDashboard(req.principal.sub);
});

const autoSettingsBody = z.object({
  risk_per_trade: z.number().min(0.1).max(5).optional(),
  max_daily_loss: z.number().min(0.5).max(20).optional(),
  max_open_positions: z.number().int().min(1).max(20).optional(),
  max_leverage: z.number().min(1).max(50).optional(),
}).refine((o) => Object.keys(o).length > 0, 'nothing to change');

app.patch('/me/auto-trader/settings', { preHandler: trader }, async (req: any, reply) => {
  const body = autoSettingsBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  await autoSettings(req.principal.sub);
  const entries = Object.entries(body.data);
  await tx(req.principal.sub, (c) => c.query(
    `UPDATE auto_settings SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE client_id = $1`,
    [req.principal.sub, ...entries.map(([, v]) => v)]));
  await autoLog(req.principal.sub, 'info', `Risk controls changed · ${entries.map(([k, v]) => `${k.replaceAll('_', ' ')} ${v}`).join(' · ')}`);
  return autoDashboard(req.principal.sub);
});

const strategyBody = z.object({
  kind: z.enum(['trend', 'mean_reversion', 'grid']),
  name: z.string().min(1).max(60).optional(),
  symbols: z.array(z.string().max(20)).min(1).max(6).optional(),
  allocation: z.number().min(0).max(1e9),
});

app.post('/me/auto-trader/strategies', { preHandler: trader }, async (req: any, reply) => {
  const body = strategyBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  const symbols = b.symbols ?? STRATEGIES[b.kind].symbols;
  for (const s of symbols) if (!await knownSymbol(s)) return reply.code(404).send({ error: `unknown symbol ${s}` });
  const { rows: [made] } = await tx(req.principal.sub, (c) => c.query<AutoStrategy>(
    'INSERT INTO auto_strategies (client_id, kind, name, symbols, allocation) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.principal.sub, b.kind, b.name ?? STRATEGIES[b.kind].name, symbols, b.allocation]));
  await autoLog(req.principal.sub, 'info', `Added ${made!.name} on ${symbols.join(', ')}`, made!.id);
  return reply.code(201).send(made);
});

app.patch('/me/auto-trader/strategies/:id', { preHandler: trader }, async (req: any, reply) => {
  const body = z.object({
    state: z.enum(['running', 'paused']).optional(),
    allocation: z.number().min(0).max(1e9).optional(),
    symbols: z.array(z.string().max(20)).min(1).max(6).optional(),
    name: z.string().min(1).max(60).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (body.data.symbols) for (const s of body.data.symbols) if (!await knownSymbol(s)) return reply.code(404).send({ error: `unknown symbol ${s}` });
  const entries = Object.entries(body.data);
  const { rows: [after] } = await tx(req.principal.sub, (c) => c.query<AutoStrategy>(
    `UPDATE auto_strategies SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}
      WHERE id = $1 AND client_id = $2 RETURNING *`,
    [req.params.id, req.principal.sub, ...entries.map(([, v]) => v)]));
  if (!after) return reply.code(404).send({ error: 'no such strategy' });
  await autoLog(req.principal.sub, 'info', `${after.name} · ${entries.map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}`, after.id);
  return after;
});

app.delete('/me/auto-trader/strategies/:id', { preHandler: trader }, async (req: any, reply) => {
  const open = (await autoOpenTrades(req.principal.sub)).some((t) => t.strategy_id === req.params.id);
  if (open) return reply.code(409).send({ error: 'this strategy still has a position open — pause it, or close the position first' });
  const { rowCount } = await tx(req.principal.sub, (c) => c.query(
    'DELETE FROM auto_strategies WHERE id = $1 AND client_id = $2', [req.params.id, req.principal.sub]));
  if (!rowCount) return reply.code(404).send({ error: 'no such strategy' });
  return { ok: true };
});

/** Close everything the bot holds, cancel what it has resting, and switch it off. */
app.post('/me/auto-trader/kill', { preHandler: trader }, async (req: any) => {
  const clientId = req.principal.sub;
  const account = await demoAccount(clientId);
  const open = await autoOpenTrades(clientId);
  for (const t of open) await autoClose(clientId, account.id, t, 'Kill switch');
  await tx(clientId, async (c) => {
    await c.query(`UPDATE orders SET status = 'cancelled' WHERE client_id = $1 AND source = 'auto' AND status IN ('new','working')`, [clientId]);
    await c.query('UPDATE clients SET auto_trader = false WHERE id = $1', [clientId]);
    await logActivity(c, { client_id: clientId, kind: 'note', actor: clientId, summary: `Auto trader kill switch: closed ${open.length} position${open.length === 1 ? '' : 's'} and stopped` });
  });
  await autoLog(clientId, 'warn', `Kill switch · closed ${open.length} position${open.length === 1 ? '' : 's'} · stopped`);
  return autoDashboard(clientId);
});

app.get('/portfolios/:id/transactions', { preHandler: auth() }, async (req: any, reply) => {
  // A client sees their own; staff see whoever's they are looking at. Scoped by the
  // portfolio's owner either way, so naming somebody else's id gets nothing back rather
  // than somebody else's history.
  const { rows: [owner] } = await pool.query<{ client_id: string }>(
    'SELECT client_id FROM portfolios WHERE id = $1', [req.params.id]);
  if (!owner) return reply.code(404).send({ error: 'no such portfolio' });
  const own = req.principal.kind === 'client' && req.principal.sub === owner.client_id;
  if (!own && !can(req.principal.role, 'crm:read')) return reply.code(403).send({ error: 'forbidden' });

  return (await pool.query(
    `SELECT t.* FROM portfolio_transactions t
      WHERE t.portfolio_id = $1 ORDER BY t.at DESC LIMIT 200`, [req.params.id])).rows;
});

// ---------------------------------------------------------------- staking

/*
 * Locking crypto for a term and earning a yield in the same asset.
 *
 * The same shape as portfolios, and for the same reasons: a catalogue the desk offers, a
 * position the client opens against one, and a rate the desk can agree on that one
 * position without moving the product everybody else holds. What differs is that the
 * asset comes out of a wallet rather than a cash account, and that a locked stake cannot
 * be taken back before its date.
 *
 * Nothing here touches a chain. The asset moves between two rows the platform already
 * keeps for this client, exactly as a portfolio contribution does.
 */

type StakeRow = {
  id: string; client_id: string; product_code: string; asset: string;
  amount: number; rewards: number; apy_override: number | null;
  status: string; staked_at: string; unlocks_at: string | null;
};

/** A rate as a person reads it: 7.25%, and 9% rather than 9.00%. */
const asPct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

/** The rate a stake actually pays: what was agreed on it, or the product's. */
const stakeApy = (s: { apy_override: number | null; apy: number }) =>
  Number(s.apy_override ?? s.apy);

app.get('/staking-products', { preHandler: auth() }, async () =>
  (await pool.query(
    `SELECT code, name, asset, description, apy, lock_days, min_amount
       FROM staking_products WHERE active ORDER BY sort_order`)).rows);

app.get('/stakes', async (req: any, reply) => {
  const clientId = await portfolioScope(req, reply);
  if (clientId === null) return reply.sent ? undefined : [];
  const { rows } = await pool.query(
    `SELECT s.*, p.name AS product_name, p.description, p.lock_days,
            p.apy AS product_apy, coalesce(s.apy_override, p.apy) AS apy
       FROM stakes s JOIN staking_products p ON p.code = s.product_code
      WHERE s.client_id = $1 ORDER BY s.status, s.staked_at DESC`, [clientId]);

  return Promise.all(rows.map(async (s) => {
    const rate = await rateToUsd(s.asset);
    return {
      ...s,
      // Valued for the client's own total; null rather than a guess when nothing prices it.
      usd_value: rate === null ? null : round8((Number(s.amount) + Number(s.rewards)) * rate),
      locked: s.unlocks_at !== null && new Date(s.unlocks_at) > new Date(),
      // What a full year at this rate would pay on what is in there now. A projection, and
      // the same arithmetic the accrual actually uses.
      projected_year: round8(accrue({
        balance: Number(s.amount), annualRate: stakeApy(s), days: 365,
      })),
    };
  }));
});

const stakeBody = z.object({
  client_id: z.string().uuid().optional(),
  product_code: z.string().min(2).max(30),
  amount: z.number().positive().finite(),
});

app.post('/stakes', { preHandler: auth() }, async (req: any, reply) => {
  const who = await portfolioSubject(req, reply);
  if (!who) return;
  const body = stakeBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { product_code, amount } = body.data;

  const { rows: [product] } = await pool.query<{
    code: string; name: string; asset: string; apy: number; lock_days: number; min_amount: number;
  }>('SELECT code, name, asset, apy, lock_days, min_amount FROM staking_products WHERE code = $1 AND active',
    [product_code]);
  if (!product) return reply.code(404).send({ error: 'no such staking product' });
  if (amount < Number(product.min_amount)) {
    return reply.code(400).send({ error: `the minimum for this product is ${product.min_amount} ${product.asset}` });
  }

  const out = await tx(req.principal.sub, async (c) => {
    // The asset leaves a wallet the client already holds. Never opened on the way in: you
    // cannot stake an asset you have none of, and creating an empty wallet to fail against
    // would leave litter behind every mistake.
    const wallet = await lockHolding(c, who.clientId, product.asset, 'crypto', false);
    if (!wallet) return 'no-wallet' as const;
    if (Number(wallet.balance) < amount) return 'insufficient' as const;

    await moveBalance(c, wallet, -amount);
    const { rows: [stake] } = await c.query<StakeRow>(
      `INSERT INTO stakes (client_id, product_code, asset, amount, unlocks_at)
       VALUES ($1,$2,$3,$4, CASE WHEN $5::int > 0 THEN now() + ($5 || ' days')::interval ELSE NULL END)
       RETURNING *`,
      [who.clientId, product.code, product.asset, amount, product.lock_days]);

    await logActivity(c, {
      client_id: who.clientId, kind: 'stake', actor: req.principal.sub,
      summary: `${who.onBehalf ? 'Desk staked' : 'Staked'} ${amount} ${product.asset} in ${product.name}`,
      ref_table: 'stakes', ref_id: stake.id,
      data: { product: product.code, amount, asset: product.asset, lock_days: product.lock_days },
    });
    // Somebody whose crypto was locked by the desk rather than by themselves should hear
    // about it from us before they notice the balance missing.
    if (who.onBehalf) {
      await notifyClientOf(c, {
        client_id: who.clientId, kind: 'stake',
        title: `${amount} ${product.asset} staked in ${product.name}`,
        body: product.lock_days
          ? `Locked for ${product.lock_days} days. Moved by the desk.`
          : 'Moved by the desk. Nothing is locked — unstake whenever you like.',
        ref_table: 'stakes', ref_id: stake.id,
      });
    }
    return stake;
  });

  if (out === 'no-wallet') return reply.code(400).send({ error: `no ${product.asset} wallet to stake from` });
  if (out === 'insufficient') return reply.code(400).send({ error: `not enough ${product.asset}` });
  return reply.code(201).send(out);
});

app.post('/stakes/:id/unstake', { preHandler: auth() }, async (req: any, reply) => {
  const who = await portfolioSubject(req, reply);
  if (!who) return;

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [s] } = await c.query<StakeRow & { product_name: string }>(
      `SELECT s.*, p.name AS product_name FROM stakes s
         JOIN staking_products p ON p.code = s.product_code
        WHERE s.id = $1 AND s.client_id = $2 FOR UPDATE OF s`, [req.params.id, who.clientId]);
    if (!s) return 'missing' as const;
    if (s.status !== 'active') return 'closed' as const;

    // A lock is a lock. The desk is not exempt: it is the client's agreement, not ours,
    // and an early exit is a change to it rather than a button.
    if (s.unlocks_at && new Date(s.unlocks_at) > new Date()) return 'locked' as const;

    const returned = round8(Number(s.amount) + Number(s.rewards));
    const wallet = await lockHolding(c, who.clientId, s.asset, 'crypto', true);
    if (!wallet) return 'no-wallet' as const;
    await moveBalance(c, wallet, returned);
    await c.query(
      `UPDATE stakes SET status = 'closed', amount = 0, rewards = 0, closed_at = now() WHERE id = $1`,
      [s.id]);

    await logActivity(c, {
      client_id: who.clientId, kind: 'stake', actor: req.principal.sub,
      summary: `${who.onBehalf ? 'Desk unstaked' : 'Unstaked'} ${returned} ${s.asset} from ${s.product_name}`,
      ref_table: 'stakes', ref_id: s.id,
      data: { returned, asset: s.asset, principal: Number(s.amount), rewards: Number(s.rewards) },
    });
    await notifyClientOf(c, {
      client_id: who.clientId, kind: 'stake',
      title: `${returned} ${s.asset} returned to your wallet`,
      body: `${s.amount} staked plus ${s.rewards} earned.`,
      ref_table: 'stakes', ref_id: s.id,
    });
    return { returned, asset: s.asset, rewards: Number(s.rewards) };
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such stake' });
  if (out === 'closed') return reply.code(409).send({ error: 'that stake is already closed' });
  if (out === 'locked') return reply.code(409).send({ error: 'this stake is still locked' });
  if (out === 'no-wallet') return reply.code(500).send({ error: 'could not open a wallet to return it to' });
  return out;
});

app.patch('/stakes/:id', { preHandler: auth() }, async (req: any, reply) => {
  const who = await portfolioSubject(req, reply);
  if (!who) return;
  const body = z.object({
    client_id: z.string().uuid().optional(),
    // The rate agreed on this one stake. Null puts it back on the product's.
    apy_override: z.number().min(0).max(1).nullable().optional(),
    // Ending a lock early. The desk's to give, and recorded as given.
    unlock_now: z.literal(true).optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (!who.onBehalf) return reply.code(403).send({ error: 'the terms of a stake are set by the desk' });
  if (body.data.apy_override === undefined && !body.data.unlock_now) {
    return reply.code(400).send({ error: 'nothing to change' });
  }

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [s] } = await c.query<StakeRow & { product_name: string; product_apy: number }>(
      `SELECT s.*, p.name AS product_name, p.apy AS product_apy FROM stakes s
         JOIN staking_products p ON p.code = s.product_code
        WHERE s.id = $1 AND s.client_id = $2 FOR UPDATE OF s`, [req.params.id, who.clientId]);
    if (!s) return 'missing' as const;

    if (body.data.apy_override !== undefined) {
      await c.query('UPDATE stakes SET apy_override = $2 WHERE id = $1', [s.id, body.data.apy_override]);
      const effective = body.data.apy_override ?? Number(s.product_apy);
      await logActivity(c, {
        client_id: who.clientId, kind: 'stake', actor: req.principal.sub,
        summary: body.data.apy_override === null
          ? `Desk put ${s.product_name} back on the standard rate`
          : `Desk set ${s.product_name} to ${asPct(effective)} a year`,
        ref_table: 'stakes', ref_id: s.id, data: { apy_override: body.data.apy_override },
      });
      await notifyClientOf(c, {
        client_id: who.clientId, kind: 'stake',
        title: `Your ${s.product_name} stake now earns ${asPct(effective)} a year`,
        body: 'Credited daily on what is staked.',
        ref_table: 'stakes', ref_id: s.id,
      });
    }

    if (body.data.unlock_now) {
      await c.query('UPDATE stakes SET unlocks_at = now() WHERE id = $1', [s.id]);
      await logActivity(c, {
        client_id: who.clientId, kind: 'stake', actor: req.principal.sub,
        summary: `Desk released the lock on ${s.product_name}`,
        ref_table: 'stakes', ref_id: s.id,
      });
      await notifyClientOf(c, {
        client_id: who.clientId, kind: 'stake',
        title: `Your ${s.product_name} stake is unlocked`,
        body: 'You can unstake it whenever you like.',
        ref_table: 'stakes', ref_id: s.id,
      });
    }

    const { rows: [after] } = await c.query('SELECT * FROM stakes WHERE id = $1', [s.id]);
    return after;
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such stake' });
  return out;
});

/**
 * Post staking rewards to every open stake with whole days outstanding.
 *
 * Same claim-by-date discipline as the portfolio accrual, for the same reason: running it
 * twice in a day must pay once, and a week missed must pay the week.
 */
async function accrueStaking(): Promise<{ stakes: number; posted: number }> {
  const { rows } = await pool.query<{
    id: string; client_id: string; asset: string; amount: number; rate: number;
    days: number; product_name: string;
  }>(`
    SELECT s.id, s.client_id, s.asset, s.amount, p.name AS product_name,
           coalesce(s.apy_override, p.apy) AS rate,
           (current_date - s.last_accrued_on) AS days
      FROM stakes s JOIN staking_products p ON p.code = s.product_code
     WHERE s.status = 'active'
       AND s.amount > 0
       AND coalesce(s.apy_override, p.apy) > 0
       AND s.last_accrued_on < current_date`);

  let posted = 0;
  for (const s of rows) {
    const reward = accrue({ balance: Number(s.amount), annualRate: Number(s.rate), days: Number(s.days) });
    if (reward <= 0) {
      await pool.query('UPDATE stakes SET last_accrued_on = current_date WHERE id = $1', [s.id]);
      continue;
    }
    await tx('system', async (c) => {
      // Claimed and credited together: a reward paid without moving the date would pay
      // again on the next run.
      const { rowCount } = await c.query(
        `UPDATE stakes SET rewards = rewards + $2, last_accrued_on = current_date
          WHERE id = $1 AND last_accrued_on < current_date`, [s.id, reward]);
      if (!rowCount) return;
      posted++;
      await logActivity(c, {
        client_id: s.client_id, kind: 'stake', actor: 'system',
        summary: `Staking reward of ${reward} ${s.asset} on ${s.product_name}`,
        ref_table: 'stakes', ref_id: s.id, data: { reward, asset: s.asset, days: Number(s.days) },
      });
    });
  }
  return { stakes: rows.length, posted };
}

/** Admin: run the staking accrual by hand, the same way interest can be run. */
app.post('/admin/accrue-staking', { preHandler: auth('admin') }, async () => accrueStaking());

/**
 * The staking catalogue, as the desk maintains it.
 *
 * A product's rate is shared: every stake on it that has not had its own rate agreed is
 * paid the product's, so changing this number changes what a lot of people earn at once.
 * The count of stakes riding on it comes back with every product for that reason — the
 * desk should see the size of what it is about to move before it moves it.
 */
const productBody = z.object({
  name: z.string().min(1).max(80),
  asset: z.string().min(2).max(10),
  description: z.string().min(1).max(400),
  apy: z.number().min(0).max(1),
  lock_days: z.number().int().min(0).max(3650).default(0),
  min_amount: z.number().min(0).finite().default(0),
  sort_order: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

/** Everything the desk offers or has ever offered, with what is riding on each. */
app.get('/admin/staking-products', { preHandler: auth('crm:read') }, async () =>
  (await pool.query(`
    SELECT p.*,
           (SELECT count(*) FROM stakes s WHERE s.product_code = p.code AND s.status = 'active')      AS active_stakes,
           (SELECT count(*) FROM stakes s WHERE s.product_code = p.code AND s.status = 'active'
             AND s.apy_override IS NULL)                                                             AS on_product_rate,
           (SELECT coalesce(sum(s.amount + s.rewards), 0) FROM stakes s
             WHERE s.product_code = p.code AND s.status = 'active')                                  AS staked
      FROM staking_products p ORDER BY p.sort_order, p.name`)).rows);

app.post('/admin/staking-products', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = z.object({ code: z.string().min(2).max(30).regex(/^[a-z0-9_]+$/) })
    .and(productBody).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  if (!(await currencies()).has(b.asset)) return reply.code(404).send({ error: 'unknown asset' });

  try {
    const created = await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO staking_products (code, name, asset, description, apy, lock_days, min_amount, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.code, b.name, b.asset, b.description, b.apy, b.lock_days, b.min_amount, b.sort_order, b.active]);
      return rows[0];
    });
    return reply.code(201).send(created);
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'a product with that code already exists' });
    throw err;
  }
});

app.patch('/admin/staking-products/:code', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = productBody.partial()
    .refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  if (body.data.asset && !(await currencies()).has(body.data.asset)) {
    return reply.code(404).send({ error: 'unknown asset' });
  }

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [before] } = await c.query<{ asset: string; apy: number; name: string }>(
      'SELECT asset, apy, name FROM staking_products WHERE code = $1 FOR UPDATE', [req.params.code]);
    if (!before) return 'missing' as const;

    // A stake keeps the asset it was opened in, so changing the product's would leave the
    // two disagreeing about what the same row is denominated in. Retire it and add another.
    if (body.data.asset && body.data.asset !== before.asset) {
      const { rows: [{ n }] } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM stakes WHERE product_code = $1 AND status = 'active'",
        [req.params.code]);
      if (Number(n) > 0) return 'asset-locked' as const;
    }

    const entries = Object.entries(body.data);
    const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await c.query(
      `UPDATE staking_products SET ${set} WHERE code = $1 RETURNING *`,
      [req.params.code, ...entries.map(([, v]) => v)]);

    // Worth its own line on the audit trail: this one number moves what everybody on the
    // product earns, and how many that is belongs in the record beside it.
    if (body.data.apy !== undefined && Number(body.data.apy) !== Number(before.apy)) {
      const { rows: [{ n }] } = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM stakes
          WHERE product_code = $1 AND status = 'active' AND apy_override IS NULL`, [req.params.code]);
      app.log.info({ product: req.params.code, from: before.apy, to: body.data.apy, stakes: n },
        'staking product rate changed');
    }
    return rows[0];
  });

  if (out === 'missing') return reply.code(404).send({ error: 'no such product' });
  if (out === 'asset-locked') {
    return reply.code(409).send({ error: 'this product has open stakes — its asset cannot change' });
  }
  return out;
});

/** Every open stake on the desk, for the firm-wide view. */
app.get('/admin/stakes', { preHandler: auth('crm:read') }, async (req: any) => {
  const q = z.object({
    status: z.enum(['active', 'closed', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }).parse(req.query);
  const { rows } = await pool.query(
    `SELECT s.id, s.client_id, cl.name AS client_name, s.asset, s.amount, s.rewards,
            s.status, s.staked_at, s.unlocks_at, s.apy_override,
            p.name AS product_name, p.code AS product_code,
            coalesce(s.apy_override, p.apy) AS apy
       FROM stakes s
       JOIN staking_products p ON p.code = s.product_code
       JOIN clients cl ON cl.id = s.client_id
      WHERE ($1 = 'all' OR s.status = $1)
      ORDER BY s.staked_at DESC LIMIT $2`, [q.status, q.limit]);
  return rows;
});


// --------------------------------------------------------------- dashboard

/** The whole business in one response: CRM, trading and compliance side by side. */
app.get('/admin/overview', { preHandler: auth('admin') }, async () => {
  const q = async <T extends pg.QueryResultRow>(sql: string) => (await pool.query<T>(sql)).rows;

  const [clients, pipeline, kyc, flags, tasks, trading, positions, cash, series, desk] = await Promise.all([
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
    // Fourteen days of the numbers the tiles show as a single instant: the same figures,
    // but with their shape. generate_series supplies the empty days so a quiet Sunday is a
    // gap in the bars rather than a missing bar that shifts every other one along.
    // ponytail: correlated subqueries, fine over 14 rows; join and group if this grows.
    q<{ day: string; volume: number; fills: number; net_flow: number; new_clients: number }>(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
             (SELECT coalesce(sum(f.qty * f.price), 0) FROM fills f
               WHERE f.filled_at >= d AND f.filled_at < d + interval '1 day')      AS volume,
             (SELECT count(*) FROM fills f
               WHERE f.filled_at >= d AND f.filled_at < d + interval '1 day')      AS fills,
             (SELECT coalesce(sum(t.amount), 0) FROM cash_transactions t
               WHERE t.status IN ('approved','settled')
                 AND t.created_at >= d AND t.created_at < d + interval '1 day')    AS net_flow,
             (SELECT count(*) FROM clients c
               WHERE c.created_at >= d AND c.created_at < d + interval '1 day')    AS new_clients
        FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') d
       ORDER BY day`),
    // The two queues added since this dashboard was written. A desk-wide view that does
    // not carry them is one where they are only found by going looking.
    q<{
      requests_pending: number; requests_amount: number;
      stakes_active: number; stakers: number;
    }>(`
      SELECT (SELECT count(*) FROM portfolio_requests WHERE status = 'pending')                  AS requests_pending,
             (SELECT coalesce(sum(amount), 0) FROM portfolio_requests WHERE status = 'pending')  AS requests_amount,
             (SELECT count(*) FROM stakes WHERE status = 'active')                               AS stakes_active,
             (SELECT count(DISTINCT client_id) FROM stakes WHERE status = 'active')              AS stakers`),
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
    desk: desk[0],
    series: series.map((r) => ({
      day: r.day,
      volume: Number(r.volume),
      fills: Number(r.fills),
      net_flow: Number(r.net_flow),
      new_clients: Number(r.new_clients),
    })),
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
  additional_documents: EXTRA_KINDS,
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

/**
 * For the platform's health check. Touches the database, because a process that is up but
 * cannot reach Postgres is not healthy — it would serve 500s to every request. Says
 * nothing about versions or internals to an anonymous caller.
 */
app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    // See UPLOAD_PERSISTENCE: proven from a marker left on the last boot, not inferred
    // from an environment variable being set. Reported here so it can be read from
    // outside without signing in.
    return { ok: true, uploads: UPLOAD_PERSISTENCE };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

// --------------------------------------------------------------- the web app
//
// In development Vite serves the front end and proxies /api here. In production there is
// no Vite, so this serves web/dist itself: one origin, one service, no CORS, and the
// WebSocket feed on the same host. Registered last so it never shadows an API route.

const WEB_DIST = join(import.meta.dirname, '..', 'web', 'dist');
if (existsSync(join(WEB_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  // Hash routing means every deep link is still '/', so a stray path should land on the
  // app rather than a 404 page — but only if the caller wanted the app. An unknown API
  // path has to answer as the API.
  //
  // This used to test req.url for an /api prefix, which by this point rewriteUrl has
  // already stripped, so the test never matched and GET /api/anything returned the whole
  // front end with a 200. The caller then got 'Unexpected token <' out of .json() and a
  // mistyped path looked like a parse bug rather than a missing route.
  app.setNotFoundHandler((req, reply) => (
    req.method === 'GET' && !(req.raw as ApiMarked).cameInUnderApi
      ? reply.sendFile('index.html')
      : reply.code(404).send({ error: 'not found' })
  ));
  app.log.info('serving the built web app from web/dist');
} else {
  app.log.info('no web/dist — API only, run the Vite dev server for the front end');
}

// ------------------------------------------------------------- IPO offerings
//
// A deal the desk publishes, a window clients subscribe through, and a fixed ROI accrued
// daily until maturity. The money mechanics are the portfolio ones — debit on subscribe
// inside one locked transaction, credit back on refund or settlement — with one addition
// portfolios do not have: a cap the whole book shares, so the offering row is locked too.
//
// The return is the ROI and not the share price. A subscription is not equity, confers no
// interest in any company named, and moves the same simulated balances as everything else
// here. See the README.
//
// What is deliberately left undone, so `grep -rn "ponytail:" src web/src` stays the list:
// ponytail: offering images sit on the container disk under UPLOAD_DIR. They belong in
//   object storage — without a mounted volume every deploy loses them, the same trap the
//   KYC documents already carry a warning about.
// ponytail: no secondary market and no transfer of an allocation. A subscription is held
//   by the client who made it until it is refunded or settled.
// ponytail: no partial allocation or pro-rata scale-back on oversubscription. First come,
//   first served, and the overflow is refused rather than trimmed.
// ponytail: no per-offering document attachments — a prospectus or term sheet would want
//   the KYC upload path rather than this one, since those are documents, not marketing.
// ponytail: the ROI accrual runs on the same in-process timer as the others, so several
//   API instances would each run it. Harmless while it is idempotent; move it to a single
//   scheduled job at that point.

/** Marketing imagery, so the formats a browser renders and nothing else. */
const IPO_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'],
]);
const IPO_IMAGE_MAX = 5 * 1024 * 1024;
/** A picture written to disk before they moved into the row: those keys carry an extension. */
const IPO_DISK_NAME = /[.](jpg|png|webp)$/i;

/** What the client page and the desk list both need on top of the stored columns. */
type IpoRow = {
  id: string; slug: string; name: string; summary: string; description: string | null;
  asset: string; currency: string; target_amount: number; min_subscription: number;
  max_subscription: number | null; roi_rate: number; term_days: number;
  opens_at: Date | null; closes_at: Date | null; matures_at: Date | null;
  status: string; image_key: string | null; sort_order: number;
  valuation: string | null;
  raised_baseline: number;
  raised: number; subscribers: number;
  // Whether a picture exists, never the picture itself. The bytes are deliberately absent
  // from this type so a list of offerings cannot accidentally carry a dozen of them.
  has_image_data: boolean;
};

/**
 * Raised counts money that is still in: a refunded subscription freed its slot in the cap
 * and must not go on holding it. Settled ones stay counted, because the book they filled
 * was filled.
 */
const RAISED_JOIN = `
  LEFT JOIN (SELECT ipo_id, sum(amount) AS raised, count(*)::int AS subscribers
               FROM ipo_subscriptions WHERE status <> 'refunded' GROUP BY ipo_id) r
         ON r.ipo_id = i.id`;

/**
 * Every column except the picture.
 *
 * Spelled out rather than `i.*` for one reason: image_data is a bytea of up to five
 * megabytes, and `i.*` would read it out of the database, carry it through Node and
 * serialise it into the JSON of every list of offerings. The page needs to know whether a
 * picture exists, which is a boolean, and then fetches it from its own route.
 */
const IPO_COLUMNS = `
  i.id, i.slug, i.name, i.summary, i.description, i.asset, i.currency, i.target_amount,
  i.min_subscription, i.max_subscription, i.roi_rate, i.term_days,
  i.opens_at, i.closes_at, i.matures_at, i.status, i.image_key, i.sort_order,
  i.valuation, i.raised_baseline, i.created_at, i.updated_at,
  (i.image_data IS NOT NULL) AS has_image_data`;

const ipoSelect = (where: string) => `
  SELECT ${IPO_COLUMNS},
         coalesce(r.raised, 0) + i.raised_baseline AS raised,
         coalesce(r.subscribers, 0) AS subscribers
    FROM ipos i ${RAISED_JOIN}
   ${where}
   ORDER BY i.sort_order, i.created_at DESC`;

/** The offering as the API talks about it: stored columns plus what today makes of them. */
function shapeIpo(row: IpoRow, now = new Date()) {
  const status = effectiveStatus(row, now);
  const raised = Number(row.raised);
  const target = Number(row.target_amount);
  // The return over the whole term, as a fraction of what goes in — 7.25% a year across 180
  // days is about 3.52%, not 7.25%. Computed with accrue() on a unit balance rather than
  // with a formula written out again here: the figure a client is shown before subscribing
  // has to be the one the daily job actually credits, and the only way to guarantee that is
  // for both to be the same function. There is a test that holds them together.
  const estimated = accrue({ balance: 1, annualRate: Number(row.roi_rate), days: row.term_days });
  return {
    ...row,
    status,                                   // computed, never the stored column
    stored_status: row.status,                // what the desk set, for the desk's own screen
    group: ipoGroup(status),
    raised,
    remaining: round8(Math.max(0, target - raised)),
    progress: progress(raised, target),
    // Absolute and in UTC. The page corrects for clock skew against these; it never uses
    // its own clock to decide whether a window is open, and neither does the server.
    server_time: now.toISOString(),
    // "Estimated" because the desk can change the rate on a live offering; it is exact for
    // as long as the rate stands, not a projection of anything uncertain.
    estimated_return_pct: round8(estimated),
    has_image: row.has_image_data || row.image_key !== null,
  };
}

/** A client's own positions, keyed by offering, for stitching onto a list. */
async function subscriptionsOf(clientId: string, ipoIds: string[]) {
  if (!ipoIds.length) return new Map<string, any>();
  const { rows } = await pool.query(
    `SELECT * FROM ipo_subscriptions WHERE client_id = $1 AND ipo_id = ANY($2::uuid[])
      ORDER BY created_at`, [clientId, ipoIds]);
  const by = new Map<string, any>();
  for (const s of rows) {
    const prior = by.get(s.ipo_id);
    // One client can subscribe more than once; the page wants the position, not the rows.
    by.set(s.ipo_id, prior
      ? { ...prior, amount: round8(Number(prior.amount) + Number(s.amount)),
          accrued: round8(Number(prior.accrued) + Number(s.accrued)) }
      : { ...s, amount: Number(s.amount), accrued: Number(s.accrued) });
  }
  return by;
}

/**
 * Everything a client may see: every offering except a draft, with their own position.
 * Staff with crm:read may read it as a named client, the same scope portfolios use.
 */
app.get('/ipos', { preHandler: auth() }, async (req: any, reply) => {
  const subject = await portfolioScope(req, reply);
  if (!subject) return;
  const { rows } = await pool.query<IpoRow>(ipoSelect(`WHERE i.status <> 'draft'`));
  // A row with a missing date computes to draft however it is stored, which is what keeps
  // a half-prepared offering off this page without the desk remembering to hide it.
  const visible = rows.map((r) => shapeIpo(r)).filter((r) => r.group !== 'hidden');
  const mine = await subscriptionsOf(subject, visible.map((r) => r.id));
  return visible.map((r) => ({ ...r, subscription: mine.get(r.id) ?? null }));
});

app.get('/ipos/:id', { preHandler: auth() }, async (req: any, reply) => {
  const subject = await portfolioScope(req, reply);
  if (!subject) return;
  const { rows } = await pool.query<IpoRow>(ipoSelect('WHERE i.id = $1'), [req.params.id]);
  if (!rows[0]) return reply.code(404).send({ error: 'no such offering' });
  const shaped = shapeIpo(rows[0]);
  if (shaped.group === 'hidden') return reply.code(404).send({ error: 'no such offering' });
  const mine = await subscriptionsOf(subject, [shaped.id]);
  return { ...shaped, subscription: mine.get(shaped.id) ?? null };
});

/** The client's own positions across every offering, including ones now finished. */
app.get('/me/ipo-subscriptions', { preHandler: trader }, async (req: any) => {
  const { rows } = await pool.query(`
    SELECT s.*, i.name, i.slug, i.asset, i.term_days, i.matures_at, i.roi_rate,
           i.status AS ipo_stored_status, i.opens_at, i.closes_at,
           coalesce(s.roi_override, i.roi_rate) AS effective_rate
      FROM ipo_subscriptions s JOIN ipos i ON i.id = s.ipo_id
     WHERE s.client_id = $1 ORDER BY s.created_at DESC`, [req.principal.sub]);
  return rows.map((r) => ({
    ...r,
    ipo_status: effectiveStatus({
      status: r.ipo_stored_status, opens_at: r.opens_at, closes_at: r.closes_at, matures_at: r.matures_at,
    }),
  }));
});

const subscribeBody = z.object({
  amount: z.number().positive().finite().max(1e12),
  client_id: z.string().uuid().optional(),      // staff acting for a client
});

/**
 * Subscribe: debit now, allocate against the cap, and refuse clearly when it will not fit.
 *
 * Two locks, and both are necessary. The client's holding, because a balance check and a
 * debit that are not one atomic step let two concurrent subscriptions both pass a check
 * only one can afford. And the offering row, because the cap is a shared resource: two
 * clients racing for the last of a target must not both get it.
 *
 * The window is re-checked here from the server's own clock. Whatever the page's countdown
 * says, this is the only thing that decides.
 */
app.post('/ipos/:id/subscribe', { preHandler: auth() }, async (req: any, reply) => {
  const body = subscribeBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const { amount } = body.data;

  // A client subscribes for themselves; staff need funds:credit and must name the client,
  // exactly as acting on a portfolio does.
  let subject: string;
  let onBehalf = false;
  if (req.principal.kind === 'client') {
    subject = req.principal.sub;
  } else {
    if (!can(req.principal.role, 'funds:credit')) {
      return reply.code(403).send({ error: 'subscribing for a client needs funds:credit' });
    }
    if (!body.data.client_id) return reply.code(400).send({ error: 'staff must name the client: client_id' });
    subject = body.data.client_id;
    onBehalf = true;
  }

  const { rows: [client] } = await pool.query<{ kyc_status: string }>(
    'SELECT kyc_status FROM clients WHERE id = $1', [subject]);
  if (!client) return reply.code(404).send({ error: 'no such client' });

  const out = await tx(req.principal.sub, async (c) => {
    // The offering first, and locked: everything after this reads the book.
    const { rows: [ipo] } = await c.query<IpoRow>(
      // Named columns, not i.*: this row is read under FOR UPDATE on every subscription,
      // and i.* would pull the offering picture — up to five megabytes of bytea — through
      // the lock each time, for a transaction that never looks at it.
      `SELECT ${IPO_COLUMNS}, 0 AS raised, 0 AS subscribers FROM ipos i WHERE i.id = $1 FOR UPDATE`,
      [req.params.id]);
    if (!ipo) return { kind: 'missing' } as const;

    const status = effectiveStatus(ipo);
    if (status !== 'open') return { kind: 'not-open', status } as const;

    // Taking investment money from an unverified client is the single most obvious
    // compliance failure this feature could ship with. The attempt is flagged even though
    // it is refused: a refusal nobody records is a refusal nobody can count.
    if (client.kyc_status !== 'approved') {
      const { rows: previous } = await c.query<{ amount: number }>(
        'SELECT amount FROM ipo_subscriptions WHERE client_id = $1', [subject]);
      await raiseFlags(c, subject, subscriptionFlags({
        amount, kycStatus: client.kyc_status, previous,
      }));
      return { kind: 'unverified', kyc: client.kyc_status } as const;
    }

    const { rows: [book] } = await c.query<{ raised: number }>(
      `SELECT coalesce(sum(amount), 0) AS raised FROM ipo_subscriptions
        WHERE ipo_id = $1 AND status <> 'refunded'`, [ipo.id]);

    // Plus what the desk placed before this book opened. The progress bar already counts it,
    // so the allocation must as well — otherwise an offering shown as nearly full would go on
    // accepting subscriptions up to the full target, and the refusal would name an amount
    // that was never really available.
    const taken = Number(book.raised) + Number(ipo.raised_baseline);

    const fit = allocation({
      target: Number(ipo.target_amount), raised: taken, amount,
      min: Number(ipo.min_subscription), max: ipo.max_subscription === null ? null : Number(ipo.max_subscription),
    });
    if (!fit.ok) return { kind: 'refused', fit, currency: ipo.currency } as const;

    const ccy = (await currencies()).get(ipo.currency);
    if (!ccy) return { kind: 'unknown-currency', currency: ipo.currency } as const;
    const holding = await lockHolding(c, subject, ipo.currency, ccy.kind, false);
    if (!holding) return { kind: 'no-holding', currency: ipo.currency } as const;
    if (Number(holding.balance) < amount) {
      return { kind: 'insufficient', balance: Number(holding.balance), currency: ipo.currency } as const;
    }

    await moveBalance(c, holding, -amount);
    // last_accrued_on is only the high-water mark of what has been paid. Where accrual
    // *starts* is the offering's close, applied by the accrual itself against whatever the
    // close is at the time — not snapshotted here. Snapshotting it meant an offering whose
    // close the desk later pulled earlier never began paying, because this column sat in
    // the future and the accrual skips anything not yet due.
    const { rows: [sub] } = await c.query(
      `INSERT INTO ipo_subscriptions (ipo_id, client_id, amount, currency)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [ipo.id, subject, amount, ipo.currency]);

    // Measured against what this client has subscribed before, excluding the row just
    // written. Only the size rules can fire: the KYC one already returned above, so it is
    // dropped rather than raised twice for the same attempt.
    const { rows: previous } = await c.query<{ amount: number }>(
      'SELECT amount FROM ipo_subscriptions WHERE client_id = $1 AND id <> $2', [subject, sub.id]);
    await raiseFlags(c, subject, subscriptionFlags({
      amount, kycStatus: client.kyc_status, previous,
    }).filter((f) => f.rule !== 'subscription_without_kyc'));

    await logActivity(c, {
      client_id: subject, kind: 'ipo', actor: req.principal.sub,
      summary: onBehalf
        ? `Desk subscribed ${amount} ${ipo.currency} to ${ipo.name}`
        : `Subscribed ${amount} ${ipo.currency} to ${ipo.name}`,
      ref_table: 'ipos', ref_id: ipo.id,
      data: { amount, currency: ipo.currency, offering: ipo.name, on_behalf: onBehalf },
    });

    // Their own act of subscribing is not notified — they were there. Money the desk moved
    // for them is, because that is money they did not move.
    if (onBehalf) {
      await notifyClientOf(c, {
        client_id: subject, kind: 'ipo',
        title: `${amount} ${ipo.currency} subscribed to ${ipo.name}`,
        body: 'Moved by the desk from your balance.',
        ref_table: 'ipos', ref_id: ipo.id,
      });
    }

    const raisedNow = round8(Number(book.raised) + amount);
    if (raisedNow >= Number(ipo.target_amount)) {
      await notifyStaff(c, { roles: ['sales', 'admin'] }, {
        kind: 'ipo.filled',
        title: `${ipo.name} is fully subscribed`,
        body: `${raisedNow} ${ipo.currency} against a target of ${ipo.target_amount}.`,
        ref_table: 'ipos', ref_id: ipo.id,
      });
    }

    return {
      kind: 'ok', subscription: sub, remaining: round8(Number(ipo.target_amount) - raisedNow),
    } as const;
  });

  flushNotifications();
  switch (out.kind) {
    case 'missing': return reply.code(404).send({ error: 'no such offering' });
    case 'not-open': return reply.code(409).send({
      error: out.status === 'upcoming' ? 'this offering has not opened yet'
        : out.status === 'draft' ? 'no such offering'
        : `this offering is ${out.status} and is not taking subscriptions`,
    });
    case 'unverified': return reply.code(403).send({
      error: 'subscriptions are open to verified accounts — send your identity documents '
        + 'from Documents and the desk will review them',
      kyc_status: out.kyc,
    });
    case 'refused': return reply.code(422).send({
      error: out.fit.reason === 'below-min' ? `the minimum is ${out.fit.min} ${out.currency}`
        : out.fit.reason === 'above-max' ? `the maximum is ${out.fit.max} ${out.currency}`
        : out.fit.available > 0
          ? `only ${out.fit.available} ${out.currency} is left in this offering`
          : 'this offering is fully subscribed',
    });
    case 'unknown-currency': return reply.code(409).send({ error: `no rate for ${out.currency}` });
    case 'no-holding': return reply.code(422).send({ error: `you hold no ${out.currency}` });
    case 'insufficient': return reply.code(422).send({
      error: `you hold ${out.balance} ${out.currency}`,
    });
    default: return out;
  }
});

/** The offering's picture. Served through a route, never as a guessable static path. */
/**
 * Take the picture off an offering.
 *
 * Separate from uploading a replacement because they are different decisions: one is a
 * better photograph, the other is "this should not be showing". Without it the desk can only
 * ever swap one picture for another, and a card that should fall back to its drawn mark
 * cannot be made to.
 */
app.delete('/admin/ipos/:id/image', { preHandler: auth('admin') }, async (req: any, reply) => {
  const out = await tx(req.principal.sub, async (c) => {
    const { rows } = await c.query<{ image_key: string | null }>(
      `UPDATE ipos SET image_key = NULL, image_data = NULL, image_type = NULL
        WHERE id = $1 RETURNING image_key`, [req.params.id]);
    return rows.length ? rows[0] : null;
  });
  if (!out) return reply.code(404).send({ error: 'no such offering' });
  return { ok: true, image: false };
});

app.get('/ipos/:id/image', { preHandler: auth() }, async (req: any, reply) => {
  const { rows } = await pool.query<{
    image_key: string | null; image_data: Buffer | null; image_type: string | null;
  }>('SELECT image_key, image_data, image_type FROM ipos WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (!row?.image_key) return reply.code(404).send({ error: 'no picture' });

  // Marketing rather than anything private, but it sits behind the same login the page does,
  // so it is cached by the browser and not by anything in between. The key changes on every
  // upload, so a stale cached picture is replaced as soon as the desk changes it.
  const sent = reply.header('cache-control', 'private, max-age=86400');
  if (row.image_data) return sent.type(row.image_type ?? 'image/jpeg').send(row.image_data);

  // Uploaded before pictures moved into the row: served from disk if the deploy that
  // replaced the filesystem has not got there first, and simply absent if it has.
  const path = join(UPLOAD_DIR, basename(row.image_key));
  if (!path.startsWith(UPLOAD_DIR) || !existsSync(path)) {
    return reply.code(404).send({ error: 'no picture' });
  }
  const ext = extname(path);
  return sent
    .type(ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg')
    .send(createReadStream(path));
});

// --------------------------------------------------------------- the desk side

/** Every offering including drafts, which the client list never shows. */
app.get('/admin/ipos', { preHandler: auth('crm:read') }, async () => {
  const { rows } = await pool.query<IpoRow>(ipoSelect(''));
  return rows.map((r) => shapeIpo(r));
});

const ipoBody = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, 'lower case, digits and dashes'),
  name: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  asset: z.string().min(1).max(20),
  currency: z.string().min(2).max(10),
  // Free text: valuations are reported as ranges and approximations ("$165-175bn", "$1tn+"),
  // and nothing computes with this, so nothing needs it parsed into a number.
  valuation: z.string().max(60).nullable().optional(),
  // Allocation placed away from this platform. Bounded against the target by a CHECK, so a
  // baseline larger than the book is refused rather than making `remaining` negative.
  raised_baseline: z.number().min(0).finite().max(1e15).default(0),
  target_amount: z.number().positive().finite().max(1e15),
  min_subscription: z.number().min(0).finite().max(1e15).default(0),
  max_subscription: z.number().positive().finite().max(1e15).nullable().optional(),
  // Taken as a percentage and stored as a fraction, the same way the desk types every
  // other rate in this product.
  // No upper bound worth calling a rate limit. The old 100% ceiling made short-dated
  // offerings unenterable — 15% over 30 days is about 440% annualised — and this is the
  // desk's own number on its own product. What is enforced is what is not taste: not
  // negative, because the accrual takes the 365th root of (1 + rate); finite, because
  // Infinity would silently corrupt every balance it touched; and inside what the column
  // stores, so too large is a refusal that says so rather than a driver error.
  roi_rate: z.number().min(0).finite().max(1_000_000),
  term_days: z.number().int().min(1).max(3650),
  opens_at: z.coerce.date().nullable().optional(),
  closes_at: z.coerce.date().nullable().optional(),
  matures_at: z.coerce.date().nullable().optional(),
  sort_order: z.number().int().min(-32768).max(32767).default(0),
});

app.post('/admin/ipos', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = ipoBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const b = body.data;
  if (!(await currencies()).get(b.currency)) {
    return reply.code(404).send({ error: 'unknown currency' });
  }
  try {
    return await tx(req.principal.sub, async (c) => {
      const { rows: [ipo] } = await c.query(
        `INSERT INTO ipos (slug, name, summary, description, asset, currency, target_amount,
                           min_subscription, max_subscription, roi_rate, term_days,
                           opens_at, closes_at, matures_at, sort_order, valuation,
                           raised_baseline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${IPO_COLUMNS.replaceAll('i.', '')}`,
        [b.slug, b.name, b.summary, b.description ?? null, b.asset, b.currency, b.target_amount,
         b.min_subscription, b.max_subscription ?? null, b.roi_rate / 100, b.term_days,
         b.opens_at ?? null, b.closes_at ?? null, b.matures_at ?? null, b.sort_order,
         b.valuation ?? null, b.raised_baseline]);
      return reply.code(201).send(shapeIpo({ ...ipo, raised: 0, subscribers: 0 }));
    });
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'that slug is taken' });
    if (err?.code === '23514') return reply.code(400).send({ error: `the dates or bounds are not valid: ${err.constraint}` });
    throw err;
  }
});

const ipoPatch = ipoBody.partial().extend({
  // The desk's explicit decisions. Everything else about the lifecycle is the dates'.
  status: z.enum(['draft', 'upcoming', 'open', 'closed', 'active', 'cancelled']).optional(),
}).refine((o) => Object.keys(o).length > 0, 'no fields to update');

/**
 * Edit an offering, including its ROI.
 *
 * Behind `admin` rather than ordinary crm:write: changing the ROI on a live offering
 * changes what every subscriber is paid, which is the same shape of power as funds:credit
 * and should not sit with sales.
 *
 * Settling and cancelling are not here — they move money, so they have their own routes.
 */
app.patch('/admin/ipos/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = ipoPatch.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const patch: Record<string, unknown> = { ...body.data };
  if (patch.roi_rate !== undefined) patch.roi_rate = (patch.roi_rate as number) / 100;

  const entries = Object.entries(patch);
  const set = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  try {
    const out = await tx(req.principal.sub, async (c) => {
      // id, name and roi_rate are all the rest of this needs, and naming them keeps the
      // picture out of a row that is read and written on every edit.
      const { rows: [before] } = await c.query<IpoRow>(
        'SELECT id, name, roi_rate FROM ipos WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before) return null;
      const { rows: [after] } = await c.query<IpoRow>(
        `UPDATE ipos SET ${set} WHERE id = $1 RETURNING id, name, roi_rate`,
        [req.params.id, ...entries.map(([, v]) => v)]);

      // A rate change is told to everybody it affects, because it changes what they are
      // paid. Silent is how a number nobody agreed to becomes a number nobody disputes.
      if (patch.roi_rate !== undefined && Number(after.roi_rate) !== Number(before.roi_rate)) {
        const { rows: holders } = await c.query<{ client_id: string }>(
          `SELECT DISTINCT client_id FROM ipo_subscriptions
            WHERE ipo_id = $1 AND status = 'active' AND roi_override IS NULL`, [after.id]);
        for (const h of holders) {
          await notifyClientOf(c, {
            client_id: h.client_id, kind: 'ipo',
            title: `${after.name} now pays ${(Number(after.roi_rate) * 100).toFixed(2)}%`,
            body: 'Applies from the next daily accrual. Nothing already credited changes.',
            ref_table: 'ipos', ref_id: after.id,
          });
          await logActivity(c, {
            client_id: h.client_id, kind: 'ipo', actor: req.principal.sub,
            summary: `${after.name} ROI changed from ${(Number(before.roi_rate) * 100).toFixed(2)}%`
              + ` to ${(Number(after.roi_rate) * 100).toFixed(2)}%`,
            ref_table: 'ipos', ref_id: after.id,
            data: { from: Number(before.roi_rate), to: Number(after.roi_rate) },
          });
        }
      }
      return after;
    });
    if (!out) return reply.code(404).send({ error: 'no such offering' });
    flushNotifications();
    const { rows } = await pool.query<IpoRow>(ipoSelect('WHERE i.id = $1'), [out.id]);
    return shapeIpo(rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'that slug is taken' });
    if (err?.code === '23514') return reply.code(400).send({ error: `the dates or bounds are not valid: ${err.constraint}` });
    throw err;
  }
});

/**
 * The offering's picture, stored in its row.
 *
 * On disk it would not survive: this deploys to a container whose filesystem is replaced on
 * every release, so a file written here is gone by the next one and the card silently loses
 * its picture. In the row it is as permanent as the offering itself, it reaches every
 * instance without shared storage, and it is included in whatever backs the database up.
 * One picture per offering at five megabytes is small enough for that to be the right trade.
 */
app.post('/admin/ipos/:id/image', { preHandler: auth('admin') }, async (req: any, reply) => {
  const { rows: [ipo] } = await pool.query<{ id: string; image_key: string | null }>(
    'SELECT id, image_key FROM ipos WHERE id = $1', [req.params.id]);
  if (!ipo) return reply.code(404).send({ error: 'no such offering' });

  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'no file' });
  if (!IPO_IMAGE_TYPES.has(file.mimetype)) {
    return reply.code(415).send({ error: 'only jpeg, png or webp' });
  }

  // The multipart plugin's own ceiling is set for KYC documents, so the picture limit is
  // enforced here — after buffering, which is safe because that ceiling is 10 MB.
  const bytes = await file.toBuffer();
  if (file.file.truncated || bytes.length > IPO_IMAGE_MAX) {
    return reply.code(413).send({ error: 'that picture is larger than 5 MB' });
  }

  // image_key is now only a cache-busting token: it changes on every upload, which is what
  // makes a browser holding the old picture go and ask for the new one.
  const key = randomUUID();
  await tx(req.principal.sub, (c) => c.query(
    'UPDATE ipos SET image_key = $2, image_data = $3, image_type = $4 WHERE id = $1',
    [ipo.id, key, bytes, file.mimetype]));

  // If the one it replaced was a file from before this change, take it with us.
  if (ipo.image_key && IPO_DISK_NAME.test(ipo.image_key)) {
    await rm(join(UPLOAD_DIR, basename(ipo.image_key)), { force: true }).catch(() => {});
  }
  return { ok: true, image_key: key };
});

/** The book: who subscribed, how much, when, and what they are actually paid. */
app.get('/admin/ipos/:id/subscriptions', { preHandler: auth('crm:read') }, async (req: any) => {
  const { rows } = await pool.query(`
    SELECT s.*, c.name AS client_name, c.email AS client_email, c.tier,
           coalesce(s.roi_override, i.roi_rate) AS effective_rate, i.roi_rate AS offering_rate
      FROM ipo_subscriptions s
      JOIN clients c ON c.id = s.client_id
      JOIN ipos i ON i.id = s.ipo_id
     WHERE s.ipo_id = $1 ORDER BY s.created_at`, [req.params.id]);
  return rows;
});

/** The rate agreed with one client on one subscription. Never shown on a client screen. */
app.patch('/admin/ipo-subscriptions/:id', { preHandler: auth('funds:credit') }, async (req: any, reply) => {
  const body = z.object({
    // Same bounds as the offering's own rate: an agreed rate for one client is not a
    // smaller number than the one it replaces.
    roi_override: z.number().min(0).finite().max(1_000_000).nullable(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const next = body.data.roi_override === null ? null : body.data.roi_override / 100;

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [sub] } = await c.query(
      `UPDATE ipo_subscriptions s SET roi_override = $2 WHERE s.id = $1 RETURNING s.*`,
      [req.params.id, next]);
    if (!sub) return null;
    const { rows: [ipo] } = await c.query<{ name: string; roi_rate: number }>(
      'SELECT name, roi_rate FROM ipos WHERE id = $1', [sub.ipo_id]);
    const shown = `${((next ?? Number(ipo.roi_rate)) * 100).toFixed(2)}%`;
    await logActivity(c, {
      client_id: sub.client_id, kind: 'ipo', actor: req.principal.sub,
      summary: next === null
        ? `Desk put ${ipo.name} back on the offering's rate`
        : `Desk set ${ipo.name} to ${shown} a year for this client`,
      ref_table: 'ipos', ref_id: sub.ipo_id,
      data: { roi_override: next },
    });
    await notifyClientOf(c, {
      client_id: sub.client_id, kind: 'ipo',
      title: `Your ${ipo.name} subscription now earns ${shown}`,
      body: 'Applies from the next daily accrual.',
      ref_table: 'ipos', ref_id: sub.ipo_id,
    });
    return sub;
  });
  if (!out) return reply.code(404).send({ error: 'no such subscription' });
  flushNotifications();
  return out;
});

/**
 * Cancel an offering and refund every subscription in full.
 *
 * Refunds are the amount originally debited, never a figure recomputed from a rate: the
 * client put in a number and that is the number that comes back. Each refund is its own
 * transaction so a failure on one cannot leave another client's money in neither place.
 */
app.post('/admin/ipos/:id/cancel', { preHandler: auth('admin') }, async (req: any, reply) => {
  const { rows: [ipo] } = await pool.query<IpoRow>(
    'SELECT *, 0 AS raised, 0 AS subscribers FROM ipos WHERE id = $1', [req.params.id]);
  if (!ipo) return reply.code(404).send({ error: 'no such offering' });
  const status = effectiveStatus(ipo);
  if (status === 'cancelled') return reply.code(409).send({ error: 'already cancelled' });
  // Cancellation is reachable from any state before active: after that, money has been
  // working and the way out is a settlement rather than a refund.
  if (status === 'active' || status === 'completed') {
    return reply.code(409).send({ error: `an ${status} offering is settled, not cancelled` });
  }

  const { rows: subs } = await pool.query<{ id: string; client_id: string; amount: number; currency: string }>(
    `SELECT id, client_id, amount, currency FROM ipo_subscriptions
      WHERE ipo_id = $1 AND status = 'active'`, [ipo.id]);

  let refunded = 0;
  for (const s of subs) {
    await tx(req.principal.sub, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE ipo_subscriptions SET status = 'refunded' WHERE id = $1 AND status = 'active'`, [s.id]);
      if (!rowCount) return;                       // another run got there first
      const ccy = (await currencies()).get(s.currency)!;
      const holding = await lockHolding(c, s.client_id, s.currency, ccy.kind, true);
      if (!holding) throw new Error(`no ${s.currency} holding to refund into`);
      await moveBalance(c, holding, Number(s.amount));
      await logActivity(c, {
        client_id: s.client_id, kind: 'ipo', actor: req.principal.sub,
        summary: `${ipo.name} cancelled — ${s.amount} ${s.currency} refunded`,
        ref_table: 'ipos', ref_id: ipo.id,
        data: { refunded: Number(s.amount), currency: s.currency },
      });
      await notifyClientOf(c, {
        client_id: s.client_id, kind: 'ipo',
        title: `${ipo.name} was cancelled`,
        body: `${s.amount} ${s.currency} has been returned to your balance in full.`,
        ref_table: 'ipos', ref_id: ipo.id,
      });
      refunded++;
    });
  }

  await tx(req.principal.sub, (c) =>
    c.query(`UPDATE ipos SET status = 'cancelled' WHERE id = $1`, [ipo.id]));
  flushNotifications();
  return { cancelled: ipo.id, refunded };
});

/**
 * Settle: pay principal plus accrued back, and mark the subscription settled.
 *
 * Runs at maturity from the sweep, and by hand when the desk settles early. Accrual is
 * brought up to the earlier of today and maturity first, so an early settlement pays what
 * was earned and a late one does not pay for the delay.
 */
async function settleIpo(ipoId: string, actor: string): Promise<{ settled: number; dust: number }> {
  const { rows: [ipo] } = await pool.query<IpoRow>(
    'SELECT *, 0 AS raised, 0 AS subscribers FROM ipos WHERE id = $1', [ipoId]);
  if (!ipo) return { settled: 0, dust: 0 };
  const ccy = (await currencies()).get(ipo.currency);
  const decimals = ccy?.decimals ?? 2;

  const { rows: subs } = await pool.query<{
    id: string; client_id: string; amount: number; accrued: number; currency: string;
  }>(`SELECT id, client_id, amount, accrued, currency FROM ipo_subscriptions
       WHERE ipo_id = $1 AND status = 'active'`, [ipoId]);

  let settled = 0;
  let dust = 0;
  for (const s of subs) {
    await tx(actor, async (c) => {
      const { rowCount } = await c.query(
        `UPDATE ipo_subscriptions SET status = 'settled' WHERE id = $1 AND status = 'active'`, [s.id]);
      if (!rowCount) return;
      const paid = settlement({ amount: Number(s.amount), accrued: Number(s.accrued), decimals });
      const holding = await lockHolding(c, s.client_id, s.currency, ccy!.kind, true);
      if (!holding) throw new Error(`no ${s.currency} holding to settle into`);
      await moveBalance(c, holding, paid.paid);
      await logActivity(c, {
        client_id: s.client_id, kind: 'ipo', actor,
        summary: `${ipo.name} matured — ${paid.paid} ${s.currency} paid`
          + ` (${s.amount} subscribed, ${s.accrued} earned)`
          + (paid.dust > 0 ? `, ${paid.dust} kept as dust` : ''),
        ref_table: 'ipos', ref_id: ipo.id,
        data: { paid: paid.paid, principal: Number(s.amount), accrued: Number(s.accrued), dust: paid.dust },
      });
      await notifyClientOf(c, {
        client_id: s.client_id, kind: 'ipo',
        title: `${ipo.name} has matured`,
        body: `${paid.paid} ${s.currency} is back on your balance — ${s.amount} subscribed`
          + ` plus ${s.accrued} earned.`,
        ref_table: 'ipos', ref_id: ipo.id,
      });
      settled++;
      dust = round8(dust + paid.dust);
    });
  }
  await tx(actor, (c) => c.query(`UPDATE ipos SET status = 'completed' WHERE id = $1`, [ipoId]));
  flushNotifications();
  return { settled, dust };
}

app.post('/admin/ipos/:id/settle', { preHandler: auth('admin') }, async (req: any, reply) => {
  const { rows: [ipo] } = await pool.query<IpoRow>(
    'SELECT *, 0 AS raised, 0 AS subscribers FROM ipos WHERE id = $1', [req.params.id]);
  if (!ipo) return reply.code(404).send({ error: 'no such offering' });
  const status = effectiveStatus(ipo);
  if (status !== 'active' && status !== 'closed' && status !== 'completed') {
    return reply.code(409).send({ error: `an ${status} offering has nothing to settle` });
  }
  // Bring accrual up to date first, so an early settlement pays what was actually earned.
  await accrueIpos();
  return settleIpo(ipo.id, req.principal.sub);
});

/**
 * Credit a day's ROI on every active subscription of an active offering.
 *
 * Modelled on accrueInterest and deliberately not a second mechanism: claim the day by
 * moving last_accrued_on inside the same transaction that credits it, so running twice in
 * a day pays once, a rolled-back transaction leaves the day unclaimed, and a week lost to
 * an outage is paid as one compounded step equal to seven daily ones.
 *
 * Accrual stops at matures_at. A subscription is only ever paid for its term, whenever the
 * job happens to run.
 */
async function accrueIpos(): Promise<{ subscriptions: number; posted: number }> {
  const { rows } = await pool.query<{
    id: string; client_id: string; amount: number; accrued: number; currency: string;
    rate: number; name: string; last_accrued_on: string; matures_at: Date | null;
    closes_on: string;
  }>(`
    SELECT s.id, s.client_id, s.amount, s.accrued, s.currency, s.last_accrued_on,
           i.name, i.matures_at, i.closes_at::date AS closes_on,
           -- The rate agreed on this subscription wins over the offering's. One
           -- expression, used by the job that pays and by the screens that promise.
           coalesce(s.roi_override, i.roi_rate) AS rate
      FROM ipo_subscriptions s JOIN ipos i ON i.id = s.ipo_id
     WHERE s.status = 'active'
       AND s.amount > 0
       AND s.last_accrued_on < current_date
       AND i.status NOT IN ('draft', 'cancelled')
       AND i.closes_at IS NOT NULL AND i.matures_at IS NOT NULL
       AND i.closes_at <= now()`);

  let posted = 0;
  for (const s of rows) {
    // Accrual runs from the later of what has already been paid and the offering's close,
    // read fresh each time. Both are plain YYYY-MM-DD, so the string comparison is the
    // date comparison. A subscription taken during the window earns from the close, not
    // from the day it was taken — the ROI is for the term.
    const from = s.last_accrued_on > s.closes_on ? s.last_accrued_on : s.closes_on;
    const days = accruableDays({ lastAccruedOn: from, maturesAt: s.matures_at });
    if (days <= 0) {
      // Past maturity with nothing left to pay: claim the day so this row stops being
      // reconsidered on every sweep.
      await pool.query('UPDATE ipo_subscriptions SET last_accrued_on = current_date WHERE id = $1', [s.id]);
      continue;
    }
    // ROI is earned on what was subscribed plus what it has already earned — the same
    // compounding the client was promised.
    const roi = accrue({
      balance: round8(Number(s.amount) + Number(s.accrued)),
      annualRate: Number(s.rate), days,
    });
    if (roi <= 0) {
      await pool.query('UPDATE ipo_subscriptions SET last_accrued_on = current_date WHERE id = $1', [s.id]);
      continue;
    }
    await tx('system', async (c) => {
      const { rowCount } = await c.query(
        `UPDATE ipo_subscriptions
            SET accrued = accrued + $2,
                last_accrued_on = least(current_date, coalesce($3::date, current_date))
          WHERE id = $1 AND last_accrued_on < current_date`,
        [s.id, roi, s.matures_at]);
      if (!rowCount) return;                     // another run got there first
      await logActivity(c, {
        client_id: s.client_id, kind: 'ipo', actor: 'system',
        summary: `ROI of ${roi} ${s.currency} on ${s.name}`,
        ref_table: 'ipos', ref_id: null as unknown as string,
        data: { days, rate: Number(s.rate), roi, subscription: s.id },
      });
      await notifyClientOf(c, {
        client_id: s.client_id, kind: 'ipo',
        title: `ROI on ${s.name}`,
        body: `${roi} ${s.currency} credited for ${days} day(s).`,
      });
      posted++;
    });
  }
  flushNotifications();
  return { subscriptions: rows.length, posted };
}

/**
 * Run the accrual now, and settle anything that has matured.
 *
 * Exists for the same reason /admin/accrue does: operations can re-run after an incident
 * and the day rollover can be exercised without waiting for one. Idempotent, so an
 * accidental double-click costs nothing.
 */
app.post('/admin/accrue-ipos', { preHandler: auth('admin') }, async (req: any) => {
  const accrued = await accrueIpos();
  const matured = await maturedIpos(req.principal.sub);
  return { ...accrued, ...matured };
});

/** Settle every offering whose maturity has passed. Safe to run repeatedly. */
async function maturedIpos(actor: string): Promise<{ offerings: number; settled: number }> {
  const { rows } = await pool.query<{ id: string }>(`
    SELECT i.id FROM ipos i
     WHERE i.status NOT IN ('draft', 'cancelled', 'completed')
       AND i.matures_at IS NOT NULL AND i.matures_at <= now()
       AND EXISTS (SELECT 1 FROM ipo_subscriptions s WHERE s.ipo_id = i.id AND s.status = 'active')`);
  let settled = 0;
  for (const r of rows) settled += (await settleIpo(r.id, actor)).settled;
  return { offerings: rows.length, settled };
}


// ------------------------------------------------------------------ email to clients
/*
 * An article the desk writes once and sends to everybody who has not opted out.
 *
 * Four things shape this, and all four are about the fact that mail cannot be recalled:
 *
 *   Drafting and sending are separate calls. Compose, read it back, send it to yourself,
 *   then release it. One endpoint that composed and delivered would make a typo permanent
 *   for a thousand people simultaneously.
 *
 *   The send is guarded by a count. The caller states how many people it expects to reach
 *   and the server refuses if that is not the number it computes. A stale screen, a client
 *   list that grew, or a misclick on the wrong campaign all fail closed.
 *
 *   Every recipient is recorded before the message leaves, with a UNIQUE on
 *   (campaign_id, client_id). Running the same send twice delivers nothing the second time.
 *
 *   One failure is one failure. A refused address is written down and the loop carries on,
 *   because the alternative is that client 4 of 900 decides the other 896 hear nothing.
 */

/** Who a campaign would actually reach: opted in, and with an address to reach them at. */
const RECIPIENTS = `
  FROM clients c
 WHERE c.email_opt_out = false
   AND c.email IS NOT NULL AND c.email <> ''`;

/**
 * The people one campaign reaches.
 *
 * Either the whole list or the ones the desk picked — and in both cases never anybody who
 * opted out, because a name on a hand-picked list is not consent. The same fragment counts
 * them for the confirmation, counts them again under the row lock, and selects them for the
 * loop, so the number the screen showed is the number that goes out.
 */
const audienceOf = (c: { audience: string; recipient_ids: string[] | null }) => (c.audience === 'selected'
  ? {
    sql: `FROM clients c
          WHERE c.id = ANY($1::uuid[])
            AND c.email_opt_out = false
            AND c.email IS NOT NULL AND c.email <> ''`,
    params: [c.recipient_ids ?? []] as unknown[],
  }
  : { sql: RECIPIENTS, params: [] as unknown[] });

app.get('/admin/email/status', { preHandler: auth('admin') }, async () => {
  const cfg = mailConfig();
  /**
   * Which of the settings are present — names and booleans, never values.
   *
   * "Not configured" on its own sends somebody to check five variables when four of them are
   * fine. Whether a name is set is an operational fact and leaks nothing; what it is set to
   * is a credential and stays in the process. SMTP_HOST and SMTP_FROM are the two that
   * decide whether anything can be sent at all, which is why their absence is what the
   * screen names first.
   */
  const set = (name: string) => (process.env[name]?.trim() ?? '') !== '';
  const settings = {
    SMTP_FROM: set('SMTP_FROM'),
    POSTMARK_SERVER_TOKEN: set('POSTMARK_SERVER_TOKEN'),
    SMTP_HOST: set('SMTP_HOST'),
    SMTP_PORT: set('SMTP_PORT'),
    SMTP_USER: set('SMTP_USER'),
    SMTP_PASS: set('SMTP_PASS'),
    SMTP_MESSAGE_STREAM: set('SMTP_MESSAGE_STREAM'),
    PUBLIC_URL: set('PUBLIC_URL'),
  };
  // A sender, and one way out: the Postmark token (HTTPS, works on any host) or an SMTP host
  // (blocked outright on some — Railway below its Pro plan). Named in that order because the
  // token is the one that works where this is deployed.
  const missing: string[] = [];
  if (!settings.SMTP_FROM) missing.push('SMTP_FROM');
  if (!settings.POSTMARK_SERVER_TOKEN && !settings.SMTP_HOST) missing.push('POSTMARK_SERVER_TOKEN or SMTP_HOST');
  const { rows: [n] } = await pool.query<{ eligible: number; opted_out: number }>(`
    SELECT (SELECT count(*)::int ${RECIPIENTS}) AS eligible,
           (SELECT count(*)::int FROM clients WHERE email_opt_out) AS opted_out`);
  return {
    // What is set, never what it is set to: a host and a sender are operational facts, a
    // password is not, and it has no business leaving the process that reads it.
    configured: cfg !== null,
    transport: cfg?.transport ?? null,
    host: cfg?.host ?? null,
    port: cfg?.port ?? null,
    secure: cfg?.secure ?? null,
    from: cfg?.from ?? null,
    message_stream: cfg?.messageStream ?? null,
    authenticated: cfg?.user !== null && cfg?.user !== undefined,
    settings,
    missing,
    eligible: n.eligible,
    opted_out: n.opted_out,
  };
});

/** Ask the mail server whether it would have us, without sending to anybody. */
app.post('/admin/email/verify', { preHandler: auth('admin') }, async (_req, reply) => {
  const out = await verifyMail();
  if (!out.ok) return reply.code(502).send({ ok: false, error: out.error });
  return { ok: true };
});

/**
 * A draft written from what actually happened, rather than from nothing.
 *
 * It reports the shelf: what opened, what is closing, what matured. Facts this database
 * holds, phrased plainly. It deliberately contains no market commentary, no outlook and no
 * suggestion about what anybody should do with their money — this desk is simulated, the
 * author is a program, and an article that told clients what to buy would be the one part of
 * this feature nobody could defend. The desk edits it before it goes anywhere.
 */
async function draftWeeklyUpdate(): Promise<{ subject: string; body: string }> {
  const { rows: opened } = await pool.query<{ name: string; closes_at: Date | null }>(`
    SELECT name, closes_at FROM ipos
     WHERE status NOT IN ('draft','cancelled') AND opens_at IS NOT NULL
       AND opens_at >= now() - interval '7 days' AND opens_at <= now()
     ORDER BY opens_at`);
  const { rows: closing } = await pool.query<{ name: string; closes_at: Date }>(`
    SELECT name, closes_at FROM ipos
     WHERE status NOT IN ('draft','cancelled') AND closes_at IS NOT NULL
       AND closes_at > now() AND closes_at <= now() + interval '14 days'
     ORDER BY closes_at`);
  const { rows: matured } = await pool.query<{ name: string }>(`
    SELECT name FROM ipos
     WHERE matures_at IS NOT NULL AND matures_at >= now() - interval '7 days'
       AND matures_at <= now() AND status <> 'cancelled'
     ORDER BY matures_at`);
  const { rows: [shelf] } = await pool.query<{ open: number }>(`
    SELECT count(*)::int AS open FROM ipos
     WHERE status NOT IN ('draft','cancelled')
       AND opens_at <= now() AND closes_at > now()`);

  const when = (d: Date | null) => (d
    ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'shortly');
  const list = (xs: string[]) => (xs.length > 1
    ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] ?? '');

  const paras: string[] = ['Here is what changed on the desk this week.'];

  if (opened.length) {
    paras.push(`${list(opened.map((o) => o.name))} ${opened.length > 1 ? 'opened' : 'opened'} `
      + `for subscription. You can read the terms on the IPO offerings page.`);
  }
  if (closing.length) {
    paras.push(`Closing soon: ${closing.map((c) => `${c.name} on ${when(c.closes_at)}`).join('; ')}. `
      + `Once a book closes nothing further can be put into it.`);
  }
  if (matured.length) {
    paras.push(`${list(matured.map((m) => m.name))} reached maturity. Where you held an `
      + `allocation, the principal and the return accrued over the term were paid to your balance.`);
  }
  if (!opened.length && !closing.length && !matured.length) {
    paras.push('No offerings opened, closed or matured this week.');
  }
  paras.push(shelf.open
    ? `There ${shelf.open === 1 ? 'is one offering' : `are ${shelf.open} offerings`} open for `
      + `subscription right now.`
    : 'Nothing is open for subscription at the moment.');
  paras.push('As always, your positions, balances and documents are on your account page.');

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return { subject: `Weekly update — ${today}`, body: paras.join('\n\n') };
}

const campaignBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});

app.get('/admin/campaigns', { preHandler: auth('admin') }, async () =>
  (await pool.query(`
    SELECT c.id, c.kind, c.subject, c.status, c.created_at, c.started_at, c.finished_at,
           c.recipients, c.failures, s.name AS created_by,
           c.audience, cardinality(c.recipient_ids) AS chosen
      FROM email_campaigns c LEFT JOIN staff s ON s.id = c.created_by
     ORDER BY c.created_at DESC LIMIT 50`)).rows);

app.get('/admin/campaigns/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  const { rows: [c] } = await pool.query<{ audience: string; recipient_ids: string[] | null }>(
    'SELECT * FROM email_campaigns WHERE id = $1', [req.params.id]);
  if (!c) return reply.code(404).send({ error: 'no such campaign' });
  const who = audienceOf(c);
  const { rows: [n] } = await pool.query<{ eligible: number }>(
    `SELECT count(*)::int AS eligible ${who.sql}`, who.params);
  // The picked list as people, with the reason any of them will be skipped, so the screen
  // can say "these three, and not that one" rather than show a number that does not add up.
  const { rows: chosen_clients } = c.audience === 'selected'
    ? await pool.query(
      `SELECT id, name, email, email_opt_out FROM clients WHERE id = ANY($1::uuid[]) ORDER BY name`,
      [c.recipient_ids ?? []])
    : { rows: [] };
  const { rows: deliveries } = await pool.query(`
    SELECT d.status, d.email, d.error, d.sent_at, cl.name
      FROM email_deliveries d JOIN clients cl ON cl.id = d.client_id
     WHERE d.campaign_id = $1 ORDER BY d.sent_at DESC LIMIT 200`, [req.params.id]);
  return { ...c, eligible: n.eligible, chosen_clients, deliveries };
});

/** Who a campaign is for. A hand-picked list has to have somebody on it. */
const audienceBody = z.object({
  audience: z.enum(['all', 'selected']).optional(),
  recipient_ids: z.array(z.string().uuid()).max(5000).optional(),
}).refine((o) => o.audience !== 'selected' || (o.recipient_ids?.length ?? 0) > 0,
  { message: 'choose at least one client', path: ['recipient_ids'] });

/**
 * Create a draft.
 *
 * `mode` decides the words: 'weekly' is written from what happened on the desk, 'blank' is
 * an empty page the desk fills in. A subject and body given outright are used as they are.
 * The audience is chosen here too, before there is a text box to get lost in, and can be
 * changed on the draft afterwards.
 */
app.post('/admin/campaigns', { preHandler: auth('admin') }, async (req: any, reply) => {
  const given = campaignBody.partial().extend({ mode: z.enum(['weekly', 'blank']).optional() })
    .and(audienceBody).safeParse(req.body ?? {});
  if (!given.success) return reply.code(400).send({ error: given.error.flatten() });
  const g = given.data;
  const draft = g.subject && g.body ? { kind: 'custom', subject: g.subject, body: g.body }
    : g.mode === 'blank' ? { kind: 'custom', subject: '', body: '' }
      : { kind: 'weekly_update', ...(await draftWeeklyUpdate()) };
  const audience = g.audience ?? 'all';

  return await tx(req.principal.sub, async (c) => {
    const { rows: [made] } = await c.query(
      `INSERT INTO email_campaigns (kind, subject, body, created_by, audience, recipient_ids)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [draft.kind, draft.subject, draft.body, req.principal.sub, audience,
       audience === 'selected' ? g.recipient_ids : null]);
    return reply.code(201).send(made);
  });
});

app.patch('/admin/campaigns/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = campaignBody.partial().and(audienceBody)
    .refine((o) => Object.keys(o).length > 0, 'nothing to change')
    .safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  // Going back to everyone drops the list, so the record never carries a list it ignores.
  if (body.data.audience === 'all') body.data.recipient_ids = null as unknown as undefined;
  if (body.data.recipient_ids && !body.data.audience) body.data.audience = 'selected';

  const out = await tx(req.principal.sub, async (c) => {
    const { rows: [before] } = await c.query<{ status: string }>(
      'SELECT status FROM email_campaigns WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!before) return { kind: 'missing' } as const;
    // Editing something already delivered would rewrite history without touching a single
    // inbox: the record has to keep saying what was actually sent.
    if (before.status !== 'draft') return { kind: 'not-draft', status: before.status } as const;
    const entries = Object.entries(body.data);
    const { rows: [after] } = await c.query(
      `UPDATE email_campaigns SET ${entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')}
        WHERE id = $1 RETURNING *`,
      [req.params.id, ...entries.map(([, v]) => v)]);
    return { kind: 'ok', campaign: after } as const;
  });
  if (out.kind === 'missing') return reply.code(404).send({ error: 'no such campaign' });
  if (out.kind === 'not-draft') {
    return reply.code(409).send({ error: `this campaign is ${out.status} and cannot be edited` });
  }
  return out.campaign;
});

/** Send it to one address — normally the admin's own — and to nobody else. */
app.post('/admin/campaigns/:id/test', { preHandler: auth('admin') }, async (req: any, reply) => {
  const to = z.object({ to: z.string().email() }).safeParse(req.body);
  if (!to.success) return reply.code(400).send({ error: 'a single address to send the test to' });

  const { rows: [c] } = await pool.query<{ subject: string; body: string }>(
    'SELECT subject, body FROM email_campaigns WHERE id = $1', [req.params.id]);
  if (!c) return reply.code(404).send({ error: 'no such campaign' });

  const cfg = mailConfig();
  if (!cfg) return reply.code(503).send({ error: 'Email is not configured' });
  // A test carries an unsubscribe link that goes nowhere real: it is not addressed to a
  // client, so there is no consent to withdraw and nothing to look up.
  const unsubscribeUrl = `${cfg.publicUrl}/unsubscribe?token=test`;
  const { text, html } = renderMail({
    subject: c.subject, body: c.body, name: 'there', unsubscribeUrl, publicUrl: cfg.publicUrl,
  });
  const sent = await sendMail({
    to: to.data.to, subject: `[test] ${c.subject}`, text, html, unsubscribeUrl,
  });
  if (!sent.ok) return reply.code(502).send({ error: sent.error });
  return { ok: true, to: to.data.to };
});

/**
 * Send it to every client who has not opted out.
 *
 * `confirm_recipients` has to match the number the server counts. It is not ceremony: the
 * screen that offered the button may have been open for an hour, the list may have grown,
 * and this is the one action here that cannot be undone by pressing something else.
 */
app.post('/admin/campaigns/:id/send', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = z.object({ confirm_recipients: z.number().int().min(0) }).safeParse(req.body);
  if (!body.success) {
    return reply.code(400).send({ error: 'confirm_recipients must state how many this will reach' });
  }
  const cfg = mailConfig();
  if (!cfg) return reply.code(503).send({ error: 'Email is not configured' });

  // Claim the campaign: moving it out of draft inside a transaction is what stops two
  // admins, or one admin clicking twice, both starting the same run.
  const claim = await tx(req.principal.sub, async (c) => {
    const { rows: [row] } = await c.query<{
      id: string; status: string; subject: string; body: string;
      audience: string; recipient_ids: string[] | null;
    }>(
      `SELECT id, status, subject, body, audience, recipient_ids
         FROM email_campaigns WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!row) return { kind: 'missing' } as const;
    if (row.status !== 'draft') return { kind: 'busy', status: row.status } as const;
    // A blank page can be created on purpose; it cannot be sent by accident.
    if (!row.subject.trim() || !row.body.trim()) return { kind: 'blank' } as const;

    const who = audienceOf(row);
    const { rows: [n] } = await c.query<{ eligible: number }>(
      `SELECT count(*)::int AS eligible ${who.sql}`, who.params);
    if (n.eligible !== body.data.confirm_recipients) {
      return { kind: 'changed', eligible: n.eligible } as const;
    }
    if (n.eligible === 0) return { kind: 'nobody' } as const;
    await c.query(`UPDATE email_campaigns SET status = 'sending', started_at = now() WHERE id = $1`,
      [row.id]);
    return { kind: 'ok', campaign: row, eligible: n.eligible, who } as const;
  });

  if (claim.kind === 'missing') return reply.code(404).send({ error: 'no such campaign' });
  if (claim.kind === 'busy') {
    return reply.code(409).send({ error: `this campaign is already ${claim.status}` });
  }
  if (claim.kind === 'blank') {
    return reply.code(422).send({ error: 'write a subject and a message before sending' });
  }
  if (claim.kind === 'nobody') {
    return reply.code(422).send({ error: 'nobody on this list can be emailed — they have no address or have opted out' });
  }
  if (claim.kind === 'changed') {
    return reply.code(409).send({
      error: `this would now reach ${claim.eligible} clients, not ${body.data.confirm_recipients}.`
        + ' Nothing was sent — check the number and try again.',
      eligible: claim.eligible,
    });
  }

  // Nobody is mailed without a working way out. The column has a default, so this fills
  // nothing on a healthy database — it is here because the failure it prevents is silent:
  // a missing token renders as ?token=null, which looks like a link, reads like a link, and
  // unsubscribes nobody. Cheap, idempotent, and it runs before a single message goes out.
  const { rowCount: repaired } = await pool.query(`
    UPDATE clients
       SET unsubscribe_token = replace(gen_random_uuid()::text, '-', '')
                            || replace(gen_random_uuid()::text, '-', '')
     WHERE unsubscribe_token IS NULL`);
  if (repaired) app.log.warn({ repaired }, 'clients had no unsubscribe token; generated one each');

  const { rows: people } = await pool.query<{
    id: string; name: string; email: string; unsubscribe_token: string;
  }>(`SELECT c.id, c.name, c.email, c.unsubscribe_token ${claim.who.sql} ORDER BY c.created_at`, claim.who.params);

  let sent = 0;
  let failed = 0;
  for (const person of people) {
    const unsubscribeUrl = `${cfg.publicUrl}/unsubscribe?token=${person.unsubscribe_token}`;
    const { text, html } = renderMail({
      subject: claim.campaign.subject, body: claim.campaign.body,
      name: person.name, unsubscribeUrl, publicUrl: cfg.publicUrl,
    });
    const out = await sendMail({
      to: person.email, subject: claim.campaign.subject, text, html, unsubscribeUrl,
    });

    // Recorded whether it worked or not, and never allowed to throw: a bookkeeping failure
    // must not stop the run, and ON CONFLICT is what makes a re-run skip these.
    try {
      await pool.query(
        `INSERT INTO email_deliveries (campaign_id, client_id, email, status, error)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (campaign_id, client_id) DO NOTHING`,
        [claim.campaign.id, person.id, person.email, out.ok ? 'sent' : 'failed',
         out.ok ? null : out.error.slice(0, 500)]);
    } catch (err) {
      app.log.error({ err, client: person.id }, 'could not record an email delivery');
    }
    if (out.ok) sent++; else failed++;
  }

  await tx(req.principal.sub, (c) => c.query(
    `UPDATE email_campaigns SET status = $2, finished_at = now(), recipients = $3, failures = $4
      WHERE id = $1`,
    [claim.campaign.id, failed === people.length && people.length > 0 ? 'failed' : 'sent', sent, failed]));

  app.log.info({ campaign: claim.campaign.id, sent, failed }, 'weekly update sent');
  return { ok: true, sent, failed, recipients: people.length };
});

/**
 * Stop receiving these, without signing in.
 *
 * Unauthenticated on purpose: somebody who no longer wants our mail must not have to
 * remember a password to say so, and a link that leads to a login screen is a link that gets
 * the message reported as spam instead. The token is random and per client, so it identifies
 * one person without exposing an id, and it always answers the same way — an unknown token
 * gets the same page a known one does, because differing replies would turn this into a
 * checker for which tokens are real.
 */
app.get('/unsubscribe', async (req: any, reply) => {
  const token = String(req.query?.token ?? '');
  if (token && token !== 'test') {
    await tx('unsubscribe', (c) => c.query(
      `UPDATE clients SET email_opt_out = true, email_opt_out_at = now()
        WHERE unsubscribe_token = $1 AND email_opt_out = false`, [token]));
  }
  return reply.type('text/html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribed</title></head>
<body style="margin:0;padding:48px 24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
<div style="font-size:18px;">Pantera GP <span style="color:#ff7817;">///</span></div>
<h1 style="font-size:20px;margin:18px 0 10px;">You will not get these any more</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 12px;">
  We have stopped sending you update emails. It takes effect immediately — nothing further
  is queued.</p>
<p style="font-size:14px;line-height:1.6;color:#66666e;margin:0;">
  This does not close your account or affect anything about it. Messages about your own
  account — a document we need, a withdrawal, something you asked us to tell you — are not
  part of this and will still reach you.</p>
</div></body></html>`);
});


// -------------------------------------------------- writing to one client, from their record
/*
 * A message to one person, composed on their record by whoever looks after them.
 *
 * Deliberately not a campaign of one. There is no recipient count to confirm, because the
 * recipient is on the screen; no unsubscribe link, because one message from an account
 * manager is not a list anybody joined; and the marketing opt-out does not silence it, for
 * the same reason — somebody who asked not to receive the weekly update still needs to hear
 * that their document expired. The screen shows their opt-out state so the sender knows what
 * kind of message would be unwelcome, which is a judgement a person should make, not a
 * filter.
 *
 * What is stored is the text that was sent, never a reference to the template it came from:
 * a template edited next month must not silently rewrite what was said last month.
 */

/** {{name}} and {{email}} only — a template language is not what this needs to be. */
const fillTemplate = (s: string, c: { name: string; email: string }) =>
  s.replaceAll('{{name}}', c.name).replaceAll('{{email}}', c.email);

app.get('/admin/email-templates', { preHandler: auth('crm:read') }, async () =>
  (await pool.query(`
    SELECT t.id, t.name, t.subject, t.body, t.updated_at, s.name AS created_by
      FROM email_templates t LEFT JOIN staff s ON s.id = t.created_by
     ORDER BY t.name`)).rows);

const templateBody = z.object({
  name: z.string().min(1).max(80),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
});

app.post('/admin/email-templates', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = templateBody.safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  try {
    return await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO email_templates (name, subject, body, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [body.data.name, body.data.subject, body.data.body, req.principal.sub]);
      return reply.code(201).send(rows[0]);
    });
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'a template with that name exists' });
    throw err;
  }
});

app.patch('/admin/email-templates/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  const body = templateBody.partial()
    .refine((o) => Object.keys(o).length > 0, 'nothing to change').safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  const entries = Object.entries(body.data);
  try {
    const out = await tx(req.principal.sub, async (c) => {
      const { rows } = await c.query(
        `UPDATE email_templates SET ${entries.map(([k], i) => `${k} = ${i + 2}`).join(', ')}
          WHERE id = $1 RETURNING *`, [req.params.id, ...entries.map(([, v]) => v)]);
      return rows[0] ?? null;
    });
    if (!out) return reply.code(404).send({ error: 'no such template' });
    return out;
  } catch (err: any) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'a template with that name exists' });
    throw err;
  }
});

app.delete('/admin/email-templates/:id', { preHandler: auth('admin') }, async (req: any, reply) => {
  // Messages already sent keep their text and lose only the link back, by ON DELETE SET NULL:
  // deleting a template must not erase the record of what somebody was told.
  const out = await tx(req.principal.sub, async (c) =>
    (await c.query('DELETE FROM email_templates WHERE id = $1 RETURNING id', [req.params.id])).rows[0] ?? null);
  if (!out) return reply.code(404).send({ error: 'no such template' });
  return { ok: true };
});

/** What has been written to this client, newest first. */
app.get('/clients/:id/emails', { preHandler: clientScope }, async (req: any, reply) => {
  if (req.principal.kind === 'client') {
    return reply.code(403).send({ error: 'staff only' });
  }
  return (await pool.query(`
    SELECT e.id, e.subject, e.body, e.email, e.status, e.error, e.sent_at, s.name AS sent_by
      FROM client_emails e LEFT JOIN staff s ON s.id = e.sent_by
     WHERE e.client_id = $1 ORDER BY e.sent_at DESC LIMIT 50`, [req.params.id])).rows;
});

app.post('/clients/:id/email', { preHandler: auth('crm:write') }, async (req: any, reply) => {
  const body = z.object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    template_id: z.string().uuid().nullable().optional(),
  }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const cfg = mailConfig();
  if (!cfg) return reply.code(503).send({ error: 'Email is not configured' });

  const { rows: [client] } = await pool.query<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM clients WHERE id = $1', [req.params.id]);
  if (!client) return reply.code(404).send({ error: 'no such client' });
  if (!client.email) return reply.code(422).send({ error: 'this client has no email address' });

  const subject = fillTemplate(body.data.subject, client);
  const text = fillTemplate(body.data.body, client);
  // No unsubscribe link: this is one message to one person from the desk that holds their
  // account, not a list. renderMail wants a url, so it gets the account page — the footer
  // reads as "open your account" and offers nothing to opt out of.
  const { html } = renderMail({
    subject, body: text, name: client.name, publicUrl: cfg.publicUrl,
  });

  const out = await sendMail({ to: client.email, subject, text, html });

  await tx(req.principal.sub, async (c) => {
    await c.query(
      `INSERT INTO client_emails (client_id, email, subject, body, template_id, sent_by, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [client.id, client.email, subject, text, body.data.template_id ?? null,
       req.principal.sub, out.ok ? 'sent' : 'failed', out.ok ? null : out.error.slice(0, 500)]);
    // On the client's own timeline, because "we emailed them this" is part of the record of
    // the relationship and the next person to pick up the account needs to see it.
    await logActivity(c, {
      client_id: client.id, kind: 'note', actor: req.principal.sub,
      summary: out.ok ? `Emailed: ${subject}` : `Email failed: ${subject}`,
      ref_table: 'client_emails', data: { ok: out.ok },
    });
  });

  if (!out.ok) return reply.code(502).send({ error: out.error });
  return { ok: true, to: client.email };
});

// ------------------------------------------------------------------- articles
//
// Posts written and published by bunzy, a content service that writes for search, kept in
// this database and served from this origin as the public Insights pages. The receiver is
// the only way an article gets in: nobody on the desk writes one here, and nothing a client
// sends touches them.
//
// Three rules the service sets and this side keeps. Every delivery is signed over its raw
// bytes and is checked before it is read — an unsigned or mis-signed delivery is answered
// 401 and never parsed. A delivery is acknowledged within the service's ten seconds and
// applied afterwards, because the service does not retry: an article whose delivery times
// out is simply lost, and a database write should never be what loses it. And a delivery
// is applied once: the delivery id is unique in article_deliveries, so the same delivery
// arriving twice is acknowledged and ignored.
//
// ponytail: cover images are linked from the service's CDN rather than copied into
//   uploads. They render either way; copy them in if the service ever goes away.

const bunzySecret = () => process.env.BUNZY_WEBHOOK_SECRET?.trim() || undefined;
const publicUrl = () => (process.env.PUBLIC_URL?.trim() || `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

const CARD = 'slug, title, excerpt, cover_url, tags, read_minutes, published_at';
const cardOf = (r: any): ArticleCard => ({ ...r, published_at: iso(r.published_at)! });
const articleOf = (r: any): Article => ({
  ...r,
  published_at: iso(r.published_at)!,
  updated_at: iso(r.source_updated_at),
  key_takeaways: Array.isArray(r.key_takeaways) ? r.key_takeaways : [],
  faq: Array.isArray(r.faq) ? r.faq : [],
});
const PAGE = 12;

/** Live articles, newest first, optionally under one tag. */
async function liveArticles(opts: { tag?: string; page: number }) {
  const where = ['unpublished_at IS NULL'];
  const params: unknown[] = [];
  if (opts.tag) { params.push(opts.tag); where.push(`$${params.length} = ANY (tags)`); }
  const w = where.join(' AND ');
  const { rows: [{ n }] } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM articles WHERE ${w}`, params);
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const page = Math.min(Math.max(1, opts.page), pages);
  const { rows } = await pool.query(
    `SELECT ${CARD} FROM articles WHERE ${w} ORDER BY published_at DESC, slug LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`, params);
  return { articles: rows.map(cardOf), page, pages, total: n };
}

/** The delivery, applied after it was acknowledged. Its row records what became of it. */
async function applyDelivery(id: number, d: Delivery, raw: unknown) {
  try {
    const status = await tx('bunzy', async (c) => {
      if (d.event === 'article.unpublished') {
        const r = await c.query('UPDATE articles SET unpublished_at = now() WHERE slug = $1 AND unpublished_at IS NULL', [d.slug]);
        return r.rowCount ? 'applied' : 'ignored';
      }
      const a = d.article!;
      await c.query(
        `INSERT INTO articles (slug, title, excerpt, html, markdown, cover_url, tags, read_minutes, author_name,
                               canonical_url, meta_title, meta_description, og_image_url, json_ld, key_takeaways, faq,
                               raw, published_at, source_updated_at, unpublished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL)
         ON CONFLICT (slug) DO UPDATE SET
           title = EXCLUDED.title, excerpt = EXCLUDED.excerpt, html = EXCLUDED.html, markdown = EXCLUDED.markdown,
           cover_url = EXCLUDED.cover_url, tags = EXCLUDED.tags, read_minutes = EXCLUDED.read_minutes,
           author_name = EXCLUDED.author_name, canonical_url = EXCLUDED.canonical_url, meta_title = EXCLUDED.meta_title,
           meta_description = EXCLUDED.meta_description, og_image_url = EXCLUDED.og_image_url, json_ld = EXCLUDED.json_ld,
           key_takeaways = EXCLUDED.key_takeaways, faq = EXCLUDED.faq, raw = EXCLUDED.raw,
           published_at = EXCLUDED.published_at, source_updated_at = EXCLUDED.source_updated_at, unpublished_at = NULL`,
        [a.slug, a.title, a.excerpt, a.html, a.markdown, a.cover_url, a.tags, a.read_minutes, a.author_name,
          a.canonical_url, a.meta_title, a.meta_description, a.og_image_url,
          a.json_ld == null ? null : JSON.stringify(a.json_ld), JSON.stringify(a.key_takeaways), JSON.stringify(a.faq),
          JSON.stringify(raw), a.published_at, a.updated_at]);
      return 'applied';
    });
    await pool.query('UPDATE article_deliveries SET status = $2, settled_at = now() WHERE id = $1', [id, status]);
    app.log.info({ event: d.event, slug: d.slug, status }, 'article delivery applied');
  } catch (err) {
    app.log.error({ err, event: d.event, slug: d.slug }, 'article delivery failed');
    await pool.query('UPDATE article_deliveries SET status = $2, error = $3, settled_at = now() WHERE id = $1',
      [id, 'failed', String((err as Error).message ?? err).slice(0, 500)]).catch(() => {});
  }
}

/**
 * bunzy's receiver. Unauthenticated in the app's sense — the service has no login — and
 * guarded instead by the signature over the raw body, which is why the JSON parser keeps
 * those bytes on the request. The bearer the service also sends is checked when present;
 * the signature is what admits a delivery, because a bearer alone proves nothing about
 * the body it came with.
 */
app.post('/webhooks/bunzy', async (req: any, reply) => {
  const secret = bunzySecret();
  if (!secret) return reply.code(503).send({ error: 'the receiver is not configured: set BUNZY_WEBHOOK_SECRET' });
  const raw = (req.raw as RawBodied).rawBody;
  if (typeof raw !== 'string') return reply.code(415).send({ error: 'send application/json' });
  if (!signatureMatches(raw, req.headers['x-bunzy-signature'], secret)) {
    return reply.code(401).send({ error: 'invalid signature' });
  }
  if (req.headers.authorization && !bearerMatches(req.headers.authorization, secret)) {
    return reply.code(401).send({ error: 'invalid bearer' });
  }
  let d: Delivery;
  try {
    d = parseDelivery(req.body);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  // The Test button's synthetic article: logged so the desk can see the wiring works,
  // never stored as a post.
  if (d.test) {
    await pool.query(
      `INSERT INTO article_deliveries (delivery_id, event_type, slug, test, status, settled_at)
       VALUES ($1,$2,$3,true,'ignored',now()) ON CONFLICT (delivery_id) DO NOTHING`,
      [d.delivery_id, d.event, d.slug]);
    return { message: 'Test received' };
  }
  const { rows: [row] } = await pool.query<{ id: number }>(
    `INSERT INTO article_deliveries (delivery_id, event_type, slug) VALUES ($1,$2,$3)
     ON CONFLICT (delivery_id) DO NOTHING RETURNING id`,
    [d.delivery_id, d.event, d.slug]);
  if (!row) return { message: 'Already received' };
  // Acknowledge, then apply: the write is quick, but the service's clock is the one that
  // matters and a slow database must not cost an article.
  reply.send({ message: 'Received' });
  setImmediate(() => { void applyDelivery(row.id, d, req.body); });
  return reply;
});

/** The desk's view of the receiver: whether it is configured, what arrived, what stuck. */
app.get('/admin/articles', { preHandler: auth('admin') }, async () => {
  const [{ rows: articles }, { rows: deliveries }, { rows: [count] }] = await Promise.all([
    pool.query('SELECT slug, title, published_at, unpublished_at, updated_at FROM articles ORDER BY published_at DESC LIMIT 100'),
    pool.query('SELECT id, delivery_id, event_type, slug, test, status, error, received_at, settled_at FROM article_deliveries ORDER BY id DESC LIMIT 50'),
    pool.query<{ live: number }>('SELECT count(*)::int AS live FROM articles WHERE unpublished_at IS NULL'),
  ]);
  return {
    configured: !!bunzySecret(),
    endpoint: `${publicUrl()}/api/webhooks/bunzy`,
    live: count!.live,
    articles, deliveries,
  };
});

const listQuery = z.object({ page: z.coerce.number().int().min(1).default(1), tag: z.string().max(60).optional() });

// The same articles as JSON, for the mobile client or anything else that renders its own.
app.get('/articles', async (req: any) => liveArticles(listQuery.parse(req.query)));
app.get('/articles/:slug', async (req: any, reply) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG.test(slug)) return reply.code(404).send({ error: 'not found' });
  const { rows: [row] } = await pool.query('SELECT * FROM articles WHERE slug = $1 AND unpublished_at IS NULL', [slug]);
  if (!row) return reply.code(404).send({ error: 'not found' });
  const { raw: _raw, ...rest } = row;
  return articleOf(rest);
});

// The pages themselves. Cached briefly at the edge and in the browser: an article changes
// when the service says so, and a minute's staleness is nothing against a page load that
// hits the database for every crawler.
const html = (reply: any) => reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=60');

app.get('/blog', async (req: any, reply) => {
  const q = listQuery.parse(req.query);
  const list = await liveArticles(q);
  return html(reply).send(indexPage({ ...list, publicUrl: publicUrl() }));
});
app.get('/blog/:slug', async (req: any, reply) => {
  const slug = String(req.params.slug).toLowerCase();
  const { rows: [row] } = SLUG.test(slug)
    ? await pool.query('SELECT * FROM articles WHERE slug = $1 AND unpublished_at IS NULL', [slug])
    : { rows: [] as any[] };
  if (!row) {
    return html(reply).code(404).send(indexPage({ ...await liveArticles({ page: 1 }), publicUrl: publicUrl() }));
  }
  const { rows: more } = await pool.query(
    `SELECT ${CARD} FROM articles WHERE unpublished_at IS NULL AND slug <> $1 ORDER BY published_at DESC LIMIT 3`, [slug]);
  return html(reply).send(articlePage({ article: articleOf(row), more: more.map(cardOf), publicUrl: publicUrl() }));
});
app.get('/sitemap.xml', async (_req, reply) => {
  const { rows } = await pool.query('SELECT slug, published_at, source_updated_at FROM articles WHERE unpublished_at IS NULL ORDER BY published_at DESC');
  return reply.type('application/xml; charset=utf-8').header('cache-control', 'public, max-age=600').send(sitemap({
    publicUrl: publicUrl(),
    articles: rows.map((r) => ({ slug: r.slug, published_at: iso(r.published_at)!, updated_at: iso(r.source_updated_at) })),
  }));
});
app.get('/robots.txt', async (_req, reply) =>
  reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=600')
    .send(`User-agent: *\nAllow: /\nSitemap: ${publicUrl()}/sitemap.xml\n`));

if (process.argv[1]?.endsWith('server.ts')) {
  // Refuse to start misconfigured, rather than serving 500s at the login screen.
  try {
    assertSecretConfigured();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });

  // Settlement must not depend on anyone being connected — see startTicker.
  startTicker().catch((err: unknown) => app.log.error({ err }, 'could not start the ticker'));
  startAutoTrader();

  // Interest is posted per whole day, so an hourly sweep is ample: it catches the day
  // rollover wherever the server happens to be, and picks up anything a restart missed.
  // ponytail: an in-process timer, so several API instances would each run it — harmless
  // because the accrual is idempotent, but move it to a single scheduled job at that point.
  // Staking rides the same sweep as portfolio interest: one schedule, so a day that pays
  // one pays the other, and a failure in either is logged rather than silently skipping.
  // IPO ROI rides the same sweep, for the same reason staking does: one schedule, so a day
  // that pays one pays them all. Maturity settlement runs after the accrual rather than
  // beside it, so a subscription is paid its last day before the principal goes back.
  const sweep = () => Promise.allSettled([
    accrueInterest(),
    accrueStaking(),
    accrueIpos().then(async (a) => ({ ...a, ...await maturedIpos('system') })),
  ])
    .then(([interest, staking, ipos]) => {
      if (interest.status === 'rejected') app.log.error({ err: interest.reason }, 'interest accrual failed');
      else if (interest.value.posted) app.log.info({ posted: interest.value.posted }, 'interest accrued');
      if (staking.status === 'rejected') app.log.error({ err: staking.reason }, 'staking accrual failed');
      else if (staking.value.posted) app.log.info({ posted: staking.value.posted }, 'staking rewards accrued');
      if (ipos.status === 'rejected') app.log.error({ err: ipos.reason }, 'IPO accrual failed');
      else if (ipos.value.posted || ipos.value.settled) {
        app.log.info({ posted: ipos.value.posted, settled: ipos.value.settled }, 'IPO ROI accrued');
      }
    });
  setTimeout(sweep, 5_000).unref();          // once shortly after boot
  setInterval(sweep, 3600_000).unref();

  // Drain in-flight requests and hand the pool back rather than dropping connections
  // mid-query. Windows kills without delivering this, and Postgres copes either way, so
  // it is good manners rather than something anything depends on.
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      app.close().then(() => pool.end()).catch(() => {}).finally(() => process.exit(0));
    });
  }
}

export { app, pool, tx };
