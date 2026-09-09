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

// ponytail: one connection at a time, and it does not notice a client that dies without
// closing — kill the API on its own and every later connection is reset until this process
// restarts too. Restart the pair, or set DEV_DB_DIR so a restart keeps the data.
await new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1' }).start();
console.log(`dev db on 5432 (${dir ? `persisted in ${dir}` : 'in memory'})`
  + `${existing?.present ? ', existing data kept' : ', schema applied'}`
  + ' — login admin@local.test / devpassword');
