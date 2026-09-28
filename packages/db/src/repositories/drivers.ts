/**
 * Drivers.
 *
 * Separate from `users` because most drivers at a small carrier never log in,
 * and a load still has to be assigned to them. `userId` is the optional link for
 * the ones who do.
 */

import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { drivers } from '../schema/fleet.ts';
import { loads } from '../schema/loads.ts';
import { withTransaction } from '../transaction.ts';

export type Driver = typeof drivers.$inferSelect;

export interface CreateDriverInput {
  fullName: string;
  phone?: string | undefined;
  email?: string | undefined;
  cdlNumber?: string | undefined;
  cdlState?: string | undefined;
  cdlExpiresAt?: string | undefined;
  medicalCardExpiresAt?: string | undefined;
  /** Matched against requirements extracted from broker comments. */
  endorsements?: string[] | undefined;
  defaultTruckId?: string | undefined;
}

export interface ListDriversQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/**
 * The caller's own roster row in this org.
 *
 * For a `driver`-role request scoping its own reads (`GET /v1/loads` and
 * friends) — undefined means this login is not linked to any `drivers` row
 * yet (see `orgInvitations.driverId`/`acceptInvitation` in `members.ts`),
 * which the route treats as "sees nothing" rather than an error.
 */
export async function driverIdForUser(s: Scope, userId: string): Promise<string | undefined> {
  const [row] = await s.db
    .select({ id: drivers.id })
    .from(drivers)
    .where(
      and(eq(drivers.orgId, s.ctx.orgId), eq(drivers.userId, userId), isNull(drivers.deletedAt)),
    );
  return row?.id;
}

/** Alphabetical, cursor-paginated on `(fullName, id)` — see `pagination.ts`. */
export async function listDrivers(s: Scope, q: ListDriversQuery = {}): Promise<CursorPage<Driver>> {
  const conditions = [eq(drivers.orgId, s.ctx.orgId), isNull(drivers.deletedAt)];
  if (q.cursor) {
    const cursor = decodeCursor(q.cursor);
    const cursorName = String(cursor.v);
    conditions.push(
      or(gt(drivers.fullName, cursorName), and(eq(drivers.fullName, cursorName), gt(drivers.id, cursor.id)))!,
    );
  }

  const limit = Math.min(q.limit ?? 50, 200);
  const rows = await s.db
    .select()
    .from(drivers)
    .where(and(...conditions))
    .orderBy(asc(drivers.fullName), asc(drivers.id))
    .limit(limit);

  return toCursorPage(rows, limit, (row) => ({ v: row.fullName, id: row.id }));
}

/** Every driver, not one page — for internal sweeps like `expiringCredentials` below. */
async function listAllDrivers(s: Scope): Promise<Driver[]> {
  const all: Driver[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await listDrivers(s, cursor ? { cursor } : {});
    all.push(...page.items);
    if (!page.nextCursor) return all;
    cursor = page.nextCursor;
  }
}

export async function createDriver(
  s: Scope,
  input: CreateDriverInput,
): Promise<Driver> {
  return withTransaction(s, async (tx) => {
    const [row] = await tx.db
      .insert(drivers)
      .values({
        orgId: tx.ctx.orgId,
        fullName: input.fullName,
        phone: input.phone ?? null,
        email: input.email ?? null,
        cdlNumber: input.cdlNumber ?? null,
        cdlState: input.cdlState ?? null,
        cdlExpiresAt: input.cdlExpiresAt ? new Date(input.cdlExpiresAt) : null,
        medicalCardExpiresAt: input.medicalCardExpiresAt
          ? new Date(input.medicalCardExpiresAt)
          : null,
        endorsements: input.endorsements ?? [],
        defaultTruckId: input.defaultTruckId ?? null,
      })
      .returning();

    if (!row) throw new Error('driver insert returned nothing');

    await recordEvent(tx, 'driver.added', {
      subjectId: row.id,
      payload: { name: row.fullName },
    });

    return row;
  });
}

/**
 * Credentials expiring within `days`.
 *
 * Not a notification feature yet — it backs the onboarding checklist and, later,
 * the thing that stops a load being assigned to a driver whose medical card
 * lapsed last week. Both dates are checked because either one expiring puts the
 * driver out of service, and a carrier tracking them on a wall calendar is the
 * situation HaulQ is meant to replace.
 */
export async function expiringCredentials(
  s: Scope,
  days = 30,
): Promise<Array<{ driver: Driver; what: 'cdl' | 'medical_card'; expiresAt: Date }>> {
  const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const rows = await listAllDrivers(s);
  const out: Array<{ driver: Driver; what: 'cdl' | 'medical_card'; expiresAt: Date }> = [];

  for (const driver of rows) {
    if (driver.cdlExpiresAt && driver.cdlExpiresAt <= cutoff) {
      out.push({ driver, what: 'cdl', expiresAt: driver.cdlExpiresAt });
    }
    if (driver.medicalCardExpiresAt && driver.medicalCardExpiresAt <= cutoff) {
      out.push({
        driver,
        what: 'medical_card',
        expiresAt: driver.medicalCardExpiresAt,
      });
    }
  }

  return out.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

/**
 * Raised for a rule this file enforces. Same contract as `TruckError`:
 * `message` is for the log, `explanation` is the sentence a carrier reads.
 */
export class DriverError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.explanation = explanation;
  }
}

