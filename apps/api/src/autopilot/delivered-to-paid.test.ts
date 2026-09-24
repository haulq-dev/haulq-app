/**
 * The delivered-to-paid loop, end to end.
 *
 * `FEATURE_REQUESTS_PLAN.md` section 8, piece 3. What is worth a server for
 * here is the loop's *restraint*, not its happy path:
 *
 *  - a carrier that never opted in is never visited
 *  - it reminds only about what is genuinely owed and safe to chase: not
 *    inside the grace window, not past the collections window, not an
 *    invoice a factor holds, not a paid balance, not a broker with no email
 *  - one broker gets one email listing everything, once a week
 *  - it drafts an invoice only where the amount is unambiguous, creates a
 *    real one only when a person will approve the email, and can never be
 *    made fully automatic
 *  - shadow drafts are promoted — not blocked — once a carrier turns an
 *    action on
 *  - one carrier's data never reaches another's messages
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  addTestDocument,
  addTestFactoringPacket,
  backdateTestOutbound,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  markMailboxConnected,
  MemoryObjectStore,
  requestMailboxConnection,
  scope,
  sha256,
  setTestBrokerContact,
  setTestLoadAccessorials,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../env.ts';
import type { SendEmailInput, UnipileClient } from '../integrations/unipile.ts';
import { buildServer } from '../server.ts';
import { runDeliveredToPaidPass } from './delivered-to-paid.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const DAY = 86_400_000;

class FakeUnipileClient implements UnipileClient {
  sent: SendEmailInput[] = [];
  async sendEmail(input: SendEmailInput): Promise<{ providerMessageId: string | null }> {
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

const as = (orgId: string) => ({ 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId });

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

async function connectMailbox(orgId: string): Promise<void> {
  const s = scope(app.db, { orgId, actor: { type: 'system', name: 'test' }, correlationId: randomUUID() });
  await requestMailboxConnection(s);
  await markMailboxConnected(app.db, { orgId, unipileAccountId: `acct-${randomUUID()}` });
}

const putSettings = (orgId: string, body: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/v1/outbound/settings', headers: as(orgId), payload: body });

const trucks = new Map<string, string>();

/** A delivered load has to name its truck, so every org gets one, once. */
async function truckFor(orgId: string): Promise<string> {
  const known = trucks.get(orgId);
  if (known) return known;
  const res = await app.inject({ method: 'POST', url: '/v1/trucks', headers: as(orgId), payload: { label: 'Truck 1' } });
  const id = res.json().id as string;
  trucks.set(orgId, id);
  return id;
}

const storedKeys: string[] = [];

/** A document whose bytes are really in storage, with a matching checksum. */
async function storedDoc(orgId: string, loadId: string, kind: string, bytes?: Buffer): Promise<Buffer> {
  const body = bytes ?? Buffer.from('%PDF-1.7 ' + kind + ' ' + randomUUID());
  const key = 'test/' + randomUUID();
  storedKeys.push(key);
  await app.storage.put(key, body, 'application/pdf');
  await addTestDocument(app.db, { orgId, loadId, kind, storageKey: key, sha256: sha256(body), filename: kind + '.pdf', byteSize: body.byteLength });
  return body;
}

interface LoadOpts {
  broker?: string;
  email?: string | null;
  rate?: number;
  pod?: boolean;
  accessorials?: number;
  /** Put real bytes in storage for the POD and rate confirmation, so an email can actually attach them. */
  storedDocs?: boolean;
}

