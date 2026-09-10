/**
 * Loads, end to end — the driver-scoping added on top of the ordinary
 * owner/dispatcher routes.
 *
 * The claims worth a server for — things a repository test cannot reach:
 *
 *  - a `driver`-role login only ever sees loads assigned to their own
 *    linked `drivers` row, never the rest of the org's
 *  - a driver probing another driver's load id gets the same 404 a
 *    genuinely missing load would
 *  - a driver whose login is not yet linked to any roster row sees nothing,
 *    rather than an error or the whole org's loads
 *  - margin/rate stays owner/dispatcher/accountant business, blocked
 *    outright rather than merely scoped
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestUser, destroyTestOrg, destroyTestUser } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let ownerId: string;
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const as = (orgId: string, userId = ownerId, role?: string) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...(role ? { 'x-haulq-role': role } : {}),
});

async function newOrg(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': ownerId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const id = res.json().org.id as string;
  createdOrgs.push(id);
  return id;
}

async function newUser() {
  const u = await createTestUser(app.db);
  createdUsers.push(u.id);
  return u;
}

async function newDriver(orgId: string, fullName: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/drivers',
    headers: as(orgId),
    payload: { fullName },
  });
  return res.json().id as string;
}

/** Invites a driver-role login linked to `driverId`, and accepts it as `userId`. */
async function linkDriver(orgId: string, driverId: string, userId: string): Promise<void> {
  const invited = await app.inject({
    method: 'POST',
    url: '/v1/members/invites',
    headers: as(orgId),
    payload: { email: `${userId}@example.test`, role: 'driver', driverId },
  });
  const token = invited.json().token as string;
  const accepted = await app.inject({
    method: 'POST',
    url: `/v1/invitations/${token}/accept`,
    headers: { 'x-haulq-user-id': userId },
  });
  assert.equal(accepted.statusCode, 200, 'test setup: linking the driver should succeed');
}

async function newLoad(orgId: string, driverId?: string) {
  // No `status`/`truckId` — the default `prospect` status is enough to
  // exercise driver-scoped reads, and skips the "dispatched needs a truck"
  // schema rule that is unrelated to what these tests check.
  const res = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: as(orgId),
    payload: {
      brokerName: 'Prairie Freight',
      ...(driverId ? { driverId } : {}),
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    },
  });
  return res.json() as { id: string; reference: number };
}

suite('loads routes — driver scoping', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    ownerId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of createdUsers) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, ownerId);
    await app.close();
  });

  it('lists only a driver\'s own assigned load, not the whole org\'s', async () => {
    const orgId = await newOrg('Scope Co');
    const driverAId = await newDriver(orgId, 'Driver A');
    const driverBId = await newDriver(orgId, 'Driver B');
    const driverAUser = await newUser();
    const driverBUser = await newUser();
    await linkDriver(orgId, driverAId, driverAUser.id);
    await linkDriver(orgId, driverBId, driverBUser.id);

    const loadA = await newLoad(orgId, driverAId);
    await newLoad(orgId, driverBId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/loads',
      headers: as(orgId, driverAUser.id),
    });
    assert.equal(res.statusCode, 200);
    const items = res.json().items as Array<{ id: string }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, loadA.id);
  });

  it('sees nothing when the driver login has no linked roster row', async () => {
    const orgId = await newOrg('Unlinked Co');
    const driverId = await newDriver(orgId, 'Roster Only');
    await newLoad(orgId, driverId);

    const strangerUser = await newUser();
    // No invite/link for this user — same role header a driver's real token
    // would carry, but nothing on `drivers.user_id` points at them.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/loads',
      headers: as(orgId, strangerUser.id, 'driver'),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items, []);
  });

  it('404s a driver reading another driver\'s load by id, same as a missing one', async () => {
    const orgId = await newOrg('Peek Co');
    const driverAId = await newDriver(orgId, 'Driver A2');
    const driverBId = await newDriver(orgId, 'Driver B2');
    const driverAUser = await newUser();
    await linkDriver(orgId, driverAId, driverAUser.id);

    const loadB = await newLoad(orgId, driverBId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/loads/${loadB.id}`,
      headers: as(orgId, driverAUser.id),
    });
    assert.equal(res.statusCode, 404);
  });

  it('lets a driver read their own load by id and its tracking', async () => {
    const orgId = await newOrg('Own Load Co');
    const driverId = await newDriver(orgId, 'Driver C');
    const driverUser = await newUser();
    await linkDriver(orgId, driverId, driverUser.id);
    const load = await newLoad(orgId, driverId);

    const got = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}`,
      headers: as(orgId, driverUser.id),
    });
    assert.equal(got.statusCode, 200);

    const tracking = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}/tracking`,
      headers: as(orgId, driverUser.id),
    });
    assert.equal(tracking.statusCode, 200);
  });

  it('blocks a driver from a load\'s margin outright', async () => {
    const orgId = await newOrg('Margin Co');
    const driverId = await newDriver(orgId, 'Driver D');
    const driverUser = await newUser();
    await linkDriver(orgId, driverId, driverUser.id);
    const load = await newLoad(orgId, driverId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}/margin`,
      headers: as(orgId, driverUser.id),
    });
    assert.equal(res.statusCode, 403);
  });

  it('does not change owner/dispatcher behavior — they still see every load', async () => {
    const orgId = await newOrg('Unrestricted Co');
    const driverAId = await newDriver(orgId, 'Driver E');
    const driverBId = await newDriver(orgId, 'Driver F');
    await newLoad(orgId, driverAId);
    await newLoad(orgId, driverBId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/loads',
      headers: as(orgId),
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json().items as unknown[]).length, 2);
  });
});
