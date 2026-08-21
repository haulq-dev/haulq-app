import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CredentialDecryptionError,
  decryptCredential,
  encryptCredential,
  generateCredentialKeypair,
} from './credential-crypto.ts';

describe('credential-crypto', () => {
  it('round-trips a token through the keypair that sealed it', async () => {
    const kp = await generateCredentialKeypair();
    const sealed = await encryptCredential(kp.publicKey, 'a-real-motive-access-token');
    const opened = await decryptCredential(kp.publicKey, kp.privateKey, sealed);
    assert.equal(opened, 'a-real-motive-access-token');
  });

  it('produces different ciphertext for the same plaintext each time', async () => {
    const kp = await generateCredentialKeypair();
    const a = await encryptCredential(kp.publicKey, 'same-token');
    const b = await encryptCredential(kp.publicKey, 'same-token');
    assert.notEqual(a, b);
  });

  it('refuses to open with the wrong keypair', async () => {
    const kp = await generateCredentialKeypair();
    const other = await generateCredentialKeypair();
    const sealed = await encryptCredential(kp.publicKey, 'a-token');

    await assert.rejects(
      () => decryptCredential(other.publicKey, other.privateKey, sealed),
      CredentialDecryptionError,
    );
  });

  it('handles a long token, the shape a real JWT or Motive access token has', async () => {
    const kp = await generateCredentialKeypair();
    const long = 'x'.repeat(2000);
    const sealed = await encryptCredential(kp.publicKey, long);
    assert.equal(await decryptCredential(kp.publicKey, kp.privateKey, sealed), long);
  });
});
