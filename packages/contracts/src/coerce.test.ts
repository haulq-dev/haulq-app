/**
 * Coercion.
 *
 * The governing rule, tested throughout: **absent and unparseable are
 * different.** An empty rate cell is a load whose rate was never recorded.
 * A rate cell reading "see email" is a value nobody can interpret. Returning
 * zero for either is the failure this file exists to prevent — a silent zero is
 * invisible in ninety rows and drags measured revenue per mile down until
 * somebody happens to look.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coerceDate,
  coerceInteger,
  coerceMoneyCents,
  coercePlace,
  coerceState,
} from './coerce.ts';

describe('money', () => {
  it('reads the forms carriers actually type', () => {
    assert.equal(coerceMoneyCents('$1,800.00').value, 180_000);
    assert.equal(coerceMoneyCents('1800').value, 180_000);
    assert.equal(coerceMoneyCents('1,800.50').value, 180_050);
    assert.equal(coerceMoneyCents('$2400 USD').value, 240_000);
  });

  it('reads accounting parentheses as negative', () => {
    // Excel's negative format. A naive parser reads this as +250 and turns a
    // credit into revenue.
    assert.equal(coerceMoneyCents('(250.00)').value, -25_000);
    assert.equal(coerceMoneyCents('-250').value, -25_000);
  });

  it('treats an empty cell as absent, not zero', () => {
    for (const blank of ['', '   ', 'N/A', 'n/a', '-', 'none']) {
      const r = coerceMoneyCents(blank);
      assert.equal(r.value, undefined, `"${blank}" should be absent`);
      assert.equal(r.issue, undefined, `"${blank}" should not be an error`);
    }
  });

  it('reports an unreadable value instead of guessing', () => {
    const r = coerceMoneyCents('see email');
    assert.equal(r.value, undefined);
    assert.match(r.issue!, /not an amount/);
  });

  it('rounds at the boundary and only there', () => {
    assert.equal(coerceMoneyCents('1800.005').value, 180_001);
    assert.equal(coerceMoneyCents('0.1').value, 10);
  });
});

describe('integers', () => {
  it('strips thousands separators and unit suffixes', () => {
    assert.equal(coerceInteger('1,234').value, 1234);
    assert.equal(coerceInteger('1234 mi').value, 1234);
    assert.equal(coerceInteger('12,000 lbs').value, 12_000);
  });

  it('enforces bounds with a message naming the field', () => {
    const r = coerceInteger('999999', { label: 'Weight', max: 100_000 });
    assert.match(r.issue!, /beyond what HaulQ will accept/);
  });
});

describe('dates', () => {
  it('reads ISO', () => {
    assert.match(coerceDate('2026-05-01').value!, /^2026-05-01/);
  });

  it('reads US slash dates', () => {
    assert.match(coerceDate('5/1/2026').value!, /^2026-05-01/);
    assert.match(coerceDate('05-01-26').value!, /^2026-05-01/);
  });

  it('uses day-first when the day is unambiguous', () => {
    // A file exported with European settings should not silently produce
    // nonsense. 25 cannot be a month.
    assert.match(coerceDate('25/03/2026').value!, /^2026-03-25/);
  });

  it('reads named months in both orders', () => {
    assert.match(coerceDate('May 1, 2026').value!, /^2026-05-01/);
    assert.match(coerceDate('1 May 2026').value!, /^2026-05-01/);
  });

  it('reads an Excel serial number', () => {
    // A column of five-digit integers where a date belongs is a sheet exported
    // without formatting, not a typo.
    assert.match(coerceDate('46143').value!, /^2026-/);
  });

  it('rejects a date that does not exist', () => {
    // `new Date` rolls this to March 3 without complaint, which is exactly why
    // the constructor is not used.
    const r = coerceDate('2026-02-31');
    assert.equal(r.value, undefined);
    assert.match(r.issue!, /not a real date/);
  });

  it('reports junk rather than returning Invalid Date', () => {
    assert.match(coerceDate('totals').issue!, /not a date/);
    assert.match(coerceDate('ASAP').issue!, /not a date/);
  });

  it('treats an empty cell as absent', () => {
    assert.deepEqual(coerceDate(''), {});
  });
});

describe('states and places', () => {
  it('accepts codes and full names', () => {
    assert.equal(coerceState('KS').value, 'KS');
    assert.equal(coerceState('ks').value, 'KS');
    assert.equal(coerceState('Kansas').value, 'KS');
  });

  it('rejects something that is not a state', () => {
    assert.match(coerceState('XX').issue!, /not a US state/);
  });

  it('splits a combined city and state', () => {
    assert.deepEqual(coercePlace('Wichita, KS').value, {
      city: 'Wichita',
      state: 'KS',
    });
    assert.deepEqual(coercePlace('Wichita KS').value, {
      city: 'Wichita',
      state: 'KS',
    });
  });

  it('ignores a trailing zip', () => {
    assert.deepEqual(coercePlace('Wichita, KS 67202').value, {
      city: 'Wichita',
      state: 'KS',
    });
  });

  it('handles a two-word state', () => {
    assert.deepEqual(coercePlace('Newark, New Jersey').value, {
      city: 'Newark',
      state: 'NJ',
    });
  });

  it('prefers separate city and state columns when present', () => {
    assert.deepEqual(coercePlace(undefined, 'Tulsa', 'Oklahoma').value, {
      city: 'Tulsa',
      state: 'OK',
    });
  });

  it('keeps a city with no readable state', () => {
    // Discarding it would lose the only location on the load. Geocoding is
    // Phase 3's problem.
    assert.deepEqual(coercePlace('Wichita').value, { city: 'Wichita' });
  });
});
