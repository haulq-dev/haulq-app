/**
 * The validation verdict.
 *
 * Worth its own suite because this is the rule the product is sold on, it is
 * pure, and every part of it is a judgement call that a future change could
 * quietly reverse: which severity blocks a packet, what a carrier reads when
 * something is wrong, and what happens when nothing is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DOCUMENT_KINDS,
  documentKindLabel,
  summarizeValidation,
  type ValidationFinding,
} from './documents.ts';

const agree = (field: string): ValidationFinding => ({
  field,
  documentValue: '1',
  loadValue: '1',
  agrees: true,
  severity: 'info',
});

const differ = (
  field: string,
  severity: ValidationFinding['severity'],
  documentValue: string | null = 'a',
  loadValue: string | null = 'b',
): ValidationFinding => ({ field, documentValue, loadValue, agrees: false, severity });

describe('summarizeValidation', () => {
  it('validates when there is nothing to compare', () => {
    const v = summarizeValidation([]);
    assert.equal(v.outcome, 'validated');
    assert.deepEqual(v.disagreements, []);
    assert.equal(v.reason, null);
  });

  it('validates when everything agrees', () => {
    const v = summarizeValidation([agree('rateAmount'), agree('weightLbs')]);
    assert.equal(v.outcome, 'validated');
    assert.equal(v.disagreements.length, 0);
    assert.equal(v.reason, null);
  });

  it('does not reject on a warning alone', () => {
    const v = summarizeValidation([differ('pickupCity', 'warning')]);
    assert.equal(v.outcome, 'validated');
    // Still surfaced. Not rejecting is not the same as not reporting.
    assert.equal(v.disagreements.length, 1);
    assert.equal(v.reason, null);
  });

  it('rejects on a single error', () => {
    const v = summarizeValidation([
      differ('rateAmount', 'error', '$2,400.00', '$2,600.00'),
    ]);
    assert.equal(v.outcome, 'rejected');
    assert.equal(
      v.reason,
      'rateAmount is $2,400.00 on the document but $2,600.00 on the load.',
    );
  });

  it('names both fields when two disagree', () => {
    const v = summarizeValidation([
      differ('rateAmount', 'error', '$2,400.00', '$2,600.00'),
      differ('weightLbs', 'error', '42,000', '38,000'),
    ]);
    assert.equal(
      v.reason,
      'rateAmount is $2,400.00 on the document but $2,600.00 on the load, ' +
        'and weightLbs is 42,000 on the document but 38,000 on the load.',
    );
  });

  it('counts the rest rather than listing them', () => {
    const v = summarizeValidation([
      differ('a', 'error'),
      differ('b', 'error'),
      differ('c', 'error'),
      differ('d', 'error'),
    ]);
    assert.match(v.reason ?? '', /and 2 other fields also disagree\.$/);
  });

  it('says "1 other field", not "1 other fields"', () => {
    const v = summarizeValidation([
      differ('a', 'error'),
      differ('b', 'error'),
      differ('c', 'error'),
    ]);
    assert.match(v.reason ?? '', /and 1 other field also disagree\.$/);
  });

  it('reads "missing" rather than "null" when a side has no value', () => {
    const v = summarizeValidation([differ('pod', 'error', null, '$2,400.00')]);
    assert.equal(
      v.reason,
      'pod is missing on the document but $2,400.00 on the load.',
    );
  });

  it('orders disagreements worst first', () => {
    const v = summarizeValidation([
      differ('c', 'info'),
      differ('a', 'error'),
      differ('b', 'warning'),
    ]);
    assert.deepEqual(
      v.disagreements.map((f) => f.field),
      ['a', 'b', 'c'],
    );
  });

  it('leaves agreeing fields out of the disagreement list', () => {
    const v = summarizeValidation([agree('x'), differ('y', 'warning'), agree('z')]);
    assert.deepEqual(
      v.disagreements.map((f) => f.field),
      ['y'],
    );
  });

  it('always has a reason when it rejects, and never when it does not', () => {
    // The rejected-has-reason check constraint is unsatisfiable otherwise, and
    // a null reason would fail the insert rather than this assertion.
    for (const severity of ['error', 'warning', 'info'] as const) {
      const v = summarizeValidation([differ('f', severity)]);
      assert.equal(
        v.reason !== null,
        v.outcome === 'rejected',
        `reason/outcome disagree for ${severity}`,
      );
    }
  });
});

describe('document kinds', () => {
  it('has no duplicates', () => {
    assert.equal(new Set(DOCUMENT_KINDS).size, DOCUMENT_KINDS.length);
  });

  it('keeps "other" available as the classifier fallback', () => {
    assert.ok(DOCUMENT_KINDS.includes('other'));
  });

  it('reads a kind as words, not as an identifier', () => {
    assert.equal(documentKindLabel('rate_confirmation'), 'rate confirmation');
    assert.equal(documentKindLabel('insurance_certificate'), 'insurance certificate');
  });
});
