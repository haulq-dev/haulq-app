/**
 * Rate confirmation to draft load, end to end.
 * `FEATURE_REQUESTS_PLAN.md` section 12.
 *
 * Driven the way it happens: a real PDF is uploaded to the real route, the real
 * outbox is drained, and a proposal appears (or, as often, does not). The model
 * is a fake that answers with whatever a test scripts, but its answer goes
 * through the real `parseLoadResponse`, so a lie in it is caught by the same code
 * that catches one in production.
 *
 * What is worth a server here is the restraint: nothing is proposed without a
 * key or for a document that is not a rate confirmation, a redelivery does not
 * read twice, a model that is down does not fail the delivery, a carrier stops
 * at its daily allowance, and a load is created only by a person, once, however
 * many people click.
 */

import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { parseLoadResponse, type LoadReading } from '@haulq/contracts';
import {
  addTestMembership,
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
import { ModelReaderError, type ModelDocumentReader, type ModelReading } from '../documents/model-reader.ts';
import { LocalDocumentReader } from '../documents/reader.ts';
import { buildOutboxHandlers } from '../outbox/handlers.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

/** A model that answers with what a test scripts, through the real checking. */
class FakeLoadReader implements ModelDocumentReader {
  readonly name = 'fake-model/test-v1';
  readonly loadReaderName = 'fake-model/load-v1';
  calls = 0;
  reply: string | null = null;
  failWith: Error | undefined;

  async read(): Promise<ModelReading | null> {
    return null;
  }

  async readLoad(text: string): Promise<LoadReading | null> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    return this.reply === null ? null : parseLoadResponse(this.reply, text);
  }
}

