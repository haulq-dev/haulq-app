/**
 * The outbound choke point, end to end.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 1. The claims worth a server
 * for are the guardrails, not the happy path:
 *
 *  - nothing is configured, nothing is sent — shadow is the default
 *  - the kill switch holds a message that asked for more freedom, and is
 *    checked again at approval time
 *  - a mode above an action's ceiling cannot be set, and an unregistered
 *    action cannot be sent at all
 *  - a repeated intent (same `dedupeKey`) sends once
 *  - a provider failure is recorded, not thrown into an unattended loop
 *  - a double-approve, or an approve racing a reject, sends at most once
 *  - reconnecting a mailbox never inherits an "on" nobody re-confirmed
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  markMailboxConnected,
  requestMailboxConnection,
  scope,
  type Scope,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { UnipileApiError, type SendEmailInput, type UnipileClient } from '../integrations/unipile.ts';
import { OutboundError, sendAsCarrier } from '../outbound/dispatch.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

class FakeUnipileClient implements UnipileClient {
  sent: SendEmailInput[] = [];
  failWith: Error | undefined;

  async sendEmail(input: SendEmailInput): Promise<{ providerMessageId: string | null }> {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { providerMessageId: `provider-${this.sent.length}` };
  }
  async createHostedAuthLink(): Promise<string> {
    return 'https://account.unipile.com/fake';
  }
  async fetchAttachment(): Promise<{ body: Buffer; contentType: string | null }> {
    throw new Error('not used by this suite');
  }
}

let app: FastifyInstance;
let unipile: FakeUnipileClient;
let userId: string;
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

const systemScope = (orgId: string): Scope =>
  scope(app.db, { orgId, actor: { type: 'system', name: 'test-loop' }, correlationId: randomUUID() });

/** A connected mailbox, without going through the hosted-auth webhooks. */
async function connectMailbox(orgId: string): Promise<string> {
  const accountId = `acct-${randomUUID()}`;
  await requestMailboxConnection(systemScope(orgId));
  await markMailboxConnected(app.db, { orgId, unipileAccountId: accountId });
  return accountId;
}

function putSettings(orgId: string, body: Record<string, unknown>, actingUserId = userId) {
  return app.inject({ method: 'PUT', url: '/v1/outbound/settings', headers: as(orgId, actingUserId), payload: body });
}

async function getSettings(orgId: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/outbound/settings', headers: as(orgId) });
  return res.json() as { sendingEnabled: boolean; modes: Record<string, string> };
}

const send = (orgId: string, over: Partial<Parameters<typeof sendAsCarrier>[2]> = {}) =>
  sendAsCarrier({ unipile }, systemScope(orgId), {
    actionType: 'broker_message',
    to: ['broker@example.com'],
    subject: 'Load 1042',
    body: 'Following up on load 1042.',
    ...over,
  });

