/**
 * The outbox consumer, against a real database.
 *
 * The claims that matter and are easy to get wrong:
 *
 *  - a message is delivered, and marked done only after the handler returns
 *  - a failing handler is retried, with the delay growing
 *  - retries stop, and the message stays visible rather than vanishing
 *  - a topic nobody handles is left completely untouched
 *  - two consumers running at once do not both take the same message
 *
 * The clock is injected throughout. Testing backoff by sleeping would make this
 * suite take minutes and still be flaky.
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import { scope, type Scope } from '../context.ts';
import { eventOutbox } from '../schema/events.ts';
import { createTestOrg, destroyTestOrg } from '../testing.ts';
import { withTransaction } from '../transaction.ts';
import {
  drainOutbox,
  outboxDeadLetters,
  outboxDepth,
  replayOutboxMessage,
  type OutboxMessage,
} from './outbox.ts';
import { recordEvent } from './record.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;

/** A fixed instant, so backoff arithmetic is checkable rather than approximate. */
const T0 = new Date('2026-08-18T12:00:00.000Z');
const at = (secondsFromT0: number) => new Date(T0.getTime() + secondsFromT0 * 1000);

async function queue(topic: string, payload: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(eventOutbox)
    .values({ orgId, topic, payload, availableAt: T0 })
    .returning({ seq: eventOutbox.seq });
  return row!.seq;
}

async function rowFor(seq: bigint) {
  const [row] = await db
    .select()
    .from(eventOutbox)
    .where(inArray(eventOutbox.seq, [seq]));
  return row!;
}

const collect = (into: OutboxMessage[]) => async (m: OutboxMessage) => {
  into.push(m);
};

const alwaysFails = (message: string) => async () => {
  throw new Error(message);
};

