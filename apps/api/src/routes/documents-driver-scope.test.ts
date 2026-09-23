/**
 * A driver sees paperwork on their own assigned loads, and nothing else.
 *
 * Before this, the document read routes had no role check, so a driver's
 * login could list and download every rate confirmation in the account.
 * These tests pin down the closed version: list, get and content are scoped
 * to the driver's own loads, counts are office-only, and a driver's upload
 * can name only their own load. `assertDriverMaySee` in documents.ts has the
 * reasoning.
 *
 * Uses a real linked driver (invite with `driverId`, then accept), not just a
 * `driver` membership. Scoping resolves the login to a `drivers` row, so an
 * unlinked driver would prove only the "sees nothing" path.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closeDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  MemoryObjectStore,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const pdf = (tag: string) => Buffer.concat([Buffer.from(`%PDF-1.7\n% ${tag}\n`), Buffer.alloc(64)]);

suite('document routes, driver scope', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let driverUserId: string;
  let otherDriverUserId: string;
  let orgId: string;
  let myLoad: string;
  let theirLoad: string;
  let myDoc: string;
  let theirDoc: string;
  let inboxDoc: string;

  const asOwner = () => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': ownerId });
  const asDriver = () => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': driverUserId });

  async function newDriver(fullName: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/v1/drivers', headers: asOwner(), payload: { fullName } });
    return res.json().id as string;
  }

  async function linkDriver(driverId: string, userId: string) {
    const invited = await app.inject({
      method: 'POST',
      url: '/v1/members/invites',
      headers: asOwner(),
      payload: { email: `${userId}@example.test`, role: 'driver', driverId },
    });
    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${invited.json().token as string}/accept`,
      headers: { 'x-haulq-user-id': userId },
    });
    assert.equal(accepted.statusCode, 200, 'test setup: linking the driver');
  }

  async function newLoad(driverId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: asOwner(),
      payload: {
        driverId,
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      },
    });
    return res.json().id as string;
  }

  async function upload(headers: Record<string, string>, tag: string, loadId?: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/documents${loadId ? `?loadId=${loadId}` : ''}`,
      headers: { ...headers, 'content-type': 'application/pdf' },
      payload: pdf(tag),
    });
  }

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      // Never the real bucket, whatever the developer's .env holds.
      storage: new MemoryObjectStore(),
    });
    ownerId = (await createTestUser(app.db)).id;
    driverUserId = (await createTestUser(app.db)).id;
    otherDriverUserId = (await createTestUser(app.db)).id;

    const org = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': ownerId },
      payload: { name: 'Driver Scope Co', contactEmail: 'owner@example.com' },
    });
    orgId = org.json().org.id as string;

    const mine = await newDriver('Driver Mine');
    const theirs = await newDriver('Driver Theirs');
    await linkDriver(mine, driverUserId);
    await linkDriver(theirs, otherDriverUserId);
    myLoad = await newLoad(mine);
    theirLoad = await newLoad(theirs);

    myDoc = (await upload(asOwner(), 'mine', myLoad)).json().document.id as string;
    theirDoc = (await upload(asOwner(), 'theirs', theirLoad)).json().document.id as string;
    inboxDoc = (await upload(asOwner(), 'inbox')).json().document.id as string;
  });

  after(async () => {
    await destroyTestOrg(app.db, orgId);
    for (const id of [ownerId, driverUserId, otherDriverUserId]) await destroyTestUser(app.db, id);
    await app.close();
    await closeDatabase(app.db);
  });

  it("lists a driver's own load's paperwork, and only when a load is named", async () => {
    const own = await app.inject({ method: 'GET', url: `/v1/documents?loadId=${myLoad}`, headers: asDriver() });
    assert.equal(own.statusCode, 200);
    assert.deepEqual((own.json().items as Array<{ id: string }>).map((d) => d.id), [myDoc]);

    const whole = await app.inject({ method: 'GET', url: '/v1/documents', headers: asDriver() });
    assert.equal(whole.statusCode, 403, 'not the whole account');

    const inbox = await app.inject({ method: 'GET', url: '/v1/documents?unattached=true', headers: asDriver() });
    assert.equal(inbox.statusCode, 403, 'not the office inbox either');

    const other = await app.inject({ method: 'GET', url: `/v1/documents?loadId=${theirLoad}`, headers: asDriver() });
    assert.equal(other.statusCode, 404, "another driver's load reads as missing");
  });

  it("opens a driver's own documents, and 404s everything else", async () => {
    for (const path of [`/v1/documents/${myDoc}`, `/v1/documents/${myDoc}/content`]) {
      const res = await app.inject({ method: 'GET', url: path, headers: asDriver() });
      assert.equal(res.statusCode, 200, path);
    }
    for (const id of [theirDoc, inboxDoc]) {
      for (const path of [`/v1/documents/${id}`, `/v1/documents/${id}/content`]) {
        const res = await app.inject({ method: 'GET', url: path, headers: asDriver() });
        assert.equal(res.statusCode, 404, path);
      }
    }
  });

  it('keeps the account-wide counts office-only', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/documents/counts', headers: asDriver() });
    assert.equal(res.statusCode, 403);
  });

  it("lets a driver upload to their own load or the inbox, never someone else's load", async () => {
    assert.equal((await upload(asDriver(), 'd-own', myLoad)).statusCode, 201);
    assert.equal((await upload(asDriver(), 'd-inbox')).statusCode, 201);

    const other = await upload(asDriver(), 'd-other', theirLoad);
    assert.equal(other.statusCode, 404);
    assert.equal(other.json().code, 'load_not_found');
  });

  it('leaves office roles seeing the whole account', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/documents', headers: asOwner() });
    assert.equal(res.statusCode, 200);
    assert.ok((res.json().items as unknown[]).length >= 3);
  });
});
