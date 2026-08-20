/**
 * The Azure Document Intelligence reader, against a real HTTP server.
 *
 * A stub Azure runs on localhost for this suite rather than a mocked `fetch`,
 * so the request that goes out is a real request: real headers, real base64
 * body, real 202-then-poll handshake. A hand-rolled REST client whose only
 * verification is a stubbed function is a client that has never been serialised.
 *
 * What it cannot prove is that the shapes match the live service. The request
 * path, the `Operation-Location` handshake and the `analyzeResult.content`
 * location come from Microsoft's REST reference for 2024-11-30; the stub asserts
 * this client speaks that contract, and the first call against real Azure is
 * still the first call against real Azure.
 *
 * Most of the effort here goes on one distinction, because it is expensive in
 * one direction and silent in the other:
 *
 *   a transport failure must throw, so the outbox retries
 *   an unreadable document must not, so the outbox does not spend eight pages
 *   of quota rediscovering that a blank scan is blank
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AzureDocumentReader, AzureReaderError, ChainedDocumentReader } from './azure-reader.ts';
import { FakeDocumentReader, LocalDocumentReader, type DocumentReader } from './reader.ts';

/** What the stub should do next. Set per test. */
interface Script {
  /** Status for the initial POST. 202 is the documented success. */
  analyzeStatus: number;
  analyzeBody?: unknown;
  /** Omit the Operation-Location header on the 202. */
  omitLocation?: boolean;
  /** Poll responses, consumed in order. The last one repeats. */
  polls: Array<{ status: number; body?: unknown }>;
}

let server: Server;
let base: string;
let script: Script;
const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];

const succeeded = (content: string, pages = 1) => ({
  status: 'succeeded',
  analyzeResult: {
    content,
    contentFormat: 'text',
    pages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1 })),
  },
});

const RATECON = [
  'PRAIRIE LOGISTICS LLC',
  'RATE CONFIRMATION',
  'Load Number: 84213',
  'Weight: 42,000 lbs',
  'Total Rate: $2,400.00',
].join('\n');

function reader(overrides: Record<string, unknown> = {}) {
  return new AzureDocumentReader({
    endpoint: base,
    key: 'test-key',
    pollIntervalMs: 1,
    timeoutMs: 2000,
    // No real waiting: the polling loop is exercised, the clock is not.
    sleep: async () => {},
    ...overrides,
  });
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      });

      if (req.method === 'POST') {
        res.statusCode = script.analyzeStatus;
        if (script.analyzeStatus === 202 && !script.omitLocation) {
          res.setHeader(
            'operation-location',
            `${base}/documentintelligence/documentModels/prebuilt-read/analyzeResults/abc-123?api-version=2024-11-30`,
          );
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(script.analyzeBody ?? {}));
        return;
      }

      const next = script.polls.length > 1 ? script.polls.shift()! : script.polls[0]!;
      res.statusCode = next.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(next.body ?? {}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  script = { analyzeStatus: 202, polls: [{ status: 200, body: succeeded(RATECON) }] };
});

