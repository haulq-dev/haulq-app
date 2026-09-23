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
 *  - it drafts an invoice only where the amount is unambiguous, never
 *    creates one, and cannot be configured past shadow
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
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  markMailboxConnected,
  requestMailboxConnection,
  scope,
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

interface LoadOpts {
  broker?: string;
  email?: string | null;
  rate?: number;
  pod?: boolean;
  accessorials?: number;
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
  if (opts.pod !== false) await addTestDocument(app.db, { orgId, loadId: load.id, kind: 'pod' });
  if (opts.accessorials) await setTestLoadAccessorials(app.db, load.id, opts.accessorials);
  return load;
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
    deps: { unipile },
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

  it('cannot be configured past shadow, because outbound email cannot carry attachments yet', async () => {
    const orgId = await newOrg('Autopilot Invoice Ceiling Co');
    const res = await putSettings(orgId, { modes: { invoice_delivery: 'act' } });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'above_ceiling');
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
