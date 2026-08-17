/**
 * The event log.
 *
 * Guardrail 6: "Immutable log of recommendations, decisions, messages, document
 * changes, financial actions — with human-readable explanations." Build plan
 * section 13 puts it alongside the load object as un-retrofittable.
 *
 * ---------------------------------------------------------------------------
 * Immutable means enforced, not intended
 * ---------------------------------------------------------------------------
 *
 * Append-only is a database grant, not a code review convention. 0001_guards.sql
 * revokes UPDATE and DELETE on this table from the application role and adds a
 * trigger that raises on either. If the audit trail can be edited by the same
 * credential that writes it, it is a log, not an audit trail.
 *
 * `hash` and `prev_hash` chain each org's events. Tampering by anyone who
 * *does* hold DDL rights then requires rewriting every subsequent row, which is
 * detectable by a verification pass. This is cheap insurance against the
 * scenario that actually matters: a dispute over what HaulQ recommended and
 * when, months later, with money attached.
 *
 * ---------------------------------------------------------------------------
 * `explanation` is not optional
 * ---------------------------------------------------------------------------
 *
 * Guardrail 6 says human-readable, and section 8 sells explainable control.
 * Every writer must produce a sentence a carrier can read without the schema in
 * front of them: "Recommended load 1042 (Wichita → Denver, $2,400) because it
 * clears $1.94/total mile against your $1.60 floor." Not "score=72".
 *
 * `actor_type = 'agent'` exists so guardrail 5 — no binding AI commitments — is
 * auditable. A model's action must never be indistinguishable from a cron job's.
 */

import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { actorTypeEnum } from './enums.ts';
import { orgs, users } from './tenancy.ts';

export const eventLog = pgTable(
  'event_log',
  {
    /**
     * bigserial, not uuid. Ordering is the point, and the dispatcher schema
     * already learned this the hard way: an approve and an undo can land inside
     * the same timestamp tick, at which point ordering on `occurred_at` alone is
     * undefined and the undo can lose to the approve it was meant to reverse.
     * That was caught by a test against the SQLite store. Same hazard here.
     */
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),

    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'restrict' }),

    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // --- who ---------------------------------------------------------------
    actorType: actorTypeEnum('actor_type').notNull(),
    /** User id for `user`, model identifier for `agent`, service name otherwise. */
    actorId: text('actor_id'),
    actorUserId: uuid('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // --- what --------------------------------------------------------------
    /** Dotted past-tense verb: `load.booked`, `document.validated`, `invoice.sent`. */
    verb: text('verb').notNull(),
    /** 'load' | 'document' | 'invoice' | 'truck' | 'org' | ... */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),

    /** See the module note. A sentence, for a person, always. */
    explanation: text('explanation').notNull(),

    /** Structured payload. Before/after for changes, inputs for recommendations. */
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),

    // --- tamper evidence ---------------------------------------------------
    /** sha256 over the canonical serialization of this row plus `prev_hash`. */
    hash: text('hash'),
    /** `hash` of the previous event for this org. Null for the first. */
    prevHash: text('prev_hash'),

    // --- request context ---------------------------------------------------
    /** Ties every event produced by one request or job run together. */
    correlationId: uuid('correlation_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('event_log_org_seq_idx').on(t.orgId, t.seq),
    index('event_log_subject_idx').on(t.orgId, t.subjectType, t.subjectId, t.seq),
    index('event_log_verb_idx').on(t.orgId, t.verb, t.occurredAt),
    index('event_log_correlation_idx').on(t.correlationId),
    index('event_log_agent_idx')
      .on(t.orgId, t.seq)
      .where(sql`actor_type = 'agent'`),
  ],
);

/**
 * Transactional outbox.
 *
 * Build plan section 5 picks "outbox table + pg-boss consumers" over a broker.
 * A row lands here in the same transaction as the state change it describes, so
 * a notification is never sent for a booking that rolled back, and never lost
 * for one that committed.
 *
 * Separate from `event_log` on purpose. The log is permanent and append-only;
 * the outbox is a work queue that is drained and pruned. One table doing both
 * would mean either retaining queue rows forever or deleting audit rows.
 */
export const eventOutbox = pgTable(
  'event_outbox',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** Matches `event_log.seq` when the outbox row mirrors a logged event. */
    eventSeq: bigint('event_seq', { mode: 'bigint' }),

    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    /** null = pending. Set when a consumer commits the handling. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Backoff. Consumers skip rows whose time has not come. */
    availableAt: timestamp('available_at', { withTimezone: true })
      .notNull()
      .defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The consumer's only query. Partial, so drained rows cost nothing. */
    index('event_outbox_pending_idx')
      .on(t.availableAt, t.seq)
      .where(sql`processed_at is null`),
    index('event_outbox_org_idx').on(t.orgId),
  ],
);

export const eventLogRelations = relations(eventLog, ({ one }) => ({
  org: one(orgs, { fields: [eventLog.orgId], references: [orgs.id] }),
  actorUser: one(users, {
    fields: [eventLog.actorUserId],
    references: [users.id],
  }),
}));
