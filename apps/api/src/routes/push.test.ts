/**
 * Registering phones and switching notifications off, end to end.
 *
 * The claims worth a server: a phone signed in as someone else moves to
 * them, signing out only removes your own token, preferences round-trip and
 * refuse an unknown category, and the test send reaches only your phones.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestUser, destroyTestOrg, destroyTestUser, pushDeviceForTest } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { FakePushSender } from '../push/sender.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

suite('push routes', () => {
  let app: FastifyInstance;
  let bareApp: FastifyInstance;
  const push = new FakePushSender();
  let alice: string;
  let bob: string;
  let orgId: string;

  const as = (userId: string, org?: string) => ({ 'x-haulq-user-id': userId, ...(org ? { 'x-haulq-org-id': org } : {}) });

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), { pushSender: push });
    bareApp = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), { pushSender: undefined });
    alice = (await createTestUser(app.db)).id;
    bob = (await createTestUser(app.db)).id;
    const org = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': alice },
      payload: { name: 'Push Routes Co', contactEmail: 'owner@example.com' },
    });
    orgId = org.json().org.id as string;
  });

  after(async () => {
    await destroyTestOrg(app.db, orgId);
    await destroyTestUser(app.db, alice);
    await destroyTestUser(app.db, bob);
    await bareApp.close();
    await app.close();
  });

  it('needs a signed-in person', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/push/devices', payload: { token: TOKEN_A, platform: 'ios' } });
    assert.equal(res.statusCode, 401);
  });

  it('moves a shared phone to whoever signed in last', async () => {
    const first = await app.inject({ method: 'POST', url: '/v1/push/devices', headers: as(alice), payload: { token: TOKEN_A, platform: 'ios', appVersion: '1.0.2' } });
    assert.equal(first.statusCode, 204);
    assert.equal((await pushDeviceForTest(app.db, TOKEN_A))?.userId, alice);

    await app.inject({ method: 'POST', url: '/v1/push/devices', headers: as(bob), payload: { token: TOKEN_A, platform: 'ios' } });
    assert.equal((await pushDeviceForTest(app.db, TOKEN_A))?.userId, bob);
  });

  it('only removes your own token on sign-out', async () => {
    // TOKEN_A is Bob's now. Alice signing out a stale copy must not take it from him.
    const res = await app.inject({ method: 'DELETE', url: `/v1/push/devices/${TOKEN_A}`, headers: as(alice) });
    assert.equal(res.statusCode, 204);
    assert.equal((await pushDeviceForTest(app.db, TOKEN_A))?.userId, bob);

    await app.inject({ method: 'DELETE', url: `/v1/push/devices/${TOKEN_A}`, headers: as(bob) });
    assert.equal(await pushDeviceForTest(app.db, TOKEN_A), undefined);
  });

  it('round-trips preferences, and refuses a category that does not exist', async () => {
    const empty = await app.inject({ method: 'GET', url: '/v1/push/preferences', headers: as(alice) });
    assert.deepEqual(empty.json(), { muted: [] });

    const put = await app.inject({ method: 'PUT', url: '/v1/push/preferences', headers: as(alice), payload: { muted: ['invoice_paid', 'invoice_paid'] } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.json(), { muted: ['invoice_paid'] });

    const bad = await app.inject({ method: 'PUT', url: '/v1/push/preferences', headers: as(alice), payload: { muted: ['marketing'] } });
    assert.equal(bad.statusCode, 400);
  });

  it('sends a test only to your own phones, and says why when it cannot', async () => {
    const none = await app.inject({ method: 'POST', url: '/v1/push/test', headers: as(alice, orgId) });
    assert.equal(none.statusCode, 409);
    assert.equal(none.json().code, 'no_devices');

    await app.inject({ method: 'POST', url: '/v1/push/devices', headers: as(alice), payload: { token: TOKEN_B, platform: 'ios' } });
    push.sent.length = 0;
    const res = await app.inject({ method: 'POST', url: '/v1/push/test', headers: as(alice, orgId) });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { sent: 1 });
    assert.equal(push.sent[0]!.device.token, TOKEN_B);
    assert.equal(push.sent[0]!.message.orgId, orgId);

    const unconfigured = await bareApp.inject({ method: 'POST', url: '/v1/push/test', headers: as(alice, orgId) });
    assert.equal(unconfigured.statusCode, 503);
  });
});
