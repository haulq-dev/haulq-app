/**
 * Editing and removing drivers, end to end (MOBILE_PARITY_PLAN.md M4).
 *
 * The claims worth a server: a renewed credential can be recorded and clears
 * the expiring warning, `null` clears a field while absent leaves it alone, a
 * driver still on a booked load can't be removed out from under it, and a
 * driver login can do neither.
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

async function newDriver(orgId: string, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/drivers', headers: as(orgId), payload: body });
  assert.equal(res.statusCode, 201);
  return res.json().id as string;
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

suite('driver routes — edit and remove', () => {
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

  it('records a renewed medical card, which clears the expiring warning', async () => {
    const orgId = await newOrg('Driver Edit Co');
    const id = await newDriver(orgId, { fullName: 'Rosa Diaz', phone: '555-0100', medicalCardExpiresAt: inDays(5) });

    const before_ = await app.inject({ method: 'GET', url: '/v1/drivers/expiring?days=30', headers: as(orgId) });
    assert.equal(before_.json().items.length, 1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/drivers/${id}`,
      headers: as(orgId),
      payload: { medicalCardExpiresAt: inDays(700), phone: null },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().phone, null, 'null clears');
    assert.equal(res.json().fullName, 'Rosa Diaz', 'absent leaves it alone');

    const after_ = await app.inject({ method: 'GET', url: '/v1/drivers/expiring?days=30', headers: as(orgId) });
    assert.equal(after_.json().items.length, 0);
  });

  it('refuses an empty update with a readable 400', async () => {
    const orgId = await newOrg('Driver Empty Co');
    const id = await newDriver(orgId, { fullName: 'Sam' });
    const res = await app.inject({ method: 'PATCH', url: `/v1/drivers/${id}`, headers: as(orgId), payload: {} });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().explanation);
  });

  it('will not remove a driver who is on a booked load, and names the load', async () => {
    const orgId = await newOrg('Driver Busy Co');
    const id = await newDriver(orgId, { fullName: 'Busy Bee' });
    const load = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: {
        status: 'booked',
        driverId: id,
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      },
    });
    assert.equal(load.statusCode, 201, load.body);

    const res = await app.inject({ method: 'DELETE', url: `/v1/drivers/${id}`, headers: as(orgId) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'on_active_load');
    assert.match(res.json().explanation, new RegExp(`load ${load.json().reference}`));
  });

  it('takes a free driver off the roster, and they drop out of the list', async () => {
    const orgId = await newOrg('Driver Remove Co');
    const id = await newDriver(orgId, { fullName: 'Gone Soon' });

    const res = await app.inject({ method: 'DELETE', url: `/v1/drivers/${id}`, headers: as(orgId) });
    assert.equal(res.statusCode, 204);

    const list = await app.inject({ method: 'GET', url: '/v1/drivers', headers: as(orgId) });
    assert.equal(list.json().items.length, 0);

    const again = await app.inject({ method: 'PATCH', url: `/v1/drivers/${id}`, headers: as(orgId), payload: { fullName: 'Back' } });
    assert.equal(again.statusCode, 404);
  });

  it('refuses a driver login', async () => {
    const orgId = await newOrg('Driver Role Co');
    const id = await newDriver(orgId, { fullName: 'Someone' });
    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });
    const patch = await app.inject({ method: 'PATCH', url: `/v1/drivers/${id}`, headers: as(orgId, driverUserId), payload: { fullName: 'X' } });
    assert.equal(patch.statusCode, 403);
    const del = await app.inject({ method: 'DELETE', url: `/v1/drivers/${id}`, headers: as(orgId, driverUserId) });
    assert.equal(del.statusCode, 403);
  });
});
