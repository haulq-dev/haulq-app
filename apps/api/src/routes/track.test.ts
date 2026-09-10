/**
 * Track's routes, end to end.
 *
 * The claims worth a server for — things a repository test cannot reach:
 *
 *  - a driver cannot issue or revoke a link; owner and dispatcher can
 *  - the public routes work with no auth headers at all — that is the point
 *  - a bad token comes back 404, a revoked one 410, not a 500
 *  - a check-in write actually lands on `load_stops` reachable through the
 *    ordinary authenticated `GET /v1/loads/:id`
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addTestMembership, createTestUser, destroyTestOrg, destroyTestUser } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let userId: string;
let driverUserId: string;
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const as = (orgId: string, actingUserId = userId) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': actingUserId,
});

async function newOrg(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const id = res.json().org.id as string;
  createdOrgs.push(id);
  return id;
}

async function aDispatchedLoad(orgId: string) {
  const truckRes = await app.inject({
    method: 'POST',
    url: '/v1/trucks',
    headers: as(orgId),
    payload: { label: 'Truck 1' },
  });
  const truckId = truckRes.json().id as string;

  const loadRes = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: as(orgId),
    payload: {
      status: 'dispatched',
      brokerName: 'Prairie Freight',
      truckId,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    },
  });
  return loadRes.json() as {
    id: string;
    reference: number;
    stops: Array<{ id: string; seq: number }>;
  };
}

suite('track routes', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    userId = (await createTestUser(app.db)).id;
    driverUserId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of createdUsers) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, userId);
    await destroyTestUser(app.db, driverUserId);
    await app.close();
  });

  it('issues a checkin link and previews it with no auth headers', async () => {
    const orgId = await newOrg('Track Route Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    assert.equal(issued.statusCode, 201);
    const { token } = issued.json() as { token: string };

    const preview = await app.inject({ method: 'GET', url: `/v1/checkin/${token}` });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().loadReference, load.reference);
  });

  it('issues a checkin link with no payload at all, not just an empty one', async () => {
    // The real bug this guards: `payload: {}` above sends an actual `{}`
    // body, which always validated fine. A caller that omits the body
    // entirely (the web app's own API client does exactly this) sends no
    // bytes at all, and Fastify's JSON parser hands that through as `null`
    // — which `IssueCheckinLinkSchema.optional()` rejected even though the
    // route's own comment says a bare POST is the common case. Needs
    // `.nullish()`. See the note at the schema's usage in this route.
    const orgId = await newOrg('Track No Payload Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
    });
    assert.equal(issued.statusCode, 201);
  });

  it('refuses a driver issuing a checkin link', async () => {
    const orgId = await newOrg('Track Role Carrier');
    const load = await aDispatchedLoad(orgId);

    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId, driverUserId),
      payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  it('records a stop check-in reachable from the ordinary load read', async () => {
    const orgId = await newOrg('Track Checkin Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token } = issued.json() as { token: string };
    const pickupId = load.stops.find((s) => s.seq === 1)!.id;

    const checkin = await app.inject({
      method: 'POST',
      url: `/v1/checkin/${token}/stops/${pickupId}`,
      payload: { milestone: 'arrived' },
    });
    assert.equal(checkin.statusCode, 200);

    const reread = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}`,
      headers: as(orgId),
    });
    const stop = reread.json().stops.find((s: { id: string }) => s.id === pickupId);
    assert.ok(stop.arrivedAt);
    assert.equal(stop.arrivalSource, 'driver_app');
  });

  it('undoes a mis-tapped stop check-in, and refuses a second undo with nothing left to undo', async () => {
    const orgId = await newOrg('Track Undo Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token } = issued.json() as { token: string };
    const pickupId = load.stops.find((s) => s.seq === 1)!.id;

    await app.inject({
      method: 'POST',
      url: `/v1/checkin/${token}/stops/${pickupId}`,
      payload: { milestone: 'arrived' },
    });

    const undo = await app.inject({
      method: 'POST',
      url: `/v1/checkin/${token}/stops/${pickupId}/undo`,
      payload: { milestone: 'arrived' },
    });
    assert.equal(undo.statusCode, 200);

    const reread = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}`,
      headers: as(orgId),
    });
    const stop = reread.json().stops.find((s: { id: string }) => s.id === pickupId);
    assert.equal(stop.arrivedAt, null);
    assert.equal(stop.arrivalSource, null);

    const secondUndo = await app.inject({
      method: 'POST',
      url: `/v1/checkin/${token}/stops/${pickupId}/undo`,
      payload: { milestone: 'arrived' },
    });
    assert.equal(secondUndo.statusCode, 422);
    assert.equal(secondUndo.json().code, 'not_set');
  });

  it('records a position ping and revokes a checkin link', async () => {
    const orgId = await newOrg('Track Position Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token } = issued.json() as { token: string };

    const ping = await app.inject({
      method: 'POST',
      url: `/v1/checkin/${token}/position`,
      payload: { lat: 39.0997, lng: -94.5786 },
    });
    assert.equal(ping.statusCode, 204);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
    });
    assert.equal(revoke.statusCode, 204);

    const afterRevoke = await app.inject({ method: 'GET', url: `/v1/checkin/${token}` });
    assert.equal(afterRevoke.statusCode, 410);
  });

  it('resolves and persists city/state from a reverse geocoder when one is configured', async () => {
    const orgId = await newOrg('Track Reverse Geocode Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token } = issued.json() as { token: string };

    // A second server instance, same database, with a reverse geocoder the
    // shared `app` above deliberately has none of — proves the route calls
    // it and passes the result through, without restructuring every other
    // test in this file around a HERE dependency they don't need.
    const geocoded = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      reverseGeocoder: {
        reverseGeocode: async () => ({ city: 'Kansas City', state: 'MO' }),
      },
    });
    try {
      const ping = await geocoded.inject({
        method: 'POST',
        url: `/v1/checkin/${token}/position`,
        payload: { lat: 39.0997, lng: -94.5786 },
      });
      assert.equal(ping.statusCode, 204);
    } finally {
      await geocoded.close();
    }

    const visibility = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/visibility-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token: trackToken } = visibility.json() as { token: string };
    const tracking = await app.inject({ method: 'GET', url: `/v1/track/${trackToken}` });

    assert.equal(tracking.json().truck.currentCity, 'Kansas City');
    assert.equal(tracking.json().truck.currentState, 'MO');
  });

  it('records the position even when the reverse geocoder itself fails', async () => {
    const orgId = await newOrg('Track Reverse Geocode Failure Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/checkin-links`,
      headers: as(orgId),
      payload: {},
    });
    const { token } = issued.json() as { token: string };

    const geocoded = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      reverseGeocoder: {
        reverseGeocode: async () => {
          throw new Error('HERE is down');
        },
      },
    });
    try {
      const ping = await geocoded.inject({
        method: 'POST',
        url: `/v1/checkin/${token}/position`,
        payload: { lat: 39.0997, lng: -94.5786 },
      });
      // The position write itself must not fail just because the
      // enrichment call did.
      assert.equal(ping.statusCode, 204);
    } finally {
      await geocoded.close();
    }
  });

  it('serves a broker tracking page with no auth headers', async () => {
    const orgId = await newOrg('Track Visibility Carrier');
    const load = await aDispatchedLoad(orgId);

    const issued = await app.inject({
      method: 'POST',
      url: `/v1/loads/${load.id}/visibility-links`,
      headers: as(orgId),
      payload: {},
    });
    assert.equal(issued.statusCode, 201);
    const { token } = issued.json() as { token: string };

    const view = await app.inject({ method: 'GET', url: `/v1/track/${token}` });
    assert.equal(view.statusCode, 200);
    assert.equal(view.json().loadReference, load.reference);
    assert.equal(view.json().truck.label, 'Truck 1');
  });

  it('answers an unknown tracking token with 404, not 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/track/not-a-real-token' });
    assert.equal(res.statusCode, 404);
    assert.ok(res.json().explanation);
  });

  // --- a signed-in driver's own account, not an anonymous link --------------

  describe('an authenticated driver reporting through their own account', () => {
    async function linkedDriver(orgId: string): Promise<{ driverId: string; userId: string }> {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/drivers',
        headers: as(orgId),
        payload: { fullName: 'Authed Driver' },
      });
      const driverId = created.json().id as string;

      const user = await createTestUser(app.db);
      createdUsers.push(user.id);
      const invited = await app.inject({
        method: 'POST',
        url: '/v1/members/invites',
        headers: as(orgId),
        payload: { email: `${user.id}@example.test`, role: 'driver', driverId },
      });
      const token = invited.json().token as string;
      await app.inject({
        method: 'POST',
        url: `/v1/invitations/${token}/accept`,
        headers: { 'x-haulq-user-id': user.id },
      });

      return { driverId, userId: user.id };
    }

    async function aDispatchedLoadForDriver(orgId: string, driverId: string) {
      const truckRes = await app.inject({
        method: 'POST',
        url: '/v1/trucks',
        headers: as(orgId),
        payload: { label: 'Truck 2' },
      });
      const truckId = truckRes.json().id as string;

      const loadRes = await app.inject({
        method: 'POST',
        url: '/v1/loads',
        headers: as(orgId),
        payload: {
          status: 'dispatched',
          brokerName: 'Prairie Freight',
          truckId,
          driverId,
          stops: [
            { type: 'pickup', city: 'Wichita', state: 'KS' },
            { type: 'delivery', city: 'Denver', state: 'CO' },
          ],
        },
      });
      return loadRes.json() as {
        id: string;
        reference: number;
        stops: Array<{ id: string; seq: number }>;
      };
    }

    it("records a stop milestone under the driver's own name, not driver_checkin_link", async () => {
      const orgId = await newOrg('Authed Checkin Carrier');
      const { driverId, userId } = await linkedDriver(orgId);
      const load = await aDispatchedLoadForDriver(orgId, driverId);
      const pickupId = load.stops.find((s) => s.seq === 1)!.id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/stops/${pickupId}/checkin`,
        headers: as(orgId, userId),
        payload: { milestone: 'arrived' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().stop.arrivedAt);

      const timeline = await app.inject({
        method: 'GET',
        url: `/v1/timeline?subjectType=load&subjectId=${load.id}`,
        headers: as(orgId),
      });
      const entries = timeline.json().items as Array<{
        verb: string;
        actorType: string;
        actorId: string | null;
      }>;
      // `actorId` displays a user's email, not their raw id (see
      // `context.ts`'s `actorId`) — the dev-mode stub hardcodes that email
      // rather than looking it up, so the provable thing here is the actor
      // *kind*: `user`, not the anonymous link's `driver_checkin_link`.
      const checkin = entries.find((e) => e.verb === 'load_stop.checkin');
      assert.equal(checkin?.actorType, 'user');
      assert.notEqual(checkin?.actorId, 'driver_checkin_link');
    });

    it('undoes its own mis-tapped milestone', async () => {
      const orgId = await newOrg('Authed Undo Carrier');
      const { driverId, userId } = await linkedDriver(orgId);
      const load = await aDispatchedLoadForDriver(orgId, driverId);
      const pickupId = load.stops.find((s) => s.seq === 1)!.id;

      await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/stops/${pickupId}/checkin`,
        headers: as(orgId, userId),
        payload: { milestone: 'arrived' },
      });

      const undo = await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/stops/${pickupId}/checkin/undo`,
        headers: as(orgId, userId),
        payload: { milestone: 'arrived' },
      });
      assert.equal(undo.statusCode, 200);
      assert.equal(undo.json().stop.arrivedAt, null);
    });

    it("404s a driver tapping a milestone on a load that isn't theirs", async () => {
      const orgId = await newOrg('Authed Wrong Load Carrier');
      const { userId } = await linkedDriver(orgId);
      const otherDriverId = (
        await app.inject({
          method: 'POST',
          url: '/v1/drivers',
          headers: as(orgId),
          payload: { fullName: 'Someone Else' },
        })
      ).json().id as string;
      const othersLoad = await aDispatchedLoadForDriver(orgId, otherDriverId);
      const pickupId = othersLoad.stops.find((s) => s.seq === 1)!.id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${othersLoad.id}/stops/${pickupId}/checkin`,
        headers: as(orgId, userId),
        payload: { milestone: 'arrived' },
      });
      assert.equal(res.statusCode, 404);
    });

    it('refuses a non-driver role at these routes even inside the right org', async () => {
      const orgId = await newOrg('Authed Role Carrier');
      const { driverId } = await linkedDriver(orgId);
      const load = await aDispatchedLoadForDriver(orgId, driverId);
      const pickupId = load.stops.find((s) => s.seq === 1)!.id;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/stops/${pickupId}/checkin`,
        headers: as(orgId), // the owner, not the linked driver
        payload: { milestone: 'arrived' },
      });
      assert.equal(res.statusCode, 403);
    });

    it("records a position ping against the load's own truck", async () => {
      const orgId = await newOrg('Authed Position Carrier');
      const { driverId, userId } = await linkedDriver(orgId);
      const load = await aDispatchedLoadForDriver(orgId, driverId);

      const ping = await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/position`,
        headers: as(orgId, userId),
        payload: { lat: 39.0997, lng: -94.5786 },
      });
      assert.equal(ping.statusCode, 204);
    });

    it('refuses a position ping for a load with no truck assigned yet', async () => {
      const orgId = await newOrg('Authed No Truck Carrier');
      const { driverId, userId } = await linkedDriver(orgId);

      const loadRes = await app.inject({
        method: 'POST',
        url: '/v1/loads',
        headers: as(orgId),
        payload: {
          brokerName: 'Prairie Freight',
          driverId,
          stops: [
            { type: 'pickup', city: 'Wichita', state: 'KS' },
            { type: 'delivery', city: 'Denver', state: 'CO' },
          ],
        },
      });
      const load = loadRes.json() as { id: string };

      const ping = await app.inject({
        method: 'POST',
        url: `/v1/loads/${load.id}/position`,
        headers: as(orgId, userId),
        payload: { lat: 39.0997, lng: -94.5786 },
      });
      assert.equal(ping.statusCode, 422);
      assert.equal(ping.json().code, 'no_truck');
    });
  });
});
