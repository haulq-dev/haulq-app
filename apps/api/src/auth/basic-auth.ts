/**
 * HTTP Basic Auth verification.
 *
 * Postmark's inbound webhook has no signature scheme — unlike its outbound
 * delivery-event webhooks, an inbound parse POST is not HMAC-signed. Basic
 * Auth over TLS is what Postmark itself documents for protecting the endpoint,
 * so this is the whole of it: decode, split on the first colon, compare both
 * halves in constant time. Same discipline as `svix-signature.ts` — length is
 * checked before `timingSafeEqual`, which throws on a length mismatch rather
 * than returning false.
 */

import { timingSafeEqual } from 'node:crypto';

export class BasicAuthError extends Error {
  readonly explanation: string;

  constructor(message: string, explanation: string) {
    super(message);
    this.name = 'BasicAuthError';
    this.explanation = explanation;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function verifyBasicAuth(
  header: string | undefined,
  user: string,
  password: string,
): void {
  if (!header?.startsWith('Basic ')) {
    throw new BasicAuthError(
      'missing or malformed authorization header',
      'This request is missing its authentication.',
    );
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    throw new BasicAuthError('unparseable basic auth header', 'That authentication is malformed.');
  }

  const sep = decoded.indexOf(':');
  const sentUser = sep === -1 ? decoded : decoded.slice(0, sep);
  const sentPassword = sep === -1 ? '' : decoded.slice(sep + 1);

  if (!safeEqual(sentUser, user) || !safeEqual(sentPassword, password)) {
    throw new BasicAuthError('basic auth mismatch', 'Those credentials are not valid.');
  }
}
