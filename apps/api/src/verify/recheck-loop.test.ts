/**
 * The verify recheck loop's scheduling, with no database.
 *
 * `findBrokersDueForRecheck`/`recordScheduledVerification` are exercised for
 * real against Postgres in `@haulq/db`'s own suite. What is worth checking
 * here — the loop mechanics — is structurally the same thing
 * `exceptions/scan-loop.test.ts` already proves for its loop, which this one
 * is deliberately modelled on: a failing pass must not throw out of the
 * loop, and a non-positive interval must be refused rather than
 * busy-waiting.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  backdateVerificationForTest,
  closeDatabase,
  createDatabase,
  createLoad,
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  getBroker,
  listVerifications,
  pendingOutboxTopics,
  readTimeline,
  recordVerification,
  testScope,
  updateBrokerDocket,
  type Database,
  type Scope,
} from '@haulq/db';
import { recheckOnce, startVerifyRecheckLoop } from './recheck-loop.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('recheckOnce', () => {
  it('never throws, even when the database is unreachable', async () => {
    const db = {
      select: () => {
        throw new Error('connection refused');
      },
    } as never;

    await assert.doesNotReject(() =>
      recheckOnce({ db, staleHours: 24, fmcsaWebKey: 'test-key', log: silent }),
    );
    const result = await recheckOnce({ db, staleHours: 24, fmcsaWebKey: 'test-key', log: silent });
    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.equal(result.changed, 0);
  });
});

describe('startVerifyRecheckLoop', () => {
  it('refuses a non-positive interval rather than busy-waiting', () => {
    assert.throws(() =>
      startVerifyRecheckLoop({
        db: {} as never,
        intervalMs: 0,
        staleHours: 24,
        fmcsaWebKey: 'test-key',
        log: silent,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The full loop, against a real database and a stub FMCSA server
// ---------------------------------------------------------------------------

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

suite('recheckOnce — against a real database', () => {
  let db: Database;
  let orgId: string;
  let s: Scope;
  let fmcsa: Server;
  let fmcsaBase: string;

  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Recheck Loop Test Carrier');
    orgId = org.id;
    const user = await createTestUser(db);
    s = testScope(db, orgId, { type: 'user', id: user.id });

    // Not authorized this time — the whole point is a status that disagrees
    // with what is already on file.
    fmcsa = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          content: {
            carrier: {
              legalName: 'Recheck Freight LLC',
              dotNumber: '9999999',
              allowedToOperate: 'N',
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => fmcsa.listen(0, '127.0.0.1', resolve));
    fmcsaBase = `http://127.0.0.1:${(fmcsa.address() as AddressInfo).port}`;
  });

  after(async () => {
    fmcsa.close();
    await destroyTestOrg(db, orgId);
    await closeDatabase(db);
  });

  it('re-checks a stale broker end to end: new row, advanced pointer, event, and an outbox message', async () => {
    const load = await createLoad(s, {
      brokerName: 'Recheck Freight',
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
    const brokerId = load.brokerId!;
    // A load names a broker with no docket number — `resolveBroker` has no
    // way to learn one from a rate confirmation. The sweep needs one to
    // have anything to ask FMCSA for.
    await updateBrokerDocket(s, brokerId, { mcNumber: '123456' });

    const first = await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: 'Authorized',
      raw: null,
    });
    await backdateVerificationForTest(db, first.id, new Date(Date.now() - 30 * 3_600_000));

    const result = await recheckOnce({
      db,
      staleHours: 24,
      fmcsaWebKey: 'test-key',
      fmcsaBaseUrl: fmcsaBase,
      log: silent,
    });

    assert.equal(result.ok, true);
    assert.ok(result.checked >= 1);
    assert.ok(result.changed >= 1);

    const history = await listVerifications(s, brokerId);
    assert.equal(history.length, 2, 'the stale check plus the new one');
    assert.equal(history[0]!.operatingStatus, 'Not authorized', 'newest first');

    const broker = await getBroker(s, brokerId);
    assert.equal(broker!.latestVerificationId, history[0]!.id);

    const events = await readTimeline(s, { subjectId: brokerId });
    const changedEvent = events.find((e) => e.verb === 'broker.verification_changed');
    assert.ok(changedEvent, 'no broker.verification_changed event');
    assert.match(changedEvent!.explanation, /authorized to not authorized/);

    const topics = await pendingOutboxTopics(db, orgId);
    assert.ok(topics.includes('broker.verification_changed'), JSON.stringify(topics));
  });
});
