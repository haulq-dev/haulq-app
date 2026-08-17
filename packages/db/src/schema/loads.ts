/**
 * The load object.
 *
 * Build plan section 13: "The load object and the event log cannot be
 * retrofitted cheaply. Every later product reads them." So this file gets more
 * design attention than the rest of the schema combined, and the reasoning is
 * written down rather than remembered.
 *
 * ---------------------------------------------------------------------------
 * Four decisions that shape everything downstream
 * ---------------------------------------------------------------------------
 *
 * 1. ONE ROW PER COMMERCIAL LOAD, NOT PER BOARD POSTING.
 *    The dispatcher's `scored_loads` is a log of postings seen — hundreds a day,
 *    mostly rejects, kept because they are the tuning data. That is a different
 *    object with a different lifetime and it stays where it is, in the
 *    dispatcher schema, keyed to this table by `id` once a posting is acted on.
 *    Conflating the two would mean Pay joins against a table that grows by
 *    10,000 rows a week per truck.
 *
 * 2. STOPS ARE ROWS, NOT COLUMNS.
 *    `origin_city`/`dest_city` on the load works until the first two-stop
 *    delivery, and Routes (Phase 3) is multi-load sequencing by definition.
 *    Denormalizing the first and last stop back onto the load for list queries
 *    is a materialized column away; going the other direction is a migration
 *    with data loss.
 *
 * 3. EXPECTED AND ACTUAL ARE BOTH STORED, ALWAYS.
 *    Build plan section 8 names closed-loop learning from reconciled margin as
 *    a place HaulQ wins, and section 13 warns that without a validation dataset
 *    scoring cannot be tuned. Neither is possible if the estimate is overwritten
 *    by the outcome. Every number that can be predicted has an `expected_` and
 *    an `actual_` and they are never the same column.
 *
 * 4. PROVENANCE IS A FIRST-CLASS FIELD, NOT A NOTE.
 *    Guardrail 4 requires respecting each board's permitted use and retention
 *    rules. That is enforceable only if every row knows which board it came
 *    from, under which terms, and when it must be purged. `purge_after` is set
 *    on write by the adapter, not by a policy someone remembers to apply.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, moneyNotNull, pk, timestamps } from './_shared.ts';
import {
  equipmentTypeEnum,
  loadSourceEnum,
  loadStatusEnum,
  stopTypeEnum,
} from './enums.ts';
import { brokers } from './brokers.ts';
import { drivers, trucks } from './fleet.ts';
import { orgs } from './tenancy.ts';

export const loads = pgTable(
  'loads',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /**
     * Human-facing sequential number, per org. "Load 1042" is what gets said on
     * the phone; a uuid is not.
     *
     * Assigned by trigger — see `sql/post/0100_load_reference.sql`. The `0`
     * default is what makes that possible from application code: it tells
     * Drizzle the column is optional on insert, and the trigger treats `0` (and
     * null) as "assign me one". A caller that supplies a real number keeps it,
     * which is how the CSV importer preserves a carrier's historical load
     * numbers that brokers already have on invoices.
     */
    reference: integer('reference').notNull().default(0),

    status: loadStatusEnum('status').notNull().default('prospect'),

    // --- provenance, decision 4 ------------------------------------------
    source: loadSourceEnum('source').notNull(),
    /** 'DAT' | 'DF' | 'TRUCKSTOP' | '123LB' | 'MOCK'. Matches the core's Load.board. */
    sourceBoard: text('source_board'),
    /** `deriveLoadId()` from the core's boards/adapter.ts. */
    sourceLoadId: text('source_load_id'),
    sourceFetchedAt: timestamp('source_fetched_at', { withTimezone: true }),
    /**
     * Retention deadline inherited from the provider's terms. A nightly job
     * purges past this; see guardrail 4. Null means we own the record outright
     * (manual entry, CSV import, the carrier's own email).
     */
    purgeAfter: timestamp('purge_after', { withTimezone: true }),

    // --- counterparty ------------------------------------------------------
    brokerId: uuid('broker_id').references(() => brokers.id, {
      onDelete: 'restrict',
    }),
    /** Broker's own number for this load. Goes on the invoice; brokers pay on it. */
    brokerLoadNumber: text('broker_load_number'),

    // --- freight -----------------------------------------------------------
    equipment: equipmentTypeEnum('equipment').notNull().default('STRAIGHT_BOX'),
    commodity: text('commodity'),
    weightLbs: integer('weight_lbs'),
    lengthFt: integer('length_ft'),
    pieceCount: integer('piece_count'),
    fullLoad: boolean('full_load').notNull().default(true),
    hazmat: boolean('hazmat').notNull().default(false),

    /**
     * Requirements extracted from the broker's freeform comments — liftgate,
     * dock high, driver assist, TWIC, appointment. Written by the core's
     * extraction layer, matched against `trucks.capabilities` and
     * `drivers.endorsements`.
     *
     * Shape is `{ code: string, required: boolean, confidence: number,
     * source: 'pattern'|'model', evidence: string }[]`. Pattern matches block,
     * model findings only warn — that asymmetry is the core's design and this
     * column preserves which is which so it survives the trip through the
     * database.
     */
    requirements: jsonb('requirements').notNull().default(sql`'[]'::jsonb`),
    /** Verbatim broker notes. The thing the extraction layer reads. */
    comments: text('comments'),

    // --- money, decision 3 -------------------------------------------------
    /** What the broker posted or we agreed. All-in unless `rateIsLinehaul`. */
    ...money('rate'),
    rateIsLinehaul: boolean('rate_is_linehaul').notNull().default(false),
    /** Detention, layover, liftgate, TWIC — billed on top. */
    ...money('accessorials'),
    accessorialDetail: jsonb('accessorial_detail')
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Our prediction at decision time. Never overwritten by the outcome. */
    ...money('expectedCost'),
    ...money('expectedMargin'),
    /** Reconciled after settlement. The only honest number. */
    ...money('actualRevenue'),
    ...money('actualCost'),
    ...money('actualMargin'),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),

    // --- distance ----------------------------------------------------------
    expectedDeadheadMiles: integer('expected_deadhead_miles'),
    expectedLoadedMiles: integer('expected_loaded_miles'),
    actualDeadheadMiles: integer('actual_deadhead_miles'),
    actualLoadedMiles: integer('actual_loaded_miles'),
    /**
     * How the expected miles were obtained: 'board' | 'haversine' | 'routing'.
     * The core's distance.ts lands within ~10% of DAT's figure, which is fine
     * for screening and not fine for an invoice. Recording the method means the
     * two uses can be told apart later.
     */
    milesSource: text('miles_source'),

    // --- execution ---------------------------------------------------------
    truckId: uuid('truck_id').references(() => trucks.id, {
      onDelete: 'set null',
    }),
    driverId: uuid('driver_id').references(() => drivers.id, {
      onDelete: 'set null',
    }),

    bookedAt: timestamp('booked_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: text('cancelled_reason'),

    /** Untouched source payload, for debugging an adapter without a re-fetch. */
    raw: jsonb('raw'),

    ...timestamps,
  },
  (t) => [
    unique('loads_org_reference_key').on(t.orgId, t.reference),
    /**
     * The dedupe gate. Without it the same posting becomes two loads the first
     * time a poll overlaps a retry. Partial, because `source_load_id` is null
     * for manual and imported rows and a plain unique index would collapse them.
     */
    unique('loads_org_source_key').on(t.orgId, t.sourceBoard, t.sourceLoadId),
    index('loads_org_status_idx').on(t.orgId, t.status),
    index('loads_org_created_idx').on(t.orgId, t.createdAt),
    index('loads_org_truck_idx').on(t.orgId, t.truckId),
    index('loads_broker_idx').on(t.brokerId),
    index('loads_purge_idx').on(t.purgeAfter),
  ],
);

