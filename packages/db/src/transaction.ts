/**
 * Transactions.
 *
 * The one rule this file exists to enforce: **a state change and the event that
 * records it commit together or not at all.**
 *
 * Without it the audit trail drifts from reality in both directions. An event
 * appended outside the transaction survives a rollback, so the log claims a load
 * was booked that never was. An event appended after commit can be lost to a
 * crash, so a load is booked with nothing recording who did it. Guardrail 6
 * fails either way, and it fails silently — nobody notices until the trail is
 * needed, which is during a dispute, months later.
 *
 * Same argument covers the outbox. `event_outbox` is written in the same
 * transaction as the change it describes, so a notification is never sent for a
 * booking that rolled back and never lost for one that committed.
 */

import type { Database } from './client.ts';
import type { Scope } from './context.ts';

/**
 * The handle inside a transaction.
 *
 * Drizzle's transaction callback receives a type that is structurally close to
 * the top-level `Database` but not identical. Naming it here means call sites
 * take `Scope` and never have to know which of the two they hold.
 */
export type Txn = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run `fn` inside a transaction, with a `Scope` whose `db` is the transaction.
 *
 * Nested calls join the outer transaction rather than opening a second one —
 * `db.transaction` on a transaction handle issues a savepoint. That matters
 * because a service function should not have to know whether its caller already
 * opened one; if it did, the two would deadlock on the same connection.
 */
export async function withTransaction<T>(
  s: Scope,
  fn: (s: Scope) => Promise<T>,
): Promise<T> {
  return s.db.transaction(async (tx) => {
    return fn({ ctx: s.ctx, db: tx as unknown as Database });
  });
}
