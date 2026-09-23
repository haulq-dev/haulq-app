/**
 * Outbound — everything HaulQ sends, or would send, in a carrier's name.
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 1.
 *
 * `outbound_messages` is the verbatim record: the exact recipients, subject
 * and body, whether it was only drafted (`shadow`), held for approval, or
 * sent. Shadow rows are the point, not an edge case — they are what the
 * carrier reviews to decide an action type can be trusted, so they are
 * stored with the same fidelity as a sent message.
 *
 * `status`, `mode` and `action_type` are text rather than enums, the same
 * reasoning `board_credentials.board` gives: the set grows on the
 * application's schedule, and the registry that bounds them lives in
 * `@haulq/contracts` (`outbound.ts`), where the web app can read it too.
 * `@haulq/db` deliberately does not import that package.
 */

import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { orgs, users } from './tenancy.ts';

export const outboundMessages = pgTable(
  'outbound_messages',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** Key into `OUTBOUND_ACTIONS`. Not an enum — see the module note. */
    actionType: text('action_type').notNull(),
    /** The mode this message actually ran under, after the ceiling and the kill switch. */
    mode: text('mode').notNull(),
    /** 'shadow' | 'pending_approval' | 'sending' | 'sent' | 'failed' | 'rejected'. */
    status: text('status').notNull(),
    /** Set when the message asked for more autonomy than it was allowed: 'sending_disabled' | 'not_connected'. */
    holdReason: text('hold_reason'),

    channel: text('channel').notNull().default('email'),
    toAddresses: jsonb('to_addresses').notNull().$type<string[]>(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),

    /** What this message is about — usually a load or an invoice. Loose on purpose: no FK, the way `event_log.subject_id` is loose. */
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),

    /**
     * Caller-supplied identity for the *intent*, so a loop that re-evaluates
     * the same load every pass cannot send the same chase twice. Unique per
     * org when present; the second `send` with the same key returns the
     * first row rather than creating another.
     */
    dedupeKey: text('dedupe_key'),

    /** Unipile's id for the sent message, when it returned one. */
    providerMessageId: text('provider_message_id'),
    error: text('error'),

    /** Who approved or rejected it — null for a message that never needed a person. */
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    index('outbound_messages_org_created_idx').on(t.orgId, t.createdAt),
    index('outbound_messages_org_status_idx').on(t.orgId, t.status),
    uniqueIndex('outbound_messages_org_dedupe_key')
      .on(t.orgId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

/**
 * One row per (org, action type) the carrier has set. An action type with
 * no row runs in `shadow` — the absence of a decision is never
 * permission.
 */
export const autonomySettings = pgTable(
  'autonomy_settings',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    /** 'shadow' | 'draft' | 'act'. Held to the action's ceiling at send time, not just at write time. */
    mode: text('mode').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('autonomy_settings_org_action_key').on(t.orgId, t.actionType)],
);
