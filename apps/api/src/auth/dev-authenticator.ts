/**
 * Development authenticator.
 *
 * Reads the tenant and actor from request headers. This trusts the client
 * completely, which is fine on a laptop and catastrophic anywhere else, so the
 * constructor refuses to build outside development.
 *
 *   x-haulq-org-id    required, an org uuid
 *   x-haulq-user-id   a users.id  → actor is that user
 *   x-haulq-agent     a model id  → actor is an agent (for testing guardrail 5)
 *   x-haulq-role      defaults to owner
 *
 * One header is deliberately absent: there is no "skip auth" mode. Every
 * development request names an org and an actor, because code written against
 * an implicit tenant is code that will need finding and fixing later — which is
 * the position `ai-load-dispatcher` is in now.
 */

import { ensureDevUser, membershipIn, type Actor, type Database } from '@haulq/db';
import {
  AuthenticationError,
  type Authenticated,
  type AuthenticatedUser,
  type Authenticator,
} from './authenticator.ts';

const ROLES = ['owner', 'dispatcher', 'driver', 'accountant'] as const;
type Role = (typeof ROLES)[number];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export class DevAuthenticator implements Authenticator {
  readonly name = 'dev-header';
  readonly #db: Database | undefined;

  constructor(nodeEnv: string, db?: Database) {
    if (nodeEnv === 'production') {
      throw new Error(
        'DevAuthenticator cannot run in production: it trusts request headers, ' +
          'so anyone could name any tenant. Configure Clerk instead.',
      );
    }
    this.#db = db;
  }

  async authenticate(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<Authenticated | null> {
    const orgId = header(headers, 'x-haulq-org-id');
    if (!orgId) return null;

    if (!UUID.test(orgId)) {
      throw new AuthenticationError(
        'malformed x-haulq-org-id',
        'The x-haulq-org-id header is not a valid uuid.',
      );
    }

    const roleHeader = (header(headers, 'x-haulq-role') ?? 'owner') as Role;
    if (!ROLES.includes(roleHeader)) {
      throw new AuthenticationError(
        `unknown role ${roleHeader}`,
        `"${roleHeader}" is not a role. Expected one of: ${ROLES.join(', ')}.`,
      );
    }

    const agent = header(headers, 'x-haulq-agent');
    const userId = header(headers, 'x-haulq-user-id');

    let actor: Actor;
    if (agent) {
      // Lets guardrail 5 be exercised locally: an agent-actor request should
      // produce agent-attributed events and be refused anything that commits.
      actor = {
        type: 'agent',
        model: agent,
        ...(userId ? { onBehalfOfUserId: userId } : {}),
      };
    } else if (userId) {
      if (!UUID.test(userId)) {
        throw new AuthenticationError(
          'malformed x-haulq-user-id',
          'The x-haulq-user-id header is not a valid uuid.',
        );
      }
      actor = { type: 'user', id: userId, email: 'dev@haulq.test' };
    } else {
      throw new AuthenticationError(
        'no actor',
        'Send x-haulq-user-id or x-haulq-agent. Every request must name who is acting.',
      );
    }

    // The user row is created on first sight, mirroring the Clerk path. Without
    // it, signing up as a brand-new person fails on a foreign key — which is
    // exactly the flow a demo starts with.
    if (this.#db && actor.type === 'user') await ensureDevUser(this.#db, actor.id);

    /**
     * A real membership wins over the header.
     *
     * Clerk resolves the role from `org_memberships` on every request. If the
     * stub only ever trusted a header, every role-related test would be
     * exercising the header rather than the access model — and would keep
     * passing after a change that broke the real thing.
     *
     * The header stays as a fallback for fixtures that create an org and a user
     * without a membership between them, which several tests do deliberately in
     * order to check a 403.
     */
    const role =
      this.#db && actor.type === 'user'
        ? ((await membershipIn(this.#db, actor.id, orgId))?.role ?? roleHeader)
        : roleHeader;

    return { orgId, actor, role };
  }

  async authenticateUser(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedUser | null> {
    const userId = header(headers, 'x-haulq-user-id');
    if (!userId) return null;

    if (!UUID.test(userId)) {
      throw new AuthenticationError(
        'malformed x-haulq-user-id',
        'The x-haulq-user-id header is not a valid uuid.',
      );
    }

    // An agent header present here is refused rather than ignored. Silently
    // downgrading it to a user would be the worst of both: guardrail 5 bypassed,
    // and the log claiming a person did it.
    if (header(headers, 'x-haulq-agent')) {
      throw new AuthenticationError(
        'agent attempted onboarding',
        'HaulQ will not create an account on its own. This needs a person.',
      );
    }

    if (this.#db) {
      const user = await ensureDevUser(this.#db, userId);
      return { actor: { type: 'user', id: user.id, email: user.email } };
    }

    return { actor: { type: 'user', id: userId, email: 'dev@haulq.test' } };
  }
}
