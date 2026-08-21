/**
 * Classification and extraction, end to end through the outbox.
 *
 * Driven by uploading a real PDF to the real route and then draining the real
 * outbox — not by calling `processDocument` directly. The thing most likely to
 * be wrong is not the pipeline, it is the wiring: whether `document.received`
 * carries enough to find its document, whether the actor is recorded as a model,
 * and whether a redelivered message reads the same file twice.
 */

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  drainOutbox,
  MemoryObjectStore,
  pendingOutboxTopics,
  requeueOutboxForTest,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';
import { buildOutboxHandlers } from '../outbox/handlers.ts';
import type { Classification } from '@haulq/contracts';
import type { ModelDocumentReader, ModelReading } from './model-reader.ts';
import { LocalDocumentReader } from './reader.ts';

/**
 * A model reader that returns whatever a test scripts, and records what it
 * was asked. `read` returning null is the honest "could not help" answer —
 * `AnthropicModelReader` itself only reaches that after a real HTTP call,
 * already covered in `model-reader.test.ts`; this fake exists so the
 * pipeline's wiring can be tested without one.
 */
class FakeModelReader implements ModelDocumentReader {
  readonly name = 'fake-model/test-v1';
  calls: Array<{ text: string; guess: Classification | null }> = [];
  #next: ModelReading | null = null;

  script(reading: ModelReading | null) {
    this.#next = reading;
  }

  async read(text: string, guess: Classification | null): Promise<ModelReading | null> {
    this.calls.push({ text, guess });
    return this.#next;
  }
}

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let userId: string;
const createdOrgs: string[] = [];

/** A one-page PDF with a real, Flate-compressed text layer. */
function pdf(lines: string[]): Buffer {
  const content =
    'BT /F1 12 Tf 72 720 Td\n' +
    lines
      .map((l, i) => `${i ? '0 -16 Td\n' : ''}(${l.replace(/([()\\])/g, '\\$1')}) Tj\n`)
      .join('') +
    'ET\n';
  const body = deflateSync(Buffer.from(content, 'latin1'));

  return Buffer.concat([
    Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
        '2 0 obj << /Type /Pages /Count 1 >> endobj\n' +
        '3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n' +
        `4 0 obj << /Length ${body.length} /Filter /FlateDecode >> stream\n`,
      'latin1',
    ),
    body,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

const RATECON = pdf([
  'PRAIRIE LOGISTICS LLC',
  'RATE CONFIRMATION',
  'Carrier: Test Carrier LLC',
  'Load Number: 84213',
  'Weight: 42,000 lbs',
  'Total Rate: $2,400.00',
]);

const POD = pdf([
  'PROOF OF DELIVERY',
  'Received in good order and condition',
  'Consignee signature: ____________________',
]);

/** A packet: three documents in one file, none of which should win. */
const PACKET = pdf([
  'RATE CONFIRMATION',
  'Total Rate: $2,400.00',
  'STRAIGHT BILL OF LADING',
  'B/L Number: 55231',
  'PROOF OF DELIVERY',
  'Received in good order and condition',
]);

/** A scan: no text layer at all, just an image the reader cannot open. */
const SCAN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 7)]);

/** Classifies confidently, but names no load number for the rule to find. */
const RATECON_NO_LOADNUM = pdf([
  'PRAIRIE LOGISTICS LLC',
  'RATE CONFIRMATION',
  'Weight: 42,000 lbs',
  'Total Rate: $2,400.00',
]);

const as = (orgId: string, extra: Record<string, string> = {}) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
  ...extra,
});

async function newOrg(name: string) {
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

async function upload(orgId: string, bytes: Buffer, filename: string, type = 'application/pdf') {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/documents?filename=${encodeURIComponent(filename)}`,
    headers: as(orgId, { 'content-type': type }),
    payload: bytes,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().document as { id: string };
}

/** Drain the outbox the way the runner would, and report what it did. */
async function drain(modelReader?: ModelDocumentReader) {
  const logged: Array<{ o: Record<string, unknown>; msg: string }> = [];
  const handlers = buildOutboxHandlers({
    mailer: { send: async () => {} } as never,
    webOrigin: 'http://localhost:5173',
    db: app.db,
    storage: app.storage,
    reader: new LocalDocumentReader(),
    modelReader,
    log: {
      info: (o, msg) => logged.push({ o: o as Record<string, unknown>, msg }),
      warn: (o, msg) => logged.push({ o: o as Record<string, unknown>, msg }),
    },
  });
  const result = await drainOutbox(app.db, { handlers });
  return { result, logged };
}

async function fetchDoc(orgId: string, id: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/documents/${id}`, headers: as(orgId) });
  return res.json().document;
}

