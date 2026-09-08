import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = 'x'.repeat(32);
const { can, hashPassword, signToken, verifyPassword, verifyToken } = await import('../src/auth.ts');

test('password hash verifies, and rejects wrong password / tampered hash', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('correct horse battery', null), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  assert.notEqual(h, await hashPassword('correct horse battery')); // salted
});

test('token round-trips and rejects tampering', async () => {
  const p = { sub: 'abc', kind: 'staff', role: 'compliance' } as const;
  const t = await signToken(p);
  assert.deepEqual(await verifyToken(t), p);
  await assert.rejects(() => verifyToken(t.slice(0, -2) + 'aa'));
  // alg=none forgery must not verify
  const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' +
    Buffer.from('{"sub":"abc","role":"admin","kind":"staff"}').toString('base64url') + '.';
  await assert.rejects(() => verifyToken(none));
});

test('rbac matrix', () => {
  assert.ok(can('trader', 'trade:own'));
  assert.equal(can('trader', 'crm:read'), false);      // traders never see the CRM
  assert.equal(can('sales', 'kyc:review'), false);     // KYC is compliance-only
  assert.equal(can('sales', 'audit:read'), false);
  assert.ok(can('sales', 'trade:read'));               // trading data, read-only
  assert.ok(can('compliance', 'audit:read'));
  assert.equal(can('compliance', 'crm:write'), false);
  for (const role of ['sales', 'support', 'compliance', 'trader'] as const) {
    assert.equal(can(role, 'funds:credit'), false, role + ' must not be able to credit funds');
  }
  for (const p of ['crm:write', 'kyc:review', 'audit:read', 'funds:credit', 'admin'] as const) assert.ok(can('admin', p));
});
