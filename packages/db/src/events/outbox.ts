/**
 * Draining the outbox.
 *
 * `recordEvent` writes an `event_outbox` row in the same transaction as the
 * change it describes, so a consequence is never fired for something that
 * rolled back and never lost for something that committed. This file is the
 * other half: the part that picks those rows up and makes the consequence
 * happen.
 *
 * ---------------------------------------------------------------------------
 * Delivery is at-least-once. Handlers MUST be idempotent.
 * ---------------------------------------------------------------------------
 *
 * There is no way around this and no configuration that removes it. A handler
 * sends an email, the process is killed before the row is marked done, the
 * lease expires, and the message is delivered again. The alternative — mark
 * first, then act — loses messages instead, which for `member.invite_email`
 * means an invitation that silently never arrives.
 *
 * Losing is worse than repeating here, so repeating is what this does. Handlers
 * that cannot tolerate it must dedupe on something stable; `seq` is unique per
 * message and `eventSeq` ties back to the logged event.
 *
 * ---------------------------------------------------------------------------
 * Why a lease rather than one long transaction
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is: open a transaction, `SELECT ... FOR UPDATE`, run the
 * handlers, commit. It holds a Postgres connection open for the duration of
 * every external call in the batch — an unreachable SMTP host would pin a
 * connection from a pool of ten until it timed out.
 *
 * So claiming and completing are separate transactions. Claiming bumps
 * `attempts` and pushes `available_at` out by the lease, which makes the row
 * invisible to other consumers for that window. If this process dies mid-batch
 * the lease simply expires and the message is retried. That is also why
 * `attempts` counts *deliveries attempted* rather than *failures*: a handler
 * that hangs forever still has to stop being retried eventually.
 *
 * ---------------------------------------------------------------------------
 * Unregistered topics are not claimed at all
 * ---------------------------------------------------------------------------
 *
 * The claim query filters on the topics this consumer has handlers for. A
 * message whose topic nobody handles is left pending, untouched, with
 * `attempts` still zero.
 *
 * The two alternatives are both wrong. Marking it processed silently drops work
 * that a later deploy would have known what to do with. Claiming it and failing
 * burns its retry budget for a reason that has nothing to do with the message.
 * Leaving it alone means a consumer deployed next week picks up everything that
 * accumulated in the meantime, which is the behaviour the outbox pattern is for.
 *
 * It also means two consumers can safely split the work by topic.
 *
 * ---------------------------------------------------------------------------
 * This is deliberately not a job queue
 * ---------------------------------------------------------------------------
 *
 * No scheduling, no cron, no priorities, no fan-out. `event_outbox` already
 * exists, is already written transactionally, and already has the partial index
 * this file's claim query needs. Reaching for pg-boss now would mean a second
 * store of pending work with a second failure mode, for features nothing uses
 * yet. If scheduled or recurring jobs arrive, pg-boss can sit beside this and
 * consume from it — the two are not exclusive.
 *
 * Nothing here knows where it runs. A Render worker service, an interval inside
 * the API, or a test calling `drainOutbox` once are all the same to it.
 */

