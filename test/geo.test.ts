import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countryCode, decide, isCrawler, isPublicIp, makeLookup, parseLookup, policyFromEnv } from '../src/geo.ts';

describe('the door: who is let in', () => {
  it('knows a private or loopback address and never treats it as a visitor', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', 'fd00::1', 'fe80::1', '']) {
      assert.equal(isPublicIp(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '::ffff:69.46.46.33', '2a00:1450:4009:81e::200e']) {
      assert.equal(isPublicIp(ip), true, ip);
    }
  });

  it('reads the keyed and the keyless answers into one shape', () => {
    assert.deepEqual(parseLookup({ location: { country_code: 'us' }, is_vpn: true, is_proxy: false, is_tor: false, is_datacenter: true }),
      { country: 'US', vpn: true, proxy: false, tor: false, datacenter: true });
    assert.deepEqual(parseLookup({ country: 'United States', company: 'Google LLC' }),
      { country: 'US', vpn: null, proxy: null, tor: null, datacenter: null });
    assert.equal(countryCode('France'), 'FR');
    assert.equal(countryCode('Narnia'), 'Narnia');
    assert.equal(countryCode(null), null);
  });

  it('refuses the listed countries and anonymisers, and nothing else', () => {
    const policy = { countries: new Set(['US']), anon: true, datacenter: false };
    const base = { country: 'GB', vpn: false, proxy: false, tor: false, datacenter: false };
    assert.deepEqual(decide(base, policy), { allow: true });
    assert.deepEqual(decide({ ...base, country: 'US' }, policy), { allow: false, reason: 'country' });
    assert.deepEqual(decide({ ...base, vpn: true }, policy), { allow: false, reason: 'anon' });
    assert.deepEqual(decide({ ...base, tor: true }, policy), { allow: false, reason: 'anon' });
    assert.deepEqual(decide({ ...base, datacenter: true }, policy), { allow: true }, 'hosting ranges pass unless asked');
    assert.deepEqual(decide({ ...base, datacenter: true }, { ...policy, datacenter: true }), { allow: false, reason: 'datacenter' });
    // A keyless answer has no verdict on VPNs: only the country rule can bite.
    assert.deepEqual(decide({ country: 'DE', vpn: null, proxy: null, tor: null, datacenter: null }, policy), { allow: true });
    assert.deepEqual(decide({ country: 'US', vpn: null, proxy: null, tor: null, datacenter: null }, policy), { allow: false, reason: 'country' });
  });

  it('reads the policy from the environment, with the United States and anonymisers refused by default', () => {
    assert.deepEqual(policyFromEnv({}), { countries: new Set(['US']), anon: true, datacenter: false });
    assert.deepEqual(policyFromEnv({ GEO_BLOCK_COUNTRIES: 'us, ca', GEO_BLOCK_ANON: '0', GEO_BLOCK_DATACENTER: '1' }),
      { countries: new Set(['US', 'CA']), anon: false, datacenter: true });
    assert.equal(policyFromEnv({ GEO_OFF: '1' }), null);
    assert.equal(policyFromEnv({ GEO_BLOCK_COUNTRIES: '', GEO_BLOCK_ANON: '0' }), null);
  });

  it('lets search engines through on their user agent', () => {
    assert.equal(isCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
    assert.equal(isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false);
    assert.equal(isCrawler(undefined), false);
  });

  it('asks the service once per address and fails open when it cannot', async () => {
    const calls: string[] = [];
    const lookup = makeLookup({
      key: 'k',
      fetch: async (url) => {
        calls.push(url);
        if (url.includes('q=9.9.9.9')) throw new Error('down');
        return { ok: true, json: async () => ({ location: { country_code: 'US' }, is_vpn: false, is_proxy: false, is_tor: false, is_datacenter: false }) };
      },
    });
    const a = await lookup('8.8.8.8');
    const b = await lookup('8.8.8.8');
    assert.equal(a?.country, 'US');
    assert.equal(b, a, 'remembered');
    assert.equal(calls.length, 1);
    assert.match(calls[0], /q=8\.8\.8\.8&key=k$/);
    assert.equal(await lookup('9.9.9.9'), null, 'an outage is an open door');
    await lookup('9.9.9.9');
    assert.equal(calls.length, 2, 'and is not retried at once');
  });
});
