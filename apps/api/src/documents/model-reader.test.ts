/**
 * The model pass: response parsing, and the request against a real server.
 *
 * Two different things are worth this much test weight, for two different
 * reasons.
 *
 * `parseModelResponse` is pure and gets the exhaustive treatment because it is
 * the whole safety argument of this file: a model that is asked for a number
 * and instead points at the wrong four characters has to come out of this
 * function with nothing, not a wrong answer that looks like a right one.
 *
 * `AnthropicModelReader` gets one HTTP-level test, against a stub server on
 * localhost rather than a mocked `fetch` — same reasoning `azure-reader.test.ts`
 * gives for itself: a hand-rolled REST client whose only verification is a
 * stubbed function has never been serialised. What it proves is that this
 * client speaks the `/v1/messages` contract; the first call against real
 * Anthropic is still the first call against real Anthropic.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  AnthropicModelReader,
  ModelReaderError,
  parseModelResponse,
} from './model-reader.ts';

const RATECON_TEXT = [
  'PRAIRIE LOGISTICS LLC',
  'RATE CONFIRMATION',
  'Load Number: RC-9001',
  'Total Rate: $2,400.00',
  'Weight: 42,000 lbs',
].join('\n');

describe('parseModelResponse', () => {
  it('reads a well-formed reading', () => {
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.92,
        fields: [
          { field: 'rateAmount', raw: '$2,400.00' },
          { field: 'brokerLoadNumber', raw: 'RC-9001' },
        ],
      }),
      RATECON_TEXT,
    );

    assert.equal(reading?.kind, 'rate_confirmation');
    assert.equal(reading?.confidence, 0.92);
    // Re-derived through the same parseMoney the deterministic rules use —
    // not whatever number the model might have computed.
    assert.equal(reading?.fields['rateAmount']?.value, 240000);
    assert.equal(reading?.fields['rateAmount']?.raw, '$2,400.00');
    assert.equal(reading?.fields['brokerLoadNumber']?.value, 'RC-9001');
  });

  it('strips a markdown fence the model added despite being asked not to', () => {
    const fenced = '```json\n' + JSON.stringify({ kind: 'pod', confidence: 0.8, fields: [] }) + '\n```';
    const reading = parseModelResponse(fenced, RATECON_TEXT);
    assert.equal(reading?.kind, 'pod');
  });

  it('discards a field whose raw text is not actually on the page', () => {
    // The whole guard. A model that reports $9,999.00 when the page never
    // said that must produce nothing for this field, not a wrong number.
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.9,
        fields: [{ field: 'rateAmount', raw: '$9,999.00' }],
      }),
      RATECON_TEXT,
    );
    assert.equal(reading?.fields['rateAmount'], undefined);
  });

  it('keeps other fields when one is discarded', () => {
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.9,
        fields: [
          { field: 'rateAmount', raw: '$9,999.00' }, // not on the page
          { field: 'brokerLoadNumber', raw: 'RC-9001' }, // is
        ],
      }),
      RATECON_TEXT,
    );
    assert.equal(reading?.fields['rateAmount'], undefined);
    assert.equal(reading?.fields['brokerLoadNumber']?.value, 'RC-9001');
  });

  it('discards a field whose raw text cannot be parsed as its kind of value', () => {
    // "raw" is on the page and verbatim, but is not plainly a money amount —
    // same discipline extractDeterministically applies to a rule match.
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.9,
        fields: [{ field: 'rateAmount', raw: 'RATE CONFIRMATION' }],
      }),
      RATECON_TEXT,
    );
    assert.equal(reading?.fields['rateAmount'], undefined);
  });

  it('rejects a kind that is not one HaulQ recognises', () => {
    const reading = parseModelResponse(
      JSON.stringify({ kind: 'shipping_manifest', confidence: 0.9, fields: [] }),
      RATECON_TEXT,
    );
    assert.equal(reading, null);
  });

  it('rejects a missing or non-numeric confidence', () => {
    assert.equal(
      parseModelResponse(JSON.stringify({ kind: 'pod', fields: [] }), RATECON_TEXT),
      null,
    );
    assert.equal(
      parseModelResponse(
        JSON.stringify({ kind: 'pod', confidence: 'high', fields: [] }),
        RATECON_TEXT,
      ),
      null,
    );
  });

  it('clamps an out-of-range confidence rather than rejecting the whole reading', () => {
    // Not a hallucination risk the way a wrong field value is — just an
    // imprecise score, worth keeping rather than throwing away a real reading.
    const reading = parseModelResponse(
      JSON.stringify({ kind: 'pod', confidence: 1.4, fields: [] }),
      RATECON_TEXT,
    );
    assert.equal(reading?.confidence, 1);
  });

  it('returns null for unparseable JSON', () => {
    assert.equal(parseModelResponse('not json at all', RATECON_TEXT), null);
  });

  it('returns null for a JSON value that is not an object', () => {
    assert.equal(parseModelResponse('"just a string"', RATECON_TEXT), null);
    assert.equal(parseModelResponse('42', RATECON_TEXT), null);
  });

  it('tolerates a field entry with no usable shape without failing the rest', () => {
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.9,
        fields: [null, 'not an object', { field: 123, raw: 'x' }, { field: 'brokerLoadNumber', raw: 'RC-9001' }],
      }),
      RATECON_TEXT,
    );
    assert.equal(Object.keys(reading?.fields ?? {}).length, 1);
    assert.equal(reading?.fields['brokerLoadNumber']?.value, 'RC-9001');
  });

  it('marks every surviving field as model-sourced', () => {
    const reading = parseModelResponse(
      JSON.stringify({
        kind: 'rate_confirmation',
        confidence: 0.9,
        fields: [{ field: 'brokerLoadNumber', raw: 'RC-9001' }],
      }),
      RATECON_TEXT,
    );
    assert.equal(reading?.fields['brokerLoadNumber']?.label, 'model');
  });

  it('accepts an empty fields array — a page with nothing legible on it', () => {
    const reading = parseModelResponse(
      JSON.stringify({ kind: 'other', confidence: 0.1, fields: [] }),
      RATECON_TEXT,
    );
    assert.deepEqual(reading?.fields, {});
  });
});

// ---------------------------------------------------------------------------
// AnthropicModelReader, against a real HTTP server
// ---------------------------------------------------------------------------

interface Script {
  status: number;
  body?: unknown;
  /** Delay before responding, to exercise the abort/timeout path for real. */
  delayMs?: number;
}

