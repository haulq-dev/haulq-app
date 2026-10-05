/**
 * Moving loads along from check-ins.
 *
 * The rules are a pure function and tested as one. The database half is
 * what a pure test can't reach: that the sweep finds the load, that the move
 * goes through `updateLoadStatus` (timestamps, events, the status trigger),
 * and that a load a dispatcher moved in the meantime is left alone. Skips
 * without DATABASE_URL, same as the rest of the package.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, setTestOrgStatus, testScope } from '../testing.ts';
import { createLoad, getLoad, updateLoadStatus } from './loads.ts';
import { advanceLoadStatus, findStatusAdvanceCandidates, statusAdvanceFor } from './status-advance.ts';
import { recordStopCheckinAsDriver } from './track.ts';
import { createTruck } from './trucks.ts';

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000);

describe('statusAdvanceFor', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const pickup = (departedAt: Date | null) => ({ seq: 1, type: 'pickup' as const, departedAt });
  const delivery = (departedAt: Date | null, seq = 2) => ({ seq, type: 'delivery' as const, departedAt });

  it('moves a dispatched load to in transit once the first pickup has departed', () => {
    const at = minutesAgo(now, 30);
    assert.deepEqual(statusAdvanceFor('dispatched', [pickup(at), delivery(null)], now), { to: 'in_transit', at });
    assert.deepEqual(statusAdvanceFor('booked', [pickup(at), delivery(null)], now), { to: 'in_transit', at });
  });

  it('moves to delivered once the last delivery has departed, from any open status', () => {
    const at = minutesAgo(now, 15);
    for (const status of ['booked', 'dispatched', 'in_transit'] as const) {
      assert.deepEqual(statusAdvanceFor(status, [pickup(minutesAgo(now, 300)), delivery(at)], now), { to: 'delivered', at });
    }
  });

  it('ignores a departure still inside the undo window', () => {
    assert.equal(statusAdvanceFor('dispatched', [pickup(minutesAgo(now, 9)), delivery(null)], now), null);
    assert.equal(statusAdvanceFor('in_transit', [pickup(minutesAgo(now, 300)), delivery(minutesAgo(now, 9))], now), null);
  });

  it('does nothing once a load is already in transit and the delivery is still open', () => {
    assert.equal(statusAdvanceFor('in_transit', [pickup(minutesAgo(now, 300)), delivery(null)], now), null);
  });

  it('leaves prospects, quotes and anything past delivery alone', () => {
    const stops = [pickup(minutesAgo(now, 300)), delivery(minutesAgo(now, 60))];
    for (const status of ['prospect', 'quoted', 'delivered', 'invoiced', 'paid', 'cancelled'] as const) {
      assert.equal(statusAdvanceFor(status, stops, now), null, status);
    }
  });

  it('only counts the last stop by sequence, and only when it is a delivery', () => {
    const departed = minutesAgo(now, 60);
    // Two deliveries: the first one departing is not delivered yet.
    assert.deepEqual(
      statusAdvanceFor('in_transit', [delivery(null, 3), pickup(departed), delivery(departed, 2)], now),
      null,
    );
    // A load ending on a pickup never reads as delivered.
    assert.deepEqual(statusAdvanceFor('dispatched', [{ seq: 2, type: 'pickup', departedAt: departed }, pickup(departed)], now), {
      to: 'in_transit',
      at: departed,
    });
  });
});

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let userId: string;
let s: Scope;
let truckId: string;

const stops = [
  { type: 'pickup' as const, city: 'Wichita', state: 'KS' },
  { type: 'delivery' as const, city: 'Denver', state: 'CO' },
];

async function aLoad(status: 'prospect' | 'booked' | 'dispatched' = 'dispatched', withTruck = true) {
  return createLoad(s, { status, brokerName: 'Prairie Freight', stops, ...(withTruck ? { truckId } : {}) });
}

async function depart(loadId: string, stopIndex: number, at: Date) {
  const load = (await getLoad(s, loadId))!;
  await recordStopCheckinAsDriver(s, {
    loadId,
    stopId: load.stops[stopIndex]!.id,
    milestone: 'departed',
    occurredAt: at.toISOString(),
  });
}

const candidateFor = async (loadId: string) =>
  (await findStatusAdvanceCandidates(db)).find((c) => c.loadId === loadId);

suite('status advance against the database', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    orgId = (await createTestOrg(db, 'Status Advance Carrier')).id;
    await setTestOrgStatus(db, { orgId, status: 'active' });
    userId = (await createTestUser(db)).id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    truckId = (await createTruck(s, { label: 'Truck 9' })).id;
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  it('moves a load to in transit, then delivered, as HaulQ, stamped with the departure time', async () => {
    const load = await aLoad();
    const leftPickup = minutesAgo(new Date(), 120);
    await depart(load.id, 0, leftPickup);

    const first = await candidateFor(load.id);
    assert.equal(first?.to, 'in_transit');
    assert.equal(await advanceLoadStatus(db, first!), true);
    assert.equal((await getLoad(s, load.id))!.status, 'in_transit');

    const leftDelivery = minutesAgo(new Date(), 20);
    await depart(load.id, 1, leftDelivery);
    const second = await candidateFor(load.id);
    assert.equal(second?.to, 'delivered');
    assert.equal(await advanceLoadStatus(db, second!), true);

    const after = (await getLoad(s, load.id))!;
    assert.equal(after.status, 'delivered');
    assert.equal(after.deliveredAt?.toISOString(), leftDelivery.toISOString());

    const events = await readTimeline(s, { subjectId: load.id });
    const delivered = events.find((e) => e.verb === 'load.delivered');
    assert.equal(delivered?.actorType, 'system');
    assert.ok(events.some((e) => e.verb === 'load.status_changed' && e.actorType === 'system'));
  });

  it('takes a booked load straight to delivered when the delivery departs, filling in the skipped timestamps', async () => {
    const load = await aLoad('booked');
    await depart(load.id, 1, minutesAgo(new Date(), 30));

    const candidate = await candidateFor(load.id);
    assert.equal(candidate?.to, 'delivered');
    assert.equal(await advanceLoadStatus(db, candidate!), true);

    const after = (await getLoad(s, load.id))!;
    assert.equal(after.status, 'delivered');
    assert.ok(after.dispatchedAt);
  });

  it('waits out the undo window before moving anything', async () => {
    const load = await aLoad();
    await depart(load.id, 1, minutesAgo(new Date(), 2));
    assert.equal(await candidateFor(load.id), undefined);
  });

  it('skips a carrier without an active subscription', async () => {
    const load = await aLoad();
    await depart(load.id, 1, minutesAgo(new Date(), 30));
    await setTestOrgStatus(db, { orgId, status: 'past_due' });
    try {
      assert.equal(await candidateFor(load.id), undefined);
    } finally {
      await setTestOrgStatus(db, { orgId, status: 'active' });
    }
    assert.equal((await candidateFor(load.id))?.to, 'delivered');
  });

  it('leaves a prospect alone even with departures on it', async () => {
    const load = await aLoad('prospect');
    await depart(load.id, 1, minutesAgo(new Date(), 60));
    assert.equal(await candidateFor(load.id), undefined);
  });

  it('leaves a load with no truck for the dispatcher, since every status past booked needs one', async () => {
    const load = await aLoad('booked', false);
    await depart(load.id, 1, minutesAgo(new Date(), 30));
    assert.equal(await candidateFor(load.id), undefined);
  });

  it('does not touch a load a dispatcher moved on after the sweep read it', async () => {
    const load = await aLoad();
    await depart(load.id, 1, minutesAgo(new Date(), 30));
    const candidate = await candidateFor(load.id);
    assert.equal(candidate?.to, 'delivered');

    await updateLoadStatus(s, load.id, { status: 'invoiced' });

    assert.equal(await advanceLoadStatus(db, candidate!), false);
    assert.equal((await getLoad(s, load.id))!.status, 'invoiced');
  });
});
