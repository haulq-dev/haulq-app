/**
 * The account-wide money reads are office-only.
 *
 * Found while scoping MOBILE_PARITY_PLAN.md M5: insights, the timeline,
 * usage, operating costs and the imported-history summary had no role
 * check, so any driver login could read revenue by broker, overdue invoices
 * and the carrier's cost per mile. The same gap M2 closed for documents.
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
let ownerId: string;
let driverId: string;
let accountantId: string;
let orgId: string;

const as = (userId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });

const MONEY_READS = [
  '/v1/insights?days=90',
  '/v1/timeline',
  '/v1/usage',
  '/v1/org/operating-facts',
  '/v1/imports/history-summary',
];

suite('account-wide money reads — driver scope', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    ownerId = (await createTestUser(app.db)).id;
    driverId = (await createTestUser(app.db)).id;
    accountantId = (await createTestUser(app.db)).id;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': ownerId },
      payload: { name: 'Money Reads Co', contactEmail: 'owner@example.com' },
    });
    orgId = res.json().org.id as string;
    await addTestMembership(app.db, { orgId, userId: driverId, role: 'driver' });
    await addTestMembership(app.db, { orgId, userId: accountantId, role: 'accountant' });
  });

  after(async () => {
    await destroyTestOrg(app.db, orgId);
    for (const id of [ownerId, driverId, accountantId]) await destroyTestUser(app.db, id);
    await app.close();
  });

  for (const path of MONEY_READS) {
    it(`refuses a driver ${path}, and answers an accountant`, async () => {
      const refused = await app.inject({ method: 'GET', url: path, headers: as(driverId) });
      assert.equal(refused.statusCode, 403, refused.body);
      assert.equal(refused.json().code, 'forbidden');

      const allowed = await app.inject({ method: 'GET', url: path, headers: as(accountantId) });
      assert.equal(allowed.statusCode, 200, allowed.body);
    });
  }

  it('still lets a driver read the carrier profile (the intake address) and the checklist', async () => {
    for (const path of ['/v1/org/profile', '/v1/onboarding']) {
      const res = await app.inject({ method: 'GET', url: path, headers: as(driverId) });
      assert.equal(res.statusCode, 200, `${path}: ${res.body}`);
    }
  });
});