export interface UpdateDriverInput {
  fullName?: string | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  cdlNumber?: string | null | undefined;
  cdlState?: string | null | undefined;
  cdlExpiresAt?: string | null | undefined;
  medicalCardExpiresAt?: string | null | undefined;
  endorsements?: string[] | undefined;
  defaultTruckId?: string | null | undefined;
}

async function getDriver(s: Scope, id: string): Promise<Driver | undefined> {
  const [row] = await s.db
    .select()
    .from(drivers)
    .where(and(eq(drivers.id, id), eq(drivers.orgId, s.ctx.orgId), isNull(drivers.deletedAt)));
  return row;
}

const notFound = (id: string) =>
  new DriverError('not_found', `driver ${id} not found`, 'That driver is not on this account.');

const sameInstant = (a: Date | null, b: string | null) =>
  (a === null && b === null) || (a !== null && b !== null && a.getTime() === new Date(b).getTime());

/**
 * A partial update, recorded as one `driver.updated` naming what changed.
 * A re-submitted form with no edits writes and records nothing, the same as
 * `updateTruck`.
 */
export async function updateDriver(s: Scope, id: string, input: UpdateDriverInput): Promise<Driver> {
  return withTransaction(s, async (tx) => {
    const current = await getDriver(tx, id);
    if (!current) throw notFound(id);

    const fields: string[] = [];
    const patch: Partial<typeof drivers.$inferInsert> = { updatedAt: new Date() };

    const text = <K extends 'fullName' | 'phone' | 'email' | 'cdlNumber' | 'cdlState' | 'defaultTruckId'>(
      key: K,
      label: string,
    ) => {
      const next = input[key];
      if (next === undefined || next === current[key]) return;
      (patch as Record<string, unknown>)[key] = next;
      fields.push(label);
    };
    text('fullName', 'name');
    text('phone', 'phone');
    text('email', 'email');
    text('cdlNumber', 'CDL number');
    text('cdlState', 'CDL state');
    text('defaultTruckId', 'usual truck');

    if (input.cdlExpiresAt !== undefined && !sameInstant(current.cdlExpiresAt, input.cdlExpiresAt)) {
      patch.cdlExpiresAt = input.cdlExpiresAt ? new Date(input.cdlExpiresAt) : null;
      fields.push('CDL expiry');
    }
    if (
      input.medicalCardExpiresAt !== undefined &&
      !sameInstant(current.medicalCardExpiresAt, input.medicalCardExpiresAt)
    ) {
      patch.medicalCardExpiresAt = input.medicalCardExpiresAt ? new Date(input.medicalCardExpiresAt) : null;
      fields.push('medical card expiry');
    }
    if (input.endorsements !== undefined) {
      const before = [...current.endorsements].sort().join(',');
      const after = [...input.endorsements].sort().join(',');
      if (before !== after) {
        patch.endorsements = input.endorsements;
        fields.push('endorsements');
      }
    }

    if (fields.length === 0) return current;

    const [row] = await tx.db
      .update(drivers)
      .set(patch)
      .where(and(eq(drivers.id, id), eq(drivers.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new Error('driver update returned nothing');

    await recordEvent(tx, 'driver.updated', { subjectId: id, payload: { name: row.fullName, fields } });
    return row;
  });
}

/** Load statuses where a driver is still needed on the load. */
const ACTIVE_LOAD_STATUSES = ['booked', 'dispatched', 'in_transit'] as const;

/**
 * Take a driver off the roster: a soft delete, so past loads keep the name
 * they were run under. Refused while the driver is on a booked, dispatched
 * or in-transit load, because that load would be left with a driver nobody
 * can see or reassign from.
 */
export async function removeDriver(s: Scope, id: string): Promise<void> {
  await withTransaction(s, async (tx) => {
    const current = await getDriver(tx, id);
    if (!current) throw notFound(id);

    const [busy] = await tx.db
      .select({ reference: loads.reference })
      .from(loads)
      .where(
        and(
          eq(loads.orgId, tx.ctx.orgId),
          eq(loads.driverId, id),
          inArray(loads.status, [...ACTIVE_LOAD_STATUSES]),
        ),
      )
      .limit(1);
    if (busy) {
      throw new DriverError(
        'on_active_load',
        `driver ${id} is on active load ${busy.reference}`,
        `${current.fullName} is on load ${busy.reference}. Reassign that load first.`,
      );
    }

    await tx.db
      .update(drivers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(drivers.id, id), eq(drivers.orgId, tx.ctx.orgId)));

    await recordEvent(tx, 'driver.removed', { subjectId: id, payload: { name: current.fullName } });
  });
}

/**
 * The login a roster row is linked to, or undefined for a driver who doesn't
 * use the app. For a push to that driver: a roster row can't receive one,
 * only a person can.
 */
export async function driverUserId(s: Scope, driverId: string): Promise<string | undefined> {
  const [row] = await s.db
    .select({ userId: drivers.userId })
    .from(drivers)
    .where(and(eq(drivers.id, driverId), eq(drivers.orgId, s.ctx.orgId), isNull(drivers.deletedAt)));
  return row?.userId ?? undefined;
}
