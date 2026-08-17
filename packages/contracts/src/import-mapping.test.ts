/**
 * Header guessing, row coercion and broker matching.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  brokerMatchKey,
  coerceRow,
  guessMapping,
  rowHasErrors,
  type ColumnMapping,
} from './import-mapping.ts';

const mappingFrom = (headers: string[]): ColumnMapping =>
  Object.fromEntries(guessMapping(headers).map((g) => [g.header, g.field]));

describe('header guessing', () => {
  it('recognises the usual names', () => {
    const m = mappingFrom([
      'Load #',
      'Broker',
      'Pickup City',
      'Pickup State',
      'Delivery City',
      'Delivery State',
      'Delivery Date',
      'Rate',
      'Miles',
    ]);
    assert.equal(m['Broker'], 'brokerName');
    assert.equal(m['Pickup City'], 'originCity');
    assert.equal(m['Delivery State'], 'destState');
    assert.equal(m['Delivery Date'], 'deliveryDate');
    assert.equal(m['Rate'], 'rate');
    assert.equal(m['Miles'], 'loadedMiles');
  });

  it('is insensitive to punctuation and casing', () => {
    const m = mappingFrom(['PICKUP_CITY', 'pick-up state', 'Dead Head Miles']);
    assert.equal(m['PICKUP_CITY'], 'originCity');
    assert.equal(m['pick-up state'], 'originState');
    assert.equal(m['Dead Head Miles'], 'deadheadMiles');
  });

  it('lets the more specific header win a contested field', () => {
    // Both could be loadedMiles. If both claimed it, one would silently lose
    // and which one would depend on column order.
    const m = mappingFrom(['Miles', 'Loaded Miles']);
    const claimants = Object.values(m).filter((f) => f === 'loadedMiles');
    assert.equal(claimants.length, 1);
  });

  it('leaves unrecognised columns unmapped rather than guessing', () => {
    const m = mappingFrom(['Dispatcher Initials', 'Random Column']);
    assert.equal(m['Dispatcher Initials'], null);
    assert.equal(m['Random Column'], null);
  });

  it('is less confident about a bare "Date"', () => {
    // It could be pickup, delivery or invoice date. Low confidence tells the
    // UI to draw attention to it rather than presenting it as settled.
    const guess = guessMapping(['Date']).find((g) => g.header === 'Date')!;
    assert.ok(guess.confidence < 0.5);
  });
});

describe('row coercion', () => {
  const mapping: ColumnMapping = {
    'Load #': 'reference',
    Broker: 'brokerName',
    Origin: 'origin',
    Destination: 'destination',
    'Delivery Date': 'deliveryDate',
    Rate: 'rate',
    Miles: 'loadedMiles',
  };

  const row = (over: Record<string, string> = {}) =>
    coerceRow(
      {
        'Load #': '1001',
        Broker: 'Acme Logistics',
        Origin: 'Wichita, KS',
        Destination: 'Denver, CO',
        'Delivery Date': '5/3/2026',
        Rate: '$2,400.00',
        Miles: '520',
        ...over,
      },
      mapping,
    );

  it('reads a clean row with no issues', () => {
    const { parsed, issues } = row();
    assert.equal(parsed.reference, 1001);
    assert.equal(parsed.brokerName, 'Acme Logistics');
    assert.equal(parsed.originCity, 'Wichita');
    assert.equal(parsed.originState, 'KS');
    assert.equal(parsed.rateAmount, 240_000);
    assert.deepEqual(issues, []);
  });

  it('makes an unreadable rate an error, not a silent zero', () => {
    const { parsed, issues } = row({ Rate: 'see invoice' });
    assert.equal(parsed.rateAmount, undefined);
    assert.ok(rowHasErrors(issues));
  });

  it('makes an unreadable delivery date an error', () => {
    // It anchors every margin-by-period figure the import exists to produce.
    const { issues } = row({ 'Delivery Date': 'ASAP' });
    assert.ok(rowHasErrors(issues));
  });

  it('makes an unreadable weight only a warning', () => {
    // Nothing in Phase 0 divides by it.
    const { issues } = coerceRow(
      { Weight: 'heavy', Origin: 'Wichita, KS', 'Delivery Date': '5/3/2026' },
      { Weight: 'weightLbs', Origin: 'origin', 'Delivery Date': 'deliveryDate' },
    );
    assert.equal(rowHasErrors(issues), false);
    assert.ok(issues.some((i) => i.severity === 'warning'));
  });

  it('rejects a row with no location at all', () => {
    const { issues } = row({ Origin: '', Destination: '' });
    assert.ok(issues.some((i) => i.severity === 'error' && /at least one location/.test(i.message)));
  });

  it('catches a delivery before its pickup', () => {
    const { issues } = coerceRow(
      { P: '5/10/2026', D: '5/3/2026', O: 'Wichita, KS', R: '100' },
      { P: 'pickupDate', D: 'deliveryDate', O: 'origin', R: 'rate' },
    );
    assert.ok(issues.some((i) => /day\/month swap/.test(i.message)));
  });

  it('rejects a negative rate rather than importing it as a load', () => {
    const { issues } = row({ Rate: '(500.00)' });
    assert.ok(issues.some((i) => i.severity === 'error' && /credit or adjustment/.test(i.message)));
  });

  it('warns when the rate per mile is implausible', () => {
    // Every field parsed cleanly; the combination is what is wrong. Usually a
    // decimal in the wrong place.
    const { issues } = row({ Rate: '$24,000.00', Miles: '520' });
    assert.ok(issues.some((i) => /far above market/.test(i.message)));
    assert.equal(rowHasErrors(issues), false, 'unusual is not impossible');
  });

  it('warns when no broker is named', () => {
    const { issues } = row({ Broker: '' });
    assert.ok(issues.some((i) => /broker profitability/.test(i.message)));
    assert.equal(rowHasErrors(issues), false);
  });
});

describe('broker matching', () => {
  it('collapses cosmetic differences', () => {
    const key = brokerMatchKey('Acme Logistics');
    assert.equal(brokerMatchKey('ACME LOGISTICS, INC.'), key);
    assert.equal(brokerMatchKey('Acme  Logistics LLC'), key);
    assert.equal(brokerMatchKey('Acme Logistics Co'), key);
  });

  it('keeps genuinely different brokers apart', () => {
    assert.notEqual(brokerMatchKey('Acme Logistics'), brokerMatchKey('Apex Logistics'));
  });

  it('does not produce an empty key for a name that is all suffixes', () => {
    // "Logistics Company" would otherwise match every other such broker.
    const key = brokerMatchKey('Logistics Company');
    assert.ok(key.length > 0);
    assert.notEqual(key, brokerMatchKey('Transport Group'));
  });
});
