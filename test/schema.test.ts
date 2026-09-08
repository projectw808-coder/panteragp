// Runs db/schema.sql against an in-process Postgres (PGlite) and checks the
// guarantees the app relies on the database to enforce.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;
let staffId: string;
let clientId: string;

before(async () => {
  db = await PGlite.create();
  await db.exec(readFileSync(join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await db.query("SELECT set_config('app.actor', 'test-actor', false)");
  staffId = (await db.query<{ id: string }>(
    `INSERT INTO staff (email, name, role, password_hash)
     VALUES ('a@b.example','Ann','sales','scrypt$x$y') RETURNING id`)).rows[0]!.id;
  clientId = (await db.query<{ id: string }>(
    `INSERT INTO clients (email, name, owner_staff_id, password_hash)
     VALUES ('c@d.example','Cid',$1,'scrypt$s$h') RETURNING id`, [staffId])).rows[0]!.id;
});

describe('audit log', () => {
  test('records inserts with the actor, and never copies password_hash', async () => {
    const { rows } = await db.query<any>(
      `SELECT * FROM audit_log WHERE tbl='clients' AND row_id=$1`, [clientId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'INSERT');
    assert.equal(rows[0].actor, 'test-actor');
    assert.equal(rows[0].before, null);
    assert.equal(rows[0].after.name, 'Cid');
    assert.ok(!('password_hash' in rows[0].after), 'password_hash leaked into audit_log');
  });

  test('records before/after on update, and skips no-op updates', async () => {
    await db.query('UPDATE clients SET stage_id = 5 WHERE id = $1', [clientId]);
    await db.query('UPDATE clients SET stage_id = 5 WHERE id = $1', [clientId]); // no-op
    const { rows } = await db.query<any>(
      `SELECT * FROM audit_log WHERE tbl='clients' AND row_id=$1 AND action='UPDATE'`, [clientId]);
    assert.equal(rows.length, 1, 'a no-op update should not produce an audit row');
    assert.equal(rows[0].before.stage_id, 1);
    assert.equal(rows[0].after.stage_id, 5);
  });

  test('is append-only', async () => {
    await assert.rejects(() => db.query('UPDATE audit_log SET actor = $1', ['forged']), /append-only/);
    await assert.rejects(() => db.query('DELETE FROM audit_log'), /append-only/);
  });
});

test('activity_log is append-only', async () => {
  await db.query(
    `INSERT INTO activity_log (client_id, kind, actor, summary) VALUES ($1,'note','sys','hi')`, [clientId]);
  await assert.rejects(() => db.query('UPDATE activity_log SET summary = $1', ['edited']), /append-only/);
  await assert.rejects(() => db.query('DELETE FROM activity_log'), /append-only/);
});

test('updated_at is maintained by the database', async () => {
  const before = (await db.query<any>('SELECT updated_at FROM clients WHERE id=$1', [clientId])).rows[0].updated_at;
  await db.query("UPDATE clients SET name = 'Cid II' WHERE id = $1", [clientId]);
  const after = (await db.query<any>('SELECT updated_at FROM clients WHERE id=$1', [clientId])).rows[0].updated_at;
  assert.ok(after > before);
});

describe('trading constraints', () => {
  let accountId: string;
  before(async () => {
    accountId = (await db.query<{ id: string }>(
      `INSERT INTO trading_accounts (client_id, mode) VALUES ($1,'demo') RETURNING id`, [clientId])).rows[0]!.id;
    
  });

  test('account mode is demo or live, nothing else', async () => {
    await assert.rejects(
      () => db.query(`INSERT INTO trading_accounts (client_id, mode) VALUES ($1,'real')`, [clientId]));
  });

  const order = (type: string, extra = '') =>
    db.query(`INSERT INTO orders (account_id, client_id, symbol, side, type, qty ${extra ? ', ' + extra.split('=')[0] : ''})
              VALUES ($1,$2,'EURUSD','buy','${type}',1 ${extra ? ', ' + extra.split('=')[1] : ''})`,
             [accountId, clientId]);

  test('order price fields are required by type', async () => {
    await assert.rejects(() => order('limit'), 'limit order without limit_price must be rejected');
    await assert.rejects(() => order('stop'), 'stop order without stop_price must be rejected');
    await assert.rejects(() => order('trailing_stop'), 'trailing stop without trail_amount must be rejected');
    await order('limit', 'limit_price=1.05');       // valid
    await order('market');                          // valid
  });

  test('quantity must be positive', async () => {
    await assert.rejects(() => db.query(
      `INSERT INTO orders (account_id, client_id, symbol, side, type, qty)
       VALUES ($1,$2,'EURUSD','buy','market',0)`, [accountId, clientId]));
  });
});