suite('outbox consumer', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    orgId = (await createTestOrg(db, 'Outbox Test Carrier')).id;
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await closeDatabase(db);
  });

  beforeEach(async () => {
    await db.delete(eventOutbox).where(eq(eventOutbox.orgId, orgId));
  });

  it('delivers a message and marks it processed', async () => {
    const seq = await queue('member.invite_email', { email: 'owner@example.test' });
    const seen: OutboxMessage[] = [];

    const result = await drainOutbox(db, {
      handlers: { 'member.invite_email': collect(seen) },
      now: () => at(0),
    });

    assert.deepEqual(result, { claimed: 1, processed: 1, failed: 0, exhausted: 0 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.topic, 'member.invite_email');
    assert.deepEqual(seen[0]!.payload, { email: 'owner@example.test' });
    assert.equal(seen[0]!.attempts, 1, 'first delivery is attempt 1, not 0');

    const row = await rowFor(seq);
    assert.ok(row.processedAt, 'processed_at is set');
    assert.equal(row.lastError, null);
  });

  it('leaves a message for a topic it has no handler for', async () => {
    const seq = await queue('document.received');

    const result = await drainOutbox(db, {
      handlers: { 'member.invite_email': async () => {} },
      now: () => at(0),
    });

    assert.equal(result.claimed, 0);

    // Untouched, not merely unprocessed: a consumer deployed later must find it
    // with a full retry budget.
    const row = await rowFor(seq);
    assert.equal(row.processedAt, null);
    assert.equal(row.attempts, 0);
    assert.equal(row.lastError, null);
  });

  it('retries a failing handler with a growing delay, then stops', async () => {
    const seq = await queue('member.invite_email');
    const handlers = { 'member.invite_email': alwaysFails('smtp unreachable') };

    // Attempt 1 at T0. Backoff 2^1 = 2s.
    let result = await drainOutbox(db, { handlers, now: () => at(0) });
    assert.deepEqual(result, { claimed: 1, processed: 0, failed: 1, exhausted: 0 });

    let row = await rowFor(seq);
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, 'smtp unreachable');
    assert.equal(row.availableAt.toISOString(), at(2).toISOString());

    // Not yet due — a consumer running before the backoff elapses takes nothing.
    result = await drainOutbox(db, { handlers, now: () => at(1) });
    assert.equal(result.claimed, 0, 'backoff is respected');

    // Due. Attempt 2, backoff 2^2 = 4s from that moment.
    result = await drainOutbox(db, { handlers, now: () => at(2) });
    assert.equal(result.failed, 1);
    row = await rowFor(seq);
    assert.equal(row.attempts, 2);
    assert.equal(row.availableAt.toISOString(), at(6).toISOString());

    // Run it out. maxAttempts of 3 means the third delivery is the last.
    result = await drainOutbox(db, { handlers, maxAttempts: 3, now: () => at(6) });
    assert.deepEqual(result, { claimed: 1, processed: 0, failed: 0, exhausted: 1 });

    // Still there, still unprocessed, carrying the reason.
    row = await rowFor(seq);
    assert.equal(row.processedAt, null);
    assert.equal(row.attempts, 3);
    assert.equal(row.lastError, 'smtp unreachable');

    // And never claimed again, however long we wait.
    result = await drainOutbox(db, { handlers, maxAttempts: 3, now: () => at(86_400) });
    assert.equal(result.claimed, 0, 'exhausted messages are not retried');
  });

  it('surfaces exhausted messages, and replays them on request', async () => {
    const seq = await queue('member.invite_email', { email: 'stuck@example.test' });
    const handlers = { 'member.invite_email': alwaysFails('bad template') };

    await drainOutbox(db, { handlers, maxAttempts: 1, now: () => at(0) });

    const dead = await outboxDeadLetters(db, { maxAttempts: 1 });
    const mine = dead.filter((d) => d.orgId === orgId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.lastError, 'bad template');
    assert.deepEqual(mine[0]!.payload, { email: 'stuck@example.test' });

    const depth = await outboxDepth(db, { maxAttempts: 1 });
    assert.ok(depth.dead >= 1, 'dead is the count worth alerting on');

    // Fix the cause, replay, and it succeeds with a fresh budget.
    await replayOutboxMessage(db, seq, { now: () => at(10) });
    const row = await rowFor(seq);
    assert.equal(row.attempts, 0);
    assert.equal(row.lastError, null);

    const seen: OutboxMessage[] = [];
    const result = await drainOutbox(db, {
      handlers: { 'member.invite_email': collect(seen) },
      maxAttempts: 1,
      now: () => at(10),
    });
    assert.equal(result.processed, 1);
    assert.equal(seen.length, 1);
  });

  it('does not hand the same message to two consumers at once', async () => {
    for (let i = 0; i < 6; i += 1) await queue('member.invite_email', { i });

    const a: OutboxMessage[] = [];
    const b: OutboxMessage[] = [];

    // Concurrent, on separate connections from the pool. SKIP LOCKED is what
    // makes this take disjoint sets rather than deadlock or double-deliver.
    const [ra, rb] = await Promise.all([
      drainOutbox(db, { handlers: { 'member.invite_email': collect(a) }, now: () => at(0) }),
      drainOutbox(db, { handlers: { 'member.invite_email': collect(b) }, now: () => at(0) }),
    ]);

    assert.equal(ra.claimed + rb.claimed, 6, 'every message claimed exactly once');

    const seqs = [...a, ...b].map((m) => m.seq.toString());
    assert.equal(new Set(seqs).size, 6, 'no message delivered twice');
  });

  it('a failure in one message does not abandon the rest of the batch', async () => {
    await queue('member.invite_email', { n: 1 });
    await queue('member.invite_email', { n: 2 });
    await queue('member.invite_email', { n: 3 });

    const result = await drainOutbox(db, {
      handlers: {
        'member.invite_email': async (m) => {
          if ((m.payload as { n: number }).n === 2) throw new Error('just this one');
        },
      },
      now: () => at(0),
    });

    assert.deepEqual(result, { claimed: 3, processed: 2, failed: 1, exhausted: 0 });
  });

  it('picks up what recordEvent queued, in the same transaction as the change', async () => {
    const s: Scope = scope(db, {
      orgId,
      actor: { type: 'system', name: 'outbox-consumer-test' },
      correlationId: randomUUID(),
    });

    await withTransaction(s, async (tx) => {
      await recordEvent(tx, 'member.invited', {
        payload: { email: 'invited@example.test', role: 'dispatcher' },
      });
    });

    const seen: OutboxMessage[] = [];
    // Real clock here, deliberately. `queue()` backdates `available_at` to T0,
    // but recordEvent lets the column default to the database's now() — so a
    // frozen 12:00 clock would find this row not yet due, which is the consumer
    // behaving correctly and the test lying.
    const result = await drainOutbox(db, {
      handlers: { 'member.invite_email': collect(seen) },
    });

    assert.equal(result.processed, 1);
    assert.equal(seen[0]!.topic, 'member.invite_email');
    assert.deepEqual(seen[0]!.payload, {
      email: 'invited@example.test',
      role: 'dispatcher',
    });
    assert.ok(seen[0]!.eventSeq, 'ties back to the logged event');
  });

  it('claims nothing when no handlers are registered', async () => {
    await queue('member.invite_email');
    const result = await drainOutbox(db, { handlers: {}, now: () => at(0) });
    assert.deepEqual(result, { claimed: 0, processed: 0, failed: 0, exhausted: 0 });
  });
});