/** A one-page PDF with a real, Flate-compressed text layer. */
function pdf(lines: string[]): Buffer {
  const content =
    'BT /F1 12 Tf 72 720 Td\n' +
    lines.map((l, i) => `${i ? '0 -16 Td\n' : ''}(${l.replace(/([()\\])/g, '\\$1')}) Tj\n`).join('') +
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

/** A rate confirmation with stops. `number` keeps two of them from being byte-identical. */
const rateCon = (number = '84213') =>
  pdf([
    'PRAIRIE LOGISTICS LLC',
    'RATE CONFIRMATION',
    'Broker: Prairie Logistics LLC',
    `Load Number: ${number}`,
    'Equipment: 53 Dry Van',
    'Weight: 42,000 lbs',
    'Total Rate: $2,400.00',
    'PICKUP',
    'Prairie Foods',
    '1200 Industrial Blvd',
    'Wichita, KS 67202',
    'Appt: 09/28/2026 08:00-12:00',
    'DELIVERY',
    'Front Range Grocers',
    '4400 Brighton Blvd',
    'Denver, CO 80216',
    'Appt: 09/30/2026 0800-1200',
  ]);

const REPLY = JSON.stringify({
  broker: { name: 'Prairie Logistics LLC' },
  stops: [
    { type: 'pickup', facility: 'Prairie Foods', address: '1200 Industrial Blvd', city: 'Wichita', state: 'KS', postal: '67202', appointment: '09/28/2026 08:00-12:00' },
    { type: 'delivery', facility: 'Front Range Grocers', address: '4400 Brighton Blvd', city: 'Denver', state: 'CO', postal: '80216', appointment: '09/30/2026 0800-1200' },
  ],
});

const POD = pdf(['PROOF OF DELIVERY', 'Received in good order and condition', 'Consignee signature: ____________________']);

let app: FastifyInstance;
let appWithoutModel: FastifyInstance;
let cappedApp: FastifyInstance;
let fake: FakeLoadReader;
let cappedFake: FakeLoadReader;
let userId: string;
const createdOrgs: string[] = [];
const createdUsers: string[] = [];

const as = (orgId: string, who = userId) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': who });

async function newOrg(name: string, on: FastifyInstance = app): Promise<string> {
  const res = await on.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const id = res.json().org.id as string;
  createdOrgs.push(id);
  return id;
}

async function upload(orgId: string, bytes: Buffer, filename: string, on: FastifyInstance = app) {
  const res = await on.inject({
    method: 'POST',
    url: `/v1/documents?filename=${encodeURIComponent(filename)}`,
    headers: { ...as(orgId), 'content-type': 'application/pdf' },
    payload: bytes,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().document as { id: string };
}

/** Drain the outbox as the runner would. `modelReader` and `perDay` are what the deployment would have configured. */
async function drain(on: FastifyInstance, modelReader: ModelDocumentReader | undefined, perDay: number, orgId?: string) {
  const logged: Array<{ o: Record<string, unknown>; msg: string }> = [];
  const handlers = buildOutboxHandlers({
    mailer: { send: async () => {} } as never,
    webOrigin: 'http://localhost:5173',
    db: on.db,
    storage: on.storage,
    reader: new LocalDocumentReader(),
    modelReader,
    loadProposalsPerDay: perDay,
    log: {
      info: (o, msg) => logged.push({ o: o as Record<string, unknown>, msg }),
      warn: (o, msg) => logged.push({ o: o as Record<string, unknown>, msg }),
    },
  });
  // The outbox is shared, and one drain takes one batch of whoever is oldest, so
  // a backlog from elsewhere can leave this carrier's document for the next round.
  // Keep going until it is done (or clearly not going to be).
  let result = await drainOutbox(on.db, { handlers });
  for (let round = 0; orgId && round < 15; round += 1) {
    if (!(await pendingOutboxTopics(on.db, orgId)).includes('document.received')) break;
    result = await drainOutbox(on.db, { handlers });
  }
  return { result, logged };
}

const proposals = async (orgId: string, status = 'pending', who = userId, on: FastifyInstance = app) => {
  const res = await on.inject({ method: 'GET', url: `/v1/load-proposals?status=${status}`, headers: as(orgId, who) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items as Array<Record<string, any>>;
};

/** What the review form would send for the reviewer who changed nothing. */
const formFor = (over: Record<string, unknown> = {}) => ({
  brokerName: 'Prairie Logistics LLC',
  brokerLoadNumber: '84213',
  equipment: 'DRY_VAN',
  weightLbs: 42_000,
  rate: { amount: 240_000, currency: 'USD' },
  stops: [
    { type: 'pickup', facilityName: 'Prairie Foods', addressLine1: '1200 Industrial Blvd', city: 'Wichita', state: 'KS', postalCode: '67202' },
    { type: 'delivery', facilityName: 'Front Range Grocers', addressLine1: '4400 Brighton Blvd', city: 'Denver', state: 'CO', postalCode: '80216' },
  ],
  ...over,
});

const createFrom = (orgId: string, proposalId: string, body: Record<string, unknown> = formFor(), who = userId) =>
  app.inject({ method: 'POST', url: `/v1/load-proposals/${proposalId}/create`, headers: as(orgId, who), payload: body });

suite('rate confirmation to draft load', () => {
  before(async () => {
    fake = new FakeLoadReader();
    fake.reply = REPLY;
    cappedFake = new FakeLoadReader();
    cappedFake.reply = REPLY;
    const env = (extra: Record<string, string> = {}) => loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url!, ...extra });
    app = await buildServer(env(), { storage: new MemoryObjectStore(), modelReader: fake });
    // `modelReader: undefined` is "not set", which would fall back to Anthropic if a
    // key were in the environment, so the key is removed for this one.
    const { ANTHROPIC_API_KEY: _drop, ...noKey } = process.env;
    appWithoutModel = await buildServer(loadEnv({ ...noKey, NODE_ENV: 'test', DATABASE_URL: url! }), { storage: new MemoryObjectStore() });
    cappedApp = await buildServer(env({ LOAD_PROPOSALS_PER_DAY: '1' }), { storage: new MemoryObjectStore(), modelReader: cappedFake });
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    for (const id of createdUsers) await destroyTestUser(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
    await appWithoutModel.close();
    await cappedApp.close();
  });

  // --- reading ---------------------------------------------------------------------

  it('proposes a load from an unattached rate confirmation, with the text each part came from', async () => {
    const orgId = await newOrg('Proposal Reads Co');
    await upload(orgId, rateCon(), 'ratecon.pdf');
    const before = fake.calls;

    await drain(app, fake, 30, orgId);

    assert.equal(fake.calls, before + 1);
    const [p] = await proposals(orgId);
    assert.equal(p!.status, 'pending');
    assert.equal(p!.load.stops.length, 2);
    assert.equal(p!.load.stops[0].city, 'Wichita');
    assert.equal(p!.load.brokerName, 'Prairie Logistics LLC');
    // The free rules' values win where both have one: 84213 and $2,400.00 came off the labels.
    assert.equal(p!.load.brokerLoadNumber, '84213');
    assert.equal(p!.load.rateAmount, 240_000);
    assert.equal(p!.load.weightLbs, 42_000);
    assert.equal(p!.load.equipment, 'DRY_VAN');
    assert.equal(p!.evidence['stops.1.city'], 'Denver');
    assert.equal(p!.canCreate, true);
    // Denver is in a single-zone state, so its appointment became a window; Wichita's did not.
    assert.equal(p!.load.stops[1].windowStart, '2026-09-30T14:00:00.000Z');
    assert.equal(p!.load.stops[0].windowStart, undefined);
    assert.ok(p!.notes.some((n: string) => /Wichita, KS/.test(n)));
    assert.equal(p!.filename, 'ratecon.pdf');
  });

  it('proposes nothing without a model, with proposing turned off, or for a document that is not a rate confirmation', async () => {
    const orgId = await newOrg('Proposal Restraint Co');
    const before = fake.calls;

    await upload(orgId, rateCon('51001'), 'no-model.pdf');
    await drain(app, undefined, 30, orgId);
    assert.equal((await proposals(orgId)).length, 0, 'no model configured: as before this existed');

    await upload(orgId, rateCon('51005'), 'turned-off.pdf');
    await drain(app, fake, 0, orgId);
    assert.equal((await proposals(orgId)).length, 0, 'a limit of 0 turns it off');
    assert.equal(fake.calls, before, 'and never called the model');

    // A proof of delivery is read and left alone; the next rate confirmation is proposed.
    // (A document the pipeline has already read is not proposed on redelivery: that is
    // what the on-demand route is for, tested below.)
    await upload(orgId, POD, 'pod.pdf');
    await upload(orgId, rateCon('51006'), 'proposed.pdf');
    await drain(app, fake, 30, orgId);
    const found = await proposals(orgId);
    assert.equal(found.length, 1, 'only the rate confirmation, not the proof of delivery');
    assert.equal(found[0]!.filename, 'proposed.pdf');
    assert.equal(fake.calls, before + 1);
  });

  it('does not read the same document twice when the outbox redelivers', async () => {
    const orgId = await newOrg('Proposal Redelivery Co');
    await upload(orgId, rateCon('51002'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const before = fake.calls;

    await requeueOutboxForTest(app.db, { orgId, topic: 'document.received' });
    await drain(app, fake, 30, orgId);

    assert.equal(fake.calls, before, 'no second model call');
    assert.equal((await proposals(orgId)).length, 1, 'and no second proposal');
  });

  it('does not fail the delivery when the model is down, and leaves the document in the inbox', async () => {
    const orgId = await newOrg('Proposal Model Down Co');
    const doc = await upload(orgId, rateCon('51003'), 'ratecon.pdf');
    fake.failWith = new ModelReaderError('Anthropic returned 503', 503);
    try {
      const { result, logged } = await drain(app, fake, 30, orgId);
      assert.equal(result.failed ?? 0, 0, JSON.stringify(result));
      assert.ok(logged.some((l) => /could not read a rate confirmation as a load/.test(l.msg)));
    } finally {
      fake.failWith = undefined;
    }

    assert.equal((await proposals(orgId)).length, 0);
    const res = await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(orgId) });
    assert.equal(res.json().document.kind, 'rate_confirmation', 'the document itself was read and is safe');
  });

  it('keeps an empty reading as "could not read this one", and asking again replaces it', async () => {
    const orgId = await newOrg('Proposal Unreadable Co');
    const doc = await upload(orgId, rateCon('51004'), 'ratecon.pdf');
    fake.reply = null;
    try {
      await drain(app, fake, 30, orgId);
    } finally {
      fake.reply = REPLY;
    }
    const [empty] = await proposals(orgId, 'unreadable');
    assert.ok(empty);
    assert.equal(empty!.canCreate, false);
    assert.equal((await proposals(orgId, 'pending')).length, 0);

    const again = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/propose-load`, headers: as(orgId) });
    assert.equal(again.statusCode, 201, again.body);
    assert.equal(again.json().status, 'pending');
    assert.equal((await proposals(orgId, 'unreadable')).length, 0, 'replaced, not duplicated');
  });

  it('stops a carrier at its daily allowance, automatically and on demand', async () => {
    const orgId = await newOrg('Proposal Cap Co', cappedApp);
    await upload(orgId, rateCon('52001'), 'one.pdf', cappedApp);
    const second = await upload(orgId, rateCon('52002'), 'two.pdf', cappedApp);

    await drain(cappedApp, cappedFake, 1, orgId);

    assert.equal(cappedFake.calls, 1, 'the second was not sent to the model');
    assert.equal((await proposals(orgId, 'pending', userId, cappedApp)).length, 1);
    const onDemand = await cappedApp.inject({ method: 'POST', url: `/v1/documents/${second.id}/propose-load`, headers: as(orgId) });
    assert.equal(onDemand.statusCode, 429);
    assert.equal(onDemand.json().code, 'daily_limit_reached');
    assert.equal(cappedFake.calls, 1);
  });

  // --- on demand ----------------------------------------------------------------------

  it('reads one on demand, is idempotent, and refuses what it should', async () => {
    const orgId = await newOrg('Proposal On Demand Co');
    const doc = await upload(orgId, rateCon('53001'), 'ratecon.pdf');
    const pod = await upload(orgId, POD, 'pod.pdf');
    await drain(app, undefined, 30, orgId); // read and classified, but no proposal yet

    const first = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/propose-load`, headers: as(orgId) });
    const second = await app.inject({ method: 'POST', url: `/v1/documents/${doc.id}/propose-load`, headers: as(orgId) });
    const notRateCon = await app.inject({ method: 'POST', url: `/v1/documents/${pod.id}/propose-load`, headers: as(orgId) });
    const missing = await app.inject({ method: 'POST', url: `/v1/documents/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/propose-load`, headers: as(orgId) });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200, 'already there: returned, not read again');
    assert.equal(second.json().id, first.json().id);
    assert.equal(notRateCon.statusCode, 409);
    assert.equal(notRateCon.json().code, 'not_a_rate_confirmation');
    assert.equal(missing.statusCode, 404);
  });

  it('says so when no model is set up on this deployment', async () => {
    const orgId = await newOrg('Proposal No Model Co', appWithoutModel);
    const doc = await upload(orgId, rateCon('53002'), 'ratecon.pdf', appWithoutModel);
    await drain(appWithoutModel, undefined, 30, orgId);

    const res = await appWithoutModel.inject({ method: 'POST', url: `/v1/documents/${doc.id}/propose-load`, headers: as(orgId) });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'not_configured');
  });

  // --- creating -------------------------------------------------------------------------

  it('makes the load from a proposal: broker email, booked, the rate confirmation attached', async () => {
    const orgId = await newOrg('Proposal Create Co');
    const doc = await upload(orgId, rateCon('54001'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const res = await createFrom(orgId, p!.id, formFor({ brokerLoadNumber: '54001' }));

    assert.equal(res.statusCode, 201, res.body);
    const { load, proposal } = res.json();
    assert.equal(proposal.status, 'created');
    assert.equal(proposal.createdLoadId, load.id);

    const made = (await app.inject({ method: 'GET', url: `/v1/loads/${load.id}`, headers: as(orgId) })).json();
    assert.equal(made.source, 'broker_email');
    assert.equal(made.status, 'booked');
    assert.equal(made.brokerName, 'Prairie Logistics LLC');
    assert.equal(made.stops.length, 2);
    assert.equal(made.rateAmount, 240_000);

    const attached = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(orgId) })).json().document;
    assert.equal(attached.loadId, load.id, 'the rate confirmation hangs on its load');
    assert.ok(attached.validatedAt, 'and was checked against it');
    assert.equal((await proposals(orgId)).length, 0, 'it is no longer waiting');
  });

  it('is the person, not the reader, who decides: source and status are held, and a bad load is refused without losing the proposal', async () => {
    const orgId = await newOrg('Proposal Validation Co');
    await upload(orgId, rateCon('54002'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const noDelivery = await createFrom(orgId, p!.id, formFor({ stops: [formFor().stops[0]] }));
    assert.equal(noDelivery.statusCode, 400);
    assert.equal(noDelivery.json().code, 'invalid_load');
    assert.equal((await proposals(orgId)).length, 1, 'still there for another try');

    // A request that says "manual" and "delivered" is held to broker_email.
    const forced = await createFrom(orgId, p!.id, formFor({ brokerLoadNumber: '54002', source: 'manual' }));
    assert.equal(forced.statusCode, 201, forced.body);
    const made = (await app.inject({ method: 'GET', url: `/v1/loads/${forced.json().load.id}`, headers: as(orgId) })).json();
    assert.equal(made.source, 'broker_email');
  });

  it('makes one load however many people click, and answers the others plainly', async () => {
    const orgId = await newOrg('Proposal Race Co');
    await upload(orgId, rateCon('54003'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const results = await Promise.all([1, 2, 3].map(() => createFrom(orgId, p!.id, formFor({ brokerLoadNumber: '54003' }))));

    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [201, 409, 409]);
    const list = (await app.inject({ method: 'GET', url: '/v1/loads', headers: as(orgId) })).json();
    assert.equal(list.items.length, 1, 'exactly one load');
    assert.ok(results.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'already_handled'));
  });

  it('will not make a second load with a broker load number that already has one, unless told to', async () => {
    const orgId = await newOrg('Proposal Duplicate Co');
    const existing = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: formFor({ brokerLoadNumber: '54004', source: 'manual', status: 'booked' }),
    });
    assert.equal(existing.statusCode, 201, existing.body);
    await upload(orgId, rateCon('54004'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    assert.equal(p!.matchedLoad.reference, existing.json().reference, 'offered as the existing load’s paperwork');
    assert.ok(p!.notes.some((n: string) => /already has this broker load number/.test(n)));

    const refused = await createFrom(orgId, p!.id, formFor({ brokerLoadNumber: '54004' }));
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, 'duplicate_load_number');
    assert.equal((await proposals(orgId)).length, 1, 'refusing costs nothing');

    const confirmed = await createFrom(orgId, p!.id, formFor({ brokerLoadNumber: '54004', confirmDuplicate: true }));
    assert.equal(confirmed.statusCode, 201, confirmed.body);
  });

  it('attaches to the existing load instead, and checks the rate against it', async () => {
    const orgId = await newOrg('Proposal Attach Co');
    const existing = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: formFor({ brokerLoadNumber: '54005', source: 'manual', status: 'booked' }),
    });
    const doc = await upload(orgId, rateCon('54005'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/load-proposals/${p!.id}/attach`,
      headers: as(orgId),
      payload: { loadId: existing.json().id },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().load.reference, existing.json().reference);
    assert.equal(res.json().validation.outcome, 'validated', 'the rate on the page matches the load');
    const attached = (await app.inject({ method: 'GET', url: `/v1/documents/${doc.id}`, headers: as(orgId) })).json().document;
    assert.equal(attached.loadId, existing.json().id);
    assert.equal((await proposals(orgId, 'attached')).length, 1);
    const again = await app.inject({ method: 'POST', url: `/v1/load-proposals/${p!.id}/attach`, headers: as(orgId), payload: { loadId: existing.json().id } });
    assert.equal(again.statusCode, 409, 'not twice');
  });

  it('dismisses one that is not a load to create, and it cannot then be created', async () => {
    const orgId = await newOrg('Proposal Dismiss Co');
    await upload(orgId, rateCon('54006'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const dismissed = await app.inject({ method: 'POST', url: `/v1/load-proposals/${p!.id}/dismiss`, headers: as(orgId) });
    const create = await createFrom(orgId, p!.id);

    assert.equal(dismissed.statusCode, 200);
    assert.equal(create.statusCode, 409);
    assert.equal((await proposals(orgId, 'dismissed')).length, 1);
    assert.equal((await proposals(orgId)).length, 0);
  });

  it('reads one proposal by id in any state, and never another carrier’s', async () => {
    const orgId = await newOrg('Proposal Get One Co');
    const other = await newOrg('Proposal Get One Other Co');
    await upload(orgId, rateCon('56001'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const pending = await app.inject({ method: 'GET', url: `/v1/load-proposals/${p!.id}`, headers: as(orgId) });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().status, 'pending');
    assert.equal(pending.json().filename, 'ratecon.pdf');

    await app.inject({ method: 'POST', url: `/v1/load-proposals/${p!.id}/dismiss`, headers: as(orgId) });
    const dismissed = await app.inject({ method: 'GET', url: `/v1/load-proposals/${p!.id}`, headers: as(orgId) });
    assert.equal(dismissed.statusCode, 200, 'still readable once handled, so a link from an email can say what happened');
    assert.equal(dismissed.json().status, 'dismissed');

    assert.equal((await app.inject({ method: 'GET', url: `/v1/load-proposals/${p!.id}`, headers: as(other) })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/v1/load-proposals/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, headers: as(orgId) })).statusCode, 404);
  });

  // --- who -------------------------------------------------------------------------------

  it('is for owners and dispatchers, and one carrier never sees another’s', async () => {
    const orgId = await newOrg('Proposal Roles Co');
    const other = await newOrg('Proposal Roles Other Co');
    await upload(orgId, rateCon('55001'), 'ratecon.pdf');
    await drain(app, fake, 30, orgId);
    const [p] = await proposals(orgId);

    const dispatcher = await createTestUser(app.db);
    const accountant = await createTestUser(app.db);
    const driver = await createTestUser(app.db);
    createdUsers.push(dispatcher.id, accountant.id, driver.id);
    await addTestMembership(app.db, { orgId, userId: dispatcher.id, role: 'dispatcher' });
    await addTestMembership(app.db, { orgId, userId: accountant.id, role: 'accountant' });
    await addTestMembership(app.db, { orgId, userId: driver.id, role: 'driver' });

    for (const who of [accountant.id, driver.id]) {
      const list = await app.inject({ method: 'GET', url: '/v1/load-proposals', headers: as(orgId, who) });
      const create = await createFrom(orgId, p!.id, formFor(), who);
      assert.equal(list.statusCode, 403);
      assert.equal(create.statusCode, 403);
    }
    assert.equal((await proposals(orgId, 'pending', dispatcher.id)).length, 1, 'a dispatcher can look');
    assert.equal((await proposals(other)).length, 0, 'another carrier sees none of it');
    assert.equal((await createFrom(other, p!.id)).statusCode, 404, 'and cannot act on it');
    const dismissOther = await app.inject({ method: 'POST', url: `/v1/load-proposals/${p!.id}/dismiss`, headers: as(other) });
    assert.equal(dismissOther.statusCode, 404);
  });
});
