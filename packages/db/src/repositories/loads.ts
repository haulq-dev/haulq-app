/**
 * Load reads and writes.
 *
 * The load object is one of the two things build plan section 13 names as
 * un-retrofittable, and its rules are split across three places on purpose:
 *
 *  - **The database owns the state machine.** `sql/post/0300_load_status.sql`
 *    forbids moving backwards and reopening a cancellation, and checks that a
 *    status has the timestamp it implies. Docs, Pay, Dispatch and the driver
 *    app all write `status`; a rule in one service's code is a rule the other
 *    three break.
 *  - **The database owns the reference.** `sql/post/0100_load_reference.sql`
 *    assigns the per-org sequential number by trigger, taking a row lock so two
 *    concurrent inserts cannot receive the same one. Nothing here computes it.
 *  - **This file owns the timestamps and the events**, because those are the
 *    part the database cannot infer. A trigger can reject a `booked` load with
 *    no `booked_at`; only the caller knows when it was booked.
 *
 * So the functions below set the timestamp a transition implies *before*
 * handing the row to Postgres. Leaving it to the caller means the check
 * constraint fires and the carrier reads a constraint name.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { brokerMatchKey } from '@haulq/contracts';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { brokers } from '../schema/brokers.ts';
import { drivers, trucks } from '../schema/fleet.ts';
import { loads, loadStops } from '../schema/loads.ts';
import { withTransaction } from '../transaction.ts';
import { getLatestVerification } from './verify.ts';

export type Load = typeof loads.$inferSelect;
export type LoadStop = typeof loadStops.$inferSelect;
export type LoadStatus = Load['status'];
export type LoadSource = Load['source'];

export interface LoadWithStops extends Load {
  stops: LoadStop[];
  brokerName: string | null;
  /** Null means the broker has no override — see `repositories/track.ts`'s `DEFAULT_DETENTION_FREE_MINUTES`. */
  brokerDetentionFreeMinutes: number | null;
  truckLabel: string | null;
  driverName: string | null;
}

/**
 * Raised for a rule this file enforces rather than the database.
 *
 * Carries the sentence a carrier should read, same contract as `MemberError`.
 * Constraint violations that come back from Postgres are translated in the
 * route, not here — see `apps/api/src/routes/loads.ts`.
 */
export class LoadError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'LoadError';
    this.code = code;
    this.explanation = explanation;
  }
}

export interface StopInput {
  type: 'pickup' | 'delivery';
  city: string;
  state: string;
  facilityName?: string | undefined;
  addressLine1?: string | undefined;
  postalCode?: string | undefined;
  /**
   * Optional today because nothing geocodes an address yet — a caller who
   * already has coordinates (a future geocoding step, a carrier pasting
   * them, a board that reports them) can pass them straight through. Track's
   * ETA (`repositories/track.ts`'s `previewTracking`) is null for any stop
   * without them, which is the honest answer until geocoding exists.
   */
  lat?: number | undefined;
  lng?: number | undefined;
  windowStart?: string | undefined;
  windowEnd?: string | undefined;
  appointmentRequired?: boolean | undefined;
  appointmentNumber?: string | undefined;
  referenceNumber?: string | undefined;
  instructions?: string | undefined;
}

export interface CreateLoadInput {
  source?: LoadSource | undefined;
  status?: LoadStatus | undefined;
  brokerName?: string | undefined;
  brokerLoadNumber?: string | undefined;
  equipment?: Load['equipment'] | undefined;
  commodity?: string | undefined;
  weightLbs?: number | undefined;
  pieceCount?: number | undefined;
  fullLoad?: boolean | undefined;
  hazmat?: boolean | undefined;
  comments?: string | undefined;
  rate?: { amount: number; currency: string } | undefined;
  rateIsLinehaul?: boolean | undefined;
  expectedDeadheadMiles?: number | undefined;
  expectedLoadedMiles?: number | undefined;
  truckId?: string | undefined;
  driverId?: string | undefined;
  stops: StopInput[];
}

const ORDINAL: Record<LoadStatus, number> = {
  prospect: 10,
  quoted: 20,
  booked: 30,
  dispatched: 40,
  in_transit: 50,
  delivered: 60,
  invoiced: 70,
  paid: 80,
  cancelled: 90,
};

