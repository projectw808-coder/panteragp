import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';

const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw.normalize('NFKC'), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

// ------------------------------------------------------------------ tokens

export type Role = 'trader' | 'sales' | 'support' | 'compliance' | 'admin';
export type Principal = { sub: string; kind: 'staff' | 'client'; role: Role };

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set to at least 32 chars');
  return new TextEncoder().encode(s);
};

/**
 * Check the secret at boot rather than at the first sign-in. Without this the server
 * starts happily, passes its health check, and then fails every login with a 500 — which
 * looks like a broken app rather than a missing variable.
 */
export const assertSecretConfigured = (): void => { secret(); };

export function signToken(p: Principal, ttl = '8h'): Promise<string> {
  return new SignJWT({ kind: p.kind, role: p.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  return { sub: payload.sub!, kind: payload.kind as Principal['kind'], role: payload.role as Role };
}

// -------------------------------------------------------------------- RBAC

export type Perm =
  | 'crm:read' | 'crm:write' | 'trade:read' | 'trade:own'
  | 'kyc:review' | 'audit:read' | 'funds:credit' | 'password:reset' | 'admin';

const PERMS: Record<Role, Perm[]> = {
  trader:     ['trade:own'],
  sales:      ['crm:read', 'crm:write', 'trade:read'],
  support:    ['crm:read', 'crm:write', 'trade:read'],
  compliance: ['crm:read', 'trade:read', 'kyc:review', 'audit:read'],
  // funds:credit puts money on a client account out of nothing. Deliberately admin-only:
  // it is not part of ordinary CRM write access.
  // password:reset is the same shape of power: setting someone's password hands over
  // their account, so it is not something ordinary CRM write access should carry.
  // Anyone can always change their OWN password — that needs no permission at all.
  admin:      ['crm:read', 'crm:write', 'trade:read', 'trade:own', 'kyc:review', 'audit:read',
               'funds:credit', 'password:reset', 'admin'],
};

export const can = (role: Role, perm: Perm): boolean => PERMS[role]?.includes(perm) ?? false;
