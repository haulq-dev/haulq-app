import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agingSummary,
  balanceDue,
  dateInputToIso,
  daysOverdue,
  invoiceableLoads,
  invoiceActions,
  isOverdue,
  lineItemsBody,
  parseDollars,
  settleablePackets,
  todayInput,
  type FactoringPacket,
} from './pay.ts';

const NOW = Date.parse('2026-09-27T12:00:00Z');

describe('parseDollars', () => {
  it('reads what a phone keyboard produces', () => {
    assert.equal(parseDollars('2400'), 240_000);
    assert.equal(parseDollars('2,400.5'), 240_050);
    assert.equal(parseDollars(' $2,400.50 '), 240_050);
    assert.equal(parseDollars('0.07'), 7);
    assert.equal(parseDollars('12.'), 1200);
  });

  it('refuses anything it would have to guess at, rather than billing a different amount', () => {
    for (const bad of ['', 'abc', '-5', '1.234', '1.2.3', '$', '12 00']) assert.equal(parseDollars(bad), null, bad);
  });
});

describe('lineItemsBody', () => {
  it('drops empty rows and converts the rest to cents', () => {
    const result = lineItemsBody([
      { code: 'linehaul', description: 'Linehaul', amount: '2,200' },
      { code: 'fuel_surcharge', description: '', amount: '' },
      { code: '', description: 'Lumper', amount: '85' },
    ]);
    assert.deepEqual(result, {
      items: [
        { code: 'linehaul', description: 'Linehaul', amountCents: 220_000 },
        { code: 'other', description: 'Lumper', amountCents: 8_500 },
      ],
    });
  });

  it('names the half-filled row instead of silently leaving it off the invoice', () => {
    assert.deepEqual(lineItemsBody([{ code: 'linehaul', description: 'Linehaul', amount: '2200' }, { code: 'detention', description: 'Detention', amount: '' }]), { invalidRow: 1 });
    assert.deepEqual(lineItemsBody([{ code: 'x', description: 'Thing', amount: '0' }]), { invalidRow: 0 });
    assert.deepEqual(lineItemsBody([{ code: 'x', description: '', amount: '' }]), { empty: true });
  });
});

describe('aging', () => {
  it('totals what is owed and what of it is late', () => {
    assert.deepEqual(
      agingSummary([
        { bucket: 'current', count: 2, totalCents: 400_000 },
        { bucket: 'past_1_30', count: 1, totalCents: 150_000 },
        { bucket: 'past_over_90', count: 1, totalCents: 90_000 },
      ]),
      { owedCents: 640_000, owedCount: 4, lateCents: 240_000, lateCount: 2 },
    );
  });

  it('only calls a sent invoice late', () => {
    const due = '2026-09-20T12:00:00Z';
    assert.equal(isOverdue({ status: 'sent', dueAt: due }, NOW), true);
    assert.equal(daysOverdue({ status: 'sent', dueAt: due }, NOW), 7);
    assert.equal(isOverdue({ status: 'draft', dueAt: due }, NOW), false);
    assert.equal(isOverdue({ status: 'paid', dueAt: due }, NOW), false);
    assert.equal(isOverdue({ status: 'sent', dueAt: null }, NOW), false);
    assert.equal(daysOverdue({ status: 'sent', dueAt: '2026-10-01T00:00:00Z' }, NOW), 0);
  });
});

describe('balanceDue', () => {
  it('subtracts partial payments and never goes negative', () => {
    assert.equal(balanceDue({ totalAmount: 240_000 }, [{ paymentAmount: 100_000 }]), 140_000);
    assert.equal(balanceDue({ totalAmount: 240_000 }, [{ paymentAmount: 300_000 }]), 0);
    assert.equal(balanceDue({ totalAmount: 240_000 }, []), 240_000);
  });
});

describe('invoiceActions', () => {
  it('lets a dispatcher mark a draft sent, but not move money', () => {
    assert.deepEqual(invoiceActions({ status: 'draft' }, 'dispatcher'), { markSent: true, recordPayment: false, void: false, startPacket: false });
    assert.deepEqual(invoiceActions({ status: 'sent' }, 'dispatcher'), { markSent: false, recordPayment: false, void: false, startPacket: true });
  });

  it('gives money roles payment and void on a sent invoice', () => {
    for (const role of ['owner', 'accountant']) {
      assert.deepEqual(invoiceActions({ status: 'sent' }, role), { markSent: false, recordPayment: true, void: true, startPacket: true });
    }
  });

  it('offers nothing that would only fail: a paid invoice cannot be voided, a void one takes nothing', () => {
    assert.deepEqual(invoiceActions({ status: 'paid' }, 'owner'), { markSent: false, recordPayment: false, void: false, startPacket: false });
    assert.deepEqual(invoiceActions({ status: 'void' }, 'owner'), { markSent: false, recordPayment: false, void: false, startPacket: false });
  });

  it('gives a driver nothing', () => {
    assert.deepEqual(invoiceActions({ status: 'draft' }, 'driver'), { markSent: false, recordPayment: false, void: false, startPacket: false });
  });
});

describe('invoiceableLoads', () => {
  const loads = [
    { id: 'A', status: 'delivered' },
    { id: 'B', status: 'invoiced' },
    { id: 'C', status: 'invoiced' },
    { id: 'D', status: 'in_transit' },
  ];

  it('keeps delivered loads and reissues after a void, and drops loads with an open invoice', () => {
    const got = invoiceableLoads(loads, [
      { loadId: 'B', status: 'sent' },
      { loadId: 'C', status: 'void' },
    ]).map((l) => l.id);
    assert.deepEqual(got, ['A', 'C']);
  });
});

describe('settleablePackets', () => {
  it('is the packets a factor has or accepted', () => {
    const p = (id: string, status: FactoringPacket['status']): FactoringPacket => ({
      id, invoiceId: 'I', factoringCompanyId: 'F', status, submittedAt: null, respondedAt: null, rejectionReason: null,
    });
    const got = settleablePackets([p('1', 'assembling'), p('2', 'submitted'), p('3', 'accepted'), p('4', 'rejected'), p('5', 'funded')]);
    assert.deepEqual(got.map((x) => x.id), ['2', '3']);
  });
});

describe('dates', () => {
  it('turns a date input into local noon and back', () => {
    const iso = dateInputToIso('2026-09-03');
    assert.ok(iso);
    assert.equal(todayInput(new Date(iso)), '2026-09-03');
    assert.equal(dateInputToIso('09/03/2026'), null);
  });
});
