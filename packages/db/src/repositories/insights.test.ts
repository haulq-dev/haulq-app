/**
 * Insights, against a real database.
 *
 * The module header names two rules every query here has to get right, and
 * those are what this file exists to protect:
 *
 *  - **actual overrides expected**, never the reverse, and a load with only
 *    expected figures still counts — Insights has to work before a carrier
 *    has reconciled anything
 *  - **a load with no deadhead recorded is excluded from per-total-mile
 *    averages, not treated as zero.** Zero is the flattering answer, and it
 *    is what the whole file exists to avoid defaulting to.
 *
 * Alongside those: only delivered-or-later loads count, the window is
 * respected, and a breakdown's `basis` tells actual from expected from mixed.
 *
 * Every test gets its own org. Insights is aggregate arithmetic — sums,
 * counts, ratios — and asserting an exact revenue figure against an org
 * shared with other tests means the number depends on test order, which is
 * exactly the kind of failure that looks nothing like its cause.
 *
 * Skips without DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, setLoadActualsForTest, testScope } from '../testing.ts';
import { createLoad, updateLoadStatus } from './loads.ts';
import {
  actionQueue,
  insightsSummary,
  loadMargin,
  paymentPerformance,
  revenueByBroker,
  revenueByLane,
  revenueByTruck,
} from './insights.ts';
import {
  assembleFactoringPacket,
  createFactoringCompany,
  generateInvoice,
  recordFactoringResponse,
  recordPayment,
  sendInvoice,
  submitFactoringPacket,
} from './pay.ts';
import { createTruck } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let userId: string;
const createdOrgs: string[] = [];

const wichitaToDenver = [
  { type: 'pickup' as const, city: 'Wichita', state: 'KS' },
  { type: 'delivery' as const, city: 'Denver', state: 'CO' },
];

/** A fresh org and scope, for a test that needs to reason about exact totals. */
async function freshOrg(name: string): Promise<Scope> {
  const org = await createTestOrg(db, name);
  createdOrgs.push(org.id);
  return testScope(db, org.id, { type: 'user', id: userId });
}

/**
 * A delivered load, ready to be counted, in the given scope.
 *
 * `source: 'csv_import'` by default — the one source `loads_dispatched_has_truck`
 * exempts from naming a truck, and also Insights' actual primary case: reconciled
 * history is how a carrier's numbers get here before HaulQ has dispatched
 * anything itself. A test that wants a real truck passes `truckId` and gets
 * the constraint satisfied that way instead.
 */
async function delivered(
  scope_: Scope,
  over: Partial<Parameters<typeof createLoad>[1]> = {},
) {
  return createLoad(scope_, {
    status: 'delivered',
    source: 'csv_import',
    brokerName: 'Prairie Freight',
    stops: wichitaToDenver,
    ...over,
  });
}

