import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialsMatch, hasLockPass, LOCK_COOKIE, LOCK_PAGE, lockCookieValue, lockFromEnv, makeAttempts, safeNext } from '../src/site-lock.ts';

const lock = { user: 'desk', password: 'p@ss&word' };

test('the lock is on only when both the username and the password are set', () => {
  assert.equal(lockFromEnv({}), null);
  assert.equal(lockFromEnv({ SITE_LOCK_USER: 'desk' }), null);
  assert.equal(lockFromEnv({ SITE_LOCK_PASSWORD: 'x' }), null);
  assert.equal(lockFromEnv({ SITE_LOCK_USER: '  ', SITE_LOCK_PASSWORD: 'x' }), null);
  assert.deepEqual(lockFromEnv({ SITE_LOCK_USER: ' desk ', SITE_LOCK_PASSWORD: 'x' }), { user: 'desk', password: 'x' });
});

test('credentials match only as a pair, and the password is case-sensitive', () => {
  assert.equal(credentialsMatch(lock, 'desk', 'p@ss&word'), true);
  assert.equal(credentialsMatch(lock, ' desk ', 'p@ss&word'), true);
  assert.equal(credentialsMatch(lock, 'desk', 'P@ss&word'), false);
  assert.equal(credentialsMatch(lock, 'other', 'p@ss&word'), false);
  assert.equal(credentialsMatch(lock, undefined, undefined), false);
});

test('the cookie is accepted only while the password is unchanged', () => {
  const cookie = `a=1; ${LOCK_COOKIE}=${lockCookieValue(lock)}; b=2`;
  assert.equal(hasLockPass(cookie, lock), true);
  assert.equal(hasLockPass(cookie, { ...lock, password: 'new' }), false);
  assert.equal(hasLockPass(`${LOCK_COOKIE}=forged`, lock), false);
  assert.equal(hasLockPass(undefined, lock), false);
});

test('after signing in, a visitor is only ever sent to a page on this site', () => {
  assert.equal(safeNext('/blog?x=1'), '/blog?x=1');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext(undefined), '/');
});

test('ten wrong tries in fifteen minutes stop the form until the window passes', () => {
  const a = makeAttempts(10, 1000);
  for (let i = 0; i < 9; i++) a.fail('1.2.3.4', 0);
  assert.equal(a.blocked('1.2.3.4', 10), false);
  a.fail('1.2.3.4', 0);
  assert.equal(a.blocked('1.2.3.4', 10), true);
  assert.equal(a.blocked('5.6.7.8', 10), false);
  assert.equal(a.blocked('1.2.3.4', 2000), false);
});

test('the page escapes where it sends the visitor next', () => {
  const page = LOCK_PAGE({ next: '/"><script>x</script>' });
  assert.ok(!page.includes('<script>x'));
  assert.ok(LOCK_PAGE({ next: '/', error: 'wrong' }).includes('role="alert"'));
});
