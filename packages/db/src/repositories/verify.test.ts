/**
 * The verify repository, against a real database.
 *
 * The claims worth a server for:
 *
 *  - a check writes one row and points the broker at it, in one transaction
 *  - every check is kept, not overwritten — the change history the exit
 *    gate asks for
 *  - tenant isolation on both the write and the read
 *  - the not-found refusal, same shape every other repository in this
 *    project uses
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, testScope } from '../testing.ts';
import { BrokerError, getBroker } from './brokers.ts';
import { createLoad } from './loads.ts';
import { getLatestVerification, listVerifications, recordVerification } from './verify.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;

suite('verify repository', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Verify Test Carrier');
    orgId = org.id;
    const second = await createTestOrg(db, 'Other Carrier');
    otherOrgId = second.id;
    const user = await createTestUser(db);
    userId = user.id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    other = testScope(db, otherOrgId, { type: 'user', id: userId });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  /** A broker is created implicitly the first time a load names one. */
  async function aBroker(scope_: Scope, name = 'Prairie Freight') {
    const load = await createLoad(scope_, {
      brokerName: name,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
    return load.brokerId!;
  }

  it('records a check and points the broker at it', async () => {
    const brokerId = await aBroker(s, 'Recorded Freight');

    const verification = await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: 'Authorized',
      legalName: 'Recorded Freight LLC',
      raw: { ok: true },
    });

    assert.equal(verification.operatingStatus, 'Authorized');
    assert.equal(verification.brokerId, brokerId);

    const broker = await getBroker(s, brokerId);
    assert.equal(broker!.latestVerificationId, verification.id);
  });

  it('records the event', async () => {
    const brokerId = await aBroker(s, 'Event Freight');
    await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: 'Authorized',
      raw: null,
    });

    const events = await readTimeline(s, { subjectId: brokerId });
    const event = events.find((e) => e.verb === 'broker.verified');
    assert.ok(event);
    assert.match(event!.explanation, /authorized/);
  });

  it('names the source and says so when nothing was found', async () => {
    const brokerId = await aBroker(s, 'Not Found Freight');
    await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: null,
      raw: null,
    });

    const events = await readTimeline(s, { subjectId: brokerId });
    const event = events.find((e) => e.verb === 'broker.verified');
    assert.match(event!.explanation, /nothing found/);
  });

  it('keeps every check — a second check does not overwrite the first', async () => {
    const brokerId = await aBroker(s, 'History Freight');
    const first = await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: 'Authorized',
      raw: null,
    });
    const second = await recordVerification(s, {
      brokerId,
      source: 'FMCSA QCMobile',
      operatingStatus: 'Not authorized',
      raw: null,
    });

    const history = await listVerifications(s, brokerId);
    assert.equal(history.length, 2);
    assert.ok(history.some((v) => v.id === first.id));
    assert.ok(history.some((v) => v.id === second.id));

    // Newest first, and the broker points at the newest, not the first.
    assert.equal(history[0]!.id, second.id);
    const broker = await getBroker(s, brokerId);
    assert.equal(broker!.latestVerificationId, second.id);
  });

  it('getLatestVerification returns undefined for a broker never checked', async () => {
    const brokerId = await aBroker(s, 'Unchecked Freight');
    assert.equal(await getLatestVerification(s, brokerId), undefined);
  });

  it('refuses a broker from another tenant', async () => {
    const brokerId = await aBroker(other, 'Cross-Tenant Freight');
    await assert.rejects(
      () =>
        recordVerification(s, {
          brokerId,
          source: 'FMCSA QCMobile',
          operatingStatus: 'Authorized',
          raw: null,
        }),
      (e: unknown) => e instanceof BrokerError && e.code === 'not_found',
    );
  });

  it('refuses an unknown broker', async () => {
    await assert.rejects(
      () =>
        recordVerification(s, {
          brokerId: '00000000-0000-0000-0000-000000000000',
          source: 'FMCSA QCMobile',
          operatingStatus: 'Authorized',
          raw: null,
        }),
      (e: unknown) => e instanceof BrokerError && e.code === 'not_found',
    );
  });

  it('is tenant-scoped on read', async () => {
    const brokerId = await aBroker(s, 'Read Isolation Freight');
    await recordVerification(s, { brokerId, source: 'FMCSA QCMobile', operatingStatus: 'Authorized', raw: null });

    assert.ok(await getLatestVerification(s, brokerId));
    assert.equal(await getLatestVerification(other, brokerId), undefined);
  });
});
