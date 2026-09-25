import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appointmentNotes,
  createBodyFromForm,
  equipmentLabel,
  evidenceFor,
  formatCents,
  formFromProposal,
  formProblems,
  gapSentence,
  proposalLane,
  blankStop,
  type ProposalForm,
  type ProposedLoad,
} from './proposals.ts';

const load = (over: Partial<ProposedLoad> = {}): ProposedLoad => ({
  brokerName: 'Prairie Logistics LLC',
  brokerLoadNumber: '84213',
  rateAmount: 240_000,
  weightLbs: 42_000,
  equipment: 'DRY_VAN',
  commodity: 'Packaged food',
  stops: [
    { type: 'pickup', facilityName: 'Prairie Foods', addressLine1: '1200 Industrial Blvd', city: 'Wichita', state: 'KS', postalCode: '67202', appointmentText: '09/28/2026 08:00-12:00' },
    {
      type: 'delivery',
      city: 'Denver',
      state: 'CO',
      appointmentText: '09/30/2026 0800-1200',
      windowStart: '2026-09-30T14:00:00.000Z',
      windowEnd: '2026-09-30T18:00:00.000Z',
    },
  ],
  ...over,
});

const filled = (over: Partial<ProposalForm> = {}): ProposalForm => ({ ...formFromProposal({ load: load() }), ...over });

describe('the form a reviewer starts from', () => {
  it('is what the reader found, with the rate as dollars a person can edit', () => {
    const form = formFromProposal({ load: load() });

    assert.equal(form.brokerName, 'Prairie Logistics LLC');
    assert.equal(form.brokerLoadNumber, '84213');
    assert.equal(form.equipment, 'DRY_VAN');
    assert.equal(form.rate, '2400.00');
    assert.equal(form.weightLbs, '42000');
    assert.equal(form.stops.length, 2);
    assert.equal(form.stops[0]!.city, 'Wichita');
    assert.equal(form.stops[1]!.windowStart, '2026-09-30T14:00:00.000Z');
  });

  it('leaves blank what was not read, and never fills in equipment', () => {
    const form = formFromProposal({ load: { stops: [] } });
    assert.equal(form.equipment, '');
    assert.equal(form.rate, '');
    assert.equal(form.brokerName, '');
    assert.deepEqual(form.stops, []);
  });

  it('keeps the appointments that did not become windows, in the load’s comments', () => {
    const form = formFromProposal({ load: load() });
    assert.match(form.comments, /not set as windows/);
    assert.match(form.comments, /Pickup, Wichita, KS: 09\/28\/2026 08:00-12:00/);
    assert.doesNotMatch(form.comments, /Denver/, 'the delivery became a window, so it is not repeated');
    assert.equal(appointmentNotes([{ type: 'pickup', city: 'A', state: 'KS' }]), '');
  });

  it('gives each stop its own key, so removing one does not disturb another', () => {
    const form = formFromProposal({ load: load() });
    assert.notEqual(form.stops[0]!.key, form.stops[1]!.key);
    assert.notEqual(blankStop('pickup').key, blankStop('pickup').key);
  });
});

describe('what stops a form being a load', () => {
  it('passes a form that has a pickup, a delivery and its equipment', () => {
    assert.deepEqual(formProblems(filled()), []);
  });

  it('needs a pickup and a delivery', () => {
    const noDelivery = filled({ stops: [blankStopWith('pickup')] });
    assert.ok(formProblems(noDelivery).includes('Add a delivery.'));
    assert.ok(formProblems(filled({ stops: [] })).includes('Add a pickup.'));
  });

  it('needs a city and a two-letter state on every stop, and says which stop', () => {
    const bad = filled({ stops: [{ ...blankStopWith('pickup'), city: '', state: 'Kansas' }, blankStopWith('delivery')] });
    const problems = formProblems(bad);
    assert.ok(problems.includes('Pickup 1 needs a city.'));
    assert.ok(problems.includes('Pickup 1 needs a two-letter state.'));
    assert.ok(!problems.some((p) => /Delivery 2/.test(p)));
  });

  it('asks for equipment rather than defaulting it', () => {
    const problems = formProblems(filled({ equipment: '' }));
    assert.ok(problems.some((p) => /Choose the equipment/.test(p)));
  });

  it('refuses a rate or weight that is not one, but not a blank one', () => {
    assert.ok(formProblems(filled({ rate: 'a lot' })).some((p) => /rate/.test(p)));
    assert.ok(formProblems(filled({ weightLbs: '900000' })).some((p) => /weight/.test(p)));
    assert.ok(formProblems(filled({ weightLbs: '12.5' })).some((p) => /weight/.test(p)));
    assert.deepEqual(formProblems(filled({ rate: '', weightLbs: '' })), [], 'a missing rate is a warning on the screen, not a blocker');
  });
});

