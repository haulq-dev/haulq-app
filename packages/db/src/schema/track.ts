/**
 * Track — Phase 2a.
 *
 * PHASE_2_PLAN.md section 4. Two link tables and one telemetry table:
 *
 *  - `load_checkin_links` — a driver's unauthenticated-but-scoped route to
 *    report arrival, loading and departure on one load, without a Clerk
 *    account. Same token-hash shape `org_invitations` already uses
 *    (`tenancy.ts`); the real difference is what the token authorizes —
 *    writing `load_stops`' timestamps and `truck_positions`, not joining a
 *    carrier. Read-many rather than accept-once, so there is no
 *    `accepted_at`: a driver opens the link repeatedly over one load's life.
 *
 *  - `load_visibility_links` — the read-only counterpart for a broker.
 *    `expires_at` is nullable because plan section 7 leaves the link's
 *    lifetime an open decision — "live until the load reaches a terminal
 *    status, or a fixed window, or manually revocable... probably some
 *    mix." Null means no fixed date; the repository is where that mix gets
 *    decided once it is, not here.
 *
 *  - `truck_positions` — telemetry, not a business event. Plan section 4:
 *    "jamming a ping every few minutes into an append-only hash-chained
 *    audit log is the same category error `documents.ts`'s header already
 *    warns against for bytes." Written alongside `trucks.currentLat/
 *    currentLng/positionAt/positionSource`, which stays the fast "where is
 *    it right now" read — one write, two destinations, the same pattern the
 *    CSV importer already uses for `loads`/`import_rows.loadId`. Built now,
 *    in 2a, so 2b's ELD adapter has a tested sink to write into rather than
 *    designing one under integration pressure.
 *
 * What is NOT here, deliberately: a detention-threshold column (plan
 * section 7 — where it lives is still open) and anything ELD-specific (2b,
 * plan section 5; `board_credentials` already carries the connection,
 * `truck_positions` above already gives 2b a sink).
 */

import { relations, sql } from 'drizzle-orm';
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { drivers, trucks } from './fleet.ts';
import { loads } from './loads.ts';
import { orgs, users } from './tenancy.ts';

/**
 * A position ping. Append-only telemetry — never updated, never soft
 * deleted — so this gets a plain `created_at` rather than the full
 * `timestamps` spread, the same reasoning `event_outbox` already applies.
 */
export const truckPositions = pgTable(
  'truck_positions',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    truckId: uuid('truck_id')
      .notNull()
      .references(() => trucks.id, { onDelete: 'cascade' }),

    lat: doublePrecision('lat').notNull(),
    lng: doublePrecision('lng').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** 'driver_app' | 'eld' | 'manual'. Mirrors `trucks.position_source`. */
    source: text('source').notNull(),
    /** Untouched adapter payload, same reasoning as `loads.raw`. */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('truck_positions_org_idx').on(t.orgId),
    /** Serves both "where is this truck now" and its breadcrumb trail. */
    index('truck_positions_truck_recorded_idx').on(t.truckId, t.recordedAt),
  ],
);

export const loadCheckinLinks = pgTable(
  'load_checkin_links',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    loadId: uuid('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'cascade' }),
    /** Who the link was handed to. Nullable — a carrier can issue one before naming a driver. */
    driverId: uuid('driver_id').references(() => drivers.id, {
      onDelete: 'set null',
    }),

    /** sha256 of the token, hex. Only ever in the link itself. */
    tokenHash: text('token_hash').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('load_checkin_links_token_key').on(t.tokenHash),
    index('load_checkin_links_org_idx').on(t.orgId),
    index('load_checkin_links_load_idx').on(t.loadId),
  ],
);

export const loadVisibilityLinks = pgTable(
  'load_visibility_links',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    loadId: uuid('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    /** Null = no fixed date. See the module note on plan section 7. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('load_visibility_links_token_key').on(t.tokenHash),
    index('load_visibility_links_org_idx').on(t.orgId),
    index('load_visibility_links_load_idx').on(t.loadId),
  ],
);

// --- relations ---------------------------------------------------------

export const truckPositionsRelations = relations(truckPositions, ({ one }) => ({
  org: one(orgs, { fields: [truckPositions.orgId], references: [orgs.id] }),
  truck: one(trucks, { fields: [truckPositions.truckId], references: [trucks.id] }),
}));

export const loadCheckinLinksRelations = relations(loadCheckinLinks, ({ one }) => ({
  org: one(orgs, { fields: [loadCheckinLinks.orgId], references: [orgs.id] }),
  load: one(loads, { fields: [loadCheckinLinks.loadId], references: [loads.id] }),
  driver: one(drivers, {
    fields: [loadCheckinLinks.driverId],
    references: [drivers.id],
  }),
}));

export const loadVisibilityLinksRelations = relations(loadVisibilityLinks, ({ one }) => ({
  org: one(orgs, { fields: [loadVisibilityLinks.orgId], references: [orgs.id] }),
  load: one(loads, { fields: [loadVisibilityLinks.loadId], references: [loads.id] }),
}));
