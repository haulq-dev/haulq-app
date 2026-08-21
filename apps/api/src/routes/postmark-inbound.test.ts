/**
 * Postmark inbound email intake.
 *
 * The claims worth a server for:
 *
 *  - Basic Auth actually gates the endpoint, the same way the Clerk webhook's
 *    signature does
 *  - `MailboxHash` resolves to the right org and to no other org
 *  - a resend costs zero writes to the object store, same as a direct upload
 *  - an attachment referenced from the HTML body (a signature logo) is never
 *    stored as a document
 *  - mail to an unrecognized mailbox is acknowledged, not retried forever
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
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const AUTH_USER = 'postmark';
const AUTH_PASSWORD = 'test-inbound-secret';

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

let app: FastifyInstance;
let store: CountingStore;
let userId: string;
const createdOrgs: string[] = [];

/** Enough of a PDF to sniff as one. `tag` makes the digest unique. */
const pdf = (tag = 'a') => Buffer.concat([Buffer.from(`%PDF-1.7\n% ${tag}\n`), Buffer.alloc(64)]);

const as = (orgId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });

async function newOrg(name: string): Promise<{ id: string; slug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const org = res.json().org as { id: string; slug: string };
  createdOrgs.push(org.id);
  return org;
}

function authHeader(user = AUTH_USER, password = AUTH_PASSWORD) {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

interface AttachmentInput {
  Name: string;
  Content: Buffer;
  ContentType: string;
  ContentID?: string;
}

function payload(mailboxHash: string, attachments: AttachmentInput[] = [], over: Record<string, unknown> = {}) {
  return {
    From: 'broker@example.com',
    FromFull: { Email: 'broker@example.com', Name: 'A Broker' },
    Subject: 'RE: your load',
    MessageID: `msg_${randomUUID()}`,
    MailboxHash: mailboxHash,
    Attachments: attachments.map((a) => ({
      Name: a.Name,
      Content: a.Content.toString('base64'),
      ContentType: a.ContentType,
      ContentLength: a.Content.byteLength,
      ...(a.ContentID ? { ContentID: a.ContentID } : {}),
    })),
    ...over,
  };
}

function deliver(body: unknown, headers: Record<string, string> = authHeader()) {
  return app.inject({
    method: 'POST',
    url: '/v1/webhooks/postmark-inbound',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body as Record<string, unknown>,
  });
}

suite('postmark inbound', () => {
  before(async () => {
    store = new CountingStore();
    app = await buildServer(
      loadEnv({
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url!,
        POSTMARK_INBOUND_USER: AUTH_USER,
        POSTMARK_INBOUND_PASSWORD: AUTH_PASSWORD,
      }),
      { storage: store },
    );
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- auth ------------------------------------------------------------------

  it('rejects a request with no authorization header', async () => {
    const res = await deliver(payload('whatever'), {});
    assert.equal(res.statusCode, 401);
  });

  it('rejects the wrong credentials', async () => {
    const res = await deliver(payload('whatever'), authHeader('postmark', 'not-the-secret'));
    assert.equal(res.statusCode, 401);
  });

  it('refuses to accept anything when not configured', async () => {
    // Accepting unverified would be an unauthenticated write reachable by
    // anyone who learns the URL — same reasoning as the Clerk webhook.
    const unconfigured = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
      { storage: new MemoryObjectStore() },
    );
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/v1/webhooks/postmark-inbound',
      headers: { 'content-type': 'application/json', ...authHeader() },
      payload: payload('whatever'),
    });
    assert.equal(res.statusCode, 503);
    await unconfigured.close();
  });

  // --- routing -----------------------------------------------------------

  it('acknowledges mail to a mailbox no org owns', async () => {
    // 200, not 4xx: Postmark retries a non-2xx delivery, and mail to an
    // address with no matching org will never gain one by being retried.
    const res = await deliver(payload(`no-such-org-${randomUUID()}`));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
  });

  it('acknowledges mail with no mailbox tag at all', async () => {
    const res = await deliver(payload(''));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().handled, false);
  });

  // --- intake --------------------------------------------------------------

  it('stores an attachment against the org named by MailboxHash', async () => {
    const org = await newOrg('Inbound Co');
    store.reset();

    const res = await deliver(
      payload(org.slug, [{ Name: 'ratecon.pdf', Content: pdf('one'), ContentType: 'application/pdf' }]),
    );

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.handled, true);
    assert.equal(body.documents.length, 1);
    assert.equal(body.documents[0].deduped, false);
    assert.equal(store.puts, 1);

    const doc = await app.inject({
      method: 'GET',
      url: `/v1/documents/${body.documents[0].documentId}`,
      headers: as(org.id),
    });
    assert.equal(doc.json().document.source, 'email_intake');
    assert.equal(doc.json().document.receivedFrom, 'broker@example.com');
  });

  it('costs zero writes when the same attachment is resent', async () => {
    const org = await newOrg('Repeat Inbound Co');
    const bytes = pdf('repeat-inbound');

    store.reset();
    const first = await deliver(
      payload(org.slug, [{ Name: 'ratecon.pdf', Content: bytes, ContentType: 'application/pdf' }]),
    );
    assert.equal(store.puts, 1);

    const second = await deliver(
      payload(org.slug, [{ Name: 'ratecon-resend.pdf', Content: bytes, ContentType: 'application/pdf' }]),
    );
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().documents[0].deduped, true);
    assert.equal(
      second.json().documents[0].documentId,
      first.json().documents[0].documentId,
      'a resend is the same document',
    );
    assert.equal(store.puts, 1, 'the resend must not touch the object store');
    assert.equal(store.deletes, 0);
  });

  it('never files an inline image as a document', async () => {
    const org = await newOrg('Signature Logo Co');
    store.reset();

    const res = await deliver(
      payload(org.slug, [
        {
          Name: 'logo.png',
          Content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
          ContentType: 'image/png',
          ContentID: 'cid:logo123',
        },
      ]),
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().documents.length, 0);
    assert.equal(store.puts, 0);
  });

  it('skips an attachment the pipeline cannot read', async () => {
    const org = await newOrg('Plain Text Co');
    store.reset();

    const res = await deliver(
      payload(org.slug, [
        { Name: 'notes.txt', Content: Buffer.from('just some text'), ContentType: 'text/plain' },
      ]),
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().documents.length, 0);
    assert.equal(store.puts, 0);
  });

  it('keeps two orgs apart', async () => {
    const a = await newOrg('Mail Carrier A');
    const b = await newOrg('Mail Carrier B');
    const bytes = pdf('shared-across-orgs');

    const toA = await deliver(payload(a.slug, [{ Name: 'a.pdf', Content: bytes, ContentType: 'application/pdf' }]));
    const toB = await deliver(payload(b.slug, [{ Name: 'b.pdf', Content: bytes, ContentType: 'application/pdf' }]));

    assert.notEqual(toA.json().documents[0].documentId, toB.json().documents[0].documentId);
  });
});
