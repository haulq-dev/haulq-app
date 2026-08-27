/**
 * The 3a feasibility route, end to end.
 *
 * A real `RoutingProvider` is a HERE account this repo does not have yet —
 * see `integrations/here.ts`'s module note — so this suite injects a fake
 * one through `buildServer`'s `routingProvider` option, the same seam
 * `documents.test.ts` already uses for `reader`/`modelReader`. What this
 * proves is the wiring: a missing provider 503s, a HERE restriction and a
 * blown stop window each come back as the named `decidingConstraint`
 * PHASE_3_PLAN.md section 4's exit gate requires, and a clean route comes
 * back feasible with `hoursChecked: false`.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  closeDatabase,
  createDatabase,
  createTestUser,
  destroyTestOrg,
  destroyTestUser,
  type Database,
} from '@haulq/db';
import type { FastifyInstance } from 'fastify';
import type {
  Restriction,
  Route,
  RoutingProvider,
  RoutingStop,
  TruckProfile,
} from '../integrations/routing-provider.ts';
import { loadEnv } from '../env.ts';
import { buildServer } from '../server.ts';

const url = process.env['DATABASE_URL'];
const suite = url ? describe : describe.skip;

const ORIGIN = { lat: 39.0997, lng: -94.5786 }; // Kansas City
const DEST = { lat: 38.6270, lng: -90.1994 }; // St. Louis

class FakeRoutingProvider implements RoutingProvider {
  private readonly routeResult: Route;
  private readonly restrictions: Restriction[];

  constructor(route: Route, restrictions: Restriction[] = []) {
    this.routeResult = route;
    this.restrictions = restrictions;
  }

  async route(_stops: RoutingStop[], _truck: TruckProfile): Promise<Route> {
    return this.routeResult;
  }
  async feasibility(_route: Route, _truck: TruckProfile): Promise<Restriction[]> {
    return this.restrictions;
  }
  async matrix(): Promise<never> {
    throw new Error('not used by 3a');
  }
}

function aFeasibleRoute(arrivalAt: Date): Route {
  return { miles: 250, durationSeconds: 5 * 3600, arrivalAt, raw: null };
}

async function newApp(routingProvider: RoutingProvider | undefined): Promise<FastifyInstance> {
  return buildServer(loadEnv({ ...process.env, NODE_ENV: 'test', DATABASE_URL: url! }), { routingProvider });
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

async function aLoad(
  app: FastifyInstance,
  orgId: string,
  userId: string,
  windowEnd: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/loads',
    headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    payload: {
      stops: [
        { type: 'pickup', city: 'Kansas City', state: 'MO', lat: ORIGIN.lat, lng: ORIGIN.lng },
        { type: 'delivery', city: 'St. Louis', state: 'MO', lat: DEST.lat, lng: DEST.lng, windowEnd },
      ],
    },
  });
  return res.json().id as string;
}

async function aTruck(app: FastifyInstance, orgId: string, userId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/trucks',
    headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
    payload: { label: 'Unit 1', maxWeightLbs: 26_000, maxLengthFt: 26 },
  });
  return res.json().id as string;
}

suite('feasibility route', () => {
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

  it('answers 503 when no routing provider is configured', async () => {
    const app = await newApp(undefined);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility Not Configured Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, '2026-09-01T18:00:00Z');
      const truckId = await aTruck(app, orgId, userId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { truckId },
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().code, 'not_configured');
    } finally {
      await app.close();
    }
  });

  it('is feasible when the route has no restrictions and lands inside the window', async () => {
    const provider = new FakeRoutingProvider(aFeasibleRoute(new Date('2026-09-01T15:00:00Z')));
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility Clean Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, '2026-09-01T18:00:00Z');
      const truckId = await aTruck(app, orgId, userId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { truckId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.feasible, true);
      assert.equal(body.hoursChecked, false);
      assert.equal(body.decidingConstraint, null);
    } finally {
      await app.close();
    }
  });

  it('is infeasible and names a HERE restriction before checking the window', async () => {
    const provider = new FakeRoutingProvider(aFeasibleRoute(new Date('2026-09-01T15:00:00Z')), [
      { code: 'violatedVehicleRestriction', description: 'Route uses a road restricted for this vehicle' },
    ]);
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility Restricted Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, '2026-09-01T18:00:00Z');
      const truckId = await aTruck(app, orgId, userId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { truckId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.feasible, false);
      assert.equal(body.decidingConstraint.code, 'violatedVehicleRestriction');
    } finally {
      await app.close();
    }
  });

  it('is infeasible and names the stop window when arrival misses it', async () => {
    const provider = new FakeRoutingProvider(aFeasibleRoute(new Date('2026-09-01T19:00:00Z')));
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility Late Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, '2026-09-01T18:00:00Z');
      const truckId = await aTruck(app, orgId, userId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { truckId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.feasible, false);
      assert.equal(body.decidingConstraint.code, 'stop_window_overrun');
    } finally {
      await app.close();
    }
  });

  it('answers 422 when a stop has no coordinates yet, rather than guessing', async () => {
    const provider = new FakeRoutingProvider(aFeasibleRoute(new Date()));
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility No Coordinates Carrier');
      createdOrgs.push(orgId);
      const truckId = await aTruck(app, orgId, userId);
      const loadRes = await app.inject({
        method: 'POST',
        url: '/v1/loads',
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: {
          stops: [
            { type: 'pickup', city: 'Kansas City', state: 'MO' },
            { type: 'delivery', city: 'St. Louis', state: 'MO' },
          ],
        },
      });
      const loadId = loadRes.json().id as string;

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: { truckId },
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().code, 'missing_coordinates');
    } finally {
      await app.close();
    }
  });

  it('answers 409 when the load has no truck and none was passed', async () => {
    const provider = new FakeRoutingProvider(aFeasibleRoute(new Date()));
    const app = await newApp(provider);
    try {
      const orgId = await newOrg(app, userId, 'Feasibility No Truck Carrier');
      createdOrgs.push(orgId);
      const loadId = await aLoad(app, orgId, userId, '2026-09-01T18:00:00Z');

      const res = await app.inject({
        method: 'POST',
        url: `/v1/loads/${loadId}/feasibility`,
        headers: { 'x-haulq-org-id': orgId, 'x-haulq-user-id': userId },
        payload: {},
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().code, 'no_truck');
    } finally {
      await app.close();
    }
  });
});
