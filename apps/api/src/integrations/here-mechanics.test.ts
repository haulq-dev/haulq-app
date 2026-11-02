/**
 * The HERE repair-shop client, against a real HTTP server: a stub on localhost,
 * not a mocked `fetch`, same as `here-places.test.ts`. Pins which endpoint each
 * kind of search goes to, what it asks, and what is kept of the answer.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { HereApiError } from './here.ts';
import { HereMechanicSearchProvider } from './here-mechanics.ts';

let server: Server;
let base: string;
let items: unknown[];
let status: number;
const requests: URL[] = [];

const shop = (title: string, meters: number, phone?: string, lat = 39.05, lng = -95.68) => ({
  title,
  position: { lat, lng },
  distance: meters,
  address: { label: `${title}, 1 Main St, Topeka, KS 66603, United States` },
  ...(phone ? { contacts: [{ phone: [{ value: phone }] }] } : {}),
});

before(async () => {
  server = createServer((req, res) => {
    requests.push(new URL(req.url ?? '', 'http://x'));
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

beforeEach(() => {
  items = [];
  status = 200;
  requests.length = 0;
});

const provider = () => new HereMechanicSearchProvider({ apiKey: 'test-key' }, `${base}/browse`, `${base}/discover`);

describe('HereMechanicSearchProvider', () => {
  it('browses by category for a shortcut, inside the circle', async () => {
    await provider().nearbyMechanics(39.05, -95.68, 24_140, 'heavy duty towing', 'towing');
    const url = requests[0]!;
    assert.equal(url.pathname, '/browse');
    assert.equal(url.searchParams.get('categories'), '700-7200-0278');
    assert.equal(url.searchParams.get('at'), '39.05,-95.68');
    assert.equal(url.searchParams.get('in'), 'circle:39.05,-95.68;r=24140');
    assert.equal(url.searchParams.get('apiKey'), 'test-key');
    assert.equal(url.searchParams.has('q'), false);
  });

  it('lets the words decide for a typed search', async () => {
    await provider().nearbyMechanics(39.05, -95.68, 8_000, 'thermo king');
    const url = requests[0]!;
    assert.equal(url.pathname, '/discover');
    assert.equal(url.searchParams.get('q'), 'thermo king');
    assert.equal(url.searchParams.get('in'), 'circle:39.05,-95.68;r=8000');
    assert.equal(url.searchParams.has('categories'), false);
  });

  it('understands what installed iOS builds still send', async () => {
    await provider().nearbyMechanics(39.05, -95.68, 8_000, 'diesel truck repair', 'truckrepair,autorepair');
    await provider().nearbyMechanics(39.05, -95.68, 8_000, 'reefer trailer repair', 'trailerrepair,truckrepair');
    await provider().nearbyMechanics(39.05, -95.68, 8_000, 'something', 'nosuchkind');

    assert.equal(requests[0]!.searchParams.get('categories'), '700-7850-0126', 'garages are left out');
    assert.equal(requests[1]!.pathname, '/discover', 'HERE has no trailer category, so the words decide');
    assert.equal(requests[1]!.searchParams.get('q'), 'reefer trailer repair');
    assert.equal(requests[2]!.pathname, '/discover');
  });

  it('maps a shop, closest first, in miles, with a readable phone number', async () => {
    items = [shop('Far Diesel', 8_046.72, '+13165550100'), shop('Near Diesel', 1_609.344, '+13165550111')];
    const found = await provider().nearbyMechanics(39.05, -95.68, 24_140, 'x', 'truckrepair');

    assert.deepEqual(found.map((m) => m.name), ['Near Diesel', 'Far Diesel']);
    assert.equal(found[0]!.phone, '(316) 555-0111');
    assert.ok(Math.abs(found[0]!.distanceMiles - 1) < 0.001);
    assert.equal(found[0]!.address, 'Near Diesel, 1 Main St, Topeka, KS 66603, United States');
    assert.equal(found[0]!.lat, 39.05);
  });

  it('leaves a shop with no phone as having none, and an unfamiliar number as it came', async () => {
    items = [shop('No Phone', 100), shop('Mexico Shop', 200, '+525555550100')];
    const found = await provider().nearbyMechanics(39.05, -95.68, 24_140, 'x', 'truckrepair');
    assert.equal(found[0]!.phone, null);
    assert.equal(found[1]!.phone, '+525555550100');
  });

  it('lists a shop HERE has twice only once, at its nearest', async () => {
    items = [
      shop('Chihuahua Truck Repair', 300, '+18065550100'),
      shop('chihuahua truck repair', 100, '+18065550100'),
      shop('No Phone Shop', 500, undefined, 39.0501, -95.6801),
      shop('No Phone Shop', 600, undefined, 39.0502, -95.6802),
      shop('No Phone Shop', 700, undefined, 39.9, -95.9),
    ];
    const found = await provider().nearbyMechanics(39.05, -95.68, 24_140, 'x', 'truckrepair');
    assert.deepEqual(found.map((m) => [m.name, Math.round(m.distanceMiles * 1609.344)]), [
      ['chihuahua truck repair', 100],
      ['No Phone Shop', 500],
      ['No Phone Shop', 700],
    ]);
  });

  it('holds results to the radius, and drops what it cannot place', async () => {
    items = [shop('Inside', 1_000), shop('Outside', 9_000), { title: 'No Distance', position: { lat: 1, lng: 1 } }, { title: 'No Position', distance: 5 }];
    const found = await provider().nearbyMechanics(39.05, -95.68, 8_000, 'x', 'truckrepair');
    assert.deepEqual(found.map((m) => m.name), ['Inside']);
  });

  it('returns ten at most', async () => {
    items = Array.from({ length: 20 }, (_, i) => shop(`Shop ${i}`, 100 + i));
    assert.equal((await provider().nearbyMechanics(39.05, -95.68, 24_140, 'x', 'truckrepair')).length, 10);
  });

  it('raises HERE\'s own status when it refuses', async () => {
    status = 429;
    await assert.rejects(provider().nearbyMechanics(39.05, -95.68, 8_000, 'x'), (err: unknown) => err instanceof HereApiError && err.status === 429);
  });
});
