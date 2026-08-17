/**
 * Clerk.
 *
 * Implements the same `Authenticator` interface as the dev stub, so nothing
 * above this file changes when it is swapped in. See
 * `packages/db/src/repositories/identity.ts` for why Clerk answers only "which
 * person is this?" and tenancy stays in Postgres.
 *
 * ---------------------------------------------------------------------------
 * The token verifier is injected
 * ---------------------------------------------------------------------------
 *
 * `verifyToken` from `@clerk/backend` fetches Clerk's JWKS and checks an RS256
 * signature. That is the one part of this file that cannot be exercised without
 * a real Clerk instance, so it is a constructor parameter rather than a direct
 * import. Everything else — org resolution, membership checks, the refusal of
 * agent actors — is then testable against a fake, which is most of the logic
 * and all of the parts specific to HaulQ.
 *
 * JWT verification itself is deliberately *not* hand-rolled. Signature checking,
 * JWKS rotation and clock skew are a bad place to be original.
 */

import { verifyToken } from '@clerk/backend';
import {
  membershipIn,
  upsertUserFromIdentity,
  type Database,
} from '@haulq/db';
import {
  AuthenticationError,
  type Authenticated,
  type AuthenticatedUser,
  type Authenticator,
} from './authenticator.ts';

/** The claims HaulQ reads. Clerk sends more; these are the ones relied on. */
export interface SessionClaims {
  /** Clerk user id, `user_...`. */
  sub: string;
  email?: string;
  name?: string;
  phone?: string;
}

export type TokenVerifier = (token: string) => Promise<SessionClaims>;

export interface ClerkAuthenticatorOptions {
  db: Database;
  secretKey: string;
  /** Overridden in tests. Defaults to Clerk's JWKS-backed verification. */
  verifier?: TokenVerifier;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Pull the session token from the request.
 *
 * `Authorization: Bearer` first, then Clerk's `__session` cookie. Both because
 * the web app uses the cookie and the mobile app (Phase 2a) will use the
 * header, and supporting one now means changing this file later for no reason.
 */
function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const auth = headerValue(headers, 'authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || undefined;

  const cookie = headerValue(headers, 'cookie');
  const match = cookie?.match(/(?:^|;\s*)__session=([^;]+)/);
  return match?.[1];
}

export class ClerkAuthenticator implements Authenticator {
  readonly name = 'clerk';
  readonly #db: Database;
  readonly #verify: TokenVerifier;

  constructor(options: ClerkAuthenticatorOptions) {
    if (!options.secretKey) {
      throw new Error('ClerkAuthenticator requires CLERK_SECRET_KEY.');
    }
    this.#db = options.db;
    this.#verify =
      options.verifier ??
      (async (token) => {
        const claims = await verifyToken(token, { secretKey: options.secretKey });
        return claims as unknown as SessionClaims;
      });
  }

  async #identify(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ userId: string; email: string } | null> {
    const token = extractToken(headers);
    if (!token) return null;

    let claims: SessionClaims;
    try {
      claims = await this.#verify(token);
    } catch (err) {
      // A present-but-invalid credential is different from no credential. An
      // expired session should tell the browser to refresh, not look like a
      // logged-out user and silently bounce someone mid-task.
      throw new AuthenticationError(
        `clerk token rejected: ${(err as Error).message}`,
        'Your session has expired or is not valid. Sign in again.',
      );
    }

    if (!claims.sub) {
      throw new AuthenticationError(
        'clerk token has no subject',
        'That session is missing its user. Sign in again.',
      );
    }

    // Clerk can be configured without email in the session claims. Rather than
    // fail, fall back to a placeholder derived from the id — the webhook fills
    // in the real address, and blocking sign-in over a display field would be a
    // poor trade.
    const email = claims.email ?? `${claims.sub}@users.clerk.invalid`;

    const user = await upsertUserFromIdentity(this.#db, {
      externalAuthId: claims.sub,
      email,
      fullName: claims.name,
      phone: claims.phone,
    });

    return { userId: user.id, email: user.email };
  }

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Authenticated | null> {
    const identity = await this.#identify(headers);
    if (!identity) return null;

    const orgId = headerValue(headers, 'x-haulq-org-id');
    if (!orgId) {
      throw new AuthenticationError(
        'no org selected',
        'No account was selected for this request. Pick an account and try again.',
      );
    }

    // The authorization check. Membership is read from Postgres on every
    // request rather than trusted from a token claim, so revoking someone takes
    // effect immediately instead of when their session happens to refresh.
    const membership = await membershipIn(this.#db, identity.userId, orgId);
    if (!membership) {
      // Deliberately the same message whether the org does not exist or the
      // user simply has no membership in it. Distinguishing them turns this
      // endpoint into a way to test whether an org id is real.
      throw new AuthenticationError(
        `user ${identity.userId} has no active membership in org ${orgId}`,
        'You do not have access to that account.',
      );
    }

    return {
      orgId,
      actor: { type: 'user', id: identity.userId, email: identity.email },
      role: membership.role,
    };
  }

  async authenticateUser(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedUser | null> {
    const identity = await this.#identify(headers);
    if (!identity) return null;

    // No agent path here at all, by construction: a Clerk session belongs to a
    // person. Guardrail 5's "no binding AI commitments" is upheld for account
    // creation because there is no way for a model to hold one.
    return {
      actor: { type: 'user', id: identity.userId, email: identity.email },
    };
  }
}
