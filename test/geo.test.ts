import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countryCode, decide, isCrawler, isPublicIp, looksLikeHosting, looksLikeVpn, makeLookup, makeTorList, parseLookup, policyFromEnv, TZ_GUARD_SCRIPT, US_TIMEZONES } from '../src/geo.ts';

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
    assert.deepEqual(parseLookup({ location: { country_code: 'us' }, is_vpn: true, is_proxy: false, is_tor: false, is_datacenter: true, asn: { asn: 9009, org: 'M247 Europe SRL' }, company: { name: 'M247 Europe SRL' } }),
      { country: 'US', vpn: true, proxy: false, tor: false, datacenter: true, asn: 'AS9009 M247 Europe SRL', company: 'M247 Europe SRL', vpnProvider: true, hosting: true });
    assert.deepEqual(parseLookup({ country: 'United States', company: 'Google LLC', asn: 'AS15169 Google LLC' }),
      { country: 'US', vpn: null, proxy: null, tor: null, datacenter: null, asn: 'AS15169 Google LLC', company: 'Google LLC', vpnProvider: false, hosting: true });
    assert.equal(parseLookup({ country: 'France', company: 'Proxad / Free SAS', asn: 'AS12322 Free SAS' }).hosting, false, 'a home ISP is not hosting');
    assert.equal(countryCode('France'), 'FR');
    assert.equal(countryCode('Narnia'), 'Narnia');
    assert.equal(countryCode(null), null);
  });

  it('reads a VPN provider or a hosting range off the network name, with or without a key', () => {
    assert.equal(looksLikeVpn('AS9009 M247 Europe SRL', 'M247 Europe SRL'), true);
    assert.equal(looksLikeVpn('AS212238 Datacamp Limited', 'Datacamp Limited'), true);
    assert.equal(looksLikeVpn('AS62240 Clouvider Limited', null), true);
    assert.equal(looksLikeVpn(null, 'Proton AG'), true);
    assert.equal(looksLikeVpn('AS12322 Free SAS', 'Proxad / Free SAS'), false);
    assert.equal(looksLikeVpn('AS5089 Virgin Media Limited', 'Virgin Media'), false);
    assert.equal(looksLikeHosting('AS16509 Amazon.com, Inc.', 'Amazon Technologies Inc.'), true);
    assert.equal(looksLikeHosting('AS24940 Hetzner Online GmbH', null), true);
    assert.equal(looksLikeHosting('AS5089 Virgin Media Limited', 'Virgin Media'), false);
    assert.equal(looksLikeHosting('AS7922 Comcast Cable Communications, LLC', 'Comcast'), false);
  });

  it('refuses the listed countries and anonymisers, and nothing else', () => {
    const policy = { countries: new Set(['US']), anon: true, datacenter: false };
    const base = { country: 'GB', vpn: false, proxy: false, tor: false, datacenter: false, asn: null, company: null, vpnProvider: false, hosting: false };
    assert.deepEqual(decide(base, policy), { allow: true });
    assert.deepEqual(decide({ ...base, country: 'US' }, policy), { allow: false, reason: 'country' });
    assert.deepEqual(decide({ ...base, vpn: true }, policy), { allow: false, reason: 'anon' });
    assert.deepEqual(decide({ ...base, tor: true }, policy), { allow: false, reason: 'anon' });
    assert.deepEqual(decide({ ...base, datacenter: true }, policy), { allow: true }, 'hosting ranges pass unless asked');
    assert.deepEqual(decide({ ...base, datacenter: true }, { ...policy, datacenter: true }), { allow: false, reason: 'datacenter' });
    assert.deepEqual(decide({ ...base, hosting: true }, { ...policy, datacenter: true }), { allow: false, reason: 'datacenter' }, 'our own reading of the network counts too');
    assert.deepEqual(decide({ ...base, vpnProvider: true }, policy), { allow: false, reason: 'anon' }, 'a VPN provider is a VPN whatever the flags say');
    assert.deepEqual(decide(base, policy, true), { allow: false, reason: 'anon' }, 'a Tor exit from the exit list');
    // A keyless answer has no flags: the country rule and the network reading still bite.
    const keyless = { country: 'DE', vpn: null, proxy: null, tor: null, datacenter: null, asn: 'AS3320 Deutsche Telekom AG', company: 'Deutsche Telekom', vpnProvider: false, hosting: false };
    assert.deepEqual(decide(keyless, policy), { allow: true });
    assert.deepEqual(decide({ ...keyless, country: 'US' }, policy), { allow: false, reason: 'country' });
    assert.deepEqual(decide({ ...keyless, vpnProvider: true }, policy), { allow: false, reason: 'anon' });
  });

  it('keeps the Tor exit list and survives an outage', async () => {
    let fail = false;
    const tor = makeTorList({ fetch: async () => { if (fail) throw new Error('down'); return { ok: true, json: async () => null, text: async () => '# exits\n1.2.3.4\n5.6.7.8\n' } as any; } });
    assert.equal(tor.has('1.2.3.4'), false, 'empty until fetched');
    await tor.refresh();
    assert.equal(tor.size(), 2);
    assert.equal(tor.has('::ffff:5.6.7.8'), true);
    fail = true;
    await tor.refresh();
    assert.equal(tor.size(), 2, 'the last good list stays');
  });

  it('names the United States time zones and carries them into the public pages', () => {
    assert.ok(US_TIMEZONES.includes('America/New_York') && US_TIMEZONES.includes('Pacific/Honolulu'));
    assert.ok(!US_TIMEZONES.includes('Europe/London') && !US_TIMEZONES.includes('America/Toronto'));
    assert.match(TZ_GUARD_SCRIPT, /^<script>/);
    assert.ok(TZ_GUARD_SCRIPT.includes('America/Chicago') && TZ_GUARD_SCRIPT.includes('Not available here'));
  });

  it('reads the policy from the environment, with the United States and anonymisers refused by default', () => {
    assert.deepEqual(policyFromEnv({}), { countries: new Set(['US']), anon: true, datacenter: true });
    assert.deepEqual(policyFromEnv({ GEO_BLOCK_COUNTRIES: 'us, ca', GEO_BLOCK_ANON: '0', GEO_BLOCK_DATACENTER: '0' }),
      { countries: new Set(['US', 'CA']), anon: false, datacenter: false });
    assert.equal(policyFromEnv({ GEO_OFF: '1' }), null);
    assert.equal(policyFromEnv({ GEO_BLOCK_COUNTRIES: '', GEO_BLOCK_ANON: '0', GEO_BLOCK_DATACENTER: '0' }), null);
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
