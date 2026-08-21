/**
 * Brokers.
 *
 * Thin on purpose. Most of a broker row is written implicitly — `resolveBroker`
 * in `repositories/loads.ts` finds-or-creates one every time a load names a
 * counterparty — and nothing here duplicates that. What this file owns is the
 * one field a carrier sets deliberately rather than has inferred for them:
 * the per-broker detention free time PHASE_2_PLAN.md section 7 landed on.
 */

import { and, eq } from 'drizzle-orm';
import type { Scope } from '../context.ts';
import { recordEvent } from '../events/record.ts';
import { brokers } from '../schema/brokers.ts';
import { withTransaction } from '../transaction.ts';

export type Broker = typeof brokers.$inferSelect;

export class BrokerError extends Error {
  readonly code: string;
  readonly explanation: string;

  constructor(code: string, message: string, explanation: string) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
    this.explanation = explanation;
  }
}

export async function getBroker(s: Scope, id: string): Promise<Broker | undefined> {
  const [row] = await s.db
    .select()
    .from(brokers)
    .where(and(eq(brokers.id, id), eq(brokers.orgId, s.ctx.orgId)));
  return row;
}

/**
 * Set or clear a broker's detention free time.
 *
 * `null` clears it back to the default — see `repositories/track.ts`'s
 * `DEFAULT_DETENTION_FREE_MINUTES` — rather than requiring a carrier who
 * changes their mind to look up what the default even is.
 */
export async function updateBrokerDetentionThreshold(
  s: Scope,
  id: string,
  freeMinutes: number | null,
): Promise<Broker> {
  return withTransaction(s, async (tx) => {
    const current = await getBroker(tx, id);
    if (!current) {
      throw new BrokerError('not_found', `broker ${id} not found`, 'That broker is not on this account.');
    }

    const [row] = await tx.db
      .update(brokers)
      .set({ detentionFreeMinutes: freeMinutes, updatedAt: new Date() })
      .where(and(eq(brokers.id, id), eq(brokers.orgId, tx.ctx.orgId)))
      .returning();
    if (!row) throw new Error('broker detention threshold update returned nothing');

    await recordEvent(tx, 'broker.detention_threshold_updated', {
      subjectId: id,
      payload: { brokerName: row.name, freeMinutes },
    });

    return row;
  });
}
