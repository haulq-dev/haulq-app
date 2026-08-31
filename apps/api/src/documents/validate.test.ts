/**
 * Validation, through the whole stack.
 *
 * A real PDF is uploaded, the real outbox reads it, and the real load record is
 * what it gets compared against. The unit suite in `@haulq/contracts` already
 * covers what each disagreement means; what this one covers is the wiring, and
 * specifically the ordering problem that makes it awkward:
 *
 * **A rate confirmation usually arrives before the load exists.** So the two
 * halves land in either order, and whichever is second has to be the one that
 * produces a verdict. Both orders are tested.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import {
  createDocument,
  createLoad,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  drainOutbox,
  MemoryObjectStore,
  recordExtraction,
  testScope,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';
import { buildOutboxHandlers } from '../outbox/handlers.ts';
import { LocalDocumentReader } from './reader.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let app: FastifyInstance;
let userId: string;
const createdOrgs: string[] = [];

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

const ratecon = (rate: string, loadNumber = '84213') =>
  pdf([
    'PRAIRIE LOGISTICS LLC',
    'RATE CONFIRMATION',
    `Load Number: ${loadNumber}`,
    'Weight: 42,000 lbs',
    `Total Rate: ${rate}`,
  ]);

const as = (orgId: string) => ({
  'x-haulq-org-id': orgId,
  'x-haulq-user-id': userId,
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

async function aLoad(orgId: string, overrides: Record<string, unknown> = {}) {
  return createLoad(testScope(app.db, orgId, { type: 'user', id: userId }), {
    brokerName: 'Prairie Freight',
    brokerLoadNumber: '84213',
    rate: { amount: 240000, currency: 'USD' },
    weightLbs: 42000,
    stops: [
      { type: 'pickup', city: 'Wichita', state: 'KS' },
      { type: 'delivery', city: 'Denver', state: 'CO' },
    ],
    ...overrides,
  });
}

async function upload(orgId: string, bytes: Buffer, query = '') {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/documents?filename=ratecon.pdf${query}`,
    headers: { ...as(orgId), 'content-type': 'application/pdf' },
    payload: bytes,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().document as { id: string };
}

async function drain() {
  const handlers = buildOutboxHandlers({
    mailer: { send: async () => {} } as never,
    webOrigin: 'http://localhost:5173',
    db: app.db,
    storage: app.storage,
    reader: new LocalDocumentReader(),
    log: { info: () => {}, warn: () => {} },
  });
  return drainOutbox(app.db, { handlers });
}

async function fetchDoc(orgId: string, id: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/documents/${id}`, headers: as(orgId) });
  return res.json().document;
}

const attach = (orgId: string, documentId: string, loadId: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/documents/${documentId}/attach`,
    headers: as(orgId),
    payload: { loadId },
  });

suite('document validation', () => {
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

  describe('load first, then the document', () => {
    it('validates during the read when the document arrives already attached', async () => {
      const orgId = await newOrg('Load First Co');
      const load = await aLoad(orgId);
      const doc = await upload(orgId, ratecon('$2,400.00'), `&loadId=${load.id}`);

      await drain();
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.status, 'validated');
      assert.equal(after.rejectionReason, null);
      assert.ok(after.validation.length > 0, 'findings were recorded');
      assert.ok(
        after.validation.every((f: { agrees: boolean }) => f.agrees),
        JSON.stringify(after.validation, null, 1),
      );
    });

    it('rejects a rate confirmation whose rate is not what was agreed', async () => {
      const orgId = await newOrg('Wrong Rate Co');
      const load = await aLoad(orgId);
      const doc = await upload(orgId, ratecon('$2,600.00'), `&loadId=${load.id}`);

      await drain();
      const after = await fetchDoc(orgId, doc.id);

      assert.equal(after.status, 'rejected');
      assert.match(after.rejectionReason, /rate is \$2,600\.00 on the document but \$2,400\.00 on the load/);
    });

    it('records the rejection in the timeline as a sentence a carrier can act on', async () => {
      const orgId = await newOrg('Timeline Co');
      const load = await aLoad(orgId);
      await upload(orgId, ratecon('$2,600.00'), `&loadId=${load.id}`);
      await drain();

      const timeline = await app.inject({
        method: 'GET',
        url: '/v1/timeline?limit=20',
        headers: as(orgId),
      });
      const rejected = timeline
        .json()
        .items.find((e: { verb: string }) => e.verb === 'document.rejected');

      assert.ok(rejected, 'no document.rejected event');
      assert.match(rejected.explanation, /does not match load \d+/);
      assert.match(rejected.explanation, /\$2,600\.00/);
      assert.equal(rejected.actorType, 'agent', 'a model read it, and the log must say so');
    });
  });

  describe('document first, then the load', () => {
    it('leaves a verdict for the attach, because there is nothing to compare yet', async () => {
      const orgId = await newOrg('Doc First Co');
      const doc = await upload(orgId, ratecon('$2,400.00'));

      await drain();
      const beforeAttach = await fetchDoc(orgId, doc.id);
      assert.equal(beforeAttach.status, 'extracted', 'read, but nothing to check it against');
      assert.equal(beforeAttach.validation, null);

      const load = await aLoad(orgId);
      const res = await attach(orgId, doc.id, load.id);

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().validation.outcome, 'validated');

      const afterAttach = await fetchDoc(orgId, doc.id);
      assert.equal(afterAttach.status, 'validated');
      assert.ok(afterAttach.validation.length > 0);
    });

    it('rejects on attach when the paperwork does not match the load it was hung on', async () => {
      const orgId = await newOrg('Wrong Load Co');
      const doc = await upload(orgId, ratecon('$2,400.00', '99999'));
      await drain();

      const load = await aLoad(orgId);
      const res = await attach(orgId, doc.id, load.id);

      assert.equal(res.json().validation.outcome, 'rejected');
      assert.match(res.json().validation.reason, /brokerLoadNumber/);

      const after = await fetchDoc(orgId, doc.id);
      assert.equal(after.status, 'rejected');
    });

    it('re-attaching to the right load clears the rejection', async () => {
      const orgId = await newOrg('Correction Co');
      const wrong = await aLoad(orgId, { brokerLoadNumber: '11111' });
      const right = await aLoad(orgId, { brokerLoadNumber: '84213' });
      const doc = await upload(orgId, ratecon('$2,400.00'));
      await drain();

      await attach(orgId, doc.id, wrong.id);
      assert.equal((await fetchDoc(orgId, doc.id)).status, 'rejected');

      const fixed = await attach(orgId, doc.id, right.id);
      assert.equal(fixed.json().validation.outcome, 'validated');

      const after = await fetchDoc(orgId, doc.id);
      assert.equal(after.status, 'validated');
      assert.equal(
        after.rejectionReason,
        null,
        'a document that no longer disagrees must stop explaining a problem it does not have',
      );
    });
  });

  describe('what it will not do', () => {
    it('does not validate a document nothing has read', async () => {
      const orgId = await newOrg('Unread Co');
      // A JPEG has no text layer, so the pipeline asks for OCR and writes nothing.
      const scan = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 3)]);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/documents?filename=scan.jpg',
        headers: { ...as(orgId), 'content-type': 'image/jpeg' },
        payload: scan,
      });
      const doc = res.json().document;
      await drain();

      const load = await aLoad(orgId);
      const attached = await attach(orgId, doc.id, load.id);

      assert.equal(attached.statusCode, 200);
      assert.equal(
        attached.json().validation,
        null,
        'a green tick over an unread document is the most expensive kind of wrong',
      );
      assert.equal((await fetchDoc(orgId, doc.id)).status, 'received');
    });

    it('does not block a packet on a weight outside tolerance', async () => {
      const orgId = await newOrg('Heavy Co');
      const load = await aLoad(orgId, { weightLbs: 36000 });
      const doc = await upload(orgId, ratecon('$2,400.00'), `&loadId=${load.id}`);
      await drain();

      const after = await fetchDoc(orgId, doc.id);
      assert.equal(after.status, 'validated');

      const weight = after.validation.find((f: { field: string }) => f.field === 'weightLbs');
      assert.equal(weight.agrees, false);
      assert.equal(weight.severity, 'warning');
    });
  });

  describe('sender domain consistency', () => {
    /** A distinct digest per call, so documents do not dedupe into each other. */
    const digest = () => randomUUID().replace(/-/g, '').repeat(2).slice(0, 64);

    /**
     * A document seeded directly through the repository rather than the
     * upload route — `POST /v1/documents` never sets `receivedFrom` (only
     * Postmark inbound intake does), and this suite needs full control over
     * it to set up a broker's sending history.
     */
    async function emailedDoc(orgId: string, loadId: string, receivedFrom: string) {
      const s = testScope(app.db, orgId, { type: 'user', id: userId });
      const { document } = await createDocument(s, {
        storageKey: `${orgId}/documents/${randomUUID()}.pdf`,
        sha256: digest(),
        source: 'email_intake',
        receivedFrom,
        loadId,
      });
      await recordExtraction(s, document.id, {
        extracted: {},
        extractorVersion: 'test',
        kind: 'rate_confirmation',
      });
      // Already attached at creation — re-attaching to the same load is a
      // no-op on the load pointer, but the route still runs validateDocument
      // afterward, which is what actually records a verdict.
      await attach(orgId, document.id, loadId);
      return document;
    }

    it('says nothing about a broker\'s first-ever emailed document — no baseline yet', async () => {
      const orgId = await newOrg('First Email Co');
      const load = await aLoad(orgId);
      const doc = await emailedDoc(orgId, load.id, 'dispatch@realbroker.test');

      const fetched = await fetchDoc(orgId, doc.id);
      assert.equal(
        fetched.validation.find((f: { field: string }) => f.field === 'senderDomain'),
        undefined,
      );
    });

    it('agrees when a later document arrives from the same domain', async () => {
      const orgId = await newOrg('Repeat Domain Co');
      const first = await aLoad(orgId);
      await emailedDoc(orgId, first.id, 'dispatch@realbroker.test');

      const second = await aLoad(orgId, { brokerLoadNumber: '55555' });
      const doc = await emailedDoc(orgId, second.id, 'ops@realbroker.test');

      const fetched = await fetchDoc(orgId, doc.id);
      const finding = fetched.validation.find((f: { field: string }) => f.field === 'senderDomain');
      assert.ok(finding, 'no senderDomain finding recorded');
      assert.equal(finding.agrees, true);
      assert.equal(fetched.status, 'validated');
    });

    it('warns without rejecting when a later document arrives from a different domain', async () => {
      const orgId = await newOrg('Different Domain Co');
      const first = await aLoad(orgId);
      await emailedDoc(orgId, first.id, 'dispatch@realbroker.test');

      const second = await aLoad(orgId, { brokerLoadNumber: '55555' });
      const doc = await emailedDoc(orgId, second.id, 'someone@totally-different.test');

      const fetched = await fetchDoc(orgId, doc.id);
      const finding = fetched.validation.find((f: { field: string }) => f.field === 'senderDomain');
      assert.ok(finding, 'no senderDomain finding recorded');
      assert.equal(finding.agrees, false);
      assert.equal(finding.severity, 'warning');
      assert.equal(
        fetched.status,
        'validated',
        'a domain mismatch is a signal, not proof — it must never reject a document on its own',
      );
    });
  });
});
