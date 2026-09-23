/**
 * The mailbox connect/status/disconnect routes, end to end.
 *
 * A real Unipile account is not something this repo has for tests, so a
 * fake `UnipileClient` is injected through `buildServer`'s `unipileClient`
 * option — the same seam `placesProvider` and `mechanicSearchProvider` use.
 * What this proves is the wiring: a missing config 503s, `connect` starts a
 * pending row and hands back Unipile's hosted-auth URL, only an owner can
 * connect or disconnect, and status reads back what `connect` wrote.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  closeDatabase,
  createDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { HostedAuthLinkInput, UnipileClient } from '../integrations/unipile.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

class FakeUnipileClient implements UnipileClient {
  public lastLinkInput: HostedAuthLinkInput | undefined;

  async sendEmail(): Promise<{ providerMessageId: string | null }> {
    throw new Error('not used by this suite');
  }

  async createHostedAuthLink(input: HostedAuthLinkInput): Promise<string> {
    this.lastLinkInput = input;
    return 'https://account.unipile.com/fake-link';
  }

  async fetchAttachment(): Promise<{ body: Buffer; contentType: string | null }> {
    throw new Error('not used by this suite');
  }
}

const CONFIG_ENV = { UNIPILE_NOTIFY_URL: 'https://api.haulq.ai/v1/webhooks/unipile/account-notify?secret=test' };

async function newApp(unipileClient: UnipileClient | undefined, extraEnv: Record<string, string> = {}): Promise<FastifyInstance> {
  const { UNIPILE_API_KEY: _k, UNIPILE_DSN: _d, ...envWithoutUnipile } = process.env;
  return buildServer(
    loadEnv({ ...envWithoutUnipile, NODE_ENV: 'test', DATABASE_URL: url!, ...extraEnv }),
    { unipileClient },
  );
}

async function newOrg(app: FastifyInstance, userId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  return res.json().org.id as string;
}

suite('mailbox routes', () => {
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

  it('answers 503 on connect when Unipile is not configured', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app, userId, 'Mailbox Not Configured Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mailbox/connect',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'not_configured');
    } finally {
      await app.close();
    }
  });

  it('starts a pending connection and returns the hosted-auth url', async () => {
    const client = new FakeUnipileClient();
    const app = await newApp(client, CONFIG_ENV);
    try {
      const orgId = await newOrg(app, userId, 'Mailbox Connect Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mailbox/connect',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().url, 'https://account.unipile.com/fake-link');
      assert.equal(client.lastLinkInput!.name, orgId);
      assert.equal(client.lastLinkInput!.notifyUrl, CONFIG_ENV.UNIPILE_NOTIFY_URL);

      const status = await app.inject({
        method: 'GET',
        url: '/v1/mailbox',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(status.json().status, 'pending');
      assert.equal(status.json().connected, false);
    } finally {
      await app.close();
    }
  });

  it('reports not_connected with no mailbox row at all', async () => {
    const app = await newApp(new FakeUnipileClient(), CONFIG_ENV);
    try {
      const orgId = await newOrg(app, userId, 'Mailbox Never Connected Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/mailbox',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, 'not_connected');
    } finally {
      await app.close();
    }
  });

  it('refuses a dispatcher — connecting a mailbox is an owner action', async () => {
    const app = await newApp(new FakeUnipileClient(), CONFIG_ENV);
    try {
      const orgId = await newOrg(app, userId, 'Mailbox Role Carrier');
      createdOrgs.push(orgId);
      const dispatcher = await createTestUser(db);
      await addTestMembership(db, { orgId, userId: dispatcher.id, role: 'dispatcher' });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/mailbox/connect',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': dispatcher.id },
      });
      assert.equal(res.statusCode, 403);

      await destroyTestUser(db, dispatcher.id);
    } finally {
      await app.close();
    }
  });

  it('disconnects an org back to not_connected', async () => {
    const app = await newApp(new FakeUnipileClient(), CONFIG_ENV);
    try {
      const orgId = await newOrg(app, userId, 'Mailbox Disconnect Carrier');
      createdOrgs.push(orgId);

      await app.inject({
        method: 'POST',
        url: '/v1/mailbox/connect',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });

      const del = await app.inject({
        method: 'DELETE',
        url: '/v1/mailbox',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(del.statusCode, 204);

      const status = await app.inject({
        method: 'GET',
        url: '/v1/mailbox',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(status.json().status, 'disconnected');
    } finally {
      await app.close();
    }
  });
});
