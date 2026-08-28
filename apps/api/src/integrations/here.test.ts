/**
 * The HERE client, against a real HTTP server.
 *
 * Same discipline `fmcsa.test.ts` already established for this repo's other
 * hand-rolled REST clients: a stub server on localhost, not a mocked `fetch`,
 * so the request that goes out is real. Unlike `fmcsa.test.ts`, this suite
 * is not protecting a port already proven in production — `here.ts`'s own
 * module note says so — it is pinning what this file assumes the v8 Routing
 * API shape is, so the day the HERE account activates there is exactly one
 * suite to re-run against a real response before trusting it.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Route, TruckProfile } from './routing-provider.ts';
import { HereApiError, hereTruckParams, HereRoutingProvider } from './here.ts';

const TRUCK: TruckProfile = {
  maxWeightLbs: 26_000,
  maxLengthFt: 26,
  boxHeightIn: 136,
  boxWidthIn: 96,
  hazmat: false,
};

describe('hereTruckParams', () => {
  it('converts imperial truck dimensions to the metric units HERE expects', () => {
    const params = hereTruckParams(TRUCK);
    assert.equal(params.get('truck[grossWeight]'), '11793'); // 26,000 lb -> kg
    assert.equal(params.get('truck[height]'), '345'); // 136 in -> cm
    assert.equal(params.get('truck[width]'), '244'); // 96 in -> cm
    assert.equal(params.get('truck[length]'), '792'); // 26 ft -> cm
  });

  it('omits a dimension the truck record does not have, rather than sending 0', () => {
    const params = hereTruckParams({ maxWeightLbs: null, maxLengthFt: null, boxHeightIn: null, boxWidthIn: null, hazmat: false });
    assert.equal(params.has('truck[grossWeight]'), false);
    assert.equal(params.has('truck[height]'), false);
  });

  it('sends every documented hazmat category when the load carries hazmat, since the real class is not recorded', () => {
    const params = hereTruckParams({ ...TRUCK, hazmat: true });
    const sent = params.get('truck[shippedHazardousGoods]')!.split(',');
    // The conservative direction: exclude a road restricted for any class,
    // not a guessed single one. See the constant's own comment in here.ts.
    for (const category of ['explosive', 'radioactive', 'poisonousInhalation', 'other']) {
      assert.ok(sent.includes(category), `expected ${category} in the sent category list`);
    }
    assert.equal(sent.length, 11);
  });

  it('sends nothing when the load carries no hazmat', () => {
    const params = hereTruckParams({ ...TRUCK, hazmat: false });
    assert.equal(params.has('truck[shippedHazardousGoods]'), false);
  });
});

let server: Server;
let base: string;
let script: { status: number; body: unknown };
const requests: string[] = [];

const ROUTE_WITH_NOTICE = {
  routes: [
    {
      sections: [
        {
          summary: { length: 160_934, duration: 7_200 }, // 100 mi, 2h
          notices: [{ code: 'violatedVehicleRestriction', title: 'Route uses a road restricted for this vehicle', severity: 'critical' }],
        },
      ],
    },
  ],
};

const ROUTE_CLEAN = {
  routes: [{ sections: [{ summary: { length: 160_934, duration: 7_200 } }] }],
};

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.statusCode = script.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(script.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  requests.length = 0;
  script = { status: 200, body: ROUTE_CLEAN };
});

describe('HereRoutingProvider.route', () => {
  it('sums section lengths and durations into miles and an arrival time', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    const departAt = new Date('2026-09-01T12:00:00Z');
    const route = await provider.route(
      [{ lat: 39.05, lng: -95.68 }, { lat: 38.63, lng: -90.2 }],
      TRUCK,
      { departAt },
    );

    assert.ok(Math.abs(route.miles - 100) < 0.1);
    assert.equal(route.durationSeconds, 7_200);
    assert.equal(route.arrivalAt.toISOString(), '2026-09-01T14:00:00.000Z');
  });

  it('requests truck mode with origin, destination and the api key', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await provider.route([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], TRUCK, { departAt: new Date() });

    const url = new URL(requests[0]!, base);
    assert.equal(url.searchParams.get('transportMode'), 'truck');
    assert.equal(url.searchParams.get('origin'), '1,2');
    assert.equal(url.searchParams.get('destination'), '3,4');
    assert.equal(url.searchParams.get('apikey'), 'test-key');
  });

  it('sends every intermediate stop as a via, in order', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await provider.route(
      [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }],
      TRUCK,
      { departAt: new Date() },
    );

    const url = new URL(requests[0]!, base);
    assert.deepEqual(url.searchParams.getAll('via'), ['2,2']);
    assert.equal(url.searchParams.get('destination'), '3,3');
  });

  it('refuses fewer than two stops without a request', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await assert.rejects(() => provider.route([{ lat: 1, lng: 1 }], TRUCK, { departAt: new Date() }));
    assert.equal(requests.length, 0);
  });

  it('throws HereApiError on a transport failure', async () => {
    script.status = 503;
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await assert.rejects(
      () => provider.route([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], TRUCK, { departAt: new Date() }),
      (err: unknown) => {
        assert.ok(err instanceof HereApiError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  it('throws HereApiError when HERE returns no route at all', async () => {
    script.body = { routes: [] };
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await assert.rejects(() => provider.route([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], TRUCK, { departAt: new Date() }));
  });
});

describe('HereRoutingProvider.feasibility', () => {
  it('turns every section notice into a named restriction', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    const route: Route = {
      miles: 100,
      durationSeconds: 7_200,
      arrivalAt: new Date(),
      raw: ROUTE_WITH_NOTICE,
    };

    const restrictions = await provider.feasibility(route, TRUCK);
    assert.equal(restrictions.length, 1);
    assert.equal(restrictions[0]!.code, 'violatedVehicleRestriction');
    assert.match(restrictions[0]!.description, /restricted for this vehicle/);
  });

  it('returns no restrictions for a route with no notices', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    const route: Route = { miles: 100, durationSeconds: 7_200, arrivalAt: new Date(), raw: ROUTE_CLEAN };

    assert.deepEqual(await provider.feasibility(route, TRUCK), []);
  });
});

describe('HereRoutingProvider.matrix', () => {
  it('is not implemented yet — 3b work, per PHASE_3_PLAN.md section 7a', async () => {
    const provider = new HereRoutingProvider({ apiKey: 'test-key' }, base);
    await assert.rejects(() => provider.matrix([], [], TRUCK));
  });
});
