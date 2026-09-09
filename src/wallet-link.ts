/**
 * Linking an Ethereum address to a client account.
 *
 * The point is identification, not money. A wallet is linked so the desk knows which
 * address belongs to whom — nothing here sends, receives, approves or reads a balance, and
 * the platform holds no keys.
 *
 * Ownership is proved rather than claimed: the client signs a short-lived challenge with
 * the address, and the signature is checked here by recovering the signer. Storing an
 * address somebody merely typed in would be worse than storing nothing, because a payout
 * address nobody proved is a payout address to somebody else's wallet.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/** EIP-55: the mixed-case form, which is the only form worth storing or showing. */
export function checksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  return out;
}

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * EIP-191 personal_sign: what MetaMask actually signs is the message wrapped in a prefix
 * that names its length, so a signature obtained for one purpose cannot be replayed as a
 * transaction. Hashing anything else here would accept signatures MetaMask never produced.
 */
function personalSignHash(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/**
 * Who signed this message, or null if the signature is unusable.
 *
 * Returns rather than throws on malformed input: a bad signature is an ordinary thing for
 * a public endpoint to receive, and it should answer 400 rather than 500.
 */
export function recoverSigner(message: string, signature: string): string | null {
  const hex = signature.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;

  // r ‖ s ‖ v, with v as 27/28 (or 0/1 from some wallets).
  const raw = Buffer.from(hex, 'hex');
  const v = raw[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) return null;

  try {
    const sig = secp256k1.Signature.fromCompact(raw.subarray(0, 64)).addRecoveryBit(recovery);
    const point = sig.recoverPublicKey(personalSignHash(message));
    // The address is the last 20 bytes of the hash of the uncompressed key, minus its
    // leading 0x04 tag.
    const pub = point.toRawBytes(false).subarray(1);
    const address = Buffer.from(keccak_256(pub)).subarray(-20).toString('hex');
    return checksumAddress(address);
  } catch {
    return null;
  }
}

/** What the client is asked to sign. Readable on purpose: they have to approve it blind. */
export const challengeMessage = (address: string, nonce: string): string =>
  [
    'Pantera GP — prove this wallet is yours.',
    '',
    `Address: ${checksumAddress(address)}`,
    `Nonce: ${nonce}`,
    '',
    'Signing costs nothing and moves nothing. It only links this address to your account.',
  ].join('\n');
