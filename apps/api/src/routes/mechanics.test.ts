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
import { YelpApiError, type Mechanic, type MechanicSearchProvider } from '../integrations/yelp.ts';
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
  public calls: Array<{ lat: number; lng: number; radiusMeters: number; query: string; categories: string | undefined }> = [];
  /** Set to make the next searches fail, as Yelp does when its budget is spent. */
  public failWith: Error | undefined;

  constructor(mechanics: Mechanic[] = [MECHANIC]) {
    this.mechanics = mechanics;
  }

  async nearbyMechanics(lat: number, lng: number, radiusMeters: number, query: string, categories?: string): Promise<Mechanic[]> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ lat, lng, radiusMeters, query, categories });
    return this.mechanics;
  }
}

async function newApp(
  mechanicSearchProvider: MechanicSearchProvider | undefined,
  extraEnv: Record<string, string> = {},
): Promise<FastifyInstance> {
  // Every test here controls the provider explicitly, so none of them
  // should depend on whether a real YELP_API_KEY happens to sit in the
  // developer's own .env — same reasoning `nearby-stops.test.ts`'s
  // `newApp` already uses for HERE_API_KEY.
  const { YELP_API_KEY: _yelpApiKey, ...envWithoutYelpKey } = process.env;
  return buildServer(
    loadEnv({ ...envWithoutYelpKey, ...extraEnv, NODE_ENV: 'test', DATABASE_URL: url! }),
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

  it('passes the categories through, and refuses ones that are not category names', async () => {
    const provider = new FakeMechanicSearchProvider();
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Categories Carrier');
      createdOrgs.push(orgId);
      const headers = { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId };
      const base = `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`;

      const ok = await app.inject({ method: 'GET', url: `${base}&query=towing&categories=towing,roadsideassist`, headers });
      const bad = await app.inject({ method: 'GET', url: `${base}&categories=towing%26limit%3D50`, headers });
      const none = await app.inject({ method: 'GET', url: base, headers });

      assert.equal(ok.statusCode, 200);
      assert.equal(provider.calls[0]!.categories, 'towing,roadsideassist');
      assert.equal(bad.statusCode, 400, 'nothing else can ride along in the query string');
      assert.equal(none.statusCode, 200);
      assert.equal(provider.calls[1]!.categories, undefined);
    } finally {
      await app.close();
    }
  });

  it('caps each carrier\'s searches per day, so one carrier cannot spend the whole Yelp budget', async () => {
    const provider = new FakeMechanicSearchProvider();
    const app = await newApp(provider, { YELP_ORG_DAILY_LIMIT: '2' });
    try {
      const busy = await newOrg(app, userId, 'Mechanics Busy Carrier');
      const quiet = await newOrg(app, userId, 'Mechanics Quiet Carrier');
      createdOrgs.push(busy, quiet);
      const search = (orgId: string) =>
        app.inject({
          method: 'GET',
          url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`,
          headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        });

      assert.equal((await search(busy)).statusCode, 200);
      assert.equal((await search(busy)).statusCode, 200);
      const third = await search(busy);
      assert.equal(third.statusCode, 429);
      assert.equal(third.json().code, 'org_search_limit_reached');
      assert.match(third.json().explanation, /2 repair-shop searches for today/);
      assert.equal(provider.calls.length, 2, 'the refused one never reached Yelp');

      assert.equal((await search(quiet)).statusCode, 200, "another carrier's day is its own");
    } finally {
      await app.close();
    }
  });

  it('says so plainly when Yelp itself has run out of its daily budget', async () => {
    const provider = new FakeMechanicSearchProvider();
    provider.failWith = new YelpApiError(429, 'Yelp 429: ACCESS_LIMIT_REACHED');
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Mechanics Yelp Limit Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/mechanics/nearby?lat=${WICHITA.lat}&lng=${WICHITA.lng}`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });

      assert.equal(res.statusCode, 429);
      assert.equal(res.json().code, 'search_limit_reached');
      assert.match(res.json().explanation, /daily limit/);
    } finally {
      await app.close();
    }
  });
});
