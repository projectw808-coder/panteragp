/**
 * The door: who may reach the site at all, decided by where a request comes from.
 *
 * Two rules, both set by environment variables so the desk can turn them on, off or
 * widen them without a deploy:
 *
 *   GEO_BLOCK_COUNTRIES   comma list of ISO country codes refused outright; default US
 *   GEO_BLOCK_ANON        1 to refuse VPNs, proxies and Tor exits; default 1
 *   GEO_BLOCK_DATACENTER  1 to also refuse addresses in hosting ranges, which is where
 *                         every proxy and relay terminates; default 1. An uptime monitor
 *                         that must get through goes in GEO_ALLOW_IPS
 *   GEO_API_KEY           the lookup service's key. Without it the service still says
 *                         which country an address is in, but says nothing about VPNs,
 *                         so only the country rule can work
 *   GEO_ALLOW_IPS         comma list of addresses that are always let in: the desk's own
 *   GEO_ALLOW_CRAWLERS    1 to let search engines' crawlers through on their user agent;
 *                         default 1, since Google and Bing crawl from the United States
 *                         and the Insights pages would otherwise fall out of search
 *   GEO_PASS              a secret for the desk's own people, who may well work through a
 *                         VPN themselves: opening /door/pass?key=<GEO_PASS> once in a
 *                         browser sets a cookie that lets that browser past the door for
 *                         a year. The cookie holds a signature, never the secret
 *   GEO_OFF               1 switches the whole door off
 *
 * The lookup is ipapi.is, one request per address, remembered for twelve hours. When the
 * service cannot be reached the door fails open: a lookup outage must not take the site
 * down with it. Private and loopback addresses are never looked up, so development and
 * the acceptance suite, which arrive over localhost, are untouched.
 *
 * A refused request gets 451 with a short page for a browser and JSON for anything else.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The cookie a desk browser carries past the door: a signature derived from the secret, never the secret. */
export const PASS_COOKIE = 'door_pass';
export const passCookieValue = (secret: string) => createHmac('sha256', secret).update('door-pass').digest('hex');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const passKeyMatches = (key: unknown, secret: string) => typeof key === 'string' && key.length > 0 && same(key, secret);
export function hasPass(cookieHeader: unknown, secret: string): boolean {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return false;
  const expected = passCookieValue(secret);
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === PASS_COOKIE && same(rest.join('='), expected)) return true;
  }
  return false;
}

export type GeoInfo = {
  country: string | null;        // ISO 3166-1 alpha-2 where known, else the service's name
  vpn: boolean | null;           // null when the service gave no verdict (no key)
  proxy: boolean | null;
  tor: boolean | null;
  datacenter: boolean | null;
  /** The network the address is announced from, as the service names it; both tiers give these. */
  asn: string | null;
  company: string | null;
  /** Our own reading of asn and company: a VPN provider, or a hosting range. Works without a key. */
  vpnProvider: boolean;
  hosting: boolean;
};

/**
 * Networks that exist to hand out exits: the consumer VPNs themselves and the transit
 * providers most of them rent from. An address announced by one of these is a VPN exit
 * whatever the lookup's flags say, and the keyless tier still names the network.
 */
const VPN_NETWORKS = /\b(nordvpn|expressvpn|surfshark|mullvad|proton ?(vpn|ag)|windscribe|cyberghost|ipvanish|hidemyass|hide ?my ?ass|privateinternetaccess|private internet access|torguard|perfect privacy|vpn ?secure|tunnelbear|hotspot ?shield|pango|anchorfree|purevpn|ivpn|astrill|zenmate|strongvpn|vypr|golden frog|datacamp|cdn77|m247|packethub|clouvider|hostroyale|zenlayer|quadranet|psychz|servers\.com|creanova|xtom|keminet|hostkey|tefincom|ovpn|vpn)\b/i;
/**
 * Hosting: clouds and server farms, where nobody browses from and where every proxy,
 * scraper and residential-looking relay actually terminates.
 */
const HOSTING_NETWORKS = /\b(amazon|aws|google (cloud|llc)|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|vultr|choopa|oracle|contabo|scaleway|leaseweb|colocrossing|hostinger|namecheap|godaddy|ionos|1&1|rackspace|cloudflare|fastly|alibaba|tencent|huawei cloud|upcloud|kamatera|hostwinds|interserver|hivelocity|liquid ?web|limestone|psychz|quadranet|serverius|worldstream|datacamp|cdn77|m247|packethub|clouvider|hostroyale|zenlayer|hosting|servers?|datacenter|data center|cloud|colo)\b/i;

export const looksLikeVpn = (asn: string | null, company: string | null) => VPN_NETWORKS.test(`${asn ?? ''} ${company ?? ''}`);
export const looksLikeHosting = (asn: string | null, company: string | null) => HOSTING_NETWORKS.test(`${asn ?? ''} ${company ?? ''}`);


