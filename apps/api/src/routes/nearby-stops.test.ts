/**
 * The nearby-stops route, end to end.
 *
 * Same shape as `feasibility.test.ts` and `geocode.test.ts`: a real HERE
 * account is not something this repo has for tests, so a fake
 * `PlacesProvider` is injected through `buildServer`'s `placesProvider`
 * option — the same seam `routingProvider` and `geocoder` use. What this
 * proves is the wiring: a missing provider 503s, results come back per
 * stop, a stop with no coordinates yet gets an empty list rather than
 * failing the request, a driver cannot call it, and Routes' Fleet-plan
 * gate (`billing/entitlements.ts`) applies here the same as it does to
 * `feasibility.ts` — every org below is put on the Fleet plan via
 * `setTestOrgPlan` before it hits the route, and one test proves a Core
 * org is refused.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  addTestMembership,
  closeDatabase,
  createDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  setTestOrgPlan,
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { NearbyPlace, PlacesProvider } from '../integrations/here-places.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const ORIGIN = { lat: 39.0997, lng: -94.5786 }; // Kansas City
const DEST = { lat: 38.6270, lng: -90.1994 }; // St. Louis

const TRUCK_STOP: NearbyPlace = {
  name: 'Pilot Travel Center',
  category: 'truckStop',
  categoryLabel: 'Truck Stop / Plaza',
  lat: 39.1,
  lng: -94.6,
  distanceMiles: 4.2,
  address: null,
};

class FakePlacesProvider implements PlacesProvider {
  private readonly places: NearbyPlace[];
  public calls: Array<{ lat: number; lng: number; radiusMeters: number }> = [];

  constructor(places: NearbyPlace[] = [TRUCK_STOP]) {
    this.places = places;
  }

  async nearbyStops(lat: number, lng: number, radiusMeters: number): Promise<NearbyPlace[]> {
    this.calls.push({ lat, lng, radiusMeters });
    return this.places;
  }
}

async function newApp(placesProvider: PlacesProvider | undefined): Promise<FastifyInstance> {
  // Every test here controls the places provider explicitly, so none of
  // them should depend on whether a real HERE_API_KEY happens to sit in
  // the developer's own .env — same reasoning `feasibility.test.ts`'s
  // `newApp` already uses.
  const { HERE_API_KEY: _hereApiKey, ...envWithoutHereKey } = process.env;
  return buildServer(
    loadEnv({ ...envWithoutHereKey, NODE_ENV: 'test', DATABASE_URL: url! }),
    { placesProvider },
  );
}

/** Fleet by default — Routes is Fleet-only, and every test here except the
 * one proving that gate needs an org that clears it. */
async function newOrg(
  app: FastifyInstance,
  db: Database,
  userId: string,
  name: string,
  plan: 'carrier' | 'fleet' = 'fleet',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  const orgId = res.json().org.id as string;
  await setTestOrgPlan(db, { orgId, plan });
  return orgId;
}

async function aLoad(
  app: FastifyInstance,
  orgId: string,
  userId: string,
  stops: Array<Record<string, unknown>>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    payload: { stops },
  });
  return res.json().id as string;
}

suite('nearby-stops route', () => {
  let db: Database;
  let userId: string;
  const createdOrgs: string[] = [];

  before(async () => {
    db = createDatabase({ url: url! });
    userId = (await createTestUser(db)).id;
  });

  after(async () => {
    for (const id of createdOrgs) await destroyTestOrg(db, id);
    await destroyTestUser(db, userId);
    await closeDatabase(db);
  });

  it('answers 503 when no places provider is configured', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops Not Configured Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO', lat: DEST.lat, lng: DEST.lng },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/loads/${loadId}/nearby-stops`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'not_configured');
    } finally {
      await app.close();
    }
  });

  it('returns places per stop, closest-first as the provider gave them, with the radius converted to meters', async () => {
    const provider = new FakePlacesProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO', lat: DEST.lat, lng: DEST.lng },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/loads/${loadId}/nearby-stops?radiusMiles=5`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.stops.length, 2);
      assert.equal(body.stops[0].city, 'Kansas City');
      assert.deepEqual(body.stops[0].places, [TRUCK_STOP]);
      assert.equal(body.stops[1].city, 'St. Louis');

      assert.equal(provider.calls.length, 2);
      assert.ok(Math.abs(provider.calls[0]!.radiusMeters - 8_046.72) < 1); // 5 mi
      assert.equal(provider.calls[0]!.lat, ORIGIN.lat);
    } finally {
      await app.close();
    }
  });

  it('returns an empty list for a stop with no coordinates yet, rather than failing the whole request', async () => {
    const provider = new FakePlacesProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops No Coordinates Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO' },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/loads/${loadId}/nearby-stops`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.stops[0].places, [TRUCK_STOP]);
      assert.deepEqual(body.stops[1].places, []);
      assert.equal(provider.calls.length, 1); // never called for the ungeocoded stop
    } finally {
      await app.close();
    }
  });

  it('refuses a driver — nearby-stop lookup is a dispatch action', async () => {
    const app = await newApp(new FakePlacesProvider());
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops Role Carrier');
      createdOrgs.push(orgId);
      const driver = await createTestUser(db);
      await addTestMembership(db, { orgId, userId: driver.id, role: 'driver' });
      const loadId = await aLoad(app, orgId, userId, [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO', lat: DEST.lat, lng: DEST.lng },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/loads/${loadId}/nearby-stops`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driver.id },
      });
      assert.equal(res.statusCode, 403);

      await destroyTestUser(db, driver.id);
    } finally {
      await app.close();
    }
  });

  it('answers 403 for a Core-plan org — Routes needs Fleet', async () => {
    const provider = new FakePlacesProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops Core Plan Carrier', 'carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO', lat: DEST.lat, lng: DEST.lng },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/loads/${loadId}/nearby-stops`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().code, 'not_entitled');
      assert.equal(provider.calls.length, 0); // refused before ever reaching HERE
    } finally {
      await app.close();
    }
  });

  it('answers 404 for a load that does not exist', async () => {
    const app = await newApp(new FakePlacesProvider());
    try {
      const orgId = await newOrg(app, db, userId, 'Nearby Stops Missing Load Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/loads/00000000-0000-0000-0000-000000000000/nearby-stops',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
