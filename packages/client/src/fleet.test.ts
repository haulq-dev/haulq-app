import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capabilityLabels,
  credentialDateToIso,
  credentialState,
  driverBody,
  driverCredentialTone,
  EMPTY_DRIVER_FORM,
  EMPTY_TRUCK_FORM,
  isoToCredentialDate,
  parseWholeNumber,
  truckBody,
  unmatchedMotiveVehicles,
} from './fleet.ts';
import { invitableRoles, invitationExpiry, invitationLink, memberControls } from './members.ts';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

describe('trucks', () => {
  it('reads whole numbers as typed, and names the field that is not one', () => {
    assert.equal(parseWholeNumber('26,000'), 26_000);
    assert.equal(parseWholeNumber(' '), null);
    assert.equal(parseWholeNumber('12.5'), undefined);
    assert.equal(parseWholeNumber('0'), undefined);

    assert.deepEqual(truckBody({ ...EMPTY_TRUCK_FORM, label: 'Unit 12', maxLengthFt: 'twenty' }, 'create'), { invalid: 'Max length' });
    assert.deepEqual(truckBody({ ...EMPTY_TRUCK_FORM, label: '  ' }, 'create'), { invalid: 'Label' });
  });

  it('leaves a blank number out on create, and clears it on update', () => {
    const values = { ...EMPTY_TRUCK_FORM, label: ' Unit 12 ', maxWeightLbs: '10,000' };
    const created = truckBody(values, 'create');
    assert.ok('body' in created);
    assert.equal(created.body['label'], 'Unit 12');
    assert.equal(created.body['maxWeightLbs'], 10_000);
    assert.equal('maxLengthFt' in created.body, false);

    const updated = truckBody(values, 'update');
    assert.ok('body' in updated);
    assert.equal(updated.body['maxLengthFt'], null);
  });

  it('lists capabilities in a stable order', () => {
    assert.deepEqual(capabilityLabels({ dockHigh: true, liftgate: true, twicCard: false }), ['Liftgate', 'Dock high']);
    assert.deepEqual(capabilityLabels(null), []);
  });

  it('offers only Motive vehicles nothing claims yet', () => {
    const vehicles = [
      { id: 1, number: '12', vin: null },
      { id: 2, number: '14', vin: null },
      { id: 3, number: '15', vin: null },
    ];
    const got = unmatchedMotiveVehicles(vehicles, [{ motiveVehicleId: 1 }, { motiveVehicleId: null }], [{ motiveVehicleId: 2 }]);
    assert.deepEqual(got.map((v) => v.id), [3]);
  });
});

describe('driver credentials', () => {
  it('calls an expired credential out of service, not a warning', () => {
    assert.deepEqual(credentialState(inDays(-2), NOW), { tone: 'bad', daysLeft: -2 });
    assert.deepEqual(credentialState(inDays(10), NOW), { tone: 'warn', daysLeft: 10 });
    assert.deepEqual(credentialState(inDays(90), NOW), { tone: 'ok', daysLeft: 90 });
    assert.deepEqual(credentialState(null, NOW), { tone: 'none', daysLeft: null });
  });

  it('rates a driver by the worse of the two dates', () => {
    assert.equal(driverCredentialTone({ cdlExpiresAt: inDays(400), medicalCardExpiresAt: inDays(-1) }, NOW), 'bad');
    assert.equal(driverCredentialTone({ cdlExpiresAt: inDays(20), medicalCardExpiresAt: null }, NOW), 'warn');
    assert.equal(driverCredentialTone({ cdlExpiresAt: null, medicalCardExpiresAt: null }, NOW), 'ok');
  });

  it('round-trips a date input through the API without shifting a day', () => {
    const iso = credentialDateToIso('2027-03-04');
    assert.equal(iso, '2027-03-04T12:00:00.000Z');
    assert.equal(isoToCredentialDate(iso), '2027-03-04');
    assert.equal(credentialDateToIso('03/04/2027'), null);
  });
});

describe('driverBody', () => {
  const form = { ...EMPTY_DRIVER_FORM, fullName: ' Rosa Diaz ', cdlState: 'ks', medicalCardExpiresAt: '2027-01-15' };

  it('leaves blanks out on create', () => {
    const got = driverBody(form, 'create');
    assert.ok('body' in got);
    assert.deepEqual(got.body, {
      fullName: 'Rosa Diaz',
      endorsements: [],
      cdlState: 'KS',
      medicalCardExpiresAt: '2027-01-15T12:00:00.000Z',
    });
  });

  it('clears emptied fields on update, so a wrong phone can actually be removed', () => {
    const got = driverBody(form, 'update');
    assert.ok('body' in got);
    assert.equal(got.body['phone'], null);
    assert.equal(got.body['cdlExpiresAt'], null);
    assert.equal(got.body['defaultTruckId'], null);
  });

  it('catches a state that is not two letters', () => {
    assert.deepEqual(driverBody({ ...form, cdlState: 'Kan' }, 'create'), { invalid: 'State' });
    assert.deepEqual(driverBody({ ...form, fullName: '' }, 'create'), { invalid: 'Full name' });
  });
});

describe('members', () => {
  it('lets only an owner invite an owner, and nobody below dispatcher invite at all', () => {
    assert.deepEqual(invitableRoles('owner'), ['owner', 'dispatcher', 'driver', 'accountant']);
    assert.deepEqual(invitableRoles('dispatcher'), ['dispatcher', 'driver', 'accountant']);
    assert.deepEqual(invitableRoles('accountant'), []);
    assert.deepEqual(invitableRoles('driver'), []);
  });

  it('protects the last owner, and never offers removing yourself', () => {
    const me = { userId: 'me', role: 'owner' };
    assert.deepEqual(memberControls({ userId: 'me', role: 'owner' }, me, 1), { changeRole: false, remove: false, lastOwner: true });
    assert.deepEqual(memberControls({ userId: 'me', role: 'owner' }, me, 2), { changeRole: true, remove: false, lastOwner: false });
    assert.deepEqual(memberControls({ userId: 'x', role: 'driver' }, me, 1), { changeRole: true, remove: true, lastOwner: false });
    assert.deepEqual(memberControls({ userId: 'x', role: 'driver' }, { userId: 'me', role: 'dispatcher' }, 1), { changeRole: false, remove: false, lastOwner: false });
  });

  it('reads an invitation expiry in words', () => {
    assert.deepEqual(invitationExpiry(inDays(-1), NOW), { label: 'Expired', tone: 'bad' });
    assert.deepEqual(invitationExpiry(inDays(1), NOW), { label: '1 day left', tone: 'warn' });
    assert.deepEqual(invitationExpiry(inDays(6), NOW), { label: '6 days left', tone: 'neutral' });
  });

  it('builds the link an invitee opens', () => {
    assert.equal(invitationLink('https://app.haulq.ai/', 'a b'), 'https://app.haulq.ai/invite/a%20b');
  });
});
