// The profile photo now lives in the row rather than on a disk, so the thing worth
// checking is that the bytes come back exactly as they went in — and that upgrades.sql,
// which runs on every deploy, is valid and can be applied twice without complaint.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const sql = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'db', name), 'utf8');

let db: PGlite;
let clientId: string;

before(async () => {
  db = await PGlite.create();
  await db.exec(sql('schema.sql'));
  // Twice on purpose: this is what a deploy does to a database that already has it, and
  // an ALTER without IF NOT EXISTS would pass once and fail on every deploy after.
  await db.exec(sql('upgrades.sql'));
  await db.exec(sql('upgrades.sql'));
  clientId = (await db.query<{ id: string }>(
    `INSERT INTO clients (email, name, password_hash) VALUES ('a@b.c','A','x') RETURNING id`
  )).rows[0]!.id;
});

describe('a profile photo', () => {
  // A PNG header followed by bytes that are not valid UTF-8: if anything along the way
  // treats this as text rather than binary, this is what catches it.
  const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f]);

  test('comes back byte for byte', async () => {
    await db.query('UPDATE clients SET avatar_key=$2, avatar_image=$3, avatar_type=$4 WHERE id=$1',
      [clientId, 'key-1', photo, 'image/png']);
    const { rows } = await db.query<{ avatar_image: Uint8Array; avatar_type: string }>(
      'SELECT avatar_image, avatar_type FROM clients WHERE id = $1', [clientId]);
    assert.deepEqual(Buffer.from(rows[0]!.avatar_image), photo);
    assert.equal(rows[0]!.avatar_type, 'image/png');
  });

  test('survives the row being read back after other writes', async () => {
    // The point of moving it off the disk: nothing else touching the record disturbs it.
    await db.query(`UPDATE clients SET name = 'Renamed', phone = '+44' WHERE id = $1`, [clientId]);
    const { rows } = await db.query<{ avatar_image: Uint8Array }>(
      'SELECT avatar_image FROM clients WHERE id = $1', [clientId]);
    assert.deepEqual(Buffer.from(rows[0]!.avatar_image), photo);
  });

  test('removing it clears the bytes, not just the key', async () => {
    // A key cleared while the image stayed would leave a photo of somebody in the database
    // that nothing can reach and nobody asked us to keep.
    await db.query(
      'UPDATE clients SET avatar_key=NULL, avatar_image=NULL, avatar_type=NULL WHERE id=$1', [clientId]);
    const { rows } = await db.query<{ avatar_image: Uint8Array | null; avatar_key: string | null }>(
      'SELECT avatar_image, avatar_key FROM clients WHERE id = $1', [clientId]);
    assert.equal(rows[0]!.avatar_image, null);
    assert.equal(rows[0]!.avatar_key, null);
  });
});
