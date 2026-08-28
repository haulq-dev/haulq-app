/**
 * Drivers.
 *
 * Separate from `users` because most drivers at a small carrier never log in,
 * and a load still has to be assigned to them. `userId` is the optional link for
 * the ones who do.
 */

import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { decodeCursor, toCursorPage, type CursorPage } from '../pagination.ts';
import { drivers } from '../schema/fleet.ts';
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
