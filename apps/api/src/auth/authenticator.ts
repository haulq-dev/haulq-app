/**
 * Authentication, as an interface with two implementations.
 *
 * Clerk is the pick (build plan section 5) but the account does not exist yet —
 * section 11 requires company addresses on `haulq.ai`, and Cloudflare Email
 * Routing for `hello@haulq.ai` is still on the todo list.
 *
 * Rather than block every other Phase 0 surface on that, or hardcode a tenant
 * the way the dispatcher does (`CARRIER_ID = process.env.CARRIER_ID ??
 * 'carrier-1'`, which is how single-tenant assumptions got everywhere in that
 * codebase), authentication is an interface. The dev stub and Clerk implement
 * the same one, so when Clerk lands nothing above this file changes.
 *
 * The stub refuses to run in production. That check is not a formality — a
 * header-trusting authenticator reachable from the internet is a total
 * authorization bypass, and "we'll remember to swap it" is exactly the thing
 * nobody remembers.
 */

import type { Actor } from '@haulq/db';

/** What a request proved about itself. */
export interface Authenticated {
  orgId: string;
  actor: Actor;
  /** Role within the org, for route-level checks. */
  role: 'owner' | 'dispatcher' | 'driver' | 'accountant';
}

/**
 * A signed-in person who is not yet inside a tenant.
 *
 * Onboarding is the chicken-and-egg case: creating an org requires being
 * authenticated, but there is no org to be authenticated *into* yet. Rather
 * than make `Authenticated.orgId` nullable — which would weaken the type on
 * every other route to serve one — that state gets its own shape and its own
 * method.
 */
export interface AuthenticatedUser {
  actor: Extract<Actor, { type: 'user' }>;
}

export interface Authenticator {
  readonly name: string;
  /**
   * Resolve a request to a tenant and an actor.
   *
   * Returns null when the request carries no valid credential. Throwing is
   * reserved for a credential that is present and broken, which is a different
   * situation and deserves a different status code.
   */
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<Authenticated | null>;

  /**
   * Resolve a request to a person, ignoring tenancy.
   *
   * Only onboarding uses this. Deliberately restricted to `user` actors: an
   * agent must not be able to create a tenant, which is guardrail 5 applied at
   * the one place where there is no org yet for the usual check to run in.
   *
   * Under Clerk this reads the session; the dev stub reads a header.
   */
  authenticateUser(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedUser | null>;
}

/**
 * Note the explicit field and assignment rather than a parameter property
 * (`constructor(readonly explanation: string)`).
 *
 * Node runs these files by stripping types, not compiling them, so anything
 * that needs *generated* code is unavailable — parameter properties, enums,
 * decorators, namespaces. Type stripping is what buys the no-build-step
 * workflow the whole workspace runs on, and this is its price. It is cheap, but
 * it is invisible until a file fails to load at runtime having typechecked
 * perfectly.
 */
export class AuthenticationError extends Error {
  readonly explanation: string;

  constructor(message: string, explanation: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.explanation = explanation;
  }
}
