/**
 * Deterministic extraction.
 *
 * The fixtures are shaped like real broker output, because the failure this
 * suite exists to catch is subtle: an extractor that finds *a* number rather
 * than *the* number. A rate confirmation carries a linehaul, a fuel surcharge, a
 * total and often a rate per mile, and picking the wrong one produces a
 * disagreement against a load that is actually correct.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DETERMINISTIC_VERSION,
  extractDeterministically,
  parseCount,
  parseMoney,
} from './extract.ts';

describe('parseMoney', () => {
  it('turns printed money into integer minor units', () => {
    assert.equal(parseMoney('$2,400.00'), 240000);
    assert.equal(parseMoney('2400'), 240000);
    assert.equal(parseMoney('$1,150.50'), 115050);
    assert.equal(parseMoney('  $975  '), 97500);
    assert.equal(parseMoney('0.05'), 5);
  });

  it('keeps a single decimal place meaning tenths, not hundredths', () => {
    assert.equal(parseMoney('$2,400.5'), 240050);
  });

  it('refuses anything that is not plainly an amount', () => {
    assert.equal(parseMoney('see invoice'), null);
    assert.equal(parseMoney(''), null);
    assert.equal(parseMoney('$'), null);
    // Three decimals is a per-mile rate or a tax factor, not a price. Rounding
    // it would put an invented cent into an invoice.
    assert.equal(parseMoney('1.2345'), null);
  });

  it('never produces a float', () => {
    for (const raw of ['$2,400.00', '1.05', '999999.99']) {
      assert.ok(Number.isInteger(parseMoney(raw)), raw);
    }
  });
});

describe('parseCount', () => {
  it('reads a weight', () => {
    assert.equal(parseCount('42,000'), 42000);
    assert.equal(parseCount('7'), 7);
  });
  it('refuses a decimal or a word', () => {
    assert.equal(parseCount('42.5'), null);
    assert.equal(parseCount('heavy'), null);
  });
});

const RATECON = `
PRAIRIE LOGISTICS LLC              RATE CONFIRMATION
Carrier: Test Carrier LLC
Load Number: 84213
Equipment: Dry Van
Weight: 42,000 lbs
Line Haul: $2,150.00
Fuel Surcharge: $250.00
Total Rate: $2,400.00
`;

describe('extractDeterministically — rate confirmation', () => {
  const result = extractDeterministically({ text: RATECON, kind: 'rate_confirmation' });

  it('takes the total, not the linehaul and not the surcharge', () => {
    assert.equal(result.fields['rateAmount']?.value, 240000);
    assert.equal(result.fields['rateAmount']?.raw, '$2,400.00');
  });

  it('keeps the linehaul separately, because Pay will need it', () => {
    assert.equal(result.fields['linehaulAmount']?.value, 215000);
  });

  it('reads the broker load number', () => {
    assert.equal(result.fields['brokerLoadNumber']?.value, '84213');
  });

  it('reads the weight as a whole number', () => {
    assert.equal(result.fields['weightLbs']?.value, 42000);
  });

  it('records the label it keyed on, so a wrong match is diagnosable', () => {
    assert.match(result.fields['rateAmount']?.label ?? '', /total rate/i);
  });

  it('needs no model pass when it found everything expected', () => {
    assert.deepEqual(result.missing, []);
  });

  it('stamps the version, so a cohort can be re-run', () => {
    assert.equal(result.version, DETERMINISTIC_VERSION);
  });
});

describe('extractDeterministically — what it will not do', () => {
  it('reports a missing rate rather than inventing one', () => {
    const text = 'RATE CONFIRMATION\nCarrier: Test Carrier LLC\nLoad Number: 99\n';
    const result = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(result.fields['rateAmount'], undefined);
    assert.ok(result.missing.includes('rateAmount'));
  });

  it('does not read a per-mile figure as the rate', () => {
    const text = 'RATE CONFIRMATION\nPer Mile Rate: $1.85\nLoad Number: 7\n';
    const result = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(
      result.fields['rateAmount'],
      undefined,
      '$1.85 is a rate per mile; treating it as the load rate is a 1000x error',
    );
  });

  it('finds nothing on a kind it has no rules for', () => {
    const result = extractDeterministically({ text: RATECON, kind: 'pod' });
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.missing, []);
  });

  it('returns empty rather than throwing on an empty page', () => {
    const result = extractDeterministically({ text: '', kind: 'rate_confirmation' });
    assert.deepEqual(result.fields, {});
    assert.deepEqual(result.missing.sort(), ['brokerLoadNumber', 'rateAmount']);
  });
});

describe('extractDeterministically — real broker layouts', () => {
  // Every case below is a synthetic fixture reproducing the *structure* of a
  // real rate confirmation checked by hand against this file's rules on
  // 2026-08-25 — not the real document, which is a carrier's own business
  // correspondence and does not belong copied into source control. The
  // structure is what mattered: which of the seven checked, and why each one
  // did or did not extract correctly, is what these pin.

  it('reads a bare "Total:" with no qualifying word, tried only after every more specific label', () => {
    const text = 'TOTAL QUALITY RATE CONFIRMATION\nLoad #: 38058701\nRate Type Total\nTotal: $1,700.00 USD\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['rateAmount']?.value, 170000);
  });

  it('does not let "Total Weight"/"Total Pieces" satisfy the bare "Total:" fallback', () => {
    // The word between "Total" and the value is what protects this — see the
    // fallback's own comment in extract.ts.
    const text = 'RATE CONFIRMATION\nLoad #: 7\nTotal Weight: 42,000\nTotal Pieces: 12\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['rateAmount'], undefined);
    assert.ok(r.missing.includes('rateAmount'));
  });

  it('reads a broker load number given only as "PO#"', () => {
    const text = 'RATE CONFIRMATION FOR PO# 38058701\nCarrier: Test Carrier LLC\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['brokerLoadNumber']?.value, '38058701');
  });

  it('does not let a bare "po" match inside an unrelated word', () => {
    const text = 'RATE CONFIRMATION\nDelivery Location: Port of Long Beach\nLoad Number: 445\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['brokerLoadNumber']?.value, '445');
  });

  it('skips a stray word satisfying the load-number pattern and finds the real one later', () => {
    // "Load At <shipper>" appearing before the real "Load #:" in extraction
    // order — found against a real broker's PDF, where the label furthest
    // from the header lands first in the text stream.
    const text =
      'Stop Information\nLoad At Some Shipper LLC\nEarliest Date 08/24/2026\n' +
      'CARRIER DISPATCH\nLOAD #: 2937288\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['brokerLoadNumber']?.value, '2937288');
  });

  it('reports a load number missing rather than a stray word, when no real one exists', () => {
    const text = 'Stop Information\nLoad At Some Shipper LLC\nEarliest Date 08/24/2026\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['brokerLoadNumber'], undefined);
    assert.ok(r.missing.includes('brokerLoadNumber'));
  });

  it('reads a weight with a unit annotation between the label and the colon', () => {
    const text = 'RATE CONFIRMATION\nLoad #: 9\nTotal Weight (lbs): 2627\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['weightLbs']?.value, 2627);
  });

  it('reads a linehaul stated as "Line Haul Rate"', () => {
    const text = 'RATE CONFIRMATION\nLoad #: 9\nLine Haul Rate  2300.00\nTotal Rate  2300.00\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['linehaulAmount']?.value, 230000);
  });

  it('reads equipment stated as "Trailer Req" rather than "Trailer Type"', () => {
    const text = 'RATE CONFIRMATION\nLoad #: 9\nTrailer Req: Straight Truck\n';
    const r = extractDeterministically({ text, kind: 'rate_confirmation' });
    assert.equal(r.fields['equipment']?.value, 'Straight Truck');
  });
});

describe('extractDeterministically — the other kinds', () => {
  it('reads an invoice', () => {
    const text = 'FREIGHT INVOICE\nInvoice Number: 10042\nAmount Due: $2,400.00\n';
    const r = extractDeterministically({ text, kind: 'invoice' });
    assert.equal(r.fields['invoiceAmount']?.value, 240000);
    assert.equal(r.fields['invoiceNumber']?.value, '10042');
    assert.deepEqual(r.missing, []);
  });

  it('reads a bill of lading', () => {
    const text = 'STRAIGHT BILL OF LADING\nB/L Number: 55231\nTotal Weight: 42,000\nPallets: 24\n';
    const r = extractDeterministically({ text, kind: 'bol' });
    assert.equal(r.fields['bolNumber']?.value, '55231');
    assert.equal(r.fields['weightLbs']?.value, 42000);
    assert.equal(r.fields['pieceCount']?.value, 24);
  });

  it('reads a scale ticket', () => {
    const r = extractDeterministically({
      text: 'SCALE TICKET\nCertified Weight: 78,400\n',
      kind: 'scale_ticket',
    });
    assert.equal(r.fields['weightLbs']?.value, 78400);
  });

  it('reads a lumper receipt', () => {
    const r = extractDeterministically({
      text: 'LUMPER RECEIPT\nLumper Fee: $150.00\n',
      kind: 'lumper_receipt',
    });
    assert.equal(r.fields['lumperAmount']?.value, 15000);
  });
});
