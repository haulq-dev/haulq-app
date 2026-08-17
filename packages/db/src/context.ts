/**
 * Request context.
 *
 * Every write in HaulQ happens on behalf of somebody, inside some tenant, as
 * part of some request. Those three facts are needed by the event log on every
 * append, and threading them through as loose arguments means they get dropped
 * exactly where it matters least visibly and hurts most later.
 *
 * So they travel together, in one object, and the write path takes that object
 * rather than an `orgId` string. The type is the enforcement: a function that
 * writes cannot be called without someone having named an actor.
 *
 * ---------------------------------------------------------------------------
 * Why `actor` is a union rather than a nullable userId
 * ---------------------------------------------------------------------------
 *
 * Guardrail 5 forbids binding AI commitments, and guardrail 6 requires an audit
 * trail that can be read months later during a dispute. Both collapse if a
 * model's action and a cron job's action are stored the same way. A nullable
 * `userId` gives exactly that — two different kinds of "not a person" that
 * nobody can tell apart afterwards.
 *
 * Modelling the actor as a discriminated union makes the distinction impossible
 * to lose: an agent action carries its model identifier, and `event_log`'s
 * `actor_type` column has a partial index on `'agent'` so "everything a model
 * did in this org" is one query rather than a forensic exercise.
 */

import type { Database } from './client.ts';

/** Who is acting. See the module note for why this is a union. */
export type Actor =
  | {
      type: 'user';
      /** `users.id`. */
      id: string;
      /** For the log's `actor_id`, so a deleted user's actions stay readable. */
      email?: string;
    }
  | {
      type: 'agent';
      /**
       * Model identifier, e.g. `claude-haiku-4-5-20251001`. Recorded verbatim.
       * When a recommendation is questioned, "which model, on which date" is the
       * first question and an un-versioned 'agent' cannot answer it.
       */
      model: string;
      /** The user the agent is acting for, when there is one. Never the actor. */
      onBehalfOfUserId?: string;
    }
  | {
      type: 'system';
      /** Job or service name, e.g. `retention-purge`, `outbox-consumer`. */
      name: string;
    }
  | {
      type: 'integration';
      /** Provider name, e.g. `clerk-webhook`, `postmark-inbound`. */
      provider: string;
    };

/**
 * Everything a write needs to know about who is asking.
 *
 * Constructed once per request (or once per job run) and passed down. Nothing
 * below the boundary reaches for the session again.
 */
export interface RequestContext {
  readonly orgId: string;
  readonly actor: Actor;
  /**
   * Ties every event from one request or job run together. Generated at the
   * boundary; the log's `correlation_idx` exists to query on it.
   */
  readonly correlationId: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/**
 * A context plus the connection to use.
 *
 * Separate from `RequestContext` because the connection changes inside a
 * transaction and the context does not. `withTransaction` swaps `db` and leaves
 * everything else identical, which is what makes it safe to pass a `Scope` into
 * a function that may or may not open a transaction of its own.
 */
export interface Scope {
  readonly ctx: RequestContext;
  readonly db: Database;
}

export function scope(db: Database, ctx: RequestContext): Scope {
  return { ctx, db };
}

/** The `actor_id` column's value, per actor kind. */
export function actorId(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return actor.email ?? actor.id;
    case 'agent':
      return actor.model;
    case 'system':
      return actor.name;
    case 'integration':
      return actor.provider;
  }
}

/** The `actor_user_id` foreign key, when a real person is behind the action. */
export function actorUserId(actor: Actor): string | null {
  switch (actor.type) {
    case 'user':
      return actor.id;
    case 'agent':
      // Deliberately recorded, but the actor is still the agent. This is the
      // column that answers "who authorized this" without ever implying the
      // person performed it.
      return actor.onBehalfOfUserId ?? null;
    default:
      return null;
  }
}

/**
 * How the actor should be described in an explanation sentence.
 *
 * Used by the event log's default phrasing so log lines read like English
 * rather than like a schema dump.
 */
export function actorLabel(actor: Actor): string {
  switch (actor.type) {
    case 'user':
      return actor.email ?? 'a user';
    case 'agent':
      return `HaulQ (${actor.model})`;
    case 'system':
      return `HaulQ (${actor.name})`;
    case 'integration':
      return actor.provider;
  }
}
