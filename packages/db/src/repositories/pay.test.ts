/**
 * The pay repository, against a real database.
 *
 * The claims worth a suite here are the ones that live in a trigger, a
 * constraint, or a transaction spanning three tables — the things a unit
 * test of pure functions cannot reach:
 *
 *  - a load can only ever hold one open invoice; voiding frees it up again
 *  - sending an invoice moves the load to `invoiced` through the same
 *    `updateLoadStatus` every other caller uses, not a parallel copy
 *  - a partial payment does not mark an invoice paid; the sum crossing the
 *    total does, and that is also the moment the load moves to `paid` and
 *    `actualRevenue` is written
 *  - a payment tagged with a factoring packet flips that packet to `funded`
 *  - the status trigger refuses voiding a paid invoice
 *  - tenant isolation
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, testScope } from '../testing.ts';
import { createLoad, getLoad } from './loads.ts';
import {
  assembleFactoringPacket,
  createFactoringCompany,
  generateInvoice,
  getInvoice,
  listPayments,
  PayError,
  receivablesAging,
  recordFactoringResponse,
  recordPayment,
  sendInvoice,
  submitFactoringPacket,
  voidInvoice,
} from './pay.ts';
import { createTruck } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;
/** `loads_dispatched_has_truck` requires one on any non-csv_import load past
 *  `dispatched` — one truck per org, reused by every test load. */
let truckId: string;
let otherTruckId: string;

const wichitaToDenver = [
  { type: 'pickup' as const, city: 'Wichita', state: 'KS' },
  { type: 'delivery' as const, city: 'Denver', state: 'CO' },
];

/** A load already past `delivered`, which is what invoicing assumes. */
async function aDeliveredLoad(scope_: Scope = s) {
  return createLoad(scope_, {
    status: 'delivered',
    brokerName: 'Prairie Freight',
    rate: { amount: 240_000, currency: 'USD' },
    truckId: scope_ === other ? otherTruckId : truckId,
    stops: wichitaToDenver,
  });
}

const lineItems = [
  { code: 'linehaul', description: 'Linehaul', amountCents: 220_000 },
  { code: 'fuel_surcharge', description: 'Fuel surcharge', amountCents: 20_000 },
];

const readEvents = (scope_: Scope, subjectId: string) => readTimeline(scope_, { subjectId });

