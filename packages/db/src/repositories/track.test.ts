/**
 * The track repository, against a real database.
 *
 * The claims worth a suite here are the ones a unit test of pure functions
 * cannot reach: a token's hash lookup and its revoked/expired refusals, a
 * position ping landing in two tables in one transaction, and tenant
 * isolation on the authenticated half of these routes. Skips without
 * DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import {
  createTestOrg,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  testScope,
} from '../testing.ts';
import { updateBrokerDetentionThreshold } from './brokers.ts';
import { createDriver } from './drivers.ts';
import { createLoad, updateLoadStatus } from './loads.ts';
import {
  findExceptionCandidates,
  generateCheckinCode,
  issueCheckinLink,
  issueVisibilityLink,
  previewCheckin,
  previewTracking,
  raiseExceptionAlert,
  recordCheckinPosition,
  recordStopCheckin,
  revokeCheckinLink,
  revokeVisibilityLink,
  TrackError,
  undoStopCheckin,
} from './track.ts';
import { createTruck } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

// Pure — runs with or without DATABASE_URL, unlike everything else in this file.
describe('generateCheckinCode', () => {
  it('produces an 8-character code in two dashed groups', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generateCheckinCode(), /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  it('never uses I, L, O or U — visually confusable with 1, 1, 0, and each other', () => {
    for (let i = 0; i < 500; i++) {
      assert.doesNotMatch(generateCheckinCode(), /[ILOU]/);
    }
  });

  it('does not repeat across a few hundred calls', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateCheckinCode()));
    assert.equal(codes.size, 500);
  });
});

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;
let truckId: string;

const wichitaToDenver = [
  { type: 'pickup' as const, city: 'Wichita', state: 'KS' },
  { type: 'delivery' as const, city: 'Denver', state: 'CO' },
];

async function aDispatchedLoad(scope_: Scope = s, truck = truckId) {
  return createLoad(scope_, {
    status: 'dispatched',
    brokerName: 'Prairie Freight',
    truckId: truck,
    stops: wichitaToDenver,
  });
}

const readEvents = (scope_: Scope, subjectId: string) => readTimeline(scope_, { subjectId });

suite('track repository', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Track Test Carrier');
    orgId = org.id;
    const second = await createTestOrg(db, 'Other Carrier');
    otherOrgId = second.id;
    const user = await createTestUser(db);
    userId = user.id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    other = testScope(db, otherOrgId, { type: 'user', id: userId });

    truckId = (await createTruck(s, { label: 'Truck 1' })).id;
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  // --- checkin links -----------------------------------------------------

  describe('issueCheckinLink / previewCheckin', () => {
    it('previews the load and its stops through the token alone', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);

      const preview = await previewCheckin(db, token);
      assert.equal(preview.loadReference, load.reference);
      assert.equal(preview.status, 'dispatched');
      assert.equal(preview.truckLabel, 'Truck 1');
      assert.equal(preview.stops.length, 2);
      assert.equal(preview.stops[0]!.arrivedAt, null);
    });

    it('records track.checkin_link_issued', async () => {
      const load = await aDispatchedLoad();
      await issueCheckinLink(s, load.id);

      const events = await readEvents(s, load.id);
      assert.ok(events.some((e) => e.verb === 'track.checkin_link_issued'));
    });

    it('supersedes a live link when reissued', async () => {
      const load = await aDispatchedLoad();
      const first = await issueCheckinLink(s, load.id);
      const second = await issueCheckinLink(s, load.id);

      await assert.rejects(
        () => previewCheckin(db, first.token),
        (e: TrackError) => e.code === 'revoked',
      );
      await assert.doesNotReject(() => previewCheckin(db, second.token));
    });

    it('refuses an unknown token', async () => {
      await assert.rejects(
        () => previewCheckin(db, 'not-a-real-token'),
        (e: TrackError) => e.code === 'invalid_token',
      );
    });

    it('refuses a load from another org', async () => {
      const load = await aDispatchedLoad();
      await assert.rejects(
        () => issueCheckinLink(other, load.id),
        (e: TrackError) => e.code === 'not_found',
      );
    });

    it('rejects a revoked link', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      await revokeCheckinLink(s, load.id);

      await assert.rejects(
        () => previewCheckin(db, token),
        (e: TrackError) => e.code === 'revoked',
      );
    });

    it('accepts a named driver', async () => {
      const load = await aDispatchedLoad();
      const driver = await createDriver(s, { fullName: 'Casey Driver' });
      const { link } = await issueCheckinLink(s, load.id, { driverId: driver.id });
      assert.equal(link.driverId, driver.id);
    });

    it('matches the code regardless of case, dash, or stray whitespace', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const [firstHalf, secondHalf] = token.split('-');

      const variants = [
        token.toLowerCase(),
        token.replace('-', ''),
        `  ${firstHalf} ${secondHalf}  `.toLowerCase(),
      ];
      for (const variant of variants) {
        await assert.doesNotReject(() => previewCheckin(db, variant));
      }
    });
  });

  describe('recordStopCheckin', () => {
    it('writes the milestone timestamp and sets arrival_source on arrival', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      const pickup = preview.stops[0]!;

      const { stop } = await recordStopCheckin(db, {
        token,
        stopId: pickup.id,
        milestone: 'arrived',
        correlationId: randomUUID(),
      });

      assert.ok(stop.arrivedAt);
      assert.equal(stop.arrivalSource, 'driver_app');
      assert.equal(stop.loadingStartedAt, null);
    });

    it('records load_stop.checkin naming the milestone', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);

      await recordStopCheckin(db, {
        token,
        stopId: preview.stops[0]!.id,
        milestone: 'arrived',
        correlationId: randomUUID(),
      });

      const events = await readEvents(s, load.id);
      const checkin = events.find((e) => e.verb === 'load_stop.checkin');
      assert.ok(checkin);
      assert.equal(checkin.actorType, 'integration');
      assert.match(checkin.explanation, /Arrived at stop 1/);
    });

    it('allows milestones out of order', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      const stopId = preview.stops[0]!.id;

      const { stop } = await recordStopCheckin(db, {
        token,
        stopId,
        milestone: 'departed',
        correlationId: randomUUID(),
      });
      assert.ok(stop.departedAt);
      assert.equal(stop.arrivedAt, null);
    });

    it('refuses a stop from a different load', async () => {
      const loadA = await aDispatchedLoad();
      const loadB = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, loadA.id);
      const previewB = await previewCheckin(db, (await issueCheckinLink(s, loadB.id)).token);

      await assert.rejects(
        () =>
          recordStopCheckin(db, {
            token,
            stopId: previewB.stops[0]!.id,
            milestone: 'arrived',
            correlationId: randomUUID(),
          }),
        (e: TrackError) => e.code === 'not_found',
      );
    });
  });

  describe('undoStopCheckin', () => {
    it('clears the milestone and, for arrival, the arrival source too', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      const stopId = preview.stops[0]!.id;
      await recordStopCheckin(db, { token, stopId, milestone: 'arrived', correlationId: randomUUID() });

      const { stop } = await undoStopCheckin(db, {
        token,
        stopId,
        milestone: 'arrived',
        correlationId: randomUUID(),
      });

      assert.equal(stop.arrivedAt, null);
      assert.equal(stop.arrivalSource, null);
    });

    it('records load_stop.checkin_undone naming the milestone', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      const stopId = preview.stops[0]!.id;
      await recordStopCheckin(db, { token, stopId, milestone: 'arrived', correlationId: randomUUID() });

      await undoStopCheckin(db, { token, stopId, milestone: 'arrived', correlationId: randomUUID() });

      const events = await readEvents(s, load.id);
      const undone = events.find((e) => e.verb === 'load_stop.checkin_undone');
      assert.ok(undone);
      assert.match(undone.explanation, /Undid the arrival report at stop 1/);
    });

    it('refuses to undo a milestone that was never reported', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);

      await assert.rejects(
        () =>
          undoStopCheckin(db, {
            token,
            stopId: preview.stops[0]!.id,
            milestone: 'arrived',
            correlationId: randomUUID(),
          }),
        (e: TrackError) => e.code === 'not_set',
      );
    });

    it('refuses to undo a milestone reported outside the undo window', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      const stopId = preview.stops[0]!.id;
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
      await recordStopCheckin(db, {
        token,
        stopId,
        milestone: 'arrived',
        occurredAt: twentyMinutesAgo,
        correlationId: randomUUID(),
      });

      await assert.rejects(
        () => undoStopCheckin(db, { token, stopId, milestone: 'arrived', correlationId: randomUUID() }),
        (e: TrackError) => e.code === 'undo_window_passed',
      );
    });

    it('refuses a stop from a different load', async () => {
      const loadA = await aDispatchedLoad();
      const loadB = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, loadA.id);
      const previewB = await previewCheckin(db, (await issueCheckinLink(s, loadB.id)).token);

      await assert.rejects(
        () =>
          undoStopCheckin(db, {
            token,
            stopId: previewB.stops[0]!.id,
            milestone: 'arrived',
            correlationId: randomUUID(),
          }),
        (e: TrackError) => e.code === 'not_found',
      );
    });
  });

  describe('recordCheckinPosition', () => {
    it('writes truck_positions and syncs trucks.current*', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueCheckinLink(s, load.id);

      await recordCheckinPosition(db, { token, lat: 39.0997, lng: -94.5786 });

      const preview = await previewCheckin(db, token);
      assert.equal(preview.truckLabel, 'Truck 1');

      const tracking = await previewTracking(db, (await issueVisibilityLink(s, load.id)).token);
      assert.ok(tracking.truck);
      assert.equal(tracking.truck!.currentCity, null); // city/state are not derived from lat/lng here
      assert.ok(tracking.truck!.positionAt);
    });

    it('refuses a position ping for a load with no truck', async () => {
      const load = await createLoad(s, {
        status: 'booked',
        brokerName: 'Prairie Freight',
        stops: wichitaToDenver,
      });
      const { token } = await issueCheckinLink(s, load.id);

      await assert.rejects(
        () => recordCheckinPosition(db, { token, lat: 39, lng: -94 }),
        (e: TrackError) => e.code === 'no_truck',
      );
    });
  });

  // --- visibility links ----------------------------------------------------

  describe('issueVisibilityLink / previewTracking', () => {
    it('shows status, stops and the truck without an account', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueVisibilityLink(s, load.id);

      const view = await previewTracking(db, token);
      assert.equal(view.loadReference, load.reference);
      assert.equal(view.status, 'dispatched');
      assert.equal(view.stops.length, 2);
      assert.equal(view.truck?.label, 'Truck 1');
    });

    it('records track.visibility_link_issued and _revoked', async () => {
      const load = await aDispatchedLoad();
      await issueVisibilityLink(s, load.id);
      await revokeVisibilityLink(s, load.id);

      const events = await readEvents(s, load.id);
      assert.ok(events.some((e) => e.verb === 'track.visibility_link_issued'));
      assert.ok(events.some((e) => e.verb === 'track.visibility_link_revoked'));
    });

    it('refuses a revoked tracking link', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueVisibilityLink(s, load.id);
      await revokeVisibilityLink(s, load.id);

      await assert.rejects(
        () => previewTracking(db, token),
        (e: TrackError) => e.code === 'revoked',
      );
    });

    it('does not leak another org\'s load on token collision-shaped input', async () => {
      await assert.rejects(
        () => previewTracking(db, 'definitely-not-issued'),
        (e: TrackError) => e.code === 'invalid_token',
      );
    });
  });

  describe('previewTracking — detention', () => {
    it('flags detention past the default two-hour free time', async () => {
      const load = await aDispatchedLoad();
      const { token: checkin } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, checkin);

      const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
      await recordStopCheckin(db, {
        token: checkin,
        stopId: preview.stops[0]!.id,
        milestone: 'arrived',
        occurredAt: threeHoursAgo,
        correlationId: randomUUID(),
      });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);
      const stop = view.stops[0]!;

      assert.equal(stop.stillOnSite, true);
      assert.ok(stop.detentionMinutes !== null && stop.detentionMinutes >= 55 && stop.detentionMinutes <= 65);
    });

    it('uses the broker\'s own free time once set', async () => {
      const load = await aDispatchedLoad();
      await updateBrokerDetentionThreshold(s, load.brokerId!, 30);

      const { token: checkin } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, checkin);
      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      await recordStopCheckin(db, {
        token: checkin,
        stopId: preview.stops[0]!.id,
        milestone: 'arrived',
        occurredAt: oneHourAgo,
        correlationId: randomUUID(),
      });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);
      // 60 minutes on site, 30 free -> ~30 minutes of detention, not the
      // ~0 the 120-minute default would report.
      assert.ok(view.stops[0]!.detentionMinutes! >= 25 && view.stops[0]!.detentionMinutes! <= 35);
    });

    it('reports zero detention and null for a stop not yet reached', async () => {
      const load = await aDispatchedLoad();
      const { token } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, token);

      assert.equal(view.stops[0]!.detentionMinutes, null);
      assert.equal(view.stops[0]!.stillOnSite, false);
    });

    it('still shows detention after departure, for a load already gone', async () => {
      // A distinct broker name, not 'Prairie Freight' — the "uses the
      // broker's own free time" test above already overrode that broker's
      // threshold to 30 minutes, and this test's math assumes the untouched
      // 120-minute default.
      const load = await createLoad(s, {
        status: 'dispatched',
        brokerName: 'Departed Freight Co',
        truckId,
        stops: wichitaToDenver,
      });
      const { token: checkin } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, checkin);
      const stopId = preview.stops[0]!.id;

      const fourHoursAgo = new Date(Date.now() - 4 * 3_600_000).toISOString();
      const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
      await recordStopCheckin(db, {
        token: checkin,
        stopId,
        milestone: 'arrived',
        occurredAt: fourHoursAgo,
        correlationId: randomUUID(),
      });
      await recordStopCheckin(db, {
        token: checkin,
        stopId,
        milestone: 'departed',
        occurredAt: oneHourAgo,
        correlationId: randomUUID(),
      });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);
      const stop = view.stops[0]!;
      assert.equal(stop.stillOnSite, false);
      // On site 09:00 -> 12:00 relative to now = 180 minutes, 120 free -> ~60.
      assert.ok(stop.detentionMinutes! >= 55 && stop.detentionMinutes! <= 65);
    });
  });

  describe('previewTracking — ETA', () => {
    const wichitaToDenverWithCoords = [
      { type: 'pickup' as const, city: 'Wichita', state: 'KS', lat: 37.6872, lng: -97.3301 },
      { type: 'delivery' as const, city: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903 },
    ];

    it('estimates arrival at the next stop with coordinates, from the truck\'s last position', async () => {
      const load = await createLoad(s, {
        status: 'dispatched',
        brokerName: 'Prairie Freight',
        truckId,
        stops: wichitaToDenverWithCoords,
      });
      const { token: checkin } = await issueCheckinLink(s, load.id);
      // Somewhere between the two, so there is real remaining distance.
      await recordCheckinPosition(db, { token: checkin, lat: 38.5, lng: -101 });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);

      assert.ok(view.eta);
      assert.equal(view.eta!.stopSeq, 1);
      assert.ok(view.eta!.milesRemaining > 0);
      assert.ok(view.eta!.arrivalAt.getTime() > Date.now());
    });

    it('is null with no truck position', async () => {
      // A truck of its own — the shared `truckId` picks up a position from
      // the test right above this one, which would make "no position"
      // false before this test ever runs.
      const freshTruck = await createTruck(s, { label: 'Truck 2' });
      const load = await createLoad(s, {
        status: 'dispatched',
        brokerName: 'Prairie Freight',
        truckId: freshTruck.id,
        stops: wichitaToDenverWithCoords,
      });
      const { token } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, token);
      assert.equal(view.eta, null);
    });

    it('is null when the next stop has no coordinates', async () => {
      const load = await aDispatchedLoad(); // wichitaToDenver has no lat/lng
      const { token: checkin } = await issueCheckinLink(s, load.id);
      await recordCheckinPosition(db, { token: checkin, lat: 38.5, lng: -101 });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);
      assert.equal(view.eta, null);
    });

    it('moves to the second stop once the first has been reached', async () => {
      const load = await createLoad(s, {
        status: 'dispatched',
        brokerName: 'Prairie Freight',
        truckId,
        stops: wichitaToDenverWithCoords,
      });
      const { token: checkin } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, checkin);
      await recordStopCheckin(db, {
        token: checkin,
        stopId: preview.stops[0]!.id,
        milestone: 'arrived',
        correlationId: randomUUID(),
      });
      await recordCheckinPosition(db, { token: checkin, lat: 37.6872, lng: -97.3301 });

      const { token: tracking } = await issueVisibilityLink(s, load.id);
      const view = await previewTracking(db, tracking);
      assert.ok(view.eta);
      assert.equal(view.eta!.stopSeq, 2);
    });
  });

  // --- exception alerts ----------------------------------------------------

  describe('findExceptionCandidates / raiseExceptionAlert', () => {
    /**
     * A load dispatched `hoursAgo` in the past, with nothing reported since —
     * on its own truck, not the shared `truckId`. `findExceptionCandidates`
     * looks at the truck's last position as much as the load's own
     * timestamps, and other tests in this file (and this block — a position
     * ping is exactly what "counts as activity" tests record) ping the
     * shared truck constantly. Sharing it here would make "quiet" depend on
     * test execution order.
     */
    async function aQuietLoad(hoursAgo: number) {
      const truck = await createTruck(s, { label: `Quiet Truck ${randomUUID().slice(0, 8)}` });
      const load = await createLoad(s, {
        status: 'booked', // no dispatchedAt yet — see the note in loads.ts
        brokerName: 'Prairie Freight',
        truckId: truck.id,
        stops: wichitaToDenver,
      });
      const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
      await updateLoadStatus(s, load.id, { status: 'in_transit', occurredAt: at });
      return load;
    }

    it('flags a load quiet past the threshold, using dispatch as the baseline', async () => {
      const load = await aQuietLoad(5);
      const candidates = await findExceptionCandidates(db, 4);
      assert.ok(candidates.some((c) => c.loadId === load.id));
    });

    it('does not flag a load dispatched inside the threshold', async () => {
      const load = await aQuietLoad(1);
      const candidates = await findExceptionCandidates(db, 4);
      assert.ok(!candidates.some((c) => c.loadId === load.id));
    });

    it('a recent stop check-in counts as activity, overriding an old dispatch', async () => {
      const load = await aQuietLoad(10);
      const { token } = await issueCheckinLink(s, load.id);
      const preview = await previewCheckin(db, token);
      await recordStopCheckin(db, {
        token,
        stopId: preview.stops[0]!.id,
        milestone: 'arrived',
        correlationId: randomUUID(),
      });

      const candidates = await findExceptionCandidates(db, 4);
      assert.ok(!candidates.some((c) => c.loadId === load.id));
    });

    it('a recent position ping counts as activity too', async () => {
      const load = await aQuietLoad(10);
      const { token } = await issueCheckinLink(s, load.id);
      await recordCheckinPosition(db, { token, lat: 39.0997, lng: -94.5786 });

      const candidates = await findExceptionCandidates(db, 4);
      assert.ok(!candidates.some((c) => c.loadId === load.id));
    });

    it('ignores a load that is not in_transit even if it is old', async () => {
      const load = await createLoad(s, {
        status: 'delivered',
        brokerName: 'Prairie Freight',
        truckId,
        stops: wichitaToDenver,
      });
      const candidates = await findExceptionCandidates(db, 4);
      assert.ok(!candidates.some((c) => c.loadId === load.id));
    });

    it('raises an alert once, then again only after activity moves the clock', async () => {
      const load = await aQuietLoad(6);
      // Found by loadId, not `[0]` — the scan is system-wide with no
      // tenant filter, so anything else quiet at the time this runs would
      // otherwise make this test order-dependent on data it does not own.
      const candidates = await findExceptionCandidates(db, 4);
      const candidate = candidates.find((c) => c.loadId === load.id);
      assert.ok(candidate);

      const first = await raiseExceptionAlert(db, candidate!);
      assert.equal(first, true);

      const second = await raiseExceptionAlert(db, candidate!);
      assert.equal(second, false, 'should not re-alert for the same silence window');

      const events = await readEvents(s, load.id);
      const alerts = events.filter((e) => e.verb === 'track.exception_alerted');
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!.explanation, /No check-in or position update/);

      // The load goes quiet again after new activity moves the baseline —
      // `lastActivityAt` has to land *after* the first alert's own
      // `occurredAt` for that to be true, not further in the past. The
      // dedup rule is "no alert since this activity"; backdating it again
      // would still be before the alert that already fired.
      const later: typeof candidate = {
        ...candidate!,
        lastActivityAt: new Date(),
      };
      const third = await raiseExceptionAlert(db, later);
      assert.equal(third, true, 'a fresh silence window should alert again');
    });
  });
});
