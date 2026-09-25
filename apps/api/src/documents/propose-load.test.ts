/**
 * The pure part of proposing a load: folding what the free rules read into what a
 * model read. The rest of `propose-load.ts` needs a database and is covered end
 * to end in `routes/load-proposals.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExtractedField, LoadReading } from '@haulq/contracts';
import { mergeRuleFields } from './propose-load.ts';

const field = (value: string | number, raw: string): ExtractedField => ({ value, raw, label: 'rule' });

const reading = (): LoadReading => ({
  load: {
    brokerName: 'Prairie Logistics LLC',
    rateAmount: 250_000,
    weightLbs: 30_000,
    equipment: 'REEFER',
    stops: [{ type: 'pickup', city: 'Wichita', state: 'KS' }],
  },
  evidence: { rate: '$2,500.00', 'broker.name': 'Prairie Logistics LLC' },
  notes: ['a note'],
});

describe('mergeRuleFields', () => {
  it('lets a value read off a label win over the model’s estimate, and keeps its evidence', () => {
    const merged = mergeRuleFields(reading(), {
      rateAmount: field(240_000, '$2,400.00'),
      brokerLoadNumber: field('84213', '84213'),
      weightLbs: field(42_000, '42,000'),
      equipment: field('53 Dry Van', '53 Dry Van'),
    });

    assert.equal(merged.load.rateAmount, 240_000);
    assert.equal(merged.evidence['rate'], '$2,400.00');
    assert.equal(merged.load.brokerLoadNumber, '84213');
    assert.equal(merged.load.weightLbs, 42_000);
    assert.equal(merged.load.equipment, 'DRY_VAN');
    // Everything the rules did not read is the model's, untouched.
    assert.equal(merged.load.brokerName, 'Prairie Logistics LLC');
    assert.equal(merged.load.stops.length, 1);
    assert.deepEqual(merged.notes, ['a note']);
  });

  it('keeps the model’s value where the rules found nothing, or found something unusable', () => {
    const merged = mergeRuleFields(reading(), {
      rateAmount: field(-5, '-$0.05'),
      weightLbs: field(900_000, '900,000'),
      equipment: field('Hotshot', 'Hotshot'),
    });

    assert.equal(merged.load.rateAmount, 250_000, 'a negative rate is not a rate');
    assert.equal(merged.load.weightLbs, 30_000, 'a weight over what a truck can carry is not one');
    assert.equal(merged.load.equipment, 'REEFER', 'an equipment nobody recognises does not replace one');
  });

  it('changes nothing when there is no rule reading', () => {
    const before = reading();
    assert.deepEqual(mergeRuleFields(before, null), before);
  });

  it('does not alter the reading it was given', () => {
    const original = reading();
    mergeRuleFields(original, { rateAmount: field(240_000, '$2,400.00') });
    assert.equal(original.load.rateAmount, 250_000);
  });
});
