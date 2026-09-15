/**
 * The nearby-mechanics route, end to end.
 *
 * Same shape as `nearby-stops.test.ts`: a real Yelp account is not
 * something this repo has for tests, so a fake `MechanicSearchProvider` is
 * injected through `buildServer`'s `mechanicSearchProvider` option — the
 * same seam `placesProvider` uses. What this proves is the wiring: a
 * missing provider 503s, results come back, and — unlike `nearby-stops.ts`
 * — a driver can call this, since it carries no role gate at all.
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
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type { Mechanic, MechanicSearchProvider } from '../integrations/yelp.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const WICHITA = { lat: 37.6889, lng: -97.3365 };

const MECHANIC: Mechanic = {
  name: 'Prairie Diesel Repair',
  rating: 4.5,
  reviewCount: 87,
  address: '123 Industrial Rd, Wichita, KS 67202',
  phone: '(316) 555-0100',
  distanceMiles: 2.1,
  yelpUrl: 'https://www.yelp.com/biz/prairie-diesel-repair',
};

class FakeMechanicSearchProvider implements MechanicSearchProvider {
  private readonly mechanics: Mechanic[];
  public calls: Array<{ lat: number; lng: number; radiusMeters: number; query: string }> = [];

  constructor(mechanics: Mechanic[] = [MECHANIC]) {
    this.mechanics = mechanics;
  }

  async nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string): Promise<Mechanic[]> {
    this.calls.push({ lat, lng, radiusMeters, query });
    return this.mechanics;
  }
}

async function newApp(mechanicSearchProvider: MechanicSearchProvider | undefined): Promise<FastifyInstance> {
  // Every test here controls the provider explicitly, so none of them
  // should depend on whether a real YELP_API_KEY happens to sit in the
  // developer's own .env — same reasoning `nearby-stops.test.ts`'s
  // `newApp` already uses for HERE_API_KEY.
  const { YELP_API_KEY: _yelpApiKey, ...envWithoutYelpKey } = process.env;
  return buildServer(
    loadEnv({ ...envWithoutYelpKey, NODE_ENV: 'test', DATABASE_URL: url! }),
    { mechanicSearchProvider },
  );
}

async function newOrg(app: FastifyInstance, userId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/orgs',
    headers: { 'x-haulq-user-id': userId },
    payload: { name, contactEmail: 'owner@example.com' },
  });
  return res.json().org.id as string;
}

suite('nearby-mechanics route', () => {
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

  it('answers 503 when no mechanic search provider is configured', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Not Configured Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'not_configured');
    } finally {
      await app.close();
    }
  });

  it('returns mechanics for a coordinate, defaulting the query and radius', async () => {
    const provider = new FakeMechanicSearchProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().mechanics, [MECHANIC]);

      assert.equal(provider.calls.length, 1);
      assert.equal(provider.calls[0]!.lat, WICHITA.lat);
      assert.equal(provider.calls[0]!.query, 'diesel truck repair');
      assert.ok(Math.abs(provider.calls[0]!.radiusMeters - 24_140.16) < 1); // 15 mi default
    } finally {
      await app.close();
    }
  });

  it('passes a caller-supplied query and radius through', async () => {
    const provider = new FakeMechanicSearchProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Custom Query Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}&radiusMiles=5&query=tire+shop`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(provider.calls[0]!.query, 'tire shop');
      assert.ok(Math.abs(provider.calls[0]!.radiusMeters - 8_046.72) < 1); // 5 mi
    } finally {
      await app.close();
    }
  });

  it('lets a driver call it — no role gate, unlike Track and Routes', async () => {
    const app = await newApp(new FakeMechanicSearchProvider());
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Driver Carrier');
      createdOrgs.push(orgId);
      const driver = await createTestUser(db);
      await addTestMembership(db, { orgId, userId: driver.id, role: 'driver' });

      const res = await app.inject({
        method: 'GET',
        url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driver.id },
      });
      assert.equal(res.statusCode, 200);

      await destroyTestUser(db, driver.id);
    } finally {
      await app.close();
    }
  });

  it('refuses a request with no coordinates', async () => {
    const app = await newApp(new FakeMechanicSearchProvider());
    try {
      const orgId = await newOrg(app, userId, 'Mechanics No Coordinates Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/mechanics/nearby',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});