import { and, asc, desc, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.ts';
import { eventOutbox } from '../schema/events.ts';

export interface OutboxMessage {
  /** Unique per message. The dedupe key for a handler that needs one. */
  seq: bigint;
  orgId: string;
  /** `event_log.seq` this mirrors, when it mirrors one. */
  eventSeq: bigint | null;
  topic: string;
  payload: Record<string, unknown>;
  /** Deliveries attempted, including the one in progress. Starts at 1. */
  attempts: number;
}

/**
 * Handle one message.
 *
 * Throwing schedules a retry. Returning marks it done. There is no third
 * outcome on purpose: a handler that wants to give up permanently should
 * succeed and record why it did nothing, because a message that is neither
 * done nor retried is a message nobody will ever look at again.
 */
export type OutboxHandler = (message: OutboxMessage) => Promise<void>;

export interface DrainOptions {
  /** Keyed by topic. Only these topics are claimed. */
  handlers: Record<string, OutboxHandler>;
  /** Messages per pass. Default 20. */
  batchSize?: number;
  /**
   * Deliveries after which a message stops being retried. Default 8.
   *
   * Exhausted messages are not deleted and not marked processed — they stay
   * pending, excluded from claiming, carrying the error that stopped them.
   * `outboxDeadLetters` is how you find them. There is no `failed_at` column to
   * set and adding one is a migration; leaving them visible in the table is
   * both honest and cheap.
   */
  maxAttempts?: number;
  /**
   * How long a claim holds a message. Default 300s.
   *
   * Must exceed the slowest handler, or a second consumer will pick up a
   * message the first is still working on. Longer is safer; the only cost is
   * how long a message waits after a process dies.
   */
  leaseSeconds?: number;
  /** Delay before the next attempt. Default: 2^attempts, capped at an hour. */
  backoffSeconds?: (attempts: number) => number;
  /** Injectable clock. Tests need to reach across a backoff without sleeping. */
  now?: () => Date;
  /** Observation hook. Errors are recorded on the row regardless. */
  onError?: (message: OutboxMessage, error: unknown) => void;
}

export interface DrainResult {
  claimed: number;
  processed: number;
  /** Failed this pass and scheduled for another attempt. */
  failed: number;
  /** Failed this pass and out of attempts. */
  exhausted: number;
}

const DEFAULT_BATCH = 20;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_LEASE_SECONDS = 300;

/** 2s, 4s, 8s … capped at an hour. */
function defaultBackoff(attempts: number): number {
  return Math.min(2 ** attempts, 3600);
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // `last_error` is for a human reading the table. A stack trace pasted whole
  // makes the column unreadable in psql and tells them nothing extra.
  return text.slice(0, 500);
}

/**
 * Claim and handle one batch. Returns when the batch is done.
 *
 * Safe to run concurrently: `FOR UPDATE SKIP LOCKED` means two consumers take
 * disjoint sets rather than blocking on each other.
 */
export async function drainOutbox(
  db: Database,
  options: DrainOptions,
): Promise<DrainResult> {
  const {
    handlers,
    batchSize = DEFAULT_BATCH,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    backoffSeconds = defaultBackoff,
    now = () => new Date(),
    onError,
  } = options;

  const topics = Object.keys(handlers);
  const result: DrainResult = { claimed: 0, processed: 0, failed: 0, exhausted: 0 };

  // No handlers means nothing is claimable. Returning early also keeps
  // `inArray(..., [])` — which drizzle renders as a false constant — out of the
  // query, so the intent is in the code rather than in a SQL quirk.
  if (topics.length === 0) return result;

  const claimedAt = now();

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        seq: eventOutbox.seq,
        orgId: eventOutbox.orgId,
        eventSeq: eventOutbox.eventSeq,
        topic: eventOutbox.topic,
        payload: eventOutbox.payload,
        attempts: eventOutbox.attempts,
      })
      .from(eventOutbox)
      .where(
        and(
          isNull(eventOutbox.processedAt),
          lte(eventOutbox.availableAt, claimedAt),
          lt(eventOutbox.attempts, maxAttempts),
          inArray(eventOutbox.topic, topics),
        ),
      )
      // Oldest ready first, then insertion order, so a retry that has come due
      // does not starve behind a burst of new messages.
      .orderBy(asc(eventOutbox.availableAt), asc(eventOutbox.seq))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];

    await tx
      .update(eventOutbox)
      .set({
        attempts: sql`${eventOutbox.attempts} + 1`,
        availableAt: new Date(claimedAt.getTime() + leaseSeconds * 1000),
      })
      .where(
        inArray(
          eventOutbox.seq,
          rows.map((r) => r.seq),
        ),
      );

    return rows;
  });

  result.claimed = claimed.length;

  for (const row of claimed) {
    const message: OutboxMessage = {
      seq: row.seq,
      orgId: row.orgId,
      eventSeq: row.eventSeq,
      topic: row.topic,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      // The row was read before the increment, so add it back. Handlers that
      // behave differently on a retry need the number they are actually on.
      attempts: row.attempts + 1,
    };

    const handler = handlers[message.topic];
    // Cannot happen — the claim filtered on these topics — but a handler map
    // mutated between claim and dispatch would otherwise throw past the loop
    // and abandon the rest of the batch under an expired lease.
    if (!handler) continue;

    try {
      await handler(message);
      await db
        .update(eventOutbox)
        .set({ processedAt: now(), lastError: null })
        .where(inArray(eventOutbox.seq, [message.seq]));
      result.processed += 1;
    } catch (error) {
      onError?.(message, error);

      const done = message.attempts >= maxAttempts;
      await db
        .update(eventOutbox)
        .set({
          lastError: errorText(error),
          // Out of attempts: leave `available_at` where the lease put it. It is
          // excluded by the attempts filter now, so the value is inert, and
          // moving it would imply a retry that is not coming.
          ...(done
            ? {}
            : {
                availableAt: new Date(
                  now().getTime() + backoffSeconds(message.attempts) * 1000,
                ),
              }),
        })
        .where(inArray(eventOutbox.seq, [message.seq]));

      if (done) result.exhausted += 1;
      else result.failed += 1;
    }
  }

  return result;
}

