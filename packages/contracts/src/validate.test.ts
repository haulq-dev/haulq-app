/**
 * Comparing a document to its load.
 *
 * The suite is organised around what each disagreement costs, because that is
 * what severity encodes and it is the part a future change is most likely to get
 * quietly wrong:
 *
 *  - a rate that disagrees stops a packet
 *  - a broker load number that disagrees means the document is on the wrong load
 *  - a weight inside scale tolerance is not a disagreement at all
 *  - one side having a value the other lacks is information, never a blocker
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeValidation } from './documents.ts';
import type { ExtractedField } from './extract.ts';
import { validateAgainstLoad, type LoadFacts } from './validate.ts';

const money = (value: number, raw: string): ExtractedField => ({ value, raw, label: 'Rate' });
const count = (value: number, raw: string): ExtractedField => ({ value, raw, label: 'Weight' });
const ref = (value: string): ExtractedField => ({ value, raw: value, label: 'Load Number' });

const LOAD: LoadFacts = {
  rateAmount: 240000,
  rateCurrency: 'USD',
  rateIsLinehaul: false,
  brokerLoadNumber: '84213',
  weightLbs: 42000,
  equipment: 'DRY_VAN',
};

const find = (findings: ReturnType<typeof validateAgainstLoad>, name: string) =>
  findings.find((f) => f.field === name);

describe('validateAgainstLoad — agreement', () => {
  it('agrees with a document that matches its load', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {
        rateAmount: money(240000, '$2,400.00'),
        brokerLoadNumber: ref('84213'),
        weightLbs: count(42000, '42,000'),
      },
      load: LOAD,
    });

    assert.ok(findings.every((f) => f.agrees), JSON.stringify(findings, null, 1));
    assert.equal(summarizeValidation(findings).outcome, 'validated');
  });

  it('ignores punctuation differences in a reference number', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { brokerLoadNumber: ref('84-213') },
      load: LOAD,
    });
    assert.equal(find(findings, 'brokerLoadNumber')?.agrees, true);
  });

  it('accepts a weight inside scale tolerance', () => {
    // 42,380 against 42,000 is the shipper's estimate against a certified
    // scale. Two honest numbers, not a discrepancy.
    const findings = validateAgainstLoad({
      kind: 'bol',
      extracted: { weightLbs: count(42380, '42,380') },
      load: LOAD,
    });
    assert.equal(find(findings, 'weightLbs')?.agrees, true);
    assert.equal(summarizeValidation(findings).outcome, 'validated');
  });

  it('reads equipment written a different way as the same trailer', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { equipment: { value: 'Dry Van', raw: 'Dry Van', label: 'Equipment' } },
      load: LOAD,
    });
    assert.equal(find(findings, 'equipment')?.agrees, true);
  });
});

describe('validateAgainstLoad — what stops a packet', () => {
  it('rejects on a rate that disagrees', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { rateAmount: money(260000, '$2,600.00') },
      load: LOAD,
    });

    const rate = find(findings, 'rate')!;
    assert.equal(rate.agrees, false);
    assert.equal(rate.severity, 'error');
    assert.equal(rate.documentValue, '$2,600.00');
    assert.equal(rate.loadValue, '$2,400.00');
    assert.equal(summarizeValidation(findings).outcome, 'rejected');
  });

  it('rejects when the broker load number says this is another load', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { brokerLoadNumber: ref('99999') },
      load: LOAD,
    });

    const found = find(findings, 'brokerLoadNumber')!;
    assert.equal(found.severity, 'error');
    assert.match(found.note ?? '', /different load/);
    assert.equal(summarizeValidation(findings).outcome, 'rejected');
  });

  it('compares an invoice total against the load rate too', () => {
    const findings = validateAgainstLoad({
      kind: 'invoice',
      extracted: { invoiceAmount: money(250000, '$2,500.00') },
      load: LOAD,
    });
    assert.equal(find(findings, 'rate')?.agrees, false);
    assert.equal(summarizeValidation(findings).outcome, 'rejected');
  });
});

describe('validateAgainstLoad — what does not stop a packet', () => {
  it('warns rather than rejects on a weight outside tolerance', () => {
    const findings = validateAgainstLoad({
      kind: 'bol',
      extracted: { weightLbs: count(48000, '48,000') },
      load: LOAD,
    });

    const weight = find(findings, 'weightLbs')!;
    assert.equal(weight.agrees, false);
    assert.equal(weight.severity, 'warning');
    assert.match(weight.note ?? '', /6,000 lb apart/);
    assert.equal(
      summarizeValidation(findings).outcome,
      'validated',
      'an overweight load is a conversation, not an unpayable invoice',
    );
  });

  it('warns on the wrong trailer type', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { equipment: { value: 'Reefer', raw: 'Reefer', label: 'Equipment' } },
      load: LOAD,
    });
    assert.equal(find(findings, 'equipment')?.severity, 'warning');
    assert.equal(summarizeValidation(findings).outcome, 'validated');
  });
});

describe('validateAgainstLoad — one side only', () => {
  const thin: LoadFacts = {
    rateAmount: null,
    rateCurrency: null,
    rateIsLinehaul: false,
    brokerLoadNumber: null,
    weightLbs: null,
    equipment: null,
  };

  it('reports the document filling in a thin load, and never blocks on it', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {
        rateAmount: money(240000, '$2,400.00'),
        brokerLoadNumber: ref('84213'),
        weightLbs: count(42000, '42,000'),
      },
      load: thin,
    });

    assert.ok(findings.every((f) => f.severity === 'info'), JSON.stringify(findings));
    assert.equal(summarizeValidation(findings).outcome, 'validated');
    assert.match(find(findings, 'rate')?.note ?? '', /load has nothing recorded/i);
  });

  it('reports a load carrying a rate the document does not mention', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
    });
    const rate = find(findings, 'rate')!;
    assert.equal(rate.documentValue, null);
    assert.equal(rate.loadValue, '$2,400.00');
    assert.equal(rate.severity, 'info');
  });
});

describe('validateAgainstLoad — linehaul', () => {
  const linehaulLoad: LoadFacts = { ...LOAD, rateAmount: 215000, rateIsLinehaul: true };

  it('compares a linehaul-only load against the document linehaul, not the total', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {
        rateAmount: money(240000, '$2,400.00'),
        linehaulAmount: money(215000, '$2,150.00'),
      },
      load: linehaulLoad,
    });

    const rate = find(findings, 'rate')!;
    assert.equal(
      rate.agrees,
      true,
      'comparing the all-in total to a linehaul rate makes every fuel surcharge a disagreement',
    );
    assert.equal(rate.documentValue, '$2,150.00');
  });

  it('falls back to the total when the document has no linehaul line', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { rateAmount: money(215000, '$2,150.00') },
      load: linehaulLoad,
    });
    assert.equal(find(findings, 'rate')?.agrees, true);
  });
});

describe('validateAgainstLoad — sender domain', () => {
  it('agrees when the current sender matches a domain seen before for this broker', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'dispatch@realbroker.com',
      priorSenders: ['ops@realbroker.com'],
    });
    const finding = find(findings, 'senderDomain')!;
    assert.equal(finding.agrees, true);
    assert.equal(finding.documentValue, 'realbroker.com');
  });

  it('warns, but does not reject, when the sender is a domain never seen before for this broker', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'someone@totally-different.com',
      priorSenders: ['ops@realbroker.com'],
    });
    const finding = find(findings, 'senderDomain')!;
    assert.equal(finding.agrees, false);
    assert.equal(finding.severity, 'warning');
    assert.match(finding.note ?? '', /realbroker\.com/);
    assert.equal(
      summarizeValidation(findings).outcome,
      'validated',
      'a domain mismatch is a signal, not proof — it must never reject a document on its own',
    );
  });

  it('says nothing on a broker\'s first-ever email-sourced document — no baseline yet', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'dispatch@realbroker.com',
      priorSenders: [],
    });
    assert.equal(find(findings, 'senderDomain'), undefined);
  });

  it('says nothing for a document that did not arrive by email', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: null,
      priorSenders: ['ops@realbroker.com'],
    });
    assert.equal(find(findings, 'senderDomain'), undefined);
  });

  it('matches case-insensitively', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'Dispatch@RealBroker.COM',
      priorSenders: ['ops@realbroker.com'],
    });
    assert.equal(find(findings, 'senderDomain')?.agrees, true);
  });

  it('does not throw on a malformed address, and says nothing about it', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'not-an-email',
      priorSenders: ['ops@realbroker.com'],
    });
    assert.equal(find(findings, 'senderDomain'), undefined);
  });

  it('lists every domain a broker has used when there is more than one', () => {
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: {},
      load: LOAD,
      receivedFrom: 'someone@a-third-domain.com',
      priorSenders: ['ops@realbroker.com', 'billing@realbroker-billing.com'],
    });
    const finding = find(findings, 'senderDomain')!;
    assert.match(finding.loadValue ?? '', /realbroker\.com/);
    assert.match(finding.loadValue ?? '', /realbroker-billing\.com/);
  });
});

describe('validateAgainstLoad — robustness', () => {
  it('finds nothing to say about an unread document', () => {
    assert.deepEqual(validateAgainstLoad({ kind: 'pod', extracted: null, load: LOAD }), []);
  });

  it('validates a POD, which has nothing to contradict', () => {
    const findings = validateAgainstLoad({ kind: 'pod', extracted: {}, load: LOAD });
    assert.equal(summarizeValidation(findings).outcome, 'validated');
  });

  it('ignores extracted values that are not the shape it expects', () => {
    // A document extracted by an older version, or a hand-edited row.
    const findings = validateAgainstLoad({
      kind: 'rate_confirmation',
      extracted: { rateAmount: 240000, brokerLoadNumber: null, weightLbs: 'heavy' },
      load: LOAD,
    });
    // Falls through to "the load has a rate the document does not mention".
    assert.equal(find(findings, 'rate')?.documentValue, null);
    assert.equal(find(findings, 'weightLbs'), undefined);
    assert.equal(summarizeValidation(findings).outcome, 'validated');
  });
});
