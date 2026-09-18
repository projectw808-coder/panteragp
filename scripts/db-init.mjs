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

  // Instruments are reference data, so they run every time rather than only on a fresh
  // database: adding a trading pair has to reach deployments that already exist. The file
  // is ON CONFLICT DO NOTHING throughout, so repeating it changes nothing.
  await client.query(readFileSync(join(root, 'db', 'instruments.sql'), 'utf8'));

  // Schema changes made after go-live. Idempotent, so this runs on every deploy for the
  // same reason instruments does: a database created last month has to reach today.
  await client.query(readFileSync(join(root, 'db', 'upgrades.sql'), 'utf8'));
  const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM instruments');
  console.log(`instruments available: ${count}`);

  // The offerings' cover art, which travels in the repository rather than being uploaded by
  // hand to every environment. Each file is named for the offering's asset code.
  //
  // Applied at most once per offering, gated on cover_seeded_at rather than on "has no
  // picture": an offering the desk has deliberately stripped back to its drawn mark must
  // stay that way, and a rule based on emptiness would undo that on the next deploy. After
  // this runs, every decision about the picture is the desk's.
  //
  // These are drawn, not photographed and not anybody's logo — see scripts/make-ipo-covers.mjs,
  // which generates them, so they are reproducible rather than eight unexplained binaries.
  let covered = 0;
  const { rows: needCover } = await client.query(
    `SELECT id, asset FROM ipos WHERE cover_seeded_at IS NULL AND image_data IS NULL`);
  for (const ipo of needCover) {
    let bytes;
    try {
      bytes = readFileSync(join(root, 'assets', 'ipo-covers', `${ipo.asset.toLowerCase()}.png`));
    } catch {
      continue; // No art shipped for this one, which is not an error: it wears its mark.
    }
    await client.query(
      `UPDATE ipos SET image_key = gen_random_uuid()::text, image_data = $2,
                       image_type = 'image/png', cover_seeded_at = now()
        WHERE id = $1`, [ipo.id, bytes]);
    covered++;
  }
  if (covered) console.log(`cover art installed on ${covered} offering(s)`);
} finally {
  await client.end();
}
