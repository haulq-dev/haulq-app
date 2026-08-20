/**
 * The outbox drain loop, and the lease arithmetic under it.
 *
 * Two things are under test here and the second one is the reason this file
 * grew:
 *
 * **The loop.** Passes never overlap, a backlog drains without waiting, a
 * database outage backs off instead of killing the process, and stopping
 * finishes the pass in flight rather than abandoning a message already paid for.
 *
 * **The groups.** `drainOutbox` stamps one lease across a whole batch and then
 * handles it serially, so the lease is a budget for the batch. That was
 * invisible while every handler took milliseconds. With OCR in the pipeline it
 * is the difference between a bulk import working and a bulk import re-reading —
 * and re-paying for — its own documents. The arithmetic is asserted against the
 * reader's real timeout rather than restated, so raising one without the other
 * fails here instead of in production.
 *
 * No database: `drainOutbox` is exercised for real elsewhere. A fake lets the
 * slow, racy and failing cases be written at all — and lets the batch size and
 * lease actually sent to Postgres be observed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AZURE_DEFAULT_TIMEOUT_MS } from '../documents/azure-reader.ts';
import { buildOutboxGroups, type OutboxGroup } from './handlers.ts';
import { startOutboxLoop } from './loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function recorder() {
  const lines: Array<{ o: Record<string, unknown>; msg: string }> = [];
  const push = (o: unknown, msg: string) =>
    lines.push({ o: (o ?? {}) as Record<string, unknown>, msg });
  return { lines, info: push, warn: push, error: push };
}

const group = (over: Partial<OutboxGroup> = {}): OutboxGroup => ({
  name: 'test',
  handlers: { 'x.y': async () => {} },
  batchSize: 10,
  leaseSeconds: 60,
  ...over,
});

/**
 * A fake database that drives `drainOutbox` and records what it was asked for.
 *
 * `limit(n)` receives the batch size and the claim's `set({ availableAt })`
 * carries the lease, so both are observable without reaching into the query
 * builder.
 */
function fakeDb(onPass: () => Promise<unknown[]> | unknown[]) {
  const seen: Array<{ batchSize: number; leaseMs: number | null }> = [];

  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => {
      const rows = await onPass();
      let batchSize = -1;
      let leaseMs: number | null = null;

      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: (n: number) => {
          batchSize = n;
          return chain;
        },
        for: () => Promise.resolve(rows),
        update: () => chain,
        set: (values: { availableAt?: Date }) => {
          if (values.availableAt instanceof Date) {
            leaseMs = values.availableAt.getTime() - Date.now();
          }
          return chain;
        },
        returning: () => Promise.resolve(rows),
      });

      const out = await fn(chain);
      seen.push({ batchSize, leaseMs });
      return out;
    },
  };

  return { db: db as never, seen };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('outbox groups — the lease has to fit the batch', () => {
  const groups = buildOutboxGroups({} as never);
  const fast = groups.find((g) => g.name === 'fast')!;
  const slow = groups.find((g) => g.name === 'slow')!;

  it('drains fast topics before slow ones', () => {
    // A backlog of scanned history must never delay somebody's invitation.
    assert.deepEqual(groups.map((g) => g.name), ['fast', 'slow']);
  });

  it('puts the document topic in the slow group and mail in the fast one', () => {
    assert.deepEqual(Object.keys(fast.handlers), ['member.invite_email']);
    assert.deepEqual(Object.keys(slow.handlers), ['document.received']);
  });

  it('sizes the slow lease against the reader\'s real worst case', () => {
    // THE invariant. drainOutbox leases a whole batch at once and handles it
    // serially, so a batch that cannot finish inside its lease starts handing
    // its own messages back to the queue mid-flight — re-reading pages and
    // burning retries on documents that were succeeding.
    const worstCaseMs = slow.batchSize * AZURE_DEFAULT_TIMEOUT_MS;
    assert.ok(
      worstCaseMs < slow.leaseSeconds * 1000,
      `a full slow batch can take ${worstCaseMs / 1000}s but the lease is ` +
        `${slow.leaseSeconds}s — raise the lease or shrink the batch`,
    );
  });

  it('leaves real slack rather than only just fitting', () => {
    const worstCaseMs = slow.batchSize * AZURE_DEFAULT_TIMEOUT_MS;
    assert.ok(
      slow.leaseSeconds * 1000 >= worstCaseMs * 1.5,
      'the slow lease should have room for a slow claim and a slow commit too',
    );
  });

  it('keeps the fast group big, because mail is cheap', () => {
    assert.ok(fast.batchSize >= 20, 'no reason to trickle invitations');
    assert.ok(
      fast.batchSize * 5000 < fast.leaseSeconds * 1000,
      'even at 5s per send a full mail batch must fit its lease',
    );
  });
});

