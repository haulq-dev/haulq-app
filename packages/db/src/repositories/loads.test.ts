/**
 * The loads repository, against a real database.
 *
 * `guards.test.ts` already covers what the trigger enforces — illegal
 * transitions, required timestamps, non-negative miles. This file is the
 * other half: the things only the repository does, because a trigger cannot
 * infer *why* a timestamp is missing or *which* broker a name matches.
 *
 *  - a broker name matches an existing broker rather than duplicating it
 *  - creating directly at a later status backfills every timestamp that
 *    status implies, including ones a normal transition would have skipped
 *  - `load.booked` fires on creation, but never for a CSV replay — a booking
 *    dated "just now" for a load delivered months ago is not just unhelpful,
 *    it is untrue, and `event_log` cannot un-say it later
 *  - which event a status move produces depends on the destination, not on
 *    a generic "status changed"
 *  - assigning a truck records an event; clearing one does not, because
 *    nothing was decided
 *  - tenant isolation on both reads
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, testScope } from '../testing.ts';
import { createDriver } from './drivers.ts';
import {
  assignLoad,
  createLoad,
  getLoad,
  listLoads,
  loadCounts,
  LoadError,
  updateLoadStatus,
  updateLoadStop,
} from './loads.ts';
import { createTruck } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;

const wichitaToDenver = [
  { type: 'pickup' as const, city: 'Wichita', state: 'KS' },
  { type: 'delivery' as const, city: 'Denver', state: 'CO' },
];

const extraOrgs: string[] = [];

/** A fresh org and scope, for a test that counts rather than merely finds. */
async function freshOrg(name: string): Promise<Scope> {
  const org = await createTestOrg(db, name);
  extraOrgs.push(org.id);
  return testScope(db, org.id, { type: 'user', id: userId });
}

const readEvents = (scope_: Scope, subjectId: string) => readTimeline(scope_, { subjectId });

