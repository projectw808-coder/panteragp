import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The site lock: an optional username and password in front of the website.
 *
 * It is on only while both SITE_LOCK_USER and SITE_LOCK_PASSWORD are set, and off the
 * moment either is removed. It guards the pages a browser opens, not the API: the mobile
 * app and the web app's own calls go through as before, each with its own sign-in. A
 * visitor who gets the pair right carries a signed cookie for 30 days. The cookie is keyed
 * on the password, so changing the password turns every existing cookie away.
 */

export type SiteLock = { user: string; password: string };

export function lockFromEnv(env: Record<string, string | undefined> = process.env): SiteLock | null {
  const user = env.SITE_LOCK_USER?.trim();
  const password = env.SITE_LOCK_PASSWORD;
  return user && password ? { user, password } : null;
}

export const LOCK_COOKIE = 'site_pass';
export const LOCK_DAYS = 30;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export const lockCookieValue = (lock: SiteLock) => createHmac('sha256', lock.password).update(`site-lock:${lock.user}`).digest('hex');

/** Both compared in full, whichever is wrong, so the answer's timing says nothing about which. */
export function credentialsMatch(lock: SiteLock, user: unknown, password: unknown): boolean {
  if (typeof user !== 'string' || typeof password !== 'string') return false;
  const u = same(user.trim(), lock.user);
  const p = same(password, lock.password);
  return u && p;
}

export function hasLockPass(cookieHeader: unknown, lock: SiteLock): boolean {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return false;
  const expected = lockCookieValue(lock);
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === LOCK_COOKIE && same(rest.join('='), expected)) return true;
  }
  return false;
}

/** Only a path on this site, so a crafted link cannot send someone elsewhere after signing in. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) && next.length < 500 ? next : '/';
}

/**
 * Wrong guesses per address, forgotten after a quarter of an hour. Ten in that window and
 * the form stops checking until it clears.
 */
export function makeAttempts(limit = 10, windowMs = 15 * 60_000) {
  const seen = new Map<string, { n: number; since: number }>();
  return {
    blocked(ip: string, now = Date.now()) {
      const s = seen.get(ip);
      if (s && now - s.since > windowMs) { seen.delete(ip); return false; }
      return !!s && s.n >= limit;
    },
    fail(ip: string, now = Date.now()) {
      const s = seen.get(ip);
      if (!s || now - s.since > windowMs) seen.set(ip, { n: 1, since: now });
      else s.n += 1;
      if (seen.size > 10_000) seen.clear();
    },
    clear(ip: string) { seen.delete(ip); },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The page in front of the site: the platform's dark, its ember, one small form. */
export const LOCK_PAGE = (opts: { next: string; error?: 'wrong' | 'busy' }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in — Pantera GP</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;color:#f5efe6;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(90% 60% at 50% 0%,rgba(255,117,24,.16),transparent 60%),radial-gradient(60% 50% at 100% 100%,rgba(255,117,24,.08),transparent 60%),#0b0d11}
main{width:100%;max-width:380px}
.brand{display:flex;align-items:center;gap:10px;margin:0 0 28px;font-weight:800;font-size:17px;letter-spacing:.01em}
.brand i{display:inline-block;width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#ff9a4d,#ff7518 55%,#c24c00);box-shadow:0 6px 24px rgba(255,117,24,.35)}
.brand span{color:#ff7518;font-style:italic;letter-spacing:-.08em}
form{border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:26px;background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01));box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:22px;font-weight:700}
p{margin:0 0 20px;color:#9aa3ae;font-size:13.5px;line-height:1.55}
label{display:block;margin:0 0 14px;font-size:12px;font-weight:600;color:#c3cad3}
input{display:block;width:100%;margin-top:6px;height:44px;padding:0 14px;border-radius:11px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.35);color:#f5efe6;font:inherit;font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#ff7518;box-shadow:0 0 0 3px rgba(255,117,24,.2)}
button{margin-top:6px;width:100%;height:46px;border:0;border-radius:999px;background:#ff7518;color:#140802;font:inherit;font-size:15px;font-weight:700;cursor:pointer;box-shadow:0 8px 26px rgba(255,117,24,.35);transition:filter .15s}
button:hover{filter:brightness(1.08)}button:focus-visible{outline:2px solid #fff;outline-offset:3px}
.err{margin:0 0 16px;padding:10px 12px;border-radius:10px;border:1px solid rgba(240,68,56,.35);background:rgba(240,68,56,.1);color:#ffb4ab;font-size:13px}
</style></head>
<body><main>
<div class="brand"><i aria-hidden="true"></i>Pantera GP <span>///</span></div>
<form method="post" action="/site-lock">
<h1>Sign in to continue</h1>
<p>This site is private. Enter the username and password you were given.</p>
${opts.error ? `<p class="err" role="alert">${opts.error === 'busy' ? 'Too many tries. Wait 15 minutes and try again.' : 'That username and password do not match. Check them and try again.'}</p>` : ''}
<input type="hidden" name="next" value="${esc(opts.next)}">
<label>Username<input name="user" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Enter site</button>
</form>
</main></body></html>`;