suite('insights', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const user = await createTestUser(db);
    userId = user.id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(db, id);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  describe('insightsSummary', () => {
    it('is all zeros and nulls for an org with nothing delivered', async () => {
      const s = await freshOrg('Empty Co');
      const summary = await insightsSummary(s);

      assert.equal(summary.loadCount, 0);
      assert.equal(summary.measurableCount, 0);
      assert.equal(summary.revenueCents, 0);
      assert.equal(summary.revenuePerTotalMileCents, null);
      assert.equal(summary.revenuePerLoadedMileCents, null);
      assert.equal(summary.deadheadRatio, null);
    });

    it('counts a delivered load on expected figures alone, per total mile', async () => {
      const s = await freshOrg('Expected Only Co');
      await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 127,
        expectedDeadheadMiles: 176,
      });

      const summary = await insightsSummary(s);
      assert.equal(summary.loadCount, 1);
      assert.equal(summary.measurableCount, 1);
      assert.equal(summary.revenueCents, 40000);
      // The canonical example: $400 over 303 total miles is $1.32/mi, not the
      // $3.15/mi a loaded-only figure would flatter it into.
      assert.equal(summary.revenuePerTotalMileCents, 132);
      assert.equal(summary.revenuePerLoadedMileCents, 315);
    });

    it('actual figures override expected, not the other way round', async () => {
      const s = await freshOrg('Actual Override Co');
      const load = await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 100,
        expectedDeadheadMiles: 50,
      });
      await setLoadActualsForTest(db, load.id, {
        actualRevenueAmount: 50000,
        actualLoadedMiles: 200,
        actualDeadheadMiles: 20,
      });

      const summary = await insightsSummary(s);
      // 220 actual total miles at $500 — not 150 expected miles at $400. If
      // this ever reads the expected figures instead, both numbers are wrong
      // in a way that would still look plausible on its own.
      assert.equal(summary.revenueCents, 50000);
      assert.equal(summary.loadedMiles, 200);
      assert.equal(summary.deadheadMiles, 20);
      assert.equal(summary.revenuePerTotalMileCents, Math.round(50000 / 220));
    });

    it('excludes a load with no deadhead recorded from the per-mile average, rather than treating it as zero', async () => {
      const s = await freshOrg('Unknown Deadhead Co');
      await delivered(s, {
        rate: { amount: 100000, currency: 'USD' },
        expectedLoadedMiles: 500,
        // expectedDeadheadMiles omitted — unknown, not zero.
      });

      const summary = await insightsSummary(s);
      assert.equal(summary.loadCount, 1, 'still counted for revenue and load count');
      assert.equal(summary.revenueCents, 100000);
      assert.equal(
        summary.measurableCount,
        0,
        'not measurable — a null-as-zero bug would make this 1',
      );
      assert.equal(
        summary.revenuePerTotalMileCents,
        null,
        'no per-mile figure from one unmeasurable load',
      );
    });

    it('a deadhead of zero is measurable — it is not the same as unknown', async () => {
      const s = await freshOrg('Zero Deadhead Co');
      const load = await delivered(s, {
        rate: { amount: 100000, currency: 'USD' },
        expectedLoadedMiles: 200,
        expectedDeadheadMiles: 0,
      });
      await setLoadActualsForTest(db, load.id, {
        actualRevenueAmount: 100000,
        actualLoadedMiles: 200,
        actualDeadheadMiles: 0,
      });

      const summary = await insightsSummary(s);
      assert.equal(summary.measurableCount, 1);
      assert.equal(summary.revenuePerTotalMileCents, summary.revenuePerLoadedMileCents);
    });

    it('does not count a load that has not been delivered', async () => {
      const s = await freshOrg('Not Delivered Co');
      await createLoad(s, {
        status: 'booked',
        rate: { amount: 999900, currency: 'USD' },
        brokerName: 'Not Delivered Co',
        stops: wichitaToDenver,
      });

      const summary = await insightsSummary(s);
      assert.equal(summary.loadCount, 0);
      assert.equal(summary.revenueCents, 0);
    });

    it('does not count a cancelled load', async () => {
      const s = await freshOrg('Cancelled Co');
      const load = await createLoad(s, {
        brokerName: 'Cancelled Co',
        rate: { amount: 999900, currency: 'USD' },
        stops: wichitaToDenver,
      });
      await updateLoadStatus(s, load.id, { status: 'cancelled', reason: 'test' });

      const summary = await insightsSummary(s);
      assert.equal(summary.loadCount, 0);
    });

    it('respects the day window', async () => {
      const s = await freshOrg('Window Co');
      const truck = await createTruck(s, { label: 'Window Co Truck' });

      const recent = await createLoad(s, {
        truckId: truck.id,
        brokerName: 'Window Co',
        rate: { amount: 10000, currency: 'USD' },
        stops: wichitaToDenver,
      });
      await updateLoadStatus(s, recent.id, { status: 'delivered' });

      const old = await createLoad(s, {
        truckId: truck.id,
        brokerName: 'Window Co',
        rate: { amount: 10000, currency: 'USD' },
        stops: wichitaToDenver,
      });
      const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
      await updateLoadStatus(s, old.id, { status: 'delivered', occurredAt: longAgo });

      const default90 = await insightsSummary(s);
      const wide365 = await insightsSummary(s, { days: 365 });

      assert.equal(default90.loadCount, 1);
      assert.equal(wide365.loadCount, 2);
    });

    it('reads cost per mile as null with no carrier profile reconciled', async () => {
      // No carrier_profiles row exists for a bare test org — createTestOrg
      // only inserts into orgs, unlike the real signup flow — and this path
      // must not throw on the missing row, just report nothing recorded.
      const s = await freshOrg('No Profile Co');
      const summary = await insightsSummary(s);
      assert.equal(summary.costPerMileCents, null);
      assert.equal(summary.factsReconciledAt, null);
    });
  });

  describe('breakdowns', () => {
    it('groups revenue by broker, worst-named group last, descending by revenue', async () => {
      const s = await freshOrg('Broker Breakdown Co');
      await delivered(s, { brokerName: 'Big Revenue Co', rate: { amount: 500000, currency: 'USD' } });
      // No broker at all — brokerName must be cleared explicitly, since the
      // helper's own default would otherwise still apply.
      await delivered(s, { brokerName: undefined, rate: { amount: 100, currency: 'USD' } });

      const rows = await revenueByBroker(s, { limit: 100 });
      assert.ok(rows.some((r) => r.label === 'Big Revenue Co'));
      assert.ok(rows.some((r) => r.label === 'No broker recorded'));
      for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i - 1]!.revenueCents >= rows[i]!.revenueCents);
      }
    });

    it('groups lanes state-to-state, not city-to-city', async () => {
      const s = await freshOrg('Lane Breakdown Co');
      await delivered(s, {
        rate: { amount: 10000, currency: 'USD' },
        stops: [
          { type: 'pickup', city: 'Wichita', state: 'KS' },
          { type: 'delivery', city: 'Denver', state: 'CO' },
        ],
      });
      await delivered(s, {
        rate: { amount: 10000, currency: 'USD' },
        stops: [
          // A different city pair in the same two states.
          { type: 'pickup', city: 'Topeka', state: 'KS' },
          { type: 'delivery', city: 'Aurora', state: 'CO' },
        ],
      });

      const lanes = await revenueByLane(s, { limit: 100 });
      assert.equal(lanes.length, 1, 'two city pairs collapse into one state-to-state lane');
      assert.equal(lanes[0]!.key, 'KS → CO');
      assert.equal(lanes[0]!.loadCount, 2);
    });

    it('reports mixed basis when some loads in a group are reconciled and some are not', async () => {
      const s = await freshOrg('Mixed Basis Co');
      const reconciled = await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 100,
        expectedDeadheadMiles: 10,
      });
      await setLoadActualsForTest(db, reconciled.id, {
        actualRevenueAmount: 41000,
        actualLoadedMiles: 101,
        actualDeadheadMiles: 11,
      });
      await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 100,
        expectedDeadheadMiles: 10,
      });

      const rows = await revenueByBroker(s, { limit: 100 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.basis, 'mixed');
    });

    it('reports actual basis only when every load in the group is reconciled', async () => {
      const s = await freshOrg('All Actual Co');
      const load = await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 100,
        expectedDeadheadMiles: 10,
      });
      await setLoadActualsForTest(db, load.id, {
        actualRevenueAmount: 41000,
        actualLoadedMiles: 101,
        actualDeadheadMiles: 11,
      });

      const rows = await revenueByBroker(s, { limit: 100 });
      assert.equal(rows[0]!.basis, 'actual');
    });

    it('groups revenue by truck, including loads with none assigned', async () => {
      const s = await freshOrg('Truck Breakdown Co');
      const truck = await createTruck(s, { label: 'Insights Unit 1' });
      await delivered(s, { truckId: truck.id, rate: { amount: 20000, currency: 'USD' } });
      await delivered(s, { rate: { amount: 5000, currency: 'USD' } });

      const rows = await revenueByTruck(s, { limit: 100 });
      assert.ok(rows.some((r) => r.label === 'Insights Unit 1'));
      assert.ok(rows.some((r) => r.label === 'No truck recorded'));
    });

    it('respects the limit', async () => {
      const s = await freshOrg('Limit Co');
      for (let i = 0; i < 3; i++) {
        await delivered(s, { brokerName: `Limit Co ${i}`, rate: { amount: 1000, currency: 'USD' } });
      }
      const rows = await revenueByBroker(s, { limit: 2 });
      assert.equal(rows.length, 2);
    });
  });

  describe('loadMargin', () => {
    it('reports no invoice for a load never invoiced', async () => {
      const s = await freshOrg('No Invoice Co');
      const load = await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 127,
        expectedDeadheadMiles: 176,
      });

      const margin = await loadMargin(s, load.id);
      assert.ok(margin);
      assert.equal(margin!.reference, load.reference);
      assert.equal(margin!.revenueCents, 40000);
      assert.equal(margin!.basis, 'expected');
      assert.equal(margin!.invoiceStatus, null);
      assert.equal(margin!.invoiceTotalCents, null);
    });

    it('reports the open invoice once one is generated', async () => {
      const s = await freshOrg('With Invoice Co');
      const load = await delivered(s, { rate: { amount: 40000, currency: 'USD' } });
      await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'Linehaul', amountCents: 40000 }],
      });

      const margin = await loadMargin(s, load.id);
      assert.equal(margin!.invoiceStatus, 'draft');
      assert.equal(margin!.invoiceTotalCents, 40000);
    });

    it('switches to actual basis once the load is reconciled', async () => {
      const s = await freshOrg('Reconciled Margin Co');
      const load = await delivered(s, {
        rate: { amount: 40000, currency: 'USD' },
        expectedLoadedMiles: 100,
        expectedDeadheadMiles: 20,
      });
      await setLoadActualsForTest(db, load.id, {
        actualRevenueAmount: 50000,
        actualLoadedMiles: 120,
        actualDeadheadMiles: 10,
      });

      const margin = await loadMargin(s, load.id);
      assert.equal(margin!.basis, 'actual');
      assert.equal(margin!.revenueCents, 50000);
    });

    it('is invisible from another tenant', async () => {
      const s = await freshOrg('Margin Owner Co');
      const other = await freshOrg('Margin Other Co');
      const load = await delivered(s);

      assert.equal(await loadMargin(other, load.id), undefined);
    });
  });

  describe('paymentPerformance', () => {
    it('is zeros and nulls with nothing paid', async () => {
      const s = await freshOrg('Nothing Paid Co');
      const perf = await paymentPerformance(s);
      assert.equal(perf.paidInvoiceCount, 0);
      assert.equal(perf.avgDaysToPayment, null);
      assert.equal(perf.exceptionRate, null);
      assert.equal(perf.factoringRejectedCount, 0);
    });

    it('does not count an on-time payment as late', async () => {
      const s = await freshOrg('On Time Co');
      const load = await delivered(s);
      const futureDue = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
        dueAt: futureDue,
      });
      await sendInvoice(s, invoice.id);
      await recordPayment(s, { invoiceId: invoice.id, amountCents: 10000, source: 'broker_direct' });

      const perf = await paymentPerformance(s);
      assert.equal(perf.paidInvoiceCount, 1);
      assert.equal(perf.lateCount, 0);
      assert.equal(perf.exceptionRate, 0);
      assert.ok(perf.avgDaysToPayment !== null && perf.avgDaysToPayment >= 0);
    });

    it('flags a payment landing after the due date as late', async () => {
      const s = await freshOrg('Late Payment Co');
      const load = await delivered(s);
      const pastDue = new Date(Date.now() - 5 * 86_400_000).toISOString();
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
        dueAt: pastDue,
      });
      await sendInvoice(s, invoice.id);
      await recordPayment(s, { invoiceId: invoice.id, amountCents: 10000, source: 'broker_direct' });

      const perf = await paymentPerformance(s);
      assert.equal(perf.lateCount, 1);
      assert.equal(perf.exceptionRate, 1);
    });

    it('counts a factoring rejection separately from late payments', async () => {
      const s = await freshOrg('Rejected Factor Co');
      const load = await delivered(s);
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
      });
      await sendInvoice(s, invoice.id);
      const factor = await createFactoringCompany(s, { name: 'Reject Capital' });
      const packet = await assembleFactoringPacket(s, {
        invoiceId: invoice.id,
        factoringCompanyId: factor.id,
        documentIds: [],
      });
      await submitFactoringPacket(s, packet.id);
      await recordFactoringResponse(s, packet.id, { outcome: 'rejected', reason: 'Missing POD' });

      const perf = await paymentPerformance(s);
      assert.equal(perf.factoringRejectedCount, 1);
      // Never paid, so it does not also show up as a late payment.
      assert.equal(perf.paidInvoiceCount, 0);
    });
  });

  describe('actionQueue', () => {
    it('is empty for an org with nothing outstanding', async () => {
      const s = await freshOrg('Nothing Outstanding Co');
      const queue = await actionQueue(s);
      assert.deepEqual(queue.deliveredNotInvoiced, []);
      assert.deepEqual(queue.overdueInvoices, []);
    });

    it('does not flag a load delivered inside the grace window', async () => {
      const s = await freshOrg('Fresh Delivery Co');
      await delivered(s);

      const queue = await actionQueue(s);
      assert.deepEqual(queue.deliveredNotInvoiced, []);
    });

    it('flags a load delivered past the grace window with no invoice', async () => {
      const s = await freshOrg('Forgotten Invoice Co');
      const load = await createLoad(s, { source: 'csv_import', brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await updateLoadStatus(s, load.id, { status: 'delivered', occurredAt: tenDaysAgo });

      const queue = await actionQueue(s);
      assert.equal(queue.deliveredNotInvoiced.length, 1);
      assert.equal(queue.deliveredNotInvoiced[0]!.loadId, load.id);
      assert.equal(queue.deliveredNotInvoiced[0]!.brokerName, 'Prairie Freight');
      assert.ok(queue.deliveredNotInvoiced[0]!.daysSinceDelivered >= 10);
    });

    it('does not flag a load once it has an invoice, even a draft one', async () => {
      const s = await freshOrg('Draft Invoice Co');
      const load = await createLoad(s, { source: 'csv_import', brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await updateLoadStatus(s, load.id, { status: 'delivered', occurredAt: tenDaysAgo });
      await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
      });

      const queue = await actionQueue(s);
      assert.deepEqual(queue.deliveredNotInvoiced, []);
    });

    it('does not flag a sent invoice that is not yet due', async () => {
      const s = await freshOrg('Not Due Yet Co');
      const load = await delivered(s);
      const futureDue = new Date(Date.now() + 5 * 86_400_000).toISOString();
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
        dueAt: futureDue,
      });
      await sendInvoice(s, invoice.id);

      const queue = await actionQueue(s);
      assert.deepEqual(queue.overdueInvoices, []);
    });

    it('flags a sent invoice past its due date, naming the broker and the load', async () => {
      const s = await freshOrg('Overdue Invoice Co');
      const load = await delivered(s);
      const pastDue = new Date(Date.now() - 12 * 86_400_000).toISOString();
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 15000 }],
        dueAt: pastDue,
      });
      await sendInvoice(s, invoice.id);

      const queue = await actionQueue(s);
      assert.equal(queue.overdueInvoices.length, 1);
      const row = queue.overdueInvoices[0]!;
      assert.equal(row.invoiceId, invoice.id);
      assert.equal(row.loadReference, load.reference);
      assert.equal(row.brokerName, 'Prairie Freight');
      assert.equal(row.totalCents, 15000);
      assert.ok(row.daysOverdue >= 12);
    });

    it('does not flag an overdue invoice once it is paid', async () => {
      const s = await freshOrg('Paid Late Co');
      const load = await delivered(s);
      const pastDue = new Date(Date.now() - 12 * 86_400_000).toISOString();
      const invoice = await generateInvoice(s, {
        loadId: load.id,
        lineItems: [{ code: 'linehaul', description: 'A', amountCents: 10000 }],
        dueAt: pastDue,
      });
      await sendInvoice(s, invoice.id);
      await recordPayment(s, { invoiceId: invoice.id, amountCents: 10000, source: 'broker_direct' });

      const queue = await actionQueue(s);
      assert.deepEqual(queue.overdueInvoices, []);
    });

    it('is invisible from another org', async () => {
      const s = await freshOrg('Queue Owner Co');
      const other = await freshOrg('Queue Stranger Co');
      const load = await createLoad(s, { source: 'csv_import', brokerName: 'Prairie Freight', stops: wichitaToDenver });
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
      await updateLoadStatus(s, load.id, { status: 'delivered', occurredAt: tenDaysAgo });

      const queue = await actionQueue(other);
      assert.deepEqual(queue.deliveredNotInvoiced, []);
    });
  });
});