describe('the request that makes the load', () => {
  it('sends what the form says, in cents, without the source or status, which are the server’s', () => {
    const body = createBodyFromForm(filled({ rate: '2,400.00', weightLbs: '42,000' })) as Record<string, any>;

    assert.equal(body['brokerName'], 'Prairie Logistics LLC');
    assert.equal(body['equipment'], 'DRY_VAN');
    assert.deepEqual(body['rate'], { amount: 240_000, currency: 'USD' });
    assert.equal(body['weightLbs'], 42_000);
    assert.equal(body['source'], undefined);
    assert.equal(body['status'], undefined);
    assert.equal(body['stops'].length, 2);
    assert.deepEqual(Object.keys(body['stops'][0]).sort(), ['addressLine1', 'city', 'facilityName', 'postalCode', 'state', 'type']);
    assert.equal(body['stops'][1].windowStart, '2026-09-30T14:00:00.000Z', 'a window the reader was certain of is carried through');
    assert.equal(body['stops'][0].windowStart, undefined);
  });

  it('is the person’s edit, not the reader’s: changed fields win, blanks are left out', () => {
    const base = filled();
    const body = createBodyFromForm({ ...base, brokerName: '  ', rate: '', commodity: '', stops: [{ ...base.stops[0]!, city: ' Salina ', state: 'ks' }, base.stops[1]!] }) as Record<string, any>;

    assert.equal(body['brokerName'], undefined);
    assert.equal(body['rate'], undefined);
    assert.equal(body['commodity'], undefined);
    assert.equal(body['stops'][0].city, 'Salina');
    assert.equal(body['stops'][0].state, 'KS');
  });

  it('carries a confirmed duplicate, and only then', () => {
    assert.equal((createBodyFromForm(filled()) as Record<string, unknown>)['confirmDuplicate'], undefined);
    assert.equal((createBodyFromForm(filled(), { confirmDuplicate: true }) as Record<string, unknown>)['confirmDuplicate'], true);
  });
});

describe('showing one', () => {
  it('names the lane, from the first pickup to the last delivery', () => {
    assert.equal(proposalLane(load()), 'Wichita, KS to Denver, CO');
    assert.equal(proposalLane({ stops: [{ type: 'pickup', city: 'Wichita', state: 'KS' }] }), null);
  });

  it('formats money and equipment, and finds the text a field came from', () => {
    assert.equal(formatCents(240_000), '$2,400.00');
    assert.equal(equipmentLabel('REEFER'), 'Reefer');
    assert.equal(equipmentLabel(undefined), null);
    assert.equal(evidenceFor({ evidence: { rate: '$2,400.00' } }, 'rate'), '$2,400.00');
    assert.equal(evidenceFor({ evidence: {} }, 'rate'), null);
  });

  it('says what could not be found, as one sentence', () => {
    assert.equal(gapSentence([]), null);
    assert.equal(gapSentence(['rate']), 'Could not find the rate.');
    assert.equal(gapSentence(['pickup', 'delivery', 'equipment']), 'Could not find a pickup, a delivery and the equipment.');
  });
});

function blankStopWith(type: 'pickup' | 'delivery') {
  return { ...blankStop(type), city: 'Wichita', state: 'KS' };
}