/** The first pickup and the last delivery, for the sentences events produce. */
function endpoints(stops: StopInput[] | LoadStop[]): {
  origin: string;
  destination: string;
} {
  const place = (s: { city: string; state: string }) => `${s.city}, ${s.state}`;
  const pickup = stops.find((s) => s.type === 'pickup');
  const delivery = [...stops].reverse().find((s) => s.type === 'delivery');
  return {
    origin: pickup ? place(pickup) : 'unknown',
    destination: delivery ? place(delivery) : 'unknown',
  };
}

/**
 * Find or create the broker, matched on a normalized key.
 *
 * Reuses `brokerMatchKey` from contracts rather than matching on the raw name,
 * so "Acme Logistics", "ACME LOGISTICS, INC." and "Acme Logistics LLC" are one
 * broker. The CSV importer already does this; a load created by hand has to
 * agree with it or broker profitability splits three ways.
 */
async function resolveBroker(
  tx: Scope,
  name: string | undefined,
): Promise<{ id: string | null; name: string | null; detentionFreeMinutes: number | null }> {
  if (!name?.trim()) return { id: null, name: null, detentionFreeMinutes: null };

  const key = brokerMatchKey(name);
  const existing = await tx.db
    .select({ id: brokers.id, name: brokers.name, detentionFreeMinutes: brokers.detentionFreeMinutes })
    .from(brokers)
    .where(and(eq(brokers.orgId, tx.ctx.orgId), isNull(brokers.deletedAt)));

  const match = existing.find((b) => brokerMatchKey(b.name) === key);
  if (match) return match;

  const [created] = await tx.db
    .insert(brokers)
    .values({ orgId: tx.ctx.orgId, name: name.trim() })
    .returning({ id: brokers.id, name: brokers.name, detentionFreeMinutes: brokers.detentionFreeMinutes });

  return created!;
}

/**
 * Phase 0b-ii. FMCSA's authority check is automatic and advisory only — a
 * load can still be booked with a broker FMCSA currently shows as "Not
 * authorized"; this only makes sure the carrier is told, on the timeline,
 * the same place every other Phase 0b warning surfaces. No verification on
 * record at all is not a warning — same "don't warn on absence" reasoning
 * `findBrokersDueForRecheck` (repositories/brokers.ts) already applies: a
 * broker nobody has checked gives no baseline to warn from. Only a
 * confirmed "Not authorized" does; "Unknown" is not a confirmed negative
 * either.
 */
async function warnIfAuthorityLapsed(
  tx: Scope,
  args: { loadId: string; reference: number; brokerId: string | null; brokerName: string | null },
): Promise<void> {
  if (!args.brokerId) return;

  const verification = await getLatestVerification(tx, args.brokerId);
  if (verification?.operatingStatus !== 'Not authorized') return;

  await recordEvent(tx, 'load.booked_with_authority_warning', {
    subjectId: args.loadId,
    payload: {
      reference: args.reference,
      brokerName: args.brokerName ?? 'an unnamed broker',
      source: verification.source,
    },
  });
}

