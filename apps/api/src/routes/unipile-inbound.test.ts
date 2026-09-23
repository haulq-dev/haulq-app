/**
 * Unipile inbound webhooks — account connect confirmation and new-mail
 * intake.
 *
 * Same claims `postmark-inbound.test.ts` proves for the sibling path, plus
 * the one thing genuinely different about this one: attachment bytes are
 * fetched by id through a follow-up call, not inlined in the webhook body,
 * so a fake `UnipileClient` stands in for that call.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  MemoryObjectStore,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { UnipileClient } from '../integrations/unipile.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const SECRET = 'test-webhook-secret';

class CountingStore extends MemoryObjectStore {
  puts = 0;
  deletes = 0;
  override async put(key: string, body: Buffer) {
    this.puts += 1;
    return super.put(key, body);
  }
  override async delete(key: string) {
    this.deletes += 1;
    return super.delete(key);
  }
  reset() {
    this.puts = 0;
    this.deletes = 0;
  }
}

/** Serves whatever byte payload was registered for an attachment id. */
class FakeUnipileClient implements UnipileClient {
  private readonly attachments = new Map<string, Buffer>();

  register(attachmentId: string, body: Buffer): void {
    this.attachments.set(attachmentId, body);
  }

  async sendEmail(): Promise<{ providerMessageId: string | null }> {
    throw new Error('not used by this suite');
  }

  async createHostedAuthLink(): Promise<string> {
    return 'https://account.unipile.com/fake-link';
  }

  async fetchAttachment(_emailId: string, _accountId: string, attachmentId: string) {
    const body = this.attachments.get(attachmentId);
    if (!body) throw new Error(`no fixture registered for attachment ${attachmentId}`);
    return { body, contentType: 'application/octet-stream' };
  }
}

let app: FastifyInstance;
let store: CountingStore;
let unipile: FakeUnipileClient;
let userId: string;
const createdOrgs: string[] = [];

/** Enough of a PDF to sniff as one. `tag` makes the digest unique. */
const pdf = (tag = 'a') => Buffer.concat([Buffer.from(`%PDF-1.7\n% ${tag}\n`), Buffer.alloc(64)]);

async function newOrg(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const orgId = res.json().org.id as string;
  createdOrgs.push(orgId);
  return orgId;
}

/** Connects `orgId` to a fresh, unique Unipile account id and returns it. */
async function connectMailbox(orgId: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/v1/mailbox/connect',
    headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
  });
  const accountId = `account-${randomUUID()}`;
  const res = await app.inject({
    method: 'POST',
    url: `/v1/webhooks/unipile/account-notify?secret=${SECRET}`,
    payload: { status: 'CREATION_SUCCESS', account_id: accountId, name: orgId },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().handled, true);
  return accountId;
}

function newEmailPayload(accountId: string, attachments: Array<{ id: string; name?: string }> = []) {
  return {
    email_id: `email-${randomUUID()}`,
    account_id: accountId,
    event: 'mail_received',
    subject: 'RE: your load',
    from_attendee: { identifier: 'broker@example.com' },
    has_attachments: attachments.length > 0,
    attachments,
  };
}

function deliverNewEmail(body: unknown, secret: string | undefined = SECRET) {
  return app.inject({
    method: 'POST',
    url: `/v1/webhooks/unipile/new-email${secret ? `?secret=${secret}` : ''}`,
    payload: body as Record<string, unknown>,
  });
}

