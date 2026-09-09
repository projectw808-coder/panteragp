/**
 * Create the schema on an empty database, and do nothing at all on one that already has
 * it. Safe to run on every deploy.
 *
 *   node scripts/db-init.mjs
 *
 * This exists because `db:reset` shells out to psql, which is not installed in a
 * deployment container, and because a managed database arrives empty with no way to load
 * a .sql file by hand.
 *
 * ponytail: this is not a migration tool. It creates the schema once; it will not carry an
 * existing database forward to a changed one. The moment the schema changes after go-live,
 * this needs replacing with real migrations — see the README's pre-production list.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_SSL === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
});

await client.connect();
try {
  const { rows: [{ present }] } = await client.query(
    "SELECT to_regclass('public.clients')::text AS present");
  if (present) {
    console.log('schema already present — leaving the database alone');
  } else {
    await client.query(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'));
    console.log('schema created');
    console.log('now create the first staff account:');
    console.log('  node --experimental-strip-types src/seed.ts <email> <password> admin');
  }
} finally {
  await client.end();
}
