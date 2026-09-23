/**
 * The Unipile client, against a real HTTP server.
 *
 * Same discipline `motive.test.ts` and `here.test.ts` already established
 * for this repo's hand-rolled REST clients: a stub server on localhost, not
 * a mocked `fetch`. Pins what this file assumes the hosted-auth-link and
 * attachment-retrieval shapes are — see `unipile.ts`'s own module note on
 * why that assumption needs re-validating against a real account before
 * this reaches a carrier's inbox.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { UnipileApiError, UnipileHostedClient } from './unipile.ts';

let server: Server;
let base: string;
let script: { status: number; body: unknown; isBinary?: boolean };
let lastRequest: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string } | undefined;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.statusCode = script.status;
      if (script.isBinary) {
        res.setHeader('content-type', 'application/pdf');
        res.end(script.body as Buffer);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(script.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  lastRequest = undefined;
  script = { status: 200, body: { object: 'HostedAuthURL', url: 'https://account.unipile.com/abc123' } };
});

describe('UnipileHostedClient.createHostedAuthLink', () => {
  it('posts the api key as x-api-key, the org id as name, and both webhook urls', async () => {
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    const url = await client.createHostedAuthLink({
      name: 'org-123',
      notifyUrl: 'https://api.haulq.ai/v1/webhooks/unipile/account-notify?secret=s3cr3t',
      successRedirectUrl: 'https://haulq.ai/integrations?mailbox=connected',
      failureRedirectUrl: 'https://haulq.ai/integrations?mailbox=denied',
    });

    assert.equal(url, 'https://account.unipile.com/abc123');
    assert.equal(lastRequest!.method, 'POST');
    assert.equal(lastRequest!.url, '/api/v1/hosted/accounts/link');
    assert.equal(lastRequest!.headers['x-api-key'], 'test-key');

    const body = JSON.parse(lastRequest!.body);
    assert.equal(body.type, 'create');
    assert.equal(body.name, 'org-123');
    assert.equal(body.notify_url, 'https://api.haulq.ai/v1/webhooks/unipile/account-notify?secret=s3cr3t');
    assert.equal(body.success_redirect_url, 'https://haulq.ai/integrations?mailbox=connected');
    assert.equal(body.failure_redirect_url, 'https://haulq.ai/integrations?mailbox=denied');
    assert.deepEqual(body.providers, ['GOOGLE', 'OUTLOOK', 'MAIL']);
  });

  it('throws UnipileApiError when the response carries no url', async () => {
    script.body = { object: 'HostedAuthURL' };
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    await assert.rejects(
      () => client.createHostedAuthLink({
        name: 'org-1',
        notifyUrl: 'https://api.haulq.ai/notify',
        successRedirectUrl: 'https://haulq.ai/ok',
        failureRedirectUrl: 'https://haulq.ai/no',
      }),
      (err: unknown) => err instanceof UnipileApiError,
    );
  });

  it('throws UnipileApiError on a transport failure', async () => {
    script.status = 401;
    script.body = { title: 'Unauthorized' };
    const client = new UnipileHostedClient({ apiKey: 'bad-key', dsn: base });
    await assert.rejects(
      () => client.createHostedAuthLink({
        name: 'org-1',
        notifyUrl: 'https://api.haulq.ai/notify',
        successRedirectUrl: 'https://haulq.ai/ok',
        failureRedirectUrl: 'https://haulq.ai/no',
      }),
      (err: unknown) => {
        assert.ok(err instanceof UnipileApiError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });
});

describe('UnipileHostedClient.fetchAttachment', () => {
  it('requests the attachment path with the account id as a query param and the api key header', async () => {
    script = { status: 200, body: Buffer.from('%PDF-1.7\n'), isBinary: true };
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    const { body, contentType } = await client.fetchAttachment('email-1', 'account-1', 'att-1');

    assert.equal(lastRequest!.method, 'GET');
    assert.equal(lastRequest!.url, '/api/v1/emails/email-1/attachments/att-1?account_id=account-1');
    assert.equal(lastRequest!.headers['x-api-key'], 'test-key');
    assert.equal(body.toString('utf8'), '%PDF-1.7\n');
    assert.equal(contentType, 'application/pdf');
  });

  it('throws UnipileApiError on a 404', async () => {
    script = { status: 404, body: { title: 'Not Found' } };
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    await assert.rejects(
      () => client.fetchAttachment('email-1', 'account-1', 'missing'),
      (err: unknown) => {
        assert.ok(err instanceof UnipileApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });
});

describe('UnipileHostedClient.sendEmail', () => {
  beforeEach(() => {
    script = { status: 200, body: { provider_id: 'prov-123' } };
  });

  it('posts json with the account, recipients, subject, an html body and the idempotency key', async () => {
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    const result = await client.sendEmail({
      accountId: 'acct-1',
      to: ['broker@example.com', 'ap@example.com'],
      subject: 'POD for load 1042',
      body: 'Hi,\nPlease send the <POD> & confirm.',
      idempotencyKey: 'msg-uuid-1',
    });

    assert.equal(result.providerMessageId, 'prov-123');
    assert.equal(lastRequest!.method, 'POST');
    assert.equal(lastRequest!.url, '/api/v1/emails');
    assert.equal(lastRequest!.headers['x-api-key'], 'test-key');
    assert.equal(lastRequest!.headers['idempotency-key'], 'msg-uuid-1');

    const body = JSON.parse(lastRequest!.body);
    assert.equal(body.account_id, 'acct-1');
    assert.deepEqual(body.to, [{ identifier: 'broker@example.com' }, { identifier: 'ap@example.com' }]);
    assert.equal(body.subject, 'POD for load 1042');
    // Newlines survive, and markup in the text is escaped, never injected.
    assert.equal(body.body, 'Hi,<br>\nPlease send the &lt;POD&gt; &amp; confirm.');
    assert.equal(body.reply_to, undefined);
  });

  it('threads a reply when given the prior message id', async () => {
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    await client.sendEmail({
      accountId: 'acct-1',
      to: ['broker@example.com'],
      subject: 'Re: load',
      body: 'ok',
      replyToProviderId: 'prior-provider-id',
      idempotencyKey: 'msg-uuid-2',
    });
    assert.equal(JSON.parse(lastRequest!.body).reply_to, 'prior-provider-id');
  });

  it('still succeeds, with no id, when the response carries none we recognize', async () => {
    script.body = {};
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    const result = await client.sendEmail({
      accountId: 'acct-1',
      to: ['broker@example.com'],
      subject: 's',
      body: 'b',
      idempotencyKey: 'k',
    });
    assert.equal(result.providerMessageId, null);
  });

  it('throws UnipileApiError when Unipile refuses', async () => {
    script = { status: 403, body: { title: 'Insufficient permissions' } };
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    await assert.rejects(
      () => client.sendEmail({ accountId: 'a', to: ['x@example.com'], subject: 's', body: 'b', idempotencyKey: 'k' }),
      (err: unknown) => err instanceof UnipileApiError && err.status === 403,
    );
  });
});

describe('UnipileHostedClient.sendEmail with attachments', () => {
  beforeEach(() => {
    script = { status: 200, body: { provider_id: 'prov-att' } };
  });

  it('sends multipart, with each file as an attachments part and the scalar fields as form fields', async () => {
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    const result = await client.sendEmail({
      accountId: 'acct-1',
      to: ['broker@example.com'],
      subject: 'Invoice 42',
      body: 'Attached.',
      idempotencyKey: 'msg-att-1',
      attachments: [
        { filename: 'Invoice-42.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF-1.7 invoice bytes') },
        { filename: 'pod.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF-1.7 pod bytes') },
      ],
    });

    assert.equal(result.providerMessageId, 'prov-att');
    const contentType = String(lastRequest!.headers['content-type']);
    assert.match(contentType, /^multipart\/form-data; boundary=/, 'fetch must set the boundary itself');
    assert.equal(lastRequest!.headers['idempotency-key'], 'msg-att-1');
    assert.equal(lastRequest!.headers['x-api-key'], 'test-key');

    const raw = lastRequest!.body;
    assert.match(raw, /name="account_id"\r\n\r\nacct-1/);
    assert.match(raw, /name="subject"\r\n\r\nInvoice 42/);
    assert.match(raw, /name="to"\r\n\r\n\[\{"identifier":"broker@example.com"\}\]/);
    assert.match(raw, /name="attachments"; filename="Invoice-42\.pdf"/);
    assert.match(raw, /name="attachments"; filename="pod\.pdf"/);
    assert.match(raw, /%PDF-1\.7 invoice bytes/);
    assert.match(raw, /%PDF-1\.7 pod bytes/);
  });

  it('stays plain json when there is nothing to attach', async () => {
    const client = new UnipileHostedClient({ apiKey: 'test-key', dsn: base });
    await client.sendEmail({
      accountId: 'acct-1',
      to: ['broker@example.com'],
      subject: 's',
      body: 'b',
      idempotencyKey: 'k',
      attachments: [],
    });
    assert.equal(lastRequest!.headers['content-type'], 'application/json');
  });
});
