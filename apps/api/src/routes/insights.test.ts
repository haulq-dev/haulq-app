/**
 * Insights' route, end to end.
 *
 * The repository (`packages/db/src/repositories/insights.test.ts`) already
 * covers the arithmetic and the query logic in depth. What's worth a server
 * for here is narrower: that `GET /v1/insights` actually wires `actionQueue`
 * into its response, and that it stays tenant-scoped like everything else —
 * not a full re-test of every field this route returns.
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
let userId: string;
const createdOrgs: string[] = [];

const as = (orgId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });

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

suite('insights routes', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  it('surfaces a delivered-but-unbilled load and an overdue invoice in the action queue', async () => {
    const orgId = await newOrg('Insights Route Carrier');

    const loadRes = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: {
        brokerName: 'Prairie Freight',
        source: 'csv_import',
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      },
    });
    const load = loadRes.json() as { id: string; reference: number };

    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await app.inject({
      method: 'PATCH',
      url: `/v1/loads/${load.id}/status`,
      headers: as(orgId),
      payload: { status: 'delivered', occurredAt: tenDaysAgo },
    });

    // A second, already-invoiced-and-overdue load, so both queues have
    // something real to report in the same call. Needs a truck — this one
    // isn't `csv_import`, and `loads_dispatched_has_truck` requires one for
    // any real (non-imported) load at delivered or later.
    const truckRes = await app.inject({
      method: 'POST',
      url: '/v1/trucks',
      headers: as(orgId),
      payload: { label: 'Unit 1' },
    });
    const truckId = truckRes.json().id as string;
    const invoicedLoadRes = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: {
        status: 'delivered',
        brokerName: 'Prairie Freight',
        truckId,
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      },
    });
    const invoicedLoad = invoicedLoadRes.json() as { id: string; reference: number };
    const pastDue = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const invoiceRes = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: as(orgId),
      payload: {
        loadId: invoicedLoad.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 15000 }],
        dueAt: pastDue,
      },
    });
    const invoice = invoiceRes.json();
    await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/send`,
      headers: as(orgId),
    });

    const res = await app.inject({ method: 'GET', url: '/v1/insights', headers: as(orgId) });
    assert.equal(res.statusCode, 200);
    const { actionQueue } = res.json();

    assert.equal(actionQueue.deliveredNotInvoiced.length, 1);
    assert.equal(actionQueue.deliveredNotInvoiced[0].loadId, load.id);

    assert.equal(actionQueue.overdueInvoices.length, 1);
    assert.equal(actionQueue.overdueInvoices[0].invoiceId, invoice.id);
    assert.equal(actionQueue.overdueInvoices[0].loadReference, invoicedLoad.reference);
  });

  it('does not show one carrier another org\'s action queue', async () => {
    const orgId = await newOrg('Insights Owner Co');
    const otherOrgId = await newOrg('Insights Stranger Co');

    const loadRes = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: {
        brokerName: 'Prairie Freight',
        source: 'csv_import',
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      },
    });
    const load = loadRes.json() as { id: string };
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await app.inject({
      method: 'PATCH',
      url: `/v1/loads/${load.id}/status`,
      headers: as(orgId),
      payload: { status: 'delivered', occurredAt: tenDaysAgo },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/insights', headers: as(otherOrgId) });
    assert.deepEqual(res.json().actionQueue.deliveredNotInvoiced, []);
  });
});