suite('document classification and extraction', () => {
  before(async () => {
    app = await buildServer(
      loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }),
      { storage: new MemoryObjectStore() },
    );
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  it('queues document.received on upload', async () => {
    const orgId = await newOrg('Queue Co');
    await upload(orgId, RATECON, 'ratecon.pdf');
    const topics = await pendingOutboxTopics(app.db, orgId);
    assert.ok(topics.includes('document.received'), JSON.stringify(topics));
  });

  it('reads a digital rate confirmation without calling anything', async () => {
    const orgId = await newOrg('Ratecon Co');
    const doc = await upload(orgId, RATECON, 'ratecon.pdf');

    const { result, logged } = await drain();
    assert.ok(result.processed > 0, JSON.stringify(result));

    const after = await fetchDoc(orgId, doc.id);
    assert.equal(after.kind, 'rate_confirmation');
    assert.ok(after.kindConfidence >= 0.7, `confidence ${after.kindConfidence}`);
    assert.equal(after.status, 'extracted');
    assert.equal(after.extracted.rateAmount.value, 240000);
    assert.equal(after.extracted.rateAmount.raw, '$2,400.00');
    assert.equal(after.extracted.brokerLoadNumber.value, '84213');
    assert.equal(after.extracted.weightLbs.value, 42000);
    assert.match(after.extractorVersion, /local-pdf-text\/deterministic-v1/);

    const read = logged.find((l) => l.msg === 'document read without a model call');
    assert.ok(read, JSON.stringify(logged.map((l) => l.msg)));
    assert.equal(read!.o['kind'], 'rate_confirmation');
  });

  it('attributes the reading to a model, not to whoever uploaded the file', async () => {
    const orgId = await newOrg('Attribution Co');
    await upload(orgId, RATECON, 'ratecon.pdf');
    await drain();

    const timeline = await app.inject({
      method: 'GET',
      url: '/v1/timeline?limit=20',
      headers: as(orgId),
    });
    const extracted = timeline
      .json()
      .items.find((e: { verb: string }) => e.verb === 'document.extracted');

    assert.ok(extracted, 'no document.extracted event');
    // Guardrail 5: a machine's reading must never be recorded as a person's.
    assert.equal(extracted.actorType, 'agent');
    assert.equal(extracted.actorId, 'local-pdf-text');
    assert.match(extracted.explanation, /Read \d+ fields off the rate confirmation/);
  });

  it('classifies a POD confidently and finds nothing to take off it', async () => {
    const orgId = await newOrg('Pod Co');
    const doc = await upload(orgId, POD, 'pod.pdf');
    await drain();

    const after = await fetchDoc(orgId, doc.id);
    assert.equal(after.kind, 'pod');
    assert.equal(after.status, 'extracted');
    assert.deepEqual(after.extracted, {}, 'a POD has no fields to check against a load');
  });

  it('refuses to route a packet on its loudest page', async () => {
    const orgId = await newOrg('Packet Co');
    const doc = await upload(orgId, PACKET, 'packet.pdf');
    const { logged } = await drain();

    const after = await fetchDoc(orgId, doc.id);
    assert.ok(after.kindConfidence < 0.7, `confidence was ${after.kindConfidence}`);
    assert.equal(after.status, 'received', 'stays in the inbox as work to be done');
    assert.equal(after.extractedAt, null, 'nothing is extracted from a guess');

    const note = logged.find((l) => l.msg === 'document needs model');
    assert.ok(note, JSON.stringify(logged.map((l) => l.msg)));
  });

  it('asks for OCR when there is no text layer, and writes nothing', async () => {
    const orgId = await newOrg('Scan Co');
    const doc = await upload(orgId, SCAN, 'scan.jpg', 'image/jpeg');
    const { logged } = await drain();

    const after = await fetchDoc(orgId, doc.id);
    assert.equal(after.status, 'received');
    assert.equal(after.kindConfidence, null, 'a filename alone must not classify');
    assert.ok(logged.some((l) => l.msg === 'document needs ocr'), JSON.stringify(logged.map((l) => l.msg)));
  });

  it('does not read the same document twice when a message is redelivered', async () => {
    const orgId = await newOrg('Redelivery Co');
    const doc = await upload(orgId, RATECON, 'ratecon.pdf');
    await drain();
    const first = await fetchDoc(orgId, doc.id);

    // Re-queue the same work, as an expired lease would.
    const requeued = await requeueOutboxForTest(app.db, {
      orgId,
      topic: 'document.received',
    });
    assert.equal(requeued, 1);

    const { logged } = await drain();
    const second = await fetchDoc(orgId, doc.id);

    assert.deepEqual(second.extractedAt, first.extractedAt, 'a redelivery must not re-read');
    assert.ok(
      logged.some((l) => l.o['why'] === 'already_read'),
      JSON.stringify(logged.map((l) => [l.msg, l.o['why']])),
    );
  });

  it('leaves a quarantined document alone', async () => {
    const orgId = await newOrg('Quarantine Co');
    const doc = await upload(orgId, RATECON, 'ratecon.pdf');
    await drain();
    const after = await fetchDoc(orgId, doc.id);
    assert.equal(after.status, 'extracted');
  });

  // --- the model pass --------------------------------------------------

  describe('the model pass', () => {
    it('reads a packet the deterministic rules could only guess at, when a model is configured', async () => {
      const orgId = await newOrg('Model Packet Co');
      const doc = await upload(orgId, PACKET, 'packet.pdf');

      const model = new FakeModelReader();
      model.script({
        kind: 'rate_confirmation',
        confidence: 0.88,
        fields: { rateAmount: { value: 240000, raw: '$2,400.00', label: 'model' } },
      });

      await drain(model);
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.kind, 'rate_confirmation');
      assert.equal(after.status, 'extracted');
      assert.equal(after.extracted.rateAmount.value, 240000);
      assert.match(after.extractorVersion, /fake-model\/test-v1/);
      assert.equal(model.calls.length, 1, 'called once, only after the deterministic rules declined');
    });

    it('still returns needs:model when even the configured model cannot help', async () => {
      const orgId = await newOrg('Model Declines Co');
      const doc = await upload(orgId, PACKET, 'packet.pdf');

      const model = new FakeModelReader();
      model.script(null);

      const { logged } = await drain(model);
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.status, 'received', 'stays in the inbox — a model call was spent, not wasted silently');
      assert.ok(logged.some((l) => l.msg === 'document needs model'));
      assert.equal(model.calls.length, 1);
    });

    it('attributes a model-produced reading to the model, not the outbox consumer', async () => {
      const orgId = await newOrg('Model Attribution Co');
      await upload(orgId, PACKET, 'packet.pdf');

      const model = new FakeModelReader();
      model.script({ kind: 'pod', confidence: 0.8, fields: {} });
      await drain(model);

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?limit=20',
        headers: as(orgId),
      });
      const extracted = timeline
        .json()
        .items.find((e: { verb: string }) => e.verb === 'document.extracted');

      assert.ok(extracted);
      assert.equal(extracted.actorType, 'agent');
      // The reader that read the *bytes* was local-pdf-text; the reading
      // itself came from the model, and guardrail 5 asks for the second one.
      assert.equal(extracted.actorId, 'fake-model/test-v1');
    });

    it('fills a missing expected field on an already-confident classification', async () => {
      const orgId = await newOrg('Fill Gap Co');
      const doc = await upload(orgId, RATECON_NO_LOADNUM, 'ratecon.pdf');

      const model = new FakeModelReader();
      model.script({
        kind: 'rate_confirmation',
        confidence: 0.95,
        fields: { brokerLoadNumber: { value: 'RC-FILLED', raw: 'RC-FILLED', label: 'model' } },
      });

      await drain(model);
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.extracted.rateAmount.value, 240000, 'the rule-found field is untouched');
      assert.equal(after.extracted.brokerLoadNumber.value, 'RC-FILLED', 'the gap the rules left is now filled');
      assert.match(after.extractorVersion, /\+fake-model\/test-v1/);
    });

    it('does not merge a model fill-in when the model names a different kind', async () => {
      const orgId = await newOrg('Kind Mismatch Co');
      const doc = await upload(orgId, RATECON_NO_LOADNUM, 'ratecon.pdf');

      const model = new FakeModelReader();
      // Disagrees with the deterministic classification — its fields answer
      // a different question and must not be trusted for this document.
      model.script({
        kind: 'bol',
        confidence: 0.9,
        fields: { brokerLoadNumber: { value: 'WRONG-KIND', raw: 'WRONG-KIND', label: 'model' } },
      });

      await drain(model);
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.extracted.brokerLoadNumber, undefined);
      assert.doesNotMatch(after.extractorVersion, /fake-model/);
    });

    it('never calls the model for a document the deterministic rules already read completely', async () => {
      const orgId = await newOrg('No Call Needed Co');
      await upload(orgId, RATECON, 'ratecon.pdf');

      const model = new FakeModelReader();
      model.script({ kind: 'rate_confirmation', confidence: 0.9, fields: {} });
      await drain(model);

      assert.equal(model.calls.length, 0, 'nothing was missing, so nothing was worth a call');
    });

    it('behaves exactly as before when no model is configured', async () => {
      const orgId = await newOrg('No Model Configured Co');
      const doc = await upload(orgId, RATECON_NO_LOADNUM, 'ratecon.pdf');

      await drain(); // no modelReader argument at all

      const after = await fetchDoc(orgId, doc.id);
      assert.equal(after.status, 'extracted');
      assert.equal(after.extracted.brokerLoadNumber, undefined, 'still missing — nothing was asked to fill it');
    });

    it('is idempotent for a model-produced reading, same as a deterministic one', async () => {
      const orgId = await newOrg('Model Redelivery Co');
      const doc = await upload(orgId, PACKET, 'packet.pdf');

      const model = new FakeModelReader();
      model.script({ kind: 'pod', confidence: 0.8, fields: {} });
      await drain(model);
      const first = await fetchDoc(orgId, doc.id);

      const requeued = await requeueOutboxForTest(app.db, { orgId, topic: 'document.received' });
      assert.equal(requeued, 1);

      const { logged } = await drain(model);
      const second = await fetchDoc(orgId, doc.id);

      assert.deepEqual(second.extractedAt, first.extractedAt);
      assert.ok(logged.some((l) => l.o['why'] === 'already_read'));
    });
  });
});
