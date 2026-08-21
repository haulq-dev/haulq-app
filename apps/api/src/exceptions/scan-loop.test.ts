/**
 * The exception scan loop's scheduling, with no database.
 *
 * `findExceptionCandidates`/`raiseExceptionAlert` are exercised for real
 * against Postgres in `@haulq/db`'s own suite. What is worth checking here
 * — the loop mechanics — is structurally the same thing `outbox/loop.test.ts`
 * already proves for `startOutboxLoop`, which this loop is deliberately
 * modelled on. Kept small rather than re-deriving that coverage: a failing
 * pass must not throw out of the loop, and a non-positive interval must be
 * refused rather than busy-waiting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scanOnce, startExceptionScanLoop } from './scan-loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('scanOnce', () => {
  it('never throws, even when the database is unreachable', async () => {
    const db = {
      select: () => {
        throw new Error('connection refused');
      },
    } as never;

    await assert.doesNotReject(() => scanOnce({ db, thresholdHours: 4, log: silent }));
    const result = await scanOnce({ db, thresholdHours: 4, log: silent });
    assert.equal(result.ok, false);
    assert.equal(result.alerted, 0);
  });
});

describe('startExceptionScanLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    assert.throws(() =>
      startExceptionScanLoop({ db: {} as never, intervalMs: 0, thresholdHours: 4, log: silent }),
    );
  });
});