/**
 * How much work is waiting.
 *
 * `pending` is the number a consumer would eventually take; `dead` is the
 * number no consumer will take again. The second is the one worth alerting on —
 * it only grows.
 */
export async function outboxDepth(
  db: Database,
  options: { maxAttempts?: number } = {},
): Promise<{ pending: number; dead: number }> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${eventOutbox.attempts} < ${maxAttempts})::int`,
      dead: sql<number>`count(*) filter (where ${eventOutbox.attempts} >= ${maxAttempts})::int`,
    })
    .from(eventOutbox)
    .where(isNull(eventOutbox.processedAt));

  return { pending: row?.pending ?? 0, dead: row?.dead ?? 0 };
}

export interface DeadLetter extends OutboxMessage {
  lastError: string | null;
  createdAt: Date;
}

/** Messages that ran out of attempts, newest first. */
export async function outboxDeadLetters(
  db: Database,
  options: { maxAttempts?: number; limit?: number } = {},
): Promise<DeadLetter[]> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const rows = await db
    .select({
      seq: eventOutbox.seq,
      orgId: eventOutbox.orgId,
      eventSeq: eventOutbox.eventSeq,
      topic: eventOutbox.topic,
      payload: eventOutbox.payload,
      attempts: eventOutbox.attempts,
      lastError: eventOutbox.lastError,
      createdAt: eventOutbox.createdAt,
    })
    .from(eventOutbox)
    .where(
      and(isNull(eventOutbox.processedAt), sql`${eventOutbox.attempts} >= ${maxAttempts}`),
    )
    .orderBy(desc(eventOutbox.seq))
    .limit(options.limit ?? 50);

  return rows.map((r) => ({
    ...r,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Put a dead message back in the queue.
 *
 * The deliberate manual step after a bad deploy or an outage: fix the cause,
 * then replay. Resets `attempts` rather than raising `maxAttempts`, so the
 * message gets a full retry budget and the next failure looks like a new
 * problem instead of the tail of an old one.
 */
export async function replayOutboxMessage(
  db: Database,
  seq: bigint,
  options: { now?: () => Date } = {},
): Promise<void> {
  const now = options.now ?? (() => new Date());
  await db
    .update(eventOutbox)
    .set({ attempts: 0, lastError: null, availableAt: now() })
    .where(and(inArray(eventOutbox.seq, [seq]), isNull(eventOutbox.processedAt)));
}
