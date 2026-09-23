/**
 * The invoice PDF. What is worth testing is not the layout but the ways a
 * render could fail *in the middle of a send*: pdf-lib's standard fonts
 * throw on characters they cannot draw, so a broker named with an emoji, or
 * a lane with an arrow, must degrade to `?` rather than fail the email.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InvoiceRenderFacts } from '@haulq/db';
import { PDFDocument } from 'pdf-lib';
import { renderInvoicePdf, winAnsi } from './pdf.ts';

const facts = (over: Partial<InvoiceRenderFacts> = {}): InvoiceRenderFacts => ({
  invoiceId: '11111111-1111-4111-8111-111111111111',
  reference: 1042,
  status: 'draft',
  createdAt: new Date('2026-09-20T15:00:00Z'),
  dueAt: new Date('2026-10-20T15:00:00Z'),
  lineItems: [{ code: 'linehaul', description: 'Freight: Wichita, KS to Denver, CO', amountCents: 240_000, currency: 'USD' }],
  totalCents: 240_000,
  currency: 'USD',
  loadReference: 88,
  brokerLoadNumber: 'PF-77120',
  origin: 'Wichita, KS',
  destination: 'Denver, CO',
  deliveredAt: new Date('2026-09-18T12:00:00Z'),
  brokerName: 'Prairie Freight LLC',
  brokerEmail: 'ap@prairie.example.com',
  paymentTermsDays: 30,
  carrierName: 'Kansas Box Truck Co',
  mcNumber: '123456',
  ...over,
});

describe('renderInvoicePdf', () => {
  it('produces a real, one-page PDF', async () => {
    const bytes = await renderInvoicePdf(facts());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    const parsed = await PDFDocument.load(bytes);
    assert.equal(parsed.getPageCount(), 1);
  });

  it('renders the same invoice to the same bytes, so a recorded checksum is a fact about the invoice', async () => {
    const a = await renderInvoicePdf(facts());
    const b = await renderInvoicePdf(facts());
    assert.ok(a.equals(b));
  });

  it('does not fail on characters the standard fonts cannot draw', async () => {
    const bytes = await renderInvoicePdf(
      facts({
        brokerName: 'Prairie Freight 🚚 LLC — Nürnberg 荷物',
        carrierName: 'Käse & Söhne Trucking ✓',
        origin: 'Wichita, KS',
        destination: 'Denver → CO',
        lineItems: [{ code: 'x', description: 'Linehaul → “premium” 🚛', amountCents: 100, currency: 'USD' }],
        totalCents: 100,
      }),
    );
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('wraps a very long description instead of running off the page', async () => {
    const long = 'Linehaul with a great many words in the description '.repeat(20);
    const bytes = await renderInvoicePdf(
      facts({ lineItems: [{ code: 'x', description: long, amountCents: 500, currency: 'USD' }], totalCents: 500 }),
    );
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  });

  it('renders an invoice with no due date, no MC, and no broker details', async () => {
    const bytes = await renderInvoicePdf(
      facts({ dueAt: null, paymentTermsDays: null, mcNumber: null, brokerName: null, brokerEmail: null, brokerLoadNumber: null }),
    );
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  });
});

describe('winAnsi', () => {
  it('keeps printable Latin-1 and replaces everything else with a question mark', () => {
    assert.equal(winAnsi('Café Nürnberg'), 'Café Nürnberg');
    assert.equal(winAnsi('Truck 🚚'), 'Truck ?', 'one character, one question mark');
    assert.equal(winAnsi('a→b'), 'a?b');
  });

  it('flattens line breaks, which the font cannot draw either', () => {
    assert.equal(winAnsi('one\ntwo\r\nthree\tfour'), 'one two three four');
  });
});