suite('outbound', () => {
  before(async () => {
    unipile = new FakeUnipileClient();
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      unipileClient: unipile,
    });
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- defaults --------------------------------------------------------------

  it('sends nothing by default — every action runs in shadow, and shadow is recorded', async () => {
    const orgId = await newOrg('Outbound Default Co');
    await connectMailbox(orgId);
    unipile.sent = [];

    const result = await send(orgId, { actionType: 'pod_chase' });

    assert.equal(result.sent, false);
    assert.equal(result.message.status, 'shadow');
    assert.equal(result.message.mode, 'shadow');
    assert.equal(result.message.holdReason, null);
    assert.equal(unipile.sent.length, 0);
  });

  it('stores a shadow message verbatim, so the owner can see what would have gone out', async () => {
    const orgId = await newOrg('Outbound Verbatim Co');
    await connectMailbox(orgId);

    await send(orgId, { actionType: 'pod_chase', subject: 'POD for load 7', body: 'Line one\nLine two' });

    const res = await app.inject({ method: 'GET', url: '/v1/outbound/messages?status=shadow', headers: as(orgId) });
    assert.equal(res.statusCode, 200);
    const [m] = res.json().messages;
    assert.equal(m.subject, 'POD for load 7');
    assert.equal(m.body, 'Line one\nLine two');
    assert.deepEqual(m.toAddresses, ['broker@example.com']);
  });

  // --- the kill switch -----------------------------------------------------------

  it('holds a message that asked for act to shadow while sending is off', async () => {
    const orgId = await newOrg('Outbound Killswitch Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { modes: { pod_chase: 'act' } });
    unipile.sent = [];

    const result = await send(orgId, { actionType: 'pod_chase' });

    assert.equal(result.sent, false);
    assert.equal(result.message.status, 'shadow');
    assert.equal(result.message.holdReason, 'sending_disabled');
    assert.equal(unipile.sent.length, 0);
  });

  it('sends when the action is act and sending is on, from the connected account', async () => {
    const orgId = await newOrg('Outbound Act Co');
    const accountId = await connectMailbox(orgId);
    assert.equal((await putSettings(orgId, { sendingEnabled: true, modes: { pod_chase: 'act' } })).statusCode, 200);
    unipile.sent = [];

    const result = await send(orgId, { actionType: 'pod_chase', subject: 'POD please' });

    assert.equal(result.sent, true);
    assert.equal(result.message.status, 'sent');
    assert.equal(result.message.holdReason, null);
    assert.equal(unipile.sent.length, 1);
    assert.equal(unipile.sent[0]!.accountId, accountId);
    assert.deepEqual(unipile.sent[0]!.to, ['broker@example.com']);
    assert.equal(unipile.sent[0]!.idempotencyKey, result.message.id, 'a retry of this send must not email twice');
    assert.equal(result.message.providerMessageId, 'provider-1');
  });

  it('turning sending back off holds the very next message', async () => {
    const orgId = await newOrg('Outbound Off Again Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { pod_chase: 'act' } });
    unipile.sent = [];

    await putSettings(orgId, { sendingEnabled: false });
    const result = await send(orgId, { actionType: 'pod_chase' });

    assert.equal(result.message.holdReason, 'sending_disabled');
    assert.equal(unipile.sent.length, 0);
  });

  it('refuses to turn sending on with no connected mailbox', async () => {
    const orgId = await newOrg('Outbound No Mailbox Co');
    const res = await putSettings(orgId, { sendingEnabled: true });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'not_connected');
  });

  it('never inherits an "on" across a reconnect', async () => {
    const orgId = await newOrg('Outbound Reconnect Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true });
    assert.equal((await getSettings(orgId)).sendingEnabled, true);

    await requestMailboxConnection(systemScope(orgId));
    await markMailboxConnected(app.db, { orgId, unipileAccountId: `acct-${randomUUID()}` });

    assert.equal((await getSettings(orgId)).sendingEnabled, false);
  });

  // --- ceilings and registration ------------------------------------------------

  it('refuses a mode above an action type\'s ceiling, and writes nothing', async () => {
    const orgId = await newOrg('Outbound Ceiling Co');
    await connectMailbox(orgId);

    const res = await putSettings(orgId, { sendingEnabled: true, modes: { detention_claim: 'act' } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'above_ceiling');

    const settings = await getSettings(orgId);
    assert.equal(settings.sendingEnabled, false, 'a rejected request must not half-apply');
    assert.equal(settings.modes['detention_claim'], 'shadow');
  });

  it('refuses an action that is not registered at all', async () => {
    const orgId = await newOrg('Outbound Unregistered Co');
    await connectMailbox(orgId);

    await assert.rejects(
      () => send(orgId, { actionType: 'accept_rate' }),
      (err: unknown) => err instanceof OutboundError && err.code === 'unknown_action',
    );

    const res = await putSettings(orgId, { modes: { accept_rate: 'act' } });
    assert.equal(res.statusCode, 400, 'an unregistered action cannot be configured either');
  });

  it('refuses a malformed message: a bad address, or a newline in the subject', async () => {
    const orgId = await newOrg('Outbound Malformed Co');
    await connectMailbox(orgId);

    await assert.rejects(
      () => send(orgId, { to: ['not-an-address'] }),
      (err: unknown) => err instanceof OutboundError && err.code === 'invalid_message',
    );
    await assert.rejects(
      () => send(orgId, { subject: 'Hello\r\nBcc: someone@example.com' }),
      (err: unknown) => err instanceof OutboundError && err.code === 'invalid_message',
    );
  });

  // --- dedupe and failure ---------------------------------------------------------

  it('sends a repeated intent once — the loop can re-evaluate every pass', async () => {
    const orgId = await newOrg('Outbound Dedupe Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { pod_chase: 'act' } });
    unipile.sent = [];

    const first = await send(orgId, { actionType: 'pod_chase', dedupeKey: 'pod-chase:load-1042:1' });
    const second = await send(orgId, { actionType: 'pod_chase', dedupeKey: 'pod-chase:load-1042:1' });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.sent, false);
    assert.equal(second.message.id, first.message.id);
    assert.equal(unipile.sent.length, 1);
  });

  it('records a provider failure on the message instead of throwing into the caller', async () => {
    const orgId = await newOrg('Outbound Failure Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { pod_chase: 'act' } });

    unipile.failWith = new UnipileApiError(403, 'Unipile 403: Insufficient permissions');
    try {
      const result = await send(orgId, { actionType: 'pod_chase' });
      assert.equal(result.sent, false);
      assert.equal(result.message.status, 'failed');
      assert.match(result.message.error ?? '', /Insufficient permissions/);
    } finally {
      unipile.failWith = undefined;
    }
  });

  // --- draft, approve, reject -------------------------------------------------------

  it('holds a draft for approval and sends it only when a person approves', async () => {
    const orgId = await newOrg('Outbound Approve Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { broker_message: 'draft' } });
    unipile.sent = [];

    const drafted = await send(orgId);
    assert.equal(drafted.message.status, 'pending_approval');
    assert.equal(unipile.sent.length, 0);

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/outbound/messages/${drafted.message.id}/approve`,
      headers: as(orgId),
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, 'sent');
    assert.equal(unipile.sent.length, 1);
  });

  it('sends at most once on a double approve', async () => {
    const orgId = await newOrg('Outbound Double Approve Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { broker_message: 'draft' } });
    unipile.sent = [];

    const drafted = await send(orgId);
    const url = `/v1/outbound/messages/${drafted.message.id}/approve`;
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url, headers: as(orgId) }),
      app.inject({ method: 'POST', url, headers: as(orgId) }),
    ]);

    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal(unipile.sent.length, 1);
  });

  it('cannot approve a message that was rejected', async () => {
    const orgId = await newOrg('Outbound Reject Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { broker_message: 'draft' } });
    unipile.sent = [];

    const drafted = await send(orgId);
    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/outbound/messages/${drafted.message.id}/reject`,
      headers: as(orgId),
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().status, 'rejected');

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/outbound/messages/${drafted.message.id}/approve`,
      headers: as(orgId),
    });
    assert.equal(approve.statusCode, 409);
    assert.equal(unipile.sent.length, 0);
  });

  it('will not send an approval if sending was turned off after the draft was made', async () => {
    const orgId = await newOrg('Outbound Late Approval Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { broker_message: 'draft' } });
    unipile.sent = [];

    const drafted = await send(orgId);
    await putSettings(orgId, { sendingEnabled: false });

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/outbound/messages/${drafted.message.id}/approve`,
      headers: as(orgId),
    });
    assert.equal(approve.statusCode, 409);
    assert.equal(approve.json().code, 'sending_disabled');
    assert.equal(unipile.sent.length, 0);
  });

  // --- the test send, roles, tenancy -----------------------------------------------

  it('sends the owner a test message, only ever to themselves, through the same path', async () => {
    const orgId = await newOrg('Outbound Test Send Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { test: 'act' } });
    unipile.sent = [];

    const res = await app.inject({ method: 'POST', url: '/v1/outbound/test', headers: as(orgId) });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().sent, true);
    assert.equal(unipile.sent.length, 1);
    assert.equal(unipile.sent[0]!.to.length, 1);
  });

  it('lets a dispatcher read settings and messages but not change them', async () => {
    const orgId = await newOrg('Outbound Roles Co');
    const dispatcher = await createTestUser(app.db);
    await addTestMembership(app.db, { orgId, userId: dispatcher.id, role: 'dispatcher' });

    const read = await app.inject({ method: 'GET', url: '/v1/outbound/settings', headers: as(orgId, dispatcher.id) });
    assert.equal(read.statusCode, 200);

    const write = await putSettings(orgId, { sendingEnabled: false }, dispatcher.id);
    assert.equal(write.statusCode, 403);

    const test = await app.inject({ method: 'POST', url: '/v1/outbound/test', headers: as(orgId, dispatcher.id) });
    assert.equal(test.statusCode, 403);

    await destroyTestUser(app.db, dispatcher.id);
  });

  it('keeps two orgs apart', async () => {
    const a = await newOrg('Outbound Tenant A');
    const b = await newOrg('Outbound Tenant B');
    await connectMailbox(a);
    await connectMailbox(b);

    const inA = await send(a, { actionType: 'pod_chase' });

    const listB = await app.inject({ method: 'GET', url: '/v1/outbound/messages', headers: as(b) });
    assert.equal(listB.json().messages.length, 0);

    const approveFromB = await app.inject({
      method: 'POST',
      url: `/v1/outbound/messages/${inA.message.id}/approve`,
      headers: as(b),
    });
    assert.equal(approveFromB.statusCode, 404);
  });
});
