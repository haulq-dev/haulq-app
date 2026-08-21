/**
 * Brokers' one route, end to end.
 *
 * The claim worth a server for: a driver cannot set a detention threshold,
 * and a bad body comes back 400 rather than a raw Zod dump.
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

/** A broker is created implicitly the first time a load names one. */
async function aBroker(orgId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: as(orgId),
    payload: {
      brokerName: 'Prairie Freight',
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    },
  });
  return (res.json().brokerId as string) ?? '';
}

suite('broker routes', () => {
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

  it('sets a detention threshold', async () => {
    const orgId = await newOrg('Broker Route Carrier');
    const brokerId = await aBroker(orgId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/detention-threshold`,
      headers: as(orgId),
      payload: { freeMinutes: 90 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().detentionFreeMinutes, 90);
  });

  it('refuses a driver', async () => {
    const orgId = await newOrg('Broker Role Carrier');
    const brokerId = await aBroker(orgId);
    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/detention-threshold`,
      headers: as(orgId, driverUserId),
      payload: { freeMinutes: 90 },
    });
    assert.equal(res.statusCode, 403);
  });

  it('rejects a body with no freeMinutes field, not a 500', async () => {
    const orgId = await newOrg('Broker Bad Body Carrier');
    const brokerId = await aBroker(orgId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/detention-threshold`,
      headers: as(orgId),
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().explanation);
  });

  it('answers an unknown broker with 404', async () => {
    const orgId = await newOrg('Broker Not Found Carrier');
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/brokers/00000000-0000-0000-0000-000000000000/detention-threshold',
      headers: as(orgId),
      payload: { freeMinutes: 90 },
    });
    assert.equal(res.statusCode, 404);
  });
});
