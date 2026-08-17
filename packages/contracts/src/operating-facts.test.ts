/**
 * Operating facts validation.
 *
 * These bounds decide whether a carrier's margin figures mean anything, and
 * they fail quietly in both directions: too strict and an owner with an unusual
 * operation cannot save his real numbers, too loose and a typo propagates into
 * every score for months.
 *
 * The tests are grouped by that asymmetry — what must block, and what must not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasErrors,
  isCompleteForScoring,
  missingForScoring,
  validateOperatingFacts,
  type OperatingFacts,
} from './operating-facts.ts';

const issuesFor = (f: OperatingFacts, field: string) =>
  validateOperatingFacts(f).filter((i) => i.field === field);

describe('what must block', () => {
  it('rejects a zero cost per mile', () => {
    const issues = issuesFor({ costPerMileCents: 0 }, 'costPerMileCents');
    assert.equal(issues[0]?.severity, 'error');
    assert.match(issues[0]!.message, /pure profit/);
  });

  it('rejects a cost per mile that is obviously a typo', () => {
    // $47.00/mi — someone typed 4700 meaning $47 total, or slipped a decimal.
    const issues = issuesFor({ costPerMileCents: 4700 }, 'costPerMileCents');
    assert.equal(issues[0]?.severity, 'error');
    assert.match(issues[0]!.message, /typo/);
  });

  it('rejects an mpg no commercial truck achieves', () => {
    const issues = issuesFor({ avgMpg: 45 }, 'avgMpg');
    assert.equal(issues[0]?.severity, 'error');
  });

  it('rejects a cost per mile below fuel alone', () => {
    // The cross-field check. $4.00/gal at 8 mpg is $0.50/mi in fuel, so a
    // stated total of $0.40 is not unusual — it is arithmetically impossible.
    const issues = issuesFor(
      { costPerMileCents: 40, fuelPricePerGallonCents: 400, avgMpg: 8 },
      'costPerMileCents',
    );
    const error = issues.find((i) => i.severity === 'error');
    assert.ok(error, 'expected an error');
    assert.match(error!.message, /fuel alone is \$0\.50\/mi/);
  });

  it('reports every problem at once, not just the first', () => {
    // A carrier filling in six fields should see six problems, not discover
    // them one save at a time.
    const issues = validateOperatingFacts({
      costPerMileCents: 0,
      fuelPricePerGallonCents: 0,
      avgMpg: 99,
    });
    assert.ok(issues.filter((i) => i.severity === 'error').length >= 3);
  });
});

describe('what must not block', () => {
  it('accepts an unusual but real cost per mile with a warning', () => {
    const issues = issuesFor({ costPerMileCents: 50 }, 'costPerMileCents');
    assert.equal(issues[0]?.severity, 'warning');
    assert.equal(hasErrors(issues), false, 'a warning must not block saving');
  });

  it('accepts zero driver pay without complaint', () => {
    // An owner-operator who drives himself is paid by the margin. Flagging this
    // as missing would push him to enter a number that double-counts.
    const issues = validateOperatingFacts({
      costPerMileCents: 150,
      driverPayPerMileCents: 0,
    });
    assert.equal(issues.filter((i) => i.field === 'driverPayPerMileCents').length, 0);
  });

  it('warns about zero fixed cost rather than rejecting it', () => {
    // A paid-off truck on an owner's own insurance is unusual, not impossible.
    const issues = issuesFor({ fixedWeeklyCostCents: 0 }, 'fixedWeeklyCostCents');
    assert.equal(issues[0]?.severity, 'warning');
    assert.match(issues[0]!.message, /lose the week/);
  });

  it('accepts an empty object', () => {
    // The first save happens before the carrier knows any of these.
    assert.deepEqual(validateOperatingFacts({}), []);
  });

  it('passes a realistic straight-truck operation clean', () => {
    const issues = validateOperatingFacts({
      costPerMileCents: 135,
      fixedWeeklyCostCents: 85_000,
      fuelPricePerGallonCents: 420,
      avgMpg: 9,
      driverPayPerMileCents: 0,
      targetMarginPercent: 20,
    });
    assert.deepEqual(issues, [], `unexpected: ${JSON.stringify(issues)}`);
  });
});

describe('warnings that catch optimism', () => {
  it('flags a cost per mile that leaves almost nothing after fuel', () => {
    // $4.20/gal at 9 mpg is $0.47/mi in fuel. $0.55 total leaves 17% for
    // maintenance, tyres and tolls — not impossible, but rarely true.
    //
    // Asserts across all warnings on the field rather than the first, because
    // one field can legitimately raise two: this value also trips the
    // "under $0.60/mi" band. Both are true and both are worth showing.
    const warnings = issuesFor(
      { costPerMileCents: 55, fuelPricePerGallonCents: 420, avgMpg: 9 },
      'costPerMileCents',
    ).filter((i) => i.severity === 'warning');

    assert.ok(
      warnings.some((w) => /optimistic/.test(w.message)),
      `expected an "optimistic" warning, got: ${warnings.map((w) => w.message).join(' | ')}`,
    );
  });

  it('flags a target margin that would hide every load', () => {
    const issues = issuesFor({ targetMarginPercent: 70 }, 'targetMarginPercent');
    assert.equal(issues[0]?.severity, 'warning');
    assert.match(issues[0]!.message, /filter out almost every load/);
  });
});

describe('completeness for scoring', () => {
  it('needs cost per mile and fixed weekly cost', () => {
    assert.equal(isCompleteForScoring({ costPerMileCents: 150 }), false);
    assert.equal(
      isCompleteForScoring({ costPerMileCents: 150, fixedWeeklyCostCents: 80_000 }),
      true,
    );
  });

  it('does not require driver pay or target margin', () => {
    // Both have safe fallbacks; neither makes the arithmetic wrong when absent.
    assert.equal(
      isCompleteForScoring({ costPerMileCents: 150, fixedWeeklyCostCents: 0 }),
      true,
    );
  });

  it('names what is still missing', () => {
    assert.deepEqual(missingForScoring({ costPerMileCents: 150 }), [
      'fixedWeeklyCostCents',
    ]);
  });
});
