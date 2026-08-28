/**
 * Truck reads and writes.
 *
 * Repositories exist for two reasons, and only the second one is interesting.
 *
 * The dull reason: `@haulq/db` is the only package that imports `drizzle-orm`.
 * The moment a second one does, the ORM is load-bearing in two places and
 * swapping it stops being a local change.
 *
 * The reason that matters: **the record and the event that describes it are
 * written by the same function, inside one transaction, and there is no way to
 * call one without the other.** Left to route handlers, the pairing is a
 * convention — the third person to add a write forgets the event, nobody
 * notices, and the audit trail has a hole in it that cannot be backfilled
 * because `event_log` is append-only.
 *
 * So a route's job is to validate input and call one of these. If a repository
 * function exists, using it is not optional.
 */

import { and, asc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { trucks } from '../schema/fleet.ts';
import { withTransaction } from '../transaction.ts';

export type Truck = typeof trucks.$inferSelect;

/**
 * The optional fields are written `?: T | undefined` rather than `?: T` because
 * the workspace runs with `exactOptionalPropertyTypes`. Zod's `.optional()`
 * produces `T | undefined`, and under that flag the two are not the same type.
 * Spelling it out here keeps the friction in one place instead of forcing every
 * caller to strip undefined before calling.
 */
export interface CreateTruckInput {
  label: string;
  equipment?: Truck['equipment'] | undefined;
  maxWeightLbs?: number | undefined;
  maxLengthFt?: number | undefined;
  boxHeightIn?: number | undefined;
  boxWidthIn?: number | undefined;
  /**
   * `{ liftgate: true, dockHigh: false, ... }`. Matched against load requirements.
   *
   * Values are `boolean | undefined`, and the distinction is real: absent means
   * the carrier has not said, false means they have said no. A load requiring a
   * liftgate should be blocked by the second and only flagged by the first.
   */
  capabilities?: Record<string, boolean | undefined> | undefined;
  shortHaulExempt?: boolean | undefined;
}

export interface ListTrucksQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * Alphabetical, cursor-paginated on `(label, id)` ascending — `id` only
 * breaks ties between two trucks sharing a label, which the schema allows.
 * See `pagination.ts` for the shared cursor shape.
 */
export async function listTrucks(s: Scope, q: ListTrucksQuery = {}): Promise<CursorPage<Truck>> {
  const conditions = [eq(trucks.orgId, s.ctx.orgId), isNull(trucks.deletedAt)];
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorLabel = String(cursor.v);
    conditions.push(
      or(gt(trucks.label, cursorLabel), and(eq(trucks.label, cursorLabel), gt(trucks.id, cursor.id)))!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(trucks)
    .where(and(...conditions))
    .orderBy(asc(trucks.label), asc(trucks.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.label, id: row.id }));
}

export async function getTruck(s: Scope, id: string): Promise<Truck | undefined> {
  const [row] = await s.db
    .select()
    .from(trucks)
    // org_id in the predicate, not just the id. A uuid is unguessable, which is
    // not the same as being an authorization check.
    .where(and(eq(trucks.id, id), eq(trucks.orgId, s.ctx.orgId)));
  return row;
}

/**
 * This org's trucks that have been matched to a Motive vehicle, keyed by
 * that vehicle id. Takes `db` directly rather than a `Scope` — called from
 * `integrations/motive-sync.ts`'s sweep across every org, one org at a
 * time, not from inside a single org's request.
 */
export async function trucksByMotiveVehicleId(db: Database, orgId: string): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: trucks.id, motiveVehicleId: trucks.motiveVehicleId })
    .from(trucks)
    .where(and(eq(trucks.orgId, orgId), isNotNull(trucks.motiveVehicleId)));
  return new Map(rows.map((r) => [r.motiveVehicleId!, r.id]));
}

export class TruckError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'TruckError';
    this.code = code;
    this.explanation = explanation;
  }
}