/** A delivered load with a broker that has an email — the loop's raw material. */
async function aDeliveredLoad(orgId: string, opts: LoadOpts = {}) {
  const truckId = await truckFor(orgId);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: as(orgId),
    payload: {
      status: 'delivered',
      truckId,
      brokerName: opts.broker ?? `Broker ${randomUUID().slice(0, 6)}`,
      rate: { amount: opts.rate ?? 240_000, currency: 'USD' },
      stops: [
        { type: 'pickup', city: 'Wichita', state: 'KS' },
        { type: 'delivery', city: 'Denver', state: 'CO' },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const load = res.json() as { id: string; reference: number; brokerId: string };
  if (opts.email !== null) {
    await setTestBrokerContact(app.db, load.brokerId, {
      email: opts.email ?? `ap-${randomUUID().slice(0, 6)}@broker.example.com`,
      paymentTermsDays: 30,
    });
  }
  const bytes: Record<string, Buffer> = {};
  if (opts.pod !== false) {
    if (opts.storedDocs) bytes['pod'] = await storedDoc(orgId, load.id, 'pod');
    else await addTestDocument(app.db, { orgId, loadId: load.id, kind: 'pod' });
  }
  if (opts.storedDocs) bytes['rate_confirmation'] = await storedDoc(orgId, load.id, 'rate_confirmation');
  if (opts.accessorials) await setTestLoadAccessorials(app.db, load.id, opts.accessorials);
  return { ...load, bytes };
}

/** A sent invoice, `daysOverdue` past its due date. */
async function anOverdueInvoice(orgId: string, load: { id: string }, daysOverdue: number, total = 240_000) {
  const gen = await app.inject({
    method: 'POST',
    url: '/v1/invoices',
    headers: as(orgId),
    payload: {
      loadId: load.id,
      lineItems: [{ code: 'linehaul', description: 'Linehaul', amountCents: total }],
      dueAt: new Date(Date.now() - daysOverdue * DAY).toISOString(),
    },
  });
  assert.equal(gen.statusCode, 201);
  const invoice = gen.json() as { id: string; reference: number };
  const sent = await app.inject({ method: 'POST', url: `/v1/invoices/${invoice.id}/send`, headers: as(orgId) });
  assert.equal(sent.statusCode, 200);
  return invoice;
}

const pass = (over: Partial<Parameters<typeof runDeliveredToPaidPass>[0]> = {}) =>
  runDeliveredToPaidPass({
    db: app.db,
    deps: { unipile, storage: app.storage },
    log: { info() {}, warn() {}, error() {} },
    invoiceGraceHours: 0,
    ...over,
  });

async function messages(orgId: string) {
  const res = await app.inject({ method: 'GET', url: '/v1/outbound/messages', headers: as(orgId) });
  return res.json().messages as Array<{
    id: string;
    actionType: string;
    status: string;
    holdReason: string | null;
    toAddresses: string[];
    subject: string;
    body: string;
  }>;
}

suite('delivered-to-paid loop', () => {
  before(async () => {
    unipile = new FakeUnipileClient();
    app = await buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), {
      unipileClient: unipile,
      storage: new MemoryObjectStore(),
    });
    userId = (await createTestUser(app.db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(app.db, id);
    await destroyTestUser(app.db, userId);
    await app.close();
  });

  // --- opt-in ------------------------------------------------------------------

  it('never visits a carrier that has not explicitly set an action', async () => {
    const orgId = await newOrg('Autopilot Never Opted In Co');
    const load = await aDeliveredLoad(orgId);
    await anOverdueInvoice(orgId, load, 10);

    await pass();

    assert.equal((await messages(orgId)).length, 0);
  });

  // --- payment reminders -----------------------------------------------------------

  it('drafts a reminder in shadow for an overdue invoice, and sends nothing', async () => {
    const orgId = await newOrg('Autopilot Reminder Shadow Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@prairie.example.com' });
    const invoice = await anOverdueInvoice(orgId, load, 10, 240_000);
    unipile.sent = [];

    await pass();

    const [m] = await messages(orgId);
    assert.equal(m!.actionType, 'payment_reminder');
    assert.equal(m!.status, 'shadow');
    assert.deepEqual(m!.toAddresses, ['ap@prairie.example.com']);
    assert.match(m!.body, new RegExp(`Invoice ${invoice.reference}`));
    assert.match(m!.body, /\$2,400\.00 outstanding/);
    assert.match(m!.body, /10 days overdue/);
    assert.equal(unipile.sent.length, 0);
  });

  it('leaves alone an invoice not yet late enough, and one so old it needs a person', async () => {
    const orgId = await newOrg('Autopilot Window Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const fresh = await aDeliveredLoad(orgId);
    const ancient = await aDeliveredLoad(orgId);
    await anOverdueInvoice(orgId, fresh, 1);
    await anOverdueInvoice(orgId, ancient, 90);

    await pass();

    assert.equal((await messages(orgId)).length, 0);
  });

  it('reminds only on what is still owed, net of payments already received', async () => {
    const orgId = await newOrg('Autopilot Partial Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId);
    const invoice = await anOverdueInvoice(orgId, load, 10, 240_000);
    const paid = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/payments`,
      headers: as(orgId),
      payload: { amount: { amount: 100_000, currency: 'USD' }, source: 'broker_direct' },
    });
    assert.equal(paid.statusCode, 201);

    await pass();

    const [m] = await messages(orgId);
    assert.match(m!.body, /\$1,400\.00 outstanding/);
    assert.doesNotMatch(m!.body, /\$2,400\.00/);
  });

  it('never chases an invoice a factor holds — that broker owes the factor', async () => {
    const orgId = await newOrg('Autopilot Factored Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId);
    const invoice = await anOverdueInvoice(orgId, load, 10);
    await addTestFactoringPacket(app.db, { orgId, invoiceId: invoice.id, status: 'submitted' });

    await pass();

    assert.equal((await messages(orgId)).length, 0);
  });

  it('skips a broker with no email, and one whose stored email is not an address, without failing the pass', async () => {
    const orgId = await newOrg('Autopilot No Email Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const noEmail = await aDeliveredLoad(orgId, { email: null });
    const badEmail = await aDeliveredLoad(orgId, { email: 'not an address' });
    const good = await aDeliveredLoad(orgId, { email: 'ap@good.example.com' });
    await anOverdueInvoice(orgId, noEmail, 10);
    await anOverdueInvoice(orgId, badEmail, 10);
    await anOverdueInvoice(orgId, good, 10);

    const summary = await pass();

    const list = await messages(orgId);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0]!.toAddresses, ['ap@good.example.com']);
    assert.ok((summary.skipped['invalid_message'] ?? 0) >= 1, 'the malformed address is counted, not thrown');
  });

  it('sends one email per broker listing everything overdue, not one per invoice', async () => {
    const orgId = await newOrg('Autopilot Grouping Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const first = await aDeliveredLoad(orgId, { broker: 'Same Broker LLC', email: 'ap@same.example.com' });
    const secondRes = await app.inject({
      method: 'POST',
      url: '/v1/loads',
      headers: as(orgId),
      payload: {
        status: 'delivered',
        truckId: await truckFor(orgId),
        brokerName: 'Same Broker LLC',
        rate: { amount: 100_000, currency: 'USD' },
        stops: [
          { type: 'pickup', city: 'Topeka', state: 'KS' },
          { type: 'delivery', city: 'Omaha', state: 'NE' },
        ],
      },
    });
    const second = secondRes.json() as { id: string };
    await anOverdueInvoice(orgId, first, 10, 240_000);
    await anOverdueInvoice(orgId, second, 20, 100_000);

    await pass();

    const list = await messages(orgId);
    assert.equal(list.length, 1);
    assert.match(list[0]!.subject, /2 overdue invoices/);
    assert.match(list[0]!.body, /\$2,400\.00/);
    assert.match(list[0]!.body, /\$1,000\.00/);
  });

  it('sends at most one reminder per broker per week, however often the loop runs', async () => {
    const orgId = await newOrg('Autopilot Weekly Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId);
    await anOverdueInvoice(orgId, load, 10);

    await pass();
    const again = await pass();
    await pass();

    assert.equal((await messages(orgId)).length, 1);
    assert.equal(again.recorded, 0);
    assert.ok((again.skipped['already_handled'] ?? 0) >= 1);
  });

  // --- promotion and the kill switch --------------------------------------------------

  it('sends a reminder that was only a shadow draft once the carrier turns it on', async () => {
    const orgId = await newOrg('Autopilot Promotion Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@promote.example.com' });
    await anOverdueInvoice(orgId, load, 10);
    unipile.sent = [];

    await pass();
    const [shadow] = await messages(orgId);
    assert.equal(shadow!.status, 'shadow');
    assert.equal(unipile.sent.length, 0);

    await putSettings(orgId, { sendingEnabled: true, modes: { payment_reminder: 'act' } });
    const summary = await pass();

    const list = await messages(orgId);
    assert.equal(list.length, 1, 'the shadow row is promoted in place, not duplicated');
    assert.equal(list[0]!.id, shadow!.id);
    assert.equal(list[0]!.status, 'sent');
    assert.equal(summary.sent, 1);
    assert.equal(unipile.sent.length, 1);
    assert.deepEqual(unipile.sent[0]!.to, ['ap@promote.example.com']);
  });

  it('holds everything back while sending is off, even for an action set to act', async () => {
    const orgId = await newOrg('Autopilot Killswitch Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { modes: { payment_reminder: 'act' } });
    const load = await aDeliveredLoad(orgId);
    await anOverdueInvoice(orgId, load, 10);
    unipile.sent = [];

    await pass();

    const [m] = await messages(orgId);
    assert.equal(m!.status, 'shadow');
    assert.equal(m!.holdReason, 'sending_disabled');
    assert.equal(unipile.sent.length, 0);
  });

  // --- the invoice draft ---------------------------------------------------------------

  it('drafts the invoice it would send, shows the amount, and creates no invoice', async () => {
    const orgId = await newOrg('Autopilot Invoice Draft Co');
    await putSettings(orgId, { modes: { invoice_delivery: 'shadow' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@bill.example.com', rate: 240_000 });
    unipile.sent = [];

    await pass();

    const [m] = await messages(orgId);
    assert.equal(m!.actionType, 'invoice_delivery');
    assert.equal(m!.status, 'shadow');
    assert.match(m!.subject, /Wichita, KS to Denver, CO/);
    assert.match(m!.body, /Total due: \$2,400\.00/);
    assert.match(m!.body, /net 30 days/);
    assert.equal(unipile.sent.length, 0);

    const invoices = await app.inject({ method: 'GET', url: '/v1/invoices', headers: as(orgId) });
    assert.equal(invoices.json().items?.length ?? invoices.json().length ?? 0, 0, 'drafting must not create an invoice');
    const after = await app.inject({ method: 'GET', url: `/v1/loads/${load.id}`, headers: as(orgId) });
    assert.equal(after.json().status, 'delivered');
  });

  it('can be held for approval, but never made fully automatic', async () => {
    const orgId = await newOrg('Autopilot Invoice Ceiling Co');
    const act = await putSettings(orgId, { modes: { invoice_delivery: 'act' } });
    assert.equal(act.statusCode, 422);
    assert.equal(act.json().code, 'above_ceiling');

    const draft = await putSettings(orgId, { modes: { invoice_delivery: 'draft' } });
    assert.equal(draft.statusCode, 200);
  });

  // --- the invoice, for real, once a person approves ------------------------------------

  /** An org that is connected, sending, and holding invoice emails for approval. */
  async function invoicingOrg(name: string): Promise<string> {
    const orgId = await newOrg(name);
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { invoice_delivery: 'draft' } });
    unipile.sent = [];
    return orgId;
  }

  const invoicesOf = async (orgId: string) =>
    (await app.inject({ method: 'GET', url: '/v1/invoices', headers: as(orgId) })).json().items as Array<{
      id: string;
      status: string;
    }>;

  it('creates the draft invoice and holds the email, with the invoice, rate confirmation and POD attached', async () => {
    const orgId = await invoicingOrg('Autopilot Invoice Attach Co');
    await aDeliveredLoad(orgId, { email: 'ap@bill.example.com', storedDocs: true });

    await pass();

    const [invoice] = await invoicesOf(orgId);
    assert.equal(invoice!.status, 'draft', 'the invoice exists, but nothing has gone to the broker');
    const [m] = await messages(orgId);
    assert.equal(m!.status, 'pending_approval');
    assert.equal(unipile.sent.length, 0);

    const full = (await app.inject({ method: 'GET', url: '/v1/outbound/messages', headers: as(orgId) })).json()
      .messages[0] as { attachments: Array<{ kind: string; filename: string }> };
    assert.deepEqual(full.attachments.map((a) => a.kind).sort(), ['document', 'document', 'invoice']);
  });

  it('on approval sends the real files, then marks the invoice sent and the load invoiced', async () => {
    const orgId = await invoicingOrg('Autopilot Approve Invoice Co');
    const load = await aDeliveredLoad(orgId, { email: 'ap@bill.example.com', storedDocs: true });
    await pass();
    const [m] = await messages(orgId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/outbound/messages/' + m!.id + '/approve',
      headers: as(orgId),
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'sent');
    assert.equal(unipile.sent.length, 1);
    const files = unipile.sent[0]!.attachments!;
    assert.equal(files.length, 3);
    const pdf = files.find((f) => f.filename.startsWith('Invoice-'))!;
    assert.equal(pdf.body.subarray(0, 5).toString('latin1'), '%PDF-', 'a real invoice PDF, rendered at send time');
    assert.ok(files.some((f) => f.body.equals(load.bytes['pod']!)), 'the POD bytes are the stored ones');
    assert.ok(files.some((f) => f.body.equals(load.bytes['rate_confirmation']!)));

    const [invoice] = await invoicesOf(orgId);
    assert.equal(invoice!.status, 'sent');
    const after = await app.inject({ method: 'GET', url: '/v1/loads/' + load.id, headers: as(orgId) });
    assert.equal(after.json().status, 'invoiced');
  });

  it('creates no invoice while the email would only be shadow — sending off, or not configured', async () => {
    const orgId = await newOrg('Autopilot Held Invoice Co');
    await connectMailbox(orgId);
    // Configured for approval, but the kill switch is off: held to shadow.
    await putSettings(orgId, { modes: { invoice_delivery: 'draft' } });
    await aDeliveredLoad(orgId, { storedDocs: true });

    await pass();

    const [m] = await messages(orgId);
    assert.equal(m!.status, 'shadow');
    assert.equal(m!.holdReason, 'sending_disabled');
    assert.equal((await invoicesOf(orgId)).length, 0, 'a held draft must not leave an invoice behind');
  });

  it('promotes the held draft when sending is turned on, creating the invoice then', async () => {
    const orgId = await newOrg('Autopilot Promote Invoice Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { modes: { invoice_delivery: 'draft' } });
    await aDeliveredLoad(orgId, { storedDocs: true });
    await pass();
    const [held] = await messages(orgId);
    assert.equal(held!.status, 'shadow');

    await putSettings(orgId, { sendingEnabled: true });
    await pass();

    const list = await messages(orgId);
    assert.equal(list.length, 1, 'the same row, promoted');
    assert.equal(list[0]!.id, held!.id);
    assert.equal(list[0]!.status, 'pending_approval');
    assert.equal((await invoicesOf(orgId)).length, 1);
  });

  it('does not send, and leaves the invoice a draft, if a stored document no longer matches its checksum', async () => {
    const orgId = await invoicingOrg('Autopilot Tampered Invoice Co');
    await aDeliveredLoad(orgId, { storedDocs: true });
    await pass();
    const [m] = await messages(orgId);
    // Someone overwrites the stored files after the draft was made.
    for (const key of storedKeys) await app.storage.put(key, Buffer.from('%PDF-1.7 tampered'), 'application/pdf');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/outbound/messages/' + m!.id + '/approve',
      headers: as(orgId),
    });

    assert.equal(res.json().status, 'failed');
    assert.match(res.json().error, /checksum/);
    assert.equal(unipile.sent.length, 0);
    const [invoice] = await invoicesOf(orgId);
    assert.equal(invoice!.status, 'draft', 'a failed send must not mark the invoice sent');
  });

  it('refuses to guess an amount: no proof of delivery, or accessorials, means no draft', async () => {
    const orgId = await newOrg('Autopilot Invoice Refusal Co');
    await putSettings(orgId, { modes: { invoice_delivery: 'shadow' } });
    await aDeliveredLoad(orgId, { pod: false });
    const withAccessorials = await aDeliveredLoad(orgId, { accessorials: 15_000 });
    void withAccessorials;

    const summary = await pass();

    assert.equal((await messages(orgId)).length, 0);
    assert.ok((summary.skipped['invoice_no_pod'] ?? 0) >= 1);
    assert.ok((summary.skipped['invoice_has_accessorials'] ?? 0) >= 1);
  });

  it('gives a dispatcher the same afternoon before the system drafts anything', async () => {
    const orgId = await newOrg('Autopilot Grace Co');
    await putSettings(orgId, { modes: { invoice_delivery: 'shadow' } });
    await aDeliveredLoad(orgId);

    await pass({ invoiceGraceHours: 24 });

    assert.equal((await messages(orgId)).length, 0);
  });

  // --- telling the carrier, and not letting drafts go stale ---------------------------

  const timeline = async (orgId: string, verb: string) =>
    ((await app.inject({ method: 'GET', url: '/v1/timeline?limit=200', headers: as(orgId) })).json().items as Array<{
      verb: string;
      explanation: string;
    }>).filter((e) => e.verb === verb);

  it('raises one "awaiting approval" event per pass, however many drafts it made', async () => {
    const orgId = await invoicingOrg('Autopilot Awaiting Once Co');
    await aDeliveredLoad(orgId, { email: 'ap@one.example.com' });
    await aDeliveredLoad(orgId, { email: 'ap@two.example.com' });
    await aDeliveredLoad(orgId, { email: 'ap@three.example.com' });

    const first = await pass();

    assert.equal(first.awaiting, 3);
    const events = await timeline(orgId, 'outbound.awaiting_approval');
    assert.equal(events.length, 1, 'three drafts, one notification');
    assert.match(events[0]!.explanation, /3 messages/);

    // Nothing new, nothing announced: a backlog is not re-announced every pass.
    const second = await pass();
    assert.equal(second.awaiting, 0);
    assert.equal((await timeline(orgId, 'outbound.awaiting_approval')).length, 1);
  });

  it('does not raise the event for a shadow preview, which needs no approval', async () => {
    const orgId = await newOrg('Autopilot No Awaiting For Shadow Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@shadow.example.com' });
    await anOverdueInvoice(orgId, load, 10);

    const summary = await pass();

    assert.equal(summary.recorded, 1);
    assert.equal(summary.awaiting, 0);
    assert.equal((await timeline(orgId, 'outbound.awaiting_approval')).length, 0);
  });

  it('withdraws a reminder nobody approved within a week, and drafts a current one in its place', async () => {
    const orgId = await newOrg('Autopilot Reminder Expiry Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { payment_reminder: 'draft' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@stale.example.com' });
    await anOverdueInvoice(orgId, load, 10);

    await pass();
    const [old] = await messages(orgId);
    assert.equal(old!.status, 'pending_approval');

    const later = await pass({ now: new Date(Date.now() + 8 * DAY) });

    assert.equal(later.expired, 1);
    const all = await messages(orgId);
    assert.equal(all.find((m) => m.id === old!.id)!.status, 'expired');
    assert.equal(all.filter((m) => m.status === 'pending_approval').length, 1, 'a fresh one replaces it');
    assert.equal((await timeline(orgId, 'outbound.expired')).length, 1);
  });

  it('leaves an unapproved invoice email alone however old — an invoice does not go stale', async () => {
    const orgId = await invoicingOrg('Autopilot Invoice No Expiry Co');
    await aDeliveredLoad(orgId, { email: 'ap@keep.example.com' });
    await pass();

    // The pass visits every opted-in carrier in the database, so its totals
    // include other tests' reminders; only this carrier's message is asserted.
    await pass({ now: new Date(Date.now() + 30 * DAY) });

    assert.equal((await messages(orgId))[0]!.status, 'pending_approval');
  });

  it('refuses to approve a reminder past its week, and marks it expired', async () => {
    const orgId = await newOrg('Autopilot Approve Stale Co');
    await connectMailbox(orgId);
    await putSettings(orgId, { sendingEnabled: true, modes: { payment_reminder: 'draft' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@late.example.com' });
    await anOverdueInvoice(orgId, load, 10);
    await pass();
    const [m] = await messages(orgId);
    unipile.sent = [];
    await backdateTestOutbound(app.db, m!.id, 8);

    const res = await app.inject({ method: 'POST', url: '/v1/outbound/messages/' + m!.id + '/approve', headers: as(orgId) });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error?.code ?? res.json().code, 'expired');
    assert.equal(unipile.sent.length, 0, 'nothing went out');
    assert.equal((await messages(orgId))[0]!.status, 'expired');
  });

  it('skips an action the carrier has cleared, and drafts nothing for it', async () => {
    const orgId = await newOrg('Autopilot Cleared Action Co');
    await putSettings(orgId, { modes: { payment_reminder: 'shadow' } });
    const load = await aDeliveredLoad(orgId, { email: 'ap@cleared.example.com' });
    await anOverdueInvoice(orgId, load, 10);
    const del = await app.inject({ method: 'DELETE', url: '/v1/outbound/settings/payment_reminder', headers: as(orgId) });
    assert.equal(del.statusCode, 204);

    await pass();

    assert.equal((await messages(orgId)).length, 0, 'off means the carrier is not visited for it at all');
  });

  // --- tenancy -----------------------------------------------------------------------

  it('keeps two carriers apart', async () => {
    const a = await newOrg('Autopilot Tenant A');
    const b = await newOrg('Autopilot Tenant B');
    await putSettings(a, { modes: { payment_reminder: 'shadow' } });
    await putSettings(b, { modes: { payment_reminder: 'shadow' } });
    const loadA = await aDeliveredLoad(a, { email: 'ap@a.example.com' });
    await anOverdueInvoice(a, loadA, 10);

    await pass();

    assert.equal((await messages(a)).length, 1);
    assert.equal((await messages(b)).length, 0, 'B has nothing overdue, so nothing of A\'s may appear');
  });
});
