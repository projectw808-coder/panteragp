// Create the first staff account: node --experimental-strip-types src/seed.ts <email> <password> [role]
import pg from 'pg';
import { hashPassword } from './auth.ts';

const [email, password, role = 'admin'] = process.argv.slice(2);
if (!email || !password) throw new Error('usage: seed.ts <email> <password> [role]');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query("SELECT set_config('app.actor', 'seed', false)");
const { rows } = await pool.query(
  `INSERT INTO staff (email, name, role, password_hash) VALUES ($1,$1,$2,$3) RETURNING id, email, role`,
  [email.toLowerCase(), role, await hashPassword(password)],
);
console.log(rows[0]);
await pool.end();