describe('AzureDocumentReader — the request it sends', () => {
  it('posts the document and returns what Azure read', async () => {
    const result = await reader().read(Buffer.from('scanned bytes'), 'image/jpeg');

    assert.equal(result.text, RATECON);
    assert.equal(result.pageCount, 1);
    assert.equal(result.version, 'azure-di/prebuilt-read/2024-11-30');
  });

  it('uses prebuilt-read, which is the cheapest model that answers the question', async () => {
    await reader().read(Buffer.from('bytes'), 'image/jpeg');
    const post = requests.find((r) => r.method === 'POST')!;

    assert.match(post.url, /documentModels\/prebuilt-read:analyze/);
    assert.match(post.url, /api-version=2024-11-30/);
    assert.match(post.url, /_overload=analyzeDocument/);
    assert.ok(
      !post.url.includes('layout'),
      'layout costs a large multiple per page and none of its output is used',
    );
  });

  it('authenticates with the subscription key header', async () => {
    await reader().read(Buffer.from('bytes'), 'image/jpeg');
    for (const request of requests) {
      assert.equal(request.headers['ocp-apim-subscription-key'], 'test-key', request.url);
    }
  });

  it('sends the bytes as base64Source, intact', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await reader().read(bytes, 'image/jpeg');

    const post = requests.find((r) => r.method === 'POST')!;
    const parsed = JSON.parse(post.body) as { base64Source: string };
    assert.deepEqual(Buffer.from(parsed.base64Source, 'base64'), bytes);
  });

  it('does not produce a double slash when the endpoint has a trailing one', async () => {
    await reader({ endpoint: `${base}/` }).read(Buffer.from('bytes'), 'image/jpeg');
    const post = requests.find((r) => r.method === 'POST')!;
    assert.ok(!post.url.includes('//documentintelligence'), post.url);
  });

  it('polls until the operation finishes', async () => {
    script.polls = [
      { status: 202 },
      { status: 200, body: { status: 'running' } },
      { status: 200, body: succeeded(RATECON, 3) },
    ];

    const result = await reader().read(Buffer.from('bytes'), 'application/pdf');
    assert.equal(result.text, RATECON);
    assert.equal(result.pageCount, 3);
    assert.equal(requests.filter((r) => r.method === 'GET').length, 3);
  });

  it('feeds the classifier and extractor the same way the local reader does', async () => {
    // The whole point of returning plain text: everything downstream is already
    // written and tested, and does not care where the words came from.
    const { classifyDeterministically, extractDeterministically, isConfident } = await import(
      '@haulq/contracts'
    );
    const result = await reader().read(Buffer.from('bytes'), 'image/jpeg');

    const classified = classifyDeterministically({ text: result.text ?? '' });
    assert.equal(classified?.kind, 'rate_confirmation');
    assert.ok(isConfident(classified));

    const extracted = extractDeterministically({
      text: result.text ?? '',
      kind: 'rate_confirmation',
    });
    assert.equal(extracted.fields['rateAmount']?.value, 240000);
  });
});

describe('AzureDocumentReader — an unreadable document is an answer', () => {
  it('returns no text when Azure reports failure, rather than throwing', async () => {
    script.polls = [
      {
        status: 200,
        body: { status: 'failed', error: { code: 'InvalidImage', message: 'unreadable' } },
      },
    ];

    const result = await reader().read(Buffer.from('bytes'), 'image/jpeg');
    assert.equal(
      result.text,
      null,
      'retrying cannot make a blank page legible; it just spends the quota',
    );
    assert.equal(result.version, 'azure-di/prebuilt-read/2024-11-30');
  });

  it('treats a near-empty result as unread', async () => {
    script.polls = [{ status: 200, body: succeeded('  .  ') }];
    const result = await reader().read(Buffer.from('bytes'), 'image/jpeg');
    assert.equal(result.text, null);
  });

  it('still reports the page count of a document it could not read', async () => {
    script.polls = [{ status: 200, body: succeeded('x', 4) }];
    const result = await reader().read(Buffer.from('bytes'), 'application/pdf');
    assert.equal(result.text, null);
    assert.equal(result.pageCount, 4);
  });
});

