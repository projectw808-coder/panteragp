/**
 * Create (or reset) the two standing admin accounts.
 *
 *   node scripts/seed-admins.mjs '<password>'
 *   SEED_ADMIN_PASSWORD='<password>' node scripts/seed-admins.mjs
 *
 * Safe to re-run: it upserts, so a second run just resets both passwords.
 *
 * The password is an argument rather than a constant on purpose. This file is in the
 * repository; a live admin password should not be. Two people sharing one login also
 * means the audit log records "admin1" rather than a person — fine for a demo, worth
 * replacing with named accounts before anyone relies on that log.
 */
import pg from 'pg';
import { hashPassword } from '../src/auth.ts';

const password = process.argv[2] ?? process.env.SEED_ADMIN_PASSWORD;
// No password given is not an error: this runs on every deploy, and does nothing unless
// SEED_ADMIN_PASSWORD is set. Set it once to create or reset the accounts, then remove it,
// or every future deploy quietly resets those passwords back.
if (!password) {
  console.log('no SEED_ADMIN_PASSWORD set - skipping admin seeding');
  process.exit(0);
}
if (password.length < 8) {
  console.error('that password is shorter than the 8 characters the API accepts anywhere');
  process.exit(1);
}

const DOMAIN = process.env.SEED_ADMIN_DOMAIN ?? 'pntgp.xyz';
const admins = [['admin1', 'Admin 1'], ['admin2', 'Admin 2']];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_SSL === 'require' ? { ssl: { rejectUnauthorized: true } } : {}),
});

// The audit triggers stamp whoever is acting; without this they would record 'system'.
await pool.query("SELECT set_config('app.actor', 'seed', false)");

for (const [user, name] of admins) {
  const email = `${user}@${DOMAIN}`.toLowerCase();
  const { rows: [row] } = await pool.query(
    `INSERT INTO staff (email, name, role, password_hash, active)
     VALUES ($1, $2, 'admin', $3, true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, active = true
     RETURNING id, email, role, active`,
    [email, name, await hashPassword(password)],
  );
  console.log(row);
}

await pool.end();
console.log('\nboth accounts are admins. Change these passwords once you are in.');
