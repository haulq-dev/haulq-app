/**
 * Drivers.
 *
 * Separate from `users` because most drivers at a small carrier never log in,
 * and a load still has to be assigned to them. `userId` is the optional link for
 * the ones who do.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
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

export async function listDrivers(s: Scope): Promise<Driver[]> {
  return s.db
    .select()
    .from(drivers)
    .where(and(eq(drivers.orgId, s.ctx.orgId), isNull(drivers.deletedAt)))
    .orderBy(asc(drivers.fullName));
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
  const rows = await listDrivers(s);
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
