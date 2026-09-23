/**
 * The API-side paywall in `requireScope`, behind `REQUIRE_ACTIVE_SUBSCRIPTION`.
 *
 * Before this, only `apps/web`'s `Shell.tsx` enforced the paywall. The mobile
 * app and any other API client could use an unpaid org freely. This suite
 * shows that with the flag on, a tenant route refuses anything short of
 * `active` while billing stays reachable. With the flag off, which is the
 * default, nothing changes.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closeDatabase,
  createDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  setTestOrgStatus,
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

function newApp(requireActive: 'true' | 'false' | undefined): Promise<FastifyInstance> {
  // Stripe keys stripped too: the billing test below must not create a real
  // Checkout Session against whatever account the developer's .env points at.
  const { REQUIRE_ACTIVE_SUBSCRIPTION: _drop, STRIPE_SECRET_KEY: _stripe, ...env } = process.env;
  return buildServer(
    loadEnv({
      ...env,
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      ...(requireActive ? { REQUIRE_ACTIVE_SUBSCRIPTION: requireActive } : {}),
    }),
  );
}

suite('subscription gate', () => {
  let db: Database;
  let userId: string;
  const createdOrgs: string[] = [];

  before(async () => {
    db = createDatabase({ url: url! });
    userId = (await createTestUser(db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(db, id);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  async function newOrg(app: FastifyInstance): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': userId },
      payload: { name: 'Subscription Gate Carrier', contactEmail: 'owner@example.com' },
    });
    const orgId = res.json().org.id as string;
    createdOrgs.push(orgId);
    return orgId;
  }

  const listLoads = (app: FastifyInstance, orgId: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/loads',
      headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    });

  it('changes nothing when the flag is unset', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app); // `trialing`, the column default
      const res = await listLoads(app, orgId);
      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('refuses every status but active with 402 subscription_inactive', async () => {
    const app = await newApp('true');
    try {
      const orgId = await newOrg(app);
      for (const status of ['trialing', 'past_due', 'paused', 'cancelled'] as const) {
        await setTestOrgStatus(db, { orgId, status });
        const res = await listLoads(app, orgId);
        assert.equal(res.statusCode, 402, status);
        assert.equal(res.json().code, 'subscription_inactive');
        assert.ok(res.json().explanation);
      }

      await setTestOrgStatus(db, { orgId, status: 'active' });
      assert.equal((await listLoads(app, orgId)).statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it('lets an unpaid owner reach billing, and never gates the org list', async () => {
    const app = await newApp('true');
    try {
      const orgId = await newOrg(app);
      const checkout = await app.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { plan: 'carrier' },
      });
      // No Stripe key, so billing answers 503 rather than a URL. That shows
      // the request got past the gate to the route itself.
      assert.equal(checkout.statusCode, 503);

      const orgs = await app.inject({
        method: 'GET',
        url: '/v1/orgs',
        headers: { 'x-haulq-user-id': userId },
      });
      assert.equal(orgs.statusCode, 200);
      const mine = (orgs.json().items as Array<{ id: string; status: string }>).find((o) => o.id === orgId);
      assert.equal(mine?.status, 'trialing');
    } finally {
      await app.close();
    }
  });
});
