/**
 * Contract schemas.
 *
 * These are the shapes the API and the web app agree on, so a change here is a
 * change to both. Tests exist mainly to pin the decisions that are easy to
 * undo by accident — integer money, and the truck fields that gate freight.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CreateTruckSchema, MoneySchema, PageQuerySchema, UpdateCarrierProfileSchema } from './index.ts';

describe('MoneySchema', () => {
  it('accepts integer minor units', () => {
    const parsed = MoneySchema.parse({ amount: 240000, currency: 'USD' });
    assert.equal(parsed.amount, 240000);
  });

  it('defaults currency rather than guessing later', () => {
    // An amount with no currency is an amount nobody can interpret. Defaulting
    // here means it never reaches the database ambiguous — where a check
    // constraint would reject it anyway.
    assert.equal(MoneySchema.parse({ amount: 100 }).currency, 'USD');
  });

  it('refuses a fractional amount', () => {
    // Build plan section 5: never floats near an invoice. $24.005 is not a
    // number of cents, and silently rounding it is how a penny goes missing
    // from a settlement.
    assert.throws(() => MoneySchema.parse({ amount: 2400.5, currency: 'USD' }));
  });
});

describe('UpdateCarrierProfileSchema — customDocsEmail', () => {
  it('lower-cases and trims it, same as every other stored address', () => {
    const parsed = UpdateCarrierProfileSchema.parse({
      customDocsEmail: '  Docs@ACME-Trucking.com  ',
    });
    assert.equal(parsed.customDocsEmail, 'docs@acme-trucking.com');
  });

  it('refuses something that is not an email', () => {
    assert.throws(() => UpdateCarrierProfileSchema.parse({ customDocsEmail: 'not an address' }));
  });

  it('accepts null to clear it', () => {
    const parsed = UpdateCarrierProfileSchema.parse({ customDocsEmail: null });
    assert.equal(parsed.customDocsEmail, null);
  });

  it('is optional — a request that never mentions it changes nothing', () => {
    const parsed = UpdateCarrierProfileSchema.parse({ legalName: 'Acme Trucking' });
    assert.equal('customDocsEmail' in parsed, false);
  });
});

describe('CreateTruckSchema', () => {
  it('defaults to a straight box truck', () => {
    // The equipment the pilot carrier actually runs. Defaulting saves the most
    // common case from being typed every time.
    const t = CreateTruckSchema.parse({ label: 'Unit 12' });
    assert.equal(t.equipment, 'STRAIGHT_BOX');
    assert.equal(t.shortHaulExempt, false);
    assert.deepEqual(t.capabilities, {});
  });

  it('keeps capability flags the caller sets', () => {
    const t = CreateTruckSchema.parse({
      label: 'Unit 12',
      capabilities: { liftgate: true, dockHigh: false },
    });
    assert.equal(t.capabilities.liftgate, true);
    assert.equal(t.capabilities.dockHigh, false);
  });

  it('rejects a weight no straight truck could carry', () => {
    // Catches a typo, not a judgement about the carrier's equipment. 80,000 lb
    // is the federal gross limit for a tractor-trailer, so anything above it is
    // a mistake regardless of what is being driven.
    assert.throws(() => CreateTruckSchema.parse({ label: 'X', maxWeightLbs: 800000 }));
  });

  it('requires a label', () => {
    assert.throws(() => CreateTruckSchema.parse({ label: '' }));
  });
});

describe('PageQuerySchema', () => {
  it('caps the page size', () => {
    assert.throws(() => PageQuerySchema.parse({ limit: 5000 }));
  });

  it('defaults to a page a phone can render', () => {
    assert.equal(PageQuerySchema.parse({}).limit, 25);
  });
});
