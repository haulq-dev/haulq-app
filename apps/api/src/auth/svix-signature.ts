/**
 * Webhook signature verification.
 *
 * Clerk signs webhooks with Svix's scheme. Unlike JWT verification — which this
 * codebase deliberately delegates to `@clerk/backend` — this one is
 * hand-written, and the reasoning is the difference between the two problems:
 *
 *  - JWT involves asymmetric crypto, key rotation, JWKS fetching and clock
 *    skew. Being original there is how signature bypasses happen.
 *  - Svix is one HMAC-SHA256 over a string you already have, compared in
 *    constant time. It is fifty lines, fully specified, and every branch is
 *    testable with a fixture — including the failure branches, which is the
 *    part that matters and the part an SDK makes awkward to exercise.
 *
 * The scheme:
 *
 *   signed  = `${svix-id}.${svix-timestamp}.${raw body}`
 *   sig     = base64(hmac_sha256(secret, signed))
 *   header  = "v1,<sig> v1,<other sig>"   (space-separated; several during a
 *                                          secret rotation)
 *   secret  = "whsec_<base64>"            (the prefix is not part of the key)
 *
 * An unverified webhook endpoint is an unauthenticated write to the users
 * table, reachable by anyone who learns the URL.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SvixHeaders {
  id?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
}

export class SignatureError extends Error {
  readonly explanation: string;

  constructor(message: string, explanation: string) {
    super(message);
    this.name = 'SignatureError';
    this.explanation = explanation;
  }
}

/**
 * How far out of date a webhook may be, in seconds.
 *
 * Without this, a signature captured once is valid forever and can be replayed
 * to re-apply an old state — a `user.updated` restoring an email the carrier
 * has since changed, for instance. Five minutes is Svix's own tolerance and
 * leaves room for retries and clock drift.
 */
const TOLERANCE_SECONDS = 300;

export function verifySvixSignature(args: {
  secret: string;
  headers: SvixHeaders;
  /** The body exactly as received. Re-serialized JSON will not verify. */
  body: Buffer;
  /** Overridable for tests. */
  now?: Date;
}): void {
  const { id, timestamp, signature } = args.headers;

  if (!id || !timestamp || !signature) {
    throw new SignatureError(
      'missing svix headers',
      'This request is missing its webhook signature headers.',
    );
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    throw new SignatureError(
      `unparseable svix-timestamp: ${timestamp}`,
      'This webhook has an invalid timestamp.',
    );
  }

  const nowSeconds = Math.floor((args.now ?? new Date()).getTime() / 1000);
  const drift = Math.abs(nowSeconds - sent);
  if (drift > TOLERANCE_SECONDS) {
    throw new SignatureError(
      `svix timestamp ${drift}s out of tolerance`,
      'This webhook is too old to accept. It may be a replay.',
    );
  }

  // The prefix is a label, not key material. Including it produces a signature
  // that never matches, which is an afternoon nobody needs to spend.
  const key = Buffer.from(args.secret.replace(/^whsec_/, ''), 'base64');

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(args.body)
    .digest();

  // Several signatures during a secret rotation; any one matching is enough.
  const candidates = signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, value]) => value ?? '');

  for (const candidate of candidates) {
    let decoded: Buffer;
    try {
      decoded = Buffer.from(candidate, 'base64');
    } catch {
      continue;
    }
    // Length is checked first because timingSafeEqual throws on a mismatch
    // rather than returning false, and an attacker choosing the length should
    // not be able to turn that into a 500.
    if (decoded.length === expected.length && timingSafeEqual(decoded, expected)) {
      return;
    }
  }

  throw new SignatureError(
    'no matching svix signature',
    'This webhook signature does not match. It was not sent by Clerk.',
  );
}

/** Sign a payload the way Svix does. Test helper, and useful for local replay. */
export function signSvix(args: {
  secret: string;
  id: string;
  timestamp: number;
  body: Buffer;
}): string {
  const key = Buffer.from(args.secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${args.id}.${args.timestamp}.`)
    .update(args.body)
    .digest('base64');
  return `v1,${mac}`;
}
