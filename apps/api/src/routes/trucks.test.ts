/**
 * The truck Motive-vehicle route, end to end.
 *
 * The claim worth a server for: a driver cannot set a match, a bad body
 * comes back 400 not a raw Zod dump, and a duplicate vehicle comes back as
 * a 409 a carrier can read rather than a raw constraint-violation message.
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

async function aTruck(orgId: string, label: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/trucks',
    headers: as(orgId),
    payload: { label },
  });
  return res.json().id as string;
}

suite('truck routes — Motive matching', () => {
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

  it('sets a Motive vehicle match', async () => {
    const orgId = await newOrg('Truck Route Carrier');
    const truckId = await aTruck(orgId, 'Truck 1');

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/trucks/${truckId}/motive-vehicle`,
      headers: as(orgId),
      payload: { motiveVehicleId: 998707 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().motiveVehicleId, 998707);
  });

  it('refuses a driver', async () => {
    const orgId = await newOrg('Truck Role Carrier');
    const truckId = await aTruck(orgId, 'Truck 1');
    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/trucks/${truckId}/motive-vehicle`,
      headers: as(orgId, driverUserId),
      payload: { motiveVehicleId: 1 },
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects a body with no motiveVehicleId field, not a 500', async () => {
    const orgId = await newOrg('Truck Bad Body Carrier');
    const truckId = await aTruck(orgId, 'Truck 1');

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/trucks/${truckId}/motive-vehicle`,
      headers: as(orgId),
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().explanation);
  });

  it('answers a duplicate vehicle with 409, not a raw constraint error', async () => {
    const orgId = await newOrg('Truck Duplicate Vehicle Carrier');
    const first = await aTruck(orgId, 'Truck 1');
    const second = await aTruck(orgId, 'Truck 2');

    await app.inject({
      method: 'PATCH',
      url: `/v1/trucks/${first}/motive-vehicle`,
      headers: as(orgId),
      payload: { motiveVehicleId: 42 },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/trucks/${second}/motive-vehicle`,
      headers: as(orgId),
      payload: { motiveVehicleId: 42 },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().explanation, /already matched/);
  });

  it('answers an unknown truck with 404', async () => {
    const orgId = await newOrg('Truck Not Found Carrier');
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/trucks/00000000-0000-0000-0000-000000000000/motive-vehicle',
      headers: as(orgId),
      payload: { motiveVehicleId: 1 },
    });
    assert.equal(res.statusCode, 404);
  });
});