/**
 * Match this truck to a Motive vehicle, or clear the match.
 *
 * `null` clears it — a carrier disconnecting a truck from Motive (it was
 * sold, or mismatched) without having to know which vehicle id to type
 * over it. `trucks_org_motive_vehicle_key` is the enforcement against two
 * trucks claiming the same vehicle; this only translates that constraint
 * violation into a sentence a carrier can read.
 */
export async function setTruckMotiveVehicleId(
  s: Scope,
  id: string,
  motiveVehicleId: number | null,
): Promise<Truck> {
  return withTransaction(s, async (tx) => {
    const current = await getTruck(tx, id);
    if (!current) {
      throw new TruckError('not_found', `truck ${id} not found`, 'That truck is not on this account.');
    }

    let row: Truck | undefined;
    try {
      [row] = await tx.db
        .update(trucks)
        .set({ motiveVehicleId, updatedAt: new Date() })
        .where(and(eq(trucks.id, id), eq(trucks.orgId, tx.ctx.orgId)))
        .returning();
    } catch (err) {
      const pg = err as { code?: string; constraint_name?: string };
      if (pg.code === '23505' && pg.constraint_name === 'trucks_org_motive_vehicle_key') {
        throw new TruckError(
          'already_matched',
          `motive vehicle ${motiveVehicleId} already matched to another truck`,
          'Another truck is already matched to that Motive vehicle.',
        );
      }
      throw err;
    }
    if (!row) throw new Error('truck motive-vehicle update returned nothing');

    await recordEvent(tx, 'truck.motive_vehicle_matched', {
      subjectId: id,
      payload: { label: row.label, motiveVehicleId },
    });

    return row;
  });
}

export interface UpdateTruckInput {
  label?: string | undefined;
  equipment?: Truck['equipment'] | undefined;
  maxWeightLbs?: number | null | undefined;
  maxLengthFt?: number | null | undefined;
  boxHeightIn?: number | null | undefined;
  boxWidthIn?: number | null | undefined;
  capabilities?: Record<string, boolean | undefined> | undefined;
  shortHaulExempt?: boolean | undefined;
}

/**
 * A partial update. Up to two events, the same split `createTruck` already
 * makes on the way in: the ordinary fields get `truck.updated`,
 * capabilities get their own `truck.capabilities_updated` with a real
 * added/removed diff against what was there before — `createTruck` only
 * ever has an `added` list, since nothing existed yet to remove from.
 */
