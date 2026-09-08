// Dev-only Postgres on port 5432, no install required: PGlite over a socket.
// Applies db/schema.sql and seeds a staff login. Never use this in production.
//   node --experimental-strip-types src/devdb.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { hashPassword } from './auth.ts';

const db = await PGlite.create();
await db.exec(readFileSync(join(import.meta.dirname, '..', 'db', 'schema.sql'), 'utf8'));
await db.query("SELECT set_config('app.actor', 'seed', false)");
await db.query(
  `INSERT INTO staff (email, name, role, password_hash) VALUES ('admin@local.test','Admin','admin',$1)`,
  [await hashPassword('devpassword')],
);

await new PGLiteSocketServer({ db, port: 5432, host: '127.0.0.1' }).start();
console.log('dev db on 5432 — login admin@local.test / devpassword');
