/**
 * Trucks and drivers.
 *
 * `trucks` extends the dispatcher's table of the same name. Two additions worth
 * naming:
 *
 *  - `capabilities`. The dispatcher's extraction layer exists because the
 *    deal-breakers hide in a broker's freeform comment: liftgate, dock height,
 *    TWIC, driver assist, no pallet jack on site. Matching those against what
 *    the truck can actually do requires storing what the truck can actually do,
 *    and nobody else in this market models it. Build plan section 8 lists
 *    accessorial-aware matching as a place HaulQ wins.
 *
 *  - `shortHaulExempt`. Build plan section 13: box truck operators frequently
 *    run under the 150 air-mile exemption, so ELD coverage is patchy and the
 *    driver-app GPS fallback is not optional. Which fallback applies is a
 *    property of the truck, so it is recorded here rather than inferred.
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { pk, timestamps } from './_shared.ts';
import { equipmentTypeEnum } from './enums.ts';
import { orgs, users } from './tenancy.ts';

export const trucks = pgTable(
  'trucks',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** What the carrier calls it. "Unit 12", "the white box". */
    label: text('label').notNull(),
    equipment: equipmentTypeEnum('equipment').notNull().default('STRAIGHT_BOX'),

    vin: text('vin'),
    plateState: text('plate_state'),
    plateNumber: text('plate_number'),

    // --- physical limits, the hard gates in screening --------------------
    maxWeightLbs: integer('max_weight_lbs'),
    maxLengthFt: integer('max_length_ft'),
    boxHeightIn: integer('box_height_in'),
    boxWidthIn: integer('box_width_in'),

    /**
     * What the truck can do beyond carrying weight. Shape mirrors
     * `TruckCapabilities` in the dispatcher core's `ai/types.ts` — keep them in
     * sync, the extraction layer compares against this object directly.
     * e.g. `{"liftgate":true,"palletJack":true,"dockHigh":false,"twic":false}`
     */
    capabilities: jsonb('capabilities').notNull().default(sql`'{}'::jsonb`),

    // --- economics, per truck --------------------------------------------
    /** Cents per mile, all-in. Overrides the org-level figure when set. */
    costPerMileCents: integer('cost_per_mile_cents'),
    avgMpg: doublePrecision('avg_mpg'),

    // --- where it is now --------------------------------------------------
    currentCity: text('current_city'),
    currentState: text('current_state'),
    currentLat: doublePrecision('current_lat'),
    currentLng: doublePrecision('current_lng'),
    /** How the position above was obtained: 'eld' | 'driver_app' | 'manual'. */
    positionSource: text('position_source'),
    positionAt: timestamp('position_at', { withTimezone: true }),

    availableFrom: timestamp('available_from', { withTimezone: true }),

    /** See the module note. Determines whether ELD data can be relied on. */
    shortHaulExempt: boolean('short_haul_exempt').notNull().default(false),

    /**
     * Motive's own numeric vehicle id, when this truck has been matched to
     * one. Phase 2b's own vehicle, not a HaulQ id — set once by a carrier
     * connecting Motive (`repositories/trucks.ts`'s `setTruckMotiveVehicleId`),
     * read by `integrations/motive-sync.ts` to know which `truck_positions`
     * row a fetched location becomes. Matching by label/number instead was
     * considered and rejected: a carrier renaming a truck, or Motive's
     * vehicle "number" not matching HaulQ's label, would silently stop the
     * sync rather than failing loudly.
     */
    motiveVehicleId: integer('motive_vehicle_id'),

    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('trucks_org_idx').on(t.orgId),
    index('trucks_org_active_idx').on(t.orgId, t.active),
    unique('trucks_org_label_key').on(t.orgId, t.label),
    /** Partial — most trucks have no Motive vehicle yet, and null must not collide with null. */
    uniqueIndex('trucks_org_motive_vehicle_key')
      .on(t.orgId, t.motiveVehicleId)
      .where(sql`${t.motiveVehicleId} is not null`),
  ],
);

/**
 * A driver.
 *
 * Separate from `users` because plenty of drivers at a small carrier will never
 * log in, and a load still has to be assigned to them. `userId` is the optional
 * link for the ones who do.
 */
export const drivers = pgTable(
  'drivers',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Null until the driver accepts an invite and installs the app. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    fullName: text('full_name').notNull(),
    phone: text('phone'),
    email: text('email'),

    cdlNumber: text('cdl_number'),
    cdlState: text('cdl_state'),
    cdlExpiresAt: timestamp('cdl_expires_at', { withTimezone: true }),
    medicalCardExpiresAt: timestamp('medical_card_expires_at', {
      withTimezone: true,
    }),

    /**
     * Endorsements and cards that gate specific freight. Kept as an array so a
     * load requirement extracted from broker comments ("TWIC required") can be
     * matched with a containment check rather than a jsonb path.
     */
    endorsements: text('endorsements').array().notNull().default(sql`'{}'`),

    /** Default truck. Loads can still be assigned against another. */
    defaultTruckId: uuid('default_truck_id').references(() => trucks.id, {
      onDelete: 'set null',
    }),

    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('drivers_org_idx').on(t.orgId),
    index('drivers_org_active_idx').on(t.orgId, t.active),
    index('drivers_user_idx').on(t.userId),
  ],
);

// --- relations -------------------------------------------------------------

export const trucksRelations = relations(trucks, ({ one, many }) => ({
  org: one(orgs, { fields: [trucks.orgId], references: [orgs.id] }),
  drivers: many(drivers),
}));

export const driversRelations = relations(drivers, ({ one }) => ({
  org: one(orgs, { fields: [drivers.orgId], references: [orgs.id] }),
  user: one(users, { fields: [drivers.userId], references: [users.id] }),
  defaultTruck: one(trucks, {
    fields: [drivers.defaultTruckId],
    references: [trucks.id],
  }),
}));
