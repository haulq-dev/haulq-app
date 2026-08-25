/**
 * Deterministic classification.
 *
 * Every fixture here is a line that really appears on the document it is meant
 * to identify. The suite is not checking a regex — it is checking three
 * judgements that cost money if they are wrong:
 *
 *  - a printed title is trusted, so no model is called for the common case
 *  - a filename is never trusted on its own
 *  - a packet is reported as ambiguous rather than routed on its loudest page
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLASSIFY_THRESHOLD,
  classifyDeterministically,
  isConfident,
  worthExtracting,
} from './classify.ts';

const RATECON = `
  PRAIRIE LOGISTICS LLC
  RATE CONFIRMATION
  Load #  84213          Carrier: Test Carrier LLC
  Agreed Rate: $2,400.00
`;

const BOL = `
  STRAIGHT BILL OF LADING            Original — Not Negotiable
  Shipper: Acme Manufacturing
  B/L Number: 55231
`;

const POD = `
  PROOF OF DELIVERY
  Received in good order and condition
  Consignee signature: ____________
`;

const INVOICE = `
  FREIGHT INVOICE
  Invoice Number: 10042
  Remit to: Prairie Freight LLC
  Amount Due: $2,400.00
`;

describe('classifyDeterministically', () => {
  it('reads a rate confirmation off its own title', () => {
    const c = classifyDeterministically({ text: RATECON });
    assert.equal(c?.kind, 'rate_confirmation');
    assert.ok(isConfident(c), `confidence was ${c?.confidence}`);
    assert.match(c!.reason, /RATE CONFIRMATION/i);
  });

  it('reads a rate confirmation that calls itself a "carrier dispatch" instead', () => {
    // Found against a real broker's paperwork, which never says "rate
    // confirmation," "load confirmation" or "carrier confirmation" anywhere
    // on the page.
    const text = 'CARRIER DISPATCH\nLOAD #: 2937288\nDispatcher: Test Dispatcher\n';
    const c = classifyDeterministically({ text });
    assert.equal(c?.kind, 'rate_confirmation');
    assert.ok(isConfident(c), `confidence was ${c?.confidence}`);
  });

  it('reads a bill of lading', () => {
    const c = classifyDeterministically({ text: BOL });
    assert.equal(c?.kind, 'bol');
    assert.ok(isConfident(c));
  });

  it('reads a proof of delivery', () => {
    const c = classifyDeterministically({ text: POD });
    assert.equal(c?.kind, 'pod');
    assert.ok(isConfident(c));
  });

  it('reads an invoice', () => {
    const c = classifyDeterministically({ text: INVOICE });
    assert.equal(c?.kind, 'invoice');
    assert.ok(isConfident(c));
  });

  it('does not confuse a rate confirmation for an invoice over one dollar figure', () => {
    // Both carry money. Only one says what it is.
    const c = classifyDeterministically({ text: RATECON });
    assert.equal(c?.kind, 'rate_confirmation');
  });

  it('reports a carrier packet as ambiguous rather than picking a page', () => {
    const packet = [RATECON, BOL, POD].join('\n');
    const c = classifyDeterministically({ text: packet });
    assert.ok(c, 'still returns its best guess');
    assert.ok(
      !isConfident(c),
      `a packet must not route on one page, got ${c!.confidence} for ${c!.kind}`,
    );
    assert.match(c!.reason, /packet/);
  });

  it('never classifies on a filename alone', () => {
    const c = classifyDeterministically({ filename: 'ratecon_1042.pdf' });
    assert.equal(c?.kind, 'rate_confirmation');
    assert.ok(
      !isConfident(c),
      'a filename is renamed by systems that do not care what is inside',
    );
  });

  it('lets a filename break a tie without deciding one', () => {
    const weak = 'Consignee signature: ______';
    const withName = classifyDeterministically({ text: weak, filename: 'POD-1042.pdf' });
    assert.equal(withName?.kind, 'pod');
    assert.ok(!isConfident(withName), 'weak page plus filename is still not proof');
  });

  it('returns null when there is nothing to go on', () => {
    assert.equal(classifyDeterministically({}), null);
    assert.equal(classifyDeterministically({ text: 'Dear carrier,\n\nThanks.' }), null);
    assert.equal(classifyDeterministically({ text: '', filename: 'scan001.pdf' }), null);
  });

  it('does not accumulate confidence from one template repeating itself', () => {
    const repeated = 'RATE CONFIRMATION\n'.repeat(5) + 'Rate Con\nCarrier Confirmation';
    const c = classifyDeterministically({ text: repeated });
    assert.ok(c!.confidence <= 1, `confidence must stay a probability, got ${c!.confidence}`);
  });

  it('recognises the small paperwork a carrier still has to file', () => {
    const cases: Array<[string, string]> = [
      ['LUMPER RECEIPT — paid $150', 'lumper_receipt'],
      ['SCALE TICKET  Gross 78,400 lb', 'scale_ticket'],
      ['CERTIFIED WEIGHT  78,400 lb', 'weight_ticket'],
      ['CERTIFICATE OF LIABILITY INSURANCE', 'insurance_certificate'],
      ['Form W-9  Request for Taxpayer Identification Number', 'w9'],
      ['CARRIER SETUP PACKET', 'carrier_packet'],
    ];
    for (const [text, kind] of cases) {
      const c = classifyDeterministically({ text });
      assert.equal(c?.kind, kind, `${text} → ${c?.kind}`);
      assert.ok(isConfident(c), `${text} was only ${c?.confidence}`);
    }
  });

  it('keeps the threshold where the comment says it is', () => {
    // Guards against someone lowering it to make a flaky case pass. The cost of
    // a wrong confident answer is a document validated against the wrong fields.
    assert.equal(CLASSIFY_THRESHOLD, 0.7);
  });
});

describe('worthExtracting', () => {
  it('skips the kinds with no fields to check against a load', () => {
    assert.equal(worthExtracting('pod'), false);
    assert.equal(worthExtracting('w9'), false);
    assert.equal(worthExtracting('insurance_certificate'), false);
  });

  it('extracts from the kinds that carry numbers', () => {
    assert.equal(worthExtracting('rate_confirmation'), true);
    assert.equal(worthExtracting('invoice'), true);
    assert.equal(worthExtracting('bol'), true);
    assert.equal(worthExtracting('scale_ticket'), true);
  });
});