/**
 * Stops, decision 2.
 *
 * `seq` is the order of service, not the order of entry. A pickup and a delivery
 * can interleave across a multi-load sequence, which is exactly what Routes
 * plans, so nothing here assumes stop 1 is a pickup.
 */
export const loadStops = pgTable(
  'load_stops',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    loadId: uuid('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'cascade' }),

    seq: integer('seq').notNull(),
    type: stopTypeEnum('type').notNull(),

    facilityName: text('facility_name'),
    addressLine1: text('address_line1'),
    city: text('city').notNull(),
    state: text('state').notNull(),
    postalCode: text('postal_code'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),

    /**
     * The appointment window. Both ends nullable because boards routinely post
     * a date with no time, and inventing "00:00" would make an HOS feasibility
     * check confidently wrong.
     */
    windowStart: timestamp('window_start', { withTimezone: true }),
    windowEnd: timestamp('window_end', { withTimezone: true }),
    appointmentRequired: boolean('appointment_required').notNull().default(false),
    appointmentNumber: text('appointment_number'),

    /** Detention evidence. Phase 2's exit gate depends on these four. */
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    loadingStartedAt: timestamp('loading_started_at', { withTimezone: true }),
    loadingEndedAt: timestamp('loading_ended_at', { withTimezone: true }),
    departedAt: timestamp('departed_at', { withTimezone: true }),
    /** How arrival was established: 'geofence' | 'driver_app' | 'eld' | 'manual'. */
    arrivalSource: text('arrival_source'),

    referenceNumber: text('reference_number'),
    instructions: text('instructions'),

    ...timestamps,
  },
  (t) => [
    unique('load_stops_load_seq_key').on(t.loadId, t.seq),
    index('load_stops_org_idx').on(t.orgId),
    index('load_stops_load_idx').on(t.loadId),
    index('load_stops_window_idx').on(t.orgId, t.windowStart),
  ],
);

// --- relations -------------------------------------------------------------

export const loadsRelations = relations(loads, ({ one, many }) => ({
  org: one(orgs, { fields: [loads.orgId], references: [orgs.id] }),
  broker: one(brokers, { fields: [loads.brokerId], references: [brokers.id] }),
  truck: one(trucks, { fields: [loads.truckId], references: [trucks.id] }),
  driver: one(drivers, { fields: [loads.driverId], references: [drivers.id] }),
  stops: many(loadStops),
}));

export const loadStopsRelations = relations(loadStops, ({ one }) => ({
  load: one(loads, { fields: [loadStops.loadId], references: [loads.id] }),
  org: one(orgs, { fields: [loadStops.orgId], references: [orgs.id] }),
}));
