/**
 * Verify — Phase 0b.
 *
 * The repository half of `broker_verifications`: one row per check, the
 * broker's `latestVerificationId` pointer kept current, and the event
 * `brokers.ts`'s header always promised. Never overwrites a past check —
 * "change history" is the whole point of a table rather than a column on
 * `brokers` itself.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.ts';
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
 * Insert a check and point the broker at it. Two writes, one transaction —
 * they must not be observed apart, or a reader could see a broker pointing
 * at a verification row that does not exist yet, or (worse, after a retry)
 * one that is not actually the latest.
 *
 * Shared by `recordVerification` (the on-demand path — always logs a
 * timeline entry) and `recordScheduledVerification` (the nightly re-check —
 * logs one only when the status actually changed) below. Deliberately just
 * the write, with no event of its own: the two callers disagree about when
 * an event is worth recording, and that decision belongs to them, not here.
 */
async function writeVerification(
  tx: Scope,
  brokerId: string,
  input: {
    source: string;
    operatingStatus: string | null;
    legalName?: string | null | undefined;
    dbaName?: string | null | undefined;
    raw: unknown;
  },
): Promise<BrokerVerification> {
  const [row] = await tx.db
    .insert(brokerVerifications)
    .values({
      orgId: tx.ctx.orgId,
      brokerId,
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
    .where(and(eq(brokers.id, brokerId), eq(brokers.orgId, tx.ctx.orgId)));

  return row;
}

/**
 * Store a verification result and point the broker at it.
 *
 * The on-demand path — a person clicked "verify." Always logs `broker.verified`
 * regardless of what it found, because a deliberate check a carrier asked for
 * is worth a timeline entry whether or not anything changed. See
 * `recordScheduledVerification` for the nightly re-check, which disagrees on
 * purpose.
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

    const row = await writeVerification(tx, input.brokerId, input);

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

export interface RecordScheduledVerificationInput {
  orgId: string;
  brokerId: string;
  /** Already known to the caller — `findBrokersDueForRecheck` reads it off the broker row it just swept. */
  brokerName: string;
  source: string;
  operatingStatus: string | null;
  legalName?: string | null | undefined;
  dbaName?: string | null | undefined;
  raw: unknown;
  /** What the broker's last check said, so this can tell whether anything actually changed. */
  previousOperatingStatus: string | null;
}

export interface RecordScheduledVerificationResult {
  verification: BrokerVerification;
  /** Whether `broker.verification_changed` fired. */
  changed: boolean;
}

/**
 * Store a nightly re-check's result — and say something only when it
 * disagrees with the last one.
 *
 * A separate function from `recordVerification` rather than a `silent?`
 * flag on it, the same "two functions on purpose" precedent
 * `documents.ts`'s `recordExtraction`/`recordManualFields` already set in
 * this codebase: the on-demand path's "always log a timeline entry"
 * behaviour is shipped and must not change underneath it. The append-only
 * history row is written either way — that is what the table is for — but
 * `broker.verification_changed` fires only when `previousOperatingStatus`
 * is a real prior status and it differs from this check's. A nightly sweep
 * quietly confirming "still fine" for every broker on file would be exactly
 * the noise guardrail 6 exists to prevent, the same reasoning
 * `recordClassification`'s "no event" and `updateCarrierProfile`'s "only
 * fields that changed" already apply elsewhere.
 *
 * Takes a bare `Database` rather than a `Scope` — this runs from a
 * cross-org sweep with no tenant request behind it, the same reason
 * `raiseExceptionAlert` in `repositories/track.ts` builds its own system
 * `Scope` inline rather than being handed one.
 */
export async function recordScheduledVerification(
  db: Database,
  input: RecordScheduledVerificationInput,
): Promise<RecordScheduledVerificationResult> {
  const s: Scope = {
    ctx: {
      orgId: input.orgId,
      actor: { type: 'system', name: 'verify-recheck' },
      correlationId: randomUUID(),
    },
    db,
  };

  return withTransaction(s, async (tx) => {
    const row = await writeVerification(tx, input.brokerId, input);

    const changed =
      input.previousOperatingStatus != null && input.previousOperatingStatus !== input.operatingStatus;

    if (changed) {
      await recordEvent(tx, 'broker.verification_changed', {
        subjectId: input.brokerId,
        payload: {
          brokerName: input.brokerName,
          previousStatus: input.previousOperatingStatus,
          newStatus: input.operatingStatus,
          source: input.source,
        },
      });
    }

    return { verification: row, changed };
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
