/**
 * The trucks repository's Motive-vehicle matching, against a real database.
 *
 * Scoped to what this session actually added — `createTruck`/`getTruck`/
 * `listTrucks` are already exercised indirectly through `track.test.ts` and
 * elsewhere. This covers the new surface: setting and clearing a match, the
 * event it records, the one-vehicle-one-truck constraint, and what
 * `integrations/motive-sync.ts` actually reads back. Skips without
 * DATABASE_URL, same as the rest of the package.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDatabase, createDatabase, type Database } from '../client.ts';
import type { Scope } from '../context.ts';
import { readTimeline } from '../events/record.ts';
import { createTestOrg, createTestUser, destroyTestOrg, destroyTestUser, testScope } from '../testing.ts';
import { createTruck, setTruckMotiveVehicleId, trucksByMotiveVehicleId, TruckError } from './trucks.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

let db: Database;
let orgId: string;
let otherOrgId: string;
let s: Scope;
let other: Scope;
let userId: string;

suite('trucks repository — Motive matching', () => {
  before(async () => {
    db = createDatabase({ url: url! });
    const org = await createTestOrg(db, 'Trucks Test Carrier');
    orgId = org.id;
    const second = await createTestOrg(db, 'Other Carrier');
    otherOrgId = second.id;
    const user = await createTestUser(db);
    userId = user.id;
    s = testScope(db, orgId, { type: 'user', id: userId });
    other = testScope(db, otherOrgId, { type: 'user', id: userId });
  });

  after(async () => {
    await destroyTestOrg(db, orgId);
    await destroyTestOrg(db, otherOrgId);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  it('sets a match and records the event', async () => {
    const truck = await createTruck(s, { label: `Truck ${crypto.randomUUID().slice(0, 8)}` });
    const updated = await setTruckMotiveVehicleId(s, truck.id, 998707);
    assert.equal(updated.motiveVehicleId, 998707);

    const events = await readTimeline(s, { subjectId: truck.id });
    const matched = events.find((e) => e.verb === 'truck.motive_vehicle_matched');
    assert.ok(matched);
    assert.match(matched.explanation, /Matched .* to Motive vehicle 998707/);
  });

  it('clears a match with null', async () => {
    const truck = await createTruck(s, { label: `Truck ${crypto.randomUUID().slice(0, 8)}` });
    await setTruckMotiveVehicleId(s, truck.id, 12345);
    const cleared = await setTruckMotiveVehicleId(s, truck.id, null);
    assert.equal(cleared.motiveVehicleId, null);
  });

  it('refuses a second truck claiming the same Motive vehicle', async () => {
    const vehicleId = 555000 + Math.floor(Math.random() * 1000);
    const first = await createTruck(s, { label: `Truck ${crypto.randomUUID().slice(0, 8)}` });
    const second = await createTruck(s, { label: `Truck ${crypto.randomUUID().slice(0, 8)}` });
    await setTruckMotiveVehicleId(s, first.id, vehicleId);

    await assert.rejects(
      () => setTruckMotiveVehicleId(s, second.id, vehicleId),
      (e: TruckError) => e.code === 'already_matched',
    );
  });

  it('refuses a truck from another org', async () => {
    const truck = await createTruck(s, { label: `Truck ${crypto.randomUUID().slice(0, 8)}` });
    await assert.rejects(
      () => setTruckMotiveVehicleId(other, truck.id, 1),
      (e: TruckError) => e.code === 'not_found',
    );
  });

  it('refuses an unknown truck', async () => {
    await assert.rejects(
      () => setTruckMotiveVehicleId(s, '00000000-0000-0000-0000-000000000000', 1),
      (e: TruckError) => e.code === 'not_found',
    );
  });

  it('trucksByMotiveVehicleId maps only matched trucks, scoped to the org', async () => {
    const matched = await createTruck(s, { label: `Matched ${crypto.randomUUID().slice(0, 8)}` });
    const unmatched = await createTruck(s, { label: `Unmatched ${crypto.randomUUID().slice(0, 8)}` });
    const vehicleId = 777000 + Math.floor(Math.random() * 1000);
    await setTruckMotiveVehicleId(s, matched.id, vehicleId);

    const map = await trucksByMotiveVehicleId(db, orgId);
    assert.equal(map.get(vehicleId), matched.id);
    assert.ok(![...map.values()].includes(unmatched.id));

    const otherOrgMap = await trucksByMotiveVehicleId(db, otherOrgId);
    assert.equal(otherOrgMap.get(vehicleId), undefined);
  });
});
