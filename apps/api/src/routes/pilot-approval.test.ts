/**
 * The pilot gate on subscribing (`REQUIRE_PILOT_APPROVAL`): a new carrier can
 * sign up but not reach Checkout until `approvePilot` has run, and a carrier
 * that has subscribed before is never held back.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  approvePilot,
  closeDatabase,
  createDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  getTestOrgEntitlements,
  listPendingPilots,
  setTestOrgStatus,
  setTestOrgStripeCustomer,
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { BillingClient } from '../billing/stripe.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

/** Stands in for Stripe: every Checkout Session gets a URL, and nothing leaves the process. */
const fakeBilling = {
  client: { checkout: { sessions: { create: async () => ({ url: 'https://checkout.stripe.test/session' }) } } },
  priceIds: { carrier: 'price_test_core' },
} as unknown as BillingClient;

function newApp(requireApproval: 'true' | 'false' | undefined): Promise<FastifyInstance> {
  const { REQUIRE_PILOT_APPROVAL: _drop, STRIPE_SECRET_KEY: _stripe, ...env } = process.env;
  return buildServer(
    loadEnv({
      ...env,
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      ...(requireApproval ? { REQUIRE_PILOT_APPROVAL: requireApproval } : {}),
    }),
    { billing: fakeBilling },
  );
}

suite('pilot approval', () => {
  let db: Database;
  let app: FastifyInstance;
  let userId: string;
  const createdOrgs: string[] = [];

  before(async () => {
    db = createDatabase({ url: url! });
    userId = (await createTestUser(db)).id;
    app = await newApp(undefined); // the default: approval required
  });

  after(async () => {
    await app.close();
    for (const id of createdOrgs) await destroyTestOrg(db, id);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  async function newOrg(on: FastifyInstance = app): Promise<string> {
    const res = await on.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': userId },
      payload: { name: 'Pilot Applicant Carrier', contactEmail: 'owner@example.com' },
    });
    const orgId = res.json().org.id as string;
    createdOrgs.push(orgId);
    return orgId;
  }

  const headers = (orgId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });
  const checkout = (orgId: string, on: FastifyInstance = app) =>
    on.inject({ method: 'POST', url: '/v1/billing/checkout', headers: headers(orgId), payload: { plan: 'carrier' } });
  const eligibility = async (orgId: string) =>
    (await app.inject({ method: 'GET', url: '/v1/billing/eligibility', headers: headers(orgId) })).json();

  it('holds a new carrier at the plans screen until approved, then lets it subscribe', async () => {
    const orgId = await newOrg();

    assert.deepEqual(await eligibility(orgId), { canSubscribe: false });
    const refused = await checkout(orgId);
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, 'pilot_not_approved');
    assert.ok((await listPendingPilots(db)).some((p) => p.orgId === orgId));

    await approvePilot(db, orgId);

    assert.deepEqual(await eligibility(orgId), { canSubscribe: true });
    const allowed = await checkout(orgId);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().url, 'https://checkout.stripe.test/session');
    assert.ok(!(await listPendingPilots(db)).some((p) => p.orgId === orgId));
  });

  it('keeps the first approval date when approved twice', async () => {
    const orgId = await newOrg();
    await approvePilot(db, orgId, new Date('2026-11-01T00:00:00Z'));
    await approvePilot(db, orgId, new Date('2026-11-20T00:00:00Z'));
    assert.equal((await getTestOrgEntitlements(db, orgId))['pilotApprovedAt'], '2026-11-01T00:00:00.000Z');
  });

  it('never holds back a carrier that has subscribed before, so a lapsed card can be fixed', async () => {
    const orgId = await newOrg();
    await setTestOrgStripeCustomer(db, { orgId, stripeCustomerId: `cus_test_${orgId.slice(0, 8)}` });
    await setTestOrgStatus(db, { orgId, status: 'past_due' });
    assert.equal((await checkout(orgId)).statusCode, 200);
  });

  it('lets anyone subscribe when the flag is off', async () => {
    const open = await newApp('false');
    try {
      const orgId = await newOrg(open);
      assert.equal((await checkout(orgId, open)).statusCode, 200);
    } finally {
      await open.close();
    }
  });
});
