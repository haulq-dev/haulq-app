/**
 * Nobody removes themselves, and `/v1/orgs` says who is asking.
 *
 * Found checking the web People screen: under Clerk the session's user id is a
 * placeholder, so both apps' "is this you?" check never matched, and an owner
 * could remove their own access whenever a second owner existed (the API only
 * refused removing the *last* owner). Now the repository refuses it, and
 * `/v1/orgs` returns the caller's user id so the screens can hide the button.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addTestMembership, createTestUser, destroyTestOrg, destroyTestUser } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

suite('members — removing yourself', () => {
  let app: FastifyInstance;
  let owner: string;
  let secondOwner: string;
  let orgId: string;
  const as = (userId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }));
    owner = (await createTestUser(app.db)).id;
    secondOwner = (await createTestUser(app.db)).id;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': owner },
      payload: { name: 'Self Removal Co', contactEmail: 'owner@example.com' },
    });
    orgId = res.json().org.id as string;
    await addTestMembership(app.db, { orgId, userId: secondOwner, role: 'owner' });
  });

  after(async () => {
    await destroyTestOrg(app.db, orgId);
    await destroyTestUser(app.db, owner);
    await destroyTestUser(app.db, secondOwner);
    await app.close();
  });

  it('says who is asking, so a screen can find your own row', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: { 'x-haulq-user-id': owner } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().userId, owner);
    assert.ok(Array.isArray(res.json().items));
  });

  it('refuses removing yourself, even with another owner present', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/v1/members/${owner}`, headers: as(owner) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'self_removal');
    assert.match(res.json().explanation, /can’t remove yourself/);
  });

  it('still lets one owner remove another', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/v1/members/${secondOwner}`, headers: as(owner) });
    assert.equal(res.statusCode, 204);
  });
});
