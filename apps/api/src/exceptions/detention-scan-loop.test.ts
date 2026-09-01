/**
 * The detention scan loop's scheduling, with no database.
 *
 * `findDetentionCandidates`/`raiseDetentionAlert` are exercised for real
 * against Postgres in `@haulq/db`'s own suite. What is worth checking here
 * — the loop mechanics — mirrors `scan-loop.test.ts` exactly, since this
 * loop is deliberately modelled on that one: a failing pass must not throw
 * out of the loop, and a non-positive interval must be refused rather than
 * busy-waiting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanOnce, startDetentionScanLoop } from './detention-scan-loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('scanOnce', () => {
  it('never throws, even when the database is unreachable', async () => {
    const db = {
      select: () => {
        throw new Error('connection refused');
      },
    } as never;

    await assert.doesNotReject(() => scanOnce({ db, log: silent }));
    const result = await scanOnce({ db, log: silent });
    assert.equal(result.ok, false);
    assert.equal(result.alerted, 0);
  });
});

describe('startDetentionScanLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    assert.throws(() => startDetentionScanLoop({ db: {} as never, intervalMs: 0, log: silent }));
  });
});
