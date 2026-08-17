/**
 * Postgres enums.
 *
 * A value here is a promise: adding one is a migration, removing one is a data
 * migration. Where the set is genuinely open (document kinds, accessorial
 * codes) use `text` with a check constraint instead so the tail can grow
 * without a deploy.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

// --- tenancy ---------------------------------------------------------------

/**
 * Carrier is the only tenant type that can hold loads. `broker` and `shipper`
 * exist because build plan section 12 leaves "carrier-only at launch" open and
 * the column is free now, expensive later.
 */
export const orgTypeEnum = pgEnum('org_type', ['carrier', 'broker', 'shipper']);

export const orgStatusEnum = pgEnum('org_status', [
  'trialing',
  'active',
  'past_due',
  'paused',
  'cancelled',
]);

/**
 * Roles, coarse on purpose. Fine-grained permissions belong in a policy table
 * once HaulQ Fleet needs them; four roles cover an owner-operator and a
 * fifteen-truck fleet.
 */
export const orgRoleEnum = pgEnum('org_role', [
  'owner',
  'dispatcher',
  'driver',
  'accountant',
]);

export const membershipStatusEnum = pgEnum('membership_status', [
  'invited',
  'active',
  'suspended',
]);

// --- equipment and loads ---------------------------------------------------

/**
 * Mirrors `EquipmentType` in the dispatcher core
 * (`packages/core/src/types.ts`). These two lists must not drift — the board
 * adapters emit the core union and it is written straight into this column.
 */
export const equipmentTypeEnum = pgEnum('equipment_type', [
  'STRAIGHT_BOX',
  'DRY_VAN',
  'REEFER',
  'FLATBED',
  'POWER_ONLY',
  'OTHER',
]);

/**
 * The load lifecycle. Ordered, and the only legal transitions are forward one
 * step or to `cancelled` — enforced in 0001_guards.sql, not in application code,
 * because HaulQ Docs, Pay and Dispatch all write to this column.
 */
export const loadStatusEnum = pgEnum('load_status', [
  'prospect', // seen on a board or in an email, nobody has committed
  'quoted', // we have made or received an offer
  'booked', // rate confirmation signed
  'dispatched', // assigned to a truck and driver
  'in_transit',
  'delivered', // POD in hand
  'invoiced',
  'paid',
  'cancelled',
]);

/**
 * Where the record came from. Drives retention: board-sourced rows inherit that
 * board's permitted-use terms (guardrail 4) and get a `purge_after`.
 */
export const loadSourceEnum = pgEnum('load_source', [
  'load_board',
  'broker_email',
  'manual',
  'csv_import',
  'api',
]);

export const stopTypeEnum = pgEnum('stop_type', ['pickup', 'delivery']);

// --- documents -------------------------------------------------------------

export const documentStatusEnum = pgEnum('document_status', [
  'received',
  'classifying',
  'extracting',
  'extracted',
  'validated',
  'rejected', // failed validation against the load record
  'quarantined', // failed a virus or content check
]);

export const documentSourceEnum = pgEnum('document_source', [
  'email_intake',
  'upload',
  'driver_app',
  'api',
  'generated', // HaulQ produced it, e.g. an invoice
]);

// --- audit -----------------------------------------------------------------

/**
 * Who acted. `agent` is deliberately distinct from `system`: guardrail 5 forbids
 * binding AI commitments, and that rule is unenforceable if a model's action is
 * indistinguishable from a cron job's in the log.
 */
export const actorTypeEnum = pgEnum('actor_type', [
  'user',
  'system',
  'agent',
  'integration',
]);

// --- imports ---------------------------------------------------------------

export const importStatusEnum = pgEnum('import_status', [
  'uploaded',
  'mapping', // waiting on the operator to map columns
  'validating',
  'ready',
  'committing',
  'committed',
  'failed',
]);

export const importRowStatusEnum = pgEnum('import_row_status', [
  'pending',
  'valid',
  'invalid',
  'committed',
  'skipped',
]);
