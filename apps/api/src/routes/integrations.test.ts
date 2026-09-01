/**
 * The Motive vehicle-listing route.
 *
 * Deliberately does not exercise a real Motive API call — that needs a
 * connected credential and a live sandbox account, which is what the
 * Motive OAuth connect flow itself is for. What is worth a server here:
 * the route refuses cleanly (409, not a 500) when nobody has connected
 * Motive yet, and a driver cannot see it.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  getBoardCredential,
  scope,
  storeOAuthCredential,
} from '@haulq/db';
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

suite('integration routes — Motive vehicles', () => {
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

  it('answers 409, not 500, when nobody has connected Motive yet', async () => {
    const orgId = await newOrg('No Motive Carrier');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/motive/vehicles',
      headers: as(orgId),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'not_connected');
    assert.ok(res.json().explanation);
  });

  it('refuses a driver', async () => {
    const orgId = await newOrg('Driver Motive Carrier');
    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/motive/vehicles',
      headers: as(orgId, driverUserId),
    });
    assert.equal(res.statusCode, 403);
  });
});

suite('integration routes — Motive disconnect', () => {
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

  it('is a no-op, not an error, when there was never a connection', async () => {
    const orgId = await newOrg('Never Connected Carrier');
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/integrations/motive',
      headers: as(orgId),
    });
    assert.equal(res.statusCode, 200);
  });

  it('removes an active connection entirely, not just its status', async () => {
    const orgId = await newOrg('Connected Carrier');
    await storeOAuthCredential(
      scope(app.db, {
        orgId,
        actor: { type: 'integration', provider: 'motive-oauth' },
        correlationId: randomUUID(),
      }),
      {
        board: 'motive',
        encryptedAccessToken: 'fake-sealed-access-token',
        encryptedRefreshToken: 'fake-sealed-refresh-token',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    );

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/integrations/motive',
      headers: as(orgId),
    });
    assert.equal(res.statusCode, 200);

    const row = await getBoardCredential(
      scope(app.db, { orgId, actor: { type: 'user', id: userId }, correlationId: randomUUID() }),
      'motive',
    );
    assert.equal(row, undefined);

    // Reconnecting afterward must work cleanly — no leftover row to conflict with.
    const list = await app.inject({ method: 'GET', url: '/v1/integrations', headers: as(orgId) });
    assert.equal(
      list.json().items.find((i: { board: string }) => i.board === 'motive'),
      undefined,
    );
  });

  it('refuses a driver', async () => {
    const orgId = await newOrg('Driver Disconnect Carrier');
    await addTestMembership(app.db, { orgId, userId: driverUserId, role: 'driver' });

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/integrations/motive',
      headers: as(orgId, driverUserId),
    });
    assert.equal(res.statusCode, 403);
  });
});

suite('integration routes — Motive callback', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
  });

  after(async () => {
    await app.close();
  });

  // Every case below must redirect the browser back into the web app, never
  // answer with a raw JSON error body — the callback fires mid-navigation on
  // Motive's own redirect, not from a caller that can render an API error.
  // This is exactly the bug a config gap surfaced: a config check thrown
  // outside the route's try/catch reached the browser as bare
  // {"code":"not_configured",...} instead of landing back on /integrations.

  it('redirects to ?motive=denied when Motive reports the user declined', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/motive/callback?error=access_denied',
    });
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location as string, /\/integrations\?motive=denied$/);
  });

  it('redirects rather than throwing raw JSON when code/state are missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/integrations/motive/callback' });
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location as string, /\/integrations\?motive=(error|not_configured)$/);
    assert.doesNotMatch(res.body, /"code"\s*:\s*"/);
  });

  it('redirects rather than throwing raw JSON on a bad state signature', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/integrations/motive/callback?code=abc&state=not-a-real-signature',
    });
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location as string, /\/integrations\?motive=(error|not_configured)$/);
    assert.doesNotMatch(res.body, /"code"\s*:\s*"/);
  });
});

suite('GET /v1/integrations — deployment status', () => {
  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  it('reports every optional integration as unconfigured on a bare deployment', async () => {
    // Not `app` — this machine's own .env carries real HERE and Motive
    // credentials (see PROJECT-STATUS.md), so the ambient environment is
    // not actually bare. A dedicated instance with every optional key
    // explicitly cleared is the only reliable way to test the "nothing
    // configured" branch on a machine where that happens to be true.
    const bareApp = await buildServer(
      loadEnv({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        AZURE_DI_ENDPOINT: undefined,
        AZURE_DI_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        FMCSA_WEBKEY: undefined,
        HERE_API_KEY: undefined,
        MOTIVE_CLIENT_ID: undefined,
        MOTIVE_CLIENT_SECRET: undefined,
        MOTIVE_REDIRECT_URI: undefined,
      }),
    );
    try {
      const orgRes = await bareApp.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { 'x-haulq-user-id': userId },
        payload: { name: 'Bare Deployment Carrier', contactEmail: 'owner@example.com' },
      });
      const orgId = orgRes.json().org.id as string;
      createdOrgs.push(orgId);

      const res = await bareApp.inject({ method: 'GET', url: '/v1/integrations', headers: as(orgId) });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().deployment, {
        azureDocumentIntelligence: { configured: false },
        anthropicModelPass: { configured: false },
        fmcsaVerify: { configured: false },
        hereRouting: { configured: false },
        motive: { configured: false },
      });
    } finally {
      await bareApp.close();
    }
  });

  it('reports each integration configured once its keys are set', async () => {
    const configuredApp = await buildServer(
      loadEnv({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        AZURE_DI_ENDPOINT: 'https://example.cognitiveservices.azure.com',
        AZURE_DI_KEY: 'test-azure-key',
        ANTHROPIC_API_KEY: 'test-anthropic-key',
        FMCSA_WEBKEY: 'test-fmcsa-key',
        HERE_API_KEY: 'test-here-key',
        MOTIVE_CLIENT_ID: 'test-client-id',
        MOTIVE_CLIENT_SECRET: 'test-client-secret',
        MOTIVE_REDIRECT_URI: 'http://localhost:3001/v1/integrations/motive/callback',
      }),
    );
    try {
      const orgRes = await configuredApp.inject({
        method: 'POST',
        url: '/v1/orgs',
        headers: { 'x-haulq-user-id': userId },
        payload: { name: 'Fully Configured Carrier', contactEmail: 'owner@example.com' },
      });
      const orgId = orgRes.json().org.id as string;
      createdOrgs.push(orgId);

      const res = await configuredApp.inject({
        method: 'GET',
        url: '/v1/integrations',
        headers: as(orgId),
      });
      assert.deepEqual(res.json().deployment, {
        azureDocumentIntelligence: { configured: true },
        anthropicModelPass: { configured: true },
        fmcsaVerify: { configured: true },
        hereRouting: { configured: true },
        motive: { configured: true },
      });
    } finally {
      await configuredApp.close();
    }
  });
});