describe('AzureDocumentReader — a transport failure must be retried', () => {
  it('throws when the service is unavailable', async () => {
    script.analyzeStatus = 503;
    await assert.rejects(
      () => reader().read(Buffer.from('bytes'), 'image/jpeg'),
      (e: AzureReaderError) => e.name === 'AzureReaderError' && e.status === 503,
    );
  });

  it('throws on a throttle, so the outbox backs off', async () => {
    script.analyzeStatus = 429;
    await assert.rejects(
      () => reader().read(Buffer.from('bytes'), 'image/jpeg'),
      (e: AzureReaderError) => e.status === 429,
    );
  });

  it('surfaces Azure\'s own message rather than a status code', async () => {
    script.analyzeStatus = 401;
    script.analyzeBody = {
      error: { code: 'Unauthorized', message: 'Access denied due to invalid subscription key.' },
    };

    await assert.rejects(
      () => reader().read(Buffer.from('bytes'), 'image/jpeg'),
      (e: Error) => /invalid subscription key/i.test(e.message),
    );
  });

  it('throws when the 202 carries no Operation-Location', async () => {
    script.omitLocation = true;
    await assert.rejects(
      () => reader().read(Buffer.from('bytes'), 'image/jpeg'),
      /no Operation-Location/,
    );
  });

  it('throws when the endpoint is not there at all', async () => {
    const unreachable = reader({ endpoint: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => unreachable.read(Buffer.from('bytes'), 'image/jpeg'),
      (e: AzureReaderError) => e.name === 'AzureReaderError',
    );
  });

  it('gives up rather than holding an outbox lease open forever', async () => {
    // A stuck operation that never settles. Without the deadline the lease
    // expires, the message is redelivered, and a second analysis of the same
    // page starts — paying twice to wait twice.
    script.polls = [{ status: 200, body: { status: 'running' } }];
    await assert.rejects(
      () => reader({ timeoutMs: 30 }).read(Buffer.from('bytes'), 'image/jpeg'),
      /did not finish within 30ms/,
    );
  });

  it('keeps polling through a status it does not recognise', async () => {
    // An unknown status treated as failure would silently drop a readable
    // document; treated as running it costs one extra poll.
    script.polls = [
      { status: 200, body: { status: 'somethingNew' } },
      { status: 200, body: succeeded(RATECON) },
    ];
    const result = await reader().read(Buffer.from('bytes'), 'image/jpeg');
    assert.equal(result.text, RATECON);
  });
});

describe('ChainedDocumentReader', () => {
  /** A reader that records whether it was asked to do anything. */
  class Spy implements DocumentReader {
    readonly name = 'spy';
    calls = 0;
    async read() {
      this.calls += 1;
      return { text: null, pageCount: null, version: this.name };
    }
  }

  it('never reaches Azure for a document the free path could read', async () => {
    const spy = new Spy();
    const local = new FakeDocumentReader();
    const bytes = Buffer.from('digital pdf');
    const { createHash } = await import('node:crypto');
    local.give(createHash('sha256').update(bytes).digest('hex'), RATECON);

    const chain = new ChainedDocumentReader([local, spy]);
    const result = await chain.read(bytes, 'application/pdf');

    assert.equal(result.text, RATECON);
    assert.equal(spy.calls, 0, 'this is the cost control, and it is the whole point');
  });

  it('falls through to the next reader when the first declines', async () => {
    const chain = new ChainedDocumentReader([new LocalDocumentReader(), reader()]);
    // A JPEG has no text layer, so the local reader declines immediately.
    const result = await chain.read(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');

    assert.equal(result.text, RATECON);
    assert.equal(
      result.version,
      'azure-di/prebuilt-read/2024-11-30',
      'the version must name the reader that actually read it, for the re-read check',
    );
  });

  it('reports both readers in its own name, for the startup log', async () => {
    const chain = new ChainedDocumentReader([new LocalDocumentReader(), reader()]);
    assert.equal(chain.name, 'local-pdf-text+azure-di/prebuilt-read/2024-11-30');
  });

  it('keeps a page count from a reader that found no text', async () => {
    const counting: DocumentReader = {
      name: 'counts-only',
      read: async () => ({ text: null, pageCount: 7, version: 'counts-only' }),
    };
    const chain = new ChainedDocumentReader([counting, new Spy()]);
    const result = await chain.read(Buffer.from('x'), 'application/pdf');
    assert.equal(result.pageCount, 7);
  });

  it('refuses to be built with nothing to chain', () => {
    assert.throws(() => new ChainedDocumentReader([]), /at least one reader/);
  });
});
