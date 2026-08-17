/**
 * Webhook signature verification.
 *
 * This is the one piece of security-relevant crypto written by hand in the
 * codebase, so the failure branches get as much attention as the success one.
 * An endpoint that accepts an unsigned webhook is an unauthenticated write to
 * the users table, reachable by anyone who learns the URL.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SignatureError,
  signSvix,
  verifySvixSignature,
} from './svix-signature.ts';

const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-32-bytes-long').toString('base64');
const BODY = Buffer.from(JSON.stringify({ type: 'user.created', data: { id: 'user_1' } }));
const ID = 'msg_2abc';
const NOW = new Date('2026-08-16T12:00:00Z');
const TS = Math.floor(NOW.getTime() / 1000);

const valid = () => signSvix({ secret: SECRET, id: ID, timestamp: TS, body: BODY });

/**
 * Asserts the failure, matching on `explanation` rather than `message`.
 *
 * The two are deliberately different throughout this codebase: `message` is the
 * technical line that goes to logs, `explanation` is the sentence a person
 * reads. Asserting on the wrong one passes while the user-facing half rots.
 */
const throwsExplaining = (fn: () => void, pattern: RegExp) =>
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof SignatureError, `expected SignatureError, got ${err}`);
    assert.match(err.explanation, pattern);
    return true;
  });

const verify = (over: Record<string, unknown> = {}) =>
  verifySvixSignature({
    secret: SECRET,
    headers: { id: ID, timestamp: String(TS), signature: valid() },
    body: BODY,
    now: NOW,
    ...over,
  });

describe('svix signature', () => {
  it('accepts a correctly signed payload', () => {
    assert.doesNotThrow(() => verify());
  });

  it('accepts when one of several signatures matches', () => {
    // Several are sent during a secret rotation. Requiring the first to match
    // would break every webhook for the duration of the rollover.
    const signature = `v1,AAAA${'B'.repeat(40)}= ${valid()}`;
    assert.doesNotThrow(() => verify({ headers: { id: ID, timestamp: String(TS), signature } }));
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ type: 'user.created', data: { id: 'user_ATTACKER' } }));
    assert.throws(() => verify({ body }), SignatureError);
  });

  it('rejects a signature made with a different secret', () => {
    const signature = signSvix({
      secret: 'whsec_' + Buffer.from('a-different-key-of-the-same-size').toString('base64'),
      id: ID,
      timestamp: TS,
      body: BODY,
    });
    assert.throws(() => verify({ headers: { id: ID, timestamp: String(TS), signature } }), SignatureError);
  });

  it('rejects a replay from outside the tolerance window', () => {
    // Without this a captured signature is valid forever and can re-apply old
    // state — a user.updated restoring an address the carrier has since changed.
    const old = TS - 600;
    const signature = signSvix({ secret: SECRET, id: ID, timestamp: old, body: BODY });
    throwsExplaining(
      () => verify({ headers: { id: ID, timestamp: String(old), signature } }),
      /too old to accept/,
    );
  });

  it('accepts a small clock drift in either direction', () => {
    for (const skew of [-60, 60]) {
      const ts = TS + skew;
      const signature = signSvix({ secret: SECRET, id: ID, timestamp: ts, body: BODY });
      assert.doesNotThrow(
        () => verify({ headers: { id: ID, timestamp: String(ts), signature } }),
        `skew ${skew}s should be tolerated`,
      );
    }
  });

  it('rejects a missing signature header', () => {
    throwsExplaining(
      () => verify({ headers: { id: ID, timestamp: String(TS), signature: undefined } }),
      /missing its webhook signature headers/i,
    );
  });

  it('rejects an unparseable timestamp', () => {
    throwsExplaining(
      () => verify({ headers: { id: ID, timestamp: 'yesterday', signature: valid() } }),
      /invalid timestamp/,
    );
  });

  it('does not throw on a wrong-length signature', () => {
    // timingSafeEqual throws on a length mismatch rather than returning false.
    // An attacker choosing the length must not be able to turn that into a 500.
    assert.throws(
      () => verify({ headers: { id: ID, timestamp: String(TS), signature: 'v1,AAAA' } }),
      SignatureError,
    );
  });

  it('ignores signature versions it does not understand', () => {
    assert.throws(
      () => verify({ headers: { id: ID, timestamp: String(TS), signature: 'v2,' + valid().slice(3) } }),
      SignatureError,
    );
  });

  it('binds the signature to the message id', () => {
    // The id is part of the signed string, so a signature cannot be lifted from
    // one delivery onto another.
    assert.throws(
      () => verify({ headers: { id: 'msg_other', timestamp: String(TS), signature: valid() } }),
      SignatureError,
    );
  });

  it('tolerates the secret with or without its prefix', () => {
    // "whsec_" is a label, not key material. Including it in the HMAC produces
    // a signature that never matches — an afternoon nobody needs to spend.
    assert.doesNotThrow(() => verify({ secret: SECRET.replace('whsec_', '') }));
  });
});
