/**
 * Signature recovery, against a signature this test makes itself.
 *
 * The casing rule is checked against the four addresses published in EIP-55 rather than
 * against anything this file computes — an implementation agreeing with itself proves
 * nothing. The signing tests then use an address derived from a fixed key, which is fine
 * once the derivation it relies on has been pinned to an outside source.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { challengeMessage, checksumAddress, isAddress, recoverSigner } from '../src/wallet-link.ts';

const PRIV = Buffer.from('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'hex');
const ADDRESS = checksumAddress(
  Buffer.from(keccak_256(secp256k1.getPublicKey(PRIV, false).subarray(1))).subarray(-20).toString('hex'));

// The examples in EIP-55 itself.
const EIP55 = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
];

/** What MetaMask does for personal_sign, so the test exercises the real shape. */
function personalSign(message: string, priv: Buffer): string {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  const sig = secp256k1.sign(keccak_256(joined), priv);
  return '0x' + Buffer.from(sig.toCompactRawBytes()).toString('hex')
    + (27 + sig.recovery).toString(16).padStart(2, '0');
}

describe('wallet address checksum', () => {
  it('matches the addresses published in EIP-55', () => {
    for (const address of EIP55) assert.equal(checksumAddress(address.toLowerCase()), address);
  });

  it('is idempotent, whatever case it is given', () => {
    for (const address of [...EIP55, ADDRESS]) {
      assert.equal(checksumAddress(address), address);
      assert.equal(checksumAddress(address.toUpperCase().replace('0X', '0x')), address);
    }
  });

  it('recognises an address, and refuses what only looks like one', () => {
    assert.ok(isAddress(ADDRESS));
    assert.ok(!isAddress('0x123'));
    assert.ok(!isAddress(`${ADDRESS}00`));
    assert.ok(!isAddress('not-an-address'));
  });
});

describe('proving a wallet is yours', () => {
  const message = challengeMessage(ADDRESS, 'nonce-under-test');

  it('recovers the signer of a genuine signature', () => {
    assert.equal(recoverSigner(message, personalSign(message, PRIV)), ADDRESS);
  });

  it('does not recover the signer for a message that was changed after signing', () => {
    // The whole point of the challenge: a signature is for one message and no other.
    const sig = personalSign(message, PRIV);
    assert.notEqual(recoverSigner(`${message} and one more thing`, sig), ADDRESS);
  });

  it('does not accept somebody else\'s signature for this address', () => {
    const other = Buffer.alloc(32, 7);
    assert.notEqual(recoverSigner(message, personalSign(message, other)), ADDRESS);
  });

  it('answers null for junk rather than throwing', () => {
    // A public endpoint receives malformed input as a matter of course; that is a 400, not
    // a 500, so nothing in here may throw on bad bytes.
    for (const junk of ['', '0x', '0xdeadbeef', 'x'.repeat(130), `0x${'0'.repeat(130)}`]) {
      assert.equal(recoverSigner(message, junk), null, `should refuse ${junk.slice(0, 12)}`);
    }
  });

  it('refuses a signature whose recovery byte is not one of the two valid ones', () => {
    const sig = personalSign(message, PRIV);
    assert.equal(recoverSigner(message, `${sig.slice(0, -2)}09`), null);
  });
});
