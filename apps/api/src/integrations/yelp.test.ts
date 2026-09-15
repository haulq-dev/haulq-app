/**
 * The Yelp mechanic search client, against a real HTTP server.
 *
 * Same discipline `here-places.test.ts` and `here.test.ts` already
 * established: a stub server on localhost, not a mocked `fetch`. Proves the
 * Bearer-token auth (Yelp's own documented scheme, unlike HERE's
 * query-string key), the category/term/radius request shape, and the
 * response mapping this file's own module note documents.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { YelpApiError, YelpMechanicSearchProvider } from './yelp.ts';

let server: Server;
let base: string;
let script: { status: number; body: unknown };
let lastAuthHeader: string | undefined;
const requests: string[] = [];

const SEARCH_RESULT = {
  businesses: [
    {
      name: 'Prairie Diesel Repair',
      rating: 4.5,
      review_count: 87,
      display_phone: '(316) 555-0100',
      distance: 3_218.6, // 2 mi
      url: 'https://www.yelp.com/biz/prairie-diesel-repair',
      location: { display_address: ['123 Industrial Rd', 'Wichita, KS 67202'] },
    },
    {
      name: 'Unrated Truck Shop',
      review_count: 0,
      distance: 8_046.72, // 5 mi
      location: {},
    },
  ],
};

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    lastAuthHeader = req.headers.authorization;
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
  lastAuthHeader = undefined;
  script = { status: 200, body: SEARCH_RESULT };
});

describe('YelpMechanicSearchProvider.nearbyMechanics', () => {
  it('sends the api key as a bearer token, not a query param', async () => {
    const provider = new YelpMechanicSearchProvider({ apiKey: 'test-key' }, base);
    await provider.nearbyMechanics(37.6889, -97.3365, 24_140, 'diesel truck repair');

    assert.equal(lastAuthHeader, 'Bearer test-key');
    const url = new URL(requests[0]!, base);
    assert.equal(url.searchParams.has('apiKey'), false);
    assert.equal(url.searchParams.has('apikey'), false);
  });

  it('requests coordinates, a clamped radius, the autorepair category and the given term', async () => {
    const provider = new YelpMechanicSearchProvider({ apiKey: 'test-key' }, base);
    await provider.nearbyMechanics(37.6889, -97.3365, 50_000, 'diesel truck repair');

    const url = new URL(requests[0]!, base);
    assert.equal(url.searchParams.get('latitude'), '37.6889');
    assert.equal(url.searchParams.get('longitude'), '-97.3365');
    // Yelp's own documented ceiling is 40,000 m — a larger ask is clamped, not sent as-is.
    assert.equal(url.searchParams.get('radius'), '40000');
    assert.equal(url.searchParams.get('categories'), 'autorepair');
    assert.equal(url.searchParams.get('term'), 'diesel truck repair');
  });

  it('maps businesses to name, rating, distance in miles and a joined address', async () => {
    const provider = new YelpMechanicSearchProvider({ apiKey: 'test-key' }, base);
    const mechanics = await provider.nearbyMechanics(37.6889, -97.3365, 24_140, 'diesel truck repair');

    assert.equal(mechanics.length, 2);
    assert.equal(mechanics[0]!.name, 'Prairie Diesel Repair');
    assert.equal(mechanics[0]!.rating, 4.5);
    assert.equal(mechanics[0]!.reviewCount, 87);
    assert.equal(mechanics[0]!.phone, '(316) 555-0100');
    assert.equal(mechanics[0]!.address, '123 Industrial Rd, Wichita, KS 67202');
    assert.ok(Math.abs(mechanics[0]!.distanceMiles - 2) < 0.01);
    assert.equal(mechanics[0]!.yelpUrl, 'https://www.yelp.com/biz/prairie-diesel-repair');
  });

  it('carries no rating and no address as null, rather than 0 or an empty string', async () => {
    const provider = new YelpMechanicSearchProvider({ apiKey: 'test-key' }, base);
    const mechanics = await provider.nearbyMechanics(37.6889, -97.3365, 24_140, 'diesel truck repair');

    assert.equal(mechanics[1]!.rating, null);
    assert.equal(mechanics[1]!.address, null);
    assert.equal(mechanics[1]!.phone, null);
  });

  it('throws YelpApiError on a transport failure', async () => {
    script.status = 401;
    const provider = new YelpMechanicSearchProvider({ apiKey: 'bad-key' }, base);
    await assert.rejects(
      () => provider.nearbyMechanics(37.6889, -97.3365, 24_140, 'diesel truck repair'),
      (err: unknown) => {
        assert.ok(err instanceof YelpApiError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });
});
