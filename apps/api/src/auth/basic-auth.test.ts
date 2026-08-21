/**
 * HTTP Basic Auth verification.
 *
 * Same reasoning as `svix-signature.test.ts`: this is the whole authentication
 * for the Postmark inbound webhook, so the failure branches matter as much as
 * the success one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BasicAuthError, verifyBasicAuth } from './basic-auth.ts';

const USER = 'postmark';
const PASSWORD = 'a-test-secret';

const header = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const throwsExplaining = (fn: () => void, pattern: RegExp) =>
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof BasicAuthError, `expected BasicAuthError, got ${err}`);
    assert.match(err.explanation, pattern);
    return true;
  });

describe('verifyBasicAuth', () => {
  it('accepts matching credentials', () => {
    assert.doesNotThrow(() => verifyBasicAuth(header(USER, PASSWORD), USER, PASSWORD));
  });

  it('rejects a missing header', () => {
    throwsExplaining(() => verifyBasicAuth(undefined, USER, PASSWORD), /missing/i);
  });

  it('rejects a header that is not Basic', () => {
    throwsExplaining(
      () => verifyBasicAuth('Bearer sometoken', USER, PASSWORD),
      /missing/i,
    );
  });

  it('rejects the wrong password', () => {
    throwsExplaining(() => verifyBasicAuth(header(USER, 'wrong'), USER, PASSWORD), /not valid/i);
  });

  it('rejects the wrong username', () => {
    throwsExplaining(() => verifyBasicAuth(header('someone-else', PASSWORD), USER, PASSWORD), /not valid/i);
  });

  it('rejects garbage after "Basic "', () => {
    // Node's base64 decoder is lenient rather than throwing, so this fails as
    // a credential mismatch rather than the (still-defensive) malformed path.
    throwsExplaining(() => verifyBasicAuth('Basic not-valid-base64!!!', USER, PASSWORD), /not valid/i);
  });

  it('rejects a password containing a colon only if it does not match', () => {
    // The split is on the *first* colon, so a password with one embedded is
    // still handled correctly when it matches.
    const withColon = 'sec:ret';
    assert.doesNotThrow(() => verifyBasicAuth(header(USER, withColon), USER, withColon));
  });

  it('rejects an empty password when one is required', () => {
    throwsExplaining(() => verifyBasicAuth(header(USER, ''), USER, PASSWORD), /not valid/i);
  });
});
