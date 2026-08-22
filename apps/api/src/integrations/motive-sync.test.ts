/**
 * `parseMotiveLocationsPage` — pure, exhaustively tested.
 *
 * The shape below is verified against developer-docs.gomotive.com's actual
 * reference for `GET /v3/vehicle_locations`, not guessed — see the module
 * note in `motive-sync.ts`. Getting the nesting wrong (`vehicle.
 * current_location.lat`, not `vehicle.lat`) is exactly the kind of mistake
 * that compiles, typechecks, and silently returns nothing in production.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMotiveLocationsPage } from './motive-sync.ts';

function page(overrides: { vehicles?: unknown[]; pagination?: object } = {}) {
  return {
    vehicles: overrides.vehicles ?? [],
    pagination: { per_page: 25, page_no: 1, total: 0, ...overrides.pagination },
  } as Parameters<typeof parseMotiveLocationsPage>[0];
}

describe('parseMotiveLocationsPage', () => {
  it('reads lat/lng/timestamp out of the nested current_location, not the vehicle root', () => {
    const result = parseMotiveLocationsPage(
      page({
        vehicles: [
          {
            vehicle: {
              id: 998707,
              current_location: {
                lat: 27.4637528,
                lon: -82.5783576,
                located_at: '2024-05-24T16:34:49Z',
              },
            },
          },
        ],
      }),
    );

    assert.equal(result.locations.length, 1);
    assert.deepEqual(result.locations[0], {
      vehicleId: 998707,
      lat: 27.4637528,
      lng: -82.5783576,
      locatedAt: new Date('2024-05-24T16:34:49Z'),
    });
  });

  it('skips a vehicle with no current_location rather than fabricating (0, 0)', () => {
    const result = parseMotiveLocationsPage(
      page({ vehicles: [{ vehicle: { id: 1, current_location: null } }, { vehicle: { id: 2 } }] }),
    );
    assert.equal(result.locations.length, 0);
  });

  it('keeps only the vehicles with a real position, out of a mixed page', () => {
    const result = parseMotiveLocationsPage(
      page({
        vehicles: [
          { vehicle: { id: 1, current_location: { lat: 1, lon: 1, located_at: '2026-01-01T00:00:00Z' } } },
          { vehicle: { id: 2, current_location: null } },
          { vehicle: { id: 3, current_location: { lat: 3, lon: 3, located_at: '2026-01-01T00:00:00Z' } } },
        ],
      }),
    );
    assert.deepEqual(
      result.locations.map((l) => l.vehicleId),
      [1, 3],
    );
  });

  it('says there is a next page when page_no * per_page has not covered total', () => {
    const result = parseMotiveLocationsPage(page({ pagination: { per_page: 25, page_no: 1, total: 60 } }));
    assert.equal(result.hasNextPage, true);
  });

  it('says there is no next page once the last page is reached', () => {
    const result = parseMotiveLocationsPage(page({ pagination: { per_page: 25, page_no: 3, total: 60 } }));
    assert.equal(result.hasNextPage, false);
  });

  it('handles the whole fleet fitting on one page', () => {
    const result = parseMotiveLocationsPage(page({ pagination: { per_page: 100, page_no: 1, total: 5 } }));
    assert.equal(result.hasNextPage, false);
  });
});
