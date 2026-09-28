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

/**
 * Where the connect was started from. `app` means the mobile app, whose
 * in-app browser has to be handed back to the app at the end rather than
 * left on a web page it isn't signed in to (MOBILE_PARITY_PLAN.md M6).
 * Signed with everything else, so it can't be flipped to steer a redirect.
 */
export type OAuthClient = 'web' | 'app';

/**
 * `org.nonce.sig` for the web, `org.nonce.app.sig` for the app. The web
 * shape is unchanged, so a state issued before the app existed still verifies.
 */
export function signOAuthState(secret: string, orgId: string, client: OAuthClient = 'web'): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = client === 'app' ? `${orgId}.${nonce}.app` : `${orgId}.${nonce}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/** The org id and where the connect started, or null if the state was never signed with this secret. */
export function readOAuthState(secret: string, state: string): { orgId: string; client: OAuthClient } | null {
  const parts = state.split('.');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const signature = parts[parts.length - 1];
  const payloadParts = parts.slice(0, -1);
  const [orgId, nonce, marker] = payloadParts;
  if (!orgId || !nonce || !signature) return null;
  if (parts.length === 4 && marker !== 'app') return null;

  const expected = createHmac('sha256', secret).update(payloadParts.join('.')).digest('base64url');
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  return { orgId, client: parts.length === 4 ? 'app' : 'web' };
}

/** Returns the org id, or null if the state was never signed with this secret. */
export function verifyOAuthState(secret: string, state: string): string | null {
  return readOAuthState(secret, state)?.orgId ?? null;
}