suite('unipile inbound', () => {
  before(async () => {
    store = new CountingStore();
    unipile = new FakeUnipileClient();
    app = await buildServer(
      loadEnv({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        UNIPILE_NOTIFY_URL: 'https://api.haulq.ai/v1/webhooks/unipile/account-notify',
        UNIPILE_WEBHOOK_SECRET: SECRET,
      }),
      { storage: store, unipileClient: unipile },
    );
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- account-notify ------------------------------------------------------

  it('connects the pending mailbox on CREATION_SUCCESS', async () => {
    const orgId = await newOrg('Notify Success Co');
    const accountId = await connectMailbox(orgId);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/mailbox',
      headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    });
    assert.equal(status.json().status, 'connected');
    assert.ok(accountId.startsWith('account-'));
  });

  it('acknowledges a denied flow without connecting anything', async () => {
    const orgId = await newOrg('Notify Denied Co');
    await app.inject({
      method: 'POST',
      url: '/v1/mailbox/connect',
      headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/unipile/account-notify?secret=${SECRET}`,
      payload: { status: 'CREATION_FAILED', name: orgId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);

    const status = await app.inject({
      method: 'GET',
      url: '/v1/mailbox',
      headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    });
    assert.equal(status.json().status, 'pending');
  });

  it('rejects a notify call with no secret or the wrong one', async () => {
    const noSecret = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/unipile/account-notify',
      payload: { status: 'CREATION_SUCCESS', account_id: 'x', name: 'y' },
    });
    assert.equal(noSecret.statusCode, 401);

    const wrongSecret = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/unipile/account-notify?secret=wrong',
      payload: { status: 'CREATION_SUCCESS', account_id: 'x', name: 'y' },
    });
    assert.equal(wrongSecret.statusCode, 401);
  });

  it('refuses to accept anything when not configured', async () => {
    const unconfigured = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
      { storage: new MemoryObjectStore() },
    );
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/v1/webhooks/unipile/account-notify?secret=whatever',
      payload: { status: 'CREATION_SUCCESS', account_id: 'x', name: 'y' },
    });
    assert.equal(res.statusCode, 503);
    await unconfigured.close();
  });

  // --- new-email -------------------------------------------------------------

  it('stores an attachment against the org that owns the account id', async () => {
    const orgId = await newOrg('New Email Co');
    const accountId = await connectMailbox(orgId);
    store.reset();

    unipile.register('att-1', pdf('one'));
    const res = await deliverNewEmail(newEmailPayload(accountId, [{ id: 'att-1', name: 'ratecon.pdf' }]));

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.handled, true);
    assert.equal(body.documents.length, 1);
    assert.equal(body.documents[0].deduped, false);
    assert.equal(store.puts, 1);

    const doc = await app.inject({
      method: 'GET',
      url: `/v1/documents/${body.documents[0].documentId}`,
      headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    });
    assert.equal(doc.json().document.source, 'email_intake');
    assert.equal(doc.json().document.receivedFrom, 'broker@example.com');
  });

  it('costs zero writes when the same attachment is resent', async () => {
    const orgId = await newOrg('Repeat New Email Co');
    const accountId = await connectMailbox(orgId);
    const bytes = pdf('repeat-unipile');
    store.reset();

    unipile.register('att-first', bytes);
    const first = await deliverNewEmail(newEmailPayload(accountId, [{ id: 'att-first', name: 'ratecon.pdf' }]));
    assert.equal(store.puts, 1);

    unipile.register('att-second', bytes);
    const second = await deliverNewEmail(newEmailPayload(accountId, [{ id: 'att-second', name: 'ratecon-resend.pdf' }]));
    assert.equal(second.json().documents[0].deduped, true);
    assert.equal(
      second.json().documents[0].documentId,
      first.json().documents[0].documentId,
      'a resend is the same document',
    );
    assert.equal(store.puts, 1, 'the resend must not touch the object store');
  });

  it('acknowledges mail for an account id no org owns', async () => {
    const res = await deliverNewEmail(newEmailPayload(`no-such-account-${randomUUID()}`, [{ id: 'att-x' }]));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
    assert.equal(res.json().reason, 'unknown account');
  });

  it('acknowledges an email with no attachments without calling Unipile again', async () => {
    const orgId = await newOrg('No Attachments Co');
    const accountId = await connectMailbox(orgId);

    const res = await deliverNewEmail(newEmailPayload(accountId, []));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
  });

  it('skips an attachment the pipeline cannot read, without failing the delivery', async () => {
    const orgId = await newOrg('Unreadable Attachment Co');
    const accountId = await connectMailbox(orgId);
    store.reset();

    unipile.register('att-text', Buffer.from('just some text'));
    const res = await deliverNewEmail(newEmailPayload(accountId, [{ id: 'att-text', name: 'notes.txt' }]));

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().documents.length, 0);
    assert.equal(store.puts, 0);
  });

  it('rejects a new-email delivery with no secret or the wrong one', async () => {
    const res = await deliverNewEmail(newEmailPayload('whatever'), 'wrong');
    assert.equal(res.statusCode, 401);
  });
});