let server: Server;
let base: string;
let script: Script;
const requests: Array<{ headers: Record<string, string>; body: string }> = [];

function reply(kind: string, confidence: number, fields: Array<{ field: string; raw: string }> = []) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ kind, confidence, fields }) }],
  };
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      requests.push({ headers: req.headers as Record<string, string>, body });
      if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs));
      res.statusCode = script.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(script.body ?? {}));
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
  script = { status: 200, body: reply('rate_confirmation', 0.9, [{ field: 'brokerLoadNumber', raw: 'RC-9001' }]) };
});

function reader(overrides: Record<string, unknown> = {}) {
  return new AnthropicModelReader({
    apiKey: 'test-key',
    baseUrl: base,
    timeoutMs: 2000,
    ...overrides,
  });
}

describe('AnthropicModelReader — the request it sends', () => {
  it('posts to /v1/messages with the documented auth headers', async () => {
    await reader().read(RATECON_TEXT, null);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.headers['x-api-key'], 'test-key');
    assert.equal(requests[0]!.headers['anthropic-version'], '2023-06-01');
    assert.equal(requests[0]!.headers['content-type'], 'application/json');
  });

  it('sends the source text and, when there is one, the deterministic guess', async () => {
    await reader().read(RATECON_TEXT, { kind: 'rate_confirmation', confidence: 0.5, reason: 'weak match' });

    const sent = JSON.parse(requests[0]!.body) as { messages: Array<{ content: string }> };
    assert.match(sent.messages[0]!.content, /RATE CONFIRMATION/);
    assert.match(sent.messages[0]!.content, /rate_confirmation/);
  });

  it('names itself after the model and the prompt version', () => {
    const r = reader({ model: 'claude-haiku-4-5-20251001' });
    assert.equal(r.name, 'anthropic/claude-haiku-4-5-20251001/model-extract-v1');
  });

  it('returns a verified reading from a well-formed reply', async () => {
    const reading = await reader().read(RATECON_TEXT, null);
    assert.equal(reading?.kind, 'rate_confirmation');
    assert.equal(reading?.fields['brokerLoadNumber']?.value, 'RC-9001');
  });
});

describe('AnthropicModelReader — a transport failure must be retried', () => {
  it('throws on a 5xx', async () => {
    script = { status: 503, body: { error: 'overloaded' } };
    await assert.rejects(
      () => reader().read(RATECON_TEXT, null),
      (err: unknown) => {
        assert.ok(err instanceof ModelReaderError);
        assert.ok(err.retryable);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  it('throws on a rate limit', async () => {
    script = { status: 429, body: { error: 'rate_limited' } };
    await assert.rejects(() => reader().read(RATECON_TEXT, null), ModelReaderError);
  });

  it('throws when the server is unreachable', async () => {
    await assert.rejects(
      () => reader({ baseUrl: 'http://127.0.0.1:1' }).read(RATECON_TEXT, null),
      ModelReaderError,
    );
  });

  it('throws when the deadline is exceeded', async () => {
    script = { status: 200, body: reply('pod', 0.9), delayMs: 50 };
    await assert.rejects(
      () => reader({ timeoutMs: 5 }).read(RATECON_TEXT, null),
      ModelReaderError,
    );
  });
});

describe('AnthropicModelReader — an unusable reply is an answer, not an error', () => {
  it('returns null when the model reply is not valid JSON', async () => {
    script = { status: 200, body: { content: [{ type: 'text', text: 'I cannot read this document.' }] } };
    const reading = await reader().read(RATECON_TEXT, null);
    assert.equal(reading, null);
  });

  it('returns null when the reply names a kind HaulQ does not recognise', async () => {
    script = { status: 200, body: reply('shipping_manifest', 0.9) };
    const reading = await reader().read(RATECON_TEXT, null);
    assert.equal(reading, null);
  });
});
