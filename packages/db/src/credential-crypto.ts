/**
 * Sealing an OAuth token at rest.
 *
 * `schema/tenancy.ts`'s module note on `board_credentials` is the reasoning;
 * this is the mechanism. `crypto_box_seal` — libsodium's actual "sealed box"
 * primitive, not a hand-rolled envelope scheme — encrypts to a public key
 * with no keypair of its own on the writing side, and only the holder of
 * the matching private key can open it. That asymmetry is the point: the
 * OAuth callback route that receives a fresh token only ever needs the
 * public key, and only the narrower path that actually calls Motive's API
 * needs the private key. A leaked database, or a leaked public key, hands
 * over nothing either way.
 *
 * A real library rather than something built from `node:crypto` primitives
 * here on purpose — sealed-box encryption is exactly the kind of thing worth
 * not re-deriving under time pressure.
 */

// `import 'libsodium-wrappers'` resolves to its package's ESM build under
// Node's `"import"` export condition, and that build's relative import of
// its own `libsodium` core package does not resolve under pnpm's strict
// linking — a known packaging gap in the library, not a bug in this file.
// `createRequire` forces Node's CJS resolver instead, which uses ordinary
// node_modules lookup and has none of that problem. `libsodium-wrappers`
// itself is CJS underneath either way; only the entry point differs.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

let ready: Promise<void> | null = null;
async function ensureReady(): Promise<void> {
  ready ??= sodium.ready;
  await ready;
}

export interface CredentialKeypair {
  publicKey: string;
  privateKey: string;
}

/** Run once, by hand, to produce `CREDENTIAL_ENCRYPTION_PUBLIC_KEY` / `_PRIVATE_KEY`. */
export async function generateCredentialKeypair(): Promise<CredentialKeypair> {
  await ensureReady();
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

/** Seal a token for storage. Only `decryptCredential`, with the private key, can reverse this. */
export async function encryptCredential(publicKeyB64: string, plaintext: string): Promise<string> {
  await ensureReady();
  const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super('sealed credential could not be opened — wrong keypair, or the ciphertext is corrupt');
    this.name = 'CredentialDecryptionError';
  }
}

export async function decryptCredential(
  publicKeyB64: string,
  privateKeyB64: string,
  ciphertextB64: string,
): Promise<string> {
  await ensureReady();
  const publicKey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const privateKey = sodium.from_base64(privateKeyB64, sodium.base64_variants.ORIGINAL);
  const ciphertext = sodium.from_base64(ciphertextB64, sodium.base64_variants.ORIGINAL);

  // The wrong keypair or corrupt ciphertext throws here rather than
  // returning a falsy value — the opposite of what libsodium's C API does,
  // and easy to get backwards without a test pinning it.
  try {
    const plaintext = sodium.crypto_box_seal_open(ciphertext, publicKey, privateKey);
    return sodium.to_string(plaintext);
  } catch {
    throw new CredentialDecryptionError();
  }
}
