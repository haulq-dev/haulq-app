/**
 * Verify — Phase 0b.
 *
 * `PHASE_0B_PLAN.md` section 5, carrying out what `brokers.ts`'s own header
 * comment already specced before this file existed: one row per check, each
 * with its source, the raw response, and the time it was fetched.
 *
 * Never updated, never soft deleted — a verification is a historical fact
 * about what a source said at a moment in time, not a mutable record, the
 * same reasoning `truck_positions` already applies to a position ping. That
 * is why this gets a plain `checked_at`/`created_at` pair rather than the
 * full `timestamps` spread from `_shared.ts`.
 *
 * `brokers.latestVerificationId` (added on that table, not here) is
 * deliberately a bare `uuid` column with no `.references()` — a real foreign
 * key would need `brokers.ts` to import this file while this file already
 * imports `brokers.ts` for `brokerId`, and breaking that cycle by hand is not
 * worth it for a pointer column the application always sets right after the
 * insert it points at.
 */

import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pk } from './_shared.ts';
import { brokers } from './brokers.ts';
import { orgs } from './tenancy.ts';

export const brokerVerifications = pgTable(
  'broker_verifications',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    brokerId: uuid('broker_id')
      .notNull()
      .references(() => brokers.id, { onDelete: 'cascade' }),

    /** e.g. "FMCSA QCMobile". What a carrier is shown as the fact's provenance. */
    source: text('source').notNull(),
    /** 'Authorized' | 'Not authorized' | 'Unknown' — null if the lookup found nothing. */
    operatingStatus: text('operating_status'),
    legalName: text('legal_name'),
    dbaName: text('dba_name'),
    /** Untouched response body, same reasoning `loads.raw` already uses. */
    raw: jsonb('raw'),

    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('broker_verifications_org_idx').on(t.orgId),
    /** Serves "the latest check for this broker" without needing the pointer column. */
    index('broker_verifications_broker_checked_idx').on(t.brokerId, t.checkedAt),
  ],
);