export async function createLoad(
  s: Scope,
  input: CreateLoadInput,
): Promise<LoadWithStops> {
  return withTransaction(s, async (tx) => {
    const status = input.status ?? 'prospect';
    const source = input.source ?? 'manual';
    const now = new Date();

    const broker = await resolveBroker(tx, input.brokerName);

    // A load created directly at a later status still needs the timestamps
    // that status implies, or the check constraints reject it. Backfilled to
    // "now" because that is the only honest answer available at creation.
    //
    // `dispatchedAt` has no check constraint behind it — nothing here would
    // reject its absence — but Track's exception scan
    // (`repositories/track.ts`'s `findExceptionCandidates`) uses it as the
    // baseline "last activity" for a load that has reported nothing yet, and
    // a load created straight into `in_transit` with no baseline can never
    // become an exception candidate. Stamped for the same reason the others
    // are, just not enforced by the same mechanism.
    const stamps = {
      ...(ORDINAL[status] >= ORDINAL.booked && status !== 'cancelled'
        ? { bookedAt: now }
        : {}),
      ...(ORDINAL[status] >= ORDINAL.dispatched && status !== 'cancelled'
        ? { dispatchedAt: now }
        : {}),
      ...(ORDINAL[status] >= ORDINAL.delivered && status !== 'cancelled'
        ? { deliveredAt: now }
        : {}),
      ...(status === 'cancelled' ? { cancelledAt: now } : {}),
    };

    const [row] = await tx.db
      .insert(loads)
      .values({
        orgId: tx.ctx.orgId,
        // `reference` deliberately omitted: the column defaults to 0, and the
        // trigger reads 0 as "assign me one".
        status,
        source,
        brokerId: broker.id,
        ...(input.brokerLoadNumber ? { brokerLoadNumber: input.brokerLoadNumber } : {}),
        equipment: input.equipment ?? 'STRAIGHT_BOX',
        ...(input.commodity ? { commodity: input.commodity } : {}),
        weightLbs: input.weightLbs ?? null,
        pieceCount: input.pieceCount ?? null,
        fullLoad: input.fullLoad ?? true,
        hazmat: input.hazmat ?? false,
        ...(input.comments ? { comments: input.comments } : {}),
        rateAmount: input.rate?.amount ?? null,
        rateCurrency: input.rate?.currency ?? 'USD',
        rateIsLinehaul: input.rateIsLinehaul ?? false,
        expectedDeadheadMiles: input.expectedDeadheadMiles ?? null,
        expectedLoadedMiles: input.expectedLoadedMiles ?? null,
        truckId: input.truckId ?? null,
        driverId: input.driverId ?? null,
        ...stamps,
      })
      .returning();

    if (!row) throw new Error('load insert returned nothing');

    const stopRows = await tx.db
      .insert(loadStops)
      .values(
        input.stops.map((stop, i) => ({
          orgId: tx.ctx.orgId,
          loadId: row.id,
          // `seq` is order of service, not order of entry — but at creation the
          // two are the same, and Routes is what will reorder them later.
          seq: i + 1,
          type: stop.type,
          city: stop.city,
          state: stop.state,
          facilityName: stop.facilityName ?? null,
          addressLine1: stop.addressLine1 ?? null,
          postalCode: stop.postalCode ?? null,
          lat: stop.lat ?? null,
          lng: stop.lng ?? null,
          windowStart: stop.windowStart ? new Date(stop.windowStart) : null,
          windowEnd: stop.windowEnd ? new Date(stop.windowEnd) : null,
          appointmentRequired: stop.appointmentRequired ?? false,
          appointmentNumber: stop.appointmentNumber ?? null,
          referenceNumber: stop.referenceNumber ?? null,
          instructions: stop.instructions ?? null,
        })),
      )
      .returning();

    const { origin, destination } = endpoints(input.stops);

    await recordEvent(tx, 'load.created', {
      subjectId: row.id,
      payload: { reference: row.reference, origin, destination, source },
    });

    /**
     * Created straight into `booked` — a carrier entering a load they have
     * already taken. The booking deserves its own line: it is the commitment,
     * and `load.created` only records the row appearing.
     *
     * Not for imported history. A CSV replay is not a booking that happened
     * just now, and manufacturing one produces lines like "Booked load 3 with
     * an unnamed broker at $0.00" for a load delivered two months ago — which
     * is both untrue and unremovable, since `event_log` is append-only. The
     * import has its own event; that is the one that is accurate.
     */
    if (
      ORDINAL[status] >= ORDINAL.booked &&
      status !== 'cancelled' &&
      source !== 'csv_import'
    ) {
      await recordEvent(tx, 'load.booked', {
        subjectId: row.id,
        payload: {
          reference: row.reference,
          brokerName: broker.name ?? 'an unnamed broker',
          rateAmount: row.rateAmount ?? 0,
          rateCurrency: row.rateCurrency ?? 'USD',
        },
      });
      await warnIfAuthorityLapsed(tx, {
        loadId: row.id,
        reference: row.reference,
        brokerId: broker.id,
        brokerName: broker.name,
      });
    }

    return {
      ...row,
      stops: stopRows,
      brokerName: broker.name,
      brokerDetentionFreeMinutes: broker.detentionFreeMinutes,
      truckLabel: null,
      driverName: null,
    };
  });
}

export interface ListLoadsQuery {
  status?: LoadStatus[] | undefined;
  truckId?: string | undefined;
  limit?: number | undefined;
  /** Opaque, from a previous call's `nextCursor`. Omit for the first page. */
  cursor?: string | undefined;
}

