// Dev-only Postgres on port 5432, no install required: PGlite over a socket.
// Applies db/schema.sql and seeds a staff login. Never use this in production.
//   node --experimental-strip-types src/devdb.ts
//
// Set DEV_DB_DIR to keep the data between restarts (the schema is then applied only when
// the directory is empty). Without it the database is in memory and starts clean each
// time, which is what the acceptance run wants.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { hashPassword } from './auth.ts';

const dir = process.env.DEV_DB_DIR;
const db = await PGlite.create(dir);

const { rows: [existing] } = await db.query<{ present: string | null }>(
  "SELECT to_regclass('public.clients')::text AS present");
if (!existing?.present) {
  await db.exec(readFileSync(join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await db.query("SELECT set_config('app.actor', 'seed', false)");
  await db.query(
    `INSERT INTO staff (email, name, role, password_hash) VALUES ('admin@local.test','Admin','admin',$1)`,
    [await hashPassword('devpassword')],
  );
}

// The default is one connection, and a client killed without closing (node --watch
// restarting the API) keeps that slot for good, so every later connection is refused.
// Room for a few means a restarted API is served while the dead socket is still lingering.
// Queries are queued inside PGlite regardless, so this is not concurrent execution.
// ponytail: this buys about three restarts, not an unlimited number. A vanished client
// leaves a handler attached to the shared query queue, and once a few have built up every
// connection breaks — which is why the API is not run under --watch. Measured, not
// theoretical: six rapid restarts fail from the fourth on.
await new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1', maxConnections: 8 }).start();

// The same abrupt kill raises ECONNRESET on that socket, and pglite-socket leaves it
// unhandled, so it reaches the process and takes the database down — losing the data with
// it. Survive a client vanishing; anything else still stops the process as it should.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET') return;
  console.error(err);
  process.exit(1);
});

console.log(`dev db on 5432 (${dir ? `persisted in ${dir}` : 'in memory'})`
  + `${existing?.present ? ', existing data kept' : ', schema applied'}`
  + ' — login admin@local.test / devpassword');
