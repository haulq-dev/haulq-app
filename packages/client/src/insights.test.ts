import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionItems, activityDay, actorLabel, againstCost, factsToForm, formToFacts, perMile, wholeDollars } from './insights.ts';

describe('money on the insights screen', () => {
  it('formats headline dollars whole and per-mile figures with cents', () => {
    assert.equal(wholeDollars(1_248_050), '$12,481');
    assert.equal(perMile(194), '$1.94');
    assert.equal(perMile(null), '—');
  });

  it('compares against cost only when both sides exist', () => {
    assert.deepEqual(againstCost(194, 160), { above: true, gapCents: 34 });
    assert.deepEqual(againstCost(140, 160), { above: false, gapCents: 20 });
    assert.equal(againstCost(null, 160), null);
    assert.equal(againstCost(194, null), null);
  });
});

describe('actionItems', () => {
  it('merges uninvoiced loads and overdue invoices, worst first', () => {
    const items = actionItems({
      deliveredNotInvoiced: [{ loadId: 'L1', reference: 1042, brokerName: 'TQL', daysSinceDelivered: 3 }],
      overdueInvoices: [{ invoiceId: 'I1', reference: 1001, loadReference: 1030, brokerName: null, totalCents: 240_000, daysOverdue: 12 }],
    });
    assert.deepEqual(items.map((i) => i.key), ['inv-I1', 'load-L1']);
    assert.equal(items[0]!.text, 'Invoice 1001 for load 1030, $2,400, 12 days past due.');
    assert.equal(items[1]!.text, 'Load 1042 (TQL) delivered 3 days ago, not invoiced.');
  });
});

describe('operating costs form', () => {
  it('round-trips cents through dollars', () => {
    const form = factsToForm({ costPerMileCents: 135, avgMpg: 9.5, driverPayPerMileCents: 0 });
    assert.equal(form.costPerMileCents, '1.35');
    assert.equal(form.avgMpg, '9.5');
    assert.equal(form.driverPayPerMileCents, '0.00');
    assert.equal(form.fixedWeeklyCostCents, '');
    assert.deepEqual(formToFacts(form), { facts: { costPerMileCents: 135, avgMpg: 9.5, driverPayPerMileCents: 0 } });
  });

  it('names a field that is not a number, rather than quietly not saving it', () => {
    const form = factsToForm({});
    assert.deepEqual(formToFacts({ ...form, costPerMileCents: '1.3.5' }), { invalid: 'costPerMileCents' });
    assert.deepEqual(formToFacts({ ...form, avgMpg: 'nine' }), { invalid: 'avgMpg' });
  });
});

describe('activity', () => {
  it('says HaulQ for anything a person did not do', () => {
    assert.equal(actorLabel('agent'), 'HaulQ');
    assert.equal(actorLabel('system'), 'HaulQ');
    assert.equal(actorLabel('user'), 'A person');
  });

  it('groups by Today, Yesterday, then the date', () => {
    const now = new Date(2026, 8, 27, 15, 0);
    assert.equal(activityDay(new Date(2026, 8, 27, 1, 0).toISOString(), now), 'Today');
    assert.equal(activityDay(new Date(2026, 8, 26, 23, 0).toISOString(), now), 'Yesterday');
    assert.equal(activityDay(new Date(2026, 8, 20, 9, 0).toISOString(), now), 'Sun, Sep 20');
    assert.equal(activityDay(new Date(2025, 11, 31, 9, 0).toISOString(), now), 'Wed, Dec 31, 2025');
  });
});
