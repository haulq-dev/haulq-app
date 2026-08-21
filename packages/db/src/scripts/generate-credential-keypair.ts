#!/usr/bin/env node
/**
 * `pnpm keypair` — prints a fresh sealed-box keypair for
 * `CREDENTIAL_ENCRYPTION_PUBLIC_KEY` / `_PRIVATE_KEY`.
 *
 * Run once per environment, by hand. Dev and production must each get
 * their own — see `credential-crypto.ts`'s module note on why the private
 * key is the whole security boundary for a sealed token, and never commit
 * either value to the repo.
 */

import { generateCredentialKeypair } from '../credential-crypto.ts';

const kp = await generateCredentialKeypair();

console.log('CREDENTIAL_ENCRYPTION_PUBLIC_KEY=' + kp.publicKey);
console.log('CREDENTIAL_ENCRYPTION_PRIVATE_KEY=' + kp.privateKey);
console.log();
console.log('Paste both into .env.local for dev, or Doppler for production.');
console.log('Never reuse one environment\'s keypair in another.');
