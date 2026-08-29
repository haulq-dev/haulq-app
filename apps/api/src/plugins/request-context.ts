/**
 * Turns an authenticated request into a `Scope`.
 *
 * This is the boundary the whole write path depends on. Below it, nothing
 * reaches for the session again: a service function takes a `Scope` and cannot
 * be called without a tenant and an actor already established.
 *
 * Routes opt in by calling `requireScope(request)`. Not a global hook, because
 * `/health` and `/ready` must answer before there is any tenant, and a hook
 * that has to be skipped for some routes is a hook someone will forget to skip
 * — in the direction that breaks the health check, or worse, the one that
 * leaves a route unauthenticated.
 */

import { randomUUID } from 'node:crypto';
import { scope, type RequestContext, type Scope } from '@haulq/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  AuthenticationError,
  type Authenticated,
  type Authenticator,
} from '../auth/authenticator.ts';

declare module 'fastify' {
  interface FastifyInstance {
    authenticator: Authenticator;
  }
  interface FastifyRequest {
    /** Populated by `requireScope`. Undefined on public routes. */
    auth?: Authenticated;
  }
}

/**
 * Raised when a request is refused. Carries an `explanation` because the API's
 * error envelope requires one — see `ApiErrorSchema` in `@haulq/contracts`, and
 * guardrail 6 for why a bare error code is not acceptable output.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly explanation: string;

  // Explicit fields, not parameter properties — see the note on
  // AuthenticationError. Node strips types rather than compiling them, so
  // anything requiring generated code is unavailable.
  constructor(statusCode: number, code: string, explanation: string) {
    super(explanation);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.explanation = explanation;
  }
}

export const requestContextPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', undefined);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ code: err.code, explanation: err.explanation });
    }
    if (err instanceof AuthenticationError) {
      return reply
        .code(401)
        .send({ code: 'unauthenticated', explanation: err.explanation });
    }
    // Fastify's own schema validation, when a route opts into it. Typed loosely
    // because `setErrorHandler` widens to unknown once other error classes are
    // narrowed above it.
    const fastifyError = err as { validation?: unknown; message?: string; statusCode?: number };
    if (fastifyError.validation) {
      return reply.code(400).send({
        code: 'invalid_request',
        explanation: fastifyError.message ?? 'The request body is not valid.',
        details: fastifyError.validation,
      });
    }

    // @fastify/rate-limit's own error, thrown with `statusCode: 429` already
    // set — not a bug to hide behind a generic 500. Its message ("Rate limit
    // exceeded, retry in N seconds") is safe to show as-is, unlike the
    // catch-all below: it never carries a column name, a constraint name, or
    // another tenant's data.
    if (fastifyError.statusCode === 429) {
      return reply.code(429).send({
        code: 'rate_limited',
        explanation: fastifyError.message ?? 'Too many requests. Try again shortly.',
      });
    }

    request.log.error({ err }, 'unhandled error');
    // Deliberately not the underlying message. It can carry column names,
    // constraint names and fragments of other tenants' data.
    return reply.code(500).send({
      code: 'internal_error',
      explanation: 'Something went wrong on our side. It has been logged.',
    });
  });
});

/**
 * Authenticate, then build the scope.
 *
 * Throws rather than returning null, so a route that forgets to check cannot
 * proceed with an undefined tenant.
 */
export async function requireScope(request: FastifyRequest): Promise<Scope> {
  const app = request.server;
  const authenticated = await app.authenticator.authenticate(request.headers);

  if (!authenticated) {
    throw new HttpError(
      401,
      'unauthenticated',
      'This request did not identify an account. Sign in and try again.',
    );
  }

  request.auth = authenticated;

  const ctx: RequestContext = {
    orgId: authenticated.orgId,
    actor: authenticated.actor,
    // One id per request, so every event this request produces can be found
    // together afterwards. `event_log_correlation_idx` exists for this query.
    correlationId: randomUUID(),
    ...(request.ip ? { ipAddress: request.ip } : {}),
    ...(typeof request.headers['user-agent'] === 'string'
      ? { userAgent: request.headers['user-agent'] }
      : {}),
  };

  return scope(app.db, ctx);
}

/**
 * Role check.
 *
 * Coarse by design — four roles, checked at the route. Anything finer belongs
 * in a policy table once HaulQ Fleet needs it, not in a growing pile of
 * conditionals here.
 */
export function requireRole(
  request: FastifyRequest,
  ...allowed: Array<'owner' | 'dispatcher' | 'driver' | 'accountant'>
): void {
  const role = request.auth?.role;
  if (!role || !allowed.includes(role)) {
    throw new HttpError(
      403,
      'forbidden',
      `This action needs ${allowed.join(' or ')} access. Your role is ${role ?? 'unknown'}.`,
    );
  }
}

/**
 * Refuse an action to a model actor.
 *
 * Guardrail 5: no load commitment, payment or compliance determination beyond
 * explicit customer authority. The rule needs a place to be applied, and it has
 * to be a call an author makes deliberately rather than a default that can be
 * inherited by accident.
 */
export function refuseAgentCommitment(request: FastifyRequest, action: string): void {
  if (request.auth?.actor.type === 'agent') {
    throw new HttpError(
      403,
      'agent_may_not_commit',
      `HaulQ will not ${action} on its own. This needs a person to approve it.`,
    );
  }
}
