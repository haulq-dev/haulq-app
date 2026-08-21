/**
 * Signed OAuth state.
 *
 * The `state` param on an OAuth authorize redirect exists for exactly one
 * reason here: the callback route has no session — Motive's redirect
 * carries no HaulQ auth headers — so `state` is the only way it learns which
 * org is connecting. Signed with HMAC so a forged or replayed value from a
 * different org cannot attach someone else's Motive account to it.
 *
 * Not JWT — a fixed three-part token is all this needs, and reaching for a
 * library to sign one field is the kind of thing worth not doing.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function signOAuthState(secret: string, orgId: string): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${orgId}.${nonce}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** Returns the org id, or null if the state was never signed with this secret. */
export function verifyOAuthState(secret: string, state: string): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [orgId, nonce, signature] = parts;
  if (!orgId || !nonce || !signature) return null;

  const expected = createHmac('sha256', secret).update(`${orgId}.${nonce}`).digest('base64url');
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  return orgId;
}