export type GeoPolicy = {
  countries: Set<string>;
  anon: boolean;
  datacenter: boolean;
};

export type Verdict = { allow: true } | { allow: false; reason: 'country' | 'anon' | 'datacenter' };

/** Country names the keyless tier returns, mapped to the codes the policy is written in. */
const COUNTRY_NAMES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'usa': 'US',
  'united kingdom': 'GB', 'canada': 'CA', 'australia': 'AU', 'germany': 'DE', 'france': 'FR',
  'netherlands': 'NL', 'ireland': 'IE', 'spain': 'ES', 'italy': 'IT', 'switzerland': 'CH',
  'singapore': 'SG', 'hong kong': 'HK', 'japan': 'JP', 'india': 'IN', 'brazil': 'BR',
  'russia': 'RU', 'russian federation': 'RU', 'china': 'CN', 'israel': 'IL', 'iran': 'IR',
  'north korea': 'KP', "korea, democratic people's republic of": 'KP', 'syria': 'SY', 'cuba': 'CU',
};

export function countryCode(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_NAMES[v.toLowerCase()] ?? v;
}

/** The service's answer, keyed or keyless, as one shape. */
export function parseLookup(body: any): GeoInfo {
  const flag = (k: string) => (typeof body?.[k] === 'boolean' ? body[k] : null);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // The keyed tier nests the network under asn/company objects; the keyless tier gives strings.
  const asn = str(body?.asn) ?? (body?.asn && typeof body.asn === 'object' ? str(`AS${body.asn.asn ?? ''} ${body.asn.org ?? body.asn.descr ?? ''}`) : null);
  const company = str(body?.company) ?? (body?.company && typeof body.company === 'object' ? str(body.company.name) : null);
  return {
    country: countryCode(body?.location?.country_code ?? body?.country ?? null),
    vpn: flag('is_vpn'),
    proxy: flag('is_proxy'),
    tor: flag('is_tor'),
    datacenter: flag('is_datacenter'),
    asn, company,
    vpnProvider: looksLikeVpn(asn, company),
    hosting: looksLikeHosting(asn, company),
  };
}

/**
 * The verdict, from every signal at once: the lookup's flags where there is a key, our
 * own reading of the network either way, and the Tor exit list kept by the server.
 */
export function decide(info: GeoInfo, policy: GeoPolicy, torExit = false): Verdict {
  if (info.country && policy.countries.has(info.country)) return { allow: false, reason: 'country' };
  if (policy.anon && (info.vpn || info.proxy || info.tor || info.vpnProvider || torExit)) return { allow: false, reason: 'anon' };
  if (policy.datacenter && (info.datacenter || info.hosting)) return { allow: false, reason: 'datacenter' };
  return { allow: true };
}

/**
 * Tor's own list of exit addresses, refreshed hourly. Keeps the last good copy through an
 * outage, and an empty list until the first fetch lands rather than a crash.
 */
export function makeTorList(o: { fetch?: Fetch; refreshMs?: number } = {}) {
  let exits = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const refresh = async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await doFetch('https://check.torproject.org/torbulkexitlist', { signal: ctl.signal });
        if (res.ok) {
          const text = await (res as any).text();
          const next = new Set(String(text).split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith('#')));
          if (next.size) exits = next;
        }
      } finally { clearTimeout(t); }
    } catch { /* keep the last list */ }
  };
  return {
    has: (ip: string) => exits.has(ip.replace(/^::ffff:/i, '')),
    size: () => exits.size,
    refresh,
    start() { void refresh(); timer = setInterval(() => void refresh(), o.refreshMs ?? 60 * 60 * 1000); timer.unref?.(); },
    stop() { if (timer) clearInterval(timer); },
  };
}

/**
 * The door's second look, taken in the browser: a visitor behind a VPN arrives from an
 * address somewhere else, but their device keeps the time of where they are. The page
 * compares the device's zone with this list and refuses itself if it is one of the
 * refused country's. Mirrors web/src/door.ts, which the app uses.
 */
export const US_TIMEZONES = [
  'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
  'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
  'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Vevay',
  'America/Indiana/Tell_City', 'America/Indiana/Knox', 'America/Chicago', 'America/Menominee',
  'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/North_Dakota/Beulah',
  'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'America/Juneau', 'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome', 'America/Adak',
  'Pacific/Honolulu', 'America/Fort_Wayne', 'America/Indianapolis', 'America/Louisville', 'America/Shiprock',
  'America/Atka', 'America/Knox_IN', 'Navajo', 'US/Alaska', 'US/Aleutian', 'US/Arizona', 'US/Central',
  'US/East-Indiana', 'US/Eastern', 'US/Hawaii', 'US/Indiana-Starke', 'US/Michigan', 'US/Mountain',
  'US/Pacific', 'US/Samoa', 'Pacific/Pago_Pago', 'Pacific/Guam', 'Pacific/Saipan', 'America/Puerto_Rico',
  'America/St_Thomas', 'America/Virgin',
];

