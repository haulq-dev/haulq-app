/**
 * The status advance loop's scheduling, with no database. The rules and the
 * write are tested against Postgres in `@haulq/db`'s own suite.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advanceOnce, startStatusAdvanceLoop } from './status-advance-loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('advanceOnce', () => {
  it('never throws, even when the database is unreachable', async () => {
    const db = {
      select: () => {
        throw new Error('connection refused');
      },
    } as never;

    const result = await advanceOnce({ db, log: silent });
    assert.equal(result.ok, false);
    assert.equal(result.advanced, 0);
  });
});

describe('startStatusAdvanceLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    assert.throws(() => startStatusAdvanceLoop({ db: {} as never, intervalMs: 0, log: silent }));
  });
});