suite('loads repository', () => {
  before(async () => {
    const dbUrl = url!;
    db = createDatabase({ url: dbUrl });
    const org = await createTestOrg(db, 'Loads Test Co');
    orgId = org.id;
    const otherOrg = await createTestOrg(db, 'Other Carrier');
    otherOrgId = otherOrg.id;
    const user = await createTestUser(db);
    userId = user.id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    other = testScope(db, otherOrgId, { type: 'user', id: userId });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    for (const id of extraOrgs) await destroyTestOrg(db, id);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  // --- createLoad ------------------------------------------------------------

  describe('createLoad', () => {
    it('creates a load with stops and a sequential reference', async () => {
      const a = await createLoad(s, { brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const b = await createLoad(s, { brokerName: 'Prairie Freight', stops: wichitaToDenver });

      assert.equal(b.reference, a.reference + 1);
      assert.equal(a.stops.length, 2);
      assert.equal(a.stops[0]!.type, 'pickup');
      assert.equal(a.stops[0]!.city, 'Wichita');
    });

    it('records load.created naming both endpoints', async () => {
      const load = await createLoad(s, { brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const events = await readEvents(s, load.id);
      const created = events.find((e) => e.verb === 'load.created');
      assert.ok(created);
      assert.match(created!.explanation, /Wichita, KS/);
      assert.match(created!.explanation, /Denver, CO/);
    });

    it('matches an existing broker rather than creating a duplicate', async () => {
      const a = await createLoad(s, { brokerName: 'Acme Logistics, Inc.', stops: wichitaToDenver });
      const b = await createLoad(s, { brokerName: 'ACME LOGISTICS LLC', stops: wichitaToDenver });

      assert.equal(a.brokerName, b.brokerName);
      // Same underlying broker row — two loads for the same broker must both
      // resolve to it, or profitability-by-broker in Insights double counts.
      const { items: listed } = await listLoads(s);
      const brokerNames = new Set(
        listed.filter((l) => [a.id, b.id].includes(l.id)).map((l) => l.brokerName),
      );
      assert.equal(brokerNames.size, 1);
    });

    it('leaves brokerId and brokerName null with no broker given', async () => {
      const load = await createLoad(s, { stops: wichitaToDenver });
      assert.equal(load.brokerId, null);
      assert.equal(load.brokerName, null);
    });

    it('backfills every timestamp a later status implies', async () => {
      // csv_import is the one source exempt from loads_dispatched_has_truck —
      // the realistic case for a load created straight into delivered with no
      // truck named, which is exactly what this test needs to isolate the
      // timestamp backfill from truck assignment.
      const load = await createLoad(s, {
        status: 'delivered',
        source: 'csv_import',
        brokerName: 'Prairie Freight',
        stops: wichitaToDenver,
      });
      // Booked and delivered both have to be non-null immediately, or the
      // check constraints on those statuses would have rejected the insert.
      assert.ok(load.bookedAt);
      assert.ok(load.deliveredAt);
    });

    it('fires load.booked when created directly at booked or later', async () => {
      const load = await createLoad(s, {
        status: 'booked',
        brokerName: 'Prairie Freight',
        rate: { amount: 240000, currency: 'USD' },
        stops: wichitaToDenver,
      });
      const events = await readEvents(s, load.id);
      const booked = events.find((e) => e.verb === 'load.booked');
      assert.ok(booked);
      assert.match(booked!.explanation, /Prairie Freight/);
      assert.match(booked!.explanation, /\$2,400/);
    });

    it('does not fire load.booked for a CSV replay', async () => {
      // A booking dated "just now" for a load delivered two months ago is
      // untrue, and event_log cannot un-say it — see the repository's own
      // comment on this branch.
      const load = await createLoad(s, {
        status: 'booked',
        source: 'csv_import',
        brokerName: 'Prairie Freight',
        stops: wichitaToDenver,
      });
      const events = await readEvents(s, load.id);
      assert.ok(!events.some((e) => e.verb === 'load.booked'));
      assert.ok(events.some((e) => e.verb === 'load.created'));
    });

    it('does not fire load.booked for a load left at prospect', async () => {
      const load = await createLoad(s, { brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const events = await readEvents(s, load.id);
      assert.ok(!events.some((e) => e.verb === 'load.booked'));
    });
  });

  // --- listLoads / getLoad ----------------------------------------------------

  describe('listing and reading', () => {
    it('lists newest first with names already joined', async () => {
      await createLoad(s, { brokerName: 'List Test Broker', stops: wichitaToDenver });
      const second = await createLoad(s, { brokerName: 'List Test Broker', stops: wichitaToDenver });

      const { items: listed } = await listLoads(s, { limit: 1 });
      assert.equal(listed[0]!.id, second.id);
      assert.equal(listed[0]!.brokerName, 'List Test Broker');
    });

    it('filters by status', async () => {
      const load = await createLoad(s, {
        status: 'quoted',
        brokerName: 'Status Filter Co',
        stops: wichitaToDenver,
      });

      const { items: quoted } = await listLoads(s, { status: ['quoted'] });
      const { items: delivered } = await listLoads(s, { status: ['delivered'] });

      assert.ok(quoted.some((l) => l.id === load.id));
      assert.ok(!delivered.some((l) => l.id === load.id));
    });

    it('filters by truck', async () => {
      const truck = await createTruck(s, { label: 'Filter Truck' });
      const onTruck = await createLoad(s, {
        status: 'dispatched',
        truckId: truck.id,
        brokerName: 'Truck Filter Co',
        stops: wichitaToDenver,
      });
      const offTruck = await createLoad(s, { brokerName: 'Truck Filter Co', stops: wichitaToDenver });

      const { items: filtered } = await listLoads(s, { truckId: truck.id });
      const ids = filtered.map((l) => l.id);
      assert.ok(ids.includes(onTruck.id));
      assert.ok(!ids.includes(offTruck.id));
    });

    it('never returns another tenant\'s loads', async () => {
      const mine = await createLoad(s, { brokerName: 'Isolation Co', stops: wichitaToDenver });
      await createLoad(other, { brokerName: 'Other Tenant Co', stops: wichitaToDenver });

      const { items: listed } = await listLoads(s);
      assert.ok(listed.every((l) => l.orgId === orgId));
      assert.ok(listed.some((l) => l.id === mine.id));

      assert.equal(await getLoad(s, mine.id).then((l) => l?.id), mine.id);
      const crossTenant = await createLoad(other, { brokerName: 'X', stops: wichitaToDenver });
      assert.equal(await getLoad(s, crossTenant.id), undefined);
    });

    it('walks every load exactly once across pages, in the same order as one unpaginated call', async () => {
      const org = await freshOrg('Cursor Walk Co');
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const load = await createLoad(org, { brokerName: 'Cursor Walk Co', stops: wichitaToDenver });
        created.push(load.id);
      }

      const { items: everything } = await listLoads(org);
      assert.equal(everything.length, 5);

      const walked: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await listLoads(org, { limit: 2, ...(cursor ? { cursor } : {}) });
        pages++;
        walked.push(...page.items.map((l) => l.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        assert.ok(pages < 10, 'pagination did not terminate');
      }

      assert.equal(pages, 3); // 2 + 2 + 1
      assert.deepEqual(walked, everything.map((l) => l.id));
    });

    it('refuses a malformed cursor rather than guessing', async () => {
      await assert.rejects(() => listLoads(s, { cursor: 'not-a-real-cursor' }), (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'invalid_cursor');
        return true;
      });
    });
  });

  // --- updateLoadStatus --------------------------------------------------------

  describe('updateLoadStatus', () => {
    it('fires load.status_changed for an ordinary move', async () => {
      const load = await createLoad(s, { brokerName: 'Status Co', stops: wichitaToDenver });
      await updateLoadStatus(s, load.id, { status: 'quoted' });

      const events = await readEvents(s, load.id);
      const changed = events.find((e) => e.verb === 'load.status_changed');
      assert.ok(changed);
      assert.match(changed!.explanation, /prospect/);
      assert.match(changed!.explanation, /quoted/);
    });

    it('fires load.booked, not load.status_changed, on reaching booked', async () => {
      const load = await createLoad(s, {
        brokerName: 'Booked Move Co',
        rate: { amount: 150000, currency: 'USD' },
        stops: wichitaToDenver,
      });
      await updateLoadStatus(s, load.id, { status: 'booked' });

      const events = await readEvents(s, load.id);
      assert.ok(events.some((e) => e.verb === 'load.booked'));
      assert.ok(!events.some((e) => e.verb === 'load.status_changed'));
    });

    it('backfills every skipped timestamp, not just the destination\'s', async () => {
      // A truck named up front — loads_dispatched_has_truck requires one by
      // the time this reaches delivered, same as any normal dispatch would.
      const truck = await createTruck(s, { label: 'Skip Co Truck' });
      const load = await createLoad(s, {
        truckId: truck.id,
        brokerName: 'Skip Co',
        stops: wichitaToDenver,
      });
      await updateLoadStatus(s, load.id, { status: 'booked' });

      const jumped = await updateLoadStatus(s, load.id, { status: 'delivered' });

      // Skipped "dispatched" entirely, but its timestamp is still filled —
      // skips are legal, and the honest answer for when it happened is now.
      assert.ok(jumped.dispatchedAt);
      assert.ok(jumped.deliveredAt);
      const events = await readEvents(s, load.id);
      assert.ok(events.some((e) => e.verb === 'load.delivered'));
    });

    it('requires a reason to cancel', async () => {
      const load = await createLoad(s, { brokerName: 'Cancel Co', stops: wichitaToDenver });
      await assert.rejects(
        () => updateLoadStatus(s, load.id, { status: 'cancelled' }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'reason_required');
          return true;
        },
      );
    });

    it('cancels with a reason and records it', async () => {
      const load = await createLoad(s, { brokerName: 'Cancel Co', stops: wichitaToDenver });
      const cancelled = await updateLoadStatus(s, load.id, {
        status: 'cancelled',
        reason: 'Broker pulled the load',
      });

      assert.equal(cancelled.cancelledReason, 'Broker pulled the load');
      const events = await readEvents(s, load.id);
      const event = events.find((e) => e.verb === 'load.cancelled');
      assert.match(event!.explanation, /Broker pulled the load/);
    });

    it('refuses a load in another tenant', async () => {
      const theirs = await createLoad(other, { brokerName: 'X', stops: wichitaToDenver });
      await assert.rejects(
        () => updateLoadStatus(s, theirs.id, { status: 'quoted' }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'not_found');
          return true;
        },
      );
    });
  });

  // --- assignLoad --------------------------------------------------------------

  describe('assignLoad', () => {
    it('assigns a truck and records the event', async () => {
      const truck = await createTruck(s, { label: 'Unit 9' });
      const load = await createLoad(s, { brokerName: 'Assign Co', stops: wichitaToDenver });

      const assigned = await assignLoad(s, load.id, { truckId: truck.id });
      assert.equal(assigned.truckId, truck.id);

      const events = await readEvents(s, load.id);
      const event = events.find((e) => e.verb === 'load.assigned');
      assert.match(event!.explanation, /Unit 9/);
    });

    it('names the driver in the same event when both are assigned', async () => {
      const truck = await createTruck(s, { label: 'Unit 10' });
      const driver = await createDriver(s, { fullName: 'Ray Mendez' });
      const load = await createLoad(s, { brokerName: 'Assign Co', stops: wichitaToDenver });

      await assignLoad(s, load.id, { truckId: truck.id, driverId: driver.id });

      const events = await readEvents(s, load.id);
      const event = events.find((e) => e.verb === 'load.assigned');
      assert.match(event!.explanation, /Ray Mendez/);
    });

    it('records no event when clearing an assignment', async () => {
      // Nothing was decided by unassigning, so there is nothing to say.
      const truck = await createTruck(s, { label: 'Unit 11' });
      const load = await createLoad(s, { brokerName: 'Unassign Co', stops: wichitaToDenver });
      await assignLoad(s, load.id, { truckId: truck.id });

      const cleared = await assignLoad(s, load.id, { truckId: null });
      assert.equal(cleared.truckId, null);

      const events = await readEvents(s, load.id);
      assert.equal(events.filter((e) => e.verb === 'load.assigned').length, 1);
    });

    it('refuses a truck from another tenant', async () => {
      const theirTruck = await createTruck(other, { label: 'Not Yours' });
      const load = await createLoad(s, { brokerName: 'Assign Co', stops: wichitaToDenver });

      await assert.rejects(
        () => assignLoad(s, load.id, { truckId: theirTruck.id }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'truck_not_found');
          return true;
        },
      );
    });

    it('refuses a driver from another tenant', async () => {
      const theirDriver = await createDriver(other, { fullName: 'Not Yours' });
      const truck = await createTruck(s, { label: 'Unit 12' });
      const load = await createLoad(s, { brokerName: 'Assign Co', stops: wichitaToDenver });

      await assert.rejects(
        () => assignLoad(s, load.id, { truckId: truck.id, driverId: theirDriver.id }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'driver_not_found');
          return true;
        },
      );
    });
  });

  // --- updateLoadStop ------------------------------------------------------

  describe('updateLoadStop', () => {
    it('sets coordinates and records the event', async () => {
      const load = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const pickup = load.stops.find((st) => st.type === 'pickup')!;

      const updated = await updateLoadStop(s, load.id, pickup.id, { lat: 37.6872, lng: -97.3301 });
      const stop = updated.stops.find((st) => st.id === pickup.id)!;
      assert.equal(stop.lat, 37.6872);
      assert.equal(stop.lng, -97.3301);

      const events = await readEvents(s, load.id);
      const event = events.find((e) => e.verb === 'load_stop.updated');
      assert.match(event!.explanation, /coordinates/);
    });

    it('sets a window without touching coordinates set earlier', async () => {
      const load = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const delivery = load.stops.find((st) => st.type === 'delivery')!;
      await updateLoadStop(s, load.id, delivery.id, { lat: 39.7392, lng: -104.9903 });

      const updated = await updateLoadStop(s, load.id, delivery.id, {
        windowEnd: '2026-09-01T18:00:00Z',
      });
      const stop = updated.stops.find((st) => st.id === delivery.id)!;
      assert.equal(stop.lat, 39.7392);
      assert.equal(stop.windowEnd?.toISOString(), '2026-09-01T18:00:00.000Z');
    });

    it('clears a window with null', async () => {
      const load = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const delivery = load.stops.find((st) => st.type === 'delivery')!;
      await updateLoadStop(s, load.id, delivery.id, { windowEnd: '2026-09-01T18:00:00Z' });

      const cleared = await updateLoadStop(s, load.id, delivery.id, { windowEnd: null });
      const stop = cleared.stops.find((st) => st.id === delivery.id)!;
      assert.equal(stop.windowEnd, null);
    });

    it('refuses a window that ends before it starts — the database\'s own constraint', async () => {
      const load = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const delivery = load.stops.find((st) => st.type === 'delivery')!;

      await assert.rejects(() =>
        updateLoadStop(s, load.id, delivery.id, {
          windowStart: '2026-09-01T18:00:00Z',
          windowEnd: '2026-09-01T12:00:00Z',
        }),
      );
    });

    it('refuses a stop that is not on the given load', async () => {
      const load = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const otherLoad = await createLoad(s, { brokerName: 'Stop Co', stops: wichitaToDenver });
      const otherStop = otherLoad.stops[0]!;

      await assert.rejects(
        () => updateLoadStop(s, load.id, otherStop.id, { lat: 1, lng: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'not_found');
          return true;
        },
      );
    });

    it('never reaches another tenant\'s load', async () => {
      const theirs = await createLoad(other, { brokerName: 'Not Yours', stops: wichitaToDenver });
      const theirStop = theirs.stops[0]!;

      await assert.rejects(
        () => updateLoadStop(s, theirs.id, theirStop.id, { lat: 1, lng: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof LoadError);
          assert.equal(err.code, 'not_found');
          return true;
        },
      );
    });
  });

  // --- loadCounts ----------------------------------------------------------

  describe('loadCounts', () => {
    it('groups by status, scoped to the tenant', async () => {
      const mine = await freshOrg('Count Co');
      const theirs = await freshOrg('Not Count Co');

      await createLoad(mine, { status: 'quoted', brokerName: 'Count Co', stops: wichitaToDenver });
      await createLoad(mine, { status: 'quoted', brokerName: 'Count Co', stops: wichitaToDenver });
      await createLoad(mine, { status: 'booked', brokerName: 'Count Co', stops: wichitaToDenver });
      await createLoad(theirs, { status: 'quoted', brokerName: 'X', stops: wichitaToDenver });

      const counts = await loadCounts(mine);
      assert.equal(counts['quoted'], 2);
      assert.equal(counts['booked'], 1);
      assert.equal(counts['delivered'] ?? 0, 0);

      const theirCounts = await loadCounts(theirs);
      assert.equal(theirCounts['quoted'], 1);
    });
  });
});
