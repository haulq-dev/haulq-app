/**
 * The HERE geocoder, against a real HTTP server.
 *
 * Same discipline `here.test.ts` established for this repo's HERE clients: a
 * stub server on localhost, not a mocked `fetch`. Pins what this file assumes
 * the v7 Geocode API response shape is — see `here-geocode.ts`'s own module
 * note for why that assumption needs re-validating against a real response.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HereApiError } from './here.ts';
import { HereGeocoder } from './here-geocode.ts';

let server: Server;
let base: string;
let script: { status: number; body: unknown };
const requests: string[] = [];

const GEOCODE_RESULT = {
  items: [
    {
      address: { label: '123 Main St, Wichita, KS 67202, United States' },
      position: { lat: 37.6889, lng: -97.3365 },
      scoring: { queryScore: 0.95 },
    },
    {
      address: { label: '123 Main Ave, Wichita, KS 67203, United States' },
      position: { lat: 37.71, lng: -97.4 },
      scoring: { queryScore: 0.61 },
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
  script = { status: 200, body: GEOCODE_RESULT };
});

describe('HereGeocoder.geocode', () => {
  it('maps HERE items to label, coordinates and query score', async () => {
    const geocoder = new HereGeocoder({ apiKey: 'test-key' }, base);
    const candidates = await geocoder.geocode('123 Main St, Wichita, KS');

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0]!.label, '123 Main St, Wichita, KS 67202, United States');
    assert.equal(candidates[0]!.lat, 37.6889);
    assert.equal(candidates[0]!.lng, -97.3365);
    assert.equal(candidates[0]!.score, 0.95);
  });

  it('sends the query, a limit and the api key', async () => {
    const geocoder = new HereGeocoder({ apiKey: 'test-key' }, base);
    await geocoder.geocode('123 Main St, Wichita, KS');

    const url = new URL(requests[0]!, base);
    assert.equal(url.searchParams.get('q'), '123 Main St, Wichita, KS');
    assert.equal(url.searchParams.get('limit'), '3');
    assert.equal(url.searchParams.get('apiKey'), 'test-key');
  });

  it('drops an item missing a position or a label rather than throwing', async () => {
    script.body = {
      items: [
        { address: { label: 'No position' } },
        { position: { lat: 1, lng: 2 } },
        GEOCODE_RESULT.items[0],
      ],
    };
    const geocoder = new HereGeocoder({ apiKey: 'test-key' }, base);
    const candidates = await geocoder.geocode('anything');

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.label, GEOCODE_RESULT.items[0]!.address.label);
  });

  it('returns an empty list rather than throwing when HERE finds nothing', async () => {
    script.body = { items: [] };
    const geocoder = new HereGeocoder({ apiKey: 'test-key' }, base);
    assert.deepEqual(await geocoder.geocode('nowhere'), []);
  });

  it('throws HereApiError on a transport failure', async () => {
    script.status = 503;
    const geocoder = new HereGeocoder({ apiKey: 'test-key' }, base);
    await assert.rejects(
      () => geocoder.geocode('anything'),
      (err: unknown) => {
        assert.ok(err instanceof HereApiError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });
});
