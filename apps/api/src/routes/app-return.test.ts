/**
 * Handing Motive and mailbox connects back to the mobile app (MOBILE_PARITY_PLAN.md M6).
 *
 * What is worth a server: the hand-back page only ever points at the app's
 * own scheme and refuses anything outside its enums, a Motive connect
 * started from the app finishes on that page (even when Motive refused or
 * the deployment is misconfigured) while one from the web is unchanged, and
 * a mailbox connect from the app sends Unipile to that page.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createTestUser, destroyTestOrg, destroyTestUser } from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { HostedAuthLinkInput, UnipileClient } from '../integrations/unipile.ts';
import { signOAuthState } from '../integrations/state.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const MOTIVE_ENV = {
  MOTIVE_CLIENT_ID: 'test-client-id',
  MOTIVE_CLIENT_SECRET: 'test-client-secret',
  MOTIVE_REDIRECT_URI: 'http://localhost:3001/v1/integrations/motive/callback',
  // Missing on purpose, so a signed code fails before any network call to Motive.
  CREDENTIAL_ENCRYPTION_PUBLIC_KEY: undefined,
  UNIPILE_NOTIFY_URL: 'https://api.haulq.ai/v1/webhooks/unipile/account-notify?secret=test',
};

class FakeUnipileClient implements UnipileClient {
  public lastLinkInput: HostedAuthLinkInput | undefined;
  async sendEmail(): Promise<{ providerMessageId: string | null }> {
    throw new Error('not used');
  }
  async createHostedAuthLink(input: HostedAuthLinkInput): Promise<string> {
    this.lastLinkInput = input;
    return 'https://account.unipile.com/fake-link';
  }
  async fetchAttachment(): Promise<{ body: Buffer; contentType: string | null }> {
    throw new Error('not used');
  }
}

suite('app hand-back', () => {
  let app: FastifyInstance;
  let userId: string;
  const unipile = new FakeUnipileClient();
  const createdOrgs: string[] = [];

  before(async () => {
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url!, ...MOTIVE_ENV }), {
      unipileClient: unipile,
    });
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  it('serves a page that opens the app with the result, and nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/app-return?motive=connected' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /content="0;url=ai\.haulq\.app:\/\/integrations\?motive=connected"/);
    assert.match(res.body, /href="ai\.haulq\.app:\/\/integrations\?motive=connected"/);
    assert.match(res.body, /Connected\./);
  });

  it('refuses a result outside its enums, so it cannot carry anything else into the page', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/app-return?motive=%22%3E%3Cscript%3E' });
    assert.equal(res.statusCode, 400);
  });

  it('finishes a Motive connect started from the app on the hand-back page, even when Motive refused', async () => {
    const state = signOAuthState(MOTIVE_ENV.MOTIVE_CLIENT_SECRET, '00000000-0000-4000-8000-000000000001', 'app');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/integrations/motive/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/v1/app-return?motive=denied');
  });

  it('hands a failed finish back to the app too', async () => {
    const state = signOAuthState(MOTIVE_ENV.MOTIVE_CLIENT_SECRET, '00000000-0000-4000-8000-000000000001', 'app');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/integrations/motive/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/v1/app-return?motive=not_configured');
  });

  it('leaves a web connect finishing on the web', async () => {
    const state = signOAuthState(MOTIVE_ENV.MOTIVE_CLIENT_SECRET, '00000000-0000-4000-8000-000000000001');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/integrations/motive/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    assert.match(res.headers.location as string, /\/integrations\?motive=denied$/);
    assert.doesNotMatch(res.headers.location as string, /app-return/);
  });

  it('sends Unipile back to the hand-back page when the app starts a mailbox connect', async () => {
    const orgRes = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { 'x-haulq-user-id': userId },
      payload: { name: 'App Mailbox Carrier', contactEmail: 'owner@example.com' },
    });
    const orgId = orgRes.json().org.id as string;
    createdOrgs.push(orgId);
    const headers = { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId };

    const fromApp = await app.inject({ method: 'POST', url: '/v1/mailbox/connect?client=app', headers });
    assert.equal(fromApp.statusCode, 200, fromApp.body);
    assert.equal(unipile.lastLinkInput!.successRedirectUrl, 'https://api.haulq.ai/v1/app-return?mailbox=connected');
    assert.equal(unipile.lastLinkInput!.failureRedirectUrl, 'https://api.haulq.ai/v1/app-return?mailbox=denied');

    const fromWeb = await app.inject({ method: 'POST', url: '/v1/mailbox/connect', headers });
    assert.equal(fromWeb.statusCode, 200);
    assert.match(unipile.lastLinkInput!.successRedirectUrl, /\/autopilot\?mailbox=connected$/);
  });
});