/**
 * Newest first, with the names a list needs already joined.
 *
 * Joined rather than fetched per row: a list of forty loads that looks up its
 * broker, truck and driver separately is a hundred and twenty extra queries,
 * and the screen is the one a dispatcher leaves open all day.
 *
 * Cursor-paginated on `(createdAt, id)` both descending — `id` is not a
 * meaningful order by itself, only a stable tiebreaker so two loads created
 * in the same millisecond do not get skipped or duplicated across pages.
 * See `pagination.ts` for why only the cursor's encode/decode is shared and
 * this `WHERE`/`orderBy` stays hand-written.
 */
export async function listLoads(s: Scope, q: ListLoadsQuery = {}): Promise<CursorPage<LoadWithStops>> {
  const conditions = [eq(loads.orgId, s.ctx.orgId), isNull(loads.deletedAt)];
  if (q.status?.length) conditions.push(inArray(loads.status, q.status));
  if (q.truckId) conditions.push(eq(loads.truckId, q.truckId));
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorDate = new Date(cursor.v);
    conditions.push(
      or(
        lt(loads.createdAt, cursorDate),
        and(eq(loads.createdAt, cursorDate), lt(loads.id, cursor.id)),
      )!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select({
      load: loads,
      brokerName: brokers.name,
      brokerDetentionFreeMinutes: brokers.detentionFreeMinutes,
      truckLabel: trucks.label,
      driverName: drivers.fullName,
    })
    .from(loads)
    .leftJoin(brokers, eq(brokers.id, loads.brokerId))
    .leftJoin(trucks, eq(trucks.id, loads.truckId))
    .leftJoin(drivers, eq(drivers.id, loads.driverId))
    .where(and(...conditions))
    .orderBy(desc(loads.createdAt), desc(loads.id))
    .limit(limit);

  if (rows.length === 0) return { items: [], nextCursor: null };

  const stops = await s.db
    .select()
    .from(loadStops)
    .where(
      inArray(
        loadStops.loadId,
        rows.map((r) => r.load.id),
      ),
    )
    .orderBy(asc(loadStops.seq));

  const byLoad = new Map<string, LoadStop[]>();
  for (const stop of stops) {
    const list = byLoad.get(stop.loadId) ?? [];
    list.push(stop);
    byLoad.set(stop.loadId, list);
  }

  const items = rows.map((r) => ({
    ...r.load,
    stops: byLoad.get(r.load.id) ?? [],
    brokerName: r.brokerName,
    brokerDetentionFreeMinutes: r.brokerDetentionFreeMinutes,
    truckLabel: r.truckLabel,
    driverName: r.driverName,
  }));

  return toCursorPage(items, limit, (item) => ({ v: item.createdAt.toISOString(), id: item.id }));
}

export async function getLoad(s: Scope, id: string): Promise<LoadWithStops | undefined> {
  const [row] = await s.db
    .select({
      load: loads,
      brokerName: brokers.name,
      brokerDetentionFreeMinutes: brokers.detentionFreeMinutes,
      truckLabel: trucks.label,
      driverName: drivers.fullName,
    })
    .from(loads)
    .leftJoin(brokers, eq(brokers.id, loads.brokerId))
    .leftJoin(trucks, eq(trucks.id, loads.truckId))
    .leftJoin(drivers, eq(drivers.id, loads.driverId))
    // org_id in the predicate, not just the id. A uuid is unguessable, which is
    // not the same as being an authorization check.
    .where(and(eq(loads.id, id), eq(loads.orgId, s.ctx.orgId)));

  if (!row) return undefined;

  const stops = await s.db
    .select()
    .from(loadStops)
    .where(eq(loadStops.loadId, id))
    .orderBy(asc(loadStops.seq));

  return {
    ...row.load,
    stops,
    brokerName: row.brokerName,
    brokerDetentionFreeMinutes: row.brokerDetentionFreeMinutes,
    truckLabel: row.truckLabel,
    driverName: row.driverName,
  };
}

export interface UpdateStatusInput {
  status: LoadStatus;
  reason?: string | undefined;
  /** Backdating, for a delivery recorded the next morning. */
  occurredAt?: string | undefined;
}

/**
 * Move a load along.
 *
 * The illegal transitions are rejected by the trigger, not here — duplicating
 * that logic would give two answers to maintain. What this does is the part the
 * database cannot: fill in the timestamp the new status implies, so the check
 * constraint is satisfied rather than tripped.
 */
export async function updateLoadStatus(
  s: Scope,
  id: string,
  input: UpdateStatusInput,
): Promise<LoadWithStops> {
  return withTransaction(s, async (tx) => {
    const current = await getLoad(tx, id);
    if (!current) {
      throw new LoadError('not_found', `load ${id} not found`, 'That load no longer exists.');
    }

    if (input.status === 'cancelled' && !input.reason?.trim()) {
      throw new LoadError(
        'reason_required',
        'cancellation without a reason',
        'Say why this load is being cancelled — the timeline records it.',
      );
    }

    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();

    // Only the timestamps this move reaches, and only the ones still empty. A
    // load that skipped `booked` on its way to `delivered` still needs
    // `booked_at`, or the constraint for the status it landed on fails.
    const stamps: Record<string, Date> = {};
    if (input.status === 'cancelled') {
      stamps['cancelledAt'] = at;
    } else {
      if (ORDINAL[input.status] >= ORDINAL.booked && !current.bookedAt) {
        stamps['bookedAt'] = at;
      }
      if (ORDINAL[input.status] >= ORDINAL.dispatched && !current.dispatchedAt) {
        stamps['dispatchedAt'] = at;
      }
      if (ORDINAL[input.status] >= ORDINAL.delivered && !current.deliveredAt) {
        stamps['deliveredAt'] = at;
      }
    }

    const [row] = await tx.db
      .update(loads)
      .set({
        status: input.status,
        ...stamps,
        ...(input.reason ? { cancelledReason: input.reason } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(loads.id, id), eq(loads.orgId, tx.ctx.orgId)))
      .returning();

    if (!row) throw new Error('load status update returned nothing');

    if (input.status === 'booked') {
      await recordEvent(tx, 'load.booked', {
        subjectId: row.id,
        payload: {
          reference: row.reference,
          brokerName: current.brokerName ?? 'an unnamed broker',
          rateAmount: row.rateAmount ?? 0,
          rateCurrency: row.rateCurrency ?? 'USD',
        },
      });
      await warnIfAuthorityLapsed(tx, {
        loadId: row.id,
        reference: row.reference,
        brokerId: current.brokerId,
        brokerName: current.brokerName,
      });
    } else if (input.status === 'delivered') {
      await recordEvent(tx, 'load.delivered', {
        subjectId: row.id,
        payload: {
          reference: row.reference,
          deliveredAt: (row.deliveredAt ?? at).toISOString(),
        },
      });
    } else if (input.status === 'cancelled') {
      await recordEvent(tx, 'load.cancelled', {
        subjectId: row.id,
        payload: { reference: row.reference, reason: input.reason ?? 'no reason given' },
      });
    } else {
      // Every other move still belongs in the timeline — guardrail 6 asks for
      // an audit trail, not a highlights reel. `load.status_changed` carries
      // the pair so the sentence reads without consulting the row.
      await recordEvent(tx, 'load.status_changed', {
        subjectId: row.id,
        payload: { reference: row.reference, from: current.status, to: row.status },
      });
    }

    return (await getLoad(tx, id))!;
  });
}

/** Put a load on a truck, or take it off one. */
export async function assignLoad(
  s: Scope,
  id: string,
  input: { truckId: string | null; driverId?: string | null | undefined },
): Promise<LoadWithStops> {
  return withTransaction(s, async (tx) => {
    const current = await getLoad(tx, id);
    if (!current) {
      throw new LoadError('not_found', `load ${id} not found`, 'That load no longer exists.');
    }

    let truckLabel: string | null = null;
    if (input.truckId) {
      const [truck] = await tx.db
        .select({ label: trucks.label })
        .from(trucks)
        .where(and(eq(trucks.id, input.truckId), eq(trucks.orgId, tx.ctx.orgId)));
      if (!truck) {
        throw new LoadError(
          'truck_not_found',
          `truck ${input.truckId} not in org`,
          'That truck is not on this account.',
        );
      }
      truckLabel = truck.label;
    }

    let driverName: string | null = null;
    if (input.driverId) {
      const [driver] = await tx.db
        .select({ fullName: drivers.fullName })
        .from(drivers)
        .where(and(eq(drivers.id, input.driverId), eq(drivers.orgId, tx.ctx.orgId)));
      if (!driver) {
        throw new LoadError(
          'driver_not_found',
          `driver ${input.driverId} not in org`,
          'That driver is not on this account.',
        );
      }
      driverName = driver.fullName;
    }

    await tx.db
      .update(loads)
      .set({
        truckId: input.truckId,
        ...(input.driverId !== undefined ? { driverId: input.driverId } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(loads.id, id), eq(loads.orgId, tx.ctx.orgId)));

    if (input.truckId) {
      await recordEvent(tx, 'load.assigned', {
        subjectId: id,
        payload: {
          reference: current.reference,
          truckLabel: truckLabel ?? 'a truck',
          ...(driverName ? { driverName } : {}),
        },
      });
    }

    return (await getLoad(tx, id))!;
  });
}

export interface UpdateLoadStopInput {
  lat?: number | null | undefined;
  lng?: number | null | undefined;
  windowStart?: string | null | undefined;
  windowEnd?: string | null | undefined;
}

/**
 * Correct a stop's coordinates or appointment window after the load already
 * exists — `CreateLoadSchema` only ever sets these at creation, and Routes'
 * 3a feasibility check (`apps/api/src/routes/feasibility.ts`) depends on
 * both, so a load created without them, or with a wrong one, had no way
 * back in until this. `load_stops_window_ordered` (`sql/post/0500_
 * constraints.sql`) still does the actual ordering enforcement, the same
 * way it already does for `createLoad` — this function does not duplicate
 * that check, it just gives Postgres a row to apply it to.
 */
export async function updateLoadStop(
  s: Scope,
  loadId: string,
  stopId: string,
  input: UpdateLoadStopInput,
): Promise<LoadWithStops> {
  return withTransaction(s, async (tx) => {
    const [load] = await tx.db
      .select({ reference: loads.reference })
      .from(loads)
      .where(and(eq(loads.id, loadId), eq(loads.orgId, tx.ctx.orgId)));
    if (!load) {
      throw new LoadError('not_found', `load ${loadId} not found`, 'That load no longer exists.');
    }

    const [stop] = await tx.db
      .select()
      .from(loadStops)
      .where(and(eq(loadStops.id, stopId), eq(loadStops.loadId, loadId)));
    if (!stop) {
      throw new LoadError('not_found', `stop ${stopId} not on load ${loadId}`, 'That stop is not on this load.');
    }

    // Names what changed for the event below, not the raw values — see the
    // catalogue entry's own note on why.
    const fields: string[] = [];
    const patch: Partial<typeof loadStops.$inferInsert> = { updatedAt: new Date() };

    if (input.lat !== undefined || input.lng !== undefined) {
      if (input.lat !== undefined) patch.lat = input.lat;
      if (input.lng !== undefined) patch.lng = input.lng;
      fields.push('coordinates');
    }
    if (input.windowStart !== undefined) {
      patch.windowStart = input.windowStart === null ? null : new Date(input.windowStart);
      fields.push('window start');
    }
    if (input.windowEnd !== undefined) {
      patch.windowEnd = input.windowEnd === null ? null : new Date(input.windowEnd);
      fields.push('window end');
    }

    await tx.db.update(loadStops).set(patch).where(eq(loadStops.id, stopId));

    await recordEvent(tx, 'load_stop.updated', {
      subjectId: loadId,
      payload: { reference: load.reference, stopSeq: stop.seq, city: stop.city, state: stop.state, fields },
    });

    return (await getLoad(tx, loadId))!;
  });
}

/**
 * What the list screen shows above the table.
 *
 * Counts by status in one grouped query rather than one per status. Cheap now;
 * the alternative becomes nine round trips on a screen that polls.
 */
export async function loadCounts(s: Scope): Promise<Record<string, number>> {
  const rows = await s.db
    .select({ status: loads.status, n: sql<number>`count(*)::int` })
    .from(loads)
    .where(and(eq(loads.orgId, s.ctx.orgId), isNull(loads.deletedAt)))
    .groupBy(loads.status);

  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
