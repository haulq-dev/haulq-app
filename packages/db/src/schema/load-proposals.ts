/**
 * Load proposals: a rate confirmation, read as the load it describes, waiting
 * for one person to look. `FEATURE_REQUESTS_PLAN.md` section 12.
 *
 * A proposal is not a load. It exists so that a rate confirmation arriving by
 * email can be turned into a load by a tap instead of by retyping, without
 * anything being created behind anyone's back. The load exists only when a
 * person accepts it, and until then this row is all there is.
 *
 * One row per document, so reading the same rate confirmation twice (the outbox
 * delivers at least once) cannot make two proposals. The fields, the text each
 * came from and the things that could not be used are stored as they were read,
 * so a person is shown what the reader saw rather than a re-run of it.
 *
 * `fields`, `evidence`, `notes` and `gaps` are opaque JSON here. Their shape is
 * `ProposedLoad` and `LoadReading` in `@haulq/contracts`, which this package
 * deliberately does not import (see `schema/outbound.ts`).
 */

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { documents } from './documents.ts';
import { loads } from './loads.ts';
import { orgs, users } from './tenancy.ts';

export const loadProposals = pgTable(
  'load_proposals',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    /**
     * 'pending' | 'created' | 'attached' | 'dismissed' | 'unreadable'.
     *
     * `unreadable` is a reading that produced nothing usable. It is stored so a
     * person sees "could not read this one" rather than nothing, and so it is not
     * read again on every redelivery; asking again replaces it.
     */
    status: text('status').notNull(),

    /** The load as read: `ProposedLoad`. Empty for an unreadable one. */
    fields: jsonb('fields').notNull().$type<unknown>(),
    /** Field path to the exact text it was read from. */
    evidence: jsonb('evidence').notNull().$type<Record<string, string>>(),
    /** What was read but could not be used, in words a person can act on. */
    notes: jsonb('notes').notNull().$type<string[]>(),
    /** What a person still has to supply: 'pickup', 'delivery', 'rate', and so on. */
    gaps: jsonb('gaps').notNull().$type<string[]>(),

    /** An existing load with the same broker load number: attach, do not create a second. */
    matchedLoadId: uuid('matched_load_id').references(() => loads.id, { onDelete: 'set null' }),
    /** The load a person made from it. */
    createdLoadId: uuid('created_load_id').references(() => loads.id, { onDelete: 'set null' }),

    /** Which reader and prompt produced it, the way `documents.extractor_version` does. */
    model: text('model'),

    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('load_proposals_document_key').on(t.documentId),
    index('load_proposals_org_status_idx').on(t.orgId, t.status),
    index('load_proposals_org_created_idx').on(t.orgId, t.createdAt),
  ],
);
