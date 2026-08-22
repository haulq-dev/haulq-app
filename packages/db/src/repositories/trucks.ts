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

import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
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

export async function listTrucks(s: Scope): Promise<Truck[]> {
  return s.db
    .select()
    .from(trucks)
    .where(and(eq(trucks.orgId, s.ctx.orgId), isNull(trucks.deletedAt)))
    .orderBy(asc(trucks.label));
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
