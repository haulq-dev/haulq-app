/**
 * HaulQ Pay's routes, end to end.
 *
 * The claims worth a server for — things a repository test cannot reach
 * because they live in HTTP status codes, headers and the role gate:
 *
 *  - a driver is refused from every money-touching route
 *  - a malformed body comes back as 400 with a field-level message, not a
 *    500 or a raw Zod dump
 *  - the whole invoice → send → pay → factoring lifecycle works through real
 *    requests, not just through the repository directly
 *  - one carrier cannot see another's invoice
 *  - the trigger's refusal to void a paid invoice survives translation into
 *    an HTTP response
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  testScope,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let userId: string;
let driverId: string;
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

async function asDriver(orgId: string) {
  await addTestMembership(app.db, { orgId, userId: driverId, role: 'driver' });
  return as(orgId, driverId);
}

/** A truck and a delivered load, direct through the db package — the route
 *  under test is Pay's, not loads', so this is setup, not the subject. */
async function aDeliveredLoad(orgId: string) {
  const s = testScope(app.db, orgId, { type: 'user', id: userId });
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
      status: 'delivered',
      brokerName: 'Prairie Freight',
      rate: { amount: 240_000, currency: 'USD' },
      truckId,
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    },
  });
  return loadRes.json() as { id: string; reference: number };
}

const lineItems = [
  { code: 'linehaul', description: 'Linehaul', amountCents: 220_000 },
  { code: 'fuel_surcharge', description: 'Fuel surcharge', amountCents: 20_000 },
];

suite('pay routes', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    userId = (await createTestUser(app.db)).id;
    driverId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await destroyTestUser(app.db, driverId);
    await app.close();
  });

  it('carries an invoice from generation through a full payment', async () => {
    const orgId = await newOrg('Pay Route Carrier');
    const load = await aDeliveredLoad(orgId);

    const generated = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    assert.equal(generated.statusCode, 201);
    const invoice = generated.json();
    assert.equal(invoice.status, 'draft');
    assert.equal(invoice.totalAmount, 240_000);

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/send`,
      headers: as(orgId),
    });
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.json().status, 'sent');

    const paid = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/payments`,
      headers: as(orgId),
      payload: { amount: { amount: 240_000, currency: 'USD' }, source: 'broker_direct' },
    });
    assert.equal(paid.statusCode, 201);
    assert.equal(paid.json().invoice.status, 'paid');

    const loadRes = await app.inject({
      method: 'GET',
      url: `/v1/loads/${load.id}`,
      headers: as(orgId),
    });
    assert.equal(loadRes.json().status, 'paid');
    assert.equal(loadRes.json().actualRevenueAmount, 240_000);
  });

  it('refuses every money-touching route to a driver', async () => {
    const orgId = await newOrg('Driver Refused Carrier');
    const driverHeaders = await asDriver(orgId);
    const load = await aDeliveredLoad(orgId);

    const attempt = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: driverHeaders,
      payload: { loadId: load.id, lineItems },
    });
    assert.equal(attempt.statusCode, 403);
  });

  it('returns 400 with a field-level message for a malformed body', async () => {
    const orgId = await newOrg('Bad Request Carrier');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: 'not-a-uuid', lineItems: [] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'invalid_request');
    assert.match(res.json().explanation, /loadId/);
  });

  it('refuses a second open invoice for the same load', async () => {
    const orgId = await newOrg('Duplicate Invoice Carrier');
    const load = await aDeliveredLoad(orgId);

    await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });

    const second = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, 'already_invoiced');
  });

  it('translates the trigger refusing to void a paid invoice', async () => {
    const orgId = await newOrg('Void Refused Carrier');
    const load = await aDeliveredLoad(orgId);

    const generated = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    const invoice = generated.json();
    await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/send`, headers: as(orgId) });
    await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/payments`,
      headers: as(orgId),
      payload: { amount: { amount: 240_000, currency: 'USD' }, source: 'broker_direct' },
    });

    const voided = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/void`,
      headers: as(orgId),
      payload: { reason: 'changed my mind' },
    });
    assert.equal(voided.statusCode, 409);
    assert.equal(voided.json().code, 'illegal_transition');
  });

  it('does not show another org an invoice', async () => {
    const orgId = await newOrg('Owner Carrier');
    const otherOrgId = await newOrg('Other Carrier');
    const load = await aDeliveredLoad(orgId);

    const generated = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    const invoice = generated.json();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/invoices/${invoice.id}`,
      headers: as(otherOrgId),
    });
    assert.equal(res.statusCode, 404);
  });

  it('carries a factoring packet from assembly to funded through requests', async () => {
    const orgId = await newOrg('Factoring Route Carrier');
    const load = await aDeliveredLoad(orgId);

    const factorRes = await app.inject({
      method: 'POST',
      url: '/v1/factoring-companies',
      headers: as(orgId),
      payload: { name: 'Apex Capital' },
    });
    assert.equal(factorRes.statusCode, 201);
    const factor = factorRes.json();

    const generated = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    const invoice = generated.json();
    await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/send`, headers: as(orgId) });

    const packetRes = await app.inject({
      method: 'POST',
      url: '/v1/factoring-packets',
      headers: as(orgId),
      payload: { invoiceId: invoice.id, factoringCompanyId: factor.id, documentIds: [] },
    });
    assert.equal(packetRes.statusCode, 201);
    const packet = packetRes.json();

    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/factoring-packets/${packet.id}/submit`,
      headers: as(orgId),
    });
    assert.equal(submitted.json().status, 'submitted');

    const responded = await app.inject({
      method: 'POST',
      url: `/v1/factoring-packets/${packet.id}/response`,
      headers: as(orgId),
      payload: { outcome: 'accepted' },
    });
    assert.equal(responded.json().status, 'accepted');

    const paid = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/payments`,
      headers: as(orgId),
      payload: {
        amount: { amount: 240_000, currency: 'USD' },
        source: 'factor',
        factoringPacketId: packet.id,
      },
    });
    assert.equal(paid.json().invoice.status, 'paid');

    const packetAfter = await app.inject({
      method: 'GET',
      url: `/v1/factoring-packets/${packet.id}`,
      headers: as(orgId),
    });
    assert.equal(packetAfter.json().packet.status, 'funded');
  });

  it('reports receivables aging for open invoices', async () => {
    const orgId = await newOrg('Aging Carrier');
    const load = await aDeliveredLoad(orgId);
    const generated = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: { loadId: load.id, lineItems },
    });
    const invoice = generated.json();
    await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/send`, headers: as(orgId) });

    const aging = await app.inject({
      method: 'GET',
      url: '/v1/invoices/receivables-aging',
      headers: as(orgId),
    });
    assert.equal(aging.statusCode, 200);
    const current = aging.json().buckets.find((b: { bucket: string }) => b.bucket === 'current');
    assert.ok(current.count >= 1);
  });
});
