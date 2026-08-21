/**
 * The brokers repository, against a real database.
 *
 * Small surface, small suite: setting and clearing the detention threshold,
 * the event it records, tenant isolation, and the not-found refusal. Skips
 * without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, testScope } from '../testing.ts';
import { BrokerError, getBroker, updateBrokerDetentionThreshold } from './brokers.ts';
import { createLoad } from './loads.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;

suite('brokers repository', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Brokers Test Carrier');
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
  async function aBroker(name = 'Prairie Freight') {
    const load = await createLoad(s, {
      brokerName: name,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    });
    return load.brokerId!;
  }

  it('sets a detention threshold and records it', async () => {
    const brokerId = await aBroker();
    const updated = await updateBrokerDetentionThreshold(s, brokerId, 90);
    assert.equal(updated.detentionFreeMinutes, 90);

    const events = await readTimeline(s, { subjectId: brokerId });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.verb, 'broker.detention_threshold_updated');
    assert.match(events[0]!.explanation, /90 minutes/);
  });

  it('clears a threshold back to the default with null', async () => {
    const brokerId = await aBroker('Acme Logistics');
    await updateBrokerDetentionThreshold(s, brokerId, 90);
    const cleared = await updateBrokerDetentionThreshold(s, brokerId, null);
    assert.equal(cleared.detentionFreeMinutes, null);
  });

  it('refuses a broker from another org', async () => {
    const brokerId = await aBroker('Cross-Org Freight');
    await assert.rejects(
      () => updateBrokerDetentionThreshold(other, brokerId, 90),
      (e: BrokerError) => e.code === 'not_found',
    );
  });

  it('refuses an unknown broker', async () => {
    await assert.rejects(
      () => updateBrokerDetentionThreshold(s, '00000000-0000-0000-0000-000000000000', 90),
      (e: BrokerError) => e.code === 'not_found',
    );
  });

  it('getBroker is tenant-scoped', async () => {
    const brokerId = await aBroker('Tenant Check Freight');
    assert.ok(await getBroker(s, brokerId));
    assert.equal(await getBroker(other, brokerId), undefined);
  });
});
