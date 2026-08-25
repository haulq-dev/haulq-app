/**
 * Brokers' routes, end to end.
 *
 * The claims worth a server for: a driver cannot set a detention threshold,
 * a bad body comes back 400 rather than a raw Zod dump, and — for verify —
 * the route 503s with no webkey configured rather than accepting an
 * unverified result, same posture every other optional external service in
 * this API takes.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** A stub FMCSA, so verify's happy path never reaches the real API in tests. */
let fmcsaServer: Server;
let fmcsaBase: string;
let fmcsaScript: { status: number; body: unknown };

const AUTHORIZED_CARRIER = {
  content: {
    carrier: {
      legalName: 'Prairie Freight LLC',
      allowedToOperate: 'Y',
    },
  },
};

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

  // --- docket ----------------------------------------------------------------

  it('sets a broker\'s MC number, normalizing the way signup already does', async () => {
    const orgId = await newOrg('Docket Carrier');
    const brokerId = await aBroker(orgId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/docket`,
      headers: as(orgId),
      payload: { mcNumber: 'MC-123456' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().mcNumber, '123456');
  });

  it('clears an MC number with null', async () => {
    const orgId = await newOrg('Docket Clear Carrier');
    const brokerId = await aBroker(orgId);
    await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/docket`,
      headers: as(orgId),
      payload: { mcNumber: '123456' },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/brokers/${brokerId}/docket`,
      headers: as(orgId),
      payload: { mcNumber: null },
    });
    assert.equal(res.json().mcNumber, null);
  });

  // --- verify ------------------------------------------------------------------
  //
  // FMCSA_WEBKEY/FMCSA_BASE_URL are server-level config, not per-request, so
  // this needs its own server instance pointed at the stub — `app` above has
  // neither set and stays that way, which is itself what the first test here
  // checks. Orgs/brokers created through `app` are visible through
  // `verifyApp` too; both point at the same test database.

  describe('verify', () => {
    let verifyApp: FastifyInstance;

    before(async () => {
      fmcsaServer = createServer((req, res) => {
        res.statusCode = fmcsaScript.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(fmcsaScript.body));
      });
      await new Promise<void>((resolve) => fmcsaServer.listen(0, '127.0.0.1', resolve));
      fmcsaBase = `http://127.0.0.1:${(fmcsaServer.address() as AddressInfo).port}`;

      verifyApp = await buildServer(
        loadEnv({
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: url!,
          FMCSA_WEBKEY: 'test-key',
          FMCSA_BASE_URL: fmcsaBase,
        }),
      );
    });

    after(async () => {
      fmcsaServer.close();
      await verifyApp.close();
    });

    it('refuses when no webkey is configured', async () => {
      // `app` (the module-level server) never sets FMCSA_WEBKEY.
      const orgId = await newOrg('Unconfigured Verify Co');
      const brokerId = await aBroker(orgId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/brokers/${brokerId}/verify`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 503);
    });

    it('refuses a broker with no MC or USDOT number on file', async () => {
      const orgId = await newOrg('No Docket Carrier');
      const brokerId = await aBroker(orgId);

      const res = await verifyApp.inject({
        method: 'POST',
        url: `/v1/brokers/${brokerId}/verify`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 422);
    });

    it('checks against FMCSA and records the result', async () => {
      fmcsaScript = { status: 200, body: AUTHORIZED_CARRIER };
      const orgId = await newOrg('Verify Happy Carrier');
      const brokerId = await aBroker(orgId);
      await verifyApp.inject({
        method: 'PATCH',
        url: `/v1/brokers/${brokerId}/docket`,
        headers: as(orgId),
        payload: { mcNumber: '123456' },
      });

      const res = await verifyApp.inject({
        method: 'POST',
        url: `/v1/brokers/${brokerId}/verify`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().verification.operatingStatus, 'Authorized');

      const read = await verifyApp.inject({
        method: 'GET',
        url: `/v1/brokers/${brokerId}/verification`,
        headers: as(orgId),
      });
      assert.equal(read.json().verification.operatingStatus, 'Authorized');
    });

    it('answers 502, not 500, when FMCSA fails', async () => {
      fmcsaScript = { status: 503, body: {} };
      const orgId = await newOrg('Verify Upstream Fail Carrier');
      const brokerId = await aBroker(orgId);
      await verifyApp.inject({
        method: 'PATCH',
        url: `/v1/brokers/${brokerId}/docket`,
        headers: as(orgId),
        payload: { mcNumber: '123456' },
      });

      const res = await verifyApp.inject({
        method: 'POST',
        url: `/v1/brokers/${brokerId}/verify`,
        headers: as(orgId),
      });
      assert.equal(res.statusCode, 502);
    });

    it('refuses a driver', async () => {
      const orgId = await newOrg('Verify Role Carrier');
      const brokerId = await aBroker(orgId);
      await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });
      await verifyApp.inject({
        method: 'PATCH',
        url: `/v1/brokers/${brokerId}/docket`,
        headers: as(orgId),
        payload: { mcNumber: '123456' },
      });

      const res = await verifyApp.inject({
        method: 'POST',
        url: `/v1/brokers/${brokerId}/verify`,
        headers: as(orgId, driverUserId),
      });
      assert.equal(res.statusCode, 403);
    });
  });
});
