/**
 * Core's limit on trucks in service (`CORE_TRUCK_LIMIT`), enforced on adding
 * a truck and on bringing one back into service. Fleet has none.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestUser, destroyTestOrg, destroyTestUser, setTestOrgPlan } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';
import { CORE_TRUCK_LIMIT } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

suite('Core truck limit', () => {
  let app: FastifyInstance;
  let userId: string;
  const createdOrgs: string[] = [];

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  async function newOrg(plan: 'carrier' | 'fleet' | null) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': userId },
      payload: { name: 'Truck Limit Carrier', contactEmail: 'owner@example.com' },
    });
    const orgId = res.json().org.id as string;
    createdOrgs.push(orgId);
    if (plan) await setTestOrgPlan(app.db, { orgId, plan }); // a new org starts with no plan
    return orgId;
  }

  const headers = (orgId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });
  const addTruck = (orgId: string, label: string) =>
    app.inject({ method: 'POST', url: '/v1/trucks', headers: headers(orgId), payload: { label } });
  const setActive = (orgId: string, id: string, active: boolean) =>
    app.inject({ method: 'PATCH', url: `/v1/trucks/${id}/active`, headers: headers(orgId), payload: { active } });

  it(`lets Core run ${CORE_TRUCK_LIMIT} trucks and refuses the next, without naming a plan or price`, async () => {
    const orgId = await newOrg('carrier');
    for (let i = 1; i <= CORE_TRUCK_LIMIT; i++) {
      assert.equal((await addTruck(orgId, `T${i}`)).statusCode, 201);
    }
    const refused = await addTruck(orgId, 'One too many');
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, 'truck_limit_reached');
    // The iPhone app shows this verbatim (App Review 3.1.1).
    assert.doesNotMatch(refused.json().explanation, /fleet|core|plan|upgrade|price|\$|haulq\.ai/i);
  });

  it('counts only trucks in service, and holds the line on bringing one back', async () => {
    const orgId = await newOrg('carrier');
    const ids: string[] = [];
    for (let i = 1; i <= CORE_TRUCK_LIMIT; i++) ids.push((await addTruck(orgId, `T${i}`)).json().id);

    assert.equal((await setActive(orgId, ids[0]!, false)).statusCode, 200);
    assert.equal((await addTruck(orgId, 'Replacement')).statusCode, 201, 'room again after one left service');

    const back = await setActive(orgId, ids[0]!, true);
    assert.equal(back.statusCode, 403);
    assert.equal(back.json().code, 'truck_limit_reached');
  });

  it('treats a carrier with no plan yet like Core', async () => {
    const orgId = await newOrg(null);
    for (let i = 1; i <= CORE_TRUCK_LIMIT; i++) await addTruck(orgId, `T${i}`);
    assert.equal((await addTruck(orgId, 'Extra')).statusCode, 403);
  });

  it('puts no limit on Fleet', async () => {
    const orgId = await newOrg('fleet');
    for (let i = 1; i <= CORE_TRUCK_LIMIT + 2; i++) {
      assert.equal((await addTruck(orgId, `T${i}`)).statusCode, 201);
    }
  });
});