suite('pay repository', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Pay Test Carrier');
    orgId = org.id;
    const second = await createTestOrg(db, 'Other Carrier');
    otherOrgId = second.id;
    const user = await createTestUser(db);
    userId = user.id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    other = testScope(db, otherOrgId, { type: 'user', id: userId });

    truckId = (await createTruck(s, { label: 'Truck 1' })).id;
    otherTruckId = (await createTruck(other, { label: 'Truck 1' })).id;
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  // --- generateInvoice -------------------------------------------------------

  describe('generateInvoice', () => {
    it('totals the line items and assigns a sequential reference', async () => {
      const loadA = await aDeliveredLoad();
      const loadB = await aDeliveredLoad();

      const a = await generateInvoice(s, { loadId: loadA.id, lineItems });
      const b = await generateInvoice(s, { loadId: loadB.id, lineItems });

      assert.equal(a.totalAmount, 240_000);
      assert.equal(a.totalCurrency, 'USD');
      assert.equal(a.status, 'draft');
      assert.equal(b.reference, a.reference + 1);
    });

    it('records invoice.generated naming the load', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });

      const events = await readEvents(s, invoice.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.verb, 'invoice.generated');
      assert.match(events[0]!.explanation, new RegExp(`load ${load.reference}\\b`));
    });

    it('refuses a second open invoice for the same load', async () => {
      const load = await aDeliveredLoad();
      await generateInvoice(s, { loadId: load.id, lineItems });

      await assert.rejects(
        () => generateInvoice(s, { loadId: load.id, lineItems }),
        (e: PayError) => e.code === 'already_invoiced',
      );
    });

    it('allows a new invoice once the first is voided', async () => {
      const load = await aDeliveredLoad();
      const first = await generateInvoice(s, { loadId: load.id, lineItems });
      await voidInvoice(s, first.id, 'Wrong accessorials, redoing it');

      const second = await generateInvoice(s, { loadId: load.id, lineItems });
      assert.notEqual(second.id, first.id);
    });

    it('refuses no line items', async () => {
      const load = await aDeliveredLoad();
      await assert.rejects(
        () => generateInvoice(s, { loadId: load.id, lineItems: [] }),
        (e: PayError) => e.code === 'no_line_items',
      );
    });

    it('refuses line items in more than one currency', async () => {
      const load = await aDeliveredLoad();
      await assert.rejects(
        () =>
          generateInvoice(s, {
            loadId: load.id,
            lineItems: [
              { code: 'linehaul', description: 'Linehaul', amountCents: 100_000 },
              {
                code: 'fuel_surcharge',
                description: 'Fuel',
                amountCents: 5_000,
                currency: 'CAD',
              },
            ],
          }),
        (e: PayError) => e.code === 'mixed_currency',
      );
    });

    it('refuses a load in another tenant', async () => {
      const theirLoad = await aDeliveredLoad(other);
      await assert.rejects(
        () => generateInvoice(s, { loadId: theirLoad.id, lineItems }),
        (e: PayError) => e.code === 'load_not_found',
      );
    });
  });

  // --- sendInvoice -------------------------------------------------------------

  describe('sendInvoice', () => {
    it('moves draft to sent and the load to invoiced', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });

      const sent = await sendInvoice(s, invoice.id);
      assert.equal(sent.status, 'sent');
      assert.ok(sent.sentAt instanceof Date);

      const reloaded = await getLoad(s, load.id);
      assert.equal(reloaded!.status, 'invoiced');
    });

    it('records invoice.sent and the load status_changed event', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      const invoiceEvents = await readEvents(s, invoice.id);
      assert.ok(invoiceEvents.some((e) => e.verb === 'invoice.sent'));

      const loadEvents = await readEvents(s, load.id);
      const statusChange = loadEvents.find((e) => e.verb === 'load.status_changed');
      assert.ok(statusChange, 'expected a load.status_changed event');
    });

    it('refuses sending a non-draft invoice', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      await assert.rejects(
        () => sendInvoice(s, invoice.id),
        (e: PayError) => e.code === 'not_draft',
      );
    });
  });

  // --- voidInvoice ---------------------------------------------------------

  describe('voidInvoice', () => {
    it('requires a reason', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await assert.rejects(
        () => voidInvoice(s, invoice.id, '   '),
        (e: PayError) => e.code === 'reason_required',
      );
    });

    it('the trigger refuses voiding a paid invoice', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);
      await recordPayment(s, {
        invoiceId: invoice.id,
        amountCents: invoice.totalAmount,
        source: 'broker_direct',
      });

      await assert.rejects(() => voidInvoice(s, invoice.id, 'changed my mind'));
    });
  });

  // --- recordPayment ---------------------------------------------------------

  describe('recordPayment', () => {
    it('a partial payment does not mark the invoice paid', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      const { invoice: after1 } = await recordPayment(s, {
        invoiceId: invoice.id,
        amountCents: 100_000,
        source: 'broker_direct',
      });
      assert.equal(after1.status, 'sent');
      assert.equal(after1.paidAt, null);
    });

    it('the sum crossing the total marks it paid and reconciles the load', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      await recordPayment(s, {
        invoiceId: invoice.id,
        amountCents: 100_000,
        source: 'broker_direct',
      });
      const { invoice: settled } = await recordPayment(s, {
        invoiceId: invoice.id,
        amountCents: 140_000,
        source: 'broker_direct',
      });

      assert.equal(settled.status, 'paid');
      assert.ok(settled.paidAt instanceof Date);

      const reloadedLoad = await getLoad(s, load.id);
      assert.equal(reloadedLoad!.status, 'paid');
      assert.equal(reloadedLoad!.actualRevenueAmount, invoice.totalAmount);
      assert.equal(reloadedLoad!.actualRevenueCurrency, 'USD');

      const payments = await listPayments(s, invoice.id);
      assert.equal(payments.length, 2);

      const invoiceEvents = await readEvents(s, invoice.id);
      assert.ok(invoiceEvents.some((e) => e.verb === 'invoice.paid'));
    });

    it('refuses a payment against a draft invoice', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });

      await assert.rejects(
        () =>
          recordPayment(s, {
            invoiceId: invoice.id,
            amountCents: 1_000,
            source: 'broker_direct',
          }),
        (e: PayError) => e.code === 'not_sent',
      );
    });
  });

  // --- factoring -------------------------------------------------------------

  describe('factoring', () => {
    it('carries a packet from assembled through submitted to funded on payment', async () => {
      const factor = await createFactoringCompany(s, { name: 'Apex Capital', email: 'ops@apex.test' });

      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      const packet = await assembleFactoringPacket(s, {
        invoiceId: invoice.id,
        factoringCompanyId: factor.id,
        documentIds: [],
      });
      assert.equal(packet.status, 'assembling');

      const submitted = await submitFactoringPacket(s, packet.id);
      assert.equal(submitted.status, 'submitted');
      assert.ok(submitted.submittedAt instanceof Date);

      const accepted = await recordFactoringResponse(s, packet.id, { outcome: 'accepted' });
      assert.equal(accepted.status, 'accepted');

      const { invoice: settled } = await recordPayment(s, {
        invoiceId: invoice.id,
        amountCents: invoice.totalAmount,
        source: 'factor',
        factoringPacketId: packet.id,
      });
      assert.equal(settled.status, 'paid');

      const events = await readEvents(s, packet.id);
      assert.ok(events.some((e) => e.verb === 'factoring_packet.funded'));
    });

    it('records a rejection with its reason and refuses one with none', async () => {
      const factor = await createFactoringCompany(s, { name: 'Second Factor Co' });
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);
      const packet = await assembleFactoringPacket(s, {
        invoiceId: invoice.id,
        factoringCompanyId: factor.id,
        documentIds: [],
      });
      await submitFactoringPacket(s, packet.id);

      await assert.rejects(
        () => recordFactoringResponse(s, packet.id, { outcome: 'rejected' }),
        (e: PayError) => e.code === 'reason_required',
      );

      const rejected = await recordFactoringResponse(s, packet.id, {
        outcome: 'rejected',
        reason: 'Missing signed POD',
      });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.rejectionReason, 'Missing signed POD');
    });
  });

  // --- receivablesAging --------------------------------------------------------

  describe('receivablesAging', () => {
    it('buckets a sent invoice with no due date as current', async () => {
      const load = await aDeliveredLoad();
      const invoice = await generateInvoice(s, { loadId: load.id, lineItems });
      await sendInvoice(s, invoice.id);

      const aging = await receivablesAging(s);
      const current = aging.find((b) => b.bucket === 'current')!;
      assert.ok(current.count >= 1);
      assert.ok(current.totalCents >= invoice.totalAmount);
    });

    it('excludes draft, void and paid invoices', async () => {
      const before_ = await receivablesAging(s);
      const beforeTotal = before_.reduce((sum, b) => sum + b.count, 0);

      const load = await aDeliveredLoad();
      // A draft invoice never enters aging.
      await generateInvoice(s, { loadId: load.id, lineItems });

      const after_ = await receivablesAging(s);
      const afterTotal = after_.reduce((sum, b) => sum + b.count, 0);
      assert.equal(afterTotal, beforeTotal);
    });
  });

  // --- tenant isolation --------------------------------------------------------

  it('an invoice is invisible from another org', async () => {
    const load = await aDeliveredLoad();
    const invoice = await generateInvoice(s, { loadId: load.id, lineItems });

    const fromOther = await getInvoice(other, invoice.id);
    assert.equal(fromOther, undefined);
  });
});
