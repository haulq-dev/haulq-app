/**
 * Brokers, as the carrier knows them.
 *
 * This table holds *asserted* facts — the name on the rate confirmation, the
 * email the load came from, what the carrier has typed in. It holds no
 * verification result. Guardrail 3 is that authority and insurance come from an
 * authoritative source with a timestamp, and the moment a `insurance_ok`
 * boolean appears on this table someone will read it six months stale and route
 * a load against it.
 *
 * Verify's output lands in `broker_verifications` in Phase 0b: one row per
 * check, each with its source, the raw response, and the time it was fetched.
 * This table will gain a pointer to the latest one and nothing more.
 *
 * Scoped per org rather than global. Two carriers can hold different, equally
 * valid opinions of the same broker, and a shared row invites one tenant's
 * "do not load" note to leak into another's screen.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { orgs } from './tenancy.ts';

export const brokers = pgTable(
  'brokers',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Digits only, no "MC-" prefix. The join key to FMCSA. */
    mcNumber: text('mc_number'),
    usdotNumber: text('usdot_number'),

    email: text('email'),
    phone: text('phone'),
    website: text('website'),

    /**
     * Carrier's own standing with this broker. `blocked` feeds the dispatcher's
     * `excludedBrokers` criteria directly.
     */
    blocked: boolean('blocked').notNull().default(false),
    blockedReason: text('blocked_reason'),

    /**
     * Agreed payment terms in days, when the carrier has them. Pay uses it to
     * age receivables; Insights uses it to tell a good rate from a good rate
     * paid ninety days late.
     */
    paymentTermsDays: integer('payment_terms_days'),

    notes: text('notes'),

    /**
     * Whatever the load board reported about the posting company. Kept raw and
     * unmerged: it is another party's assertion, not our record, and merging it
     * into the columns above would erase which is which.
     */
    boardMetadata: jsonb('board_metadata').notNull().default(sql`'{}'::jsonb`),

    lastLoadAt: timestamp('last_load_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('brokers_org_idx').on(t.orgId),
    index('brokers_org_mc_idx').on(t.orgId, t.mcNumber),
    index('brokers_org_blocked_idx').on(t.orgId, t.blocked),
    unique('brokers_org_name_mc_key').on(t.orgId, t.name, t.mcNumber),
  ],
);

export const brokersRelations = relations(brokers, ({ one }) => ({
  org: one(orgs, { fields: [brokers.orgId], references: [orgs.id] }),
}));
