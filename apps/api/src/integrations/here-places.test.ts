/**
 * The HERE places client, against a real HTTP server.
 *
 * Same discipline `here-geocode.test.ts` and `here.test.ts` already
 * established: a stub server on localhost, not a mocked `fetch`. Pins what
 * this file assumes the `/browse` response shape is, and proves the
 * category-ID request and distance-sorted, meters-to-miles response
 * mapping this file's own module note documents.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HereApiError } from './here.ts';
import { HerePlacesProvider, NEARBY_STOP_CATEGORIES } from './here-places.ts';

let server: Server;
let base: string;
let script: { status: number; body: unknown };
const requests: string[] = [];

const BROWSE_RESULT = {
  items: [
    {
      title: 'Pilot Travel Center',
      categories: [{ id: NEARBY_STOP_CATEGORIES.truckStop.id }],
      position: { lat: 39.05, lng: -95.68 },
      distance: 16_093, // 10 mi
      address: { label: '123 Highway Dr, Topeka, KS' },
    },
    {
      title: 'KS Weigh Station 12',
      categories: [{ id: NEARBY_STOP_CATEGORIES.weighStation.id }],
      position: { lat: 39.02, lng: -95.7 },
      distance: 4_828.03, // 3 mi — closer, should sort first
    },
  ],
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
  script = { status: 200, body: BROWSE_RESULT };
});

describe('HerePlacesProvider.nearbyStops', () => {
  it('requests a circle around the point with every named category and the api key', async () => {
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    await provider.nearbyStops(39.05, -95.68, 16_093);

    const url = new URL(requests[0]!, base);
    assert.equal(url.searchParams.get('in'), 'circle:39.05,-95.68;r=16093');
    assert.equal(url.searchParams.get('apiKey'), 'test-key');
    const categories = url.searchParams.get('categories')!.split(',');
    assert.ok(categories.includes(NEARBY_STOP_CATEGORIES.truckStop.id));
    assert.ok(categories.includes(NEARBY_STOP_CATEGORIES.weighStation.id));
    assert.ok(categories.includes(NEARBY_STOP_CATEGORIES.restArea.id));
    // EV truck charging needs a separate HERE license add-on — see the
    // constant's own comment in here-places.ts.
    assert.ok(!categories.includes('700-7600-0323'));
  });

  it('maps HERE items to a labeled category, converts distance to miles, and sorts closest first', async () => {
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    const places = await provider.nearbyStops(39.05, -95.68, 16_093);

    assert.equal(places.length, 2);
    assert.equal(places[0]!.name, 'KS Weigh Station 12');
    assert.equal(places[0]!.category, 'weighStation');
    assert.equal(places[0]!.categoryLabel, 'Weigh Station');
    assert.ok(Math.abs(places[0]!.distanceMiles - 3) < 0.01);
    assert.equal(places[0]!.address, null);

    assert.equal(places[1]!.name, 'Pilot Travel Center');
    assert.equal(places[1]!.category, 'truckStop');
    assert.ok(Math.abs(places[1]!.distanceMiles - 10) < 0.01);
    assert.equal(places[1]!.address, '123 Highway Dr, Topeka, KS');
  });

  it('drops an item with no position or no title rather than guessing', async () => {
    script.body = { items: [{ categories: [{ id: NEARBY_STOP_CATEGORIES.truckStop.id }] }] };
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    const places = await provider.nearbyStops(39.05, -95.68, 16_093);
    assert.deepEqual(places, []);
  });

  it('throws HereApiError on a transport failure', async () => {
    script.status = 503;
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    await assert.rejects(
      () => provider.nearbyStops(39.05, -95.68, 16_093),
      (err: unknown) => {
        assert.ok(err instanceof HereApiError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });
});