export async function updateTruck(s: Scope, id: string, input: UpdateTruckInput): Promise<Truck> {
  return withTransaction(s, async (tx) => {
    const current = await getTruck(tx, id);
    if (!current) {
      throw new TruckError('not_found', `truck ${id} not found`, 'That truck is not on this account.');
    }

    const fields: string[] = [];
    const patch: Partial<typeof trucks.$inferInsert> = { updatedAt: new Date() };

    if (input.label !== undefined && input.label !== current.label) {
      patch.label = input.label;
      fields.push('label');
    }
    if (input.equipment !== undefined && input.equipment !== current.equipment) {
      patch.equipment = input.equipment;
      fields.push('equipment');
    }
    if (input.maxWeightLbs !== undefined && input.maxWeightLbs !== current.maxWeightLbs) {
      patch.maxWeightLbs = input.maxWeightLbs;
      fields.push('max weight');
    }
    if (input.maxLengthFt !== undefined && input.maxLengthFt !== current.maxLengthFt) {
      patch.maxLengthFt = input.maxLengthFt;
      fields.push('max length');
    }
    if (input.boxHeightIn !== undefined && input.boxHeightIn !== current.boxHeightIn) {
      patch.boxHeightIn = input.boxHeightIn;
      fields.push('box height');
    }
    if (input.boxWidthIn !== undefined && input.boxWidthIn !== current.boxWidthIn) {
      patch.boxWidthIn = input.boxWidthIn;
      fields.push('box width');
    }
    if (input.shortHaulExempt !== undefined && input.shortHaulExempt !== current.shortHaulExempt) {
      patch.shortHaulExempt = input.shortHaulExempt;
      fields.push('short-haul exemption');
    }

    let added: string[] = [];
    let removed: string[] = [];
    if (input.capabilities !== undefined) {
      const before = (current.capabilities as Record<string, boolean | undefined>) ?? {};
      patch.capabilities = input.capabilities;
      added = Object.keys(input.capabilities).filter((k) => input.capabilities![k] === true && before[k] !== true);
      removed = Object.keys(before).filter((k) => before[k] === true && input.capabilities![k] !== true);
    }

    // Nothing actually changed — a re-submitted form with no edits. Not an
    // error, just nothing to write or record.
    if (fields.length === 0 && added.length === 0 && removed.length === 0) {
      return current;
    }

    const [row] = await tx.db
      .update(trucks)
      .set(patch)
      .where(and(eq(trucks.id, id), eq(trucks.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new Error('truck update returned nothing');

    if (fields.length) {
      await recordEvent(tx, 'truck.updated', { subjectId: id, payload: { label: row.label, fields } });
    }
    if (added.length || removed.length) {
      await recordEvent(tx, 'truck.capabilities_updated', {
        subjectId: id,
        payload: { label: row.label, added, removed },
      });
    }

    return row;
  });
}

/**
 * Take a truck out of service, or bring it back — never a real `DELETE`.
 * `contracts`' `SetTruckActiveSchema` has the reasoning: a truck stays
 * referenced by loads, drivers and telemetry for as long as it was ever
 * run, so "removing" one from the fleet means flipping `active`, not
 * erasing the row `_shared.ts`'s soft-delete rule exists for correcting
 * mistakes, not retiring equipment.
 */
export async function setTruckActive(
  s: Scope,
  id: string,
  active: boolean,
  reason?: string,
): Promise<Truck> {
  return withTransaction(s, async (tx) => {
    const current = await getTruck(tx, id);
    if (!current) {
      throw new TruckError('not_found', `truck ${id} not found`, 'That truck is not on this account.');
    }
    if (current.active === active) return current;

    const [row] = await tx.db
      .update(trucks)
      .set({ active, updatedAt: new Date() })
      .where(and(eq(trucks.id, id), eq(trucks.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new Error('truck active update returned nothing');

    if (active) {
      await recordEvent(tx, 'truck.reactivated', { subjectId: id, payload: { label: row.label } });
    } else {
      await recordEvent(tx, 'truck.deactivated', {
        subjectId: id,
        payload: { label: row.label, ...(reason ? { reason } : {}) },
      });
    }

    return row;
  });
}

export async function createTruck(
  s: Scope,
  input: CreateTruckInput,
): Promise<Truck> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .insert(trucks)
      .values({
        orgId: tx.ctx.orgId,
        label: input.label,
        equipment: input.equipment ?? 'STRAIGHT_BOX',
        maxWeightLbs: input.maxWeightLbs ?? null,
        maxLengthFt: input.maxLengthFt ?? null,
        boxHeightIn: input.boxHeightIn ?? null,
        boxWidthIn: input.boxWidthIn ?? null,
        capabilities: input.capabilities ?? {},
        shortHaulExempt: input.shortHaulExempt ?? false,
      })
      .returning();

    if (!row) throw new Error('truck insert returned nothing');

    await recordEvent(tx, 'truck.added', {
      subjectId: row.id,
      payload: { label: row.label, equipment: row.equipment },
    });

    // A second event, deliberately. Capabilities decide which loads are
    // visible, so a carrier asking "why am I not seeing liftgate loads" needs a
    // line to find — not a detail folded into `truck.added`.
    const enabled = Object.entries(input.capabilities ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name);

    if (enabled.length) {
      await recordEvent(tx, 'truck.capabilities_updated', {
        subjectId: row.id,
        payload: { label: row.label, added: enabled, removed: [] },
      });
    }

    return row;
  });
}
