/**
 * The outbox drain loop.
 *
 * Shared by the API and the worker, so the behaviour worth pinning is the
 * behaviour that differs between "it works on my laptop" and "it works during a
 * Render deploy at 3am":
 *
 *  - passes never overlap, because with Azure in the chain one can take tens of
 *    seconds and two of them would fight for the same rows
 *  - a full batch goes straight round again, so forty documents drain in
 *    seconds rather than forty polling intervals
 *  - a database outage backs off instead of producing a wall of identical
 *    errors, and does not kill the process
 *  - stopping finishes the pass in flight rather than abandoning a leased
 *    message that has already been paid for
 *
 * No database: `drainOutbox` is exercised for real elsewhere. What is under test
 * here is the loop around it, and giving it a fake lets the slow, racy and
 * failing cases be written at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startOutboxLoop } from './loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Records what the loop said, for the cases where the log is the interface. */
function recorder() {
  const lines: Array<{ o: Record<string, unknown>; msg: string }> = [];
  const push = (o: unknown, msg: string) =>
    lines.push({ o: (o ?? {}) as Record<string, unknown>, msg });
  return { lines, info: push, warn: push, error: push };
}

/**
 * A fake database whose `transaction` drives `drainOutbox`.
 *
 * `drainOutbox` claims inside a transaction and returns early when it claims
 * nothing, so a transaction that yields no rows is a complete, honest "idle
 * pass" without needing Postgres.
 */
function fakeDb(onPass: () => Promise<unknown[]> | unknown[]) {
  return {
    transaction: async (fn: (tx: unknown) => unknown) => {
      const rows = await onPass();
      const chain = {
        select: () => chain,
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        for: () => Promise.resolve(rows),
        update: () => chain,
        set: () => chain,
        returning: () => Promise.resolve(rows),
      };
      return fn(chain);
    },
  } as never;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('startOutboxLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    assert.throws(
      () => startOutboxLoop({ db: fakeDb(() => []), handlers: {}, intervalMs: 0, log: silent }),
      /positive interval/,
    );
  });

  it('keeps polling while it has nothing to do', async () => {
    let passes = 0;
    const loop = startOutboxLoop({
      db: fakeDb(() => {
        passes += 1;
        return [];
      }),
      handlers: { 'x.y': async () => {} },
      intervalMs: 1,
      log: silent,
    });

    await tick();
    await loop.stop();
    assert.ok(passes >= 2, `expected repeated passes, saw ${passes}`);
  });

  it('never runs two passes at once', async () => {
    let inFlight = 0;
    let overlapped = false;

    const loop = startOutboxLoop({
      db: fakeDb(async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return [];
      }),
      handlers: { 'x.y': async () => {} },
      // Far shorter than a pass takes. An interval-based loop would stack here.
      intervalMs: 1,
      log: silent,
    });

    await new Promise((r) => setTimeout(r, 60));
    await loop.stop();
    assert.equal(overlapped, false, 'two drains ran concurrently');
  });

  it('does not die when the database is unreachable', async () => {
    const log = recorder();
    let passes = 0;

    const loop = startOutboxLoop({
      db: fakeDb(() => {
        passes += 1;
        throw new Error('ECONNREFUSED');
      }),
      handlers: { 'x.y': async () => {} },
      intervalMs: 1,
      errorBackoffMs: 5,
      log,
    });

    await new Promise((r) => setTimeout(r, 40));
    await loop.stop();

    assert.ok(passes >= 2, 'the loop stopped trying');
    assert.ok(
      log.lines.some((l) => l.msg === 'outbox drain failed'),
      JSON.stringify(log.lines.map((l) => l.msg)),
    );
  });

  it('backs off further after a failure than after an idle pass', async () => {
    const failing: number[] = [];
    const loop = startOutboxLoop({
      db: fakeDb(() => {
        failing.push(Date.now());
        throw new Error('down');
      }),
      handlers: { 'x.y': async () => {} },
      intervalMs: 1,
      errorBackoffMs: 30,
      log: silent,
    });

    await new Promise((r) => setTimeout(r, 70));
    await loop.stop();

    const gaps = failing.slice(1).map((t, i) => t - failing[i]!);
    assert.ok(
      gaps.every((g) => g >= 25),
      `expected the error backoff to apply, gaps were ${JSON.stringify(gaps)}`,
    );
  });

  it('stops after finishing the pass in flight', async () => {
    let finishedPasses = 0;
    const loop = startOutboxLoop({
      db: fakeDb(async () => {
        await new Promise((r) => setTimeout(r, 25));
        finishedPasses += 1;
        return [];
      }),
      handlers: { 'x.y': async () => {} },
      intervalMs: 1,
      log: silent,
    });

    // Stop while a pass is definitely still running.
    await new Promise((r) => setTimeout(r, 5));
    await loop.stop();

    assert.ok(
      finishedPasses >= 1,
      'stop() returned before the in-flight pass completed — its message stays leased and gets re-read',
    );
  });

  it('resolves stop() even when called twice', async () => {
    const loop = startOutboxLoop({
      db: fakeDb(() => []),
      handlers: { 'x.y': async () => {} },
      intervalMs: 1,
      log: silent,
    });
    await loop.stop();
    await loop.stop();
    await loop.finished;
  });

  it('says what it is draining when it starts', async () => {
    const log = recorder();
    const loop = startOutboxLoop({
      db: fakeDb(() => []),
      handlers: { 'member.invite_email': async () => {}, 'document.received': async () => {} },
      intervalMs: 1,
      log,
    });
    await loop.stop();

    const started = log.lines.find((l) => l.msg === 'outbox loop started');
    assert.ok(started, JSON.stringify(log.lines.map((l) => l.msg)));
    assert.deepEqual(started!.o['topics'], ['member.invite_email', 'document.received']);
  });
});
