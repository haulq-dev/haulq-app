/**
 * The HERE places client, against a real HTTP server.
 *
 * Same discipline `here-geocode.test.ts` and `here.test.ts` already
 * established: a stub server on localhost, not a mocked `fetch`. Pins what
 * this file assumes the `/browse` request and response shape are, and proves
 * the one-request-per-kind design and the distance-sorted, meters-to-miles
 * response mapping this file's own notes document.
 *
 * One of these tests exists because the first version was only ever run
 * against a stub: HERE refuses `/browse` without an `at` parameter, which no
 * stub complained about. The request shape is asserted here so that stays true.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HereApiError } from './here.ts';
import { HerePlacesProvider, NEARBY_STOP_CATEGORIES } from './here-places.ts';

let server: Server;
let base: string;
/** What the stub answers for each category ID it is asked about. */
let byCategory: Record<string, unknown[]>;
let status: number;
const requests: string[] = [];

const item = (title: string, meters: number, lat = 39.05, lng = -95.68, address?: string) => ({
  title,
  position: { lat, lng },
  distance: meters,
  ...(address ? { address: { label: address } } : {}),
});

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const category = new URL(req.url ?? '', 'http://x').searchParams.get('categories') ?? '';
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items: byCategory[category] ?? [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  requests.length = 0;
  status = 200;
  byCategory = {
    [NEARBY_STOP_CATEGORIES.truckStop.id]: [item('Pilot Travel Center', 16_093, 39.05, -95.68, '123 Highway Dr, Topeka, KS')],
    [NEARBY_STOP_CATEGORIES.weighStation.id]: [item('KS Weigh Station 12', 4_828.03, 39.02, -95.7)],
  };
});

describe('HerePlacesProvider.nearbyStops', () => {
  it('asks HERE about one kind of place at a time, each around the point, with the api key', async () => {
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    await provider.nearbyStops(39.05, -95.68, 16_093);

    assert.equal(requests.length, Object.keys(NEARBY_STOP_CATEGORIES).length);
    const asked = requests.map((r) => new URL(r, base).searchParams.get('categories')).sort();
    assert.deepEqual(asked, Object.values(NEARBY_STOP_CATEGORIES).map((c) => c.id).sort());

    for (const r of requests) {
      const url = new URL(r, base);
      assert.equal(url.searchParams.get('in'), 'circle:39.05,-95.68;r=16093');
      // HERE refuses /browse without `at`, even with `in` — see the provider.
      assert.equal(url.searchParams.get('at'), '39.05,-95.68');
      assert.equal(url.searchParams.get('apiKey'), 'test-key');
      assert.equal(url.searchParams.get('limit'), '5');
    }
    // EV truck charging needs a separate HERE license add-on — see the
    // constant's own comment in here-places.ts.
    assert.ok(!(asked as Array<string | null>).includes('700-7600-0323'));
  });

  it('gives every kind its own results, so a crowd of one cannot hide another', async () => {
    // Five truck stops nearer than the only weigh station: a single shared
    // limit would have cut the weigh station off.
    byCategory[NEARBY_STOP_CATEGORIES.truckStop.id] = [1, 2, 3, 4, 5].map((n) => item(`Stop ${n}`, n * 500, 39.05 + n / 1000));
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);

    const places = await provider.nearbyStops(39.05, -95.68, 16_093);

    assert.equal(places.filter((p) => p.category === 'truckStop').length, 5);
    assert.equal(places.filter((p) => p.category === 'weighStation').length, 1);
  });

  it('labels each place with the kind it was asked for, converts distance to miles, and sorts closest first', async () => {
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

  it('lists a place once when HERE returns it under two kinds, under the first kind', async () => {
    const same = item('Love’s Travel Stop', 3_000, 39.03, -95.69);
    byCategory[NEARBY_STOP_CATEGORIES.truckStop.id] = [same];
    byCategory[NEARBY_STOP_CATEGORIES.fuelStation.id] = [same];
    byCategory[NEARBY_STOP_CATEGORIES.weighStation.id] = [];
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);

    const places = await provider.nearbyStops(39.05, -95.68, 16_093);

    assert.equal(places.length, 1);
    assert.equal(places[0]!.category, 'truckStop');
  });

  it('drops an item with no position or no title rather than guessing', async () => {
    byCategory = { [NEARBY_STOP_CATEGORIES.truckStop.id]: [{ categories: [{ id: NEARBY_STOP_CATEGORIES.truckStop.id }] }, { title: 'No position' }] };
    const provider = new HerePlacesProvider({ apiKey: 'test-key' }, base);
    const places = await provider.nearbyStops(39.05, -95.68, 16_093);
    assert.deepEqual(places, []);
  });

  it('throws HereApiError on a transport failure', async () => {
    status = 503;
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
