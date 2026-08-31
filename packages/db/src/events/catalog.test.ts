/**
 * The explanation builders.
 *
 * These run with no database, which is the point: the sentences are the product
 * of guardrail 6 and section 8's "explainable control", and they deserve to be
 * checked the way any other output is. A regression here is invisible in
 * production — the log keeps filling up, just with prose nobody can use.
 *
 * Asserting on exact strings rather than substrings is deliberate. It makes
 * changing a sentence a conscious act with a visible diff, which is appropriate
 * for text that gets written to an append-only table and can never be revised
 * after the fact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventCatalog, formatMoney, formatPlace } from './catalog.ts';

describe('formatting', () => {
  it('renders minor units as currency', () => {
    assert.equal(formatMoney(240000), '$2,400.00');
    assert.equal(formatMoney(0), '$0.00');
    assert.equal(formatMoney(-15050), '-$150.50');
  });

  it('does not lose cents', () => {
    // The reason money is stored as integer minor units at all. A float would
    // have produced 1234.5599999999999 somewhere along this path.
    assert.equal(formatMoney(123456), '$1,234.56');
  });

  it('renders a place the way a dispatcher says it', () => {
    assert.equal(formatPlace('Wichita', 'KS'), 'Wichita, KS');
  });
});

describe('event explanations', () => {
  it('describes a booking with the counterparty and the money', () => {
    assert.equal(
      eventCatalog['load.booked'].describe({
        reference: 1042,
        brokerName: 'Acme Logistics',
        rateAmount: 240000,
        rateCurrency: 'USD',
      }),
      'Booked load 1042 with Acme Logistics at $2,400.00.',
    );
  });

  it('warns without blocking when the broker on file is not authorized', () => {
    assert.equal(
      eventCatalog['load.booked_with_authority_warning'].describe({
        reference: 1042,
        brokerName: 'Acme Logistics',
        source: 'FMCSA QCMobile',
      }),
      'Booked load 1042 with Acme Logistics even though FMCSA QCMobile currently shows them as not authorized to operate. Confirm their authority before dispatching.',
    );
  });

  it('says what a capability change does, not just that it happened', () => {
    // "Updated capabilities" would be useless to the carrier wondering why the
    // liftgate loads vanished.
    assert.equal(
      eventCatalog['truck.capabilities_updated'].describe({
        label: 'Unit 12',
        added: ['liftgate'],
        removed: ['dockHigh'],
      }),
      'Updated what Unit 12 can do: added liftgate and removed dockHigh. ' +
        'This changes which loads are matched to it.',
    );
  });

  it('names both numbers when reconciling margin', () => {
    assert.equal(
      eventCatalog['load.reconciled'].describe({
        reference: 1042,
        expectedMarginAmount: 60000,
        actualMarginAmount: 42000,
        currency: 'USD',
      }),
      'Reconciled load 1042: expected $600.00, actually made $420.00 — worse than predicted.',
    );
  });

  it('does not claim a difference when there is none', () => {
    const text = eventCatalog['load.reconciled'].describe({
      reference: 7,
      expectedMarginAmount: 50000,
      actualMarginAmount: 50000,
      currency: 'USD',
    });
    assert.match(text, /exactly as expected/);
  });

  it('describes the Phase 0 exit gate in terms a carrier would use', () => {
    assert.equal(
      eventCatalog['org.operating_facts_reconciled'].describe({
        loadCount: 87,
        periodDays: 90,
      }),
      'Reconciled operating costs against 87 loads over the last 90 days. ' +
        'Scoring now uses measured figures rather than estimates.',
    );
  });

  it('tells the carrier what a failed board credential costs them', () => {
    const text = eventCatalog['board_credential.failed'].describe({
      board: 'Direct Freight',
      error: 'password rejected',
    });
    assert.match(text, /Load search is paused/);
  });
});

describe('catalogue integrity', () => {
  it('gives every verb a subject type and a description', () => {
    for (const [verb, def] of Object.entries(eventCatalog)) {
      assert.ok(def.subjectType, `${verb} has no subjectType`);
      assert.equal(typeof def.describe, 'function', `${verb} has no describe()`);
    }
  });

  it('produces a non-empty sentence for every verb', () => {
    // Guards against a describe() that returns '' for an empty payload, which
    // would violate event_log's not-null explanation at insert time rather than
    // here, in production, inside someone's transaction.
    for (const [verb, def] of Object.entries(eventCatalog)) {
      const text = (def.describe as (p: unknown) => string)({
        reference: 1,
        label: 'X',
        name: 'X',
        email: 'a@b.com',
        role: 'owner',
        equipment: 'STRAIGHT_BOX',
        origin: 'A, KS',
        destination: 'B, MO',
        source: 'manual',
        brokerName: 'B',
        rateAmount: 100,
        rateCurrency: 'USD',
        truckLabel: 'T',
        deliveredAt: '2026-08-14',
        reason: 'r',
        expectedMarginAmount: 1,
        actualMarginAmount: 1,
        currency: 'USD',
        filename: 'f.csv',
        rowCount: 1,
        committed: 1,
        skipped: 0,
        kind: 'bol',
        from: 'x@y.com',
        loadReference: 1,
        board: 'DAT',
        error: 'e',
        changed: ['name'],
        fields: ['name'],
        added: [],
        removed: [],
        loadCount: 1,
        periodDays: 30,
        from_: 'a',
        to: 'b',
      });
      assert.ok(text.length > 0, `${verb} produced an empty explanation`);
    }
  });
});
