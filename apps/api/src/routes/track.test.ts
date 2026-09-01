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
});
