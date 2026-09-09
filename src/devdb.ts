// Dev-only Postgres on port 5432, no install required: the real server, from the
// embedded-postgres package. Applies db/schema.sql and seeds a staff login.
// Never use this in production.
//   node --experimental-strip-types src/devdb.ts
//
// This is genuine PostgreSQL rather than an in-process stand-in, so it handles clients
// coming and going: the API can be restarted, or run under --watch, without disturbing it.
//
// Set DEV_DB_DIR to keep the data between restarts (the schema is then applied only when
// the cluster is empty). Without it the data lives in .pgdata-ephemeral, which is wiped on
// every boot so the database starts clean, which is what the acceptance run wants.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { hashPassword } from './auth.ts';

const root = join(import.meta.dirname, '..');
const keep = process.env.DEV_DB_DIR;
const dir = join(root, keep ?? '.pgdata-ephemeral');

// Only ever remove the directory this file owns, and only when it is a Postgres cluster or
// absent. A DEV_DB_DIR the user named is never touched.
if (!keep && existsSync(dir)) {
  if (!existsSync(join(dir, 'PG_VERSION'))) {
    throw new Error(`${dir} exists but is not a Postgres data directory — refusing to delete it`);
  }
  rmSync(dir, { recursive: true, force: true });
}

const fresh = !existsSync(join(dir, 'PG_VERSION'));
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  persistent: true,          // stop() must never delete the cluster out from under us
  onLog: () => {},           // the server's own chatter is noise here
});

if (fresh) await pg.initialise();
await pg.start();

const client = pg.getPgClient();
await client.connect();
const { rows: [existing] } = await client.query<{ present: string | null }>(
  "SELECT to_regclass('public.clients')::text AS present");
// Reference data, applied every start so a new trading pair appears without a reset.
const instruments = () => client.query(readFileSync(join(root, 'db', 'instruments.sql'), 'utf8'));

if (!existing?.present) {
  await client.query(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'));
  await client.query("SELECT set_config('app.actor', 'seed', false)");
  await client.query(
    `INSERT INTO staff (email, name, role, password_hash) VALUES ('admin@local.test','Admin','admin',$1)`,
    [await hashPassword('devpassword')],
  );
}
await instruments();
await client.end();

// Postgres is a child process, so leaving it running would hold port 5432 after this exits.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    pg.stop().catch(() => {}).finally(() => process.exit(0));
  });
}

console.log(`dev db on 5432 (${keep ? `persisted in ${keep}` : 'ephemeral, wiped on boot'})`
  + `${existing?.present ? ', existing data kept' : ', schema applied'}`
  + ' — login admin@local.test / devpassword');
