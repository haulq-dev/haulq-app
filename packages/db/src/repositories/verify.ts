/**
 * Verify — Phase 0b.
 *
 * The repository half of `broker_verifications`: one row per check, the
 * broker's `latestVerificationId` pointer kept current, and the event
 * `brokers.ts`'s header always promised. Never overwrites a past check —
 * "change history" is the whole point of a table rather than a column on
 * `brokers` itself.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { BrokerError, getBroker } from './brokers.ts';
import { brokers } from '../schema/brokers.ts';
import { brokerVerifications } from '../schema/verify.ts';
import { withTransaction } from '../transaction.ts';

export type BrokerVerification = typeof brokerVerifications.$inferSelect;

export interface RecordVerificationInput {
  brokerId: string;
  source: string;
  operatingStatus: string | null;
  legalName?: string | null | undefined;
  dbaName?: string | null | undefined;
  raw: unknown;
}

/**
 * Store a verification result and point the broker at it.
 *
 * Two writes, one transaction — the insert and the pointer update must not
 * be observed apart, or a reader could see a broker pointing at a
 * verification row that does not exist yet, or (worse, after a retry) one
 * that is not actually the latest.
 */
export async function recordVerification(
  s: Scope,
  input: RecordVerificationInput,
): Promise<BrokerVerification> {
  return withTransaction(s, async (tx) => {
    const broker = await getBroker(tx, input.brokerId);
    if (!broker) {
      throw new BrokerError(
        'not_found',
        `broker ${input.brokerId} not found`,
        'That broker is not on this account.',
      );
    }

    const [row] = await tx.db
      .insert(brokerVerifications)
      .values({
        orgId: tx.ctx.orgId,
        brokerId: input.brokerId,
        source: input.source,
        operatingStatus: input.operatingStatus,
        legalName: input.legalName ?? null,
        dbaName: input.dbaName ?? null,
        raw: input.raw as object | null,
      })
      .returning();
    if (!row) throw new Error('broker verification insert returned nothing');

    await tx.db
      .update(brokers)
      .set({ latestVerificationId: row.id, updatedAt: new Date() })
      .where(and(eq(brokers.id, input.brokerId), eq(brokers.orgId, tx.ctx.orgId)));

    await recordEvent(tx, 'broker.verified', {
      subjectId: input.brokerId,
      payload: {
        brokerName: broker.name,
        operatingStatus: input.operatingStatus,
        source: input.source,
      },
    });

    return row;
  });
}

/** The most recent check, or undefined if this broker has never been verified. */
export async function getLatestVerification(
  s: Scope,
  brokerId: string,
): Promise<BrokerVerification | undefined> {
  const [row] = await s.db
    .select()
    .from(brokerVerifications)
    .where(and(eq(brokerVerifications.brokerId, brokerId), eq(brokerVerifications.orgId, s.ctx.orgId)))
    .orderBy(desc(brokerVerifications.checkedAt))
    .limit(1);
  return row;
}

/** Every check on record for this broker, newest first — the change history. */
export async function listVerifications(
  s: Scope,
  brokerId: string,
): Promise<BrokerVerification[]> {
  return s.db
    .select()
    .from(brokerVerifications)
    .where(and(eq(brokerVerifications.brokerId, brokerId), eq(brokerVerifications.orgId, s.ctx.orgId)))
    .orderBy(desc(brokerVerifications.checkedAt));
}