describe('startOutboxLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    const { db } = fakeDb(() => []);
    assert.throws(
      () => startOutboxLoop({ db, groups: [group()], intervalMs: 0, log: silent }),
      /positive interval/,
    );
  });

  it('sends each group its own batch size and lease', async () => {
    const { db, seen } = fakeDb(() => []);
    const loop = startOutboxLoop({
      db,
      groups: [
        group({ name: 'fast', batchSize: 20, leaseSeconds: 300 }),
        group({ name: 'slow', handlers: { 'a.b': async () => {} }, batchSize: 3, leaseSeconds: 900 }),
      ],
      intervalMs: 1,
      log: silent,
    });

    await tick();
    await loop.stop();

    // Only claims that found rows set a lease; the batch size is always sent.
    assert.deepEqual(seen.slice(0, 2).map((s) => s.batchSize), [20, 3]);
  });

  it('keeps polling while it has nothing to do', async () => {
    let passes = 0;
    const { db } = fakeDb(() => {
      passes += 1;
      return [];
    });
    const loop = startOutboxLoop({ db, groups: [group()], intervalMs: 1, log: silent });

    await tick();
    await loop.stop();
    assert.ok(passes >= 2, `expected repeated passes, saw ${passes}`);
  });

  it('never runs two passes at once', async () => {
    let inFlight = 0;
    let overlapped = false;

    const { db } = fakeDb(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await tick(15);
      inFlight -= 1;
      return [];
    });

    // Interval far shorter than a pass takes. An interval-based loop stacks here.
    const loop = startOutboxLoop({ db, groups: [group()], intervalMs: 1, log: silent });
    await tick(60);
    await loop.stop();

    assert.equal(overlapped, false, 'two drains ran concurrently');
  });

  it('does not die when the database is unreachable', async () => {
    const log = recorder();
    let passes = 0;

    const { db } = fakeDb(() => {
      passes += 1;
      throw new Error('ECONNREFUSED');
    });
    const loop = startOutboxLoop({
      db,
      groups: [group()],
      intervalMs: 1,
      errorBackoffMs: 5,
      log,
    });

    await tick(40);
    await loop.stop();

    assert.ok(passes >= 2, 'the loop stopped trying');
    assert.ok(
      log.lines.some((l) => l.msg === 'outbox drain failed'),
      JSON.stringify(log.lines.map((l) => l.msg)),
    );
  });

  it('does not attempt later groups once the database is gone', async () => {
    let passes = 0;
    const { db } = fakeDb(() => {
      passes += 1;
      throw new Error('down');
    });

    const loop = startOutboxLoop({
      db,
      groups: [group({ name: 'fast' }), group({ name: 'slow' })],
      intervalMs: 1,
      errorBackoffMs: 50,
      log: silent,
    });

    await tick(20);
    await loop.stop();
    assert.equal(passes, 1, 'the second group tried anyway and doubled the error noise');
  });

  it('backs off further after a failure than after an idle pass', async () => {
    const failing: number[] = [];
    const { db } = fakeDb(() => {
      failing.push(Date.now());
      throw new Error('down');
    });

    const loop = startOutboxLoop({
      db,
      groups: [group()],
      intervalMs: 1,
      errorBackoffMs: 30,
      log: silent,
    });

    await tick(70);
    await loop.stop();

    const gaps = failing.slice(1).map((t, i) => t - failing[i]!);
    assert.ok(
      gaps.every((g) => g >= 25),
      `expected the error backoff to apply, gaps were ${JSON.stringify(gaps)}`,
    );
  });

  it('stops after finishing the pass in flight', async () => {
    let finishedPasses = 0;
    const { db } = fakeDb(async () => {
      await tick(25);
      finishedPasses += 1;
      return [];
    });

    const loop = startOutboxLoop({ db, groups: [group()], intervalMs: 1, log: silent });
    await tick(5);
    await loop.stop();

    assert.ok(
      finishedPasses >= 1,
      'stop() returned before the in-flight pass completed — its message stays leased and gets re-read',
    );
  });

  it('resolves stop() even when called twice', async () => {
    const { db } = fakeDb(() => []);
    const loop = startOutboxLoop({ db, groups: [group()], intervalMs: 1, log: silent });
    await loop.stop();
    await loop.stop();
    await loop.finished;
  });

  it('states every group and its arithmetic when it starts', async () => {
    const log = recorder();
    const { db } = fakeDb(() => []);
    const loop = startOutboxLoop({
      db,
      groups: buildOutboxGroups({} as never),
      intervalMs: 1,
      log,
    });
    await loop.stop();

    const started = log.lines.find((l) => l.msg === 'outbox loop started');
    assert.ok(started, JSON.stringify(log.lines.map((l) => l.msg)));
    assert.deepEqual(started!.o['groups'], [
      { name: 'fast', topics: ['member.invite_email'], batchSize: 20, leaseSeconds: 300 },
      { name: 'slow', topics: ['document.received'], batchSize: 3, leaseSeconds: 900 },
    ]);
  });
});
