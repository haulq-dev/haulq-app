/**
 * The geocode route, end to end.
 *
 * Same shape as `feasibility.test.ts`: a real HERE account is not something
 * this repo has for tests, so a fake `Geocoder` is injected through
 * `buildServer`'s `geocoder` option — the same seam `routingProvider` uses.
 * What this proves is the wiring: a missing geocoder 503s, a non-owner
 * cannot look anything up, and a query without at least a city and state is
 * refused before it ever reaches HERE.
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
import type { Geocoder, GeocodeCandidate } from '../integrations/here-geocode.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const CANDIDATE: GeocodeCandidate = {
  label: '123 Main St, Wichita, KS 67202, United States',
  lat: 37.6889,
  lng: -97.3365,
  score: 0.95,
};

class FakeGeocoder implements Geocoder {
  private readonly candidates: GeocodeCandidate[];

  constructor(candidates: GeocodeCandidate[] = [CANDIDATE]) {
    this.candidates = candidates;
  }

  async geocode(_query: string): Promise<GeocodeCandidate[]> {
    return this.candidates;
  }
}

async function newApp(geocoder: Geocoder | undefined): Promise<FastifyInstance> {
  // Same reasoning as `feasibility.test.ts`'s `newApp` — every test here
  // controls the geocoder explicitly, so none of them should depend on
  // whether a real HERE_API_KEY happens to sit in the developer's own .env.
  const { HERE_API_KEY: _hereApiKey, ...envWithoutHereKey } = process.env;
  return buildServer(
    loadEnv({ ...envWithoutHereKey, NODE_ENV: 'test', DATABASE_URL: url! }),
    { geocoder },
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

suite('geocode route', () => {
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

  it('answers 503 when no geocoder is configured', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app, userId, 'Geocode Not Configured Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/geocode?city=Wichita&state=KS',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'not_configured');
    } finally {
      await app.close();
    }
  });

  it('returns candidates for a valid query', async () => {
    const app = await newApp(new FakeGeocoder());
    try {
      const orgId = await newOrg(app, userId, 'Geocode Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/geocode?addressLine1=123+Main+St&city=Wichita&state=KS&postalCode=67202',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().candidates, [CANDIDATE]);
    } finally {
      await app.close();
    }
  });

  it('refuses a query with no city or state', async () => {
    const app = await newApp(new FakeGeocoder());
    try {
      const orgId = await newOrg(app, userId, 'Geocode No City Carrier');
      createdOrgs.push(orgId);

      const res = await app.inject({
        method: 'GET',
        url: '/v1/geocode?addressLine1=123+Main+St',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().code, 'invalid_request');
    } finally {
      await app.close();
    }
  });

  it('refuses a driver — address lookup is a dispatch action', async () => {
    const app = await newApp(new FakeGeocoder());
    try {
      const orgId = await newOrg(app, userId, 'Geocode Role Carrier');
      createdOrgs.push(orgId);
      const driver = await createTestUser(db);
      await addTestMembership(db, { orgId, userId: driver.id, role: 'driver' });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/geocode?city=Wichita&state=KS',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': driver.id },
      });
      assert.equal(res.statusCode, 403);

      await destroyTestUser(db, driver.id);
    } finally {
      await app.close();
    }
  });
});