/** The inline script the public pages carry: if the device keeps United States time, the page refuses itself. */
const GUARD_PAGE = "<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Not available — Pantera GP</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0504;color:#f5efe6;font-family:Inter,system-ui,sans-serif}main{max-width:34rem;padding:32px}h1{font-family:'Playfair Display',Georgia,serif;font-weight:400;font-size:30px;margin:0 0 14px}p{color:#a39a90;line-height:1.6;margin:0 0 10px}.k{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#ff7817}</style></head><body><main><p class=\"k\">Pantera GP</p><h1>Not available here</h1><p>Pantera GP is not offered to visitors in your location.</p><p>If you believe this is a mistake, write to support@pantera-gp.com.</p></main></body>";
export const TZ_GUARD_SCRIPT = '<script>(function(){try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z&&'
  + JSON.stringify(US_TIMEZONES) + '.indexOf(z)>=0){document.documentElement.innerHTML=' + JSON.stringify(GUARD_PAGE)
  + ';}}catch(e){}})();</script>';



/** Addresses that cannot be anyone on the public internet: never looked up, always let in. */
export function isPublicIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '');
  if (!v || v === '::1' || v === '::') return false;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v.includes(':')) {
    const low = v.toLowerCase();
    return !(low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80'));
  }
  return false;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): GeoPolicy | null {
  if (env.GEO_OFF === '1') return null;
  const countries = new Set((env.GEO_BLOCK_COUNTRIES ?? 'US').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
  const anon = (env.GEO_BLOCK_ANON ?? '1') === '1';
  // On by default: a proxy, a relay or a scraper terminates in a hosting range, and nobody
  // browses from one. A monitor that must get through goes in GEO_ALLOW_IPS.
  const datacenter = (env.GEO_BLOCK_DATACENTER ?? '1') === '1';
  if (!countries.size && !anon && !datacenter) return null;
  return { countries, anon, datacenter };
}

const CRAWLERS = /Googlebot|bingbot|DuckDuckBot|Applebot|YandexBot|Slurp|Baiduspider|facebookexternalhit|LinkedInBot|Twitterbot/i;
export const isCrawler = (userAgent: string | undefined) => !!userAgent && CRAWLERS.test(userAgent);

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

/** One lookup per address, remembered; an outage is remembered briefly too, so it is not retried on every request. */
export function makeLookup(o: { key?: string; fetch?: Fetch; ttlMs?: number; failTtlMs?: number; max?: number; timeoutMs?: number } = {}) {
  const ttl = o.ttlMs ?? 12 * 60 * 60 * 1000;
  const failTtl = o.failTtlMs ?? 5 * 60 * 1000;
  const max = o.max ?? 20_000;
  const cache = new Map<string, { info: GeoInfo | null; at: number }>();
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  let warned = false;

  return async function lookup(ip: string): Promise<GeoInfo | null> {
    const hit = cache.get(ip);
    if (hit && Date.now() - hit.at < (hit.info ? ttl : failTtl)) return hit.info;
    let info: GeoInfo | null = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 2500);
      try {
        const res = await doFetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}${o.key ? `&key=${encodeURIComponent(o.key)}` : ''}`, { signal: ctl.signal });
        if (res.ok) info = parseLookup(await res.json());
      } finally { clearTimeout(timer); }
    } catch { info = null; }
    if (info && info.vpn === null && !o.key && !warned) {
      warned = true;
      console.warn('geo: no GEO_API_KEY, so the lookup says nothing about VPNs and proxies; only the country rule is in force');
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value as string);
    cache.set(ip, { info, at: Date.now() });
    return info;
  };
}

/** The refusal, with the address and country it was judged on, so a wrong placement can be reported and allowed. */
export const BLOCKED_PAGE = (reason: Verdict & { allow: false }, who: { ip: string; country: string | null }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not available — Pantera GP</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0504;color:#f5efe6;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:34rem;padding:32px}h1{font-family:'Playfair Display',Georgia,serif;font-weight:400;font-size:30px;margin:0 0 14px}p{color:#a39a90;line-height:1.6;margin:0 0 10px}
.k{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#ff7817}</style></head>
<body><main><p class="k">Pantera GP</p><h1>Not available here</h1>
<p>${reason.reason === 'country'
    ? 'Pantera GP is not offered to visitors in your location.'
    : 'Pantera GP cannot be reached through a VPN, a proxy or an anonymising network. Turn it off and try again.'}</p>
<p>If you believe this is a mistake, write to support@pantera-gp.com and quote this line:<br><span class="k">${who.ip.replace(/[^0-9a-f.:]/gi, '')} · ${(who.country ?? 'unknown').replace(/[<>&]/g, '')}</span></p></main></body></html>`;
